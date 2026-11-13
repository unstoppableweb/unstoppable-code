import type {
  AgentDelegationPhase,
  AgentDelegationResult,
  AgentDelegationSnapshot,
  AgentDelegationSpawnRequest,
  AgentDelegationTranscript,
} from '@canopy/protocol/delegation';
import type { ThinkingLevel } from '@canopy/protocol/thinking';

/** Content-free local metrics. Follow-through means root output after a native receipt, not semantic correctness. */
export interface DelegationMetric {
  event:
    | 'invocation'
    | 'terminal'
    | 'delivery_acknowledged'
    | 'parent_follow_through'
    | 'queued'
    | 'admitted'
    | 'queue_withdrawn';
  status?: string;
  errorCode?: string;
  targetHarnessId?: string;
  runtimeKind?: string;
  requestedThinkingLevel?: ThinkingLevel;
  effectiveThinkingLevel?: ThinkingLevel;
  executionMode?: 'foreground' | 'background';
  durationMs?: number;
  /** Time a run spent waiting for a slot before admission; on `admitted`. */
  queueWaitMs?: number;
  /** Live 1-based queue position; on `queued`, when known at invocation time. */
  position?: number;
  /** What a queued run was waiting for; on `queued`, when known. */
  waitingFor?: 'queue' | 'app';
  /** Why a queued run left the queue without running; on `queue_withdrawn`. */
  reason?: string;
  /** Whether a spawn started queued or was granted immediately; on `invocation`. */
  admission?: 'queued' | 'granted';
}
export class DelegationMetrics {
  private readonly runs = new Map<
    string,
    {
      startedAt: number;
      terminal: boolean;
      acknowledged: boolean;
      followed: boolean;
      receiptTurn?: string;
      phase?: AgentDelegationPhase;
      queuedAt?: number;
      runningAt?: number;
    }
  >();
  private readonly calls = new Set<string>();
  /**
   * Live position/waitingFor observed at spawn time (from the invocation's
   * live queue state), consumed by the first transcript sighting of that same
   * delegation's first generation. Bounded like the other observation windows.
   */
  private readonly queueHints = new Map<
    string,
    { position?: number; waitingFor?: 'queue' | 'app' }
  >();
  constructor(
    private readonly emit: (metric: DelegationMetric) => void,
    private readonly now = Date.now,
  ) {}
  invocation(
    key: string,
    task: AgentDelegationSpawnRequest,
    result: AgentDelegationResult<AgentDelegationSnapshot>,
  ): void {
    if (this.calls.has(key)) return;
    this.calls.add(key);
    if (this.calls.size > 256) {
      const oldest = this.calls.values().next().value;
      if (oldest) this.calls.delete(oldest);
    }
    const route = result.ok ? result.value.routeSnapshot : undefined;
    const phase = result.ok ? result.value.phase : undefined;
    if (result.ok && phase === 'queued') {
      const queueKey = `${result.value.delegationId}:${result.value.runGeneration}`;
      const queue = result.value.queue;
      this.queueHints.set(queueKey, {
        ...(queue?.position !== undefined ? { position: queue.position } : {}),
        ...(queue?.waitingFor !== undefined
          ? { waitingFor: queue.waitingFor }
          : {}),
      });
      if (this.queueHints.size > 256) {
        const oldest = this.queueHints.keys().next().value;
        if (oldest) this.queueHints.delete(oldest);
      }
    }
    this.emit({
      event: 'invocation',
      status: result.ok ? 'accepted' : 'rejected',
      ...(!result.ok ? { errorCode: result.error.code } : {}),
      executionMode: task.executionMode,
      requestedThinkingLevel: task.thinkingLevel,
      effectiveThinkingLevel: route?.effectiveThinkingLevel,
      targetHarnessId: route?.harnessId,
      runtimeKind: route?.runtimeKind,
      ...(result.ok
        ? { admission: phase === 'queued' ? 'queued' : 'granted' }
        : {}),
    });
  }
  transcript(transcript: AgentDelegationTranscript): void {
    const { snapshot } = transcript;
    const key = `${snapshot.delegationId}:${transcript.runGeneration}`;
    let run = this.runs.get(key);
    // Cold history is not a fresh invocation or a fresh metric.
    if (!run && snapshot.status !== 'pending') return;
    if (!run) {
      run = {
        startedAt: this.now(),
        terminal: false,
        acknowledged: false,
        followed: false,
      };
      this.runs.set(key, run);
    }
    if (run.terminal) return;
    const phase = snapshot.phase;
    const previousPhase = run.phase;
    run.phase = phase;
    if (phase === 'running' && run.runningAt === undefined)
      run.runningAt = this.now();
    if (phase === 'queued' && previousPhase === undefined) {
      run.queuedAt = this.now();
      const hint = this.queueHints.get(key);
      this.queueHints.delete(key);
      this.emit({
        event: 'queued',
        ...(hint?.position !== undefined ? { position: hint.position } : {}),
        ...(hint?.waitingFor !== undefined
          ? { waitingFor: hint.waitingFor }
          : {}),
      });
    } else if (
      previousPhase === 'queued' &&
      (phase === 'starting' || phase === 'running')
    ) {
      this.emit({
        event: 'admitted',
        queueWaitMs: Math.max(0, this.now() - (run.queuedAt ?? this.now())),
      });
    } else if (previousPhase === 'queued' && phase === 'idle') {
      this.emit({
        event: 'queue_withdrawn',
        reason: snapshot.stopReason ?? snapshot.status,
      });
    }
    if (['pending', 'running', 'interrupted'].includes(snapshot.status)) return;
    run.terminal = true;
    this.emit({
      event: 'terminal',
      status: snapshot.status,
      errorCode: snapshot.error?.code,
      // Queue wait is excluded from run time when the run was ever observed
      // running; a run that never started falls back to its first sighting.
      durationMs: Math.max(0, this.now() - (run.runningAt ?? run.startedAt)),
      targetHarnessId: snapshot.routeSnapshot?.harnessId,
      runtimeKind: snapshot.routeSnapshot?.runtimeKind,
      requestedThinkingLevel: snapshot.routeSnapshot?.requestedThinkingLevel,
      effectiveThinkingLevel: snapshot.routeSnapshot?.effectiveThinkingLevel,
    });
    // Retain a bounded observation window, never unbounded chat history.
    if (this.runs.size > 256) {
      const oldest = Array.from(this.runs).find(
        ([id, state]) => id !== key && state.terminal,
      );
      if (oldest) this.runs.delete(oldest[0]);
    }
  }
  acknowledged(id: string, turn?: string, generation = 1): void {
    const run = this.runs.get(`${id}:${generation}`);
    if (!run || run.acknowledged) return;
    run.acknowledged = true;
    run.receiptTurn = turn;
    this.emit({ event: 'delivery_acknowledged' });
  }
  rootOutput(turn?: string): void {
    for (const run of Array.from(this.runs.values()))
      if (run.acknowledged && !run.followed && run.receiptTurn === turn) {
        run.followed = true;
        this.emit({
          event: 'parent_follow_through',
          durationMs: Math.max(0, this.now() - run.startedAt),
        });
      }
  }
}
