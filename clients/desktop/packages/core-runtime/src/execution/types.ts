import type { WakeLockHolderKind } from '../power/wake-lock-policy';

/** Work whose admission and lifetime core execution accounting owns. */
export type ExecutionFamily = 'pipeline' | 'script' | 'terminal' | 'codeGraph';

export const EXECUTION_FAMILIES: readonly ExecutionFamily[] = [
  'pipeline',
  'script',
  'terminal',
  'codeGraph',
];

export interface ExecutionFamilyPolicy {
  /** Critical memory pressure refuses new work while the guard is on. */
  readonly memoryGuarded: boolean;
  /** The wake-lock holder its running work takes, if any. */
  readonly keepAwake: WakeLockHolderKind | null;
}

export const EXECUTION_FAMILY_POLICIES: Readonly<
  Record<ExecutionFamily, ExecutionFamilyPolicy>
> = {
  pipeline: { memoryGuarded: true, keepAwake: 'pipeline' },
  script: { memoryGuarded: false, keepAwake: null },
  terminal: { memoryGuarded: false, keepAwake: null },
  codeGraph: { memoryGuarded: false, keepAwake: null },
};

export type ExecutionResourceGroupId =
  | 'app'
  | 'browser'
  | 'codex'
  | 'claude'
  | 'chat'
  | 'pipelines'
  | 'terminal'
  | 'scripts'
  | 'other';

export type ExecutionResourceKind =
  | 'electron-main'
  | 'electron-renderer'
  | 'electron-utility'
  | 'electron-gpu'
  | 'in-app-browser'
  | 'codex-app-server-pool'
  | 'pipeline-execution'
  | 'pipeline-step'
  | 'chat-provider'
  | 'terminal'
  | 'script'
  | 'hook'
  | 'other';

export type ExecutionPressureLevel = 'unknown' | 'ok' | 'warning' | 'critical';

/** Metadata core attaches to processes it finds; hosts add their own kinds. */
export interface GenericResourceMetadata {
  type: 'generic';
}

export interface ExecutionResourceItem<TMetadata extends { type: string }> {
  id: string;
  kind: ExecutionResourceKind;
  groupId: ExecutionResourceGroupId;
  label: string;
  pid?: number;
  ppid?: number;
  processGroupId?: number;
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
  startedAt?: string;
  status: 'running' | 'idle' | 'exited' | 'unknown';
  metadata?: TMetadata | GenericResourceMetadata;
  children?: ExecutionResourceItem<TMetadata>[];
}

export interface ExecutionResourceGroup<TMetadata extends { type: string }> {
  id: ExecutionResourceGroupId;
  label: string;
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
  items: ExecutionResourceItem<TMetadata>[];
}

export interface ExecutionPressure {
  level: ExecutionPressureLevel;
  reasons: string[];
  warningMemoryBytes: number;
  criticalMemoryBytes: number;
}

/** A process or unit of work shown in the accounting snapshot. */
export interface ExecutionRegistration<TMetadata extends { type: string }> {
  id: string;
  groupId: ExecutionResourceGroupId;
  kind: ExecutionResourceKind;
  label: string;
  pid?: number;
  processGroupId?: number;
  startedAt?: string;
  metadata?: TMetadata | GenericResourceMetadata;
}

export interface ExecutionRegistrationHandle<
  TMetadata extends { type: string },
> {
  update(update: Partial<ExecutionRegistration<TMetadata>>): void;
  unregister(): void;
}

export interface ExecutionFamilyStatus {
  /** Work holding a lease: accepted and not yet settled. */
  active: number;
  /** Admitted starts that have not handed over to a lease yet. */
  pending: number;
  maxActive: number | null;
  /** A new start would be refused now. */
  blocked: boolean;
}

export interface ExecutionAccountingSnapshot<
  TMetadata extends { type: string },
> {
  sampledAt: string;
  rootPid: number;
  cpuPercent: number;
  memoryRssBytes: number;
  processCount: number;
  pressure: ExecutionPressure;
  groups: ExecutionResourceGroup<TMetadata>[];
  families: Record<ExecutionFamily, ExecutionFamilyStatus>;
  /** Critical memory refuses memory-guarded families. */
  memoryGuardBlocked: boolean;
  error?: string;
}

/**
 * What memory-guarded work may still take before critical pressure refuses
 * it (CAN-6325), from one sample.
 */
export interface ExecutionMemoryHeadroom {
  /** The critical threshold less the memory the guard counts; 0 or less is tight. */
  readonly availableBytes: number;
  /** The critical threshold. */
  readonly totalBytes: number;
  /** The sample's time, in epoch milliseconds. */
  readonly sampledAt: number;
}

/** Limits the host reads from its preferences at each decision. */
export interface ExecutionAccountingLimits {
  readonly maxActive: Readonly<Partial<Record<ExecutionFamily, number | null>>>;
  readonly memoryGuardEnabled: boolean;
  readonly warningMemoryBytes: number;
  readonly criticalMemoryBytes: number;
  /** Chat-turn cap (CAN-4115); null or absent means no cap. */
  readonly maxActiveChatTurns?: number | null;
}

/** Held admission for one start; release it once the work holds a lease. */
export interface ExecutionReservation {
  release(): void;
}

/** Accepted work; released after success, failure, crash or cancel. */
export interface ExecutionLease {
  readonly family: ExecutionFamily;
  readonly id: string;
  release(): void;
  /** Releases once `settled` resolves or rejects. */
  releaseWhenSettled(settled: PromiseLike<unknown>): void;
}

/** The wake-lock holder port: `WakeLockPolicy`, or a host composition of it. */
export interface ExecutionWakeLock {
  acquire(key: string, reason: string): void;
  release(key: string): void;
}

export type ExecutionAdmissionRefusal = 'limit' | 'memory';

export class ExecutionAdmissionError extends Error {
  readonly code = 'resource-guard-blocked';
  readonly family: ExecutionFamily;
  readonly reason: ExecutionAdmissionRefusal;
  readonly maxActive: number | null;

  constructor(
    family: ExecutionFamily,
    reason: ExecutionAdmissionRefusal,
    maxActive: number | null,
  ) {
    super(
      reason === 'limit'
        ? `Already running ${String(maxActive)} ${family} executions.`
        : `Memory pressure is critical; ${family} work is refused.`,
    );
    this.name = 'ExecutionAdmissionError';
    this.family = family;
    this.reason = reason;
    this.maxActive = maxActive;
  }
}

export type ChatTurnAdmissionRefusal = 'limit' | 'memory';

/** Chat-turn admission refused at the cap or under critical memory (CAN-4115). */
export class ChatTurnAdmissionError extends Error {
  readonly code = 'resource-guard-blocked';
  readonly reason: ChatTurnAdmissionRefusal;
  readonly maxActive: number | null;

  constructor(reason: ChatTurnAdmissionRefusal, maxActive: number | null) {
    super(
      reason === 'limit'
        ? `Already running ${String(maxActive)} chat turns.`
        : 'Memory pressure refuses another chat turn.',
    );
    this.name = 'ChatTurnAdmissionError';
    this.reason = reason;
    this.maxActive = maxActive;
  }
}
