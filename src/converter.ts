import type { ColumnInfo } from '@aws-sdk/client-athena';
import {
  convert as convertImpl,
  isParseableAsType,
  isStringLikeType,
  toBoolean,
  toDate,
  toNumber,
  type AthenaTypedValue,
  type UnparseableValueBehavior,
} from './core/typed-value';

export type { AthenaTypedValue, UnparseableValueBehavior };

/**
 * Default behavior when a cell cannot be converted for its column type.
 */
const DEFAULT_UNPARSEABLE_VALUE_BEHAVIOR: UnparseableValueBehavior = 'keep';

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
};

/**
 * Converts a raw Athena cell using column metadata.
 *
 * `bigint` and `decimal` stay strings. `Number()` cannot represent every
 * signed 64-bit integer, and it drops trailing decimal scale.
 *
 * @param value - Raw `VarCharValue` (or `null` when missing).
 * @param columnName - Header name used when conversion fails.
 * @param column - Column metadata for this cell.
 * @param options - Conversion options (for example unparseable-value behavior).
 * @returns A typed value, or the original string / `null` when unparseable.
 * @throws {@link AthenaQueryResultValueConverterUnparseableValueError} When
 * `unparseableValueBehavior` is `'throw'` and the cell does not match its column type.
 */
const convert = (
  value: string | null,
  columnName: string,
  column: ColumnInfo | undefined,
  options: ConvertOptions = {},
): AthenaTypedValue => {
  return convertImpl(
    value,
    columnName,
    column,
    options.unparseableValueBehavior ?? DEFAULT_UNPARSEABLE_VALUE_BEHAVIOR,
    options.rowIndex,
  );
};

/**
 * Converts Amazon Athena query result cell values using column metadata.
 *
 * `bigint` and `decimal` stay strings so large integers and trailing scale are
 * preserved.
 */
export const AthenaQueryResultValueConverter = {
  convert,
  toNumber,
  toBoolean,
  toDate,
  isStringLikeType,
  isParseableAsType,
} as const;
