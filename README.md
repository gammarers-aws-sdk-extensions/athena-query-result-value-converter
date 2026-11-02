# Athena Query Result Value Converter

[![npm version](https://img.shields.io/npm/v/athena-query-result-value-converter?style=flat-square)](https://www.npmjs.com/package/athena-query-result-value-converter)
[![license](https://img.shields.io/npm/l/athena-query-result-value-converter?style=flat-square)](https://www.npmjs.com/package/athena-query-result-value-converter)
[![Node.js](https://img.shields.io/node/v/athena-query-result-value-converter?style=flat-square)](https://www.npmjs.com/package/athena-query-result-value-converter)
[![build](https://img.shields.io/github/actions/workflow/status/gammarers-aws-sdk-extensions/athena-query-result-value-converter/build.yml?label=build&style=flat-square)](https://github.com/gammarers-aws-sdk-extensions/athena-query-result-value-converter/actions/workflows/build.yml)

A TypeScript library that converts Amazon Athena query result cells and result-set rows using `ColumnInfo` types from `@aws-sdk/client-athena`. It keeps `bigint`, `decimal`, `time`, and timestamps finer than milliseconds as strings.

## Features

* **Type-aware conversion**: `AthenaQueryResultValueConverter.convert` maps cells from `ColumnInfo.Type` (and `Precision` / `Scale` for decimals and temporal types).
* **Result pages**: `convertResultSet` turns one `GetQueryResults` page into rows. `headerRow` says whether that page still starts with column names.
* **Safe helpers**: `toNumber`, `toBoolean`, and `toDate` for `string | null` values. `toDate` accepts Athena timestamp and `YYYY-MM-DD` literals.
* **Unparseable value handling**: `keep` (default), `null`, or `throw` with a typed error.
* **Type predicates**: `isStringLikeType` and `isParseableAsType` use the same literals as `convert`.

## Installation

### npm

```bash
npm install athena-query-result-value-converter
```

### yarn

```bash
yarn add athena-query-result-value-converter
```

### pnpm

```bash
pnpm add athena-query-result-value-converter
```

`@aws-sdk/client-athena` (v3) is a dependency. Import `ColumnInfo` from that package when you need column metadata types.

## Usage

```ts
import { AthenaQueryResultValueConverter } from 'athena-query-result-value-converter';
import type { ColumnInfo } from '@aws-sdk/client-athena';

const { convert, toNumber, toBoolean, toDate } = AthenaQueryResultValueConverter;

const n = toNumber('1.25'); // number | null
const b = toBoolean('true'); // boolean | null
const d = toDate('2026-01-01 00:00:00.000'); // Date → 2026-01-01T00:00:00.000Z

const column: ColumnInfo = { Name: 'user_id', Type: 'bigint' };
const typed = convert('9223372036854775807', 'user_id', column);
// bigint → string (exact decimal text)

const amount = convert('1.50', 'amount', {
  Name: 'amount',
  Type: 'decimal',
  Precision: 10,
  Scale: 2,
});
// decimal → string (trailing scale kept)

const createdAt = convert('2026-01-01 00:00:00.000', 'created_at', {
  Name: 'created_at',
  Type: 'timestamp',
}, { timeZone: 'Asia/Tokyo' });
// Date → 2025-12-31T15:00:00.000Z

const birthDate = convert('2026-01-01', 'birth_date', {
  Name: 'birth_date',
  Type: 'date',
}, { dateValue: 'string' });
// '2026-01-01'
```

### Unparseable values

```ts
import {
  AthenaQueryResultValueConverter,
  AthenaQueryResultValueConverterError,
  AthenaQueryResultValueConverterUnparseableValueError,
} from 'athena-query-result-value-converter';

const { convert } = AthenaQueryResultValueConverter;

convert('not-a-number', 'n', { Name: 'n', Type: 'integer' }); // 'not-a-number'
convert('not-a-number', 'n', { Name: 'n', Type: 'integer' }, {
  unparseableValueBehavior: 'null',
}); // null

const reportConvertError = (error: unknown): void => {
  if (error instanceof AthenaQueryResultValueConverterUnparseableValueError) {
    console.error(error.code, error.columnName, error.value);
    return;
  }
  if (error instanceof AthenaQueryResultValueConverterError) {
    console.error(error.code, error.message);
  }
};

try {
  convert('not-a-number', 'n', { Name: 'n', Type: 'integer' }, {
    unparseableValueBehavior: 'throw',
  });
} catch (error) {
  reportConvertError(error);
}
```

### Result pages

`GetQueryResults` returns every cell as `Datum.VarCharValue`. NULL is a missing property. The first page starts with the column names. A page fetched with `NextToken` does not.

```ts
import { AthenaQueryResultValueConverter } from 'athena-query-result-value-converter';
import type { ColumnInfo, Row } from '@aws-sdk/client-athena';

const { convertResultSet } = AthenaQueryResultValueConverter;

const columns: ColumnInfo[] = [
  { Name: 'user_id', Type: 'bigint' },
  { Name: 'created_at', Type: 'timestamp' },
];

const firstPage: Row[] = [
  { Data: [{ VarCharValue: 'user_id' }, { VarCharValue: 'created_at' }] },
  { Data: [{ VarCharValue: '9223372036854775807' }, { VarCharValue: '2026-01-01 00:00:00.000' }] },
];

const firstRows = convertResultSet(columns, firstPage, { headerRow: 'present' });
const nextPage: Row[] = [
  { Data: [{ VarCharValue: '1' }, {}] },
];
const nextRows = convertResultSet(columns, nextPage, { headerRow: 'absent' });
// nextRows[0].cells[1].value === null
```

`cells` follows `ColumnInfo` order. Two columns with the same name stay as two cells.

## Options

### `ConvertOptions`

Accepted by `AthenaQueryResultValueConverter.convert`.

| Option                   | Default     | Description                                                                                          |
| ------------------------ | ----------- | ---------------------------------------------------------------------------------------------------- |
| unparseableValueBehavior | `'keep'`    | `UnparseableValueBehavior`. `'keep'` returns the original string. `'null'` returns `null`. `'throw'` throws a typed error. |
| rowIndex                 | omitted     | Zero-based row index included in throw messages.                                                     |
| timeZone                 | `'UTC'`     | IANA time zone for `timestamp` without a zone suffix. `timestamp with time zone` uses the suffix.  |
| dateValue                | `'instant'` | `DateValueKind`. `'instant'` returns `date` as a UTC-midnight `Date`. `'string'` returns the `YYYY-MM-DD` text. |

An unusable `timeZone` or `dateValue` throws `AthenaQueryResultValueConverterArgumentError`.

`tinyint`, `smallint`, `int`, and `integer` become `number` when the cell is a base-10 integer inside that type's range. `bigint` stays a string when it fits in signed 64 bits. `decimal` stays a string, including trailing fractional zeros. Digit limits for `decimal` use `ColumnInfo.Precision` and `ColumnInfo.Scale`, or `decimal(p,s)` on `Type` when those fields are absent. `real`, `float`, and `double` become `number`.

`timestamp`, `timestamp(p)`, and the `with time zone` forms accept Athena literals such as `2026-01-01 00:00:00.000` and `2026-01-01 00:00:00.000 Asia/Tokyo`. Precision comes from `ColumnInfo.Precision`, then `(p)`, then 3. Precision above 3 stays the original text, including when `unparseableValueBehavior` is `'throw'`. A repeated local time becomes the earlier instant. A skipped local time is unparseable. `time` and `time(p)` stay text. `date` accepts `YYYY-MM-DD` only.

### `ToDateOptions`

Accepted by `AthenaQueryResultValueConverter.toDate`.

| Option   | Default | Description                                                                                          |
| -------- | ------- | ---------------------------------------------------------------------------------------------------- |
| timeZone | `'UTC'` | IANA time zone when the text has no zone suffix. A suffix on the value wins. `YYYY-MM-DD` stays UTC midnight. An unusable name throws `AthenaQueryResultValueConverterArgumentError`. |

### `ConvertResultSetOptions`

Accepted by `AthenaQueryResultValueConverter.convertResultSet`.

| Option                   | Default     | Description                                                                                     |
| ------------------------ | ----------- | ----------------------------------------------------------------------------------------------- |
| headerRow                | required    | `HeaderRowPresence`. `'present'` skips the first row. `'absent'` converts every row. Set this per page. |
| unparseableValueBehavior | `'keep'`    | Same as `ConvertOptions`.                                                                       |
| timeZone                 | `'UTC'`     | Same as `ConvertOptions`.                                                                       |
| dateValue                | `'instant'` | Same as `ConvertOptions`.                                                                       |

A row whose cell count differs from `columns` throws `AthenaQueryResultValueConverterColumnCountError`, including the header row. `rowIndex` on that error, and on an unparseable cell, is the index in the `rows` argument.

## Requirements

* Node.js >= 20

## License

This project is licensed under the Apache-2.0 License.
