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
