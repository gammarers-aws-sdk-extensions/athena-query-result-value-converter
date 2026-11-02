/**
 * Base error thrown by Athena query result value conversion.
 *
 * Catch this type to handle every converter failure, or catch a subclass for a
 * specific case. {@link code} is a stable machine-readable identifier.
 */
export abstract class AthenaQueryResultValueConverterError extends Error {
  /**
   * Stable error code for logging, metrics, and programmatic handling.
   */
  abstract readonly code: string;

  override readonly name: string = 'AthenaQueryResultValueConverterError';

  protected constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, AthenaQueryResultValueConverterError.prototype);
  }
}

/**
 * Builds the message for {@link AthenaQueryResultValueConverterUnparseableValueError}.
 *
 * @param columnName - Header name of the cell that could not be converted.
 * @param columnType - Raw Athena column type, when metadata provided one.
 * @param value - Original cell text that failed conversion.
 * @param rowIndex - Optional zero-based row index included in the message.
 * @returns A human-readable error message.
 */
const describeUnparseableValue = (
  columnName: string,
  columnType: string | undefined,
  value: string,
  rowIndex?: number,
): string => {
  const rowPart = rowIndex != null ? ` at row index ${rowIndex}` : '';
  const typePart = columnType != null && columnType.length > 0 ? ` (${columnType})` : '';
  return `Unparseable value${rowPart} for column "${columnName}"${typePart}: "${value}"`;
};

/**
 * Thrown when a cell cannot be converted for its column type and
 * `unparseableValueBehavior` is `'throw'`.
 */
export class AthenaQueryResultValueConverterUnparseableValueError extends AthenaQueryResultValueConverterError {
  override readonly name: string = 'AthenaQueryResultValueConverterUnparseableValueError';
  readonly code = 'unparseable-value' as const;

  /**
   * Header name of the cell that could not be converted.
   */
  readonly columnName: string;

  /**
   * Raw Athena column type from metadata, when one was provided.
   */
  readonly columnType: string | undefined;

  /**
   * Original cell text that failed conversion.
   */
  readonly value: string;

  /**
   * Optional zero-based row index included in the message when provided.
   */
  readonly rowIndex: number | undefined;

  constructor(
    columnName: string,
    columnType: string | undefined,
    value: string,
    rowIndex?: number,
  ) {
    super(describeUnparseableValue(columnName, columnType, value, rowIndex));
    Object.setPrototypeOf(this, AthenaQueryResultValueConverterUnparseableValueError.prototype);
    this.columnName = columnName;
    this.columnType = columnType;
    this.value = value;
    this.rowIndex = rowIndex;
  }
}

/**
 * Builds the message for {@link AthenaQueryResultValueConverterColumnCountError}.
 *
 * @param rowIndex - Zero-based index in the `Row[]` passed to the converter.
 * @param expected - Column count from `ColumnInfo[]`.
 * @param actual - Cell count on that row.
 * @returns A human-readable error message.
 */
const describeColumnCount = (rowIndex: number, expected: number, actual: number): string => {
  return `Expected ${expected} cells at row index ${rowIndex} but received ${actual}`;
};

/**
 * Thrown when a result row does not have one cell per column.
 *
 * The header row is included. `GetQueryResults` pages are not realigned.
 */
export class AthenaQueryResultValueConverterColumnCountError extends AthenaQueryResultValueConverterError {
  override readonly name: string = 'AthenaQueryResultValueConverterColumnCountError';
  readonly code = 'column-count' as const;

  /**
   * Zero-based index in the `Row[]` passed to the converter.
   */
  readonly rowIndex: number;

  /**
   * Column count from the supplied `ColumnInfo[]`.
   */
  readonly expected: number;

  /**
   * Cell count on the row that failed the check.
   */
  readonly actual: number;

  constructor(rowIndex: number, expected: number, actual: number) {
    super(describeColumnCount(rowIndex, expected, actual));
    Object.setPrototypeOf(this, AthenaQueryResultValueConverterColumnCountError.prototype);
    this.rowIndex = rowIndex;
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * Thrown when a caller passes an option this package cannot use.
 *
 * This is distinct from a cell that does not match its column type.
 */
export class AthenaQueryResultValueConverterArgumentError extends AthenaQueryResultValueConverterError {
  override readonly name: string = 'AthenaQueryResultValueConverterArgumentError';
  readonly code = 'argument' as const;

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, AthenaQueryResultValueConverterArgumentError.prototype);
  }
}
