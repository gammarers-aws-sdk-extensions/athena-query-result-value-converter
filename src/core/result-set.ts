import type { ColumnInfo, Row } from '@aws-sdk/client-athena';
import {
  AthenaQueryResultValueConverterArgumentError,
  AthenaQueryResultValueConverterColumnCountError,
} from './errors';
import {
  convert,
  resolveTemporalOptions,
  type AthenaTypedValue,
  type DateValueKind,
  type UnparseableValueBehavior,
} from './typed-value';

const HEADER_ROW_PRESENT = 'present' as const;
const HEADER_ROW_ABSENT = 'absent' as const;
const DEFAULT_UNPARSEABLE_VALUE_BEHAVIOR: UnparseableValueBehavior = 'keep';

/**
 * Whether the `Row[]` for this page still starts with column names.
 *
 * The first `GetQueryResults` page uses `'present'`. A page fetched with `NextToken` uses `'absent'`.
 */
export type HeaderRowPresence = typeof HEADER_ROW_PRESENT | typeof HEADER_ROW_ABSENT;

/**
 * One converted cell, in `ColumnInfo` order.
 *
 * `name` is `ColumnInfo.Name`, or `''` when the metadata has no name.
 * Duplicate names stay as separate cells.
 */
export type AthenaConvertedCell = {
  readonly name: string;
  readonly value: AthenaTypedValue;
};

/**
 * One data row. `cells` follows `ColumnInfo` order and keeps duplicate column names.
 */
export type AthenaConvertedRow = {
  readonly cells: readonly AthenaConvertedCell[];
};

/**
 * Options for {@link convertResultSet}.
 *
 * `headerRow` is required so a later page is not treated as if it still had column names.
 */
export type ConvertResultSetOptions = {
  /**
   * `'present'` skips the first row. `'absent'` converts every row.
   */
  headerRow: HeaderRowPresence;
  /**
   * How to handle a cell that does not match its column type.
   *
   * Default: `'keep'`.
   */
  unparseableValueBehavior?: UnparseableValueBehavior;
  /**
   * IANA time zone for `timestamp` without a zone suffix.
   *
   * Default: `'UTC'`.
   */
  timeZone?: string;
  /**
   * How to return a `date` column.
   *
   * Default: `'instant'`.
   */
  dateValue?: DateValueKind;
};

/**
 * Rejects a missing or unknown `headerRow`.
 *
 * @param headerRow - Caller-supplied page flag.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When the flag is not `'present'` or `'absent'`.
 */
const requireHeaderRow = (headerRow: string | undefined): HeaderRowPresence => {
  if (headerRow === HEADER_ROW_PRESENT || headerRow === HEADER_ROW_ABSENT) return headerRow;
  throw new AthenaQueryResultValueConverterArgumentError(
    "headerRow must be 'present' or 'absent'",
  );
};

/**
 * Converts one `GetQueryResults` page into data rows.
 *
 * Every cell in the service response is `Datum.VarCharValue` text. A missing `VarCharValue` is NULL.
 * A row whose cell count differs from `columns`, including the header row, throws.
 * The returned cells stay in column order, so duplicate names are not collapsed into one object entry.
 *
 * @param columns - `ResultSetMetadata.ColumnInfo` for the query. Later pages repeat this metadata.
 * @param rows - `ResultSet.Rows` for this page only.
 * @param options - Page header flag and the same value options as cell conversion.
 * @returns Data rows. The header row is not included.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When `headerRow`, `timeZone`, or `dateValue` is unusable.
 * @throws {@link AthenaQueryResultValueConverterColumnCountError} When a row's cell count differs from `columns`.
 * @throws {@link AthenaQueryResultValueConverterUnparseableValueError} When a cell does not match its type and
 * `unparseableValueBehavior` is `'throw'`. `rowIndex` is the index in `rows`.
 */
export const convertResultSet = (
  columns: readonly ColumnInfo[],
  rows: readonly Row[],
  options: ConvertResultSetOptions,
): AthenaConvertedRow[] => {
  const headerRow = requireHeaderRow(options?.headerRow);
  const temporal = resolveTemporalOptions(options);
  const behavior = options.unparseableValueBehavior ?? DEFAULT_UNPARSEABLE_VALUE_BEHAVIOR;
  const columnCount = columns.length;
  const converted: AthenaConvertedRow[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const data = rows[rowIndex]?.Data;
    const actual = data?.length ?? 0;
    if (actual !== columnCount) {
      throw new AthenaQueryResultValueConverterColumnCountError(rowIndex, columnCount, actual);
    }
    if (headerRow === HEADER_ROW_PRESENT && rowIndex === 0) continue;

    const cells: AthenaConvertedCell[] = [];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex++) {
      const column = columns[columnIndex];
      const raw = data?.[columnIndex]?.VarCharValue;
      const name = column?.Name ?? '';
      cells.push({
        name,
        value: convert(raw == null ? null : raw, name, column, behavior, rowIndex, temporal),
      });
    }
    converted.push({ cells });
  }

  return converted;
};
