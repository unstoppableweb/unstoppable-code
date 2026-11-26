import type { WorkerAgentTurnScope } from '@canopy/protocol/canopy-core';

/** The turn an admitted approval belongs to. */
export interface AdmittedTurnApprovalKey {
  readonly turnRunId: string;
  readonly scope: WorkerAgentTurnScope;
}

interface Entry<Admitted> {
  readonly key: AdmittedTurnApprovalKey;
  readonly policyRevision: number;
  readonly admitted: Admitted;
}

const sameKey = (
  a: AdmittedTurnApprovalKey,
  b: AdmittedTurnApprovalKey,
): boolean =>
  a.turnRunId === b.turnRunId &&
  a.scope.workspaceId === b.scope.workspaceId &&
  a.scope.worktreeId === b.scope.worktreeId &&
  a.scope.chatId === b.scope.chatId;

/**
 * The approvals core admitted for live chat turns, by admission id. A turn's
 * launch carries only the id; the serving host reads the admitted approval
 * here, never from the launch, because a host's rules can name host paths
 * and core evaluates policy (ADR 22a rule 1). Memory only: a turn run is
 * lost on restart, and its admission with it.
 */
export class AdmittedTurnApprovals<Admitted> {
  private readonly entries = new Map<string, Entry<Admitted>>();

  /** Records an admission; false when the id is already in use. */
  add(
    admissionId: string,
    key: AdmittedTurnApprovalKey,
    policyRevision: number,
    admitted: Admitted,
  ): boolean {
    if (this.entries.has(admissionId)) return false;
    this.entries.set(admissionId, { key, policyRevision, admitted });
    return true;
  }

  /** The admitted approval for this turn, or null when unknown or another turn's. */
  read(admissionId: string, key: AdmittedTurnApprovalKey): Admitted | null {
    const entry = this.entries.get(admissionId);
    return entry && sameKey(entry.key, key) ? entry.admitted : null;
  }

  release(admissionId: string): void {
    this.entries.delete(admissionId);
  }

  get size(): number {
    return this.entries.size;
  }
}
