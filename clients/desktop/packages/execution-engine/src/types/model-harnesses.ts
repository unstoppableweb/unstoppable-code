import type {
  AiGatewayHarness,
  AiGatewayModelFamily,
} from '@canopy/protocol/ai-gateway-models';
import type { CodexConfig } from '../lib/codex-model-config';

/** Execution harness selected for a model. Source and harness are independent. */
export type ModelHarness =
  | AiGatewayHarness
  | 'cursor'
  | 'copilot'
  | 'opencode'
  | 'antigravity';

export type ModelHarnessSource =
  | 'claude-managed'
  | 'codex-managed'
  | 'cursor-managed'
  | 'copilot-managed'
  | 'antigravity-managed'
  | 'opencode-managed'
  | 'ai-gateway'
  | 'ollama';

/** One authoritative model-to-harness assignment projected by the host. */
export interface ModelHarnessAssignment {
  modelId: string;
  source: ModelHarnessSource;
  harness: ModelHarness;
  defaultHarness: ModelHarness;
  configurable: boolean;
  overridden: boolean;
  /** Supported destinations; absent in older host snapshots. */
  availableHarnesses?: ModelHarness[];
  /** Per-chat choices; native defaults remain tied to their native identities. */
  chatHarnesses?: ModelHarness[];
}

/** Complete authoritative assignment state returned by assignment IPC. */
export interface ModelHarnessAssignmentSnapshot {
  revision: number;
  assignments: ModelHarnessAssignment[];
}

/** Versioned, brand-scoped `model-harness-overrides.json` wire schema. */
export interface ModelHarnessOverridesFile {
  version: 1;
  overrides: Record<string, ModelHarness>;
}

/** Minimal catalog projection consumed by the pure assignment policy. */
export interface ModelHarnessCatalog {
  claudeModels: readonly string[];
  codexModels: readonly string[];
  cursorModels?: readonly string[];
  copilotModels?: readonly string[];
  antigravityModels?: readonly string[];
  opencodeModels?: readonly string[];
  /** Exact eligible gateway IDs projected only by a connected desktop host. */
  openCodeGatewayModels?: readonly string[];
  /** Canonical native model -> exact, advertised Cursor runtime identity. */
  cursorModelMappings?: Readonly<Record<string, string>>;
  aiGatewayModels: ReadonlyArray<{
    id: string;
    recommendedHarness: ModelHarness;
  }>;
  ollamaModels: readonly string[];
  modelAliases?: Readonly<Record<string, string>>;
  agentBaseModels?: Readonly<Record<string, string>>;
}

export interface BuildModelHarnessAssignmentsInput {
  catalog: ModelHarnessCatalog;
  overrides?: Readonly<Record<string, ModelHarness>>;
  revision?: number;
}

/** Versioned model catalog sent to builtin-action subprocesses. */
export interface BuiltinModelCatalogPayload {
  version: 1;
  claudeModels: string[];
  codexModels: string[];
  ollamaModels: string[];
  aiGatewayModels: string[];
  gatewayRoutes: Array<{
    modelId: string;
    gatewayId: string;
    family: AiGatewayModelFamily;
    recommendedHarness: ModelHarness;
    gatewayOnly: boolean;
    contextWindow?: number;
    supportsPromptCaching?: boolean;
    supportedThinkingLevels?: string[];
    toolSchemaProfile?: 'standard' | 'flat';
  }>;
  modelAliases: Record<string, string>;
}

export interface SetModelHarnessAssignmentInput {
  modelId: string;
  harness: ModelHarness;
}

export interface ResetModelHarnessAssignmentInput {
  modelId: string;
}

/** Provider-neutral, per-invocation resolution passed across runtimes. */
export interface ModelHarnessInvocation {
  source: ModelHarnessSource;
  /**
   * Pipeline/headless dispatch now supports all three harnesses: Codex and
   * Cursor each run through their own host runner
   * (`maybeRunCodexPrompt`/`maybeRunCursorPrompt` in
   * `pipelines/executor/step-runner.ts`), so this is no longer narrowed to
   * exclude 'cursor'.
   */
  harness: ModelHarness;
  runtimeModel: string;
  aiCreditsRouted: boolean;
  modelGatewayRouted?: boolean;
  /** Routed to the account proxy, which bills a proxy account (CAN-4020). */
  accountProxyRouted?: boolean;
  accountProxyConnectionId?: string;
  envOverride?: Record<string, string>;
  codexConfig?: CodexConfig;
}

export interface HarnessAssignmentsApi {
  load(): Promise<ModelHarnessAssignmentSnapshot>;
  set(
    input: SetModelHarnessAssignmentInput,
  ): Promise<ModelHarnessAssignmentSnapshot>;
  reset(
    input: ResetModelHarnessAssignmentInput,
  ): Promise<ModelHarnessAssignmentSnapshot>;
}
