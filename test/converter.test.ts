import type { ColumnInfo } from '@aws-sdk/client-athena';
import {
  AthenaQueryResultValueConverter,
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

  it('toDate should parse ISO-like timestamps', () => {
    const d = toDate('2026-01-01T00:00:00.000Z');
    expect(d).not.toBeNull();
    expect(d!.toISOString()).toBe('2026-01-01T00:00:00.000Z');
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
      '2026-01-01T00:00:00.000Z',
      'created_at',
      makeColumn('timestamp'),
    );
    expect(createdAt).toBeInstanceOf(Date);
    expect((createdAt as Date).toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(convert('Alice', 'name', makeColumn('varchar'))).toBe('Alice');
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
  ] as const)('isStringLikeType(%s) should be %s', (type, expected) => {
    expect(isStringLikeType(type)).toBe(expected);
  });

  it.each([
    ['42', 'integer', true],
    ['id', 'integer', false],
    ['true', 'boolean', true],
    ['yes', 'boolean', false],
    ['2026-01-01', 'date', true],
    ['created_at', 'timestamp', false],
    ['Alice', 'varchar', true],
  ] as const)('isParseableAsType(%s, %s) should be %s', (value, type, expected) => {
    expect(isParseableAsType(value, type)).toBe(expected);
  });
});
