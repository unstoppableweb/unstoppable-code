import type {
  AgentAuditEntry,
  AgentAuditStatus,
  AgentProviderType,
} from '@canopy/desktop-shared/types';
import type {
  CostAttributedItem,
  CostBillingBasis,
  CostContextView,
  CostHelperKind,
  CostModelRow,
  CostPipelineRunRow,
  CostProxyAccountRow,
  CostScopeRef,
  CostSourceBreakdown,
  CostStatus,
  CostTokenTotals,
  CostTotals,
  PipelineRunCostView,
  SessionBreakdownView,
} from '@canopy/protocol/cost-view';

/** Content-free, last-line-wins audit projection. Never persist the audit itself. */
export interface CostTurnRecord {
  readonly entryId: string;
  readonly day: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly status: AgentAuditStatus;
  readonly source: 'chat' | 'pipeline' | 'background' | 'delegation';
  readonly chatId?: string;
  readonly helperKind?: CostHelperKind;
  readonly pipeline?: {
    readonly rootExecutionId: string;
    readonly executionId: string;
    readonly pipelineName?: string;
    readonly jobId?: string;
    readonly stepId?: string;
    readonly attempt?: number;
  };
  readonly provider: AgentProviderType;
  readonly model?: string;
  readonly agentId?: string;
  readonly harness?: string;
  readonly billingBasis: CostBillingBasis;
  readonly tokens: CostTokenTotals;
  readonly costUsd?: number;
  readonly costStatus: CostStatus;
  readonly durationMs?: number;
  readonly toolCounts?: AgentAuditEntry['toolCounts'];
  readonly subagentCount?: number;
  readonly toolUseCount?: number;
  readonly subagents?: readonly CostAttributedItem[];
  readonly delegation?: CostAttributedItem;
  readonly context?: AgentAuditEntry['context'];
  readonly compactions?: AgentAuditEntry['compactions'];
  readonly planEvents?: AgentAuditEntry['planEvents'];
  /**
   * The account-proxy accounts that served the entry (CAN-4021), without
   * their labels.
   */
  readonly accountProxy?: {
    readonly connectionId: string;
    readonly accounts: readonly {
      readonly authIndex: string;
      readonly provider?: string;
      readonly requests: number;
    }[];
  };
}

/** Exact turn points survive compaction so percentile calculations never drift. */
export interface CostTurnPoint {
  readonly startedAt: string;
  readonly durationMs?: number;
  readonly context?: {
    readonly endTokens: number;
    readonly windowTokens: number;
    readonly peakTokens?: number;
  };
  readonly compaction?: 'auto' | 'manual' | 'unknown';
}

/** Chat aggregate without canonical chat labels or live state. */
export interface CostChatAggregate {
  readonly totals: CostTotals;
  readonly turnCount: number;
  readonly firstActivityAt?: string;
  readonly lastActivityAt?: string;
  readonly hasCodexEstimate: boolean;
  readonly bySource: CostSourceBreakdown;
  readonly chatTurnsByModel: readonly CostModelRow[];
  readonly byModel: readonly CostModelRow[];
  /** Absent in aggregates sealed before the account proxy was shown. */
  readonly byProxyAccount?: readonly CostProxyAccountRow[];
  readonly context: CostContextView;
  /** Categories may precede the latest fill (providers need not report both). */
  readonly contextCategoriesAt?: string;
  readonly compactions: SessionBreakdownView['compactions'];
  readonly activity: SessionBreakdownView['activity'];
  readonly points: readonly CostTurnPoint[];
}

export interface CostChatFile {
  readonly version: 1;
  readonly chatId: string;
  readonly records: Readonly<Record<string, CostTurnRecord>>;
  readonly sealed?: CostChatAggregate;
  /** Compact replay tombstones survive checkpoint crashes and archive/restore. */
  readonly sealedEntryIds?: readonly string[];
}

/** Pipeline/unattached records share one small file; chat reads need no scan. */
export interface CostUnattachedFile {
  readonly version: 1;
  readonly records: Readonly<Record<string, CostTurnRecord>>;
  readonly sealedUnattached?: CostChatAggregate;
  readonly sealedRuns?: Readonly<Record<string, PipelineRunCostView>>;
  /** The latest activity among the pipeline records folded into `sealedRuns`. */
  readonly sealedRunsLastActivityAt?: string;
  readonly sealedEntryIds?: readonly string[];
}

export interface CostSummaryChat {
  readonly chatId: string;
  readonly totals: CostTotals;
  readonly turnCount: number;
  readonly firstActivityAt?: string;
  readonly lastActivityAt: string;
  readonly models: readonly string[];
  readonly running: boolean;
  readonly hasCodexEstimate: boolean;
  readonly proxyAccounts?: readonly CostProxyAccountRow[];
}

export interface CostSummaryFile {
  readonly version: 1;
  readonly projectId: string;
  readonly scopeId: string;
  readonly incarnation: string;
  readonly updatedAt: string | null;
  readonly sealedAt?: string;
  readonly coverageStart?: string;
  readonly retentionDays: number;
  readonly revision: number;
  readonly totals: CostTotals;
  readonly chats: readonly CostSummaryChat[];
  readonly pipelineRuns: readonly CostPipelineRunRow[];
  readonly unattached?: CostTotals;
  readonly hasCodexEstimate: boolean;
}

export type CostInternalTrigger =
  | 'startup'
  | 'idle'
  | 'open'
  | 'manual'
  | 'turn'
  | 'archive';

export interface CostIndexCheckpoint {
  readonly version: 1;
  readonly generation: number;
  readonly firstBuild: { readonly at: string; readonly coverageStart: string };
  readonly retainedFillComplete?: boolean;
  readonly audit: Readonly<
    Record<
      string,
      {
        readonly offset: number;
        readonly size: number;
        readonly mtimeMs: number;
        readonly ino?: number;
      }
    >
  >;
  readonly lastRefresh?: {
    readonly trigger: CostInternalTrigger;
    readonly startedAt: string;
    readonly completedAt: string;
    readonly linesRead: number;
    readonly durationMs: number;
  };
}

/** Trusted local facts only. Host paths never cross a protocol operation. */
export interface CostScopeLocation {
  readonly scope: CostScopeRef;
  readonly directory: string;
  readonly incarnation: string;
  readonly createdAt: string;
}

export interface CostChatIdentity {
  readonly chatId: string;
  readonly label: string;
  readonly state: 'open' | 'archived';
  readonly createdAt?: string;
  readonly running?: boolean;
}

export interface CostIndexHost {
  readonly auditDirectory: () => string;
  readonly checkpointPath: () => string;
  readonly resolveScope: (
    scope: CostScopeRef,
  ) => Promise<CostScopeLocation | null>;
  readonly listRetainedScopes: () => Promise<readonly CostScopeLocation[]>;
  readonly withRetainedLock: <T>(
    scope: CostScopeRef,
    action: () => Promise<T>,
  ) => Promise<T>;
  readonly readChats: (
    scope: CostScopeRef,
  ) => Promise<readonly CostChatIdentity[]>;
  readonly readPipelineRun: (
    scope: CostScopeRef,
    executionId: string,
  ) => Promise<{
    readonly nonAgentStepCount?: number;
    readonly status?: CostPipelineRunRow['status'];
    readonly pipelineName?: string;
    /**
     * Step names from the run's definitions, keyed `executionId/jobId/stepId`.
     * Read when a view is projected, never stored.
     */
    readonly stepNames?: Readonly<Record<string, string>>;
  } | null>;
  /**
   * The root status and name of each pipeline run in a live scope, by
   * execution id. Read when a scope is projected, never stored, so the list
   * agrees with the run's own view.
   */
  readonly readPipelineRunStates?: (scope: CostScopeRef) => Promise<
    ReadonlyMap<
      string,
      {
        readonly status: CostPipelineRunRow['status'];
        readonly pipelineName?: string;
      }
    >
  >;
  /**
   * Account-proxy account labels by `proxy:<connectionId>:<auth_index>`, read
   * only when a view names an account. Never stored.
   */
  readonly readProxyAccountLabels?: () => Promise<ReadonlyMap<string, string>>;
  readonly retentionDays: () => number | Promise<number>;
  readonly flush: () => Promise<void>;
  readonly now?: () => Date;
  readonly yield?: () => Promise<void>;
  readonly onSlice?: (durationMs: number, bytes: number) => void;
}
