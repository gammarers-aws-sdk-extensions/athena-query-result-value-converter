import type { ColumnInfo, Row } from '@aws-sdk/client-athena';
import {
  convertResultSet as convertResultSetImpl,
  type AthenaConvertedCell,
  type AthenaConvertedRow,
  type ConvertResultSetOptions,
  type HeaderRowPresence,
} from './core/result-set';
import {
  convert as convertImpl,
  isParseableAsType,
  isStringLikeType,
  DEFAULT_UNPARSEABLE_VALUE_BEHAVIOR,
  resolveTemporalOptions,
  toBoolean,
  toDate,
  toNumber,
  type AthenaTypedValue,
  type DateValueKind,
  type UnparseableValueBehavior,
} from './core/typed-value';

export type { AthenaTypedValue, DateValueKind, ToDateOptions, UnparseableValueBehavior } from './core/typed-value';
export type { AthenaConvertedCell, AthenaConvertedRow, ConvertResultSetOptions, HeaderRowPresence };

/**
 * Options for {@link AthenaQueryResultValueConverter.convert}.
 */
export type ConvertOptions = {
  /**
   * How to handle values that cannot be converted based on the column type.
   *
   * Default: `'keep'`.
   *
   * @see UnparseableValueBehavior
   */
  unparseableValueBehavior?: UnparseableValueBehavior;
  /**
   * Zero-based row index included in throw messages when available.
   */
  rowIndex?: number;
  /**
   * IANA time zone for a `timestamp` that has no zone suffix.
   *
   * Default: `'UTC'`. `timestamp with time zone` uses the suffix on the cell.
   * `YYYY-MM-DD HH:mm:ss.SSS` is that zone's wall clock, not the host zone.
   */
  timeZone?: string;
  /**
   * How to return a `date` column.
   *
   * - `'instant'` (default): UTC midnight {@link Date}
   * - `'string'`: the `YYYY-MM-DD` text
   */
  dateValue?: DateValueKind;
};

/**
 * Converts a raw Athena cell using column metadata.
 *
 * `bigint` and `decimal` stay strings. `Number()` cannot represent every
 * signed 64-bit integer, and it drops trailing decimal scale. A `timestamp` with
 * precision above milliseconds stays a string for the same reason. `time` stays a string.
 *
 * @param value - Raw `VarCharValue` (or `null` when missing).
 * @param columnName - Header name used when conversion fails.
 * @param column - Column metadata for this cell.
 * @param options - Conversion options (for example unparseable-value behavior).
 * @returns A typed value, or the original string / `null` when unparseable.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When `timeZone` or `dateValue` is unusable.
 * @throws {@link AthenaQueryResultValueConverterUnparseableValueError} When
 * `unparseableValueBehavior` is `'throw'` and the cell does not match its column type.
 */
const convert = (
  value: string | null,
  columnName: string,
  column: ColumnInfo | undefined,
  options: ConvertOptions = {},
): AthenaTypedValue => {
  const temporal = resolveTemporalOptions(options);
  return convertImpl(
    value,
    columnName,
    column,
    options.unparseableValueBehavior ?? DEFAULT_UNPARSEABLE_VALUE_BEHAVIOR,
    options.rowIndex,
    temporal,
  );
};

/**
 * Converts one `GetQueryResults` page into data rows.
 *
 * Pass `headerRow: 'present'` for the first page and `headerRow: 'absent'` for a page
 * fetched with `NextToken`. NULL is a missing `VarCharValue`.
 *
 * @param columns - `ResultSetMetadata.ColumnInfo` for the query.
 * @param rows - `ResultSet.Rows` for this page.
 * @param options - Required `headerRow`, plus the cell conversion options.
 * @returns Data rows in column order. Duplicate column names stay as separate cells.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When `headerRow`, `timeZone`, or `dateValue` is unusable.
 * @throws {@link AthenaQueryResultValueConverterColumnCountError} When a row's cell count differs from `columns`.
 * @throws {@link AthenaQueryResultValueConverterUnparseableValueError} When a cell does not match its type and
 * `unparseableValueBehavior` is `'throw'`.
 */
const convertResultSet = (
  columns: readonly ColumnInfo[],
  rows: readonly Row[],
  options: ConvertResultSetOptions,
): AthenaConvertedRow[] => {
  return convertResultSetImpl(columns, rows, options);
};

/**
 * Converts Amazon Athena query result cells and result pages using column metadata.
 *
 * `bigint`, `decimal`, `time`, and timestamps finer than milliseconds stay strings.
 */
export const AthenaQueryResultValueConverter = {
  convert,
  convertResultSet,
  toNumber,
  toBoolean,
  toDate,
  isStringLikeType,
  isParseableAsType,
} as const;
