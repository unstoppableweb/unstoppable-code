import { loadMarketplacesCacheOnly } from '../../plugins/plugin-service';
import { readCommittedLockStatus } from '../../skills/lock-file';

/** Read canonical installed state; uncertainty must never qualify a campaign. */
export async function hasInstalledCapability(): Promise<boolean> {
  const lock = await readCommittedLockStatus();
  const lockUncertain = lock.status === 'damaged' || lock.status === 'refused';
  if (!lockUncertain && Object.keys(lock.stored).length > 0) return true;
  const result = await loadMarketplacesCacheOnly();
  if (!result.success || result.data === undefined)
    throw new Error('Installed plugins could not be read.');
  const plugin = result.data.marketplaces.some((marketplace) =>
    marketplace.plugins.some(
      (entry) =>
        entry.globalInstallStatus?.claude?.installed === true ||
        entry.globalInstallStatus?.codex?.installed === true,
    ),
  );
  // A known positive wins; an uncertain lock never reads as no skills.
  if (!plugin && lockUncertain)
    throw new Error('Installed skills could not be read.');
  return plugin;
}
