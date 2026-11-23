/** A page size as `120 KB` or `3.4 MB`. Rounds up to whole KB first, so just under 1 MB is `1.0 MB`, not `1024 KB`. */
export function formatSize(bytes: number): string {
  const kb = Math.ceil(bytes / 1024);
  return kb < 1024 ? `${kb} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
