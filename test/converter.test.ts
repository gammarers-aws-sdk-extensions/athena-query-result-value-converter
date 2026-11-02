import type { ColumnInfo } from '@aws-sdk/client-athena';
import {
  AthenaQueryResultValueConverter,
  AthenaQueryResultValueConverterArgumentError,
  AthenaQueryResultValueConverterError,
  AthenaQueryResultValueConverterUnparseableValueError,
} from '../src';

const { convert, toBoolean, toDate, toNumber, isParseableAsType, isStringLikeType } =
  AthenaQueryResultValueConverter;

const makeColumn = (
  type: string,
  options?: { precision?: number; scale?: number },
): ColumnInfo => ({
  Name: 'n',
  Type: type,
  Precision: options?.precision,
  Scale: options?.scale,
});

describe('value conversion utilities', () => {
  it('toNumber should return null for null/empty/unparseable values', () => {
    expect(toNumber(null)).toBeNull();
    expect(toNumber('')).toBeNull();
    expect(toNumber('   ')).toBeNull();
    expect(toNumber('not-a-number')).toBeNull();
  });

  it('toNumber should parse finite numbers', () => {
    expect(toNumber('0')).toBe(0);
    expect(toNumber('  1.25 ')).toBe(1.25);
    expect(toNumber('-10')).toBe(-10);
  });

  it('toBoolean should return null for null/empty/unrecognized values', () => {
    expect(toBoolean(null)).toBeNull();
    expect(toBoolean('')).toBeNull();
    expect(toBoolean('   ')).toBeNull();
    expect(toBoolean('yes')).toBeNull();
    expect(toBoolean('1')).toBeNull();
  });

  it('toBoolean should parse true/false (case-insensitive)', () => {
    expect(toBoolean('true')).toBe(true);
    expect(toBoolean('TRUE')).toBe(true);
    expect(toBoolean(' false ')).toBe(false);
  });

  it('toDate should return null for null/empty/unparseable values', () => {
    expect(toDate(null)).toBeNull();
    expect(toDate('')).toBeNull();
    expect(toDate('   ')).toBeNull();
    expect(toDate('not-a-date')).toBeNull();
  });

  it('toDate should parse Athena timestamps as UTC by default', () => {
    const d = toDate('2026-01-01 00:00:00.000');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('toDate should apply an IANA zone and prefer a suffix on the value', () => {
    expect(toDate('2026-01-01 00:00:00.000', { timeZone: 'Asia/Tokyo' })!.toISOString())
      .toBe('2025-12-31T15:00:00.000Z');
    expect(toDate('2026-01-01 00:00:00.000 Asia/Tokyo')!.toISOString())
      .toBe('2025-12-31T15:00:00.000Z');
    expect(toDate('2026-01-01 00:00:00.123 +09:00')!.toISOString())
      .toBe('2025-12-31T15:00:00.123Z');
  });

  it('toDate should keep a date-only literal at UTC midnight', () => {
    expect(toDate('2026-01-01', { timeZone: 'Asia/Tokyo' })!.toISOString())
      .toBe('2026-01-01T00:00:00.000Z');
  });

  it('toDate should reject non-Athena text and fractions finer than milliseconds', () => {
    expect(toDate('2026-01-01T00:00:00.000Z')).toBeNull();
    expect(toDate('January 1, 2026')).toBeNull();
    expect(toDate('2026')).toBeNull();
    expect(toDate('2026-01-01 00:00:00.123456')).toBeNull();
    expect(toDate('12:00:00.000')).toBeNull();
  });

  it('toDate should throw when the session time zone is not an IANA name', () => {
    expect(() => toDate('2026-01-01 00:00:00.000', { timeZone: 'Not/AZone' }))
      .toThrow(AthenaQueryResultValueConverterArgumentError);
  });
});

describe('AthenaQueryResultValueConverter.convert', () => {
  it('should convert values from ColumnInfo without rounding bigint or decimal', () => {
    expect(convert('1', 'id', makeColumn('integer'))).toBe(1);
    expect(convert('9223372036854775807', 'user_id', makeColumn('bigint'))).toBe(
      '9223372036854775807',
    );
    expect(
      convert('1.50', 'amount', makeColumn('decimal', { precision: 10, scale: 2 })),
    ).toBe('1.50');
    expect(convert('1.25', 'score', makeColumn('double'))).toBe(1.25);
    expect(convert('true', 'is_active', makeColumn('boolean'))).toBe(true);

    const createdAt = convert(
      '2026-01-01 00:00:00.000',
      'created_at',
      makeColumn('timestamp'),
    );
    expect(createdAt).toBeInstanceOf(Date);
    expect((createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(convert('Alice', 'name', makeColumn('varchar'))).toBe('Alice');
    expect(convert('Alice', 'name', { Name: 'name', Type: undefined })).toBe('Alice');
  });

  it.each([
    ['tinyint', '-128', -128],
    ['tinyint', '127', 127],
    ['smallint', '-32768', -32768],
    ['smallint', '32767', 32767],
    ['int', '-2147483648', -2147483648],
    ['int', '2147483647', 2147483647],
    ['integer', '42', 42],
  ] as const)('should convert %s %s to number %s', (type, raw, expected) => {
    expect(convert(raw, 'n', makeColumn(type))).toBe(expected);
  });

  it.each([
    ['tinyint', '128'],
    ['tinyint', '-129'],
    ['smallint', '32768'],
    ['int', '2147483648'],
    ['integer', '1.5'],
    ['integer', '1e2'],
    ['int', '99999999999999999999'],
  ] as const)('should keep out-of-range %s value %s', (type, raw) => {
    expect(convert(raw, 'n', makeColumn(type))).toBe(raw);
  });

  it.each([
    '1',
    '+1',
    '9007199254740993',
    '9223372036854775807',
    '-9223372036854775808',
  ] as const)('should preserve bigint %s as text', (raw) => {
    expect(convert(`  ${raw}  `, 'id', makeColumn('bigint'))).toBe(raw);
  });

  it('should keep a bigint outside signed 64 bits as text by default', () => {
    expect(convert('9223372036854775808', 'id', makeColumn('bigint'))).toBe(
      '9223372036854775808',
    );
  });

  it('should preserve decimal scale from ColumnInfo and from the type string', () => {
    expect(
      convert('1.50', 'amount', makeColumn('decimal', { precision: 10, scale: 2 })),
    ).toBe('1.50');
    expect(convert('1.50', 'amount', makeColumn('decimal(10,2)'))).toBe('1.50');
  });

  it('should keep decimal text when the type string is not decimal(p,s)', () => {
    expect(convert('1.50', 'amount', makeColumn('decimal(10'))).toBe('1.50');
  });

  it('should keep a decimal string when precision and scale are absent', () => {
    expect(convert('1.50', 'amount', makeColumn('decimal'))).toBe('1.50');
  });

  it('should limit total digits when only precision is present', () => {
    const column = makeColumn('decimal', { precision: 4 });
    expect(convert('12.3', 'amount', column)).toBe('12.3');
    expect(convert('1234.5', 'amount', column)).toBe('1234.5');
  });

  it('should keep a scale-zero decimal identifier as text', () => {
    expect(
      convert(
        '9007199254740993',
        'id',
        makeColumn('decimal', { precision: 20, scale: 0 }),
      ),
    ).toBe('9007199254740993');
  });

  it('should reject a decimal when precision is lower than scale', () => {
    expect(
      convert('1.00', 'amount', makeColumn('decimal', { precision: 2, scale: 4 })),
    ).toBe('1.00');
  });

  it('should ignore invalid precision and scale and use decimal(p,s) on Type', () => {
    const column: ColumnInfo = {
      Name: 'amount',
      Type: 'decimal(10,2)',
      Precision: -1,
      Scale: 1.5,
    };
    expect(convert('1.50', 'amount', column)).toBe('1.50');
  });

  it.each([
    ['double', 'not-a-number'],
    ['boolean', 'yes'],
    ['timestamp', 'not-a-date'],
  ] as const)('should keep unparseable %s value %s', (type, raw) => {
    expect(convert(raw, 'n', makeColumn(type))).toBe(raw);
  });

  it('should prefer ColumnInfo precision and scale over decimal(p,s) in Type', () => {
    const column: ColumnInfo = {
      Name: 'amount',
      Type: 'decimal(10,2)',
      Precision: 3,
      Scale: 0,
    };
    expect(convert('1.50', 'amount', column)).toBe('1.50');
  });

  it.each([
    ['999.99', '999.99'],
    ['1.5', '1.5'],
    ['0001.50', '0001.50'],
  ] as const)('should accept decimal %s within decimal(5,2)', (raw, expected) => {
    expect(convert(raw, 'amount', makeColumn('decimal(5,2)'))).toBe(expected);
  });

  it.each([
    '1000.00',
    '1.500',
    'not-a-decimal',
  ] as const)('should keep decimal %s that exceeds decimal(5,2)', (raw) => {
    expect(convert(raw, 'amount', makeColumn('decimal(5,2)'))).toBe(raw);
  });

  it('should keep a null cell as null', () => {
    expect(convert(null, 'id', makeColumn('bigint'))).toBeNull();
  });

  it('should keep original string when unparseable (default)', () => {
    expect(convert('not-a-number', 'n', makeColumn('bigint'))).toBe('not-a-number');
  });

  it('should convert unparseable values to null when configured', () => {
    expect(
      convert('not-a-number', 'n', makeColumn('bigint'), {
        unparseableValueBehavior: 'null',
      }),
    ).toBeNull();
  });

  it('should throw AthenaQueryResultValueConverterUnparseableValueError when configured', () => {
    expect(() =>
      convert('not-a-number', 'n', makeColumn('integer'), {
        unparseableValueBehavior: 'throw',
      }),
    ).toThrow('Unparseable value for column "n" (integer): "not-a-number"');
  });

  it('should throw with code and cell details', () => {
    expect(() =>
      convert('not-a-number', 'n', makeColumn('bigint'), {
        unparseableValueBehavior: 'throw',
        rowIndex: 4,
      }),
    ).toThrow(AthenaQueryResultValueConverterUnparseableValueError);

    try {
      convert('not-a-number', 'n', makeColumn('bigint'), {
        unparseableValueBehavior: 'throw',
        rowIndex: 4,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(AthenaQueryResultValueConverterError);
      expect(error).toMatchObject({
        code: 'unparseable-value',
        columnName: 'n',
        columnType: 'bigint',
        value: 'not-a-number',
        rowIndex: 4,
      });
    }

    const withoutType = new AthenaQueryResultValueConverterUnparseableValueError('n', undefined, 'x');
    expect(withoutType.message).toBe('Unparseable value for column "n": "x"');
    expect(withoutType.columnType).toBeUndefined();
  });
});

describe('Athena date and time literals', () => {
  const expectInstant = (value: unknown, iso: string): void => {
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).toISOString()).toBe(iso);
  };

  it('should read a zone-less timestamp in the session time zone', () => {
    expectInstant(
      convert('2026-01-01 00:00:00.000', 'created_at', makeColumn('timestamp'), {
        timeZone: 'Asia/Tokyo',
      }),
      '2025-12-31T15:00:00.000Z',
    );
    expectInstant(
      convert('  2026-01-01 00:00:00.1  ', 'created_at', makeColumn('timestamp(3)')),
      '2026-01-01T00:00:00.100Z',
    );
    expectInstant(
      convert('2026-01-01 00:00:00', 'created_at', makeColumn('timestamp')),
      '2026-01-01T00:00:00.000Z',
    );
  });

  it.each([
    ['2026-01-01 00:00:00.000 UTC', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01 00:00:00.000 +09:00', '2025-12-31T15:00:00.000Z'],
    ['2026-01-01 00:00:00.000 +0900', '2025-12-31T15:00:00.000Z'],
    ['2026-01-01 00:00:00.000 +18', '2025-12-31T06:00:00.000Z'],
    ['2026-01-01 00:00:00.000 -05:30', '2026-01-01T05:30:00.000Z'],
    ['2026-01-01 00:00:00.000 Asia/Tokyo', '2025-12-31T15:00:00.000Z'],
    ['2026-11-01 01:30:00.000 America/New_York', '2026-11-01T05:30:00.000Z'],
    ['2026-03-08 03:30:00.000 America/New_York', '2026-03-08T07:30:00.000Z'],
    ['2026-10-25 02:30:00.000 Europe/Paris', '2026-10-25T00:30:00.000Z'],
    ['2026-04-05 01:30:00.000 Australia/Lord_Howe', '2026-04-04T14:30:00.000Z'],
  ] as const)('should convert timestamp with time zone %s to %s', (raw, iso) => {
    expectInstant(convert(raw, 'created_at', makeColumn('timestamp with time zone')), iso);
  });

  it('should use the earlier instant when the session zone repeats a local time', () => {
    expectInstant(
      convert('2026-10-25 02:30:00.000', 'created_at', makeColumn('timestamp'), {
        timeZone: 'Europe/Paris',
      }),
      '2026-10-25T00:30:00.000Z',
    );
  });

  it('should keep a timestamp that skips a local hour', () => {
    const raw = '2026-03-08 02:30:00.000 America/New_York';
    expect(convert(raw, 'created_at', makeColumn('timestamp with time zone'))).toBe(raw);
  });

  it.each([
    '+18:01',
    '+18:00:01',
    '+19:00',
    '+00:60',
    '+00:00:60',
  ] as const)('should keep an out-of-range offset %s', (offset) => {
    const raw = `2026-01-01 00:00:00.000 ${offset}`;
    expect(convert(raw, 'created_at', makeColumn('timestamp with time zone'))).toBe(raw);
  });

  it('should keep timestamps whose precision does not fit in a Date', () => {
    expect(convert('2026-01-01 00:00:00.123456', 'created_at', makeColumn('timestamp(6)')))
      .toBe('2026-01-01 00:00:00.123456');
    expect(convert('2026-01-01 00:00:00.000', 'created_at', makeColumn('timestamp(6)')))
      .toBe('2026-01-01 00:00:00.000');
    expect(
      convert('2026-01-01 00:00:00.123456 UTC', 'created_at', makeColumn('timestamp(6) with time zone')),
    ).toBe('2026-01-01 00:00:00.123456 UTC');
    expect(
      convert('2026-01-01 00:00:00.000', 'created_at', makeColumn('timestamp', { precision: 6 })),
    ).toBe('2026-01-01 00:00:00.000');
  });

  it('should not throw when a fine timestamp is valid text', () => {
    expect(
      convert('2026-01-01 00:00:00.123456', 'created_at', makeColumn('timestamp(6)'), {
        unparseableValueBehavior: 'throw',
      }),
    ).toBe('2026-01-01 00:00:00.123456');
  });

  it('should prefer ColumnInfo.Precision over timestamp(p) on the type', () => {
    expectInstant(
      convert('2026-01-01 00:00:00.123', 'created_at', makeColumn('timestamp(6)', { precision: 3 })),
      '2026-01-01T00:00:00.123Z',
    );
    expect(
      convert('2026-01-01 00:00:00.123456', 'created_at', makeColumn('timestamp(6)', { precision: -1 }), {
        unparseableValueBehavior: 'throw',
      }),
    ).toBe('2026-01-01 00:00:00.123456');
  });

  it.each([
    '2026',
    'January 1, 2026',
    '01/02/2026',
    '2026-01-01T00:00:00.000Z',
    '2026-02-31 00:00:00.000',
    '2026-01-01 24:00:00.000',
    '2026-01-01 00:00:00.123456',
    '2026-01-01 00:00:00.000 Asia/Tokyo',
    '   ',
  ] as const)('should keep non-Athena or over-precise timestamp %s', (raw) => {
    expect(convert(raw, 'created_at', makeColumn('timestamp'))).toBe(raw);
  });

  it('should throw when a timestamp fraction exceeds the declared precision', () => {
    expect(() =>
      convert('2026-01-01 00:00:00.123456', 'created_at', makeColumn('timestamp(3)'), {
        unparseableValueBehavior: 'throw',
      }),
    ).toThrow(AthenaQueryResultValueConverterUnparseableValueError);
  });

  it('should return a date as UTC midnight or as YYYY-MM-DD text', () => {
    expectInstant(convert('2026-01-01', 'birth_date', makeColumn('date')), '2026-01-01T00:00:00.000Z');
    expectInstant(convert('0001-01-01', 'birth_date', makeColumn('date')), '0001-01-01T00:00:00.000Z');
    expectInstant(convert('0000-02-29', 'birth_date', makeColumn('date')), '0000-02-29T00:00:00.000Z');
    expect(convert('2026-01-01', 'birth_date', makeColumn('date'), { dateValue: 'string' })).toBe('2026-01-01');
    expect(convert('2026-02-31', 'birth_date', makeColumn('date'))).toBe('2026-02-31');
    expect(convert('2026-00-01', 'birth_date', makeColumn('date'))).toBe('2026-00-01');
    expect(convert('2026-13-01', 'birth_date', makeColumn('date'))).toBe('2026-13-01');
    expect(convert('2026-01-00', 'birth_date', makeColumn('date'))).toBe('2026-01-00');
    expect(convert('0000-02-30', 'birth_date', makeColumn('date'))).toBe('0000-02-30');
    expect(convert('01/02/2026', 'birth_date', makeColumn('date'), { dateValue: 'string' })).toBe('01/02/2026');
  });

  it('should keep years 0 through 99 instead of shifting them into the 1900s', () => {
    expectInstant(
      convert('0099-01-01 00:00:00.000', 'created_at', makeColumn('timestamp')),
      '0099-01-01T00:00:00.000Z',
    );
    expectInstant(
      convert('0001-01-01 00:00:00.000 +09:00', 'created_at', makeColumn('timestamp with time zone')),
      '0000-12-31T15:00:00.000Z',
    );
  });

  it('should keep time and time(p) as text', () => {
    expect(
      convert('12:34:56.789', 'started_at', makeColumn('time'), { unparseableValueBehavior: 'throw' }),
    ).toBe('12:34:56.789');
    expect(
      convert('12:34:56.789', 'started_at', makeColumn('time(3)'), { unparseableValueBehavior: 'throw' }),
    ).toBe('12:34:56.789');
    expect(convert('12:34:56', 'started_at', makeColumn('time(0)'))).toBe('12:34:56');
    expect(convert('12:34:56.123456', 'started_at', makeColumn('time(6)'))).toBe('12:34:56.123456');
    expect(convert('12:34:56.1', 'started_at', makeColumn('time(0)'))).toBe('12:34:56.1');
    expect(convert('12:00', 'started_at', makeColumn('time'))).toBe('12:00');
    expect(() =>
      convert('24:00:00', 'started_at', makeColumn('time'), { unparseableValueBehavior: 'throw' }),
    ).toThrow(AthenaQueryResultValueConverterUnparseableValueError);
    expect(convert('12:00:00.000 UTC', 'started_at', makeColumn('time with time zone')))
      .toBe('12:00:00.000 UTC');
  });

  it('should keep a zoned timestamp that is not an Athena literal', () => {
    expect(convert('2026-01-01 00:00:00.000', 'created_at', makeColumn('timestamp with time zone')))
      .toBe('2026-01-01 00:00:00.000');
    expect(convert('2026-01-01 24:00:00.000 UTC', 'created_at', makeColumn('timestamp with time zone')))
      .toBe('2026-01-01 24:00:00.000 UTC');
    expect(convert('2026-02-31 00:00:00.000 UTC', 'created_at', makeColumn('timestamp with time zone')))
      .toBe('2026-02-31 00:00:00.000 UTC');
  });

  it('should accept a local midnight when Intl reports that hour as 24', () => {
    const timeZone = 'Atlantic/Reykjavik';
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    // This ICU build writes midnight as hour 00. The converter also accepts hour 24 from other builds.
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(function dateTimeFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): Intl.DateTimeFormat {
      const formatter = new OriginalDateTimeFormat(locales, options);
      if (options?.timeZone !== timeZone) return formatter;

      const formatToParts = formatter.formatToParts.bind(formatter);
      formatter.formatToParts = (date?: Date | number) => {
        const parts = formatToParts(date);
        const hour = parts.find((part) => part.type === 'hour');
        if (hour == null || hour.value !== '00') return parts;

        const year = Number(parts.find((part) => part.type === 'year')?.value);
        const month = Number(parts.find((part) => part.type === 'month')?.value);
        const day = Number(parts.find((part) => part.type === 'day')?.value);
        const previous = new Date(0);
        previous.setUTCFullYear(year, month - 1, day - 1);
        return parts.map((part) => {
          if (part.type === 'hour') return { ...part, value: '24' };
          if (part.type === 'year') return { ...part, value: String(previous.getUTCFullYear()) };
          if (part.type === 'month') return { ...part, value: String(previous.getUTCMonth() + 1).padStart(2, '0') };
          if (part.type === 'day') return { ...part, value: String(previous.getUTCDate()).padStart(2, '0') };
          return part;
        });
      };
      return formatter;
    });

    try {
      expectInstant(
        convert('2026-01-02 00:00:00.000', 'created_at', makeColumn('timestamp'), { timeZone }),
        '2026-01-02T00:00:00.000Z',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('should rethrow when resolving a time zone fails for a reason other than RangeError', () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const spy = jest.spyOn(Intl, 'DateTimeFormat').mockImplementation(function dateTimeFormat(
      locales?: Intl.LocalesArgument,
      options?: Intl.DateTimeFormatOptions,
    ): Intl.DateTimeFormat {
      if (options?.timeZone === 'Explode/Zone') throw new TypeError('formatter failed');
      return new OriginalDateTimeFormat(locales, options);
    });

    try {
      expect(() => convert('1', 'n', makeColumn('integer'), { timeZone: 'Explode/Zone' })).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  it('should keep a timestamp when its instant is not a safe integer', () => {
    const isSafeInteger = Number.isSafeInteger;
    // Four-digit Athena years fit in a safe integer. This forces the defensive text branch.
    Number.isSafeInteger = (value: unknown): boolean => {
      if (typeof value === 'number' && Math.abs(value) > 1_000_000_000_000) return false;
      return isSafeInteger(value);
    };

    try {
      expect(convert('2026-01-01 00:00:00.000', 'created_at', makeColumn('timestamp')))
        .toBe('2026-01-01 00:00:00.000');
    } finally {
      Number.isSafeInteger = isSafeInteger;
    }
  });

  it('should keep a timestamp when Date cannot represent that instant', () => {
    const RealDate = Date;
    const epochMs = RealDate.parse('2026-01-01T00:00:00.000Z');
    // A safe integer past the Date range is not produced by a four-digit year. Force that one instant.
    function DateWithOneInvalidInstant(...args: ConstructorParameters<typeof Date>): Date {
      if (args.length === 1 && args[0] === epochMs) return new RealDate(Number.NaN);
      return new RealDate(...args);
    }
    Object.setPrototypeOf(DateWithOneInvalidInstant, RealDate);
    DateWithOneInvalidInstant.prototype = RealDate.prototype;
    globalThis.Date = DateWithOneInvalidInstant as unknown as DateConstructor;

    try {
      expect(convert('2026-01-01 00:00:00.000', 'created_at', makeColumn('timestamp')))
        .toBe('2026-01-01 00:00:00.000');
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it('should keep a decimal when the integer-digit group is missing', () => {
    const decimalSource = /^[+-]?(\d+)(?:\.(\d+))?$/.source;
    const exec = RegExp.prototype.exec;
    let cleared = false;
    RegExp.prototype.exec = function (value: string): RegExpExecArray | null {
      const match = exec.call(this, value);
      if (match != null && this.source === decimalSource) {
        delete match[1];
        cleared = true;
      }
      return match;
    };

    try {
      expect(convert('1.50', 'amount', makeColumn('decimal(10,2)'))).toBe('1.50');
      expect(cleared).toBe(true);
    } finally {
      RegExp.prototype.exec = exec;
    }
  });

  it('should keep a zoned timestamp when the zone group is missing', () => {
    const zoneSource = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))? (.+)$/.source;
    const exec = RegExp.prototype.exec;
    let cleared = false;
    RegExp.prototype.exec = function (value: string): RegExpExecArray | null {
      const match = exec.call(this, value);
      if (match != null && this.source === zoneSource) {
        delete match[8];
        cleared = true;
      }
      return match;
    };

    try {
      const raw = '2026-01-01 00:00:00.000 UTC';
      expect(convert(raw, 'created_at', makeColumn('timestamp with time zone'))).toBe(raw);
      expect(cleared).toBe(true);
    } finally {
      RegExp.prototype.exec = exec;
    }
  });

  it('should throw when the session time zone or dateValue is unusable', () => {
    expect(() =>
      convert('1', 'n', makeColumn('integer'), { timeZone: 'Not/AZone' }),
    ).toThrow(AthenaQueryResultValueConverterArgumentError);
    expect(() =>
      convert('2026-01-01', 'birth_date', makeColumn('date'), {
        dateValue: 'day' as 'instant',
      }),
    ).toThrow("dateValue must be 'instant' or 'string'");
  });
});

describe('type predicates', () => {
  it.each([
    ['string', true],
    ['varchar', true],
    ['varchar(10)', true],
    ['char', true],
    ['char(1)', true],
    ['varbinary', true],
    ['integer', false],
    ['boolean', false],
    [undefined, false],
  ] as const)('isStringLikeType(%s) should be %s', (type, expected) => {
    expect(isStringLikeType(type)).toBe(expected);
  });

  it.each([
    ['42', 'integer', true],
    ['id', 'integer', false],
    ['true', 'boolean', true],
    ['yes', 'boolean', false],
    ['2026-01-01', 'date', true],
    ['2026', 'date', false],
    ['January 1, 2026', 'date', false],
    ['01/02/2026', 'date', false],
    ['created_at', 'timestamp', false],
    ['2026-01-01 00:00:00.000', 'timestamp', true],
    ['2026-01-01T00:00:00.000Z', 'timestamp', false],
    ['2026-01-01 00:00:00.123456', 'timestamp(6)', true],
    ['2026-01-01 00:00:00.123456', 'timestamp(3)', false],
    ['2026-01-01 00:00:00.000 Asia/Tokyo', 'timestamp with time zone', true],
    ['2026-01-01 00:00:00.000 Not/AZone', 'timestamp with time zone', false],
    ['2026-03-08 02:30:00.000 America/New_York', 'timestamp with time zone', false],
    ['12:00:00.000', 'time(3)', true],
    ['12:00:00', 'time', true],
    ['12:00:00.1234', 'time', false],
    ['12:00:00.000000', 'time(6)', true],
    ['12:00:00.000000', 'time(3)', false],
    ['Alice', 'varchar', true],
    ['Alice', undefined, true],
  ] as const)('isParseableAsType(%s, %s) should be %s', (value, type, expected) => {
    expect(isParseableAsType(value, type)).toBe(expected);
  });
});
