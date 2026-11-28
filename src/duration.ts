const MS_PER_MINUTE = 60_000,
  MS_PER_HOUR = 3_600_000,
  MS_PER_DAY = 86_400_000,
  /** Below this many hours a duration reads better in minutes, and below this many days in hours. */
  FEW_HOURS = 3,
  FEW_DAYS = 3;

/** A length of time in the unit a person would say it in: minutes, hours, or days. */
function duration(ms: number): string {
  if (!Number.isFinite(ms)) {
    return "forever";
  }
  if (ms < FEW_HOURS * MS_PER_HOUR) {
    const whole = Math.ceil(ms / MS_PER_MINUTE);
    return whole === 1 ? "1 minute" : `${whole} minutes`;
  }
  return ms < FEW_DAYS * MS_PER_DAY ? `${(ms / MS_PER_HOUR).toFixed(1)} hours` : `${(ms / MS_PER_DAY).toFixed(1)} days`;
}

export { duration };
