export function formatDownloadSize(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return 'size unavailable'
  const gigabytes = bytes / 1024 ** 3
  return gigabytes >= 10 ? `${gigabytes.toFixed(1)} GB` : `${gigabytes.toFixed(2)} GB`
}

/** Compact remaining-time label for the small library cards, always in minutes. */
export function formatEtaMinutes(seconds: number | null | undefined): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null
  if (seconds <= 45) return 'less than a minute left'
  return `${Math.max(1, Math.ceil(seconds / 60))} min left`
}

/** Live download rate, e.g. "42.3 MB/s". */
export function formatSpeed(bytesPerSecond: number | null | undefined): string | null {
  if (typeof bytesPerSecond !== 'number' || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
    return null
  }
  const megabytes = bytesPerSecond / 1024 ** 2
  if (megabytes >= 1) return `${megabytes >= 10 ? megabytes.toFixed(0) : megabytes.toFixed(1)} MB/s`
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`
}
