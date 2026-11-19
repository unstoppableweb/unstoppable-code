import { randomUUID } from 'node:crypto';
import type {
  BrowserHandoffEvent,
  BrowserHandoff,
  BrowserHandoffHydration,
  ShowFilesChatOrigin,
} from '@canopy/desktop-shared/types';
import { presentationChatKey } from '../canopy-tools/presentation-state';

type HandoffEvent = Extract<
  BrowserHandoffEvent,
  { type: 'handoff-requested' | 'handoff-released' }
>;
interface PendingHandoff {
  handoff: BrowserHandoff;
  publish: (event: HandoffEvent) => void;
}

/** Process-local core authority. No disk writer, timers, or renderer-owned lifecycle. */
export interface BrowserHandoffAdmission {
  targetRevision: number;
  originRevision: number;
  chatRevision: number;
}

export class BrowserHandoffStore {
  private readonly worktreeRevisions = new Map<string, number>();
  private readonly chatRevisions = new Map<string, number>();

  captureAdmission(
    projectId: string,
    worktreeId: string,
    origin: ShowFilesChatOrigin,
  ): BrowserHandoffAdmission {
    return {
      targetRevision:
        this.worktreeRevisions.get(`${projectId}/${worktreeId}`) ?? 0,
      originRevision:
        this.worktreeRevisions.get(
          `${origin.projectId}/${origin.worktreeId}`,
        ) ?? 0,
      chatRevision: this.chatRevisions.get(presentationChatKey(origin)) ?? 0,
    };
  }

  isAdmissionCurrent(
    projectId: string,
    worktreeId: string,
    origin: ShowFilesChatOrigin,
    admission: BrowserHandoffAdmission,
  ): boolean {
    const current = this.captureAdmission(projectId, worktreeId, origin);
    return (
      current.targetRevision === admission.targetRevision &&
      current.originRevision === admission.originRevision &&
      current.chatRevision === admission.chatRevision
    );
  }

  private revision = 0;
  private readonly pending = new Map<string, PendingHandoff>();

  snapshot(projectId: string, worktreeId: string): BrowserHandoffHydration {
    return {
      revision: this.revision,
      handoff: structuredClone(
        this.pending.get(`${projectId}/${worktreeId}`)?.handoff ?? null,
      ),
    };
  }

  request(
    input: Omit<BrowserHandoff, 'handoffId' | 'requestedAt'>,
    publish: PendingHandoff['publish'],
  ): BrowserHandoff {
    const key = `${input.projectId}/${input.worktreeId}`;
    const previous = this.pending.get(key)?.handoff;
    if (
      previous?.browserId === input.browserId &&
      previous.runtimeGeneration === input.runtimeGeneration &&
      presentationChatKey(previous.origin) === presentationChatKey(input.origin)
    )
      return structuredClone(previous);
    const handoff: BrowserHandoff = {
      ...input,
      origin: { ...input.origin },
      handoffId: randomUUID(),
      requestedAt: Date.now(),
    };
    this.pending.set(key, { handoff, publish });
    publish({
      type: 'handoff-requested',
      browserId: handoff.browserId,
      handoff: structuredClone(handoff),
      revision: ++this.revision,
      runtimeGeneration: handoff.runtimeGeneration,
    });
    return structuredClone(handoff);
  }

  release(handoffId: string): void {
    this.releaseHandoffs([handoffId]);
  }

  private releaseHandoffs(handoffIds: readonly string[]): void {
    const ids = new Set(handoffIds);
    const released: PendingHandoff[] = [];
    for (const [key, entry] of Array.from(this.pending)) {
      if (!ids.has(entry.handoff.handoffId)) continue;
      this.pending.delete(key);
      released.push(entry);
    }
    // Finish internal cleanup before invoking any window publisher. One failed
    // notification must not leave another target pinned or skip its event.
    const failures: unknown[] = [];
    for (const entry of released) {
      try {
        entry.publish({
          type: 'handoff-released',
          browserId: entry.handoff.browserId,
          handoffId: entry.handoff.handoffId,
          projectId: entry.handoff.projectId,
          worktreeId: entry.handoff.worktreeId,
          revision: ++this.revision,
          runtimeGeneration: entry.handoff.runtimeGeneration,
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        'Browser handoff release notification failed',
      );
  }

  captureOrigin(origin: ShowFilesChatOrigin): string[] {
    return Array.from(this.pending.values())
      .filter(
        (entry) =>
          presentationChatKey(entry.handoff.origin) ===
          presentationChatKey(origin),
      )
      .map((entry) => entry.handoff.handoffId);
  }

  releaseOrigin(origin: ShowFilesChatOrigin): void {
    // Chat ids are unique within a scope, including compatibility imports.
    // Removing one origin must not fence the same id in another scope.
    const key = presentationChatKey(origin);
    this.chatRevisions.set(key, (this.chatRevisions.get(key) ?? 0) + 1);
    this.releaseHandoffs(this.captureOrigin(origin));
  }

  releaseBrowser(browserId: string): void {
    for (const { handoff } of Array.from(this.pending.values()))
      if (handoff.browserId === browserId) this.release(handoff.handoffId);
  }

  releaseWorktree(projectId: string, worktreeId: string): void {
    const key = `${projectId}/${worktreeId}`;
    this.worktreeRevisions.set(key, (this.worktreeRevisions.get(key) ?? 0) + 1);
    for (const { handoff } of Array.from(this.pending.values())) {
      if (
        (handoff.projectId === projectId &&
          handoff.worktreeId === worktreeId) ||
        (handoff.origin.projectId === projectId &&
          handoff.origin.worktreeId === worktreeId)
      )
        this.release(handoff.handoffId);
    }
  }
}

export const browserHandoffs = new BrowserHandoffStore();
