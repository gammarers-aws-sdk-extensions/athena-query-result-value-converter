import { AthenaQueryResultValueConverterArgumentError } from './errors';

/**
 * Session time zone used when a timestamp has no zone of its own.
 * Athena's default session time zone is UTC.
 */
export const DEFAULT_TIME_ZONE = 'UTC';

/**
 * Athena / Trino timestamp and time precision when the type omits `(p)`.
 */
export const DEFAULT_TEMPORAL_PRECISION = 3;

const MILLISECOND_PRECISION = 3;
const UTC_ZONE = 'UTC';
const DATE_VALUE_INSTANT = 'instant';
const DATE_VALUE_STRING = 'string';
const MAX_OFFSET_HOURS = 18;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/**
 * Minutes to step backward when a wall clock is repeated.
 * The first resolution can land on the later instant. 30 covers `Australia/Lord_Howe`.
 */
const OVERLAP_LOOKBACK_MINUTES = [15, 20, 30, 45, 60, 90, 120] as const;

const TIMESTAMP_BODY = '(\\d{4})-(\\d{2})-(\\d{2}) (\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d+))?';
const TIMESTAMP_PATTERN = new RegExp(`^${TIMESTAMP_BODY}$`);
const TIMESTAMP_WITH_ZONE_PATTERN = new RegExp(`^${TIMESTAMP_BODY} (.+)$`);
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const OFFSET_PATTERN = /^([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?|(\d{2})(\d{2})?)?$/;
const TIMESTAMP_TYPE_PATTERN = /^timestamp(?:\((\d+)\))?$/;
const TIMESTAMP_WITH_TIME_ZONE_TYPE_PATTERN = /^timestamp(?:\((\d+)\))? with time zone$/;
const TIME_TYPE_PATTERN = /^time(?:\((\d+)\))?$/;

/**
 * How a `date` column is returned.
 *
 * - `'instant'`: UTC midnight {@link Date}
 * - `'string'`: the `YYYY-MM-DD` text
 */
export type DateValueKind = typeof DATE_VALUE_INSTANT | typeof DATE_VALUE_STRING;

/**
 * Options for {@link toDate}.
 */
export type ToDateOptions = {
  /**
   * IANA time zone for a timestamp that has no zone suffix.
   *
   * Default: `'UTC'`. A suffix on the value wins. `YYYY-MM-DD` stays UTC midnight.
   */
  timeZone?: string;
};

/**
 * Timestamp type after the Athena type string has been normalized.
 */
export type AthenaTimestampType = {
  readonly withTimeZone: boolean;
  readonly typePrecision: number | undefined;
};

/**
 * Time type after the Athena type string has been normalized.
 */
export type AthenaTimeType = {
  readonly typePrecision: number | undefined;
};

type ClockParts = {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
};

type ZoneBinding =
  | { readonly kind: 'offset'; readonly offsetMs: number }
  | { readonly kind: 'iana'; readonly timeZone: string };

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Reuses one formatter per time zone. Constructing `Intl.DateTimeFormat` dominates conversion cost.
 *
 * @param timeZone - IANA time zone name.
 * @returns A cached formatter that writes wall-clock parts in that zone.
 */
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  const cached = formatters.get(timeZone);
  if (cached != null) return cached;

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  formatters.set(timeZone, created);
  return created;
};

/**
 * Returns whether `Intl` accepts the time zone.
 *
 * @param timeZone - Caller-supplied IANA name, such as `UTC` or `Asia/Tokyo`.
 * @returns `true` when the name can be used as a session time zone.
 */
export const isValidIanaTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
};

/**
 * Rejects a session time zone `Intl` does not accept.
 *
 * @param timeZone - Caller-supplied IANA name.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When the name is not a time zone.
 */
export const requireTimeZone = (timeZone: string): void => {
  if (isValidIanaTimeZone(timeZone)) return;
  throw new AthenaQueryResultValueConverterArgumentError(
    `Invalid time zone "${timeZone}". Expected an IANA time zone name.`,
  );
};

/**
 * Rejects a `dateValue` other than `'instant'` or `'string'`.
 *
 * @param dateValue - Caller-supplied date representation.
 * @returns The same representation when it is `'instant'` or `'string'`.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When the value is not one of those two.
 */
export const requireDateValue = (dateValue: string): DateValueKind => {
  if (dateValue === DATE_VALUE_INSTANT || dateValue === DATE_VALUE_STRING) return dateValue;
  throw new AthenaQueryResultValueConverterArgumentError(
    "dateValue must be 'instant' or 'string'",
  );
};

/**
 * Resolved session zone and date representation for one conversion call.
 */
export type TemporalOptions = {
  readonly timeZone: string;
  readonly dateValue: DateValueKind;
};

/**
 * Applies defaults and rejects an unusable session zone or date representation.
 *
 * @param options - Partial caller options. Omitted fields use UTC and `'instant'`.
 * @returns The options cell conversion should use.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When `timeZone` or `dateValue` is unusable.
 */
export const resolveTemporalOptions = (options: {
  readonly timeZone?: string;
  readonly dateValue?: string;
}): TemporalOptions => {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const dateValue = requireDateValue(options.dateValue ?? DATE_VALUE_INSTANT);
  requireTimeZone(timeZone);
  return { timeZone, dateValue };
};

/**
 * Builds a UTC epoch from calendar fields.
 *
 * `Date.UTC` maps years 0 through 99 to 1900 through 1999. `setUTCFullYear` keeps the year,
 * so `0001-01-01` stays year 1.
 *
 * @param year - Full year, including 0 through 99.
 * @param monthIndex - Month index from 0.
 * @param day - Day of the month.
 * @param hour - Hour from 0 to 23.
 * @param minute - Minute from 0 to 59.
 * @param second - Second from 0 to 59.
 * @param millisecond - Millisecond from 0 to 999.
 * @returns UTC epoch milliseconds.
 */
const utcFromParts = (
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
  millisecond = 0,
): number => {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
};

/**
 * Returns whether the calendar day exists.
 *
 * @param year - Four-digit year.
 * @param month - Month from 1 to 12.
 * @param day - Day of the month.
 * @returns `true` for a real Gregorian date, including leap days.
 */
const isRealCalendarDate = (year: number, month: number, day: number): boolean => {
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day;
};

/**
 * Returns whether the clock time is a real time of day.
 *
 * Leap second `60` is rejected. Athena does not emit it.
 *
 * @param hour - Hour from 0 to 23.
 * @param minute - Minute from 0 to 59.
 * @param second - Second from 0 to 59.
 * @returns `true` when every field is in range.
 */
const isRealClockTime = (hour: number, minute: number, second: number): boolean => {
  return hour >= 0 && hour <= 23
    && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59;
};

/**
 * Reads a wall clock from an `Intl` snapshot.
 *
 * Some ICU builds report midnight as hour 24 on the previous date. That hour is rolled to 00:00 the next day.
 *
 * @param instant - UTC epoch milliseconds.
 * @param timeZone - IANA time zone used to format the instant.
 * @returns Wall-clock fields in that zone.
 */
const readZonedParts = (instant: number, timeZone: string): ClockParts => {
  const parts = formatterFor(timeZone).formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((item) => item.type === type);
    return Number(part?.value);
  };

  let year = read('year');
  let month = read('month');
  let day = read('day');
  let hour = read('hour');
  const minute = read('minute');
  const second = read('second');

  if (hour === 24) {
    hour = 0;
    const nextDay = new Date(0);
    nextDay.setUTCFullYear(year, month - 1, day + 1);
    year = nextDay.getUTCFullYear();
    month = nextDay.getUTCMonth() + 1;
    day = nextDay.getUTCDate();
  }

  return { year, month, day, hour, minute, second, millisecond: 0 };
};

/**
 * Returns whether two wall clocks name the same second.
 *
 * @param actual - Clock read back from an instant.
 * @param desired - Clock the caller asked for.
 * @returns `true` when year through second match.
 */
const sameClock = (actual: ClockParts, desired: ClockParts): boolean => {
  return actual.year === desired.year
    && actual.month === desired.month
    && actual.day === desired.day
    && actual.hour === desired.hour
    && actual.minute === desired.minute
    && actual.second === desired.second;
};

/**
 * Converts a wall clock in an IANA zone to UTC epoch milliseconds.
 *
 * A repeated local time uses the earlier instant. A skipped local time returns `null`.
 * `UTC` does not go through `Intl`, so the host zone cannot change the result.
 *
 * @param clock - Validated wall clock. Sub-second fields are added after the zone offset.
 * @param timeZone - IANA time zone that already passed {@link requireTimeZone}.
 * @returns Epoch milliseconds, or `null` when that local time does not exist.
 */
const wallTimeToUtc = (clock: ClockParts, timeZone: string): number | null => {
  if (timeZone === UTC_ZONE) {
    return utcFromParts(
      clock.year,
      clock.month - 1,
      clock.day,
      clock.hour,
      clock.minute,
      clock.second,
      clock.millisecond,
    );
  }

  const naive = utcFromParts(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second);
  const offsetOf = (utcMs: number): number => {
    const local = readZonedParts(utcMs, timeZone);
    return utcFromParts(local.year, local.month - 1, local.day, local.hour, local.minute, local.second) - utcMs;
  };
  const verified = (instant: number): boolean => sameClock(readZonedParts(instant, timeZone), clock);

  const instant1 = naive - offsetOf(naive);
  let first: number | undefined = verified(instant1) ? instant1 : undefined;
  if (first == null) {
    const instant2 = naive - offsetOf(instant1);
    if (verified(instant2)) first = instant2;
  }
  if (first == null) return null;

  let earliest = first;
  for (const minutes of OVERLAP_LOOKBACK_MINUTES) {
    const candidate = first - minutes * MS_PER_MINUTE;
    if (!verified(candidate)) continue;
    if (candidate < earliest) earliest = candidate;
  }

  return earliest + clock.millisecond;
};

/**
 * Reads a fixed offset in milliseconds east of UTC.
 *
 * @param zone - `UTC` or a numeric offset such as `+09:00` or `+0900`.
 * @returns The offset, or `undefined` when `zone` is not an offset token. `null` means the token is an offset but out of range.
 */
const readFixedOffsetMs = (zone: string): number | null | undefined => {
  if (zone === UTC_ZONE) return 0;

  const match = OFFSET_PATTERN.exec(zone);
  if (match == null) return undefined;

  const sign = match[1] === '+' ? 1 : -1;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? match[5] ?? 0);
  const seconds = Number(match[4] ?? match[6] ?? 0);
  if (hours > MAX_OFFSET_HOURS || minutes > 59 || seconds > 59) return null;
  if (hours === MAX_OFFSET_HOURS && (minutes !== 0 || seconds !== 0)) return null;
  return sign * (((hours * 60) + minutes) * 60 + seconds) * MS_PER_SECOND;
};

/**
 * Classifies the zone suffix on `timestamp with time zone`.
 *
 * @param zone - Text after the timestamp body.
 * @returns A fixed offset or an IANA zone. `undefined` when the suffix cannot be used.
 */
const classifyZone = (zone: string): ZoneBinding | undefined => {
  const offsetMs = readFixedOffsetMs(zone);
  if (offsetMs === null) return undefined;
  if (offsetMs != null) return { kind: 'offset', offsetMs };
  if (!isValidIanaTimeZone(zone)) return undefined;
  return { kind: 'iana', timeZone: zone };
};

/**
 * Builds a {@link Date} when the instant fits. Otherwise keeps the original text.
 *
 * Four-digit Athena years fit in a `Date`. The string branch covers an instant that still does not.
 *
 * @param epochMs - UTC epoch milliseconds.
 * @param original - Trimmed Athena literal to keep when `Date` cannot represent the instant.
 * @returns The instant, or `original` when it cannot be represented.
 */
const instantToDate = (epochMs: number, original: string): Date | string => {
  if (!Number.isSafeInteger(epochMs)) return original;
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return original;
  return date;
};

/**
 * Turns a validated clock and zone into a `Date` or the original text.
 *
 * Precision above milliseconds stays text after the zone is checked, so a bad zone is still unparseable.
 *
 * @param clock - Validated wall clock.
 * @param zone - Offset or IANA zone that belongs to this literal.
 * @param original - Trimmed Athena literal.
 * @param keepText - `true` when the declared precision does not fit in a `Date`.
 * @returns A {@link Date}, the original text, or `null` when the local time does not exist.
 */
const clockToValue = (
  clock: ClockParts,
  zone: ZoneBinding,
  original: string,
  keepText: boolean,
): Date | string | null => {
  const epochMs = zone.kind === 'offset'
    ? utcFromParts(
      clock.year,
      clock.month - 1,
      clock.day,
      clock.hour,
      clock.minute,
      clock.second,
      clock.millisecond,
    ) - zone.offsetMs
    : wallTimeToUtc(clock, zone.timeZone);
  if (epochMs == null) return null;
  if (keepText) return original;
  return instantToDate(epochMs, original);
};

/**
 * Pads a fractional second of at most 3 digits out to milliseconds.
 *
 * @param fraction - Digits after the decimal point, without the point.
 * @returns Milliseconds from 0 to 999.
 */
const fractionToMillisecond = (fraction: string | undefined): number => {
  if (fraction == null || fraction.length === 0) return 0;
  return Number(fraction.padEnd(MILLISECOND_PRECISION, '0'));
};

/**
 * Reads a timestamp body when the fraction fits the declared precision.
 *
 * @param match - Groups from {@link TIMESTAMP_PATTERN} or {@link TIMESTAMP_WITH_ZONE_PATTERN}.
 * @param precision - Declared timestamp precision.
 * @returns The clock and whether the value must stay text. `undefined` when the literal does not match the type.
 */
const readTimestampClock = (
  match: RegExpExecArray,
  precision: number,
): { readonly clock: ClockParts; readonly keepText: boolean } | undefined => {
  const fraction = match[7];
  const fractionDigits = fraction?.length ?? 0;
  if (fractionDigits > precision) return undefined;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (!isRealCalendarDate(year, month, day)) return undefined;
  if (!isRealClockTime(hour, minute, second)) return undefined;

  return {
    clock: {
      year,
      month,
      day,
      hour,
      minute,
      second,
      millisecond: fractionDigits > MILLISECOND_PRECISION ? 0 : fractionToMillisecond(fraction),
    },
    keepText: precision > MILLISECOND_PRECISION,
  };
};

/**
 * Converts a timestamp that has no zone suffix.
 *
 * @param trimmed - Trimmed cell text.
 * @param precision - Declared precision.
 * @param sessionTimeZone - IANA zone for the wall clock. Ignored when the text has a zone suffix, because that text does not match.
 * @returns A {@link Date}, the original text when precision does not fit, or `null` when the literal is not acceptable.
 */
const toSessionTimestamp = (
  trimmed: string,
  precision: number,
  sessionTimeZone: string,
): Date | string | null => {
  const match = TIMESTAMP_PATTERN.exec(trimmed);
  if (match == null) return null;

  const read = readTimestampClock(match, precision);
  if (read == null) return null;
  return clockToValue(read.clock, { kind: 'iana', timeZone: sessionTimeZone }, trimmed, read.keepText);
};

/**
 * Converts `timestamp with time zone`. `UTC` and numeric offsets are fixed. IANA names use the same wall-clock rule.
 *
 * @param trimmed - Trimmed cell text, including the zone suffix.
 * @param precision - Declared precision.
 * @returns A {@link Date}, the original text when precision does not fit, or `null` when the literal is not acceptable.
 */
const toZonedTimestamp = (trimmed: string, precision: number): Date | string | null => {
  const match = TIMESTAMP_WITH_ZONE_PATTERN.exec(trimmed);
  if (match == null) return null;

  const zone = classifyZone(match[8] ?? '');
  if (zone == null) return null;

  const read = readTimestampClock(match, precision);
  if (read == null) return null;
  return clockToValue(read.clock, zone, trimmed, read.keepText);
};

/**
 * Converts an Athena timestamp literal.
 *
 * `Date.parse` is not used. It would treat `YYYY-MM-DD HH:mm:ss.SSS` as the host zone and would also accept `2026` or `January 1, 2026`.
 *
 * @param value - Raw cell text.
 * @param precision - Declared precision. Above 3, a valid literal stays text.
 * @param sessionTimeZone - IANA zone for a timestamp without a zone suffix.
 * @param withTimeZone - `true` when the column is `timestamp with time zone`.
 * @returns A {@link Date}, preserved text, or `null` when the cell does not match the column.
 */
export const toAthenaTimestamp = (
  value: string,
  precision: number,
  sessionTimeZone: string,
  withTimeZone: boolean,
): Date | string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (withTimeZone) return toZonedTimestamp(trimmed, precision);
  return toSessionTimestamp(trimmed, precision, sessionTimeZone);
};

/**
 * Converts an Athena `date` literal.
 *
 * @param value - Raw cell text.
 * @param dateValue - `'instant'` for UTC midnight, `'string'` for `YYYY-MM-DD`.
 * @returns A {@link Date}, the date text, or `null` when the cell is not `YYYY-MM-DD`.
 */
export const toAthenaDate = (value: string, dateValue: DateValueKind): Date | string | null => {
  const trimmed = value.trim();
  const match = DATE_PATTERN.exec(trimmed);
  if (match == null) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isRealCalendarDate(year, month, day)) return null;
  if (dateValue === DATE_VALUE_STRING) return trimmed;
  return new Date(utcFromParts(year, month - 1, day));
};

/**
 * Keeps an Athena `time` / `time(p)` literal as text.
 *
 * A time has no date, so it is not a {@link Date}.
 *
 * @param value - Raw cell text.
 * @param precision - Declared precision. Extra fractional digits do not match.
 * @returns Trimmed time text, or `null` when the cell is not an Athena time.
 */
export const toAthenaTime = (value: string, precision: number): string | null => {
  const trimmed = value.trim();
  const match = TIME_PATTERN.exec(trimmed);
  if (match == null) return null;

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3]);
  const fractionDigits = match[4]?.length ?? 0;
  if (!isRealClockTime(hour, minute, second)) return null;
  if (fractionDigits > precision) return null;
  return trimmed;
};

/**
 * Reads `timestamp` or `timestamp(p)`, with or without `with time zone`.
 *
 * @param normalizedType - Lowercased Athena type string.
 * @returns The type's zone flag and the precision written on the type, if any.
 */
export const matchTimestampType = (normalizedType: string): AthenaTimestampType | undefined => {
  const zoned = TIMESTAMP_WITH_TIME_ZONE_TYPE_PATTERN.exec(normalizedType);
  if (zoned != null) {
    return {
      withTimeZone: true,
      typePrecision: zoned[1] == null ? undefined : Number(zoned[1]),
    };
  }

  const plain = TIMESTAMP_TYPE_PATTERN.exec(normalizedType);
  if (plain == null) return undefined;
  return {
    withTimeZone: false,
    typePrecision: plain[1] == null ? undefined : Number(plain[1]),
  };
};

/**
 * Reads `time` or `time(p)`. `time with time zone` is not this type.
 *
 * @param normalizedType - Lowercased Athena type string.
 * @returns The precision written on the type, if any.
 */
export const matchTimeType = (normalizedType: string): AthenaTimeType | undefined => {
  const match = TIME_TYPE_PATTERN.exec(normalizedType);
  if (match == null) return undefined;
  return { typePrecision: match[1] == null ? undefined : Number(match[1]) };
};

/**
 * Returns a {@link Date} only when the text is an Athena timestamp or date this package can represent.
 *
 * Fractional digits past milliseconds return `null` instead of being truncated.
 *
 * @param parsed - Result of a timestamp or date parse.
 * @returns The {@link Date}, or `null` when the parse kept text or failed.
 */
const asDate = (parsed: Date | string | null): Date | null => {
  if (parsed instanceof Date) return parsed;
  return null;
};

/**
 * Converts an Athena timestamp or `YYYY-MM-DD` date to a {@link Date}.
 *
 * Accepts `YYYY-MM-DD HH:mm:ss[.SSS]` and the same form with a `UTC`, numeric-offset, or IANA suffix.
 * `YYYY-MM-DD` is UTC midnight. Other text, including ISO `T`/`Z` forms, returns `null`.
 *
 * @param value - Raw text, or `null`.
 * @param options - Session time zone for a timestamp that has no suffix.
 * @returns A {@link Date}, or `null` when the text is not a representable Athena literal.
 * @throws {@link AthenaQueryResultValueConverterArgumentError} When `options.timeZone` is not an IANA time zone.
 */
export const toDate = (value: string | null, options: ToDateOptions = {}): Date | null => {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const sessionTimeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  requireTimeZone(sessionTimeZone);

  if (TIMESTAMP_WITH_ZONE_PATTERN.test(trimmed)) {
    return asDate(toZonedTimestamp(trimmed, MILLISECOND_PRECISION));
  }
  if (TIMESTAMP_PATTERN.test(trimmed)) {
    return asDate(toSessionTimestamp(trimmed, MILLISECOND_PRECISION, sessionTimeZone));
  }
  return asDate(toAthenaDate(trimmed, DATE_VALUE_INSTANT));
};
