# Athena Query Result Value Converter

[![npm version](https://img.shields.io/npm/v/athena-query-result-value-converter?style=flat-square)](https://www.npmjs.com/package/athena-query-result-value-converter)
[![license](https://img.shields.io/npm/l/athena-query-result-value-converter?style=flat-square)](https://www.npmjs.com/package/athena-query-result-value-converter)
[![Node.js](https://img.shields.io/node/v/athena-query-result-value-converter?style=flat-square)](https://www.npmjs.com/package/athena-query-result-value-converter)
[![build](https://img.shields.io/github/actions/workflow/status/gammarers-aws-sdk-extensions/athena-query-result-value-converter/build.yml?label=build&style=flat-square)](https://github.com/gammarers-aws-sdk-extensions/athena-query-result-value-converter/actions/workflows/build.yml)

A TypeScript library that converts Amazon Athena query result cell values using `ColumnInfo` types from `@aws-sdk/client-athena`. It keeps `bigint` and `decimal` as strings so large integers and trailing scale are preserved.

## Features

* **Type-aware conversion**: `AthenaQueryResultValueConverter.convert` maps cells from `ColumnInfo.Type` (and `Precision` / `Scale` for decimals).
* **Safe helpers**: `toNumber`, `toBoolean`, and `toDate` for `string | null` values.
* **Unparseable value handling**: `keep` (default), `null`, or `throw` with a typed error.
* **Type predicates**: `isStringLikeType` and `isParseableAsType` for header-row detection and similar checks.

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

const n = toNumber(row.count); // number | null
const b = toBoolean(row.is_active); // boolean | null
const d = toDate(row.created_at); // Date | null

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

try {
  convert('not-a-number', 'n', { Name: 'n', Type: 'integer' }, {
    unparseableValueBehavior: 'throw',
  });
} catch (error) {
  if (error instanceof AthenaQueryResultValueConverterUnparseableValueError) {
    console.error(error.code, error.columnName, error.value);
  } else if (error instanceof AthenaQueryResultValueConverterError) {
    console.error(error.code, error.message);
  }
}
```

## Options

### `ConvertOptions`

Accepted by `AthenaQueryResultValueConverter.convert`.

| Option                   | Default  | Description                                                                                    |
| ------------------------ | -------- | ---------------------------------------------------------------------------------------------- |
| unparseableValueBehavior | `'keep'` | `'keep'` returns the original string. `'null'` returns `null`. `'throw'` throws a typed error. |
| rowIndex                 | omitted  | Zero-based row index included in throw messages.                                               |

`tinyint`, `smallint`, `int`, and `integer` become `number` when the cell is a base-10 integer inside that type's range. `bigint` stays a string when it fits in signed 64 bits. `decimal` stays a string, including trailing fractional zeros. Digit limits for `decimal` use `ColumnInfo.Precision` and `ColumnInfo.Scale`, or `decimal(p,s)` on `Type` when those fields are absent. `real`, `float`, and `double` become `number`.

## Requirements

* Node.js >= 20

## License

This project is licensed under the Apache-2.0 License.
