export function formatKm(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${n.toLocaleString("en-IN", { maximumFractionDigits: n < 10 ? 2 : 1 })} km`;
}

export function formatInt(n: number): string {
  return n.toLocaleString("en-IN");
}

export function formatDist(m: number | null | undefined): string {
  if (m == null) return "—";
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

/** Extract the 4-digit year from a "Mon YYYY" commissioning string, or null. */
export function commissionYear(commissioned: string | null | undefined): number | null {
  const m = String(commissioned ?? "").match(/\b(\d{4})\b/);
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1900 && y <= 2100 ? y : null;
}

/** Age in whole years for a "Mon YYYY" commissioning string, relative to `asOfYear`. Null if unknown. */
export function ageYears(commissioned: string | null | undefined, asOfYear: number): number | null {
  const y = commissionYear(commissioned);
  if (y == null) return null;
  return Math.max(0, asOfYear - y);
}

/** Format an age in years, e.g. 9 → "9 yrs", 1 → "1 yr". Null → "—". */
export function formatAge(years: number | null | undefined): string {
  if (years == null) return "—";
  return `${years} yr${years === 1 ? "" : "s"}`;
}
