import type { CanopyClient } from '@canopy/app-core';
import type { WorktreeRecoveryListResult } from '@canopy/protocol/canopy-core';
import type { WorktreeRecoveryDescription } from '@canopy/protocol/remote-control/shell/worktree-recovery';

type Hold = NonNullable<WorktreeRecoveryListResult['resolutions']>[number];
type Project = Omit<WorktreeRecoveryListResult, 'check'> & {
  workspaceId: string;
  check: WorktreeRecoveryListResult['check'] | 'list-unavailable';
};

export function recoveryEvidenceUnavailable(
  result: Pick<WorktreeRecoveryListResult, 'unreadableEvidence'> & {
    check: string;
  },
): boolean {
  return result.check !== 'ok' || result.unreadableEvidence === 'receipts';
}

export function needsRecoveryReview(hold: Hold): boolean {
  return (
    hold.retention !== 'deleted' &&
    (hold.stage !== 'completed' || hold.retention === 'deleting')
  );
}

export function hasRecoveryMaterial(hold: Hold): boolean {
  return (
    needsRecoveryReview(hold) ||
    (hold.retention !== 'deleted' &&
      (hold.retainedSnapshots > 0 || hold.retainedPayload))
  );
}

function entryKey(entry: WorktreeRecoveryDescription): string {
  return JSON.stringify([
    entry.subject.workspaceId,
    entry.subject.worktreeId,
    entry.subject.createdAt,
    entry.diagnosis?.operationId ??
      (entry.evidence.kind === 'journal' ? entry.evidence.operationId : null),
  ]);
}

function attentionKeys(projects: readonly Project[], error: boolean): string[] {
  return [
    ...(error ? ['check-unavailable'] : []),
    ...projects.flatMap((project) => [
      ...(recoveryEvidenceUnavailable(project)
        ? [`${project.workspaceId}:unavailable`]
        : []),
      ...project.entries.map((entry) => entryKey(entry)),
      ...(project.resolutions
        ?.filter(needsRecoveryReview)
        .map((hold) => `${project.workspaceId}:${hold.operationId}`) ?? []),
    ]),
  ];
}

const STORAGE_KEY = 'canopy:archive-recovery:dismissed:v1';

function readDismissed(): Set<string> {
  try {
    const stored: unknown = JSON.parse(
      globalThis.localStorage?.getItem(STORAGE_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(stored)
        ? stored.filter((key): key is string => typeof key === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

// Origin-local UI memory on both hosts, not recovery evidence. Store identities
// only; rechecking or revising the same operation must not undo a dismissal.
const dismissed = new WeakMap<CanopyClient, Set<string>>();

function dismissedFor(client: CanopyClient): Set<string> {
  let keys = dismissed.get(client);
  if (!keys) {
    keys = readDismissed();
    dismissed.set(client, keys);
  }
  return keys;
}

export function hasNewRecovery(
  client: CanopyClient,
  projects: readonly Project[],
  error: boolean,
): boolean {
  const keys = dismissedFor(client);
  return attentionKeys(projects, error).some((key) => !keys.has(key));
}

export function dismissRecovery(
  client: CanopyClient,
  projects: readonly Project[],
  error: boolean,
): void {
  const keys = dismissedFor(client);
  for (const key of readDismissed()) keys.add(key);
  for (const key of attentionKeys(projects, error)) keys.add(key);
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Storage denied or full: keep the dismissal for this client session.
  }
}
