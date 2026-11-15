export function formatDownloadSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'size unavailable'
  const gigabytes = bytes / 1024 ** 3
  return gigabytes >= 10 ? `${gigabytes.toFixed(1)} GB` : `${gigabytes.toFixed(2)} GB`
}
