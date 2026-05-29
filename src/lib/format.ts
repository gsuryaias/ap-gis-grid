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
