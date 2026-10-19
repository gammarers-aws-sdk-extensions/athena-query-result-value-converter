import type { ColumnInfo } from '@aws-sdk/client-athena';
import { AthenaQueryResultValueConverterUnparseableValueError } from './errors';

/**
 * A parsed Athena cell value that has been converted based on the column type.
 */
export type AthenaTypedValue = string | number | boolean | Date | null;

/**
 * Behavior when a cell cannot be converted for its column type.
 *
 * - `'keep'` (default): keep the original string value
 * - `'null'`: replace with `null`
 * - `'throw'`: throw {@link AthenaQueryResultValueConverterUnparseableValueError}
 */
export type UnparseableValueBehavior = 'keep' | 'null' | 'throw';

const TYPE_TINYINT = 'tinyint' as const;
const TYPE_SMALLINT = 'smallint' as const;
const TYPE_INT = 'int' as const;
const TYPE_INTEGER = 'integer' as const;
const TYPE_BIGINT = 'bigint' as const;
const TYPE_REAL = 'real' as const;
const TYPE_FLOAT = 'float' as const;
const TYPE_DOUBLE = 'double' as const;
const TYPE_DECIMAL = 'decimal' as const;
const TYPE_BOOLEAN = 'boolean' as const;
const TYPE_STRING = 'string' as const;
const TYPE_VARCHAR_PREFIX = 'varchar' as const;
const TYPE_CHAR_PREFIX = 'char' as const;
const TYPE_VARBINARY_PREFIX = 'varbinary' as const;
const TYPE_DATE = 'date' as const;
const TYPE_TIMESTAMP = 'timestamp' as const;
const TYPE_TIMESTAMP_PREFIX = 'timestamp ' as const;
const TYPE_TIME = 'time' as const;
const TYPE_TIME_PREFIX = 'time ' as const;
const DECIMAL_TYPE_PREFIX = 'decimal(' as const;

/**
 * Signed integer widths used by Athena (Trino). These fit in a JavaScript
 * `number` without rounding.
 */
const TINYINT_MIN = -128;
const TINYINT_MAX = 127;
const SMALLINT_MIN = -32768;
const SMALLINT_MAX = 32767;
const INT_MIN = -2147483648;
const INT_MAX = 2147483647;

/**
 * Signed 64-bit bounds. Values in this range are not all safe JavaScript
 * numbers, so `bigint` cells stay decimal text.
 */
const BIGINT_MIN = -9223372036854775808n;
const BIGINT_MAX = 9223372036854775807n;

const SIGNED_INTEGER_PATTERN = /^[+-]?\d+$/;
const DECIMAL_LITERAL_PATTERN = /^[+-]?(\d+)(?:\.(\d+))?$/;
const DECIMAL_TYPE_PATTERN = /^decimal(?:\((\d+)(?:\s*,\s*(\d+))?\))?$/;

type SafeIntegerType = 'tinyint' | 'smallint' | 'int' | 'integer';

const SAFE_INTEGER_RANGE: Record<SafeIntegerType, { readonly min: number; readonly max: number }> = {
  [TYPE_TINYINT]: { min: TINYINT_MIN, max: TINYINT_MAX },
  [TYPE_SMALLINT]: { min: SMALLINT_MIN, max: SMALLINT_MAX },
  [TYPE_INT]: { min: INT_MIN, max: INT_MAX },
  [TYPE_INTEGER]: { min: INT_MIN, max: INT_MAX },
};

type DecimalBounds = {
  readonly precision: number | undefined;
  readonly scale: number | undefined;
};

/**
 * Returns a normalized Athena type string used for comparisons.
 *
 * @param type - Raw Athena column type from metadata.
 * @returns Lowercased trimmed type string, or `''` when missing.
 */
const normalizeType = (type: string | undefined): string => {
  return (type ?? '').trim().toLowerCase();
};

/**
 * Returns whether the normalized type is an integer that fits in a JavaScript `number`.
 *
 * @param type - Normalized Athena column type.
 * @returns `true` for `tinyint`, `smallint`, `int`, and `integer`.
 */
const isSafeIntegerType = (type: string): type is SafeIntegerType =>
  type === TYPE_TINYINT ||
  type === TYPE_SMALLINT ||
  type === TYPE_INT ||
  type === TYPE_INTEGER;

/**
 * Returns whether the normalized type is an approximate numeric type.
 *
 * @param type - Normalized Athena column type.
 * @returns `true` for `real`, `float`, and `double`.
 */
const isApproximateNumericType = (type: string): boolean =>
  type === TYPE_REAL || type === TYPE_FLOAT || type === TYPE_DOUBLE;

/**
 * Returns whether the normalized type is `decimal` or `decimal(...)`.
 *
 * @param type - Normalized Athena column type.
 * @returns `true` when the type is a decimal.
 */
const isDecimalType = (type: string): boolean =>
  type === TYPE_DECIMAL || type.startsWith(DECIMAL_TYPE_PREFIX);

/**
 * Accepts a non-negative integer from column metadata.
 *
 * @param value - `Precision` or `Scale` from `ColumnInfo`.
 * @returns The value when it is a non-negative integer, otherwise `undefined`.
 */
const readNonNegativeInteger = (value: number | undefined): number | undefined => {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value < 0) return undefined;
  return value;
};

/**
 * Reads `decimal(precision, scale)` from an Athena type string.
 *
 * @param type - Normalized Athena column type.
 * @returns Bounds found in the type string. Missing groups are `undefined`.
 */
const parseDecimalType = (type: string): DecimalBounds | undefined => {
  const match = DECIMAL_TYPE_PATTERN.exec(type);
  if (match == null) return undefined;

  const precision = match[1] != null ? Number(match[1]) : undefined;
  const scale = match[2] != null ? Number(match[2]) : undefined;
  return { precision, scale };
};

/**
 * Prefers `ColumnInfo.Precision` and `ColumnInfo.Scale`.
 * Falls back to `decimal(p,s)` written on `ColumnInfo.Type`.
 *
 * @param column - Column metadata for a decimal cell.
 * @returns Digit bounds. Either field may be missing.
 */
const resolveDecimalBounds = (column: ColumnInfo | undefined): DecimalBounds => {
  const fromType = parseDecimalType(normalizeType(column?.Type));
  return {
    precision: readNonNegativeInteger(column?.Precision) ?? fromType?.precision,
    scale: readNonNegativeInteger(column?.Scale) ?? fromType?.scale,
  };
};

/**
 * Counts integer digits after dropping leading zeros.
 *
 * @param integerPart - Digits to the left of the decimal point.
 * @returns The count of significant integer digits. `0` when the part is only zeros.
 */
const significantIntegerDigits = (integerPart: string): number =>
  integerPart.replace(/^0+/, '').length;

/**
 * Safely converts a string value to a finite number.
 *
 * Returns `null` when the value is `null`, empty/whitespace, or not a finite number.
 *
 * @param value - Raw Athena cell value.
 * @returns A finite number, or `null` when conversion is not possible.
 */
export const toNumber = (value: string | null): number | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

/**
 * Safely converts a string value to a boolean.
 *
 * Accepts (case-insensitive) `'true'` and `'false'`.
 * Returns `null` for `null`, empty/whitespace, or unrecognized values.
 *
 * @param value - Raw Athena cell value.
 * @returns `true` / `false`, or `null` when conversion is not possible.
 */
export const toBoolean = (value: string | null): boolean | null => {
  if (value == null) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return null;
};

/**
 * Safely converts a string value to a {@link Date}.
 *
 * Uses {@link Date.parse} and returns `null` when parsing fails.
 *
 * @param value - Raw Athena cell value.
 * @returns A {@link Date}, or `null` when conversion is not possible.
 */
export const toDate = (value: string | null): Date | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? null : new Date(ms);
};

/**
 * Converts a safe integer cell to `number` when it fits the Athena type.
 *
 * @param value - Raw cell text.
 * @param type - `tinyint`, `smallint`, `int`, or `integer`.
 * @returns The integer, or `null` when the text is not in range.
 */
const toRangedInteger = (value: string, type: SafeIntegerType): number | null => {
  const trimmed = value.trim();
  if (!SIGNED_INTEGER_PATTERN.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return null;

  const range = SAFE_INTEGER_RANGE[type];
  if (parsed < range.min || parsed > range.max) return null;
  return parsed;
};

/**
 * Keeps a `bigint` cell as decimal text when it fits in signed 64 bits.
 *
 * `Number('9223372036854775807')` becomes `9223372036854776000`, so this path
 * never calls `Number()`.
 *
 * @param value - Raw cell text.
 * @returns Trimmed decimal text, or `null` when it is not a signed 64-bit integer.
 */
const toBigIntString = (value: string): string | null => {
  const trimmed = value.trim();
  if (!SIGNED_INTEGER_PATTERN.test(trimmed)) return null;

  // `BigInt` rejects a leading `+`. The returned text still keeps that sign.
  const digits = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  const parsed = BigInt(digits);
  if (parsed < BIGINT_MIN || parsed > BIGINT_MAX) return null;
  return trimmed;
};

/**
 * Keeps a `decimal` cell as text, including trailing fractional zeros.
 *
 * Digit limits use column precision and scale when metadata provides them.
 * `Number('1.50')` is `1.5`, so this path never calls `Number()`.
 *
 * @param value - Raw cell text.
 * @param column - Column metadata. `Precision` and `Scale` constrain the text.
 * @returns Trimmed decimal text, or `null` when it does not match the type.
 */
const toDecimalString = (value: string, column: ColumnInfo | undefined): string | null => {
  const trimmed = value.trim();
  const match = DECIMAL_LITERAL_PATTERN.exec(trimmed);
  if (match == null) return null;

  const integerPart = match[1] ?? '';
  const fractionPart = match[2] ?? '';
  const { precision, scale } = resolveDecimalBounds(column);

  if (precision != null && scale != null && precision < scale) return null;
  if (scale != null && fractionPart.length > scale) return null;

  if (precision != null && scale != null) {
    if (significantIntegerDigits(integerPart) > precision - scale) return null;
    return trimmed;
  }

  if (precision != null) {
    if (significantIntegerDigits(integerPart) + fractionPart.length > precision) return null;
    return trimmed;
  }

  return trimmed;
};

/**
 * Applies {@link UnparseableValueBehavior} when a cell does not match its column type.
 *
 * @param value - Original cell text.
 * @param columnName - Header name stored on the thrown error.
 * @param columnType - Raw Athena column type, when metadata provided one.
 * @param behavior - Whether to keep the text, return `null`, or throw.
 * @param rowIndex - Optional zero-based row index included when throwing.
 * @returns The original string or `null`.
 * @throws {@link AthenaQueryResultValueConverterUnparseableValueError} When `behavior` is `'throw'`.
 */
const unparseableTypedValue = (
  value: string,
  columnName: string,
  columnType: string | undefined,
  behavior: UnparseableValueBehavior,
  rowIndex?: number,
): AthenaTypedValue => {
  if (behavior === 'null') return null;
  if (behavior === 'throw') {
    throw new AthenaQueryResultValueConverterUnparseableValueError(
      columnName,
      columnType,
      value,
      rowIndex,
    );
  }
  return value;
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
 * @param unparseable - Whether to keep the original string, return `null`, or throw.
 * @param rowIndex - Optional zero-based row index included when throwing.
 * @returns A typed value, or the original string / `null` when unparseable.
 * @throws {@link AthenaQueryResultValueConverterUnparseableValueError} When `unparseable` is `'throw'` and the cell
 * does not match its column type.
 */
export const convert = (
  value: string | null,
  columnName: string,
  column: ColumnInfo | undefined,
  unparseable: UnparseableValueBehavior,
  rowIndex?: number,
): AthenaTypedValue => {
  if (value == null) return null;

  const normalized = normalizeType(column?.Type);
  const reject = (): AthenaTypedValue => unparseableTypedValue(
    value,
    columnName,
    column?.Type,
    unparseable,
    rowIndex,
  );

  if (isSafeIntegerType(normalized)) {
    const parsed = toRangedInteger(value, normalized);
    if (parsed != null) return parsed;
    return reject();
  }

  if (normalized === TYPE_BIGINT) {
    const parsed = toBigIntString(value);
    if (parsed != null) return parsed;
    return reject();
  }

  if (isDecimalType(normalized)) {
    const parsed = toDecimalString(value, column);
    if (parsed != null) return parsed;
    return reject();
  }

  if (isApproximateNumericType(normalized)) {
    const parsed = toNumber(value);
    if (parsed != null) return parsed;
    return reject();
  }

  if (isBooleanLikeType(normalized)) {
    const parsed = toBoolean(value);
    if (parsed != null) return parsed;
    return reject();
  }

  if (isDateTimeLikeType(normalized)) {
    const parsed = toDate(value);
    if (parsed != null) return parsed;
    return reject();
  }

  return value;
};

/**
 * Returns whether the Athena type is treated as a string-like type.
 *
 * @param type - Raw Athena column type from metadata.
 * @returns `true` for string/varchar/char/varbinary-like types.
 */
export const isStringLikeType = (type: string | undefined): boolean => {
  const normalized = normalizeType(type);
  return (
    normalized === TYPE_STRING ||
    normalized.startsWith(TYPE_VARCHAR_PREFIX) ||
    normalized.startsWith(TYPE_CHAR_PREFIX) ||
    normalized.startsWith(TYPE_VARBINARY_PREFIX)
  );
};

/**
 * Returns whether header-row detection should treat the type as numeric.
 *
 * This check is looser than typed row conversion. Detection only needs to know
 * whether a header cell is unlikely to be data.
 *
 * @param type - Normalized Athena column type.
 * @returns `true` for integer, floating, and decimal types.
 */
const isNumericLikeType = (type: string): boolean => {
  return (
    type === TYPE_TINYINT ||
    type === TYPE_SMALLINT ||
    type === TYPE_INT ||
    type === TYPE_INTEGER ||
    type === TYPE_BIGINT ||
    type === TYPE_REAL ||
    type === TYPE_FLOAT ||
    type === TYPE_DOUBLE ||
    type.startsWith(TYPE_DECIMAL)
  );
};

/**
 * Returns whether the Athena type is treated as a boolean type.
 *
 * @param type - Raw or normalized Athena column type.
 * @returns `true` when the type is `boolean`.
 */
const isBooleanLikeType = (type: string | undefined): boolean => {
  return normalizeType(type) === TYPE_BOOLEAN;
};

/**
 * Returns whether the Athena type is treated as a date/time-like type.
 *
 * @param type - Raw or normalized Athena column type.
 * @returns `true` for date/timestamp/time-like types.
 */
const isDateTimeLikeType = (type: string | undefined): boolean => {
  const normalized = normalizeType(type);
  return (
    normalized === TYPE_DATE ||
    normalized === TYPE_TIMESTAMP ||
    normalized.startsWith(TYPE_TIMESTAMP_PREFIX) ||
    normalized === TYPE_TIME ||
    normalized.startsWith(TYPE_TIME_PREFIX)
  );
};

/**
 * Returns whether a string value looks parseable for the given Athena type.
 *
 * Used for strategies that decide whether a header-looking row is unlikely to
 * be valid data.
 *
 * @param value - Cell value from the first row.
 * @param type - Athena column type for that cell.
 * @returns `true` when `value` appears valid for `type`.
 */
export const isParseableAsType = (value: string, type: string | undefined): boolean => {
  const normalized = normalizeType(type);
  if (isNumericLikeType(normalized)) {
    return Number.isFinite(Number(value));
  }
  if (isBooleanLikeType(normalized)) {
    return value === 'true' || value === 'false';
  }
  if (isDateTimeLikeType(normalized)) {
    // Athena typically returns ISO-like strings for date/time types.
    // Keep this strict so column names are not classified as data.
    return !Number.isNaN(Date.parse(value));
  }
  // Complex and string-like types are treated as parseable.
  return true;
};
