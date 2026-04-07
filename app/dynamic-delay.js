export const SPECIFIC_DATE_DELAY_STATE = "specific_date";
export const BUSINESS_DAYS_RANGE_DELAY_STATE = "business_days_range";
export const LEGACY_BUSINESS_DAYS_DELAY_STATE = "business_days_12_15";

export function isBusinessDaysDelayState(delayState) {
  const normalizedDelayState = `${delayState || ""}`.trim();

  return (
    normalizedDelayState === BUSINESS_DAYS_RANGE_DELAY_STATE ||
    normalizedDelayState === LEGACY_BUSINESS_DAYS_DELAY_STATE
  );
}

export function buildBusinessDayDelayLabel({
  delayRangeEnd,
  delayRangeStart,
  referenceDate = new Date(),
}) {
  const referenceDateString = buildReferenceDateString(referenceDate);
  const normalizedStart = normalizeDateString(delayRangeStart);
  const normalizedEnd = normalizeDateString(delayRangeEnd || delayRangeStart);

  if (!referenceDateString || !normalizedStart || !normalizedEnd) {
    return "";
  }

  const startCount = countBusinessDaysBetween(referenceDateString, normalizedStart);
  const endCount = countBusinessDaysBetween(referenceDateString, normalizedEnd);

  if (startCount === null || endCount === null) {
    return "";
  }

  const minimum = Math.min(startCount, endCount);
  const maximum = Math.max(startCount, endCount);

  return minimum === maximum ? `${minimum}` : `${minimum}-${maximum}`;
}

export function buildBusinessDayDelayText(options) {
  const label = buildBusinessDayDelayLabel(options);

  if (!label) {
    return "12-15 business days";
  }

  if (label.includes("-")) {
    return `${label} business days`;
  }

  return `${label} business ${label === "1" ? "day" : "days"}`;
}

function buildReferenceDateString(referenceDate) {
  const normalizedDate =
    referenceDate instanceof Date ? referenceDate : new Date(referenceDate);

  if (Number.isNaN(normalizedDate.getTime())) {
    return "";
  }

  return [
    normalizedDate.getFullYear(),
    `${normalizedDate.getMonth() + 1}`.padStart(2, "0"),
    `${normalizedDate.getDate()}`.padStart(2, "0"),
  ].join("-");
}

function countBusinessDaysBetween(referenceDateString, targetDateString) {
  const referenceDate = parseDateString(referenceDateString);
  const targetDate = parseDateString(targetDateString);

  if (!referenceDate || !targetDate) {
    return null;
  }

  if (targetDate <= referenceDate) {
    return 0;
  }

  const cursor = new Date(referenceDate);
  let businessDayCount = 0;

  cursor.setUTCDate(cursor.getUTCDate() + 1);

  while (cursor <= targetDate) {
    const dayOfWeek = cursor.getUTCDay();

    if (dayOfWeek !== 0 && dayOfWeek !== 6) {
      businessDayCount += 1;
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return businessDayCount;
}

function normalizeDateString(value) {
  const normalizedValue = `${value || ""}`.trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(normalizedValue) ? normalizedValue : "";
}

function parseDateString(value) {
  const normalizedValue = normalizeDateString(value);

  if (!normalizedValue) {
    return null;
  }

  const [year, month, day] = normalizedValue.split("-").map(Number);
  const parsedDate = new Date(Date.UTC(year, month - 1, day));

  if (
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.getUTCFullYear() !== year ||
    parsedDate.getUTCMonth() !== month - 1 ||
    parsedDate.getUTCDate() !== day
  ) {
    return null;
  }

  return parsedDate;
}
