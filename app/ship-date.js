export function formatNotifyDockShipDate(value) {
  if (!value) {
    return "";
  }

  const [year, month, day] = `${value}`.split("-").map(Number);

  if (!year || !month || !day) {
    return `${value}`.trim();
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}
