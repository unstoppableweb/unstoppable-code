import type { WorkerAgentProviderInventory } from '@canopy/core-runtime/node/agent/providers';
import {
  WORKER_AGENT_PROVIDER_IDS,
  WORKER_AGENT_PROVIDER_MAX_MODELS,
  WORKER_AGENT_PROVIDER_MAX_USAGE_ACCOUNTS,
  WORKER_AGENT_PROVIDER_MAX_USAGE_WINDOWS,
  WORKER_AGENT_PROVIDER_NAMES,
  type WorkerAgentModel,
  type WorkerAgentModelBillingSource,
  type WorkerAgentProvider,
  type WorkerAgentProviderAuthState,
  type WorkerAgentProviderId,
  type WorkerAgentProviderUsageLimit,
  type WorkerAgentUsageWindow,
} from '@canopy/protocol/canopy-core';
import type {
  PortalProviderUsageAccount,
  PortalProviderUsageEntry,
  PortalProviderUsageError,
  PortalProviderUsageProjection,
  PortalProviderUsageWindow,
} from '@canopy/protocol/portal';
import { THINKING_LEVELS, type ThinkingLevel } from '@canopy/protocol/thinking';
import type {
  AgentProviderAuthStatus,
  ModelRegistrySnapshot,
  OllamaState,
} from '@canopy/desktop-shared/types';

export type ProviderSupport = Readonly<Record<WorkerAgentProviderId, boolean>>;
export type ProviderAuthStates = Readonly<
  Partial<Record<WorkerAgentProviderId, WorkerAgentProviderAuthState>>
>;

export interface ProviderInventoryInputs {
  readonly registry: ModelRegistrySnapshot;
  readonly supported: ProviderSupport;
  /** One entry per supported provider; a missing entry reads as `error`. */
  readonly authStates: ProviderAuthStates;
  readonly checkedAt: string;
  readonly usage: PortalProviderUsageProjection | null;
  /** True when the organization's model policy blocks the model. */
  readonly isBlocked: (modelId: string) => boolean;
  /** Receives the one warning a truncated model list logs. */
  readonly warn?: (message: string, context: Record<string, unknown>) => void;
}

type ModelSource = 'native' | 'ai-gateway' | 'ollama';

interface RegistryModelEntry {
  readonly id: unknown;
  readonly label?: string;
  readonly selectable?: boolean;
  readonly contextWindow?: number;
  readonly supportedThinkingLevels?: readonly string[];
  readonly gateway?: {
    readonly gatewayOnly: boolean;
    readonly origin?: 'hosted' | 'org-gateway';
  };
}

const MAX_MODEL_ID_LENGTH = 512;
const MAX_MODEL_NAME_LENGTH = 256;
const MAX_USAGE_TEXT_LENGTH = 320;
const MAX_USAGE_ERROR_LENGTH = 1_024;
const MAX_CURRENCY_LENGTH = 16;
const USAGE_LIMIT_PROVIDERS: ReadonlySet<WorkerAgentProviderId> = new Set([
  'claude',
  'codex',
  'copilot',
]);

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeIsoTimestamp(
  value: string | undefined,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

export function projectModelBilling(
  entry: {
    readonly gateway?: {
      readonly gatewayOnly: boolean;
      readonly origin?: 'hosted' | 'org-gateway';
    };
  },
  source: ModelSource,
): Pick<WorkerAgentModel, 'billingSources' | 'gatewayOrigin'> {
  if (source === 'ollama')
    return { billingSources: ['local'], gatewayOrigin: null };
  if (source === 'ai-gateway')
    return entry.gateway?.origin === 'org-gateway'
      ? { billingSources: [], gatewayOrigin: 'org-gateway' }
      : { billingSources: ['ai_credits'], gatewayOrigin: 'hosted' };
  const gateway = entry.gateway;
  if (!gateway)
    return { billingSources: ['provider_account'], gatewayOrigin: null };
  if (gateway.origin === 'org-gateway')
    return {
      billingSources: gateway.gatewayOnly ? [] : ['provider_account'],
      gatewayOrigin: 'org-gateway',
    };
  const billingSources: WorkerAgentModelBillingSource[] = gateway.gatewayOnly
    ? ['ai_credits']
    : ['provider_account', 'ai_credits'];
  return { billingSources, gatewayOrigin: 'hosted' };
}

function projectThinkingLevels(
  levels: readonly string[] | undefined,
  source: ModelSource,
): ThinkingLevel[] | null {
  if (source === 'ollama' || !Array.isArray(levels)) return null;
  const kept: ThinkingLevel[] = [];
  for (const level of levels)
    if (isThinkingLevel(level) && !kept.includes(level)) kept.push(level);
  return kept;
}

function projectModel(
  provider: WorkerAgentProviderId,
  entry: RegistryModelEntry & { readonly id: string },
  source: ModelSource,
  isBlocked: (modelId: string) => boolean,
): WorkerAgentModel {
  const contextWindow = entry.contextWindow;
  return {
    modelId: entry.id,
    name:
      (entry.label ?? '').trim().slice(0, MAX_MODEL_NAME_LENGTH) ||
      entry.id.slice(0, MAX_MODEL_NAME_LENGTH),
    contextWindow:
      typeof contextWindow === 'number' &&
      Number.isInteger(contextWindow) &&
      contextWindow > 0
        ? contextWindow
        : null,
    outputLimit: null,
    ...projectModelBilling(entry, source),
    thinkingLevels: projectThinkingLevels(
      entry.supportedThinkingLevels,
      source,
    ),
    blockedByOrganization: provider === 'ollama' ? false : isBlocked(entry.id),
  };
}

function modelSources(
  provider: WorkerAgentProviderId,
  registry: ModelRegistrySnapshot,
): readonly {
  readonly entries: readonly RegistryModelEntry[];
  readonly source: ModelSource;
}[] {
  // API-only rows carry no origin; their route records an org gateway.
  const orgGatewayIds = new Set(
    (registry.gatewayRoutes ?? [])
      .filter((route) => route.origin === 'org-gateway')
      .map((route) => route.modelId),
  );
  const gatewayRows = (harness: 'claude' | 'codex'): RegistryModelEntry[] =>
    (registry.aiGatewayModels ?? [])
      .filter((entry) => entry.recommendedHarness === harness)
      .map((entry) =>
        orgGatewayIds.has(entry.id)
          ? { ...entry, gateway: { gatewayOnly: true, origin: 'org-gateway' } }
          : entry,
      );
  switch (provider) {
    case 'claude':
      return [
        { entries: registry.claude, source: 'native' },
        { entries: gatewayRows('claude'), source: 'ai-gateway' },
      ];
    case 'codex':
      return [
        { entries: registry.codex, source: 'native' },
        { entries: gatewayRows('codex'), source: 'ai-gateway' },
      ];
    case 'ollama':
      return [{ entries: registry.ollama, source: 'ollama' }];
    case 'cursor':
      return [{ entries: registry.cursor ?? [], source: 'native' }];
    case 'antigravity':
      return [{ entries: registry.antigravity ?? [], source: 'native' }];
    case 'copilot':
      return [{ entries: registry.copilot ?? [], source: 'native' }];
    case 'opencode':
      return [{ entries: registry.opencode ?? [], source: 'native' }];
  }
}

function projectModels(
  provider: WorkerAgentProviderId,
  inputs: ProviderInventoryInputs,
): WorkerAgentModel[] {
  const models: WorkerAgentModel[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const { entries, source } of modelSources(provider, inputs.registry)) {
    for (const entry of entries) {
      const id = entry.id;
      if (entry.selectable === false) continue;
      if (
        typeof id !== 'string' ||
        id.length === 0 ||
        id.length > MAX_MODEL_ID_LENGTH
      )
        continue;
      if (seen.has(id)) continue;
      seen.add(id);
      if (models.length >= WORKER_AGENT_PROVIDER_MAX_MODELS) {
        dropped += 1;
        continue;
      }
      models.push(
        projectModel(provider, { ...entry, id }, source, inputs.isBlocked),
      );
    }
  }
  if (dropped > 0)
    inputs.warn?.('[agent-providers] provider model list truncated', {
      provider,
      dropped,
    });
  return models;
}

function projectUsageError(
  error: PortalProviderUsageError,
): NonNullable<WorkerAgentProviderUsageLimit['error']> {
  return {
    kind: error.kind,
    message: error.message.slice(0, MAX_USAGE_ERROR_LENGTH),
  };
}

function projectWindow(
  window: PortalProviderUsageWindow,
): WorkerAgentUsageWindow | undefined {
  const id = window.id.slice(0, MAX_USAGE_TEXT_LENGTH);
  const label = window.label.slice(0, MAX_USAGE_TEXT_LENGTH);
  if (id.length === 0 || label.length === 0) return undefined;
  const projected: WorkerAgentUsageWindow = { id, label };
  if (typeof window.unlimited === 'boolean')
    projected.unlimited = window.unlimited;
  if (isFiniteNumber(window.usedPercent) && window.usedPercent >= 0)
    projected.usedPercent = window.usedPercent;
  const resetsAt = normalizeIsoTimestamp(window.resetsAt);
  if (resetsAt !== undefined) projected.resetsAt = resetsAt;
  if (isFiniteNumber(window.windowDurationMs) && window.windowDurationMs >= 0)
    projected.windowDurationMs = window.windowDurationMs;
  if (window.credits) {
    const credits: NonNullable<WorkerAgentUsageWindow['credits']> = {
      unit: window.credits.unit,
    };
    if (isFiniteNumber(window.credits.spent))
      credits.spent = window.credits.spent;
    if (isFiniteNumber(window.credits.remaining))
      credits.remaining = window.credits.remaining;
    if (isFiniteNumber(window.credits.total))
      credits.total = window.credits.total;
    projected.credits = credits;
  }
  if (window.spend) {
    const spend: NonNullable<WorkerAgentUsageWindow['spend']> = {};
    const currency = window.spend.currency?.slice(0, MAX_CURRENCY_LENGTH);
    if (currency) spend.currency = currency;
    if (isFiniteNumber(window.spend.used)) spend.used = window.spend.used;
    if (window.spend.limit === null || isFiniteNumber(window.spend.limit))
      spend.limit = window.spend.limit;
    if (typeof window.spend.isEnabled === 'boolean')
      spend.isEnabled = window.spend.isEnabled;
    projected.spend = spend;
  }
  return projected;
}

function projectWindows(
  windows: readonly PortalProviderUsageWindow[],
): WorkerAgentUsageWindow[] {
  return windows
    .slice(0, WORKER_AGENT_PROVIDER_MAX_USAGE_WINDOWS)
    .map(projectWindow)
    .filter((window): window is WorkerAgentUsageWindow => window !== undefined);
}

type WorkerAgentUsageAccount = NonNullable<
  WorkerAgentProviderUsageLimit['accountProxy']
>['accounts'][number];

function projectAccount(
  account: PortalProviderUsageAccount,
): WorkerAgentUsageAccount {
  const projected: WorkerAgentUsageAccount = {
    status: account.status,
    windows: projectWindows(account.windows),
  };
  const availableAt = normalizeIsoTimestamp(account.availableAt);
  if (availableAt !== undefined) projected.availableAt = availableAt;
  if (account.usageSource !== undefined)
    projected.usageSource = account.usageSource;
  const lastUpdatedAt = normalizeIsoTimestamp(account.lastUpdatedAt);
  if (lastUpdatedAt !== undefined) projected.lastUpdatedAt = lastUpdatedAt;
  if (account.error) projected.error = projectUsageError(account.error);
  const retryAt = normalizeIsoTimestamp(account.retryAt);
  if (retryAt !== undefined) projected.retryAt = retryAt;
  return projected;
}

export function projectProviderUsageLimit(
  entry: PortalProviderUsageEntry | undefined,
): WorkerAgentProviderUsageLimit | null {
  if (entry === undefined) return null;
  return {
    authState: entry.authState,
    lastUpdatedAt: normalizeIsoTimestamp(entry.lastUpdatedAt) ?? null,
    error: entry.error ? projectUsageError(entry.error) : null,
    windows: projectWindows(entry.windows),
    accountProxy:
      entry.accounts === undefined
        ? null
        : {
            accounts: entry.accounts
              .slice(0, WORKER_AGENT_PROVIDER_MAX_USAGE_ACCOUNTS)
              .map(projectAccount),
          },
  };
}

/** Claude and Codex: from an observed auth status (probe) or the cached boolean (peek). */
export function nativeAuthState(
  observation: AgentProviderAuthStatus | boolean | undefined,
  userSuppliedCredential: boolean,
): WorkerAgentProviderAuthState {
  if (observation === undefined)
    return userSuppliedCredential ? 'ready' : 'error';
  if (typeof observation === 'boolean')
    return observation || userSuppliedCredential ? 'ready' : 'missing';
  if (userSuppliedCredential) return 'ready';
  // A failed probe keeps the last confirmed status; it is unknown, as the peek reads it.
  if (observation.probeFailed === true) return 'error';
  return observation.authenticated ? 'ready' : 'missing';
}

/** Cursor, Copilot, OpenCode: a runtime availability value. */
export function availabilityAuthState(
  available: boolean | undefined,
): WorkerAgentProviderAuthState {
  if (available === undefined) return 'error';
  return available ? 'ready' : 'missing';
}

export function ollamaAuthState(
  state: OllamaState,
): WorkerAgentProviderAuthState {
  if (state.status === 'error') return 'error';
  if (state.status === 'running-managed' || state.status === 'running-external')
    return 'ready';
  return state.installation.ready ? 'ready' : 'missing';
}

export function projectProviderInventory(
  inputs: ProviderInventoryInputs,
): WorkerAgentProviderInventory {
  const providers: WorkerAgentProvider[] = [];
  for (const providerId of WORKER_AGENT_PROVIDER_IDS) {
    if (inputs.supported[providerId] !== true) continue;
    providers.push({
      providerId,
      name: WORKER_AGENT_PROVIDER_NAMES[providerId],
      authState: inputs.authStates[providerId] ?? 'error',
      checkedAt: inputs.checkedAt,
      models: projectModels(providerId, inputs),
      usageLimit: USAGE_LIMIT_PROVIDERS.has(providerId)
        ? projectProviderUsageLimit(
            inputs.usage?.providers.find(
              (entry) => entry.provider === providerId,
            ),
          )
        : null,
    });
  }
  return { providers };
}
