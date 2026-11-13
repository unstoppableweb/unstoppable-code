import type { NormalizedStep } from '../../../types/pipeline';
import { isPipelineHostActionId } from '../../../pipelines/host-actions';
import type { ExecutionMemoryReading, ExecutionResourceMonitor } from './types';

/*
 * Memory admission for pipeline steps (CAN-6325, plan CP-64). A run in the
 * cloud has one sandbox, and a desktop run shares the machine, so a step
 * that would start waits while its host's memory is tight instead of
 * starting into an out-of-memory kill. The host reports memory through its
 * resource monitor (`ExecutionResourceMonitor.readMemory`); a host that
 * reports none admits every step, as before.
 *
 * One gate serves every run on a resource monitor, so runs that share a host
 * share its memory. Steps wait in arrival order. A step's estimate counts
 * against the reading until a reading taken after the step had time to grow
 * includes it, so a burst of starts can't all fit into the same free memory.
 * With nothing of the gate's running, a step starts as long as memory is not
 * already into the chat reserve, so one step larger than its estimate never
 * waits forever.
 */

const MIB = 1024 * 1024;

/** What a shell, script or node step is expected to take. */
export const PIPELINE_STEP_MEMORY_ESTIMATE_BYTES = 256 * MIB;
/** What a step that starts an agent harness is expected to take. */
export const PIPELINE_AGENT_STEP_MEMORY_ESTIMATE_BYTES = 1024 * MIB;
/** How long a started step has to grow before a reading counts it. */
export const PIPELINE_CAPACITY_SETTLE_MS = 2_000;
/** How often a held step reads memory again. */
export const PIPELINE_CAPACITY_POLL_MS = 1_000;

/** Actions that start a model harness without declaring the agent log hint. */
const AGENT_STEP_ACTIONS: ReadonlySet<string> = new Set([
  'builtin/agent-prompt',
  'builtin/agent-resume',
  'builtin/agent-loop',
  'builtin/plan-with-review',
  'builtin/quality-gate',
  'builtin/router',
  'builtin/condenser',
  'builtin/parallel-agents',
]);

/** What a step's action manifest says about the work it runs. */
export interface PipelineStepActionFacts {
  readonly runsUsing?: string;
  readonly logFormatHint?: string;
}

/**
 * The memory a step is expected to take, or 0 when it starts no process of
 * its own: a host action answered by the owner, or a child run, whose steps
 * take their own admission. `action` is its resolved manifest, so a wrapper
 * whose manifest declares the agent hint, such as `builtin/coder`, takes the
 * agent estimate; an action that can't be read takes a shell step's.
 */
export function pipelineStepMemoryEstimate(
  step: Pick<NormalizedStep, 'uses' | 'log_format_hint'>,
  action?: PipelineStepActionFacts,
): number {
  const uses = step.uses;
  if (uses === 'builtin/run-pipeline') return 0;
  if (uses?.startsWith('builtin/') && isPipelineHostActionId(uses.slice(8)))
    return 0;
  if (action?.runsUsing === 'host' || action?.runsUsing === 'pipeline')
    return 0;
  if (
    (uses !== undefined && AGENT_STEP_ACTIONS.has(uses)) ||
    step.log_format_hint === 'agent' ||
    action?.logFormatHint === 'agent'
  )
    return PIPELINE_AGENT_STEP_MEMORY_ESTIMATE_BYTES;
  return PIPELINE_STEP_MEMORY_ESTIMATE_BYTES;
}

export interface PipelineCapacityRequest {
  readonly estimateBytes: number;
  /** The run shares its worktree with chats, so it leaves their reserve free. */
  readonly keepChatReserve: boolean;
}

export interface PipelineCapacityGate {
  /**
   * Resolves once the step may start, with the function that marks it done,
   * or with `null` when `signal` aborts first. `onHold` is called once, when
   * the step first has to wait.
   */
  admit(
    signal: AbortSignal,
    request: PipelineCapacityRequest,
    onHold: () => void,
  ): Promise<(() => void) | null>;
}

export interface PipelineCapacityGateOptions {
  readonly now?: () => number;
  readonly pollMs?: number;
  readonly settleMs?: number;
}

interface Waiter {
  readonly request: PipelineCapacityRequest;
  readonly admit: (release: () => void) => void;
  readonly onHold: () => void;
  held: boolean;
}

interface Reservation {
  readonly bytes: number;
  readonly admittedAt: number;
}

export function createPipelineCapacityGate(
  readMemory: () => Promise<ExecutionMemoryReading | undefined>,
  options: PipelineCapacityGateOptions = {},
): PipelineCapacityGate {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? PIPELINE_CAPACITY_POLL_MS;
  const settleMs = options.settleMs ?? PIPELINE_CAPACITY_SETTLE_MS;
  const waiting: Waiter[] = [];
  /** Admitted steps a reading may not count yet. */
  const unmeasured = new Map<symbol, Reservation>();
  let running = 0;
  let pumping = false;
  let pumpAgain = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const read = async (): Promise<ExecutionMemoryReading | undefined> => {
    try {
      return await readMemory();
    } catch {
      // A host that can't measure must not stall its runs.
      return undefined;
    }
  };

  const fits = (
    reading: ExecutionMemoryReading | undefined,
    request: PipelineCapacityRequest,
    pending: number,
  ): boolean => {
    if (reading === undefined) return true;
    const reserve = request.keepChatReserve
      ? (reading.chatReserveBytes ?? 0)
      : 0;
    const free = reading.availableBytes - reserve;
    if (running === 0) return free > 0;
    return free - pending >= request.estimateBytes;
  };

  const start = (waiter: Waiter): void => {
    const token = Symbol('pipeline-step');
    running += 1;
    if (waiter.request.estimateBytes > 0)
      unmeasured.set(token, {
        bytes: waiter.request.estimateBytes,
        admittedAt: now(),
      });
    let released = false;
    waiter.admit(() => {
      if (released) return;
      released = true;
      running -= 1;
      unmeasured.delete(token);
      schedulePump();
    });
  };

  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        if (waiting.length === 0) break;
        const reading = await read();
        if (reading !== undefined)
          for (const [token, reservation] of unmeasured)
            if (reading.sampledAt >= reservation.admittedAt + settleMs)
              unmeasured.delete(token);
        let pending = 0;
        for (const reservation of unmeasured.values())
          pending += reservation.bytes;
        while (waiting.length > 0) {
          const head = waiting[0];
          if (!fits(reading, head.request, pending)) break;
          waiting.shift();
          start(head);
          pending += head.request.estimateBytes;
        }
        for (const waiter of waiting)
          if (!waiter.held) {
            waiter.held = true;
            try {
              waiter.onHold();
            } catch {
              // Showing the hold must not lose the step's place.
            }
          }
      } while (pumpAgain);
    } finally {
      pumping = false;
    }
    // Not unref'd: a held step is work its host still has to run.
    if (waiting.length > 0 && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        void pump();
      }, pollMs);
    }
  };

  const schedulePump = (): void => {
    void pump();
  };

  return {
    admit(signal, request, onHold) {
      if (signal.aborted) return Promise.resolve(null);
      return new Promise((resolve) => {
        const waiter: Waiter = {
          request,
          held: false,
          onHold,
          admit: (release) => {
            signal.removeEventListener('abort', onAbort);
            resolve(release);
          },
        };
        const onAbort = (): void => {
          const index = waiting.indexOf(waiter);
          if (index < 0) return;
          waiting.splice(index, 1);
          resolve(null);
          schedulePump();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiting.push(waiter);
        schedulePump();
      });
    },
  };
}

const gates = new WeakMap<ExecutionResourceMonitor, PipelineCapacityGate>();

/**
 * The gate every run on `monitor` shares, or undefined when its host reports
 * no memory and steps start as they always have.
 */
export function pipelineCapacityGateFor(
  monitor: ExecutionResourceMonitor | undefined,
): PipelineCapacityGate | undefined {
  if (!monitor?.readMemory) return undefined;
  let gate = gates.get(monitor);
  if (!gate) {
    gate = createPipelineCapacityGate(() =>
      monitor.readMemory ? monitor.readMemory() : Promise.resolve(undefined),
    );
    gates.set(monitor, gate);
  }
  return gate;
}
