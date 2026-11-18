/** The release step every provider's `sweep` shares, whatever its service calls a lease. */

/** What `releaseEach` did with the leases a provider's `sweep` found. */
export interface SweepOutcome {
  /** The leases the service still had open and released, in the order found. */
  readonly released: readonly string[];
  /** The leases whose release failed, in the order found, each with its error's message. */
  readonly failed: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Releases every lease a provider's `sweep` found at once, so a failed
 * release never skips its siblings, and sorts them by outcome. `release`
 * resolves to whether the service still had the lease open: one already
 * gone is neither released nor failed. The provider decides what a failure
 * means, typically an error naming both lists and the service timeout that
 * ends what it could not release.
 */
export async function releaseEach(ids: readonly string[], release: (id: string) => Promise<boolean>): Promise<SweepOutcome> {
  // `async` so a release that throws before its first await is a rejection like any other.
  const settled = await Promise.allSettled(ids.map(async (id) => release(id)));
  const released: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  settled.forEach((result, index) => {
    const id = ids[index]!;
    if (result.status === 'rejected') failed.push({ id, reason: result.reason instanceof Error ? result.reason.message : String(result.reason) });
    else if (result.value) released.push(id);
  });
  return { released, failed };
}
