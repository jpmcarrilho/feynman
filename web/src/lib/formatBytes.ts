/** File size for people: KB under 0.1 MB, else MB with one decimal (none from 10 MB). Pure. */
export function formatBytes(bytes: number): string {
  if (bytes < 0.1 * 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}
