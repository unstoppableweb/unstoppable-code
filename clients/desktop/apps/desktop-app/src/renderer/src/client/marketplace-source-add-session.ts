import type {
  MarketplaceSourceAddSession,
  MarketplaceSourceAddSnapshot,
  MarketplaceSource,
  MarketplaceSourceOperations,
} from '@canopy/app-core/client';
import type {
  PluginsAPI,
  MarketplaceInfo,
} from '@canopy/execution-engine/types/plugins';
import { parseGitHubRepo } from '@canopy/plugin-interop/github-repo';
import { linkRecordedAppError } from '@canopy/ui-shared';
import { toMarketplaceSource } from './marketplace-source-summary';

const INVALID_REPO =
  'Invalid format. Use a GitHub URL or owner/repo (e.g. acme/plugins).';
interface RegistrationLease {
  uncertain: boolean;
  /**
   * Main answered the write with an explicit failure, which saves nothing. If
   * no source appears, the reservation is released with this error.
   */
  rejected?: string;
  /** Main recorded the rejection, so the banner showing it records nothing. */
  rejectedRecorded?: true;
}

const reservations = new WeakMap<
  MarketplaceSourceOperations,
  Map<string, RegistrationLease>
>();

export interface IpcMarketplaceSourceAddOptions {
  readonly add: PluginsAPI['addMarketplace'];
  readonly list: () => Promise<readonly MarketplaceInfo[]>;
  readonly upsert: (source: MarketplaceInfo) => void;
  readonly operations: MarketplaceSourceOperations;
}

export function createIpcMarketplaceSourceAddSession(
  options: IpcMarketplaceSourceAddOptions,
): MarketplaceSourceAddSession {
  let identities = reservations.get(options.operations);
  if (!identities) {
    identities = new Map();
    reservations.set(options.operations, identities);
  }
  const leases = identities;
  let state: MarketplaceSourceAddSnapshot = { phase: 'input' };
  let disposed = false;
  let repo: string | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: MarketplaceSourceAddSnapshot): void => {
    if (disposed) return;
    state = Object.freeze(next);
    listeners.forEach((listener) => listener());
  };
  const matched = (
    rows: readonly MarketplaceInfo[],
  ): MarketplaceInfo | undefined =>
    rows.find(
      (row) =>
        row.sourceType === 'github' &&
        (parseGitHubRepo(row.sourceUrl) ?? row.sourceUrl).toLowerCase() ===
          repo?.toLowerCase(),
    );
  const reconcile = async (): Promise<void> => {
    const key = repo?.toLowerCase();
    const lease = key ? leases.get(key) : undefined;
    publish({
      phase: 'reconciling',
      error: 'Checking the marketplace registration…',
    });
    try {
      const found = matched(await options.list());
      if (found) {
        options.upsert(found);
        // A lease becomes uncertain only after its write settles. Keep pending
        // requests and never clear a newer reservation after an older read completes.
        if (key && lease?.uncertain && leases.get(key) === lease) {
          lease.uncertain = false;
          leases.delete(key);
        }
        // Registration is direct on desktop. A lost response can be recovered
        // as an authoritative destination; no cleanup ownership is inferred.
        publish({ phase: 'complete', result: { sourceId: found.id } });
      } else if (
        key &&
        lease?.uncertain &&
        lease.rejected !== undefined &&
        leases.get(key) === lease
      ) {
        lease.uncertain = false;
        leases.delete(key);
        publish({
          phase: 'input',
          error: lease.rejected,
          ...(lease.rejectedRecorded ? { recorded: true as const } : {}),
        });
      } else
        publish({
          phase: 'uncertain',
          error:
            'The registration result could not be verified. Check again or close and review Marketplaces.',
        });
    } catch {
      publish({
        phase: 'uncertain',
        error:
          'Could not read marketplaces. Check again before adding this source.',
      });
    }
  };
  return {
    mode: 'direct',
    inputKind: 'github',
    getSnapshot: () => state,
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    validate: (input) => (parseGitHubRepo(input) ? null : INVALID_REPO),
    async submit(input): Promise<void> {
      if (disposed || state.phase !== 'input') return;
      repo = parseGitHubRepo(input);
      if (!repo) {
        publish({ phase: 'input', error: INVALID_REPO });
        return;
      }
      const key = repo.toLowerCase();
      if (leases.has(key)) {
        publish({
          phase: 'uncertain',
          error:
            'Another registration for this source is pending or needs verification.',
        });
        return;
      }
      const lease: RegistrationLease = { uncertain: false };
      leases.set(key, lease);
      // Refresh and source mutations cannot overlap the registration request.
      const release = options.operations.acquire(null, 'update');
      if (!release) {
        leases.delete(key);
        publish({ phase: 'input', error: 'Marketplaces are busy. Try again.' });
        return;
      }
      publish({ phase: 'registering' });
      let writing = false;
      try {
        const existing = matched(await options.list());
        if (disposed) return;
        if (existing) {
          publish({
            phase: 'input',
            error: 'Marketplace has already been added.',
          });
          return;
        }
        writing = true;
        const result = await options.add(repo);
        const marketplace = result.success
          ? result.data?.marketplace
          : undefined;
        let source: MarketplaceSource | null = null;
        if (
          marketplace &&
          typeof marketplace.id === 'string' &&
          marketplace.id.trim() !== '' &&
          Array.isArray(marketplace.plugins)
        ) {
          source = toMarketplaceSource(marketplace);
        }
        if (!source || !marketplace) {
          lease.uncertain = true;
          if (!result.success) {
            lease.rejected =
              result.error?.trim() || 'Could not add this marketplace.';
            // Main recorded it; the banner records nothing but links it to
            // this session.
            linkRecordedAppError(
              result.appError,
              'cloud-marketplace-add-error',
            );
            if (result.appError?.recordedBy !== undefined)
              lease.rejectedRecorded = true;
          }
          await reconcile();
          return;
        }
        options.upsert(marketplace);
        publish({ phase: 'complete', result: { sourceId: source.id } });
      } catch (error) {
        if (writing) {
          lease.uncertain = true;
          await reconcile();
        } else
          publish({
            phase: 'input',
            error:
              error instanceof Error
                ? error.message
                : 'Could not read marketplaces. Try again.',
          });
      } finally {
        release();
        if (!lease.uncertain && leases.get(key) === lease) leases.delete(key);
      }
    },
    async retryReconciliation(): Promise<void> {
      if (state.phase === 'uncertain' && !disposed) await reconcile();
    },
    retryPreview: () => Promise.resolve(),
    confirm: () => Promise.resolve(),
    cancel(): Promise<void> {
      disposed = true;
      state = { phase: 'closed' };
      listeners.clear();
      return Promise.resolve();
    },
    dispose(): void {
      disposed = true;
      state = { phase: 'closed' };
      listeners.clear();
    },
  };
}
