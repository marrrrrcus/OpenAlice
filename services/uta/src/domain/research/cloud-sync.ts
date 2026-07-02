/**
 * Cloud-sync path guard — shared by every research ledger writer.
 *
 * Research ledgers are authoritative evidence: a cloud-synced (OneDrive)
 * directory must never hold them — sync locking can tear appends, and a
 * second clone writing into its own synced data root would mint parallel
 * "evidence" (the strategy-shadow ruling, applied uniformly to Track D).
 * The dev tree lives under OneDrive, so this also stops accidental junk
 * ledgers from dev runs; only the runtime clone (local, non-synced) writes.
 */

export function isCloudSyncedPath(p: string): boolean {
  return /onedrive/i.test(p)
}
