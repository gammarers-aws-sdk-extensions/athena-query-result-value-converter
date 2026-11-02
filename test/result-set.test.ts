import type { ColumnInfo, Row } from '@aws-sdk/client-athena';
import {
  AthenaQueryResultValueConverter,
  AthenaQueryResultValueConverterArgumentError,
  AthenaQueryResultValueConverterColumnCountError,
  AthenaQueryResultValueConverterUnparseableValueError,
} from '../src';

const { convertResultSet } = AthenaQueryResultValueConverter;

const columns: ColumnInfo[] = [
  { Name: 'user_id', Type: 'integer' },
  { Name: 'created_at', Type: 'timestamp' },
  { Name: 'birth_date', Type: 'date' },
];

const header: Row = {
  Data: [
    { VarCharValue: 'user_id' },
    { VarCharValue: 'created_at' },
    { VarCharValue: 'birth_date' },
  ],
};

const dataRow: Row = {
  Data: [
    { VarCharValue: '7' },
    { VarCharValue: '2026-01-01 00:00:00.000' },
    { VarCharValue: '2026-01-01' },
  ],
};

describe('AthenaQueryResultValueConverter.convertResultSet', () => {
  it('should skip the header on the first page and convert the next page in full', () => {
    const first = convertResultSet(columns, [header, dataRow], { headerRow: 'present' });
    const next = convertResultSet(columns, [dataRow], {
      headerRow: 'absent',
      timeZone: 'Asia/Tokyo',
      dateValue: 'string',
    });

    expect(first).toEqual([
      {
        cells: [
          { name: 'user_id', value: 7 },
          { name: 'created_at', value: new Date('2026-01-01T00:00:00.000Z') },
          { name: 'birth_date', value: new Date('2026-01-01T00:00:00.000Z') },
        ],
      },
    ]);
    expect(next).toEqual([
      {
        cells: [
          { name: 'user_id', value: 7 },
          { name: 'created_at', value: new Date('2025-12-31T15:00:00.000Z') },
          { name: 'birth_date', value: '2026-01-01' },
        ],
      },
    ]);
  });

  it('should treat a missing VarCharValue as null and keep an empty string', () => {
    const rows = convertResultSet(
      columns,
      [{ Data: [{ VarCharValue: '7' }, {}, { VarCharValue: '' }] }],
      { headerRow: 'absent' },
    );

    expect(rows[0]?.cells.map((cell) => cell.value)).toEqual([7, null, '']);
  });

  it('should keep duplicate column names in order', () => {
    const rows = convertResultSet(
      [
        { Name: 'id', Type: 'integer' },
        { Name: 'id', Type: 'integer' },
      ],
      [{ Data: [{ VarCharValue: '1' }, { VarCharValue: '2' }] }],
      { headerRow: 'absent' },
    );

    expect(rows).toEqual([
      {
        cells: [
          { name: 'id', value: 1 },
          { name: 'id', value: 2 },
        ],
      },
    ]);
  });

  it('should use an empty name when ColumnInfo.Name is missing', () => {
    const rows = convertResultSet(
      [{ Name: undefined, Type: 'integer' }],
      [{ Data: [{ VarCharValue: '4' }] }],
      { headerRow: 'absent' },
    );

    expect(rows).toEqual([{ cells: [{ name: '', value: 4 }] }]);
  });

  it('should return no data rows when the page is only a header or empty', () => {
    expect(convertResultSet(columns, [header], { headerRow: 'present' })).toEqual([]);
    expect(convertResultSet(columns, [], { headerRow: 'present' })).toEqual([]);
    expect(convertResultSet(columns, [], { headerRow: 'absent' })).toEqual([]);
  });

  it('should throw when a row has no Data array', () => {
    expect(() => convertResultSet(columns, [{}], { headerRow: 'absent' }))
      .toThrow('Expected 3 cells at row index 0 but received 0');
  });

  it('should throw when a data row or the header row has the wrong cell count', () => {
    const short: Row = { Data: [{ VarCharValue: '7' }] };

    expect(() => convertResultSet(columns, [short], { headerRow: 'absent' }))
      .toThrow(AthenaQueryResultValueConverterColumnCountError);
    expect(() => convertResultSet(columns, [short, dataRow], { headerRow: 'present' }))
      .toThrow('Expected 3 cells at row index 0 but received 1');

    try {
      convertResultSet(columns, [header, short], { headerRow: 'present' });
    } catch (error) {
      expect(error).toMatchObject({
        code: 'column-count',
        rowIndex: 1,
        expected: 3,
        actual: 1,
      });
    }
  });

  it('should throw the cell error with the index in the page rows', () => {
    const rows: Row[] = [
      header,
      { Data: [{ VarCharValue: 'nope' }, { VarCharValue: '2026-01-01 00:00:00.000' }, { VarCharValue: '2026-01-01' }] },
    ];

    expect(() =>
      convertResultSet(columns, rows, {
        headerRow: 'present',
        unparseableValueBehavior: 'throw',
      }),
    ).toThrow(AthenaQueryResultValueConverterUnparseableValueError);

    try {
      convertResultSet(columns, rows, {
        headerRow: 'present',
        unparseableValueBehavior: 'throw',
      });
    } catch (error) {
      expect(error).toMatchObject({ rowIndex: 1, columnName: 'user_id', value: 'nope' });
    }
  });

  it('should throw when headerRow is missing or unknown', () => {
    expect(() =>
      convertResultSet(columns, [], {} as { headerRow: 'present' }),
    ).toThrow(AthenaQueryResultValueConverterArgumentError);
    expect(() =>
      convertResultSet(columns, [], { headerRow: 'guess' as 'present' }),
    ).toThrow("headerRow must be 'present' or 'absent'");
  });
});
