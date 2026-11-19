import { Badge } from '@canopy/ui-shared/components/Badge';
import { Stack, Button, Surface } from '@canopy/ui-shared/components';
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Checkbox } from '@canopy/ui-shared/components';
import { linkRecordedAppError } from '@canopy/ui-shared/lib';
import type { HookChatPluginDependencyItem } from '@canopy/desktop-shared/types';
import { normalizeGitHubRepoRef } from '@canopy/execution-engine/plugin-refs';
import { DialogModal } from '../shared';
import { parseGitHubRepo } from '@/lib/format';

/**
 * Per-item install progress surfaced inside the dialog. Items are keyed by
 * `HookChatPluginDependencyItem.key` (the canonical shareable ref key).
 */
type InstallStatus =
  | { state: 'idle' }
  | { state: 'in-progress' }
  | { state: 'success' }
  | { state: 'error'; message: string };

type PluginInstallLookup =
  | { state: 'missing' }
  | { state: 'local' }
  | { state: 'external'; pluginName: string; sourceUrl: string };

interface HookChatPluginInstallDialogProps {
  worktreeLabel: string;
  items: HookChatPluginDependencyItem[];
  onClose: () => void;
}

function isInstallable(item: HookChatPluginDependencyItem): boolean {
  return item.installState === 'installable' && item.installSpec !== undefined;
}

function describeUsage(item: HookChatPluginDependencyItem): string {
  if (item.usedBy.length === 0) {
    return '';
  }
  const triggers = Array.from(
    new Set(item.usedBy.map((usage) => usage.triggerName)),
  );
  const repos = Array.from(
    new Set(
      item.usedBy
        .map((usage) => usage.repoName)
        .filter((value): value is string => typeof value === 'string'),
    ),
  );
  const repoSuffix = repos.length > 0 ? ` (in ${repos.join(', ')})` : '';
  return `Used by ${triggers.join(', ')}${repoSuffix}`;
}

/**
 * Look up a marketplace ID in the plugins cache by matching the
 * `installSpec.repo` (an `owner/repo` shorthand) against
 * `MarketplaceInfo.sourceUrl` (a normalized GitHub URL). Returns null when
 * the marketplace has not been registered yet.
 */
function findMarketplaceIdByRepo(
  cache: Awaited<ReturnType<typeof window.plugins.loadMarketplaces>>['data'],
  repo: string,
): string | null {
  if (!cache) {
    return null;
  }
  let target: string;
  try {
    target = normalizeGitHubRepoRef(repo);
  } catch {
    return null;
  }
  for (const marketplace of cache.marketplaces) {
    const parsed = parseGitHubRepo(marketplace.sourceUrl);
    if (!parsed) {
      continue;
    }
    try {
      if (normalizeGitHubRepoRef(parsed) === target) {
        return marketplace.id;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Find how a plugin should be made available. Marketplace-local plugins are
 * available as soon as their marketplace is registered; external plugins need
 * a clone through `installPlugin`.
 */
function findPluginInstallLookup(
  cache: Awaited<ReturnType<typeof window.plugins.loadMarketplaces>>['data'],
  marketplaceId: string,
  pluginName: string,
): PluginInstallLookup {
  if (!cache) {
    return { state: 'missing' };
  }
  const marketplace = cache.marketplaces.find((m) => m.id === marketplaceId);
  if (!marketplace) {
    return { state: 'missing' };
  }
  const normalizedPluginName = pluginName.trim().toLowerCase();
  const plugin = marketplace.plugins.find(
    (p) => p.name.trim().toLowerCase() === normalizedPluginName,
  );
  if (!plugin) {
    return { state: 'missing' };
  }
  if (plugin.externalSource?.url) {
    return {
      state: 'external',
      pluginName: plugin.name,
      sourceUrl: plugin.externalSource.url,
    };
  }
  return { state: 'local' };
}

async function installSkillItem(
  item: HookChatPluginDependencyItem,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!item.installSpec || item.installSpec.kind !== 'skill') {
    return { ok: false, error: 'Missing skill install spec.' };
  }
  try {
    const result = await window.skills.installSkills(item.installSpec.repo, [
      item.installSpec.skillName,
    ]);
    if (!result.success) {
      // The failure shows as plain text here; link main's record to this session.
      linkRecordedAppError(result.appError, 'hook-chat-plugin-install');
      return { ok: false, error: result.error || 'Failed to install skill.' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function installPluginItem(
  item: HookChatPluginDependencyItem,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!item.installSpec || item.installSpec.kind !== 'plugin') {
    return { ok: false, error: 'Missing plugin install spec.' };
  }
  const { repo, pluginName } = item.installSpec;

  try {
    // Step 1: load existing marketplaces.
    const initial = await window.plugins.loadMarketplaces();
    if (!initial.success) {
      return {
        ok: false,
        error: initial.error || 'Failed to load marketplaces.',
      };
    }
    let marketplaceId = findMarketplaceIdByRepo(initial.data, repo);

    // Step 2: register the marketplace if it's not already known. After
    // adding we refresh once to populate the cache with the new marketplace
    // entry (including the plugin manifest we need for the source URL).
    if (!marketplaceId) {
      const added = await window.plugins.addMarketplace(repo);
      if (!added.success) {
        linkRecordedAppError(added.appError, 'hook-chat-plugin-install');
        return {
          ok: false,
          error: added.error || 'Failed to add marketplace.',
        };
      }
      const refreshed = await window.plugins.refreshMarketplaces();
      if (!refreshed.success) {
        return {
          ok: false,
          error: refreshed.error || 'Failed to refresh marketplaces.',
        };
      }
      marketplaceId = findMarketplaceIdByRepo(refreshed.data, repo);
      if (!marketplaceId) {
        return {
          ok: false,
          error: `Marketplace ${repo} did not appear after registration.`,
        };
      }
    }

    // Step 3: locate the external sourceUrl for the plugin within the
    // marketplace manifest. Fall back to a refresh if the entry is missing
    // (the plugin manifest may have been updated upstream after the cache
    // was built).
    let lookup = findPluginInstallLookup(
      initial.data,
      marketplaceId,
      pluginName,
    );
    if (lookup.state === 'missing') {
      // Recovery refresh: force the provider update past the 24h TTL, since
      // the whole point of this fallback is to pick up a manifest that changed
      // upstream after the cache was built. The refresh above (right after
      // `addMarketplace`) keeps the TTL-respecting default - discovery alone
      // populates a freshly added marketplace.
      const refreshed = await window.plugins.refreshMarketplaces('always');
      if (!refreshed.success) {
        return {
          ok: false,
          error: refreshed.error || 'Failed to refresh marketplaces.',
        };
      }
      lookup = findPluginInstallLookup(
        refreshed.data,
        marketplaceId,
        pluginName,
      );
    }
    if (lookup.state === 'missing') {
      return {
        ok: false,
        error: `Plugin ${pluginName} not found in ${repo}.`,
      };
    }
    if (lookup.state === 'local') {
      return { ok: true };
    }

    // Step 4: install the plugin into the local cache.
    const installed = await window.plugins.installPlugin(
      marketplaceId,
      lookup.pluginName,
      lookup.sourceUrl,
    );
    if (!installed.success) {
      linkRecordedAppError(installed.appError, 'hook-chat-plugin-install');
      return {
        ok: false,
        error: installed.error || 'Failed to install plugin.',
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function HookChatPluginInstallDialog({
  worktreeLabel,
  items,
  onClose,
}: HookChatPluginInstallDialogProps): JSX.Element {
  const installable = useMemo(() => items.filter(isInstallable), [items]);
  const unavailable = useMemo(
    () => items.filter((item) => !isInstallable(item)),
    [items],
  );

  // Selection is keyed by the canonical shareable ref key. Default to all
  // installable items selected — most users want to opt-in to everything the
  // hook authors declared.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const item of installable) {
      next.add(item.key);
    }
    return next;
  });
  const [statuses, setStatuses] = useState<Record<string, InstallStatus>>({});
  const [installing, setInstalling] = useState(false);
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !installing) {
        onClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return (): void => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, installing]);

  function toggleSelected(key: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function handleInstall(): Promise<void> {
    const targets = installable.filter((item) => selected.has(item.key));
    if (targets.length === 0) {
      return;
    }
    setInstalling(true);
    setCompleted(false);

    // Mark every target as in-progress up front so the dialog gives immediate
    // feedback even for the items still queued behind earlier installs.
    setStatuses((current) => {
      const next: Record<string, InstallStatus> = { ...current };
      for (const item of targets) {
        next[item.key] = { state: 'in-progress' };
      }
      return next;
    });

    for (const item of targets) {
      const result =
        item.installSpec?.kind === 'skill'
          ? await installSkillItem(item)
          : await installPluginItem(item);

      setStatuses((current) => ({
        ...current,
        [item.key]: result.ok
          ? { state: 'success' }
          : { state: 'error', message: result.error },
      }));
    }

    setInstalling(false);
    setCompleted(true);
  }

  const selectedCount = useMemo(
    () => installable.filter((item) => selected.has(item.key)).length,
    [installable, selected],
  );

  return (
    <DialogModal
      onClose={(): void => {
        if (!installing) {
          onClose();
        }
      }}
      title="Install hook chat plugins?"
      subtitle={worktreeLabel}
      titleId="hook-chat-plugin-install-dialog-title"
      maxWidth="2xl"
      closeOnBackdrop={!installing}
    >
      <div className="flex flex-col gap-4 text-s fg-primary">
        <p className="text-xs fg-secondary">
          The chat hook actions on this worktree reference shareable skills and
          marketplace plugins that aren&apos;t installed locally yet. Install
          the ones you want available so the hooks can use them.
        </p>

        {installable.length > 0 && (
          <Stack gap="inline">
            <div className="text-2xs font-medium fg-secondary">Installable</div>
            <Surface variant="outline">
              <ul className="divide-y">
                {installable.map((item) => {
                  const status = statuses[item.key] ?? { state: 'idle' };
                  const isSelected = selected.has(item.key);
                  return (
                    <li
                      key={item.key}
                      className="flex items-start gap-3 p-3 text-xs"
                    >
                      <Checkbox
                        checked={isSelected}
                        disabled={installing || status.state === 'success'}
                        onChange={(): void => toggleSelected(item.key)}
                        className="mt-0.5"
                        aria-label={`Install ${item.displayName}`}
                      />
                      <Stack gap="tight" className="min-w-0 flex-1">
                        <div className="flex flex-col gap-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium fg-primary">
                              {item.displayName}
                            </span>
                            <Badge>{item.kind}</Badge>
                          </div>
                          <div className="mt-0.5 fg-secondary">
                            {item.displaySource}
                          </div>
                          {describeUsage(item) && (
                            <div className="mt-0.5 text-3xs fg-secondary/80">
                              {describeUsage(item)}
                            </div>
                          )}
                        </div>
                        {status.state === 'in-progress' && (
                          <div className="text-2xs fg-secondary">
                            Installing…
                          </div>
                        )}
                        {status.state === 'success' && (
                          <div className="text-2xs fg-success-strong">
                            Installed
                          </div>
                        )}
                        {status.state === 'error' && (
                          <div className="text-2xs fg-destructive-strong">
                            {status.message}
                          </div>
                        )}
                      </Stack>
                    </li>
                  );
                })}
              </ul>
            </Surface>
          </Stack>
        )}

        {unavailable.length > 0 && (
          <Stack gap="inline">
            <div className="text-2xs font-medium fg-secondary">
              Cannot install automatically
            </div>
            <Surface variant="outline">
              <ul className="divide-y">
                {unavailable.map((item) => (
                  <li key={item.key} className="p-3 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-medium fg-primary">
                        {item.displayName}
                      </span>
                      <Badge>{item.kind}</Badge>
                    </div>
                    <div className="mt-0.5 fg-secondary">
                      {item.displaySource}
                    </div>
                    {describeUsage(item) && (
                      <div className="mt-0.5 text-3xs fg-secondary/80">
                        {describeUsage(item)}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Surface>
            <p className="text-3xs fg-secondary">
              These references can&apos;t be installed from this dialog. Add
              them manually from the Plugins or Skills tab if you need them.
            </p>
          </Stack>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="text-2xs fg-secondary">
            {installable.length === 0
              ? 'Nothing to install'
              : `${selectedCount} of ${installable.length} selected`}
          </div>
          <div className="flex items-center gap-2">
            <Button size="compact" onClick={onClose} disabled={installing}>
              {completed ? 'Close' : 'Skip for now'}
            </Button>
            {installable.length > 0 && (
              <Button
                variant="primary"
                size="compact"
                onClick={(): void => {
                  void handleInstall();
                }}
                disabled={installing || selectedCount === 0}
              >
                {installing
                  ? 'Installing…'
                  : completed
                    ? 'Install again'
                    : 'Install selected'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </DialogModal>
  );
}
