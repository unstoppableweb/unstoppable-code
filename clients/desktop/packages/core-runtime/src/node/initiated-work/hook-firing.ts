import {
  InitiatedWorkHookOriginContextSchema,
  type CanopyErrorPayload,
  type CanopyWorkspaceScope,
  type InitiatedWorkGate,
  type InitiatedWorkHookOriginContext,
  type OperationOrigin,
  type OperationOwner,
  type OperationRecord,
} from '@canopy/protocol/canopy-core';

import type { OperationCancelRequest } from '../operations/service';
import type {
  InitiatedWorkAcceptance,
  InitiatedWorkEngine,
  InitiatedWorkGateCheck,
  InitiatedWorkGateVerdict,
  InitiatedWorkRequest,
  InitiatedWorkSkipCode,
  InitiatedWorkSubmission,
} from './engine';

/*
 * Hooks as a source of the initiated-work engine (CAN-4146). Every hook
 * firing, whatever started it (a pull request advance, a pre-commit failure,
 * a manual or Portal run, a restart's recovery), comes through `fire`, which
 * decides its gates in one place: the worktree's pause unless the request
 * explicitly bypasses it, the split lock, the deletion fence, and the
 * project's saved owner read when the hook fires. A paused firing is
 * recorded as a skipped run. Firings for one target reach the engine in
 * the order they were fired, whatever their reads cost.
 */

export type HookProjectOwner = InitiatedWorkHookOriginContext['projectOwner'];

/** Whether a worktree's pause applies to a firing. */
export type HookPausePolicy = NonNullable<
  InitiatedWorkHookOriginContext['pause']
>;

/** The hook a firing names; known before its actions are read. */
export interface HookRef {
  readonly hookKey: string;
  readonly triggerName: string;
  readonly target: InitiatedWorkHookOriginContext['target'];
  readonly repoId?: string;
}

/** The action fields the owner gates consult; hosts keep their own type. */
export interface HookActionRef {
  readonly type: string;
  readonly executionContext?: string;
}

export const HOOK_PAUSED_MESSAGE = 'This hook is paused in this worktree.';

/** The code of a skip whose worktree pause state could not be read (CAN-7094). */
export const HOOK_PAUSE_UNKNOWN_CODE =
  'core.initiatedWork.gate.pauseUnknown' satisfies InitiatedWorkSkipCode;

export const HOOK_PAUSE_UNKNOWN_MESSAGE =
  "This hook was skipped because this worktree's paused hooks could not be read.";

/** A worktree's paused hook keys, or `unknown` when they could not be read. */
type HookPauseState = ReadonlySet<string> | 'unknown';

/** What the hook source reads from its host. Every effect stays there. */
export interface HookFiringHost {
  /**
   * The hook keys paused in a worktree. Throws when they can't be read; an
   * enforced firing is then skipped as `pause state unknown`, never run.
   */
  pausedHookKeys(
    workspaceId: string,
    worktreeId: string,
  ): Promise<ReadonlySet<string>>;
  /** Throws the host's error while a split holds the worktree. */
  assertNotSplitLocked(workspaceId: string, worktreeId: string): void;
  /** Throws the host's error while the worktree is archived or deleted. */
  assertStartAllowed(workspaceId: string, worktreeId: string): void;
  /** The project's saved owner; `unknown` when it cannot be read. */
  projectOwner(
    workspaceId: string,
    worktreeId: string,
  ): Promise<HookProjectOwner>;
  /** The operation owner of a run in a project without an organization. */
  readonly localAuthorityId: string;
}

export interface HookFireRequest<T> {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly hook: HookRef;
  readonly invocation: InitiatedWorkHookOriginContext['invocation'];
  readonly pause: HookPausePolicy;
  /** The firing's stable identity; a repeat answers with the recorded run. */
  readonly occurrenceKey?: string;
  /** The run's operation when the firing was accepted with its state (CAN-4145). */
  readonly acceptedOperationId?: string;
  /**
   * Read the hook's actions and build its run. Called after the gates that
   * need no configuration (pause and split lock) let the firing through.
   */
  prepare(): Promise<HookFirePreparation<T>>;
}

export type HookFirePreparation<T> =
  /** The trigger has no actions here; nothing runs and nothing is recorded. */
  | { kind: 'unconfigured'; value: T }
  /** A precondition of the source stopped the firing, such as an active PR. */
  | {
      kind: 'refused';
      gate: InitiatedWorkGate;
      failure: CanopyErrorPayload;
      cause: unknown;
    }
  | ({
      kind: 'ready';
      actions: readonly HookActionRef[];
      /** The pull request whose snapshot the run reads, when it has one. */
      pullRequest?: { repository: string; number: number };
    } & Pick<InitiatedWorkRequest<T>, 'client' | 'onQueued' | 'execute'>);

export type HookFireResult<T> =
  | InitiatedWorkSubmission<T>
  | { disposition: 'unconfigured'; value: T };

/** One firing a source accepts with the state that fired it. */
export interface HookFiringAdmission {
  readonly hook: HookRef;
  readonly occurrenceKey: string;
  readonly pullRequest?: { repository: string; number: number };
}

/** A queued or running hook run, or a firing still being admitted. */
export interface LiveHookRun {
  readonly operationId: string | null;
  readonly scope: CanopyWorkspaceScope;
  readonly hookKey: string;
  readonly started: boolean;
}

interface PendingFiring extends LiveHookRun {
  readonly controller: AbortController;
}

/**
 * A place in a target's admission order. `ready` is set once its holder
 * decided what to hand the engine; it is called when the place reaches the
 * head of its target, and the holder releases the place once the engine
 * has the work.
 */
interface AdmissionSlot {
  ready: (() => void) | null;
  turn: boolean;
}

function scopeOf(
  workspaceId: string,
  worktreeId: string,
  hook: Pick<HookRef, 'target' | 'repoId'>,
): CanopyWorkspaceScope {
  return {
    workspaceId,
    worktreeId,
    ...(hook.target === 'workspace-repo' && hook.repoId !== undefined
      ? { repoId: hook.repoId }
      : {}),
  };
}

/** Hooks for one repo target of a worktree run one at a time. */
export function hookTargetKey(
  workspaceId: string,
  worktreeId: string,
  hook: Pick<HookRef, 'target' | 'repoId'>,
): string {
  return `${workspaceId}\0${worktreeId}\0${hook.target}\0${hook.repoId ?? ''}`;
}

/** The pause policy a recorded hook run was fired under. */
export function recordedHookPause(
  context: InitiatedWorkHookOriginContext,
): HookPausePolicy {
  return (
    context.pause ?? (context.invocation === 'manual' ? 'bypass' : 'enforce')
  );
}

function hostRefusal(
  gate: InitiatedWorkGate,
  kind: CanopyErrorPayload['kind'],
  error: unknown,
  fallback: string,
): InitiatedWorkGateVerdict {
  return {
    decision: 'refused',
    failure: {
      kind,
      message:
        error instanceof Error && error.message.length > 0
          ? error.message
          : fallback,
      retry: { kind: 'never' },
    },
    cause: error,
  };
}

function fixedGate(
  gate: InitiatedWorkGate,
  verdict: InitiatedWorkGateVerdict,
): InitiatedWorkGateCheck {
  return { gate, check: () => verdict };
}

const NEVER_RUNS = (): Promise<never> =>
  Promise.reject(new Error('A stopped hook never runs.'));

export class HookFiring {
  private readonly engine: InitiatedWorkEngine;
  private readonly host: HookFiringHost;
  private readonly pending = new Set<PendingFiring>();
  /**
   * Each target's firings in the order they were fired. A firing reaches
   * the engine once it and every earlier firing for its target decided
   * their gates, in the same turn, so firings made together are queued
   * together.
   */
  private readonly admissions = new Map<string, AdmissionSlot[]>();

  constructor(options: { engine: InitiatedWorkEngine; host: HookFiringHost }) {
    this.engine = options.engine;
    this.host = options.host;
  }

  get initiatedWork(): InitiatedWorkEngine {
    return this.engine;
  }

  /**
   * Fire a hook. Resolves once its run ends, or at once when a gate stops
   * it, it is a duplicate, or its trigger has nothing to run.
   */
  fire<T>(request: HookFireRequest<T>): Promise<HookFireResult<T>> {
    const scope = scopeOf(
      request.workspaceId,
      request.worktreeId,
      request.hook,
    );
    const targetKey = hookTargetKey(
      request.workspaceId,
      request.worktreeId,
      request.hook,
    );
    const pending: PendingFiring = {
      operationId: request.acceptedOperationId ?? null,
      scope,
      hookKey: request.hook.hookKey,
      started: false,
      controller: new AbortController(),
    };
    this.pending.add(pending);
    const slot = this.takeAdmissionSlot(targetKey);
    return this.admit(request, { scope, targetKey, pending, slot });
  }

  /**
   * Accept the firings a source detected with the state that fired them, in
   * one ledger transaction (CAN-4145). A paused hook is recorded as skipped
   * there and never started; the others start through {@link fire} with
   * their accepted operation.
   */
  async acceptOccurrence(input: {
    workspaceId: string;
    worktreeId: string;
    head: { source: string; subject: string; value: string };
    firings: readonly HookFiringAdmission[];
  }): Promise<InitiatedWorkAcceptance[]> {
    const targetKeys = new Set(
      input.firings.map((firing) =>
        hookTargetKey(input.workspaceId, input.worktreeId, firing.hook),
      ),
    );
    // The firings take their places on their targets now, behind earlier
    // firings still deciding their gates.
    const slots = Array.from(targetKeys, (targetKey) => ({
      targetKey,
      slot: this.takeAdmissionSlot(targetKey),
    }));
    const release = (): void => {
      for (const { targetKey, slot } of slots)
        this.releaseAdmissionSlot(targetKey, slot);
    };
    let accepted: Promise<InitiatedWorkAcceptance[]>;
    try {
      const [paused, projectOwner] = await Promise.all([
        this.readPaused(input.workspaceId, input.worktreeId),
        this.host.projectOwner(input.workspaceId, input.worktreeId),
      ]);
      await Promise.all(
        slots.map(
          ({ targetKey, slot }) =>
            new Promise<void>((resolve) => {
              this.awaitAdmissionTurn(targetKey, slot, resolve);
            }),
        ),
      );
      // The engine takes the accepted runs' places on their targets as it
      // is called, so the targets can move on at once.
      accepted = this.engine.acceptOccurrence({
        head: input.head,
        runs: input.firings.map((firing) => {
          const verdict = this.pauseVerdict(paused, firing.hook.hookKey);
          return {
            origin: this.origin({
              hook: firing.hook,
              invocation: 'automatic',
              pause: 'enforce',
              projectOwner,
              occurrenceKey: firing.occurrenceKey,
              ...(firing.pullRequest
                ? { pullRequest: firing.pullRequest }
                : {}),
            }),
            owner: this.operationOwner(projectOwner),
            scope: scopeOf(input.workspaceId, input.worktreeId, firing.hook),
            targetKey: hookTargetKey(
              input.workspaceId,
              input.worktreeId,
              firing.hook,
            ),
            ...(verdict.decision === 'skipped'
              ? { stopped: { gate: 'pause' as const, verdict } }
              : {}),
          };
        }),
      });
    } finally {
      release();
    }
    return accepted;
  }

  /**
   * The gates a recovered run meets again before it resumes, with the owner
   * read now. The run keeps the pause policy it was fired under.
   */
  async recoveredGates(
    operation: OperationRecord,
    actions: readonly HookActionRef[],
  ): Promise<InitiatedWorkGateCheck[]> {
    const context = InitiatedWorkHookOriginContextSchema.parse(
      operation.origin.context,
    );
    const { workspaceId, worktreeId } = operation.scope;
    if (workspaceId === undefined || worktreeId === undefined)
      throw new Error('A hook run is always scoped to a worktree.');
    const pause = recordedHookPause(context);
    const [paused, projectOwner] = await Promise.all([
      pause === 'enforce'
        ? this.readPaused(workspaceId, worktreeId)
        : Promise.resolve(null),
      this.host.projectOwner(workspaceId, worktreeId),
    ]);
    return [
      ...this.configurationFreeGates(
        workspaceId,
        worktreeId,
        operation.origin.sourceId,
        paused,
      ),
      ...this.configuredGates(workspaceId, worktreeId, actions, projectOwner),
    ];
  }

  /** Queued and running hook runs, and firings still being admitted. */
  liveRuns(): LiveHookRun[] {
    const admitting = Array.from(this.pending, (firing) => ({
      operationId: firing.operationId,
      scope: firing.scope,
      hookKey: firing.hookKey,
      started: false,
    }));
    const admittingIds = new Set(
      admitting.flatMap((run) =>
        run.operationId === null ? [] : [run.operationId],
      ),
    );
    const engineRuns = this.engine
      .liveRuns()
      .filter(
        (run) =>
          run.origin.kind === 'hook' &&
          (run.operationId === null || !admittingIds.has(run.operationId)),
      )
      .map((run) => ({
        operationId: run.operationId,
        scope: run.scope,
        hookKey: run.origin.sourceId,
        started: run.started,
      }));
    return [...admitting, ...engineRuns];
  }

  /**
   * Cancel the hook runs a host selects. A firing still being admitted
   * never starts; a queued or running run is cancelled through its
   * operation, where any client sees it.
   */
  async cancelWhere(
    select: (run: LiveHookRun) => boolean,
    request: OperationCancelRequest,
  ): Promise<void> {
    for (const firing of this.pending) {
      if (select(firing)) firing.controller.abort();
    }
    await this.engine.cancelWhere(
      (run) =>
        run.origin.kind === 'hook' &&
        select({
          operationId: run.operationId,
          scope: run.scope,
          hookKey: run.origin.sourceId,
          started: run.started,
        }),
      request,
    );
  }

  /**
   * Decide a firing's gates and hand it to the engine once the target's
   * earlier firings are there, so submission keeps the order firings were
   * made in.
   */
  private async admit<T>(
    request: HookFireRequest<T>,
    placement: {
      scope: CanopyWorkspaceScope;
      targetKey: string;
      pending: PendingFiring;
      slot: AdmissionSlot;
    },
  ): Promise<HookFireResult<T>> {
    const { workspaceId, worktreeId, hook } = request;
    const { pending, slot } = placement;
    // Hands the firing to the engine in its turn.
    const enter = (
      submit: () => Promise<HookFireResult<T>>,
    ): Promise<HookFireResult<T>> =>
      new Promise<HookFireResult<T>>((resolve, reject) => {
        this.awaitAdmissionTurn(placement.targetKey, slot, () => {
          this.pending.delete(pending);
          try {
            if (
              pending.controller.signal.aborted &&
              request.acceptedOperationId === undefined
            )
              resolve({ disposition: 'cancelled', operationId: null });
            else submit().then(resolve, reject);
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            this.releaseAdmissionSlot(placement.targetKey, slot);
          }
        });
      });
    const abandoned = (): boolean =>
      pending.controller.signal.aborted &&
      request.acceptedOperationId === undefined;
    // The owner is read when the hook fires, alongside its pause.
    const owner = this.host.projectOwner(workspaceId, worktreeId);
    owner.catch((): void => undefined);
    try {
      const paused =
        request.pause === 'enforce'
          ? await this.readPaused(workspaceId, worktreeId)
          : null;
      const early = this.configurationFreeGates(
        workspaceId,
        worktreeId,
        hook.hookKey,
        paused,
      );
      const earlyVerdicts = early.map((gate) =>
        fixedGate(gate.gate, gate.check()),
      );
      const earlyStop = earlyVerdicts.findIndex(
        (gate) => gate.check().decision !== 'passed',
      );
      if (earlyStop >= 0) {
        const projectOwner = await owner;
        return await enter(() =>
          this.submit(request, placement, {
            projectOwner,
            gates: earlyVerdicts.slice(0, earlyStop + 1),
            execute: NEVER_RUNS,
          }),
        );
      }
      const prepared = abandoned() ? null : await request.prepare();
      if (prepared?.kind === 'unconfigured') {
        const value = prepared.value;
        return await enter(() =>
          Promise.resolve({ disposition: 'unconfigured' as const, value }),
        );
      }
      const projectOwner = await owner;
      if (prepared === null)
        return await enter(() =>
          Promise.resolve({
            disposition: 'cancelled' as const,
            operationId: null,
          }),
        );
      if (prepared.kind === 'refused') {
        const refusal: InitiatedWorkGateVerdict = {
          decision: 'refused',
          failure: prepared.failure,
          cause: prepared.cause,
        };
        return await enter(() =>
          this.submit(request, placement, {
            projectOwner,
            gates: [...early, fixedGate(prepared.gate, refusal)],
            execute: NEVER_RUNS,
          }),
        );
      }
      return await enter(() =>
        this.submit(request, placement, {
          projectOwner,
          ...(prepared.pullRequest
            ? { pullRequest: prepared.pullRequest }
            : {}),
          gates: [
            ...early,
            ...this.configuredGates(
              workspaceId,
              worktreeId,
              prepared.actions,
              projectOwner,
            ),
          ],
          ...(prepared.client ? { client: prepared.client } : {}),
          ...(prepared.onQueued ? { onQueued: prepared.onQueued } : {}),
          execute: prepared.execute,
        }),
      );
    } catch (error) {
      if (slot.ready === null) {
        // The firing never reached its turn; later firings go on without it.
        this.pending.delete(pending);
        this.releaseAdmissionSlot(placement.targetKey, slot);
      }
      throw error;
    }
  }

  private takeAdmissionSlot(targetKey: string): AdmissionSlot {
    const slot: AdmissionSlot = { ready: null, turn: false };
    const slots = this.admissions.get(targetKey) ?? [];
    slots.push(slot);
    this.admissions.set(targetKey, slots);
    return slot;
  }

  /** Calls `ready` once the place reaches the head of its target. */
  private awaitAdmissionTurn(
    targetKey: string,
    slot: AdmissionSlot,
    ready: () => void,
  ): void {
    slot.ready = ready;
    this.drainAdmissions(targetKey);
  }

  private releaseAdmissionSlot(targetKey: string, slot: AdmissionSlot): void {
    const slots = this.admissions.get(targetKey);
    if (!slots) return;
    const index = slots.indexOf(slot);
    if (index >= 0) slots.splice(index, 1);
    if (slots.length === 0) this.admissions.delete(targetKey);
    else this.drainAdmissions(targetKey);
  }

  private drainAdmissions(targetKey: string): void {
    const head = this.admissions.get(targetKey)?.[0];
    if (!head || head.turn || !head.ready) return;
    head.turn = true;
    head.ready();
  }

  private submit<T>(
    request: HookFireRequest<T>,
    placement: { scope: CanopyWorkspaceScope; targetKey: string },
    run: {
      projectOwner: HookProjectOwner;
      pullRequest?: { repository: string; number: number };
    } & Pick<
      InitiatedWorkRequest<T>,
      'gates' | 'client' | 'onQueued' | 'execute'
    >,
  ): Promise<InitiatedWorkSubmission<T>> {
    const engineRequest: InitiatedWorkRequest<T> = {
      origin: this.origin({
        hook: request.hook,
        invocation: request.invocation,
        pause: request.pause,
        projectOwner: run.projectOwner,
        ...(request.occurrenceKey !== undefined
          ? { occurrenceKey: request.occurrenceKey }
          : {}),
        ...(run.pullRequest ? { pullRequest: run.pullRequest } : {}),
      }),
      owner: this.operationOwner(run.projectOwner),
      scope: placement.scope,
      targetKey: placement.targetKey,
      gates: run.gates,
      ...(run.client ? { client: run.client } : {}),
      ...(run.onQueued ? { onQueued: run.onQueued } : {}),
      execute: run.execute,
    };
    return request.acceptedOperationId !== undefined
      ? this.engine.runAccepted(request.acceptedOperationId, engineRequest)
      : this.engine.submit(engineRequest);
  }

  /** Fails closed: a pause state that can't be read is `unknown`. */
  private async readPaused(
    workspaceId: string,
    worktreeId: string,
  ): Promise<HookPauseState> {
    try {
      return await this.host.pausedHookKeys(workspaceId, worktreeId);
    } catch {
      return 'unknown';
    }
  }

  private pauseVerdict(
    paused: HookPauseState | null,
    hookKey: string,
  ): InitiatedWorkGateVerdict {
    if (paused === 'unknown')
      return {
        decision: 'skipped',
        message: HOOK_PAUSE_UNKNOWN_MESSAGE,
        code: HOOK_PAUSE_UNKNOWN_CODE,
      };
    return paused?.has(hookKey) === true
      ? { decision: 'skipped', message: HOOK_PAUSED_MESSAGE }
      : { decision: 'passed' };
  }

  /**
   * Pause and split lock, which need nothing from the hook's configuration.
   * `paused` is null when the request bypasses the pause.
   */
  private configurationFreeGates(
    workspaceId: string,
    worktreeId: string,
    hookKey: string,
    paused: HookPauseState | null,
  ): InitiatedWorkGateCheck[] {
    return [
      ...(paused !== null
        ? [fixedGate('pause', this.pauseVerdict(paused, hookKey))]
        : []),
      {
        gate: 'splitLock',
        check: (): InitiatedWorkGateVerdict => {
          try {
            this.host.assertNotSplitLocked(workspaceId, worktreeId);
            return { decision: 'passed' };
          } catch (error) {
            return hostRefusal(
              'splitLock',
              'failed_precondition',
              error,
              'This worktree is locked while a Split PR is in progress.',
            );
          }
        },
      },
    ];
  }

  /**
   * The deletion fence, then the owner gates: an organization execution
   * context runs only for a project that organization owns. The owner gate
   * refuses when that owner cannot be read; the execution-context gate
   * refuses another organization's context.
   */
  private configuredGates(
    workspaceId: string,
    worktreeId: string,
    actions: readonly HookActionRef[],
    owner: HookProjectOwner,
  ): InitiatedWorkGateCheck[] {
    const gates: InitiatedWorkGateCheck[] = [
      {
        gate: 'deletionFence',
        check: (): InitiatedWorkGateVerdict => {
          try {
            this.host.assertStartAllowed(workspaceId, worktreeId);
            return { decision: 'passed' };
          } catch (error) {
            return hostRefusal(
              'deletionFence',
              'failed_precondition',
              error,
              'This worktree is being removed.',
            );
          }
        },
      },
    ];
    const organizations = actions.flatMap((action) =>
      action.type !== 'command' &&
      action.executionContext?.startsWith('org:') === true
        ? [action.executionContext.slice('org:'.length)]
        : [],
    );
    if (organizations.length === 0) return gates;
    const refuse = (message: string): InitiatedWorkGateVerdict =>
      hostRefusal('owner', 'permission_denied', new Error(message), message);
    if (owner.kind === 'unknown')
      return [
        ...gates,
        fixedGate(
          'owner',
          refuse(
            "This project's owner could not be read, so its organization hook actions can't run.",
          ),
        ),
      ];
    const mismatched = organizations.some(
      (organizationId) =>
        owner.kind !== 'organization' ||
        owner.organizationId.toLowerCase() !== organizationId.toLowerCase(),
    );
    return [
      ...gates,
      fixedGate('owner', { decision: 'passed' }),
      fixedGate(
        'executionContext',
        mismatched
          ? refuse(
              "This hook runs in an organization that doesn't own this project.",
            )
          : { decision: 'passed' },
      ),
    ];
  }

  private origin(args: {
    hook: HookRef;
    invocation: InitiatedWorkHookOriginContext['invocation'];
    pause: HookPausePolicy;
    projectOwner: HookProjectOwner;
    occurrenceKey?: string;
    pullRequest?: { repository: string; number: number };
  }): OperationOrigin {
    const context: InitiatedWorkHookOriginContext = {
      triggerName: args.hook.triggerName,
      target: args.hook.target,
      ...(args.hook.repoId !== undefined ? { repoId: args.hook.repoId } : {}),
      invocation: args.invocation,
      pause: args.pause,
      projectOwner: args.projectOwner,
      ...(args.pullRequest ? { pullRequest: args.pullRequest } : {}),
    };
    return {
      kind: 'hook',
      sourceId: args.hook.hookKey,
      ...(args.occurrenceKey !== undefined
        ? { occurrenceKey: args.occurrenceKey }
        : {}),
      context,
    };
  }

  private operationOwner(owner: HookProjectOwner): OperationOwner {
    return owner.kind === 'organization'
      ? { kind: 'organization', id: owner.organizationId }
      : { kind: 'system', id: this.host.localAuthorityId };
  }
}
