import type {
  InternalRootRepairContext,
  InternalRootRepairs,
} from './internal-root-migration';
import {
  createRelocationRepairStep,
  isWithin,
  repairRelocatedWorkspace,
  type RelocationTransition,
  type RelocationRepairContext,
  type RelocationGitPlan,
  type RelocationWorkspaceEvidence,
} from './relocation';
import { createWorkspaceManifestRepository } from './w5/workspace-manifest-repository';
import { createWorktreeListRepository } from './w5/worktree-list-repository';
import type { W5Resource } from './w5/commit-log/commit-log';
import type { W5FileStore } from './w5/file-store';

export interface InternalRootLifecycleJournalEvidence {
  readonly abandoned?: {
    readonly workspaceId: string;
    readonly worktreeId: string;
  };
  readonly name: string;
  readonly raw: string;
  readonly workspaceIdentity: string | null;
  readonly ownedIdentities: readonly (string | null)[];
}

export interface InternalRootRepairPlan {
  /** Worker-validated recovery storage preimage, frozen in the transaction sidecar. */
  readonly archiveRecovery?: string;
  /** In-memory evidence; persistence keeps it in a transaction-bound sidecar. */
  readonly lifecycleJournals?: readonly InternalRootLifecycleJournalEvidence[];
  readonly abandonedPaths?: readonly string[];
  readonly abandonedCheckouts?: readonly string[];
  readonly transition: RelocationTransition;
  readonly gitPlan: RelocationGitPlan;
  readonly ownedPaths: readonly string[];
  readonly workspaces: readonly RelocationWorkspaceEvidence[];
}
export interface InternalRootMetadataImage {
  readonly workspaceId: string;
  readonly manifestRaw: string;
  readonly listRaw: string | null;
  readonly advance: readonly W5Resource[];
}

/** Project through C's W5 owners, never by walking/replacing arbitrary JSON strings. */
export async function projectInternalRootMetadata(
  plan: InternalRootRepairPlan,
): Promise<readonly InternalRootMetadataImage[]> {
  const images: InternalRootMetadataImage[] = [];
  for (const evidence of plan.workspaces) {
    const files = new Map<string, string | null>([
      ['manifest', evidence.manifestRaw],
      ['list', evidence.listRaw],
    ]);
    const advance: W5Resource[] = [];
    const store: W5FileStore = {
      read: (path) => {
        const raw = files.get(path);
        return Promise.resolve(
          raw == null ? { state: 'absent' } : { state: 'present', raw },
        );
      },
      replace: (path, contents, _storage, replacement) => {
        files.set(path, contents);
        advance.push(...replacement.advance);
        return Promise.resolve();
      },
      remove: () =>
        Promise.reject(new Error('Relocation never removes owner records')),
    };
    const manifest = createWorkspaceManifestRepository({
      store,
      filePath: () => 'manifest',
      storage: { namespace: 'workspace_manifest', writer: 'electron_main' },
      knownFields: new Set(),
      knownRepoFields: new Set(),
    });
    const list = createWorktreeListRepository({
      store,
      filePath: () => 'list',
      storage: { namespace: 'worktree_list', writer: 'electron_main' },
      knownRowFields: new Set(),
      readRow: (row) => row,
    });
    await repairRelocatedWorkspace(plan.transition, evidence, manifest, list);
    const abandoned = (plan.lifecycleJournals ?? []).flatMap((entry) =>
      entry.abandoned?.workspaceId === evidence.workspaceId
        ? [entry.abandoned.worktreeId]
        : [],
    );
    if (abandoned.length) {
      const current = await list.read(evidence.workspaceId);
      if (current.authority === 'ok')
        await list.replace(
          evidence.workspaceId,
          current.worktrees.filter((row) => !abandoned.includes(row.id)),
          current,
        );
    }
    const manifestRaw = files.get('manifest');
    if (typeof manifestRaw !== 'string')
      throw new Error('Missing projected manifest');
    images.push({
      workspaceId: evidence.workspaceId,
      manifestRaw,
      listRaw: files.get('list') ?? null,
      advance,
    });
  }
  return images;
}

/** Worker/platform host supplies observation, durability and read-only qualification. */
export interface InternalRootRepairWorker {
  readonly onProgress?: (detail: string) => void;
  /** Reconstruct named owners when legacy plans also contain incidental link targets. */
  ownedPathsForProof?(plan: InternalRootRepairPlan): readonly string[];
  readonly replaceBacklink?: RelocationRepairContext['replaceBacklink'];
  freeze(context: InternalRootRepairContext): Promise<InternalRootRepairPlan>;
  admit(
    context: InternalRootRepairContext,
    plan: InternalRootRepairPlan,
  ): Promise<void>;
  recordAuthority(
    context: InternalRootRepairContext,
    plan: InternalRootRepairPlan,
  ): Promise<void>;
  repairMetadata(
    context: InternalRootRepairContext,
    plan: InternalRootRepairPlan,
    images: readonly InternalRootMetadataImage[],
  ): Promise<void>;
  verify(
    context: InternalRootRepairContext,
    plan: InternalRootRepairPlan,
    images: readonly InternalRootMetadataImage[],
    published: boolean,
  ): Promise<void>;
}

export function createInternalRootRepairs(
  worker: InternalRootRepairWorker,
): InternalRootRepairs {
  const planFor = (
    context: InternalRootRepairContext,
  ): InternalRootRepairPlan => {
    if (!context.repairPlan)
      throw new Error(
        'Frozen relocation evidence is missing; preserve both roots and the journal for recovery.',
      );
    return context.repairPlan;
  };
  return {
    settleSourceFirst: true,
    prepare: async (context) => {
      const plan = context.repairPlan ?? (await worker.freeze(context));
      // Refuse unsupported owner shapes before a clone or external write.
      await projectInternalRootMetadata(plan);
      const externalFiles = plan.gitPlan.backlinks
        .map((image) => image.path)
        .filter((path) => !isWithin(context.identity.source, path));
      return { kind: 'ready', externalFiles, repairPlan: plan };
    },
    repair: async (context) => {
      const plan = planFor(context);
      const images = await projectInternalRootMetadata(plan);
      await createRelocationRepairStep()({
        transition: plan.transition,
        workingRoot: context.workingRoot,
        gitPlan: plan.gitPlan,
        replaceBacklink: worker.replaceBacklink,
        ownedPaths: worker.ownedPathsForProof?.(plan) ?? plan.ownedPaths,
        carryPayloadLinks: true,
        onProgress: worker.onProgress,
        admit: () => worker.admit(context, plan),
        recordAuthority: () => worker.recordAuthority(context, plan),
        repairMetadata: () => worker.repairMetadata(context, plan, images),
      });
      return { kind: 'ok' };
    },
    verify: async (context) => {
      const plan = planFor(context);
      await worker.verify(
        context,
        plan,
        await projectInternalRootMetadata(plan),
        false,
      );
      return { kind: 'ok' };
    },
    qualifyPublished: async (context) => {
      const plan = planFor(context);
      await worker.verify(
        context,
        plan,
        await projectInternalRootMetadata(plan),
        true,
      );
      return { kind: 'ok' };
    },
  };
}
