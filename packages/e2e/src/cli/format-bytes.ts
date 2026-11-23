/** A size as `512 B`, `12.3 KiB`, or `4.0 MiB`. Rounds to a tenth first, so just under 1 MiB is `1.0 MiB`, not `1024.0 KiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const tenths = Math.round((bytes * 10) / 1024);
  if (tenths < 10_240) return `${(tenths / 10).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
