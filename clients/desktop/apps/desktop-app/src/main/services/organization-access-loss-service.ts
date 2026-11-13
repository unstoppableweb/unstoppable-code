import type {
  OrgProjectOwnershipChangedEvent,
  WorkspaceOwnerBinding,
} from '@canopy/desktop-shared/types';
import type {
  OrganizationAccessLossRecord,
  OrganizationAccessLossWorkspace,
} from '../lib/organization-access-loss-record';
import type {
  WorkspaceOwnershipRead,
  WorkspaceOwnershipUpdate,
} from '../lib/workspace-persistence';
import type { WorkspaceOwnerRecord } from '../lib/workspace-ownership';
import type { withOrganizationAccessLoss } from '../lib/canopy-cloud-account-store';
import type { WorkspaceOwnershipChange } from './background-execution-rebinding';
import { logMainProcessError } from '../lib/main-process-logging';

export { selectLostOrganizationIds } from '../lib/organization-access-loss-record';

export interface OrganizationAccessLossDeps {
  listWorkspaceIds(): Promise<string[]>;
  readOwnership(workspaceId: string): Promise<WorkspaceOwnershipRead>;
  recordOwner(
    this: void,
    record: WorkspaceOwnerRecord,
  ): Promise<WorkspaceOwnershipUpdate>;
  withCurrent: typeof withOrganizationAccessLoss;
  complete(record: OrganizationAccessLossRecord): Promise<void>;
  rebind(change: WorkspaceOwnershipChange): Promise<unknown>;
  log(error: unknown): void;
}

export interface OrganizationAccessLossOutcome {
  workspaceId: string;
  organizationId: string;
  status: WorkspaceOwnershipUpdate | 'recovered' | 'failed' | 'stale';
}

export interface OrganizationAccessLossReport {
  outcomes: OrganizationAccessLossOutcome[];
  incomplete: boolean;
}

export interface OrganizationAccessLossService {
  process(
    records: readonly OrganizationAccessLossRecord[],
  ): Promise<OrganizationAccessLossReport>;
  onOwnershipChanged(
    listener: (event: OrgProjectOwnershipChangedEvent) => void,
  ): () => void;
}

function sameBinding(
  a: WorkspaceOwnerBinding | undefined,
  b: WorkspaceOwnerBinding,
): boolean {
  return (
    a?.type === b.type &&
    a.organizationId === b.organizationId &&
    a.projectId === b.projectId &&
    a.instanceId === b.instanceId &&
    a.bindingGeneration === b.bindingGeneration
  );
}

/** Durable receipts make this an at-least-once queue, bounded by refresh lifecycle. */
export function createOrganizationAccessLossService(
  deps: OrganizationAccessLossDeps,
): OrganizationAccessLossService {
  let queue: Promise<unknown> = Promise.resolve();
  const listeners = new Set<(event: OrgProjectOwnershipChangedEvent) => void>();

  async function run(
    records: readonly OrganizationAccessLossRecord[],
  ): Promise<OrganizationAccessLossReport> {
    const report: OrganizationAccessLossReport = {
      outcomes: [],
      incomplete: false,
    };
    const unique = new Map(
      records.map((record) => [
        JSON.stringify([
          record.accountId,
          record.organizationId,
          record.detachedAt,
        ]),
        record,
      ]),
    );
    for (const record of unique.values()) {
      try {
        // Enumerate only once, then freeze the indexed membership in the handoff.
        // A later recovery never sweeps newly added projects or absent orgs.
        const initialized = await deps.withCurrent(record, async (context) => {
          if (!context.record.workspaces) {
            const ids = [...new Set(await deps.listWorkspaceIds())];
            await context.checkpoint(
              ids.map((workspaceId) => ({ workspaceId })),
            );
          }
          return context.record.workspaces;
        });
        if (!initialized) continue;
        let incomplete = false;
        for (const workspace of initialized) {
          if (workspace.complete) continue;
          try {
            const outcome = await deps.withCurrent(
              record,
              async (
                context,
              ): Promise<OrganizationAccessLossOutcome['status']> => {
                const workspaces = context.record.workspaces;
                const held = workspaces?.find(
                  (item) => item.workspaceId === workspace.workspaceId,
                );
                if (!workspaces || !held || held.complete) return 'declined';
                const checkpoint = async (
                  replacement: OrganizationAccessLossWorkspace,
                ): Promise<void> =>
                  context.checkpoint(
                    workspaces.map((item) =>
                      item === held ? replacement : item,
                    ),
                  );
                const current = await deps.readOwnership(held.workspaceId);
                if (current.authority !== 'ok') {
                  if (current.authority === 'absent')
                    await checkpoint({ ...held, complete: true });
                  else
                    deps.log(
                      new Error(
                        `Workspace ${held.workspaceId} ownership is unreadable`,
                      ),
                    );
                  return current.authority;
                }
                const history = current.detachedOwner;
                const recovering =
                  !current.owner &&
                  history?.detachedAt === record.detachedAt &&
                  history.owner.organizationId === record.organizationId;
                let owner = held.owner;
                let status: OrganizationAccessLossOutcome['status'] =
                  'recovered';
                if (!recovering) {
                  if (
                    !context.membershipLost ||
                    !current.owner ||
                    current.owner.organizationId !== record.organizationId ||
                    (owner && !sameBinding(current.owner, owner))
                  ) {
                    await checkpoint({ ...held, complete: true });
                    return 'declined';
                  }
                  owner ??= current.owner;
                  // Persist the exact binding before submitting the conditional write.
                  await checkpoint({ ...held, owner });
                  const expected = owner;
                  status = await deps.recordOwner({
                    workspaceId: held.workspaceId,
                    source: 'organization_access_loss',
                    update: (latest) =>
                      sameBinding(latest.owner, expected)
                        ? {
                            owner: undefined,
                            ownershipTransfer: latest.ownershipTransfer,
                            detachedOwner: {
                              version: 1,
                              owner: expected,
                              reason: 'organization-access-lost',
                              detachedAt: record.detachedAt,
                            },
                          }
                        : null,
                  });
                  if (status !== 'written') {
                    if (status !== 'unreadable')
                      await checkpoint({ ...held, owner, complete: true });
                    return status;
                  }
                } else {
                  owner = history.owner;
                }
                if (!owner) throw new Error('Detached binding is unavailable');
                // Rebinding rejects on any failed store. The pending receipt remains
                // until it and delivery both succeed, without rewriting the manifest.
                await deps.rebind({
                  workspaceId: held.workspaceId,
                  from: {
                    kind: 'organization',
                    organizationId: owner.organizationId,
                  },
                  to: { kind: 'personal' },
                });
                let deliveryFailed = false;
                for (const listener of listeners) {
                  try {
                    listener({
                      workspaceId: held.workspaceId,
                      organizationId: owner.organizationId,
                      projectId: owner.projectId,
                      owner: 'personal',
                    });
                  } catch (error) {
                    deliveryFailed = true;
                    deps.log(error);
                  }
                }
                if (deliveryFailed)
                  throw new Error('Ownership event delivery is incomplete');
                await checkpoint({ ...held, owner, complete: true });
                return status;
              },
            );
            report.outcomes.push({
              workspaceId: workspace.workspaceId,
              organizationId: record.organizationId,
              status: outcome ?? 'stale',
            });
            if (outcome === 'unreadable') incomplete = true;
          } catch (error) {
            deps.log(error);
            incomplete = true;
            report.outcomes.push({
              workspaceId: workspace.workspaceId,
              organizationId: record.organizationId,
              status: 'failed',
            });
          }
        }
        if (!incomplete) await deps.complete(record);
        report.incomplete ||= incomplete;
      } catch (error) {
        deps.log(error);
        report.incomplete = true;
      }
    }
    return report;
  }

  return {
    process(records): Promise<OrganizationAccessLossReport> {
      const next = queue.catch(() => undefined).then(() => run(records));
      queue = next;
      return next;
    },
    onOwnershipChanged(listener): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
  };
}

let singleton: OrganizationAccessLossService | undefined;

export function getOrganizationAccessLossService(): OrganizationAccessLossService {
  singleton ??= createOrganizationAccessLossService({
    listWorkspaceIds: async (): Promise<string[]> => {
      const { getWorkspaceIndexRepository } =
        await import('../lib/sidebar-items');
      const read = await getWorkspaceIndexRepository().read();
      if (read.authority !== 'ok' && read.authority !== 'absent')
        throw new Error('Workspace index is unreadable');
      return read.entries.map((entry) => entry.id);
    },
    readOwnership: async (id): Promise<WorkspaceOwnershipRead> =>
      (await import('../lib/workspace-persistence')).readWorkspaceOwnership(id),
    recordOwner: async (record): Promise<WorkspaceOwnershipUpdate> =>
      (await import('../lib/workspace-ownership')).recordWorkspaceOwner(record),
    withCurrent: async (record, operation) =>
      (
        await import('../lib/canopy-cloud-account-store')
      ).withOrganizationAccessLoss(record, operation),
    complete: async (record): Promise<void> =>
      (
        await import('../lib/canopy-cloud-account-store')
      ).completeOrganizationAccessLoss(record),
    rebind: async (change): Promise<unknown> =>
      (await import('./background-execution-rebinding'))
        .getBackgroundExecutionContextRebinder()
        .rebindWorkspace(change, 'ownership-change'),
    log: (error): void =>
      logMainProcessError(
        'Organization access loss processing is incomplete:',
        error,
      ),
  });
  return singleton;
}
