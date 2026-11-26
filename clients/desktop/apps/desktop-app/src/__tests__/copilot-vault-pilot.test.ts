import type {
  CopilotVaultRenewalCase,
  CopilotVaultFieldCoverage,
} from '@canopy/desktop-shared/node/copilot/consumer-transport';
import {
  CopilotHandoffPhaseSchema,
  COPILOT_VAULT_IMPORT_PATHS,
} from '@canopy/protocol/copilot-handoff';
import { createCopilotQualificationConnection } from '../main/copilot/qualification-connection';
import type { CopilotQualificationHandoff } from '../main/copilot/qualification-handoff';
import { CoreDeferredToolReloads } from '@canopy/core-runtime/node/agent/deferred-tools';
import { OperationService } from '@canopy/core-runtime/node/operations';
import { OperationLedger } from '@canopy/core-runtime/node/operations/ledger';
import {
  setDeferredToolReloads,
  deferredToolsReloadCoordinator,
} from '../main/deferred-tools/reload-coordinator';
import type { DesktopDeferredToolReloadPayload } from '../main/deferred-tools/reload-host';
import { getCopilotWorkerRuntime } from '../main/agent-runs/copilot-worker-runtime';
import * as CursorToolApproval from '../main/cursor/tool-approval';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk';
import { isAssistantPatch } from '@canopy/agent-transcript/lib/assistant-snapshot';
import { parseAgentTranscriptLines } from '@canopy/agent-transcript/lib/transcript-parser';
import { DelegationTranscriptRecorder } from '../main/agents/delegation/transcript-recorder';
import type * as PathsModule from '../main/lib/paths';
import type { WorkspaceApprovalsManifest } from '../main/lib/workspace-approvals-manifest';
import type * as SessionManagerModule from '../main/agents/session-manager';
import type * as McpProxyModule from '../main/mcp/http-proxy-service';
import type * as PluginResolverModule from '../main/plugins/plugin-resolver';
import * as HomeCapabilitiesModule from '../main/plugins/home-capabilities';
import type * as InheritedCapabilitiesModule from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import type * as PluginOverlayModule from '../main/plugins/global-plugin-overlay';
import type * as MemoryPolicyModule from '../main/memory/local/policy';
import type * as ObservabilityModule from '../main/observability';
import type * as ChatStateModule from '../main/services/chat-state-service';
import type * as AttentionModule from '../main/services/attention-tracker';
import type * as IngestModule from '../main/observability/ingest';
import { app, BrowserWindow } from 'electron';
import {
  CopilotAssistantPatchSchema,
  CopilotLocalFrameSchema,
  CopilotLocalRequestSchema,
  COPILOT_RECIPIENT_LIMITS,
} from '@canopy/protocol/copilot-recipient';
import {
  hasPendingApprovalForSession,
  pendingApprovalRequests,
  resolveApproval,
} from '../main/approvals/pending-approvals';
import { resetDesktopApprovalBrokerForTests } from '../main/approvals/approval-broker';
import {
  resetDesktopChatWaitsForTest,
  setDesktopChatWaitPresence,
} from '../main/chat-waits/desktop-chat-waits';
import { CopilotProvider } from '../main/agents/copilot-session';
import {
  runInAgentWorker,
  runInAgentWorkerSync,
} from '../main/agent-runs/agent-worker-context';
import type { AgentSession } from '../main/agents/types';
import { readChatTabsFile } from '../main/lib/chat-tabs-reader';
import * as ApprovalPersistence from '../main/lib/approvals-persistence';
import * as ApprovalService from '../main/approvals/approval-service';
import * as ApprovalBridge from '../main/approvals/prompt-bridge';
import { runDesktopCopilotPipelinePrompt } from '../main/pipelines/copilot-prompt-runner';
import type * as TimersModule from 'node:timers';
import type * as CapabilityModule from '@canopy/desktop-shared/lib/cursor-capabilities';
import { createCopilotDelegationRunner } from '../main/agents/delegation/copilot-runner';
import { DelegationNativePolicy } from '../main/agents/delegation/native-policy';
import { request as delegationRequest } from '../main/__tests__/helpers/delegation-runner-fixtures/copilot';
import type { AgentDelegationEvent } from '@canopy/protocol/delegation';
import { readPreferencesFileDetailed } from '../main/lib/preferences-store';
import { DEFAULT_PREFERENCES } from '@canopy/desktop-shared/node/preferences/defaults';
import { DESKTOP_PREFERENCES_CODEC } from '@canopy/desktop-shared/node/preferences/desktop-preferences-codec';
import type { DomainPreferencesData } from '@canopy/desktop-shared/node/preferences/client-local-preferences';
import * as PreferencesEnvironment from '@canopy/desktop-shared/node/preferences/normalization-environment';
import {
  createPreferencesRepository,
  type PreferencesRepository,
} from '@canopy/core-runtime/node/preferences';
import { MemoryPreferencesDocument } from '../../../../packages/core-runtime/src/node/preferences/__tests__/fixtures/memory-document';
import {
  recordUsageDataRevocations,
  withUsageDataConsentJournal,
  type ConsentJournal,
} from '../main/lib/usage-data-consent-document';
import {
  createCopilotVaultPilot,
  type CopilotVaultPilotOptions,
  type CopilotVaultPilot,
} from '../../../core-daemon/src/copilot-pilot';
import {
  createCopilotSelectionReceipt,
  readCopilotSelectionPreferences,
  type CopilotSelectionRepository,
} from '../main/copilot/selection-receipt';
import {
  createCopilotConnectionProxy,
  COPILOT_VAULT_OPEN_FIELDS,
  type CopilotConnectionBackend,
  type CopilotConnectionProxy,
} from '../main/copilot/connection-proxy';
import {
  createCopilotVaultConnection,
  COPILOT_VAULT_PENDING_PATHS,
  COPILOT_VAULT_SETUP_CANCEL_PATHS,
  type CopilotVaultConnectionPort,
} from '../main/copilot/vault-connection';
import {
  COPILOT_VAULT_TURN_FIELDS,
  copilotVaultFieldsCovered,
} from '@canopy/desktop-shared/node/copilot/consumer-transport';
import type { CopilotRecipientHandle } from '@canopy/desktop-shared/node/copilot/recipient-handle';
import {
  copilotProcessOwnerId,
  type CopilotProcess,
  type CopilotRuntimeOptions,
  type OwnedCopilotRuntime,
} from '@canopy/copilot-recipient/runtime';
import * as CopilotModuleLoader from '@canopy/copilot-recipient/node-module-loader';
import * as CopilotProcessOwnership from '@canopy/copilot-recipient/process-ownership';
import {
  CopilotProcessReceipt,
  reapCopilotProcessReceipts,
} from '@canopy/copilot-recipient/process-receipts';
import type { CopilotReceiptStorage } from '@canopy/copilot-recipient/receipt-storage';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createMemoryVaultRepository } from '@canopy/core-runtime/vault/testing/memory-repository';
import type {
  CopilotAuthorityJournal,
  CopilotAuthorityRecord,
  CopilotGrantResult,
  CopilotGrantHead,
  CopilotVaultGrant,
  CopilotGrantAuthorityOptions,
} from '@canopy/core-runtime/node/vault';
import type { VaultFamilyWriter } from '@canopy/core-runtime/vault';
import {
  bindCopilotLocalRuntime,
  startCopilotLocalRuntime,
  type CopilotLocalPolicy,
} from '@canopy/copilot-recipient/local-driver';
import { nativeRuntime } from '../../../../packages/copilot-recipient/src/__tests__/helpers/copilot';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCopilotPipelinePrompt } from '@canopy/desktop-shared/node/pipelines/copilot-prompt-runner';
import { authorizeCopilotSetup } from '@canopy/desktop-shared/node/copilot/setup-flow';
import type { CopilotTurnRequest } from '@canopy/copilot-recipient/turn-driver';
import {
  peekCopilotRuntimeAvailability,
  invalidateCopilotRuntimeAvailability,
} from '../main/copilot/runtime-availability';
import type { CopilotConnectionStatus } from '@canopy/desktop-shared/types/copilot-connection';
import type { CopilotModelEntry } from '@canopy/execution-engine/types/copilot-models';
import { copilotModelsFromSdk } from '@canopy/execution-engine/lib/copilot-models';
import type {
  PreferencesData,
  ChatTabsFile,
} from '@canopy/desktop-shared/types';
import { windowAgentInterfacePort } from '../main/agents/agent-interface-port';

const TEST_OWNER = { kind: 'turn', id: 'vault-test' } as const;

let mockCallerConnection: CopilotConnectionProxy | undefined;
jest.mock('../main/copilot/connection', () => ({
  openManagedCopilotRuntime: (
    input: Parameters<CopilotConnectionBackend['openManagedCopilotRuntime']>[0],
  ): ReturnType<CopilotConnectionBackend['openManagedCopilotRuntime']> => {
    if (!mockCallerConnection) throw new Error('No caller composition');
    return mockCallerConnection.openManagedCopilotRuntime(input);
  },
  assertCopilotModelAvailable: (
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<CopilotModelEntry> => {
    if (!mockCallerConnection) throw new Error('No caller composition');
    return mockCallerConnection.assertCopilotModelAvailable(model, signal);
  },
  assertCopilotConnectionGeneration: (generation: number): void => {
    if (!mockCallerConnection) throw new Error('No caller composition');
    mockCallerConnection.assertCopilotConnectionGeneration(generation);
  },
}));
// Host discovery, persistence and event sinks are fixtures; turn policy/projection,
// history acceptance, host approval evaluation and recipient transport stay real.
let mockChatRoot: string;
let mockPipelineServers: Record<string, unknown> = {};
const mockHostSessions = new Map<string, AgentSession>();
const mockDiagnostics = jest.fn<
  ReturnType<
    ReturnType<
      typeof ObservabilityModule.getObservabilityService
    >['recordSessionDiagnostic']
  >,
  Parameters<
    ReturnType<
      typeof ObservabilityModule.getObservabilityService
    >['recordSessionDiagnostic']
  >
>();
const mockUnregisterRoutes = jest.fn<void, [string]>();
const mockSetToolGate = jest.fn<
  ReturnType<
    ReturnType<
      typeof McpProxyModule.getMcpHttpProxyService
    >['setSessionToolCallGate']
  >,
  Parameters<
    ReturnType<
      typeof McpProxyModule.getMcpHttpProxyService
    >['setSessionToolCallGate']
  >
>();
const mockRegisterRoute = jest.fn<
  Promise<string>,
  [McpProxyModule.CanopyWorktreeSessionRoute]
>((route) => Promise.resolve(route.sessionKey));
jest.mock('../main/mcp/http-proxy-service', () => ({
  getMcpHttpProxyService: (): Pick<
    ReturnType<typeof McpProxyModule.getMcpHttpProxyService>,
    | 'getMcpCapabilityDigests'
    | 'registerCanopyWorktreeSessionRoute'
    | 'getCanopyWorktreeMcpUrl'
    | 'getCanopyWorktreeUiMcpUrl'
    | 'setSessionToolCallGate'
    | 'getCanopyCapabilityDefinitions'
    | 'unregisterRoutesForSession'
    | 'unregisterCanopyWorktreeSessionRoute'
  > => ({
    getMcpCapabilityDigests: () => ({}),
    registerCanopyWorktreeSessionRoute: (route) => mockRegisterRoute(route),
    getCanopyWorktreeMcpUrl: () => 'http://127.0.0.1:4000/main',
    getCanopyWorktreeUiMcpUrl: () => 'http://127.0.0.1:4000/ui',
    setSessionToolCallGate: (...args) => mockSetToolGate(...args),
    getCanopyCapabilityDefinitions: () => ({ main: [], ui: [] }),
    unregisterRoutesForSession: (key) => mockUnregisterRoutes(key),
    unregisterCanopyWorktreeSessionRoute: () => undefined,
  }),
}));
jest.mock('../main/plugins/plugin-resolver', () => ({
  buildCursorCapabilityProjection:
    (): CapabilityModule.CursorCapabilityProjection =>
      jest
        .requireActual<
          typeof CapabilityModule
        >('@canopy/desktop-shared/lib/cursor-capabilities')
        .emptyCursorCapabilityProjection(),
  resolvePlugins: (): Promise<PluginResolverModule.ResolvedPlugins> =>
    Promise.resolve({
      sdkPlugins: [],
      skillPluginDir: null,
      selectedCapabilityRoots: [],
      codexMcpServers: {},
      mcpServers: mockPipelineServers,
      mcpServerBindings: {},
      warnings: [],
      cursorNotices: [],
      cursorCapabilities: jest
        .requireActual<
          typeof CapabilityModule
        >('@canopy/desktop-shared/lib/cursor-capabilities')
        .emptyCursorCapabilityProjection(),
    }),
}));
jest.mock('../main/plugins/home-capabilities', () => ({
  discoverHomeCapabilities: jest.fn<
    ReturnType<typeof HomeCapabilitiesModule.discoverHomeCapabilities>,
    Parameters<typeof HomeCapabilitiesModule.discoverHomeCapabilities>
  >(() =>
    Promise.resolve({
      inherited: jest
        .requireActual<
          typeof InheritedCapabilitiesModule
        >('@canopy/desktop-shared/node/cursor/inherited-capabilities')
        .emptyInheritedCursorCapabilities(),
      inheritedPluginRefs: [],
    }),
  ),
}));
jest.mock('../main/plugins/global-plugin-overlay', () => ({
  resolveEffectiveChatPluginContext:
    (): Promise<PluginOverlayModule.EffectiveChatPluginContext> =>
      Promise.resolve({
        selections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
        preferences: DEFAULT_PREFERENCES,
      }),
}));
jest.mock('../main/plugins/invocable-inventory-service', () => ({
  refreshInvocableInventoryAfterMutation: (): void => undefined,
}));
jest.mock('../main/lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../main/lib/paths'),
  getWorktreeDataDir: (): string => mockChatRoot,
}));
jest.mock('../main/lib/chat-tabs-reader', () => ({
  readChatTabsFile: jest.fn(),
}));
jest.mock('../main/lib/workspace-registry', () => ({
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../main/memory/local/policy', () => ({
  resolveLocalMemoryPolicy: (): Promise<MemoryPolicyModule.LocalMemoryPolicy> =>
    Promise.resolve({ kind: 'unscoped' }),
}));
jest.mock('../main/agents/session-manager', () => ({
  buildSessionKey: (
    ...args: Parameters<typeof SessionManagerModule.buildSessionKey>
  ): string => args.join(':'),
  registerSession: (key: string, session: AgentSession): void => {
    mockHostSessions.set(key, session);
  },
  getSessionKeyOwnership: (
    key: string,
    session: AgentSession,
  ): ReturnType<typeof SessionManagerModule.getSessionKeyOwnership> =>
    mockHostSessions.get(key) === session ? 'registered' : 'replaced',
  drainChatSessionEvents: (): Promise<void> => Promise.resolve(),
  markTurnActive: (): void => undefined,
  markTurnIdle: (): void => undefined,
  markTurnAwaitingUser: (): void => undefined,
  recordSessionEvent: (): void => undefined,
}));
jest.mock('../main/agents/session-event-router', () => ({
  observeRoutedTurnBinding: (): void => undefined,
}));
jest.mock('../main/canopy-tools/session-runtime', () => ({
  requestAnswersFromRenderer: jest.fn(),
}));
jest.mock('../main/services/attention-tracker', () => ({
  getAttentionTracker: (): Pick<
    ReturnType<typeof AttentionModule.getAttentionTracker>,
    'mark' | 'clear'
  > => ({ mark: () => undefined, clear: () => undefined }),
}));
jest.mock('../main/observability/ingest', () => ({
  getExecutionObservabilityIngest: (): Pick<
    ReturnType<typeof IngestModule.getExecutionObservabilityIngest>,
    'pauseChatTurn' | 'resumeChatTurn'
  > => ({ pauseChatTurn: () => undefined, resumeChatTurn: () => undefined }),
}));

jest.mock('../main/observability', () => ({
  getObservabilityService: (): Pick<
    ReturnType<typeof ObservabilityModule.getObservabilityService>,
    'recordSessionDiagnostic'
  > => ({
    recordSessionDiagnostic: (...args) => mockDiagnostics(...args),
  }),
}));
jest.mock('../main/services/chat-state-service', () => ({
  getChatStateService: (): Pick<
    ReturnType<typeof ChatStateModule.getChatStateService>,
    'commitTurnPause' | 'updateCompatibilityTab'
  > => ({
    commitTurnPause: () => Promise.resolve(),
    updateCompatibilityTab: () =>
      Promise.resolve({
        updated: false,
        tabsFile: { version: 1, tabs: [], activeTabId: '' },
      }),
  }),
}));

jest.mock('../main/lib/workspace-approvals-manifest', () => ({
  readWorkspaceApprovalsManifest: (): Promise<WorkspaceApprovalsManifest> =>
    Promise.resolve({ rules: [] }),
}));

jest.mock('../main/lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
  readPreferencesFileDetailed: jest.fn(),
  updatePreferencesFile: jest.fn(),
}));
jest.mock('../main/copilot/legacy-connection', () => ({
  authorizeCopilotDevice: jest.fn(),
  copilotInstallationStatus: jest.fn(),
}));
jest.mock('../main/copilot/feature-flag', () => ({
  assertCopilotHarnessEnabled: (): void => undefined,
}));
jest.mock('../main/copilot/credential-broker', () => ({
  CopilotSignInExpiredError: class extends Error {},
}));

const ACCESS = 'p6-access-secret-sentinel';
const REFRESH = 'p6-refresh-secret-sentinel';
const base: CopilotConnectionStatus = {
  supported: true,
  installed: true,
  enabled: false,
  version: '1',
  phase: 'idle',
  account: null,
};
function grant(): CopilotVaultGrant {
  return {
    version: 1,
    clientId: 'client',
    host: 'https://github.com',
    login: 'pilot',
    id: '123',
    accessToken: ACCESS,
    refreshToken: REFRESH,
    accessTokenExpiresAt: new Date(Date.now() + 7_200_000).toISOString(),
    refreshTokenExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  };
}
function ready(
  result:
    | CopilotGrantResult
    | { kind: 'probe-failed'; reason: 'no-access' | 'policy' | 'network' },
): CopilotGrantHead {
  expect(result.kind).toBe('ready');
  if (result.kind !== 'ready') throw new Error('Not ready');
  return result.head;
}
function deferred<T>(): { resolve(value: T): void; promise: Promise<T> } {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred');
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
type Stored = Pick<
  PreferencesData,
  'copilotVaultSelection' | 'copilotAccount' | 'copilotEnabled'
>;
type ModelResponse = {
  models: {
    id: string;
    name: string;
    policy: { state: 'enabled'; terms: string };
    capabilities: {
      supports: { vision: boolean; reasoningEffort?: boolean };
      limits: { max_prompt_tokens: number; max_context_window_tokens: number };
    };
    supportedReasoningEfforts?: string[];
  }[];
};
type Launch = Omit<
  Parameters<CopilotConnectionBackend['openManagedCopilotRuntime']>[0],
  'signal' | 'purpose' | 'requireAccount'
>;
type SdkQuota = OwnedCopilotRuntime['client']['rpc']['account']['getQuota'];
interface Fixture {
  launches: (Launch | undefined)[];
  pilot: CopilotVaultPilot;
  port: CopilotVaultConnectionPort;
  backend: CopilotConnectionBackend;
  pilotOptions: CopilotVaultPilotOptions;
  refresh: jest.Mock<
    ReturnType<CopilotGrantAuthorityOptions['refresh']>,
    Parameters<CopilotGrantAuthorityOptions['refresh']>
  >;
  selection: ReturnType<typeof createCopilotSelectionReceipt>;
  memory: ReturnType<typeof createMemoryVaultRepository>;
  natives: ReturnType<typeof nativeRuntime>[];
  list: jest.Mock<Promise<ModelResponse>, []>;
  quota: jest.Mock<ReturnType<CopilotRecipientHandle['getQuota']>, []>;
  put: jest.Mock<
    ReturnType<VaultFamilyWriter['put']>,
    Parameters<VaultFamilyWriter['put']>
  >;
  remove: jest.Mock<
    ReturnType<VaultFamilyWriter['delete']>,
    Parameters<VaultFamilyWriter['delete']>
  >;
  refreshSuccess(): void;
  refreshRejected(): void;
  failCleanup(): void;
  missingResume(): void;
  preferences(): Stored;
  state(): CopilotAuthorityRecord;
  failPin(): void;
  losePin(): void;
  setPreferences(next: Stored): void;
}
function fixture(
  hold = false,
  onPrompt?: () => void,
  configureNative?: (native: ReturnType<typeof nativeRuntime>) => void,
  nativeSessionId?: string,
  spawnOptions?: Omit<CopilotRuntimeOptions, 'signal' | 'owner'>,
): Fixture {
  let preferences: Stored = {};
  let failPin = false,
    losePin = false,
    loseRead = false;
  const preferenceRepository: CopilotSelectionRepository = {
    read: () => {
      if (loseRead) {
        loseRead = false;
        return Promise.reject(new Error(REFRESH));
      }
      return Promise.resolve(structuredClone(preferences));
    },
    update: (updater) => {
      const patch = updater(structuredClone(preferences));
      if (patch?.copilotVaultSelection?.state === 'selected' && failPin) {
        failPin = false;
        return Promise.reject(new Error(REFRESH));
      }
      preferences = { ...preferences, ...patch };
      if (patch?.copilotVaultSelection?.state === 'selected' && losePin) {
        losePin = false;
        loseRead = true;
        return Promise.reject(new Error(REFRESH));
      }
      return Promise.resolve(structuredClone(preferences));
    },
  };
  const selection = createCopilotSelectionReceipt(preferenceRepository);
  const memory = createMemoryVaultRepository();
  const raw = memory.writer('copilot-account');
  const committed = new Map<
    string,
    Awaited<ReturnType<CopilotAuthorityJournal['reconcile']>>
  >();
  let state: CopilotAuthorityRecord = {
    version: 1,
    sequence: 0,
    head: null,
    mutation: null,
    removal: null,
    completed: null,
  };
  const journal: CopilotAuthorityJournal = {
    lifetime: { familyId: 'fixture-family', isExclusive: () => false },
    read: () => Promise.resolve(structuredClone(state)),
    compareExchange: (sequence, next) => {
      if (sequence !== state.sequence) return Promise.resolve(false);
      state = structuredClone(next);
      return Promise.resolve(true);
    },
    reconcile: (id) =>
      Promise.resolve(committed.get(id) ?? { kind: 'not_accepted' }),
  };
  const put = jest.fn(
    async (request: Parameters<VaultFamilyWriter['put']>[0]) => {
      const result = await raw.put(request);
      if (result.kind === 'committed')
        committed.set(request.idempotencyKey, {
          kind: 'committed',
          pin: result.pin,
        });
      return result;
    },
  );
  const remove = jest.fn(
    async (request: Parameters<VaultFamilyWriter['delete']>[0]) => {
      const result = await raw.delete(request);
      if (result.kind === 'committed')
        committed.set(request.idempotencyKey, {
          kind: 'committed',
          pin: { ref: result.ref, revision: result.tombstoneRevision },
        });
      return result;
    },
  );
  let missingResume = false;
  let failCleanup = false;
  const policies = new Map<string, CopilotLocalPolicy>();
  const launchPolicies = new Map<string, Launch>();
  let nextPolicy = 0;
  const launches: (Launch | undefined)[] = [];
  const natives: ReturnType<typeof nativeRuntime>[] = [];
  const list = jest.fn<Promise<ModelResponse>, []>(() =>
    Promise.resolve({
      models: [
        {
          id: 'model',
          name: 'Model',
          policy: { state: 'enabled' as const, terms: '' },
          capabilities: {
            supports: { vision: false },
            limits: {
              max_prompt_tokens: 1000,
              max_context_window_tokens: 1000,
            },
          },
        },
      ],
    }),
  );
  const quota = jest.fn<ReturnType<CopilotRecipientHandle['getQuota']>, []>(
    () =>
      Promise.resolve({
        quotaSnapshots: {
          premium_interactions: {
            entitlementRequests: 400,
            usedRequests: 100,
            usageAllowedWithExhaustedQuota: false,
            overage: 0,
            overageAllowedWithExhaustedQuota: false,
            remainingPercentage: 75,
            isUnlimitedEntitlement: false,
            resetDate: '2027-01-01T00:00:00Z',
          },
          chat: {
            remainingPercentage: 100,
            isUnlimitedEntitlement: true,
            entitlementRequests: -1,
            usedRequests: 50,
            usageAllowedWithExhaustedQuota: true,
            overage: 0,
            overageAllowedWithExhaustedQuota: true,
          },
        },
      }),
  );
  const sdkQuota = jest.fn<ReturnType<SdkQuota>, Parameters<SdkQuota>>(
    async () => {
      const response = await quota();
      return {
        quotaSnapshots: Object.fromEntries(
          Object.entries(response.quotaSnapshots).map(([id, snapshot]) => [
            id,
            snapshot
              ? {
                  entitlementRequests: 0,
                  usedRequests: 0,
                  usageAllowedWithExhaustedQuota: false,
                  overage: 0,
                  overageAllowedWithExhaustedQuota: false,
                  ...snapshot,
                }
              : undefined,
          ]),
        ),
      };
    },
  );
  let refreshResult: Awaited<
    ReturnType<CopilotGrantAuthorityOptions['refresh']>
  > = { kind: 'lost' };
  const refresh = jest.fn<
    ReturnType<CopilotGrantAuthorityOptions['refresh']>,
    Parameters<CopilotGrantAuthorityOptions['refresh']>
  >(() => Promise.resolve(refreshResult));
  const pilotOptions: CopilotVaultPilotOptions = {
    processLifetime: {},
    repository: () => Promise.resolve(memory.repository),
    writer: () => Promise.resolve({ ...raw, put, delete: remove }),
    journal,
    selection,
    probeKeyIfDue: () => Promise.resolve(),
    refresh,
    platform: 'darwin' as const,
    capable: () => true,
    classifyProbeFailure: () => 'no-access' as const,
    start: (policyKey, signal, setupOwner) => {
      const launch = launchPolicies.get(policyKey ?? '');
      launches.push(setupOwner ? { ...launch, owner: setupOwner } : launch);
      const native = nativeRuntime({
        hold,
        sessionId: nativeSessionId ?? `session-${natives.length}`,
      });
      natives.push(native);
      configureNative?.(native);
      if (onPrompt) {
        const create =
          native.runtime.client.createSession.getMockImplementation();
        if (!create) throw new Error('No fixture session factory');
        native.runtime.client.createSession.mockImplementation(
          async (config) => {
            const session = await create(config);
            return {
              ...session,
              send: async (input): Promise<string> => {
                const id = await session.send(input);
                onPrompt();
                return id;
              },
            };
          },
        );
      }
      if (failCleanup) {
        native.runtime.close.mockRejectedValue(
          new Error('Fixture cleanup failed'),
        );
        native.runtime.client.createSession.mockRejectedValue(
          new Error('Fixture turn failed'),
        );
      }
      native.runtime.client.resumeSession.mockImplementation(
        async (sessionId, config) => {
          if (missingResume) {
            missingResume = false;
            throw new Error('Session not found');
          }
          return {
            ...(await native.runtime.client.createSession(config)),
            sessionId,
          };
        },
      );
      const policy = policies.get(policyKey ?? '') ?? {
        workingDirectory: '/trusted/workspace',
        configDirectory: '/trusted/config',
      };
      if (spawnOptions) {
        const owner = setupOwner ?? launch?.owner;
        if (!owner) throw new Error('Missing trusted process owner');
        return startCopilotLocalRuntime(
          {
            ...spawnOptions,
            workingDirectory: policy.workingDirectory,
            signal,
            owner,
          },
          policy,
        );
      }
      return Promise.resolve(
        bindCopilotLocalRuntime(
          {
            ...native.runtime,
            identity: {
              runtimeId: `runtime-${natives.length}`,
              pid: 100 + natives.length,
              started: 1,
            },
            isClosed: () => false,
            client: {
              ...native.runtime.client,
              rpc: {
                models: { list },
                account: { getQuota: sdkQuota },
              },
            },
          },
          policy,
        ),
      );
    },
  };
  const pilot = createCopilotVaultPilot(pilotOptions);
  const port: CopilotVaultConnectionPort = {
    ...pilot,
    status: () => pilot.authority.status(),
    resume: (id: string) => pilot.authority.resume(id),
    cancel: (id: string) => pilot.authority.cancel(id),
    remove: (epoch: string) => pilot.authority.remove(epoch),
    projectPolicy: (
      request: CopilotTurnRequest | undefined,
      launch?: Launch,
    ) => {
      const key = `policy-${nextPolicy++}`;
      if (request)
        policies.set(key, {
          workingDirectory: request.workingDirectory,
          configDirectory: request.configDirectory,
          systemPrompt: request.systemPrompt,
          mcpServers: request.mcpServers,
          skillDirectories: request.skillDirectories,
          tools: request.tools,
          secretValues: request.secretValues
            ? [...request.secretValues]
            : undefined,
          timeoutMs: request.timeoutMs,
        });
      if (launch) launchPolicies.set(key, launch);
      return Promise.resolve(key);
    },
    releasePolicy: (key: string) => {
      policies.delete(key);
      launchPolicies.delete(key);
    },
  };
  const backend = createCopilotVaultConnection({
    port,
    installation: () => Promise.resolve(base),
  });
  return {
    launches,
    refreshRejected: (): void => {
      refreshResult = { kind: 'rejected' };
    },
    failCleanup: (): void => {
      failCleanup = true;
    },
    refreshSuccess: (): void => {
      refreshResult = { kind: 'success', grant: grant() };
    },
    missingResume: (): void => {
      missingResume = true;
    },
    pilot,
    port,
    backend,
    pilotOptions,
    refresh,
    selection,
    memory,
    natives,
    list,
    quota,
    put,
    remove,
    preferences: (): Stored => preferences,
    state: (): CopilotAuthorityRecord => state,
    failPin: (): void => {
      failPin = true;
    },
    losePin: (): void => {
      losePin = true;
    },
    setPreferences: (next: Stored): void => {
      preferences = next;
    },
  };
}
function parityLegacyBackend(
  h: Fixture,
  natives: ReturnType<typeof nativeRuntime>[],
  hold = false,
): CopilotConnectionBackend {
  return {
    ...h.backend,
    openManagedCopilotRuntime: (): Promise<CopilotRecipientHandle> => {
      const native = nativeRuntime({
        sessionId: 'legacy-session',
        hold,
        account: { host: 'https://github.com', login: 'pilot' },
      });
      natives.push(native);
      return Promise.resolve({
        ...native.runtime,
        listModels: async () => copilotModelsFromSdk((await h.list()).models),
        getQuota: () => h.quota(),
      });
    },
  };
}
function turn(overrides: Partial<CopilotTurnRequest> = {}): CopilotTurnRequest {
  return {
    workingDirectory: '/trusted/workspace',
    configDirectory: '/trusted/config',
    model: 'model',
    prompt: 'hello',
    turnId: 'turn',
    signal: new AbortController().signal,
    authorize: () => Promise.resolve({ decision: 'deny' }),
    emit: () => undefined,
    onSession: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  resetDesktopApprovalBrokerForTests();
  resetDesktopChatWaitsForTest();
  setDesktopChatWaitPresence(null);
  jest.restoreAllMocks();
});

function siblingPilot(
  h: Fixture,
  overrides: Partial<CopilotVaultPilotOptions> = {},
): CopilotVaultPilot {
  return createCopilotVaultPilot({
    ...h.pilotOptions,
    journal: { ...h.pilotOptions.journal },
    ...overrides,
  });
}

it('P8 lifetime oracle: reconstructed pilots do not reap a current runtime receipt, but a new boot does', async () => {
  const h = fixture();
  const directory = await mkdtemp(join(tmpdir(), 'p8-receipt-boot-'));
  const storage: CopilotReceiptStorage = {
    write: (path, contents) => writeFile(path, contents, { mode: 0o600 }),
    syncDirectory: () => Promise.resolve(),
  };
  const processIdentity = {
    pid: 1234567,
    parent: 1,
    group: 1234567,
    started: 'synthetic-current-boot',
  };
  let alive = true;
  const terminate = jest
    .spyOn(CopilotProcessOwnership, 'terminateCopilotDescendants')
    .mockImplementation(() => {
      alive = false;
      return Promise.resolve();
    });
  jest
    .spyOn(CopilotProcessOwnership, 'remainingCopilotProcesses')
    .mockImplementation(() => Promise.resolve(alive ? [processIdentity] : []));
  const recover = jest.fn(() => reapCopilotProcessReceipts(directory, storage));
  h.pilotOptions.recoverRuntimeReceipts = recover;
  h.pilotOptions.runtimeReceiptOwner = {};
  let sibling: CopilotVaultPilot | undefined;
  let nextBoot: CopilotVaultPilot | undefined;
  try {
    await h.pilot.recoverRuntimeReceipts();
    ready(await h.pilot.setup(grant(), null));
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    await new CopilotProcessReceipt(directory, storage).save([processIdentity]);
    expect(await readdir(directory)).toHaveLength(1);
    sibling = siblingPilot(h);
    await sibling.recoverRuntimeReceipts();
    expect(recover).toHaveBeenCalledTimes(1);
    expect(terminate).not.toHaveBeenCalled();
    expect(alive).toBe(true);
    await expect(runtime.runTurn(turn())).resolves.toMatchObject({
      text: 'Verified evidence',
    });
    await runtime.close();
    nextBoot = siblingPilot(h, { processLifetime: {} });
    await nextBoot.recoverRuntimeReceipts();
    expect(recover).toHaveBeenCalledTimes(2);
    expect(terminate).toHaveBeenCalledWith([processIdentity]);
    expect(alive).toBe(false);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    sibling?.close();
    nextBoot?.close();
    h.pilot.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('P8 lifetime oracle: sibling quiescence revokes an active setup probe before result admission', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const models = h.list.getMockImplementation();
  if (!models) throw new Error('Missing provider fixture');
  h.list.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return models();
  });
  const sibling = siblingPilot(h);
  const settingUp = h.pilot.setup(grant(), null);
  try {
    await entered.promise;
    await sibling.quiesce();
    expect(h.natives[0]?.runtime.close).toHaveBeenCalled();
    release.resolve();
    expect((await settingUp).kind).not.toBe('ready');
    expect(h.put).not.toHaveBeenCalled();
    expect(h.state().head).toBeNull();
    sibling.reopen();
    expect((await sibling.setup(grant(), null)).kind).toBe('blocked');
  } finally {
    release.resolve();
    await settingUp;
    sibling.close();
    h.pilot.close();
  }
});

it.each(['create', 'recovery'])(
  'P8 lifetime oracle: sibling quiescence fences setup across %s await',
  async (edge) => {
    const h = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    if (edge === 'create') {
      const compare = h.pilotOptions.journal.compareExchange.bind(
        h.pilotOptions.journal,
      );
      jest
        .spyOn(h.pilotOptions.journal, 'compareExchange')
        .mockImplementation(async (sequence, next) => {
          const committed = await compare(sequence, next);
          if (
            next.mutation?.kind === 'create' &&
            !next.mutation.cancelling &&
            !next.mutation.probeConfirmed
          ) {
            entered.resolve();
            await release.promise;
          }
          return committed;
        });
    } else {
      h.pilotOptions.recoverRuntimeReceipts = (): Promise<void> => {
        entered.resolve();
        return release.promise;
      };
    }
    const sibling = siblingPilot(h);
    const settingUp = h.pilot.setup(grant(), null);
    try {
      await entered.promise;
      await sibling.quiesce();
      release.resolve();
      expect((await settingUp).kind).not.toBe('ready');
      expect(h.natives).toHaveLength(0);
    } finally {
      release.resolve();
      await settingUp;
      sibling.close();
      h.pilot.close();
    }
  },
);

it.each([
  'probe-confirmation',
  'cancel-confirmation',
  'persist-read',
  'repository',
  'writer',
  'pre-put-read',
  'persisted',
  'resume-list',
] as const)(
  'P8 lifetime oracle: setup fence prevents publication after %s await',
  async (edge) => {
    const h = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const pause = async (): Promise<void> => {
      entered.resolve();
      await release.promise;
    };
    const journal = h.pilotOptions.journal;
    if (
      edge === 'probe-confirmation' ||
      edge === 'cancel-confirmation' ||
      edge === 'persisted'
    ) {
      const compare = journal.compareExchange.bind(journal);
      jest
        .spyOn(journal, 'compareExchange')
        .mockImplementation(async (sequence, next) => {
          const accepted = await compare(sequence, next);
          if (
            next.mutation?.kind === 'create' &&
            next.mutation.probeConfirmed &&
            !next.mutation.cancelling &&
            Boolean(next.mutation.committed) === (edge === 'persisted')
          )
            await pause();
          return accepted;
        });
    } else if (edge === 'persist-read' || edge === 'pre-put-read') {
      const read = journal.read.bind(journal);
      let reads = 0;
      jest.spyOn(journal, 'read').mockImplementation(async () => {
        const state = await read();
        if (
          state.mutation?.probeConfirmed &&
          !state.mutation.committed &&
          ++reads === (edge === 'persist-read' ? 1 : 2)
        )
          await pause();
        return state;
      });
    } else if (edge === 'resume-list') {
      const list = h.memory.repository.list.bind(h.memory.repository);
      jest.spyOn(h.memory.repository, 'list').mockImplementation(async () => {
        const rows = await list();
        if (h.state().mutation?.committed) await pause();
        return rows;
      });
    } else if (edge === 'repository') {
      const repository = h.pilotOptions.repository.bind(h.pilotOptions);
      jest.spyOn(h.pilotOptions, 'repository').mockImplementation(async () => {
        const value = await repository();
        if (h.state().mutation?.probeConfirmed) await pause();
        return value;
      });
    } else {
      const writer = h.pilotOptions.writer.bind(h.pilotOptions);
      jest.spyOn(h.pilotOptions, 'writer').mockImplementation(async () => {
        const value = await writer();
        if (h.state().mutation?.probeConfirmed) await pause();
        return value;
      });
    }
    const confirm = jest.spyOn(h.selection, 'confirm');
    const sibling = siblingPilot(h);
    const settingUp = sibling.setup(grant(), null);
    try {
      await entered.promise;
      if (edge === 'cancel-confirmation') {
        const operationId = h.state().mutation?.operationId;
        if (!operationId)
          throw new Error('Missing setup cancellation identity');
        expect(await h.pilot.authority.cancel(operationId)).toEqual({
          kind: 'removed',
        });
      } else await h.pilot.quiesce();
      release.resolve();
      const result = await settingUp;
      expect(result.kind).not.toBe('ready');
      expect(h.put).toHaveBeenCalledTimes(
        edge === 'persisted' || edge === 'resume-list' ? 1 : 0,
      );
      expect(confirm).not.toHaveBeenCalled();
      expect(h.state().head).toBeNull();
      expect(h.preferences().copilotVaultSelection?.state).not.toBe('selected');
      expect(h.preferences().copilotEnabled).toBe(false);
      if (edge !== 'cancel-confirmation')
        expect(h.pilot.authority.recipientGeneration()).toBeUndefined();
      expect(h.natives).toHaveLength(1);
      expect(h.natives[0]?.runtime.close).toHaveBeenCalled();
    } finally {
      release.resolve();
      await settingUp;
      sibling.close();
      h.pilot.close();
    }
  },
);

it.each([
  'head-ack',
  'caller-abort',
  'caller-abort-committed',
  'selection-submit',
  'pre-head-read',
] as const)(
  'P8 lifetime oracle: setup continuation fences %s without rolling back submitted writes',
  async (edge) => {
    const h = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const controller = new AbortController();
    const pause = async (): Promise<void> => {
      entered.resolve();
      await release.promise;
    };
    if (edge === 'selection-submit') {
      const confirm = h.selection.confirm.bind(h.selection);
      jest.spyOn(h.selection, 'confirm').mockImplementation(async (request) => {
        await pause();
        return confirm(request);
      });
    } else if (edge === 'pre-head-read') {
      const read = h.pilotOptions.journal.read.bind(h.pilotOptions.journal);
      jest
        .spyOn(h.pilotOptions.journal, 'read')
        .mockImplementation(async () => {
          const result = await read();
          if (h.preferences().copilotEnabled) await pause();
          return result;
        });
    } else {
      const journal = h.pilotOptions.journal;
      const compare = journal.compareExchange.bind(journal);
      jest
        .spyOn(journal, 'compareExchange')
        .mockImplementation(async (sequence, next) => {
          const result = await compare(sequence, next);
          if (
            edge === 'head-ack'
              ? !!next.head && !next.mutation
              : !!next.mutation?.probeConfirmed &&
                Boolean(next.mutation.committed) ===
                  (edge === 'caller-abort-committed')
          )
            await pause();
          return result;
        });
    }
    const setup = h.pilot.setup(grant(), null, controller.signal);
    try {
      await entered.promise;
      if (edge === 'caller-abort' || edge === 'caller-abort-committed')
        controller.abort();
      else await h.pilot.quiesce();
      release.resolve();
      const result = await setup;
      expect(result.kind).not.toBe('ready');
      expect(h.put).toHaveBeenCalledTimes(edge === 'caller-abort' ? 0 : 1);
      expect(h.preferences().copilotEnabled).toBe(
        edge === 'selection-submit' ||
          edge === 'pre-head-read' ||
          edge === 'head-ack',
      );
      if (edge === 'head-ack') expect(h.state().head).not.toBeNull();
      else expect(h.state().head).toBeNull();
      if (!edge.startsWith('caller-abort')) {
        expect(h.pilot.authority.recipientGeneration()).toBeUndefined();
        expect((await h.pilot.authority.demand()).kind).not.toBe('ready');
      }
      expect(h.natives).toHaveLength(1);
      expect(h.natives[0]?.runtime.close).toHaveBeenCalled();
    } finally {
      release.resolve();
      await setup;
      h.pilot.close();
    }
  },
);

it('P8 lifetime oracle: Connect abort after head acknowledgement uses exact P4 cleanup', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const controller = new AbortController();
  const journal = h.pilotOptions.journal;
  const compare = journal.compareExchange.bind(journal);
  jest
    .spyOn(journal, 'compareExchange')
    .mockImplementation(async (sequence, next) => {
      const result = await compare(sequence, next);
      if (next.head && !next.mutation && !next.removal && !next.completed) {
        entered.resolve();
        await release.promise;
      }
      return result;
    });
  const authorize = jest.fn(() => Promise.resolve(grant()));
  const backend = createCopilotVaultConnection({
    port: h.port,
    installation: () => Promise.resolve(base),
    preferences: () =>
      Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
    authorize,
  });
  const connecting = backend
    .connectCopilot(controller.signal, () => undefined)
    .then(
      () => 'connected',
      () => 'cancelled',
    );
  try {
    await entered.promise;
    const head = h.state().head;
    if (!head) throw new Error('Missing already-submitted durable head');
    expect(h.preferences().copilotEnabled).toBe(true);
    controller.abort();
    release.resolve();
    const outcome = await connecting;
    expect({
      outcome,
      head: h.state().head,
      mutation: h.state().mutation,
      enabled: h.preferences().copilotEnabled,
      deleted: h.remove.mock.calls.length,
    }).toEqual({
      outcome: 'cancelled',
      head: null,
      mutation: null,
      enabled: false,
      deleted: 1,
    });
    expect(h.remove.mock.calls[0]?.[0].ref).toEqual(head.pin.ref);
    expect(h.remove.mock.calls[0]?.[0].expectedRevision).toBe(
      head.pin.revision,
    );
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(h.refresh).not.toHaveBeenCalled();
    await expect(
      backend.connectCopilot(new AbortController().signal, () => undefined),
    ).resolves.toMatchObject({ phase: 'connected' });
    expect(authorize).toHaveBeenCalledTimes(2);
    expect(h.state().head?.operationId).not.toBe(head.operationId);
  } finally {
    release.resolve();
    await connecting;
    h.pilot.close();
  }
});

it('P8 lifetime oracle: cancelled setup cleanup cannot remove a foreign published operation', async () => {
  const h = fixture();
  try {
    const head = ready(await h.pilot.setup(grant(), null));
    const controller = new AbortController();
    const remove = jest.spyOn(h.port, 'remove');
    let stale = true;
    const backend = createCopilotVaultConnection({
      port: {
        ...h.port,
        status: () => {
          if (!stale) return h.port.status();
          stale = false;
          return Promise.resolve({ kind: 'blocked', reason: 'absent' });
        },
        setup: () => {
          controller.abort();
          return Promise.resolve({
            kind: 'blocked',
            reason: 'changed',
            setupOperationId: 'superseded-setup',
          });
        },
      },
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize: () => Promise.resolve(grant()),
    });
    await expect(
      backend.connectCopilot(controller.signal, () => undefined),
    ).rejects.toThrow();
    expect(remove).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
    expect(h.state().head).toEqual(head);
    expect(h.preferences().copilotEnabled).toBe(true);
  } finally {
    h.pilot.close();
  }
});

it.each(['resume', 'cancel'])(
  'P8 lifetime oracle: sibling %s respects exact live setup ownership',
  async (action) => {
    const h = fixture();
    const entered = deferred<void>();
    const release = deferred<void>();
    const prepare = h.selection.prepare.bind(h.selection);
    jest.spyOn(h.selection, 'prepare').mockImplementation(async (...args) => {
      const prepared = await prepare(...args);
      entered.resolve();
      await release.promise;
      return prepared;
    });
    const sibling = siblingPilot(h);
    const settingUp = h.pilot.setup(grant(), null);
    try {
      await entered.promise;
      const mutation = h.state().mutation;
      if (!mutation) throw new Error('Missing live setup');
      if (action === 'resume') {
        expect(
          (await sibling.authority.resume(mutation.operationId)).kind,
        ).not.toBe('removed');
        expect(h.state().mutation?.operationId).toBe(mutation.operationId);
        expect(h.state().mutation?.cancelling).toBe(false);
      } else {
        expect(await sibling.authority.cancel(mutation.operationId)).toEqual({
          kind: 'removed',
        });
      }
      release.resolve();
      expect((await settingUp).kind).toBe(
        action === 'resume' ? 'ready' : 'blocked',
      );
      expect(h.natives).toHaveLength(action === 'resume' ? 1 : 0);
    } finally {
      release.resolve();
      await settingUp;
      sibling.close();
      h.pilot.close();
    }
  },
);

it('P8 lifetime oracle: sibling quiescence aborts a pending runtime start and closes its late result', async () => {
  const h = fixture();
  const start = h.pilotOptions.start.bind(h.pilotOptions);
  const entered = deferred<void>();
  const release = deferred<void>();
  let openingSignal: AbortSignal | undefined;
  h.pilotOptions.start = async (
    ...args
  ): ReturnType<CopilotVaultPilotOptions['start']> => {
    openingSignal = args[1];
    const runtime = await start(...args);
    entered.resolve();
    await release.promise;
    return runtime;
  };
  const sibling = siblingPilot(h);
  const settingUp = h.pilot.setup(grant(), null);
  try {
    await entered.promise;
    await sibling.quiesce();
    expect(openingSignal?.aborted).toBe(true);
    release.resolve();
    expect((await settingUp).kind).not.toBe('ready');
    expect(h.natives[0]?.runtime.close).toHaveBeenCalled();
  } finally {
    release.resolve();
    await settingUp;
    sibling.close();
    h.pilot.close();
  }
});

it('P8 lifetime oracle: sibling quiescence eagerly aborts existing ordinary hosts', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  const entered = deferred<void>();
  const release = deferred<void>();
  const models = h.list.getMockImplementation();
  if (!models) throw new Error('Missing models fixture');
  h.list.mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return models();
  });
  const sibling = siblingPilot(h);
  const result = h.backend.listCopilotModels(new AbortController().signal).then(
    () => 'delivered',
    () => 'refused',
  );
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        entered.promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Models request did not enter provider')),
            1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await sibling.quiesce();
    expect(h.natives[1]?.runtime.close).toHaveBeenCalled();
    release.resolve();
    expect(await result).toBe('refused');
  } finally {
    release.resolve();
    await result;
    sibling.close();
    h.pilot.close();
  }
});

it('P8 lifetime oracle: receipt recovery is single-flight across reconstructed journal wrappers', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const recover = jest.fn(() => {
    entered.resolve();
    return release.promise;
  });
  h.pilotOptions.recoverRuntimeReceipts = recover;
  const sibling = siblingPilot(h);
  const first = h.pilot.recoverRuntimeReceipts();
  const second = sibling.recoverRuntimeReceipts();
  try {
    await entered.promise;
    release.resolve();
    await Promise.all([first, second]);
    expect(recover).toHaveBeenCalledTimes(1);
    const reconstructed = siblingPilot(h);
    try {
      await reconstructed.recoverRuntimeReceipts();
      expect(recover).toHaveBeenCalledTimes(1);
    } finally {
      reconstructed.close();
    }
  } finally {
    release.resolve();
    sibling.close();
    h.pilot.close();
  }
});

it('P8 lifetime oracle: absent recovery never poisons a real owner and failed recovery retries across pilots', async () => {
  const h = fixture();
  await h.pilot.recoverRuntimeReceipts();
  const recover = jest.fn<Promise<void>, []>(() =>
    Promise.reject(new Error('unresolved receipt')),
  );
  h.pilotOptions.recoverRuntimeReceipts = recover;
  const sibling = siblingPilot(h);
  try {
    await expect(sibling.recoverRuntimeReceipts()).rejects.toThrow();
    recover.mockResolvedValue(undefined);
    await h.pilot.recoverRuntimeReceipts();
    await sibling.recoverRuntimeReceipts();
    expect(recover).toHaveBeenCalledTimes(2);
  } finally {
    sibling.close();
    h.pilot.close();
  }
});

it('P8 lifetime oracle: recovery namespace and trusted boot are independently isolated', async () => {
  const h = fixture();
  const owner = {};
  const recover = jest.fn(() => Promise.resolve());
  const first = siblingPilot(h, {
    runtimeReceiptOwner: owner,
    recoverRuntimeReceipts: recover,
  });
  const same = siblingPilot(h, {
    runtimeReceiptOwner: owner,
    recoverRuntimeReceipts: recover,
  });
  const other = siblingPilot(h, {
    runtimeReceiptOwner: {},
    recoverRuntimeReceipts: recover,
  });
  const nextBoot = siblingPilot(h, {
    runtimeReceiptOwner: owner,
    processLifetime: {},
    recoverRuntimeReceipts: recover,
  });
  try {
    await first.recoverRuntimeReceipts();
    await same.recoverRuntimeReceipts();
    expect(recover).toHaveBeenCalledTimes(1);
    await other.recoverRuntimeReceipts();
    expect(recover).toHaveBeenCalledTimes(2);
    await nextBoot.recoverRuntimeReceipts();
    expect(recover).toHaveBeenCalledTimes(3);
  } finally {
    first.close();
    same.close();
    other.close();
    nextBoot.close();
    h.pilot.close();
  }
});

it('runs the real device flow and identity ingress, then a P3 entitlement RPC before the vault write and receipt', async () => {
  const h = fixture();
  let polls = 0;
  const progress: CopilotConnectionStatus[] = [];
  const supplied = await authorizeCopilotSetup({
    base,
    signal: new AbortController().signal,
    progress: (status) => {
      progress.push(status);
    },
    flow: {
      clientId: 'client',
      sleep: () => Promise.resolve(),
      fetch: (input) => {
        if (typeof input === 'string' && input.endsWith('/login/device/code'))
          return Promise.resolve(
            Response.json({
              device_code: 'private-device',
              user_code: 'PUBLIC-CODE',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 1,
            }),
          );
        polls++;
        return Promise.resolve(
          Response.json(
            polls === 1
              ? { error: 'authorization_pending' }
              : {
                  access_token: ACCESS,
                  refresh_token: REFRESH,
                  expires_in: 7200,
                  refresh_token_expires_in: 86400,
                },
          ),
        );
      },
    },
    install: (report) => {
      report('installing', 100);
      return Promise.resolve();
    },
    identity: (access) => {
      expect(access).toBe(ACCESS);
      expect(h.put).not.toHaveBeenCalled();
      return Promise.resolve({ login: 'pilot', id: '123' });
    },
  });
  h.list.mockImplementation(() => {
    expect(h.put).not.toHaveBeenCalled();
    return Promise.resolve({ models: [] });
  });
  const result = await h.pilot.setup(supplied, null);
  expect(result.kind).toBe('ready');
  expect(polls).toBe(2);
  expect(h.list).toHaveBeenCalledTimes(1);
  expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
  expect(h.put).toHaveBeenCalledTimes(1);
  expect(progress.map((status) => status.phase)).toEqual([
    'installing',
    'authorizing',
    'checking',
  ]);
  expect(JSON.stringify([progress, result, h.preferences()])).not.toMatch(
    /p6-access-secret|p6-refresh-secret|private-device/,
  );
  h.pilot.close();
});

it.each(['failed', 'lost'] as const)(
  'reconciles the exact setup after a %s pin acknowledgement, without another provider flow or vault create',
  async (mode) => {
    const h = fixture();
    if (mode === 'failed') h.failPin();
    else h.losePin();
    const result = await h.pilot.setup(grant(), null);
    expect(result).toEqual({
      kind: 'blocked',
      reason: 'unconfirmed',
      setupOperationId: h.state().mutation?.operationId,
    });
    const pending = await h.pilot.authority.status();
    if (pending.kind !== 'pending') throw new Error('No pending operation');
    const head = ready(await h.pilot.authority.resume(pending.operationId));
    expect(head.operationId).toBe(pending.operationId);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.put).toHaveBeenCalledTimes(1);
    h.pilot.close();
  },
);

it('never lets old confirms, prepares or disables roll back a newer pin, even for the same host and login', async () => {
  const h = fixture();
  const first = ready(await h.pilot.setup(grant(), null));
  expect(await h.pilot.authority.remove(first.epoch)).toEqual({
    kind: 'removed',
  });
  const second = ready(await h.pilot.setup(grant(), first.pinGeneration));
  const snapshot = structuredClone(h.preferences());
  expect(await h.selection.confirm(first)).toEqual({ kind: 'superseded' });
  expect(await h.selection.prepare(first, second.pinGeneration)).toBe(false);
  await h.selection.abandon(first);
  await h.selection.abandon(second);
  expect(
    await h.selection.disable({ operationId: 'late-removal', head: first }),
  ).toEqual({ kind: 'unconfirmed' });
  expect(h.preferences()).toEqual(snapshot);
  expect(h.preferences().copilotVaultSelection?.identity.operationId).toBe(
    second.operationId,
  );
  h.pilot.close();
});

it.each([
  'journal',
  'primary',
  'acknowledgement',
  'unreadable-acknowledgement',
] as const)(
  'reconciles receipt CAS through the preferences repository after a failed %s, without losing a usage-data denial',
  async (failure) => {
    jest
      .spyOn(PreferencesEnvironment, 'preferencesNormalizationEnvironment')
      .mockReturnValue({
        resolveAvailableModel: () => null,
        ollamaEnabled: () => false,
        shortcutPlatform: () => 'darwin',
      });
    const document = new MemoryPreferencesDocument(
      'copilot-consent-' + failure,
    );
    let denied: Awaited<ReturnType<ConsentJournal['read']>> = [];
    let fail = false;
    const journal: ConsentJournal = {
      read: () => Promise.resolve(denied),
      write: (next): Promise<void> => {
        if (fail && failure === 'journal')
          return Promise.reject(new Error('journal failed'));
        denied = [...next];
        return Promise.resolve();
      },
      deny: jest.fn(),
    };
    const install = document.install.bind(document);
    jest
      .spyOn(document, 'install')
      .mockImplementation(async (slot, content) => {
        if (fail && slot === 'primary' && failure === 'primary')
          throw new Error('primary failed');
        await install(slot, content);
        if (
          fail &&
          slot === 'primary' &&
          failure === 'unreadable-acknowledgement'
        )
          document.readFailures.set('primary', new Error('primary unreadable'));
        if (fail && slot === 'primary' && failure.includes('acknowledgement'))
          throw new Error('acknowledgement lost');
      });
    const open = (): PreferencesRepository<DomainPreferencesData> =>
      createPreferencesRepository({
        document: () =>
          withUsageDataConsentJournal(
            {
              key: document.key,
              readText: (slot) => document.readText(slot),
              exists: (slot) => document.exists(slot),
              install: (slot, content) => document.install(slot, content),
              ensureFolder: () => document.ensureFolder(),
              slotPath: (slot) => document.slotPath(slot),
              backupLocation: (stamp) => document.backupLocation(stamp),
              installBackup: (location, content) =>
                document.installBackup(location, content),
              pruneBackups: () => document.pruneBackups(),
            },
            journal,
          ),
        codec: DESKTOP_PREFERENCES_CODEC,
        hooks: {
          beforeSave: async ({ next }) => {
            await recordUsageDataRevocations(journal, next.usageData);
          },
        },
        log: { error: jest.fn() },
      });
    let store = open();
    const receipt = createCopilotSelectionReceipt({
      read: async () => {
        const read = await store.readAuthority();
        if (read.authority !== 'ok' && read.authority !== 'absent')
          throw new Error('Preferences authority unavailable');
        return read.preferences;
      },
      update: async (updater) => (await store.update(updater)).next,
    });
    const identity = {
      operationId: 'consent-setup',
      epoch: 'consent-epoch',
      account: { host: 'https://github.com', login: 'pilot', id: '123' },
      origin: 'setup' as const,
    };
    const request = {
      ...identity,
      pin: { ref: { vaultId: 'vault', entryId: 'entry' }, revision: 1 },
    };
    expect(await receipt.prepare(identity, null)).toBe(true);
    await store.flush();
    // A pre-journal profile can already contain an opt-out.
    const prepared = await store.read('persisted');
    document.slots.set(
      'primary',
      JSON.stringify({
        version: 1,
        generation: 1,
        preferences: {
          ...prepared,
          usageData: { ...prepared.usageData, productAnalytics: false },
        },
      }),
    );
    fail = true;
    expect((await receipt.confirm(request)).kind).toBe(
      failure === 'acknowledgement' ? 'confirmed' : 'unconfirmed',
    );
    fail = false;
    document.readFailures.clear();
    store = open();
    const confirmed = await receipt.confirm(request);
    if (confirmed.kind !== 'confirmed') throw new Error('Pin not confirmed');
    expect(denied).toContain('productAnalytics');
    expect(
      (await store.readAuthority()).preferences.usageData.productAnalytics,
    ).toBe(false);
    await store.flush();
    const oldLastGood = document.slots.get('lastGood');
    if (!oldLastGood) throw new Error('Missing last-good');
    expect(
      await receipt.disable({
        operationId: 'disconnect',
        head: confirmed.receipt,
      }),
    ).toEqual({ kind: 'disabled' });
    const newerIdentity = {
      ...identity,
      operationId: 'newer-setup',
      epoch: 'newer-epoch',
    };
    const newer = { ...request, ...newerIdentity };
    expect(
      await receipt.prepare(newerIdentity, confirmed.receipt.pinGeneration),
    ).toBe(true);
    expect((await receipt.confirm(newer)).kind).toBe('confirmed');
    await store.flush();
    expect(await receipt.confirm(request)).toEqual({ kind: 'superseded' });
    // Served last-good must never become authority for an older pin.
    document.slots.set('lastGood', oldLastGood);
    document.slots.set('primary', '{');
    store = open();
    expect(
      (await store.read('persisted')).copilotVaultSelection?.identity
        .operationId,
    ).toBe(request.operationId);
    expect(await receipt.confirm(request)).toEqual({ kind: 'unconfirmed' });
    expect(await receipt.confirm(newer)).toEqual({ kind: 'unconfirmed' });
    expect(document.slots.get('primary')).toBe('{');
    expect(denied).toContain('productAnalytics');
  },
);

it('ignores unrelated preference generations but requires the exact receipt to disable', async () => {
  const h = fixture();
  const head = ready(await h.pilot.setup(grant(), null));
  h.setPreferences({ ...structuredClone(h.preferences()) });
  const receipt = h.preferences().copilotVaultSelection;
  if (!receipt) throw new Error('Missing receipt');
  h.setPreferences({
    ...h.preferences(),
    copilotVaultSelection: {
      ...receipt,
      pin: { ...head.pin, revision: head.pin.revision + 1 },
    },
  });
  expect(
    await h.selection.disable({ operationId: 'stale-revision', head }),
  ).toEqual({ kind: 'unconfirmed' });
  h.setPreferences({ ...h.preferences(), copilotVaultSelection: receipt });
  expect(
    await h.selection.disable({
      operationId: 'wrong-operation',
      head: { ...head, operationId: 'different' },
    }),
  ).toEqual({ kind: 'unconfirmed' });
  expect(
    await h.selection.disable({
      operationId: 'disconnect',
      head: { ...head, pinGeneration: 'wrong' },
    }),
  ).toEqual({ kind: 'unconfirmed' });
  expect(h.preferences().copilotEnabled).toBe(true);
  expect(
    await h.selection.disable({ operationId: 'disconnect', head }),
  ).toEqual({ kind: 'disabled' });
  expect(await h.selection.confirm(head)).toEqual({ kind: 'superseded' });
  h.pilot.close();
});

it('disconnects the latest revision after refresh without mistaking the original selection receipt for a different pin', async () => {
  const h = fixture();
  const head = ready(
    await h.pilot.setup(
      {
        ...grant(),
        accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
      },
      null,
    ),
  );
  h.refreshSuccess();
  await h.backend.listCopilotModels(new AbortController().signal);
  const current = ready(await h.pilot.authority.status());
  expect(current.pin.revision).toBe(head.pin.revision + 1);
  expect(h.preferences().copilotVaultSelection?.pin?.revision).toBe(
    head.pin.revision,
  );
  expect(await h.pilot.authority.remove(current.epoch)).toEqual({
    kind: 'removed',
  });
  expect(h.preferences().copilotEnabled).toBe(false);
  h.pilot.close();
});

it('refuses failed entitlement before any vault entry and does not strand the next Connect', async () => {
  const h = fixture();
  h.list.mockRejectedValueOnce(new Error(ACCESS));
  const failed = await h.pilot.setup(grant(), null);
  expect(failed).toEqual({
    kind: 'probe-failed',
    reason: 'no-access',
    setupOperationId: failed.setupOperationId,
  });
  expect(typeof failed.setupOperationId).toBe('string');
  expect(h.put).not.toHaveBeenCalled();
  expect(h.preferences().copilotEnabled).toBe(false);
  const generation = h.preferences().copilotVaultSelection?.pinGeneration;
  expect(generation).toBeDefined();
  expect((await h.pilot.setup(grant(), generation ?? null)).kind).toBe('ready');
  h.pilot.close();
});

it.each(
  ['failed', 'lost'].flatMap((mode) =>
    [false, true].flatMap((restart) =>
      [false, true].map((previousRemoval) => ({
        mode,
        restart,
        previousRemoval,
      })),
    ),
  ),
)(
  'recovers Connect after failed entitlement and $mode abandonment, restart=$restart, previous removal=$previousRemoval',
  async ({ mode, restart, previousRemoval }) => {
    const h = fixture();
    let pilot = h.pilot;
    const authorize = jest.fn(() => Promise.resolve(grant()));
    function backend(): CopilotConnectionBackend {
      return createCopilotVaultConnection({
        port: {
          ...h.port,
          ...pilot,
          status: () => pilot.authority.status(),
          resume: (id) => pilot.authority.resume(id),
          cancel: (id) => pilot.authority.cancel(id),
          remove: (epoch) => pilot.authority.remove(epoch),
        },
        installation: () => Promise.resolve(base),
        preferences: () =>
          Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
        authorize,
      });
    }
    try {
      if (previousRemoval) {
        const first = ready(await pilot.setup(grant(), null));
        expect(await pilot.authority.remove(first.epoch)).toEqual({
          kind: 'removed',
        });
      }
      h.put.mockClear();
      h.remove.mockClear();
      h.list.mockClear();
      const abandon = h.selection.abandon.bind(h.selection);
      const abandoning = jest
        .spyOn(h.selection, 'abandon')
        .mockImplementation(async (identity) => {
          if (mode === 'lost') await abandon(identity);
          throw new Error('Preference acknowledgement unavailable');
        });
      h.list.mockRejectedValueOnce(new Error('Entitlement unavailable'));
      let connection = backend();
      await expect(
        connection.connectCopilot(
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toThrow("doesn't have Copilot access");
      const failed = h.preferences().copilotVaultSelection;
      if (!failed) throw new Error('Missing failed setup receipt');
      const operationId = failed.identity.operationId;
      expect(h.state().mutation?.cancelling).toBe(true);
      expect(await pilot.authority.status()).toEqual({
        kind: 'pending',
        operationId,
        operation: { kind: 'create', origin: 'setup' },
      });
      expect(failed.state).toBe(mode === 'lost' ? 'disabled' : 'prepared');
      expect(h.put).not.toHaveBeenCalled();
      expect(h.remove).not.toHaveBeenCalled();
      if (restart) {
        pilot.close();
        pilot = createCopilotVaultPilot({
          ...h.pilotOptions,
          processLifetime: {}, // Simulated process restart, not a sibling journal wrapper.
          journal: { ...h.pilotOptions.journal },
        });
        connection = backend();
      }
      await expect(
        connection.connectCopilot(
          new AbortController().signal,
          () => undefined,
        ),
      ).rejects.toThrow();
      expect(await pilot.authority.status()).toEqual({
        kind: 'pending',
        operationId,
        operation: { kind: 'create', origin: 'setup' },
      });
      expect(abandoning).toHaveBeenCalledTimes(2);
      for (const [identity] of abandoning.mock.calls)
        expect(identity).toEqual(failed.identity);
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.put).not.toHaveBeenCalled();
      abandoning.mockRestore();
      await expect(
        connection.connectCopilot(
          new AbortController().signal,
          () => undefined,
        ),
      ).resolves.toMatchObject({ enabled: true });
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.state().mutation).toBeNull();
      const selected = h.preferences().copilotVaultSelection;
      expect(selected?.state).toBe('selected');
      expect(selected?.identity.operationId).not.toBe(operationId);
      await h.selection.abandon(failed.identity);
      expect(h.preferences().copilotVaultSelection).toEqual(selected);
      const runtime = await connection.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      await expect(runtime.runTurn(turn())).resolves.toMatchObject({
        text: 'Verified evidence',
      });
    } finally {
      pilot.close();
    }
  },
);

it.each(
  ['refused', 'lost'].flatMap((checkpoint) =>
    [false, true].map((restart) => ({ checkpoint, restart })),
  ),
)(
  'recovers failed entitlement with a $checkpoint cancellation checkpoint, restart=$restart',
  async ({ checkpoint, restart }) => {
    const h = fixture();
    let pilot = h.pilot;
    const compareExchange = h.pilotOptions.journal.compareExchange.bind(
      h.pilotOptions.journal,
    );
    jest
      .spyOn(h.pilotOptions.journal, 'compareExchange')
      .mockImplementation(async (sequence, next) => {
        if (next.mutation?.cancelling && !h.state().mutation?.cancelling) {
          if (checkpoint === 'lost') await compareExchange(sequence, next);
          throw new Error('Journal checkpoint unavailable');
        }
        return compareExchange(sequence, next);
      });
    h.list.mockRejectedValueOnce(new Error('Entitlement unavailable'));
    try {
      expect(await pilot.setup(grant(), null)).toEqual({
        kind: 'probe-failed',
        reason: 'no-access',
        setupOperationId: h.state().mutation?.operationId,
      });
      expect(h.state().mutation?.cancelling).toBe(checkpoint === 'lost');
      expect(h.preferences().copilotVaultSelection?.state).toBe('prepared');
      expect(h.put).not.toHaveBeenCalled();
      jest.restoreAllMocks();
      if (restart) {
        pilot.close();
        pilot = createCopilotVaultPilot({
          ...h.pilotOptions,
          processLifetime: {},
          journal: { ...h.pilotOptions.journal },
        });
      }
      const connection = createCopilotVaultConnection({
        port: {
          ...h.port,
          ...pilot,
          status: () => pilot.authority.status(),
          resume: (id) => pilot.authority.resume(id),
          cancel: (id) => pilot.authority.cancel(id),
          remove: (epoch) => pilot.authority.remove(epoch),
        },
        installation: () => Promise.resolve(base),
        preferences: () =>
          Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
        authorize: () => Promise.resolve(grant()),
      });
      await expect(
        connection.connectCopilot(
          new AbortController().signal,
          () => undefined,
        ),
      ).resolves.toMatchObject({ enabled: true });
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
    } finally {
      pilot.close();
    }
  },
);

it.each(['checkpoint', 'completion'] as const)(
  'retains failed-probe cleanup when the %s CAS returns false',
  async (stage) => {
    const h = fixture();
    const exchange = h.pilotOptions.journal.compareExchange.bind(
      h.pilotOptions.journal,
    );
    let refused = false;
    jest
      .spyOn(h.pilotOptions.journal, 'compareExchange')
      .mockImplementation((sequence, next) => {
        const target =
          stage === 'checkpoint'
            ? next.mutation?.cancelling && !h.state().mutation?.cancelling
            : next.mutation === null &&
              next.completed?.operationId.endsWith(':cancel');
        if (target && !refused) {
          refused = true;
          return Promise.resolve(false);
        }
        return exchange(sequence, next);
      });
    h.list.mockRejectedValueOnce(new Error('Entitlement unavailable'));
    try {
      expect(await h.pilot.setup(grant(), null)).toEqual({
        kind: 'probe-failed',
        reason: 'no-access',
        setupOperationId: h.state().mutation?.operationId,
      });
      expect(refused).toBe(true);
      const mutation = h.state().mutation;
      if (!mutation) throw new Error('Cleanup identity was lost');
      expect(h.put).not.toHaveBeenCalled();
      expect(await h.pilot.authority.resume(mutation.operationId)).toEqual({
        kind: 'removed',
      });
      expect(h.state().mutation).toBeNull();
      const previous = h.preferences().copilotVaultSelection;
      expect(previous?.state).toBe('disabled');
      ready(await h.pilot.setup(grant(), previous?.pinGeneration ?? null));
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.remove).not.toHaveBeenCalled();
    } finally {
      h.pilot.close();
    }
  },
);

it('fences delayed cleanup from concurrent resume and cancel after a newer Connect', async () => {
  const h = fixture();
  const abandon = h.selection.abandon.bind(h.selection);
  jest
    .spyOn(h.selection, 'abandon')
    .mockRejectedValueOnce(new Error('Cleanup unavailable'));
  h.list.mockRejectedValueOnce(new Error('Entitlement unavailable'));
  const first = deferred<void>();
  const late = deferred<void>();
  const entered = deferred<void>();
  try {
    await h.pilot.setup(grant(), null);
    const pending = h.state().mutation;
    if (!pending?.cancelling) throw new Error('Cleanup was not retained');
    let calls = 0;
    jest.spyOn(h.selection, 'abandon').mockImplementation(async (identity) => {
      const call = ++calls;
      if (call === 2) entered.resolve();
      await (call === 1 ? first.promise : late.promise);
      await abandon(identity);
    });
    const resuming = h.pilot.authority.resume(pending.operationId);
    const cancelling = h.pilot.authority.cancel(pending.operationId);
    await entered.promise;
    first.resolve();
    expect(await Promise.race([resuming, cancelling])).toEqual({
      kind: 'removed',
    });
    const disabled = h.preferences().copilotVaultSelection;
    expect(disabled?.state).toBe('disabled');
    const newer = ready(
      await h.pilot.setup(grant(), disabled?.pinGeneration ?? null),
    );
    const selected = structuredClone(h.preferences().copilotVaultSelection);
    late.resolve();
    await Promise.all([resuming, cancelling]);
    expect(h.preferences().copilotVaultSelection).toEqual(selected);
    expect(await h.pilot.authority.status()).toEqual({
      kind: 'ready',
      head: newer,
    });
    expect(h.put).toHaveBeenCalledTimes(1);
    expect(h.remove).not.toHaveBeenCalled();
  } finally {
    first.resolve();
    late.resolve();
    h.pilot.close();
  }
});

it.each(['chat', 'delegation', 'pipeline'] as const)(
  'preserves %s-shaped history, prompt acceptance, tools, event ordering over the encoded P4/P5 composition',
  async (family) => {
    const h = fixture();
    ready(await h.pilot.setup(grant(), null));
    const events: string[] = [];
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const result = await runtime.runTurn(
      turn({
        turnId: family,
        preparePrompt: () => {
          events.push('history');
          return Promise.resolve('retained history');
        },
        onToolsReady: () => {
          events.push('tools');
        },
        onSession: () => {
          events.push('session');
        },
        onPromptAccepted: () => {
          events.push('accepted');
        },
        emit: () => {
          events.push('output');
        },
      }),
    );
    expect(events.slice(0, 4)).toEqual([
      'tools',
      'session',
      'history',
      'accepted',
    ]);
    expect(events).toContain('output');
    expect(h.natives[1]?.sends).toEqual(['retained history']);
    const resumed = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const models = await resumed.listModels(new AbortController().signal);
    expect(models[0]?.id).toBe('copilot:model');
    await resumed.close();
    expect(JSON.stringify(result)).not.toMatch(
      /p6-access-secret|p6-refresh-secret/,
    );
    h.pilot.close();
  },
);

it('resumes an exact conversation and recovers missing interactive context only under a new create lease', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  const opens = jest.spyOn(h.port, 'open');
  const first = await h.backend.openManagedCopilotRuntime({
    owner: TEST_OWNER,
    signal: new AbortController().signal,
  });
  const resumed = await first.runTurn(turn({ sessionId: 'existing' }));
  expect(resumed.sessionId).toBe('existing');
  h.missingResume();
  const notices = jest.fn();
  const second = await h.backend.openManagedCopilotRuntime({
    owner: TEST_OWNER,
    signal: new AbortController().signal,
  });
  await second.runTurn(
    turn({ sessionId: 'missing', onSessionUnavailable: notices }),
  );
  expect(notices).toHaveBeenCalledTimes(1);
  expect(opens.mock.calls.map((call) => call[1].kind)).toEqual([
    'resume',
    'resume',
    'create',
  ]);
  expect(h.natives[2]?.runtime.client.createSession).not.toHaveBeenCalled();
  expect(h.natives[3]?.sends).toEqual(['hello']);
  h.pilot.close();
});

it('keeps copied caller ownership in trusted launch policy, never in recipient frames', async () => {
  const h = fixture();
  const frames: string[] = [];
  try {
    ready(await h.pilot.setup(grant(), null));
    const open = h.port.open.bind(h.port);
    jest
      .spyOn(h.port, 'open')
      .mockImplementation(async (purpose, audience, policy, write) => {
        const channel = await open(purpose, audience, policy, (encoded) => {
          frames.push(encoded);
          return write(encoded);
        });
        return {
          ...channel,
          receive: (encoded): Promise<void> => {
            frames.push(encoded);
            return channel.receive(encoded);
          },
        };
      });
    const owner = { kind: 'turn' as const, id: 'host-only-owner-sentinel' };
    const handle = await h.backend.openManagedCopilotRuntime({
      signal: new AbortController().signal,
      owner,
    });
    owner.id = 'later-mutation';
    await handle.runTurn(turn());
    expect(h.launches[1]?.owner).toEqual({
      kind: 'turn',
      id: 'host-only-owner-sentinel',
    });
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.join('')).not.toContain('host-only-owner-sentinel');
    expect(frames.join('')).not.toContain('later-mutation');
  } finally {
    h.pilot.close();
  }
});

it('carries selected setup, discovery and caller ownership through the runtime to the process spawner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p6-process-owner-'));
  class HostProcess extends EventEmitter implements CopilotProcess {
    readonly pid = 12345;
    readonly stdin = null;
    readonly stdout = new PassThrough();
    readonly stderr = new PassThrough();
    readonly stopped = deferred<void>();
    stop = jest.fn((): Promise<void> => {
      this.emit('close', null, 'SIGTERM');
      this.stopped.resolve();
      return Promise.resolve();
    });
  }
  const processes: HostProcess[] = [];
  const spawnProcess = jest.fn(
    (
      request: Parameters<CopilotRuntimeOptions['spawnProcess']>[0],
    ): CopilotProcess => {
      const child = new HostProcess();
      processes.push(child);
      child.stdout.write('listening on port 1234');
      expect(request.command).toBe('/trusted/copilot');
      return child;
    },
  );
  jest
    .spyOn(CopilotProcessOwnership, 'snapshotCopilotDescendants')
    .mockResolvedValue([]);
  jest
    .spyOn(CopilotProcessOwnership, 'terminateCopilotDescendants')
    .mockResolvedValue();
  const loader = jest.spyOn(CopilotModuleLoader, 'loadRequiredNodeModule');
  const h = fixture(
    false,
    undefined,
    (native) => {
      loader.mockReturnValue({
        CopilotClient: jest.fn(() => ({
          ...native.runtime.client,
          start: (): Promise<void> => Promise.resolve(),
          getStatus: (): Promise<{ version: string }> =>
            Promise.resolve({ version: 'fixture' }),
          stop: (): Promise<void> => Promise.resolve(),
          forceStop: (): Promise<void> => Promise.resolve(),
          rpc: {
            models: { list: h.list },
            account: { getQuota: h.quota },
            runtime: { shutdown: (): Promise<void> => Promise.resolve() },
          },
        })),
        RuntimeConnection: { forUri: jest.fn() },
      });
    },
    undefined,
    {
      executable: '/trusted/copilot',
      expectedVersion: 'fixture',
      workingDirectory: root,
      stateDirectory: join(root, 'state'),
      env: {},
      spawnProcess,
    },
  );
  const legacyOpen = jest.fn(h.backend.openManagedCopilotRuntime);
  const proxy = createCopilotConnectionProxy({
    legacy: { ...h.backend, openManagedCopilotRuntime: legacyOpen },
    selected: () => Promise.resolve(true),
    vault: () => h.backend,
    assertEnabled: () => undefined,
  });
  try {
    ready(await h.pilot.setup(grant(), null));
    await proxy.listCopilotModels(new AbortController().signal);
    await proxy.readCopilotAccountUsage(new AbortController().signal);
    const owners = OPEN_PARITY.owner.flatMap((row) =>
      row.owner ? [row.owner] : [],
    );
    for (const owner of owners) {
      const handle = await proxy.openManagedCopilotRuntime({
        owner,
        signal: new AbortController().signal,
      });
      await expect(handle.runTurn(turn())).resolves.toMatchObject({
        text: 'Verified evidence',
      });
    }
    expect(spawnProcess.mock.calls.map(([request]) => request.owner)).toEqual([
      { kind: 'discovery', id: 'copilot-setup-probe' },
      { kind: 'discovery', id: 'copilot-models' },
      { kind: 'discovery', id: 'copilot-quota' },
      ...owners.map((owner) => ({
        ...owner,
        id: copilotProcessOwnerId(owner.id),
      })),
    ]);
    expect(legacyOpen).not.toHaveBeenCalled();
  } finally {
    h.pilot.close();
    await Promise.all(processes.map((child) => child.stopped.promise));
    await rm(root, { recursive: true, force: true });
  }
});

it('routes model and nonempty quota reads through the same selected authority, with no SDK on the consumer handle', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  expect(
    (await h.backend.listCopilotModels(new AbortController().signal))[0]?.id,
  ).toBe('copilot:model');
  expect(
    await h.backend.readCopilotAccountUsage(new AbortController().signal),
  ).toEqual({
    account: { host: 'https://github.com', login: 'pilot' },
    limits: [
      {
        id: 'premium_interactions',
        label: 'Premium requests',
        unlimited: false,
        usedPercent: 25,
        resetsAt: '2027-01-01T00:00:00.000Z',
      },
      { id: 'chat', label: 'Chat', unlimited: true, usedPercent: 0 },
    ],
  });
  expect(h.launches.map((launch) => launch?.owner)).toEqual([
    { kind: 'discovery', id: 'copilot-setup-probe' },
    { kind: 'discovery', id: 'copilot-models' },
    { kind: 'discovery', id: 'copilot-quota' },
  ]);
  const runtime = await h.backend.openManagedCopilotRuntime({
    owner: TEST_OWNER,
    signal: new AbortController().signal,
  });
  expect(runtime).not.toHaveProperty('client');
  expect(runtime).not.toHaveProperty('tokenProvider');
  await runtime.close();
  h.pilot.close();
});

it.each(['throws', 'cancelled'] as const)(
  'fails approvals closed when the host %s, including a late allow',
  async (mode) => {
    const warnings = jest.spyOn(process, 'emitWarning');
    const h = fixture(true);
    ready(await h.pilot.setup(grant(), null));
    const accepted = deferred<void>(),
      asked = deferred<void>(),
      answer = deferred<{ decision: 'allow' }>();
    const abort = new AbortController();
    const observations: string[] = [];
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: abort.signal,
    });
    const running = runtime.runTurn(
      turn({
        signal: abort.signal,
        onEvent: (event) => {
          observations.push(event.type);
        },
        onPromptAccepted: () => {
          accepted.resolve();
        },
        authorize: async () => {
          asked.resolve();
          if (mode === 'throws') throw new Error(ACCESS);
          return answer.promise;
        },
      }),
    );
    void running.catch(() => undefined);
    await accepted.promise;
    const config = h.natives[1]?.configs[0];
    if (!config?.onEvent || !config.hooks?.onPreToolUse)
      throw new Error('Missing policy');
    config.onEvent({
      id: 'start',
      type: 'tool.execution_start',
      timestamp: new Date().toISOString(),
      parentId: null,
      data: { toolCallId: 'call', toolName: 'edit', arguments: {} },
    });
    const approving = config.hooks.onPreToolUse(
      {
        sessionId: 'session-1',
        timestamp: new Date(),
        workingDirectory: '/trusted/workspace',
        toolName: 'edit',
        toolArgs: {},
      },
      { sessionId: 'session-1' },
    );
    await asked.promise;
    if (mode === 'cancelled') {
      abort.abort();
      answer.resolve({ decision: 'allow' });
    }
    expect(await approving).toMatchObject({ permissionDecision: 'deny' });
    expect(observations).toContain('tool.execution_start');
    abort.abort();
    await expect(running).rejects.toThrow();
    expect(h.natives[1]?.runtime.close).toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    h.pilot.close();
  },
);

it('refuses a second composition for one journal and rejects Linux before process creation', async () => {
  const h = fixture();
  expect(() => createCopilotVaultPilot(h.pilotOptions)).toThrow(
    'already composed',
  );
  h.pilot.close();
  const other = fixture();
  other.pilot.close();
  const linux = createCopilotVaultPilot({
    ...other.pilotOptions,
    journal: { ...other.pilotOptions.journal },
    platform: 'linux',
  });
  expect((await linux.setup(grant(), null)).kind).toBe('blocked');
  expect(other.natives).toHaveLength(0);
  linux.close();
});

it('uses legacy only before durable selection and never after selection, a missing transport, or an unreadable selection', async () => {
  const h = fixture();
  const oldOpen = jest.fn(h.backend.openManagedCopilotRuntime);
  const legacy: CopilotConnectionBackend = {
    ...h.backend,
    openManagedCopilotRuntime: oldOpen,
  };
  let selected = false,
    unavailable = false,
    unreadable = false;
  const proxy = createCopilotConnectionProxy({
    legacy,
    selected: () => {
      if (unreadable) return Promise.reject(new Error('unreadable'));
      return Promise.resolve(selected);
    },
    vault: () => {
      if (unavailable) throw new Error('unavailable');
      return h.backend;
    },
    assertEnabled: () => undefined,
  });
  await proxy.copilotConnectionStatus();
  selected = true;
  unavailable = true;
  await expect(
    proxy.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('unavailable');
  expect(oldOpen).not.toHaveBeenCalled();
  selected = false;
  await expect(proxy.copilotConnectionStatus()).rejects.toThrow('unavailable');
  unreadable = true;
  await expect(proxy.copilotConnectionStatus()).rejects.toMatchObject({
    code: 'unavailable',
  });
  h.pilot.close();
});

it.each(['selected', 'unselected'] as const)(
  'refuses a %s acquisition revoked while selection is unresolved',
  async (custody) => {
    const h = fixture();
    const admission = deferred<boolean>();
    const entered = deferred<void>();
    const open = jest.fn(h.backend.openManagedCopilotRuntime);
    const proxy = createCopilotConnectionProxy({
      legacy: { ...h.backend, openManagedCopilotRuntime: open },
      selected: () => {
        entered.resolve();
        return admission.promise;
      },
      vault: () => ({ ...h.backend, openManagedCopilotRuntime: open }),
      assertEnabled: () => undefined,
    });
    try {
      ready(await h.pilot.setup(grant(), null));
      const input = { owner: TEST_OWNER, signal: new AbortController().signal };
      const pending = proxy.openManagedCopilotRuntime(input);
      const rejected = expect(pending).rejects.toThrow('revoked');
      await entered.promise;
      await proxy.revokeCopilotRuntimes();
      admission.resolve(custody === 'selected');
      await rejected;
      expect(open).not.toHaveBeenCalled();
      const runtime = await proxy.openManagedCopilotRuntime(input);
      expect(open).toHaveBeenCalledTimes(1);
      await runtime.close();
    } finally {
      h.pilot.close();
    }
  },
);

it('refuses an acquisition revoked during the initial selection drain', async () => {
  const h = fixture();
  const draining = deferred<void>();
  const released = deferred<void>();
  const open = jest.fn(h.backend.openManagedCopilotRuntime);
  const proxy = createCopilotConnectionProxy({
    legacy: {
      ...h.backend,
      revokeCopilotRuntimes: jest
        .fn(h.backend.revokeCopilotRuntimes)
        .mockImplementationOnce(() => {
          draining.resolve();
          return released.promise;
        }),
    },
    selected: () => Promise.resolve(true),
    vault: () => ({ ...h.backend, openManagedCopilotRuntime: open }),
    assertEnabled: () => undefined,
  });
  try {
    const pending = proxy.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const rejected = expect(pending).rejects.toThrow();
    await draining.promise;
    await proxy.revokeCopilotRuntimes();
    released.resolve();
    await rejected;
    expect(open).not.toHaveBeenCalled();
  } finally {
    h.pilot.close();
  }
});

it('never interprets served defaults from unreadable preferences as legacy custody or a durable pin acknowledgement', async () => {
  jest.mocked(readPreferencesFileDetailed).mockResolvedValue({
    authority: 'unreadable',
    preferences: DEFAULT_PREFERENCES,
  });
  await expect(readCopilotSelectionPreferences()).rejects.toThrow(
    'Copilot runtime is unavailable',
  );
});

it('cancelling copilot-connection:connect on an already connected account never deletes that account', async () => {
  const h = fixture();
  const head = ready(await h.pilot.setup(grant(), null));
  const abort = new AbortController();
  const observed = deferred<void>();
  const pending = deferred<CopilotGrantResult>();
  const statusRead = jest.spyOn(h.port, 'status').mockImplementationOnce(() => {
    observed.resolve();
    return pending.promise;
  });
  const connecting = h.backend.connectCopilot(abort.signal, () => undefined);
  void connecting.catch(() => undefined);
  await observed.promise;
  abort.abort();
  pending.resolve({ kind: 'ready', head });
  await expect(connecting).rejects.toThrow();
  expect(statusRead).toHaveBeenCalledTimes(1);
  expect(h.remove).not.toHaveBeenCalled();
  expect(ready(await h.pilot.authority.status())).toEqual(head);
  expect(h.preferences().copilotEnabled).toBe(true);
  h.pilot.close();
});

it('a revoked handle cannot resolve a delayed model result or publish a stale quota result', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  const pending = deferred<Awaited<ReturnType<typeof h.list>>>();
  const requested = deferred<void>();
  h.list.mockImplementationOnce(() => {
    requested.resolve();
    return pending.promise;
  });
  const reading = h.backend.listCopilotModels(new AbortController().signal);
  void reading.catch(() => undefined);
  await requested.promise;
  await h.backend.revokeCopilotRuntimes();
  pending.resolve({ models: [] });
  await expect(reading).rejects.toThrow();
  h.pilot.close();
});

it.each([
  { selected: false, thinkingLevel: undefined },
  { selected: true, thinkingLevel: undefined },
  { selected: false, thinkingLevel: 'high' },
  { selected: true, thinkingLevel: 'high' },
] as const)(
  'runs the production pipeline runner with selected=$selected, thinkingLevel=$thinkingLevel, preserving resume and usage',
  async ({ selected, thinkingLevel }) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-pipeline-'));
    const h = fixture();
    const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
    const proxy = createCopilotConnectionProxy({
      legacy: parityLegacyBackend(h, legacyNatives),
      selected: () => Promise.resolve(selected),
      vault: () => h.backend,
      assertEnabled: () => undefined,
    });
    try {
      ready(await h.pilot.setup(grant(), null));
      const model = (await h.list()).models[0];
      if (!model) throw new Error('Missing model fixture');
      h.list.mockResolvedValue({
        models: [
          {
            ...model,
            capabilities: {
              ...model.capabilities,
              supports: {
                ...model.capabilities.supports,
                reasoningEffort: true,
              },
            },
            supportedReasoningEfforts: ['low', 'high'],
          },
        ],
      });
      h.list.mockClear();
      const request = {
        cwd: root,
        repositoryPolicyScope: { kind: 'checkout' as const, root },
        executionsDir: root,
        executionId: 'execution',
        jobId: 'job',
        stepId: 'step',
        attempt: 1,
        environment: {},
        prompt: 'pipeline prompt',
        model: 'copilot:model',
        thinkingLevel,
        permissionPreset: 'plan' as const,
        totalTimeoutMs: 30000,
      };
      const host = {
        open: (
          signal: AbortSignal,
        ): ReturnType<CopilotConnectionBackend['openManagedCopilotRuntime']> =>
          proxy.openManagedCopilotRuntime({ owner: TEST_OWNER, signal }),
        authorize: (): void => undefined,
      };
      const result = await runCopilotPipelinePrompt(request, host);
      if (result.status !== 'success') throw new Error(JSON.stringify(result));
      expect(result).toMatchObject({
        status: 'success',
        rawText: 'Verified evidence',
        usage: { inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 3 },
      });
      const legacyNative = nativeRuntime();
      const legacy = await legacyNative.runtime.runTurn(turn());
      expect(result.usage.inputTokens).toBe(legacy.usage.input_tokens);
      expect(result.usage.cacheReadInputTokens).toBe(
        legacy.usage.cache_read_input_tokens,
      );
      expect(result.transcript).toContain('canopy_assistant_patch');
      const resumed = await runCopilotPipelinePrompt(
        { ...request, resumeSessionId: result.sessionId },
        host,
      );
      expect(resumed).toMatchObject({
        status: 'success',
        sessionId: result.sessionId,
      });
      const turns = (selected ? h.natives : legacyNatives).filter(
        (native) => native.sends.length > 0,
      );
      expect(turns).toHaveLength(2);
      expect(turns[1]?.runtime.client.resumeSession).toHaveBeenCalled();
      for (const native of turns) {
        expect(native.configs[0]?.systemMessage).toBeDefined();
        expect(native.configs[0]?.reasoningEffort).toBe(thinkingLevel);
      }
      expect(h.list).toHaveBeenCalledTimes(thinkingLevel ? 2 : 0);
      if (selected && thinkingLevel) {
        const reads = h.natives.filter((native) => native.configs.length === 0);
        // Setup plus two independent models reads; each turn still uses its session handle.
        expect(reads).toHaveLength(3);
      }
      expect(legacyNatives).toHaveLength(selected ? 0 : 2);
    } finally {
      h.pilot.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([0, 1, 3])(
  'P8 terminal vault fencing starts before %s proxy handles close and shutdown is idempotent',
  async (count) => {
    const h = fixture();
    ready(await h.pilot.setup(grant(), null));
    const release = deferred<void>();
    const entered = deferred<void>();
    const stopVault = jest.fn(h.backend.shutdownCopilotRuntimes);
    const stopLegacy = jest.fn(() => Promise.resolve());
    const selected: CopilotConnectionBackend = {
      ...h.backend,
      shutdownCopilotRuntimes: stopVault,
      async openManagedCopilotRuntime(input) {
        const runtime = await h.backend.openManagedCopilotRuntime(input);
        return {
          ...runtime,
          async close() {
            entered.resolve();
            await release.promise;
            await runtime.close();
          },
        };
      },
    };
    const proxy = createCopilotConnectionProxy({
      legacy: {
        ...h.backend,
        revokeCopilotRuntimes: () => Promise.resolve(),
        shutdownCopilotRuntimes: stopLegacy,
      },
      selected: () => Promise.resolve(true),
      vault: () => selected,
      shutdownVault: stopVault,
      assertEnabled: () => undefined,
    });
    for (let i = 0; i < count; i++)
      await proxy.openManagedCopilotRuntime({
        owner: { ...TEST_OWNER, id: String(i) },
        signal: new AbortController().signal,
      });
    const first = proxy.shutdownCopilotRuntimes();
    const repeat = proxy.shutdownCopilotRuntimes();
    try {
      if (count) await entered.promise;
      expect(first).toBe(repeat);
      expect(stopVault).toHaveBeenCalledTimes(1);
      expect(stopLegacy).toHaveBeenCalledTimes(1);
      expect(h.pilot.authority.recipientGeneration()).toBeUndefined();
      h.pilot.authority.reopen();
      expect(h.pilot.authority.recipientGeneration()).toBeUndefined();
      expect((await h.pilot.authority.create(grant(), 'setup')).kind).toBe(
        'blocked',
      );
    } finally {
      release.resolve();
      await first;
      h.pilot.close();
    }
  },
);

it('releases proxy recipient tracking when a pipeline-owned one-shot turn settles without an explicit caller close', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  const released = jest.fn(() => Promise.resolve());
  const proxy = createCopilotConnectionProxy({
    legacy: {
      ...h.backend,
      openManagedCopilotRuntime: async (input) => {
        const handle = await h.backend.openManagedCopilotRuntime(input);
        return {
          ...handle,
          close: async (): Promise<void> => {
            await handle.close();
            await released();
          },
        };
      },
    },
    selected: () => Promise.resolve(false),
    vault: () => {
      throw new Error('Unexpected vault');
    },
    assertEnabled: () => undefined,
  });
  const runtime = await proxy.openManagedCopilotRuntime({
    owner: TEST_OWNER,
    signal: new AbortController().signal,
  });
  await runtime.runTurn(turn());
  expect(released).toHaveBeenCalledTimes(1);
  await proxy.revokeCopilotRuntimes();
  expect(released).toHaveBeenCalledTimes(1);
  h.pilot.close();
});

const RENEWAL_PARITY = {
  'slow-open':
    'renews immediately after a slow successful open before any run and stops renewal after completion',
  'callback-crossing-expiry':
    'renews a selected turn across multiple TTLs and an approval crossing original expiry without legacy fallback',
  'completion-race': 'completion/renewal race has one terminal winner: %s',
} satisfies Record<CopilotVaultRenewalCase, string>;
it(RENEWAL_PARITY['callback-crossing-expiry'], async () => {
  const h = fixture(true);
  ready(await h.pilot.setup(grant(), null));
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
  });
  const timers = jest.requireActual<typeof TimersModule>('node:timers');
  async function checkpoint<T>(work: Promise<T>, phase: string): Promise<T> {
    let timer: ReturnType<typeof timers.setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timer = timers.setTimeout(
            () => reject(new Error(`Expiry checkpoint stalled: ${phase}`)),
            1500,
          );
        }),
      ]);
    } finally {
      timers.clearTimeout(timer);
    }
  }
  try {
    const asked = deferred<void>();
    const accepted = deferred<void>();
    const answer = deferred<{ decision: 'allow' }>();
    const oldOpen = jest.fn(h.backend.openManagedCopilotRuntime);
    const proxy = createCopilotConnectionProxy({
      legacy: { ...h.backend, openManagedCopilotRuntime: oldOpen },
      selected: () => Promise.resolve(true),
      vault: () => h.backend,
      assertEnabled: () => undefined,
    });
    const runtime = await checkpoint(
      proxy.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      }),
      'open',
    );
    const running = runtime.runTurn(
      turn({
        onPromptAccepted: () => {
          accepted.resolve();
        },
        authorize: () => {
          asked.resolve();
          return answer.promise;
        },
      }),
    );
    let settled = false;
    void running
      .finally(() => {
        settled = true;
      })
      .catch(() => undefined);
    await checkpoint(Promise.race([accepted.promise, running]), 'accepted');
    await jest.advanceTimersByTimeAsync(119000);
    expect(settled).toBe(false);
    const config = h.natives[1]?.configs[0];
    if (!config?.onEvent || !config?.hooks?.onPreToolUse)
      throw new Error('Missing approval hook');
    config.onEvent({
      id: 'expiring-start',
      type: 'tool.execution_start',
      timestamp: new Date().toISOString(),
      parentId: null,
      data: { toolCallId: 'expiring-call', toolName: 'edit', arguments: {} },
    });
    const approving = config.hooks.onPreToolUse(
      {
        sessionId: 'session-1',
        timestamp: new Date(),
        workingDirectory: '/trusted/workspace',
        toolName: 'edit',
        toolArgs: {},
      },
      { sessionId: 'session-1' },
    );
    await checkpoint(asked.promise, 'asked');
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(2001);
    answer.resolve({ decision: 'allow' });
    expect(
      await checkpoint(Promise.resolve(approving), 'allowed'),
    ).toMatchObject({ permissionDecision: 'allow' });
    await jest.advanceTimersByTimeAsync(180_000);
    expect(settled).toBe(false);
    config.onEvent({
      id: 'renewed-idle',
      type: 'session.idle',
      ephemeral: true,
      timestamp: new Date().toISOString(),
      parentId: null,
      data: {},
    });
    await expect(checkpoint(running, 'running')).resolves.toMatchObject({
      sessionId: 'session-1',
    });
    expect(oldOpen).not.toHaveBeenCalled();
  } finally {
    h.pilot.close();
    jest.useRealTimers();
  }
});

it('still reports a genuine runtime cleanup failure while the lease is live', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  h.failCleanup();
  const warnings = jest.spyOn(process, 'emitWarning');
  const runtime = await h.backend.openManagedCopilotRuntime({
    owner: TEST_OWNER,
    signal: new AbortController().signal,
  });
  await expect(runtime.runTurn(turn())).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(h.natives[1]?.runtime.close).toHaveBeenCalled();
  expect(warnings).toHaveBeenCalledTimes(1);
  expect(warnings).toHaveBeenCalledWith(
    'Copilot runtime cleanup failed after a turn error.',
    { code: 'COPILOT_TURN_CLEANUP_FAILED' },
  );
  h.pilot.close();
});

it.each([false, true])(
  'runs the production delegation adapter with selected=%s, account binding and transcript/usage delivery',
  async (selected) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-delegate-'));
    const h = fixture();
    const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
    try {
      ready(await h.pilot.setup(grant(), null));
      const legacy = parityLegacyBackend(h, legacyNatives);
      const legacyOpen = jest.fn(legacy.openManagedCopilotRuntime);
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: { ...legacy, openManagedCopilotRuntime: legacyOpen },
        selected: () => Promise.resolve(selected),
        vault: () => h.backend,
        assertEnabled: () => undefined,
      });
      const signal = new AbortController().signal;
      const policy = new DelegationNativePolicy({
        cwd: root,
        writePaths: [],
        signal,
        delegationId: 'child',
        mode: (): 'ask' => 'ask',
        allowed: (): Promise<boolean> => Promise.resolve(true),
        approval: {
          check: (): Promise<{ decision: 'deny' }> =>
            Promise.resolve({ decision: 'deny' }),
          setMode: (): void => undefined,
          reevaluatePendingApprovals: (): Promise<void> => Promise.resolve(),
          dispose: (): void => undefined,
        },
        emit: (): Promise<void> => Promise.resolve(),
      });
      const errors: unknown[] = [];
      const runner = createCopilotDelegationRunner({
        available: () => Promise.resolve({ available: true }),
        prepare: () =>
          Promise.resolve({
            model: 'model',
            profileDir: join(root, 'profile'),
            tools: policy,
            plugins: [],
            retainedReadRoots: [],
            mcpServers: {},
          }),
        reportError: (error) => {
          errors.push(error);
        },
      });
      const events: AgentDelegationEvent['event'][] = [];
      const terminal = deferred<void>();
      const request = delegationRequest({
        cwd: root,
        signal,
        account: { host: 'https://github.com', login: 'pilot' },
      });
      const worker = {
        kind: 'subagent',
        runId: 'delegation-worker-run',
      } as const;
      const handle = await runInAgentWorker(worker, () =>
        runner.start(request, ({ event }) => {
          events.push(event);
          if (event.type === 'terminal') terminal.resolve();
          return Promise.resolve();
        }),
      );
      await terminal.promise;
      await runner.close(handle);
      expect(errors).toEqual([]);
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'terminal', status: 'completed' }),
      );
      const usage = events.find((event) => event.type === 'usage');
      if (!usage || usage.type !== 'usage')
        throw new Error('Missing delegation usage');
      expect(usage.usage).toMatchObject({
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 3,
      });
      expect(events.some((event) => event.type === 'transcript')).toBe(true);
      if (selected)
        expect(h.launches[1]).toEqual({
          owner: { kind: worker.kind, id: worker.runId },
          cwd: root,
          workspaceId: request.parent.projectId,
          restrictedEnvironment: true,
        });
      if (selected) expect(legacyOpen).not.toHaveBeenCalled();
      else
        expect(legacyOpen).toHaveBeenCalledWith(
          expect.objectContaining({
            purpose: 'session',
            owner: { kind: worker.kind, id: worker.runId },
          }),
        );
      expect((selected ? h.natives[1] : legacyNatives[0])?.sends[0]).toContain(
        'Managed delegated task:',
      );
      expect(legacyNatives).toHaveLength(selected ? 0 : 1);
    } finally {
      mockCallerConnection = undefined;
      h.pilot.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('projects selection-read dependency failures as typed unavailable without leaking dependency messages', async () => {
  const h = fixture();
  const legacyStatus = jest.fn(h.backend.copilotConnectionStatus);
  let unreadable = true;
  const proxy = createCopilotConnectionProxy({
    legacy: { ...h.backend, copilotConnectionStatus: legacyStatus },
    selected: () =>
      unreadable ? Promise.reject(new Error(ACCESS)) : Promise.resolve(false),
    vault: () => h.backend,
    assertEnabled: () => undefined,
  });
  await expect(proxy.copilotConnectionStatus()).rejects.toMatchObject({
    code: 'unavailable',
  });
  await expect(proxy.copilotConnectionStatus()).rejects.not.toThrow(ACCESS);
  expect(legacyStatus).not.toHaveBeenCalled();
  unreadable = false;
  await proxy.copilotConnectionStatus();
  expect(legacyStatus).toHaveBeenCalledTimes(1);
  h.pilot.close();
});

function chatHistory(): ChatTabsFile {
  return {
    version: 1,
    activeTabId: 'chat',
    tabs: [
      {
        id: 'chat',
        title: 'Pilot chat',
        createdAt: new Date(0).toISOString(),
        forkedFrom: {
          projectId: 'source',
          worktreeId: 'source',
          chatId: 'source',
          atMessageId: 'history',
        },
        messages: [
          {
            id: 'history',
            role: 'user',
            timestamp: 1,
            blocks: [{ type: 'text', text: 'Frozen historical context' }],
          },
        ],
      },
    ],
  };
}

function chatSession(
  onEvent: (event: unknown) => void,
  getWindow: () => BrowserWindow | null = () => null,
  approvalMode: 'ask' | 'auto' = 'ask',
): AgentSession {
  return runInAgentWorkerSync(
    { kind: 'turn', runId: 'chat-construction-worker-run' },
    () =>
      new CopilotProvider().createSession(
        {
          cwd: mockChatRoot,
          projectId: 'project',
          worktreeId: 'worktree',
          chatId: 'chat',
          model: 'copilot:model',
          approvalMode,
          rtkEnabled: false,
        },
        onEvent,
        windowAgentInterfacePort(getWindow),
      ),
  );
}

function sendChatMessage(
  session: AgentSession,
  runId: string,
  text: string,
  options: Parameters<AgentSession['sendMessage']>[1],
): void {
  runInAgentWorkerSync({ kind: 'turn', runId }, () =>
    session.sendMessage(text, options),
  );
}

function prepareChatHost(root: string): void {
  mockChatRoot = root;
  mockPipelineServers = {};
  jest
    .spyOn(ApprovalPersistence, 'readWorkspaceApprovalsResult')
    .mockResolvedValue({ file: { version: 1, rules: [] }, status: 'ok' });
  mockHostSessions.clear();
  mockDiagnostics.mockClear();
  mockUnregisterRoutes.mockClear();
  mockSetToolGate.mockClear();
  jest.mocked(HomeCapabilitiesModule.discoverHomeCapabilities).mockClear();
  jest.mocked(readChatTabsFile).mockReset().mockResolvedValue(chatHistory());
  jest.mocked(readPreferencesFileDetailed).mockResolvedValue({
    authority: 'ok',
    preferences: DEFAULT_PREFERENCES,
  });
}

async function chatProfile(): Promise<string> {
  const profiles = await readdir(join(mockChatRoot, 'copilot-sessions'));
  expect(profiles).toHaveLength(1);
  const profile = profiles[0];
  if (!profile) throw new Error('No chat profile');
  return join(mockChatRoot, 'copilot-sessions', profile);
}

it.each(['selected', 'unselected'] as const)(
  'runs the real interactive chat consumer with %s custody, fork acceptance, resume, transcript projection and usage',
  async (custody) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-chat-'));
    const h = fixture();
    let session: AgentSession | undefined;
    const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
    const model: CopilotModelEntry = {
      id: 'copilot:model',
      rawModelId: 'model',
      label: 'Model',
      supportsVision: false,
      supportedThinkingLevels: [],
    };
    const legacyOpen = jest.fn<
      ReturnType<CopilotConnectionBackend['openManagedCopilotRuntime']>,
      Parameters<CopilotConnectionBackend['openManagedCopilotRuntime']>
    >(() => {
      const native = nativeRuntime({ sessionId: 'legacy-chat' });
      legacyNatives.push(native);
      return Promise.resolve({
        ...native.runtime,
        listModels: () => Promise.resolve([model]),
        getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
      });
    });
    const vault = jest.fn(() => h.backend);
    try {
      prepareChatHost(root);
      if (custody === 'selected') ready(await h.pilot.setup(grant(), null));
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: {
          ...h.backend,
          openManagedCopilotRuntime: legacyOpen,
          listCopilotModels: () => Promise.resolve([model]),
        },
        selected: () =>
          Promise.resolve(
            h.preferences().copilotVaultSelection?.state === 'selected',
          ),
        vault,
        assertEnabled: () => undefined,
      });
      let ended = deferred<void>();
      const events: unknown[] = [];
      session = chatSession((event) => {
        events.push(event);
        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          ended.resolve();
      });
      sendChatMessage(session, 'first-worker-run', 'First live message', {
        userMessageId: 'first',
      });
      await ended.promise;
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        is_error: false,
        result: 'Verified evidence',
        provider: 'copilot',
        canopy_turn_user_message_id: 'first',
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 2,
          output_tokens: 3,
        },
      });
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'system',
          subtype: 'init',
          provider: 'copilot',
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'canopy_assistant_patch',
          canopy_turn_user_message_id: 'first',
          patches: [
            { index: 0, block: { type: 'text', text: 'Verified evidence' } },
          ],
        }),
      );
      const native =
        custody === 'selected'
          ? h.natives.find((entry) => entry.sends.length > 0)
          : legacyNatives[0];
      expect(native?.sends[0]).toContain('<forked_conversation>');
      expect(native?.sends[0]).toContain('Frozen historical context');
      expect(native?.sends[0]).toContain('First live message');
      const profile = await chatProfile();
      const id = session.getProviderSessionId?.();
      expect(id).toBeDefined();
      expect(
        await readFile(join(profile, 'fork-context-delivered'), 'utf8'),
      ).toBe(id);
      const binding: unknown = JSON.parse(
        await readFile(join(profile, 'host-session.json'), 'utf8'),
      );
      expect(binding).toMatchObject({
        version: 2,
        sessionId: id,
        account:
          custody === 'selected'
            ? { host: 'https://github.com', login: 'pilot' }
            : { host: 'https://github.com', login: 'fixture' },
      });
      ended = deferred<void>();
      sendChatMessage(session, 'second-worker-run', 'Second live message', {
        userMessageId: 'second',
      });
      await ended.promise;
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        is_error: false,
        canopy_turn_user_message_id: 'second',
      });
      expect(jest.mocked(readChatTabsFile)).toHaveBeenCalledTimes(1);
      const chatOwners =
        custody === 'selected'
          ? h.launches.flatMap((launch) =>
              launch?.owner.kind === 'turn' ? [launch.owner] : [],
            )
          : legacyOpen.mock.calls.map(([input]) => input.owner);
      expect(chatOwners).toEqual([
        { kind: 'turn', id: 'first-worker-run' },
        { kind: 'turn', id: 'second-worker-run' },
      ]);
      if (custody === 'selected') {
        expect(legacyOpen).not.toHaveBeenCalled();
        const resumed = h.natives.find(
          (entry) => entry.runtime.client.resumeSession.mock.calls.length > 0,
        );
        expect(resumed?.runtime.client.resumeSession).toHaveBeenCalledWith(
          id,
          expect.any(Object),
        );
        expect(resumed?.sends).toEqual(['Second live message']);
      } else {
        expect(legacyOpen).toHaveBeenCalledTimes(2);
        expect(vault).not.toHaveBeenCalled();
        expect(h.natives).toHaveLength(0);
        expect(legacyNatives[1]?.sends).toEqual(['Second live message']);
      }
      expect(JSON.stringify(events)).not.toMatch(
        /p6-access-secret|p6-refresh-secret/,
      );
      expect(mockUnregisterRoutes).toHaveBeenCalledTimes(2);
    } finally {
      await session?.destroy();
      mockCallerConnection = undefined;
      h.pilot.close();
      mockHostSessions.clear();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function approvalWindow(): BrowserWindow {
  const window = new BrowserWindow({ show: false });
  let destroyed = false;
  window.isDestroyed = (): boolean => destroyed;
  window.webContents.isDestroyed = (): boolean => destroyed;
  window.webContents.isCrashed = (): boolean => false;
  Object.defineProperty(window.webContents, 'mainFrame', {
    value: { detached: false, isDestroyed: (): boolean => destroyed },
  });
  window.destroy = (): void => {
    if (destroyed) return;
    destroyed = true;
    window.webContents.emit('destroyed');
  };
  return window;
}

const nativeApprovalRows = [
  { label: 'edit', tool: 'edit', mode: 'ask', path: 'absolute', allow: false },
  {
    label: 'absolute read',
    tool: 'view',
    mode: 'auto',
    path: 'absolute',
    allow: true,
  },
  {
    label: 'relative read',
    tool: 'view',
    mode: 'auto',
    path: 'relative',
    allow: false,
  },
  {
    label: 'parent segment read',
    tool: 'view',
    mode: 'auto',
    path: 'parent',
    allow: false,
  },
  {
    label: 'tilde read',
    tool: 'view',
    mode: 'auto',
    path: 'tilde',
    allow: false,
  },
  {
    label: 'wrong view key',
    tool: 'view',
    mode: 'auto',
    path: 'wrong-key',
    allow: false,
  },
  {
    label: 'absolute grep',
    tool: 'grep',
    mode: 'auto',
    path: 'absolute',
    allow: true,
  },
  {
    label: 'relative grep',
    tool: 'grep',
    mode: 'auto',
    path: 'relative',
    allow: false,
  },
  {
    label: 'mixed grep paths',
    tool: 'grep',
    mode: 'auto',
    path: 'mixed',
    allow: false,
  },
  {
    label: 'wrong grep key',
    tool: 'grep',
    mode: 'auto',
    path: 'wrong-key',
    allow: false,
  },
  { label: 'cwd glob', tool: 'glob', mode: 'auto', path: 'cwd', allow: true },
  {
    label: 'relative glob',
    tool: 'glob',
    mode: 'auto',
    path: 'relative',
    allow: false,
  },
  {
    label: 'empty paths',
    tool: 'glob',
    mode: 'auto',
    path: 'empty',
    allow: false,
  },
  {
    label: 'wrong glob key',
    tool: 'glob',
    mode: 'auto',
    path: 'wrong-key',
    allow: false,
  },
] as const;

it.each(
  (['selected', 'unselected'] as const).flatMap((custody) =>
    nativeApprovalRows.map((row) => ({ custody, ...row })),
  ),
)(
  'routes $custody $label through the real approval broker without trusting mapped raw paths',
  async ({ custody, tool, mode, path, allow }) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-chat-approval-'));
    const accepted = deferred<void>();
    const h = fixture(true, () => accepted.resolve());
    let session: AgentSession | undefined;
    const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
    try {
      prepareChatHost(root);
      await writeFile(join(root, 'example.txt'), 'before');
      if (custody === 'selected') ready(await h.pilot.setup(grant(), null));
      const legacyOpen = jest.fn(
        parityLegacyBackend(h, legacyNatives, true).openManagedCopilotRuntime,
      );
      const vault = jest.fn(() => h.backend);
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: {
          ...h.backend,
          openManagedCopilotRuntime: legacyOpen,
          listCopilotModels: async () =>
            copilotModelsFromSdk((await h.list()).models),
        },
        selected: () => Promise.resolve(custody === 'selected'),
        vault,
        assertEnabled: () => undefined,
      });
      const createApproval = jest.spyOn(
        ApprovalService,
        'createApprovalSession',
      );
      const bridge = jest.spyOn(ApprovalBridge, 'requestApprovalDecision');
      const ended = deferred<void>();
      const events: unknown[] = [];
      session = chatSession(
        (event) => {
          events.push(event);
          if (event && typeof event === 'object' && 'type' in event) {
            if (event.type === 'canopy_assistant_patch') accepted.resolve();
            if (event.type === 'result' || event.type === 'error') {
              accepted.resolve();
              ended.resolve();
            }
          }
        },
        () => null,
        mode,
      );
      sendChatMessage(session, 'approval-worker-run', 'Edit a file', {
        userMessageId: 'approval-turn',
      });
      await accepted.promise;
      const native = [...h.natives, ...legacyNatives].find(
        (entry) => entry.sends.length > 0,
      );
      const config = native?.configs[0];
      if (!native || !config?.onEvent || !config.hooks?.onPreToolUse)
        throw new Error(JSON.stringify(events));
      const rawPath =
        path === 'relative'
          ? 'example.txt'
          : path === 'parent'
            ? `${root}/child/../example.txt`
            : path === 'tilde'
              ? '~/example.txt'
              : join(root, 'example.txt');
      const args: Record<string, string | string[]> =
        tool === 'edit'
          ? { path: rawPath, old_str: 'before', new_str: 'after' }
          : tool === 'view'
            ? {
                path: rawPath,
                ...(path === 'wrong-key' ? { paths: [rawPath] } : {}),
              }
            : {
                pattern: tool === 'grep' ? 'before' : '*.txt',
                ...(path === 'cwd'
                  ? {}
                  : path === 'wrong-key'
                    ? { path: root }
                    : {
                        paths:
                          path === 'empty'
                            ? []
                            : path === 'mixed'
                              ? [root, '.']
                              : path === 'relative'
                                ? ['.']
                                : [root],
                      }),
              };
      config.onEvent({
        id: 'start',
        type: 'tool.execution_start',
        timestamp: new Date().toISOString(),
        parentId: null,
        data: { toolCallId: 'edit-call', toolName: tool, arguments: args },
      });
      expect(
        await config.hooks.onPreToolUse(
          {
            sessionId: session.getProviderSessionId?.() ?? '',
            timestamp: new Date(),
            workingDirectory: root,
            toolName: tool,
            toolArgs: args,
          },
          { sessionId: session.getProviderSessionId?.() ?? '' },
        ),
      ).toMatchObject({ permissionDecision: allow ? 'allow' : 'deny' });
      expect(createApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'copilot',
          chatId: 'chat',
          mode,
        }),
      );
      // Invalid empty paths refuse before prompting; uncertain paths must prompt, even in Auto.
      expect(bridge).toHaveBeenCalledTimes(allow || path === 'empty' ? 0 : 1);
      if (!allow && path !== 'empty') {
        expect(bridge.mock.calls[0]?.[0].event).toMatchObject({
          chatId: 'chat',
          provider: 'copilot',
          toolUseId: 'approval-turn:edit-call',
        });
        expect(bridge.mock.calls[0]?.[0].getWindow()).toBeNull();
        expect(mockDiagnostics).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'approval_decision',
            decision: 'deny',
            scope: 'once',
          }),
        );
      }
      config.onEvent({
        id: 'idle',
        type: 'session.idle',
        ephemeral: true,
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {},
      });
      await ended.promise;
      expect(events.at(-1)).toMatchObject({ type: 'result', is_error: false });
      expect(hasPendingApprovalForSession('project:worktree:chat')).toBe(false);
      if (custody === 'selected') expect(legacyOpen).not.toHaveBeenCalled();
      else {
        expect(legacyOpen).toHaveBeenCalledTimes(1);
        expect(vault).not.toHaveBeenCalled();
      }
      expect(native.runtime.close).toHaveBeenCalled();
    } finally {
      await session?.destroy();
      mockCallerConnection = undefined;
      h.pilot.close();
      mockHostSessions.clear();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('runs the desktop pipeline host wrapper over the selected proxy with capability preparation, resume and cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'p6-desktop-pipeline-'));
  const h = fixture();
  try {
    prepareChatHost(root);
    ready(await h.pilot.setup(grant(), null));
    const legacyOpen = jest.fn(h.backend.openManagedCopilotRuntime);
    mockCallerConnection = createCopilotConnectionProxy({
      legacy: { ...h.backend, openManagedCopilotRuntime: legacyOpen },
      selected: () => Promise.resolve(true),
      vault: () => h.backend,
      assertEnabled: () => undefined,
    });
    const approvals = jest.spyOn(ApprovalService, 'createApprovalSession');
    const request: Parameters<typeof runDesktopCopilotPipelinePrompt>[0] = {
      cwd: root,
      repositoryPolicyScope: { kind: 'checkout', root },
      executionsDir: root,
      executionId: 'execution',
      projectId: 'project',
      jobId: 'job',
      stepId: 'step',
      attempt: 1,
      environment: { PILOT_PIPELINE_OVERRIDE: 'retained' },
      prompt: 'Desktop pipeline prompt',
      model: 'copilot:model',
      permissionPreset: 'plan',
      totalTimeoutMs: 30000,
    };
    const result = await runDesktopCopilotPipelinePrompt(request);
    expect(result).toMatchObject({
      status: 'success',
      rawText: 'Verified evidence',
      usage: { inputTokens: 10, cacheReadInputTokens: 2, outputTokens: 3 },
    });
    expect(h.launches[1]).toEqual({
      owner: { kind: 'pipeline', id: request.executionId },
      cwd: root,
      workspaceId: 'project',
      executionKind: 'pipeline',
      environment: { PILOT_PIPELINE_OVERRIDE: 'retained' },
    });
    expect(result.transcript).toContain('canopy_assistant_patch');
    if (result.status !== 'success') throw new Error(JSON.stringify(result));
    const resumed = await runDesktopCopilotPipelinePrompt({
      ...request,
      resumeSessionId: result.sessionId,
    });
    expect(resumed).toMatchObject({
      status: 'success',
      sessionId: result.sessionId,
    });
    expect(h.natives[2]?.runtime.client.resumeSession).toHaveBeenCalled();
    expect(approvals).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'copilot',
        trackChatTurn: false,
        mode: 'ask',
      }),
    );
    expect(mockSetToolGate).toHaveBeenCalledTimes(2);
    const gateCall = mockSetToolGate.mock.calls[0];
    if (!gateCall) throw new Error('Missing pipeline MCP gate');
    expect(
      await gateCall[1]({
        proxyUrl: 'http://127.0.0.1:4000/unselected',
        tool: 'edit',
        args: {},
      }),
    ).toBe(false);
    expect(mockUnregisterRoutes).toHaveBeenCalledTimes(2);
    expect(legacyOpen).not.toHaveBeenCalled();
    expect(h.natives[1]?.runtime.close).toHaveBeenCalled();
  } finally {
    mockCallerConnection = undefined;
    h.pilot.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each(['plan', 'dangerous_all'] as const)(
  'enforces the desktop pipeline %s MCP ceiling and saved denies through the selected proxy, then withdraws its routes',
  async (permissionPreset) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-pipeline-mcp-'));
    const sent = deferred<void>();
    const h = fixture(true, () => sent.resolve());
    const abort = new AbortController();
    let running: ReturnType<typeof runDesktopCopilotPipelinePrompt> | undefined;
    try {
      prepareChatHost(root);
      mockPipelineServers = {
        selected: {
          type: 'http',
          url: 'http://127.0.0.1:4000/selected',
          allowedTools: ['read', 'erase'],
        },
      };
      jest.mocked(readPreferencesFileDetailed).mockResolvedValue({
        authority: 'ok',
        preferences: {
          ...DEFAULT_PREFERENCES,
          globalApprovalRules: [
            {
              id: 'deny-erase',
              behavior: 'deny',
              target: { kind: 'mcp', server: 'selected', tool: 'erase' },
              createdAt: new Date(0).toISOString(),
              origin: 'prompt',
            },
          ],
        },
      });
      ready(await h.pilot.setup(grant(), null));
      const legacyOpen = jest.fn(h.backend.openManagedCopilotRuntime);
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: { ...h.backend, openManagedCopilotRuntime: legacyOpen },
        selected: () => Promise.resolve(true),
        vault: () => h.backend,
        assertEnabled: () => undefined,
      });
      running = runDesktopCopilotPipelinePrompt({
        cwd: root,
        repositoryPolicyScope: { kind: 'checkout', root },
        executionsDir: root,
        executionId: 'execution',
        projectId: 'project',
        jobId: 'job',
        stepId: 'step',
        attempt: 1,
        environment: {},
        prompt: 'Use selected tools',
        model: 'copilot:model',
        permissionPreset,
        totalTimeoutMs: 30000,
        signal: abort.signal,
      });
      await Promise.race([sent.promise, running]);
      const native = h.natives.find((entry) => entry.sends.length > 0);
      const config = native?.configs[0];
      const gate = mockSetToolGate.mock.calls[0]?.[1];
      if (!native || !config?.onEvent || !config.hooks?.onPreToolUse || !gate)
        throw new Error('Pipeline did not reach prompt acceptance');
      for (const tool of ['read', 'erase', 'unselected']) {
        const args = { resource: 'fixture' };
        config.onEvent({
          id: `start-${tool}`,
          type: 'tool.execution_start',
          timestamp: new Date().toISOString(),
          parentId: null,
          data: {
            toolCallId: `call-${tool}`,
            toolName: `selected_${tool}`,
            arguments: args,
            mcpServerName: 'selected',
            mcpToolName: tool,
          },
        });
        const decision = await config.hooks.onPreToolUse(
          {
            sessionId: 'session-1',
            timestamp: new Date(),
            workingDirectory: root,
            toolName: `selected_${tool}`,
            toolArgs: args,
          },
          { sessionId: 'session-1' },
        );
        expect(decision).toMatchObject({
          permissionDecision:
            permissionPreset === 'dangerous_all' && tool === 'read'
              ? 'allow'
              : 'deny',
        });
        expect(
          await gate({
            proxyUrl: 'http://127.0.0.1:4000/selected',
            tool,
            args,
          }),
        ).toBe(permissionPreset === 'dangerous_all' && tool === 'read');
      }
      if (permissionPreset === 'dangerous_all')
        expect(mockDiagnostics).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'approval_decision',
            decision: 'deny',
            targetKind: 'mcp',
          }),
        );
      config.onEvent({
        id: 'idle',
        type: 'session.idle',
        ephemeral: true,
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {},
      });
      expect(await running).toMatchObject({ status: 'success' });
      expect(
        await gate({
          proxyUrl: 'http://127.0.0.1:4000/selected',
          tool: 'read',
          args: {},
        }),
      ).toBe(false);
      expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
      expect(legacyOpen).not.toHaveBeenCalled();
    } finally {
      abort.abort();
      await running;
      mockCallerConnection = undefined;
      h.pilot.close();
      mockPipelineServers = {};
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { consumer: 'chat', custody: 'selected' },
  { consumer: 'chat', custody: 'unselected' },
  { consumer: 'pipeline', custody: 'selected' },
  { consumer: 'pipeline', custody: 'unselected' },
] as const)(
  'withdraws a $custody $consumer preparation failure before prompt acceptance and permits a clean retry',
  async ({ consumer, custody }) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-prepare-failure-'));
    const h = fixture();
    let session: AgentSession | undefined;
    const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
    const legacyModel: CopilotModelEntry = {
      id: 'copilot:model',
      rawModelId: 'model',
      label: 'Model',
      supportsVision: false,
      supportedThinkingLevels: [],
    };
    const legacyOpen = jest.fn<
      ReturnType<CopilotConnectionBackend['openManagedCopilotRuntime']>,
      Parameters<CopilotConnectionBackend['openManagedCopilotRuntime']>
    >(() => {
      const native = nativeRuntime();
      legacyNatives.push(native);
      return Promise.resolve({
        ...native.runtime,
        listModels: () => Promise.resolve([legacyModel]),
        getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
      });
    });
    try {
      prepareChatHost(root);
      if (custody === 'selected') ready(await h.pilot.setup(grant(), null));
      const close = jest.fn<Promise<void>, []>();
      const open = h.backend.openManagedCopilotRuntime;
      jest
        .spyOn(h.backend, 'openManagedCopilotRuntime')
        .mockImplementation(async (input) => {
          const handle = await open(input);
          return {
            ...handle,
            close: async (): Promise<void> => {
              await handle.close();
              await close();
            },
          };
        });
      close.mockResolvedValue();
      const vault = jest.fn(() => h.backend);
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: {
          ...h.backend,
          openManagedCopilotRuntime: async (input) => {
            const handle = await legacyOpen(input);
            return {
              ...handle,
              close: async (): Promise<void> => {
                await handle.close();
                await close();
              },
            };
          },
          listCopilotModels: () => Promise.resolve([legacyModel]),
        },
        selected: () => Promise.resolve(custody === 'selected'),
        vault,
        assertEnabled: () => undefined,
      });
      const discovery = jest.mocked(
        HomeCapabilitiesModule.discoverHomeCapabilities,
      );
      discovery.mockRejectedValueOnce(new Error('Capability discovery failed'));
      const createApproval = ApprovalService.createApprovalSession;
      const disposals: jest.SpyInstance<void, []>[] = [];
      const approvals = jest
        .spyOn(ApprovalService, 'createApprovalSession')
        .mockImplementation((input) => {
          const handle = createApproval(input);
          disposals.push(jest.spyOn(handle, 'dispose'));
          return handle;
        });
      let ended = deferred<void>();
      const events: unknown[] = [];
      const request: Parameters<typeof runDesktopCopilotPipelinePrompt>[0] = {
        cwd: root,
        repositoryPolicyScope: { kind: 'checkout', root },
        executionsDir: root,
        executionId: 'execution',
        projectId: 'project',
        jobId: 'job',
        stepId: 'step',
        attempt: 1,
        environment: {},
        prompt: 'Prepare capabilities before this message',
        model: 'copilot:model',
        permissionPreset: 'plan',
        totalTimeoutMs: 30000,
      };
      if (consumer === 'chat') {
        session = chatSession((event) => {
          events.push(event);
          if (
            event &&
            typeof event === 'object' &&
            'type' in event &&
            (event.type === 'error' || event.type === 'result')
          )
            ended.resolve();
        });
        sendChatMessage(session, 'failed-worker-run', request.prompt, {
          userMessageId: 'failed',
        });
        await ended.promise;
        expect(discovery).toHaveBeenCalledTimes(1);
        expect(events.at(-1)).toMatchObject({
          type: 'error',
          error: 'Capability discovery failed',
        });
        await expect(
          readFile(join(await chatProfile(), 'fork-context-delivered')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        const failed = await runDesktopCopilotPipelinePrompt(request);
        expect(discovery).toHaveBeenCalledTimes(1);
        expect(failed).toMatchObject({
          status: 'failure',
          failure: { message: 'Capability discovery failed' },
        });
      }
      expect(approvals).toHaveBeenCalledTimes(1);
      expect(disposals[0]).toHaveBeenCalledTimes(1);
      expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
      expect(mockSetToolGate).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(
        [...h.natives, ...legacyNatives].every(
          (native) => native.sends.length === 0,
        ),
      ).toBe(true);
      if (consumer === 'chat' && session) {
        ended = deferred<void>();
        sendChatMessage(session, 'retry-worker-run', 'Retry message', {
          userMessageId: 'retry',
        });
        await ended.promise;
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        const native = [...h.natives, ...legacyNatives].find(
          (entry) => entry.sends.length > 0,
        );
        expect(native?.sends[0]).toContain('Frozen historical context');
        expect(native?.sends[0]).toContain('Retry message');
      } else {
        expect(await runDesktopCopilotPipelinePrompt(request)).toMatchObject({
          status: 'success',
          rawText: 'Verified evidence',
        });
      }
      expect(close).toHaveBeenCalledTimes(2);
      expect(disposals[1]).toHaveBeenCalledTimes(1);
      expect(mockUnregisterRoutes).toHaveBeenCalledTimes(2);
      if (custody === 'selected') expect(legacyOpen).not.toHaveBeenCalled();
      else {
        expect(vault).not.toHaveBeenCalled();
        expect(legacyOpen).toHaveBeenCalledTimes(2);
      }
    } finally {
      await session?.destroy();
      mockCallerConnection = undefined;
      h.pilot.close();
      mockHostSessions.clear();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  ['selected', 'cancel'],
  ['unselected', 'cancel'],
  ['selected', 'renderer-destroyed'],
  ['unselected', 'renderer-destroyed'],
] as const)(
  'keeps %s chat approvals fail-closed on %s and rejects a late allow',
  async (custody, withdrawal) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-chat-withdrawal-'));
    const accepted = deferred<void>();
    const registered = deferred<string>();
    const h = fixture(true, () => accepted.resolve());
    let session: AgentSession | undefined;
    const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
    const window = approvalWindow();
    let currentWindow: BrowserWindow | null = window;
    const appEvents = new EventEmitter();
    jest.spyOn(app, 'on').mockImplementation((event, listener) => {
      appEvents.on(event, listener);
      return app;
    });
    jest.spyOn(app, 'removeListener').mockImplementation((event, listener) => {
      appEvents.removeListener(event, listener);
      return app;
    });
    setDesktopChatWaitPresence({
      getMainWindow: () => currentWindow,
      remoteControllerAttached: () => false,
    });
    try {
      prepareChatHost(root);
      if (custody === 'selected') ready(await h.pilot.setup(grant(), null));
      const legacyOpen = jest.fn(
        parityLegacyBackend(h, legacyNatives, true).openManagedCopilotRuntime,
      );
      const vault = jest.fn(() => h.backend);
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: {
          ...h.backend,
          openManagedCopilotRuntime: legacyOpen,
          listCopilotModels: async () =>
            copilotModelsFromSdk((await h.list()).models),
        },
        selected: () => Promise.resolve(custody === 'selected'),
        vault,
        assertEnabled: () => undefined,
      });
      const realRequest = ApprovalBridge.requestApprovalDecision;
      jest
        .spyOn(ApprovalBridge, 'requestApprovalDecision')
        .mockImplementation((options) =>
          realRequest({
            ...options,
            onRegistered: (id) => {
              options.onRegistered?.(id);
              registered.resolve(id);
            },
          }),
        );
      const sends = jest.spyOn(window.webContents, 'send');
      const ended = deferred<void>();
      const events: unknown[] = [];
      session = chatSession(
        (event) => {
          events.push(event);
          if (
            event &&
            typeof event === 'object' &&
            'type' in event &&
            event.type === 'canopy_assistant_patch'
          )
            accepted.resolve();
          if (
            event &&
            typeof event === 'object' &&
            'type' in event &&
            (event.type === 'result' || event.type === 'error')
          ) {
            accepted.resolve();
            ended.resolve();
          }
        },
        () => currentWindow,
      );
      sendChatMessage(session, 'withdrawal-worker-run', 'Edit a file', {
        userMessageId: 'withdrawal',
      });
      await accepted.promise;
      const native = [...h.natives, ...legacyNatives].find(
        (entry) => entry.sends.length > 0,
      );
      const config = native?.configs[0];
      if (!native || !config?.onEvent || !config.hooks?.onPreToolUse)
        throw new Error(JSON.stringify(events));
      const args = {
        path: join(root, 'example.txt'),
        old_str: 'before',
        new_str: 'after',
      };
      const id = session.getProviderSessionId?.() ?? '';
      config.onEvent({
        id: 'withdrawal-start',
        type: 'tool.execution_start',
        timestamp: new Date().toISOString(),
        parentId: null,
        data: { toolCallId: 'edit-call', toolName: 'edit', arguments: args },
      });
      const approving = Promise.resolve(
        config.hooks.onPreToolUse(
          {
            sessionId: id,
            timestamp: new Date(),
            workingDirectory: root,
            toolName: 'edit',
            toolArgs: args,
          },
          { sessionId: id },
        ),
      );
      const requestId = await Promise.race([
        registered.promise,
        approving.then(() => {
          throw new Error('Approval never reached host registry');
        }),
      ]);
      const key = 'project:worktree:chat';
      expect(hasPendingApprovalForSession(key)).toBe(true);
      const [card] = pendingApprovalRequests([window.webContents]);
      expect(card).toMatchObject({
        requestId,
        toolUseId: 'withdrawal:edit-call',
      });
      if (!card || typeof card.policyRevision !== 'number')
        throw new Error('Missing broker policy revision');
      const identity = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      };
      const responder = {
        id: 'p6-original-renderer',
        owners: [window.webContents],
      };
      let lateResponder = responder;
      if (withdrawal === 'cancel') await session.cancel();
      else {
        let approvalSettled = false;
        void approving.then(() => {
          approvalSettled = true;
        });
        currentWindow = null;
        window.destroy();
        // CAN-4129: closing the window withdraws delivery, not the approval.
        await Promise.resolve();
        expect(approvalSettled).toBe(false);
        expect(hasPendingApprovalForSession(key)).toBe(true);
        expect(
          resolveApproval(
            requestId,
            { behavior: 'allow', scope: 'once' },
            responder,
            identity,
            card.policyRevision,
          ),
        ).toBe(false);
        const replacement = approvalWindow();
        currentWindow = replacement;
        const redelivered = deferred<void>();
        const replacementSends = jest
          .spyOn(replacement.webContents, 'send')
          .mockImplementation((channel) => {
            if (channel === 'approval:request') redelivered.resolve();
          });
        appEvents.emit('browser-window-created');
        await redelivered.promise;
        const [replayed] = pendingApprovalRequests([replacement.webContents]);
        expect(replayed).toMatchObject({
          requestId,
          policyRevision: card.policyRevision,
        });
        expect(replacementSends).toHaveBeenCalledWith(
          'approval:request',
          expect.objectContaining({
            requestId,
            policyRevision: card.policyRevision,
          }),
        );
        lateResponder = {
          id: 'p6-replacement-renderer',
          owners: [replacement.webContents],
        };
        expect(
          resolveApproval(
            requestId,
            { behavior: 'deny', scope: 'once' },
            lateResponder,
            identity,
            replayed?.policyRevision,
          ),
        ).toBe(true);
      }
      expect(await approving).toMatchObject({ permissionDecision: 'deny' });
      expect(hasPendingApprovalForSession(key)).toBe(false);
      expect(
        resolveApproval(
          requestId,
          { behavior: 'allow', scope: 'once' },
          lateResponder,
          identity,
          card.policyRevision,
        ),
      ).toBe(false);
      if (withdrawal === 'renderer-destroyed')
        config.onEvent({
          id: 'withdrawal-idle',
          type: 'session.idle',
          ephemeral: true,
          timestamp: new Date().toISOString(),
          parentId: null,
          data: {},
        });
      await ended.promise;
      expect(events.at(-1)).toMatchObject({
        type: 'result',
        is_error: false,
        ...(withdrawal === 'cancel' ? { subtype: 'cancelled' } : {}),
      });
      expect(sends).toHaveBeenCalledWith(
        'approval:request',
        expect.objectContaining({ requestId }),
      );
      expect(mockUnregisterRoutes).toHaveBeenCalledTimes(1);
      expect(native.runtime.close).toHaveBeenCalled();
      if (custody === 'selected') expect(legacyOpen).not.toHaveBeenCalled();
      else {
        expect(legacyOpen).toHaveBeenCalledTimes(1);
        expect(vault).not.toHaveBeenCalled();
      }
    } finally {
      await session?.destroy();
      currentWindow?.destroy();
      window.destroy();
      mockCallerConnection = undefined;
      h.pilot.close();
      mockHostSessions.clear();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([true, false])(
  'preserves the legacy turn outcome when memoized close rejects (failed=%s)',
  async (failed) => {
    const h = fixture();
    const native = nativeRuntime();
    const turnError = new Error('Model refused the turn');
    const cleanupError = new Error('Runtime cleanup rejected');
    if (failed)
      native.runtime.client.createSession.mockRejectedValue(turnError);
    let closing: Promise<void> | undefined;
    native.runtime.close.mockImplementation(
      () => (closing ??= Promise.reject(cleanupError)),
    );
    const warnings = jest.spyOn(process, 'emitWarning');
    const proxy = createCopilotConnectionProxy({
      legacy: {
        ...h.backend,
        openManagedCopilotRuntime: () =>
          Promise.resolve({
            ...native.runtime,
            listModels: () => Promise.resolve([]),
            getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
          }),
      },
      selected: () => Promise.resolve(false),
      vault: () => {
        throw new Error('Unexpected vault');
      },
      assertEnabled: () => undefined,
    });
    try {
      const runtime = await proxy.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      await expect(runtime.runTurn(turn())).rejects.toBe(
        failed ? turnError : cleanupError,
      );
      expect(warnings).toHaveBeenCalledTimes(failed ? 1 : 0);
    } finally {
      h.pilot.close();
    }
  },
);

it('retires the exact selection after rejected refresh deletion and permits reconnect', async () => {
  const h = fixture();
  try {
    const head = ready(
      await h.pilot.setup(
        {
          ...grant(),
          accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
        null,
      ),
    );
    h.refreshRejected();
    await expect(
      h.backend.listCopilotModels(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(await h.pilot.authority.status()).toEqual({
      kind: 'blocked',
      reason: 'absent',
    });
    await h.backend.disconnectCopilot();
    expect(h.preferences().copilotVaultSelection).toMatchObject({
      state: 'disabled',
      identity: { epoch: head.epoch },
      pinGeneration: head.pinGeneration,
    });
    const backend = createCopilotVaultConnection({
      port: h.port,
      installation: () => Promise.resolve(base),
      authorize: () => Promise.resolve(grant()),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
    });
    expect(
      (
        await backend.connectCopilot(
          new AbortController().signal,
          () => undefined,
        )
      ).enabled,
    ).toBe(true);
    expect(ready(await h.pilot.authority.status()).epoch).not.toBe(head.epoch);
  } finally {
    h.pilot.close();
  }
});

it('publishes validated vault availability and fences a delayed status probe on revoke', async () => {
  const h = fixture();
  try {
    ready(await h.pilot.setup(grant(), null));
    invalidateCopilotRuntimeAvailability();
    expect((await h.backend.copilotConnectionStatus()).enabled).toBe(true);
    expect(peekCopilotRuntimeAvailability()).toBe(true);
    const pending = deferred<CopilotGrantResult>();
    const captured = ready(await h.pilot.authority.status());
    jest.spyOn(h.port, 'status').mockReturnValueOnce(pending.promise);
    const reading = h.backend.copilotConnectionStatus();
    await h.backend.revokeCopilotRuntimes();
    expect(peekCopilotRuntimeAvailability()).toBe(false);
    pending.resolve({ kind: 'ready', head: captured });
    await reading;
    expect(peekCopilotRuntimeAvailability()).toBe(false);
  } finally {
    h.pilot.close();
  }
});

it.each(['failed', 'unconfirmed'] as const)(
  'retains rejected deletion lineage when exact receipt disable is %s, then retries without a second deletion',
  async (kind) => {
    const h = fixture();
    try {
      const head = ready(
        await h.pilot.setup(
          {
            ...grant(),
            accessTokenExpiresAt: new Date(
              Date.now() + 1_800_000,
            ).toISOString(),
          },
          null,
        ),
      );
      const disable = jest
        .spyOn(h.selection, 'disable')
        .mockResolvedValueOnce({ kind });
      h.refreshRejected();
      await expect(
        h.backend.listCopilotModels(new AbortController().signal),
      ).rejects.toMatchObject({ code: 'unavailable' });
      const state = await h.pilot.authority.status();
      expect(state.kind).toBe('pending');
      if (state.kind !== 'pending') throw new Error('Missing pending deletion');
      expect(h.state().head).toEqual(head);
      expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(await h.pilot.authority.resume(state.operationId)).toEqual({
        kind: 'removed',
      });
      expect(disable).toHaveBeenCalledTimes(2);
      expect(disable.mock.calls[1]?.[0].head).toEqual(head);
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
      expect(await h.pilot.authority.status()).toEqual({
        kind: 'blocked',
        reason: 'absent',
      });
    } finally {
      h.pilot.close();
    }
  },
);

it('does not retire a newer selection receipt on rejected-grant deletion', async () => {
  const h = fixture();
  try {
    ready(
      await h.pilot.setup(
        {
          ...grant(),
          accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
        null,
      ),
    );
    const previous = h.preferences().copilotVaultSelection;
    if (!previous) throw new Error('Missing receipt');
    const newer = {
      ...previous,
      identity: {
        ...previous.identity,
        operationId: 'newer-operation',
        epoch: 'newer-epoch',
      },
      pinGeneration: 'newer-pin',
    };
    h.setPreferences({ ...h.preferences(), copilotVaultSelection: newer });
    h.refreshRejected();
    await expect(
      h.backend.listCopilotModels(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.preferences().copilotVaultSelection).toEqual(newer);
    expect(h.preferences().copilotEnabled).toBe(true);
    expect((await h.pilot.authority.status()).kind).toBe('pending');
  } finally {
    h.pilot.close();
  }
});

it.each(['models', 'quota'] as const)(
  'projects %s launch context through the trusted host key, preserving an empty environment snapshot',
  async (purpose) => {
    const h = fixture();
    try {
      ready(await h.pilot.setup(grant(), null));
      const environment: Record<string, string> = {};
      const launch = {
        owner: { kind: 'discovery', id: `copilot-${purpose}` } as const,
        cwd: '/trusted/workspace',
        workspaceId: 'workspace',
        executionKind: 'pipeline' as const,
        restrictedEnvironment: false,
        environment,
      };
      const runtime = await h.backend.openManagedCopilotRuntime({
        ...launch,
        purpose,
        signal: new AbortController().signal,
      });
      environment.LATE_MUTATION = 'not admitted';
      if (purpose === 'models')
        await runtime.listModels(new AbortController().signal);
      else await runtime.getQuota(new AbortController().signal);
      expect(h.launches[1]).toEqual({ ...launch, environment: {} });
      await runtime.close();
    } finally {
      h.pilot.close();
    }
  },
);

it.each(['unsupported', 'uninstalled', 'absent', 'unavailable'] as const)(
  'publishes unavailable for %s vault status',
  async (condition) => {
    const h = fixture();
    try {
      ready(await h.pilot.setup(grant(), null));
      await h.backend.copilotConnectionStatus();
      expect(peekCopilotRuntimeAvailability()).toBe(true);
      const backend = createCopilotVaultConnection({
        port: h.port,
        installation: () =>
          Promise.resolve({
            ...base,
            supported: condition !== 'unsupported',
            installed: condition !== 'uninstalled',
          }),
      });
      if (condition === 'absent')
        await h.pilot.authority.remove(
          ready(await h.pilot.authority.status()).epoch,
        );
      if (condition === 'unavailable')
        jest
          .spyOn(h.port, 'status')
          .mockRejectedValueOnce(new Error('Lost status'));
      if (condition === 'unavailable')
        await expect(backend.copilotConnectionStatus()).rejects.toThrow(
          'Lost status',
        );
      else await backend.copilotConnectionStatus();
      expect(peekCopilotRuntimeAvailability()).toBe(false);
    } finally {
      h.pilot.close();
    }
  },
);

it('preserves cancellation during proxy open when acquired handle cleanup rejects', async () => {
  const h = fixture();
  const native = nativeRuntime();
  const cleanupError = new Error('Opening cleanup rejected');
  native.runtime.close.mockRejectedValue(cleanupError);
  const acquired =
    deferred<
      Awaited<ReturnType<CopilotConnectionBackend['openManagedCopilotRuntime']>>
    >();
  const opening = deferred<void>();
  const abort = new AbortController();
  const proxy = createCopilotConnectionProxy({
    legacy: {
      ...h.backend,
      openManagedCopilotRuntime: () => {
        opening.resolve();
        return acquired.promise;
      },
    },
    selected: () => Promise.resolve(false),
    vault: () => h.backend,
    assertEnabled: () => undefined,
  });
  const warnings = jest.spyOn(process, 'emitWarning');
  try {
    const pending = proxy.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: abort.signal,
    });
    void pending.catch(() => undefined);
    await opening.promise;
    abort.abort();
    acquired.resolve({
      ...native.runtime,
      listModels: () => Promise.resolve([]),
      getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
    });
    await expect(pending).rejects.toBe(abort.signal.reason);
    expect(native.runtime.close).toHaveBeenCalledTimes(1);
    expect(warnings).toHaveBeenCalledTimes(1);
  } finally {
    h.pilot.close();
  }
});

it.each(['session', 'models', 'quota'] as const)(
  'cancels pending %s startup and releases its policy before a late runtime returns',
  async (purpose) => {
    const h = fixture();
    const returning =
      deferred<Awaited<ReturnType<CopilotVaultPilotOptions['start']>>>();
    const starting = deferred<{
      signal: AbortSignal;
      runtime: Awaited<ReturnType<CopilotVaultPilotOptions['start']>>;
    }>();
    const abort = new AbortController();
    let lateRuntime:
      | Awaited<ReturnType<CopilotVaultPilotOptions['start']>>
      | undefined;
    try {
      ready(await h.pilot.setup(grant(), null));
      const start = h.pilotOptions.start.bind(h.pilotOptions);
      jest
        .spyOn(h.pilotOptions, 'start')
        .mockImplementation(async (...args) => {
          const runtime = await start(...args);
          starting.resolve({ signal: args[1], runtime });
          return returning.promise;
        });
      const release = jest.spyOn(h.port, 'releasePolicy');
      const project = jest.spyOn(h.port, 'projectPolicy');
      const handle = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        purpose,
        signal: new AbortController().signal,
      });
      let settled = false;
      const pending = (
        purpose === 'session'
          ? handle.runTurn(turn({ signal: abort.signal }))
          : purpose === 'models'
            ? handle.listModels(abort.signal)
            : handle.getQuota(abort.signal)
      ).catch((error: unknown) => {
        settled = true;
        return error;
      });
      const started = await starting.promise;
      lateRuntime = started.runtime;
      const close = jest.spyOn(started.runtime, 'close');
      abort.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(started.signal.aborted).toBe(true);
      expect(settled).toBe(true);
      expect(await pending).toBe(abort.signal.reason);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(
        await project.mock.results[0]?.value,
      );
      expect(close).not.toHaveBeenCalled();
      returning.resolve(started.runtime);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(close).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
      await handle.close();
    } finally {
      if (lateRuntime) returning.resolve(lateRuntime);
      h.pilot.close();
    }
  },
);

it.each(['turn', 'handle', 'close'] as const)(
  'closes a channel delivered after %s cancellation without retaining its policy',
  async (source) => {
    const h = fixture();
    type Channel = Awaited<ReturnType<CopilotVaultConnectionPort['open']>>;
    const returning = deferred<Channel>();
    const acquired = deferred<{
      channel: Channel;
      signal: AbortSignal | undefined;
    }>();
    const abort = new AbortController();
    let lateChannel: Channel | undefined;
    try {
      ready(await h.pilot.setup(grant(), null));
      const open = h.port.open.bind(h.port);
      jest.spyOn(h.port, 'open').mockImplementation(async (...args) => {
        const channel = await open(...args);
        acquired.resolve({ channel, signal: args[4] });
        return returning.promise;
      });
      const release = jest.spyOn(h.port, 'releasePolicy');
      const project = jest.spyOn(h.port, 'projectPolicy');
      const handle = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal:
          source === 'handle' ? abort.signal : new AbortController().signal,
      });
      let settled = false;
      const pending = handle
        .runTurn(
          turn({
            signal:
              source === 'turn' ? abort.signal : new AbortController().signal,
          }),
        )
        .catch((error: unknown) => {
          settled = true;
          return error;
        });
      const opened = await acquired.promise;
      lateChannel = opened.channel;
      const disconnect = jest.spyOn(opened.channel, 'disconnect');
      const receive = jest.spyOn(opened.channel, 'receive');
      if (source === 'close') await handle.close();
      else abort.abort();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(opened.signal?.aborted).toBe(true);
      expect(settled).toBe(true);
      const result = await pending;
      if (source === 'close')
        expect(result).toMatchObject({ code: 'unavailable' });
      else expect(result).toBe(abort.signal.reason);
      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(
        await project.mock.results[0]?.value,
      );
      expect(disconnect).not.toHaveBeenCalled();
      returning.resolve(opened.channel);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(receive).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      if (lateChannel) returning.resolve(lateChannel);
      h.pilot.close();
    }
  },
);

it('invalidates published vault availability after selection becomes unreadable', async () => {
  const h = fixture();
  const select = jest.fn(() => Promise.resolve(true));
  const proxy = createCopilotConnectionProxy({
    legacy: h.backend,
    selected: select,
    vault: () => h.backend,
    assertEnabled: () => undefined,
  });
  try {
    ready(await h.pilot.setup(grant(), null));
    await proxy.copilotConnectionStatus();
    expect(peekCopilotRuntimeAvailability()).toBe(true);
    select.mockRejectedValueOnce(new Error('Selection unreadable'));
    await expect(proxy.copilotConnectionStatus()).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(peekCopilotRuntimeAvailability()).toBe(false);
  } finally {
    h.pilot.close();
  }
});

it('one Connect reconciles pending rejected deletion and starts replacement setup', async () => {
  const h = fixture();
  try {
    const head = ready(
      await h.pilot.setup(
        {
          ...grant(),
          accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
        null,
      ),
    );
    jest
      .spyOn(h.selection, 'disable')
      .mockResolvedValueOnce({ kind: 'unconfirmed' });
    h.refreshRejected();
    await expect(
      h.backend.listCopilotModels(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect((await h.pilot.authority.status()).kind).toBe('pending');
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: h.port,
      installation: () => Promise.resolve(base),
      authorize,
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
    });
    expect(
      (
        await backend.connectCopilot(
          new AbortController().signal,
          () => undefined,
        )
      ).enabled,
    ).toBe(true);
    expect(ready(await h.pilot.authority.status()).epoch).not.toBe(head.epoch);
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(h.remove).toHaveBeenCalledTimes(1);
  } finally {
    h.pilot.close();
  }
});

it.each([
  'aggregate-oversized',
  'aggregate-bounded',
  'aggregate-escaped',
  'content',
  'detailed',
  'blocks',
  'escaped',
  'empty',
  'boundary',
  'failed',
  'many-blocks',
] as const)(
  'completes selected turns with bounded %s tool observations',
  async (mode) => {
    const h = fixture(true);
    ready(await h.pilot.setup(grant(), null));
    const accepted = deferred<void>();
    const frames: number[] = [];
    const open = h.port.open.bind(h.port);
    jest.spyOn(h.port, 'open').mockImplementation((...args) => {
      const [purpose, audience, policy, write] = args;
      return open(purpose, audience, policy, (encoded) => {
        frames.push(Buffer.byteLength(encoded, 'utf8'));
        return write(encoded);
      });
    });
    const observations: Parameters<
      NonNullable<CopilotTurnRequest['onEvent']>
    >[0][] = [];
    const transcript: Record<string, unknown>[] = [];
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const running = runtime.runTurn(
      turn({
        onPromptAccepted: () => {
          accepted.resolve();
        },
        onEvent: (event) => {
          observations.push(event);
        },
        emit: (event) => {
          transcript.push(event);
        },
      }),
    );
    void running.catch(() => undefined);
    await accepted.promise;
    const config = h.natives[1]?.configs[0];
    if (!config?.onEvent) throw new Error('Missing selected SDK session');
    const text =
      mode === 'escaped' || mode === 'aggregate-escaped'
        ? '\u0000'.repeat(65_536)
        : mode === 'empty'
          ? ''
          : mode === 'boundary' || mode === 'aggregate-bounded'
            ? 'x'.repeat(65_536)
            : mode === 'many-blocks'
              ? 'short'
              : 'x'.repeat(100_000);
    config.onEvent({
      id: 'large-start',
      type: 'tool.execution_start',
      timestamp: new Date().toISOString(),
      parentId: null,
      data: {
        toolCallId: 'large-call',
        toolName: mode.startsWith('aggregate') ? 'grep' : 'view',
        arguments: mode.startsWith('aggregate')
          ? {
              pattern: '\\'.repeat(
                mode === 'aggregate-bounded' ? 26_000 : 31_000,
              ),
            }
          : { path: '/trusted/workspace/large.txt' },
      },
    });
    config.onEvent({
      id: 'large-completion',
      type: 'tool.execution_complete',
      timestamp: new Date().toISOString(),
      parentId: null,
      data: {
        toolCallId: 'large-call',
        success: mode !== 'failed',
        result: {
          content: mode === 'detailed' || mode === 'blocks' ? 'summary' : text,
          ...(mode === 'detailed' || mode === 'escaped'
            ? { detailedContent: text }
            : {}),
          contents: Array.from(
            { length: mode === 'many-blocks' ? 257 : 1 },
            () => ({ type: 'text' as const, text }),
          ),
        },
      },
    });
    config.onEvent({
      id: 'idle',
      type: 'session.idle',
      ephemeral: true,
      timestamp: new Date().toISOString(),
      parentId: null,
      data: {},
    });
    try {
      await expect(running).resolves.toMatchObject({
        text: 'Verified evidence',
      });
      const completion = observations.find(
        (event) => event.type === 'tool.execution_complete',
      );
      if (completion?.type !== 'tool.execution_complete')
        throw new Error('Missing completion observation');
      expect(completion.data.result?.content.length).toBeLessThanOrEqual(
        65_536,
      );
      if (mode === 'empty' || mode === 'boundary') {
        expect(completion.data.result?.content).toBe(text);
        expect(completion.data.result?.contents).toEqual([
          { type: 'text', text },
        ]);
      } else if (mode !== 'aggregate-bounded') {
        expect(completion.data.result?.contents).toBeUndefined();
        expect(completion.data.result?.detailedContent).toBeUndefined();
      }
      expect(Math.max(...frames)).toBeLessThanOrEqual(262_144);
      if (mode.startsWith('aggregate')) {
        const input = JSON.stringify({
          pattern: '\\'.repeat(mode === 'aggregate-bounded' ? 26_000 : 31_000),
        });
        const blocks = transcript.flatMap((event) => {
          const parsed = CopilotAssistantPatchSchema.safeParse(event);
          return parsed.success
            ? parsed.data.patches.flatMap((patch) =>
                'block' in patch ? [patch.block] : [],
              )
            : [];
        });
        const use = blocks.find((block) => block.type === 'tool_use');
        const result = blocks.find((block) => block.type === 'tool_result');
        expect(use?.input).toBe(input);
        expect(use?.display).toBeUndefined();
        expect(result?.output).toBe(text.slice(0, 16_384));
      }
    } finally {
      h.pilot.close();
    }
  },
);

it.each(['ok', 'failed', 'lost'] as const)(
  'cancels an uncommitted setup and reconnects after %s abandon acknowledgement',
  async (mode) => {
    const h = fixture();
    h.put.mockResolvedValueOnce({ kind: 'blocked', reason: 'unavailable' });
    const abort = new AbortController();
    const port: CopilotVaultConnectionPort = {
      ...h.port,
      setup: async (...args) => {
        const result = await h.pilot.setup(...args);
        expect(result.kind).toBe('pending');
        abort.abort();
        return result;
      },
    };
    const abandon = h.selection.abandon.bind(h.selection);
    const abandoning = jest.spyOn(h.selection, 'abandon');
    if (mode !== 'ok')
      abandoning.mockImplementationOnce(async (identity) => {
        if (mode === 'lost') await abandon(identity);
        throw new Error('Preference acknowledgement unavailable');
      });
    const backend = createCopilotVaultConnection({
      port,
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize: () => Promise.resolve(grant()),
    });
    await expect(
      backend.connectCopilot(abort.signal, () => undefined),
    ).rejects.toThrow();
    try {
      if (mode !== 'ok') {
        const pending = await h.port.status();
        expect(pending.kind).toBe('pending');
        if (pending.kind !== 'pending')
          throw new Error('Cancellation was not retained');
        expect(h.state().mutation?.cancelling).toBe(true);
        expect(await h.port.resume(pending.operationId)).toEqual({
          kind: 'removed',
        });
      }
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
      expect(await h.port.status()).toEqual({
        kind: 'blocked',
        reason: 'absent',
      });
      const next = await h.pilot.setup(
        grant(),
        h.preferences().copilotVaultSelection?.pinGeneration ?? null,
      );
      expect(next.kind).toBe('ready');
      expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
    } finally {
      h.pilot.close();
    }
  },
);

it.each([false, true])(
  'probe failure must preserve cancellation after previous removal=%s',
  async (previousRemoval) => {
    const h = fixture();
    if (previousRemoval) {
      const first = ready(await h.pilot.setup(grant(), null));
      expect(await h.pilot.authority.remove(first.epoch)).toEqual({
        kind: 'removed',
      });
    }
    const entered = deferred<void>();
    const probe = deferred<void>();
    h.list.mockImplementationOnce(async () => {
      entered.resolve();
      await probe.promise;
      throw new Error('Probe interrupted');
    });
    const settingUp = h.pilot.setup(
      grant(),
      h.preferences().copilotVaultSelection?.pinGeneration ?? null,
    );
    await entered.promise;
    const operation = h.state().mutation?.operationId;
    if (!operation) throw new Error('Missing probe setup');
    jest
      .spyOn(h.selection, 'abandon')
      .mockRejectedValue(new Error('Preferences unavailable'));
    expect((await h.pilot.authority.cancel(operation)).kind).toBe('blocked');
    expect(h.state().mutation?.cancelling).toBe(true);
    probe.resolve();
    await settingUp;
    try {
      expect(h.state().mutation?.cancelling).toBe(true);
      expect(await h.pilot.authority.status()).toEqual({
        kind: 'pending',
        operationId: operation,
        operation: { kind: 'create', origin: 'setup' },
      });
      jest.restoreAllMocks();
      expect(await h.pilot.authority.resume(operation)).toEqual({
        kind: 'removed',
      });
      expect(
        (
          await h.pilot.setup(
            grant(),
            h.preferences().copilotVaultSelection?.pinGeneration ?? null,
          )
        ).kind,
      ).toBe('ready');
      expect(h.pilot.authority.recipientGeneration()).not.toBeUndefined();
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      await expect(runtime.runTurn(turn())).resolves.toMatchObject({
        text: 'Verified evidence',
      });
    } finally {
      h.pilot.close();
    }
  },
);

it.each(['disconnect', 'change-account'] as const)(
  'resumes pending removal on %s retry after preference recovery',
  async (action) => {
    const h = fixture();
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: h.port,
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize,
    });
    try {
      const head = ready(await h.pilot.setup(grant(), null));
      const disable = jest
        .spyOn(h.selection, 'disable')
        .mockResolvedValueOnce({ kind: 'unconfirmed' });
      await expect(backend.disconnectCopilot()).rejects.toMatchObject({
        code: 'unavailable',
      });
      const pending = await h.port.status();
      expect(pending.kind).toBe('pending');
      expect(h.state().removal?.epoch).toBe(head.epoch);
      expect(h.remove).not.toHaveBeenCalled();
      if (action === 'disconnect') {
        await expect(backend.disconnectCopilot()).resolves.toBeUndefined();
        expect(await h.port.status()).toEqual({
          kind: 'blocked',
          reason: 'absent',
        });
        expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
        expect(authorize).not.toHaveBeenCalled();
      } else {
        await expect(
          backend.connectCopilot(
            new AbortController().signal,
            () => undefined,
            true,
          ),
        ).resolves.toMatchObject({ enabled: true });
        expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
        expect(authorize).toHaveBeenCalledTimes(1);
      }
      expect(disable).toHaveBeenCalledTimes(2);
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(h.state().removal).toBeNull();
    } finally {
      h.pilot.close();
    }
  },
);

it('resumes a pending cancellation delete on Disconnect', async () => {
  const h = fixture();
  try {
    h.failPin();
    const setup = await h.pilot.setup(grant(), null);
    if (setup.kind !== 'blocked' && setup.kind !== 'pending')
      throw new Error('Setup was not fenced');
    const pending = await h.port.status();
    if (pending.kind !== 'pending') throw new Error('No setup intent');
    h.remove.mockRejectedValueOnce(new Error('Vault unavailable'));
    await h.port.cancel(pending.operationId);
    expect(h.state().mutation?.kind).toBe('delete');
    expect((await h.port.status()).kind).toBe('pending');
    await expect(h.backend.disconnectCopilot()).resolves.toBeUndefined();
    expect(await h.port.status()).toEqual({
      kind: 'blocked',
      reason: 'absent',
    });
    expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
    expect(h.remove).toHaveBeenCalledTimes(2);
  } finally {
    h.pilot.close();
  }
});

it('resumes a pending rejected deletion on Disconnect', async () => {
  const h = fixture();
  try {
    ready(
      await h.pilot.setup(
        {
          ...grant(),
          accessTokenExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
        },
        null,
      ),
    );
    jest
      .spyOn(h.selection, 'disable')
      .mockResolvedValueOnce({ kind: 'unconfirmed' });
    h.refreshRejected();
    await expect(
      h.backend.listCopilotModels(new AbortController().signal),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(h.state().mutation?.kind).toBe('delete');
    expect(h.state().removal).toBeNull();
    await expect(h.backend.disconnectCopilot()).resolves.toBeUndefined();
    expect(await h.port.status()).toEqual({
      kind: 'blocked',
      reason: 'absent',
    });
    expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
    expect(h.remove).toHaveBeenCalledTimes(1);
  } finally {
    h.pilot.close();
  }
});

it.each(['refresh', 'replace'] as const)(
  'keeps uncertain %s recovery fenced across control and read entry points',
  async (kind) => {
    const h = fixture();
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: h.port,
      installation: () => Promise.resolve(base),
      authorize,
    });
    try {
      const head = ready(await h.pilot.setup(grant(), null));
      const before = h.state();
      expect(
        await h.pilotOptions.journal.compareExchange(before.sequence, {
          ...before,
          sequence: before.sequence + 1,
          mutation: {
            operationId: 'orphaned-presentation',
            epoch: head.epoch,
            account: head.account,
            origin: head.origin,
            kind,
            from: head.pin,
            committed: null,
            probeConfirmed: true,
            cancelling: false,
          },
        }),
      ).toBe(true);
      const pending = await h.port.status();
      expect(pending).toEqual({
        kind: 'pending',
        operationId: 'orphaned-presentation',
        operation: { kind, origin: 'setup' },
      });
      const retained = h.state();
      const cancel = jest.spyOn(h.port, 'cancel');
      const resume = jest.spyOn(h.port, 'resume');
      await expect(backend.copilotConnectionStatus()).resolves.toMatchObject({
        enabled: false,
      });
      await expect(backend.recoverCopilotAtStartup()).resolves.toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
      for (const action of [
        (): Promise<CopilotConnectionStatus> =>
          backend.connectCopilot(new AbortController().signal, () => undefined),
        (): ReturnType<CopilotConnectionBackend['listCopilotModels']> =>
          backend.listCopilotModels(new AbortController().signal),
        (): ReturnType<CopilotConnectionBackend['readCopilotAccountUsage']> =>
          backend.readCopilotAccountUsage(new AbortController().signal),
      ]) {
        await expect(action()).rejects.toMatchObject({ code: 'unavailable' });
        expect(h.state()).toEqual(retained);
      }
      expect(resume).toHaveBeenCalledTimes(1);
      for (const [id] of resume.mock.calls)
        expect(id).toBe('orphaned-presentation');
      expect(cancel).not.toHaveBeenCalled();
      expect(authorize).not.toHaveBeenCalled();
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.list).toHaveBeenCalledTimes(1);
      expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
    } finally {
      h.pilot.close();
    }
  },
);

it.each(['refresh', 'replace'] as const)(
  'Disconnect removes only the exact pending %s identity without provider recovery',
  async (kind) => {
    const h = fixture();
    try {
      const head = ready(await h.pilot.setup(grant(), null));
      const before = h.state();
      const operationId = 'pending-successor';
      expect(
        await h.pilotOptions.journal.compareExchange(before.sequence, {
          ...before,
          sequence: before.sequence + 1,
          mutation: {
            operationId,
            epoch: head.epoch,
            origin: head.origin,
            account: head.account,
            kind,
            from: head.pin,
            committed: null,
            probeConfirmed: true,
            cancelling: false,
          },
        }),
      ).toBe(true);
      const retained = h.state();
      expect(
        await h.pilot.authority.removePending('foreign-operation'),
      ).toEqual({ kind: 'blocked', reason: 'changed' });
      expect(h.state()).toEqual(retained);
      const resume = jest.spyOn(h.port, 'resume');
      const cancel = jest.spyOn(h.port, 'cancel');
      await expect(h.backend.disconnectCopilot()).resolves.toBeUndefined();
      expect(resume).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(h.refresh).not.toHaveBeenCalled();
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(h.remove.mock.calls[0]?.[0]).toMatchObject({
        ref: head.pin.ref,
        expectedRevision: head.pin.revision,
      });
      expect(h.state().head).toBeNull();
      expect(h.state().mutation).toBeNull();
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
    } finally {
      h.pilot.close();
    }
  },
);

it.each([false, true])(
  'Disconnect cancels pending setup create with cancelling=%s and retains failed cleanup for retry',
  async (cancelling) => {
    const h = fixture();
    try {
      if (cancelling)
        h.list.mockRejectedValueOnce(new Error('Entitlement unavailable'));
      else h.failPin();
      const cleanup = cancelling
        ? jest
            .spyOn(h.selection, 'abandon')
            .mockRejectedValue(new Error('Preferences unavailable'))
        : jest
            .spyOn(h.selection, 'disable')
            .mockResolvedValueOnce({ kind: 'unconfirmed' });
      await h.pilot.setup(grant(), null);
      const pending = await h.port.status();
      expect(pending.kind).toBe('pending');
      if (pending.kind !== 'pending') throw new Error('Missing cleanup intent');
      expect(pending.operation).toEqual({ kind: 'create', origin: 'setup' });
      const cancel = jest.spyOn(h.port, 'cancel');
      const resume = jest.spyOn(h.port, 'resume');
      await expect(h.backend.disconnectCopilot()).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect((await h.port.status()).kind).toBe('pending');
      expect(h.state().mutation?.cancelling).toBe(true);
      cleanup.mockRestore();
      await expect(h.backend.disconnectCopilot()).resolves.toBeUndefined();
      expect(cancel.mock.calls).toEqual([
        [pending.operationId],
        [pending.operationId],
      ]);
      expect(resume).not.toHaveBeenCalled();
      expect(h.remove).toHaveBeenCalledTimes(cancelling ? 0 : 1);
      expect(h.put).toHaveBeenCalledTimes(cancelling ? 0 : 1);
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
    } finally {
      h.pilot.close();
    }
  },
);

it.each(
  (['plain', 'escaped', 'overlapping', 'mixed'] as const).flatMap((shape) =>
    (['success', 'failure'] as const).map((outcome) => ({ shape, outcome })),
  ),
)('redaction parity $shape on $outcome', async ({ shape, outcome }) => {
  // qzx7w is outside hex, so it cannot occur inside randomUUID() ids on the wire.
  const secret =
    shape === 'escaped'
      ? 'caller-"private"\\value\nqzx7w'
      : 'caller-private-value-qzx7w';
  const secrets =
    shape === 'overlapping' ? [secret, 'value-qzx7w-tail'] : [secret];
  const encoded = JSON.stringify(secret).slice(1, -1);
  const parts =
    shape === 'escaped'
      ? [encoded.slice(0, 11), encoded.slice(11, 21), encoded.slice(21)]
      : [
          'caller-private-',
          'value-',
          shape === 'overlapping' ? 'qzx7w-tail' : 'qzx7w',
        ];
  async function execute(selected: boolean): Promise<{
    blocks: unknown[];
    text: string | undefined;
    frames: string[];
    error: string | undefined;
  }> {
    const h = fixture(true);
    const native = nativeRuntime({ hold: true, sessionId: 'session-1' });
    const frames: string[] = [];
    const transcript: unknown[] = [];
    const accepted = deferred<void>();
    try {
      if (selected) {
        ready(await h.pilot.setup(grant(), null));
        const open = h.port.open.bind(h.port);
        jest
          .spyOn(h.port, 'open')
          .mockImplementation((purpose, audience, policy, write) =>
            open(purpose, audience, policy, (encoded) => {
              frames.push(encoded);
              return write(encoded);
            }),
          );
      }
      const runtime = selected
        ? await h.backend.openManagedCopilotRuntime({
            owner: TEST_OWNER,
            signal: new AbortController().signal,
          })
        : native.runtime;
      const running = runtime.runTurn(
        turn({
          secretValues: secrets,
          onPromptAccepted: () => {
            accepted.resolve();
          },
          emit: (event) => {
            transcript.push(event);
          },
        }),
      );
      const settled = running.then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
      await accepted.promise;
      const config = selected ? h.natives[1]?.configs[0] : native.configs[0];
      if (!config?.onEvent) throw new Error('Missing session');
      for (const [index, content] of parts.entries()) {
        const base = {
          id: `split-${index}`,
          timestamp: new Date(0).toISOString(),
          parentId: null,
        };
        let event: SessionEvent;
        if (shape === 'mixed' && index === 0)
          event = {
            ...base,
            type: 'assistant.reasoning',
            data: { reasoningId: 'reason', content },
          };
        else if (shape === 'mixed' && index === 1) {
          config.onEvent({
            ...base,
            id: 'tool-start',
            type: 'tool.execution_start',
            data: {
              toolCallId: 'view',
              toolName: 'view',
              arguments: { path: '/trusted/workspace/file' },
            },
          });
          event = {
            ...base,
            type: 'tool.execution_complete',
            data: { toolCallId: 'view', success: true, result: { content } },
          };
        } else
          event = {
            ...base,
            type: 'assistant.message',
            data: { messageId: `split-${index}`, content },
          };
        config.onEvent(event);
      }
      config.onEvent(
        outcome === 'success'
          ? {
              id: 'end',
              type: 'session.idle',
              ephemeral: true,
              timestamp: new Date(0).toISOString(),
              parentId: null,
              data: {},
            }
          : {
              id: 'end',
              type: 'session.error',
              timestamp: new Date(0).toISOString(),
              parentId: null,
              data: {
                message: `Fixture failed: ${secret}`,
                errorType: 'unknown',
              },
            },
      );
      const value = await settled;
      if (outcome === 'success') expect(value.error).toBeUndefined();
      else expect(value.error).toBeInstanceOf(Error);
      const blocks = transcript.flatMap((event) => {
        const patch = CopilotAssistantPatchSchema.parse(event);
        return patch.patches.flatMap((item) =>
          'block' in item ? [item.block] : [],
        );
      });
      return {
        blocks,
        text: value.result?.text,
        frames,
        error: value.error instanceof Error ? value.error.message : undefined,
      };
    } finally {
      h.pilot.close();
    }
  }
  const legacy = await execute(false);
  const vault = await execute(true);
  if (outcome === 'success') expect(vault.blocks).toEqual(legacy.blocks);
  else expect(vault.blocks).toEqual([]);
  expect(vault.text).toEqual(legacy.text);
  expect(JSON.stringify(legacy.blocks)).toContain('***');
  expect(JSON.stringify(vault.blocks)).not.toMatch(
    /caller-private-|private|value-|qzx7w|tail/,
  );
  expect(vault.frames.join('')).not.toMatch(
    /caller-private-|private|value-|qzx7w|tail/,
  );
  expect(vault.error ?? '').not.toMatch(
    /caller-private-|private|value-|qzx7w|tail/,
  );
});

it('field parity preserves a caller turn timeout below the lease limit', async () => {
  jest.useFakeTimers();
  const h = fixture(true);
  try {
    ready(await h.pilot.setup(grant(), null));
    const accepted = deferred<void>();
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    let settled = false;
    const running = runtime.runTurn(
      turn({
        timeoutMs: 50,
        onPromptAccepted: () => {
          accepted.resolve();
        },
      }),
    );
    const result = running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await accepted.promise;
    await jest.advanceTimersByTimeAsync(51);
    expect(settled).toBe(true);
    await result;
  } finally {
    h.pilot.close();
    jest.useRealTimers();
  }
});

it.each(['onMcpToolsReady', 'requestManagedPermission'] as const)(
  'field parity explicitly refuses unsupported %s before opening a channel',
  async (field) => {
    const h = fixture();
    try {
      ready(await h.pilot.setup(grant(), null));
      const open = jest.spyOn(h.port, 'open');
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      await expect(
        runtime.runTurn(
          turn(
            field === 'onMcpToolsReady'
              ? { onMcpToolsReady: (): void => undefined }
              : {
                  requestManagedPermission: (): Promise<{
                    kind: 'approved';
                  }> => Promise.resolve({ kind: 'approved' }),
                },
          ),
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(open).not.toHaveBeenCalled();
    } finally {
      h.pilot.close();
    }
  },
);

it('redaction policy refuses a secret-bearing observation before it reaches a callback frame', async () => {
  const h = fixture(true);
  const secret = 'caller-private-value-12345';
  const frames: string[] = [];
  try {
    ready(await h.pilot.setup(grant(), null));
    const open = h.port.open.bind(h.port);
    jest
      .spyOn(h.port, 'open')
      .mockImplementation((purpose, audience, policy, write) =>
        open(purpose, audience, policy, (encoded) => {
          frames.push(encoded);
          return write(encoded);
        }),
      );
    const accepted = deferred<void>();
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const running = runtime.runTurn(
      turn({
        secretValues: [secret],
        onEvent: () => undefined,
        onPromptAccepted: () => {
          accepted.resolve();
        },
      }),
    );
    const settled = running.catch((error: unknown) => error);
    await accepted.promise;
    const config = h.natives[1]?.configs[0];
    if (!config?.onEvent) throw new Error('Missing session');
    config.onEvent({
      id: 'secret-call',
      type: 'tool.execution_start',
      timestamp: new Date(0).toISOString(),
      parentId: null,
      data: {
        toolCallId: 'secret-call',
        toolName: 'view',
        arguments: { path: `/trusted/workspace/${secret}` },
      },
    });
    config.onEvent({
      id: 'idle',
      type: 'session.idle',
      ephemeral: true,
      timestamp: new Date(0).toISOString(),
      parentId: null,
      data: {},
    });
    expect(await settled).toMatchObject({ code: 'unavailable' });
    expect(frames.join('')).not.toContain(secret);
  } finally {
    h.pilot.close();
  }
});

it('refuses encoded callback secrets at the decoded argument boundary', async () => {
  const h = fixture(true);
  const frames: string[] = [];
  const secret = 'caller-"private"\\value\n12345';
  const once = JSON.stringify(secret).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  const authorize = jest.fn<
    ReturnType<CopilotTurnRequest['authorize']>,
    Parameters<CopilotTurnRequest['authorize']>
  >(() => Promise.resolve({ decision: 'allow' }));
  try {
    ready(await h.pilot.setup(grant(), null));
    const open = h.port.open.bind(h.port);
    jest
      .spyOn(h.port, 'open')
      .mockImplementation((purpose, audience, policy, write) =>
        open(purpose, audience, policy, (encoded) => {
          frames.push(encoded);
          return write(encoded);
        }),
      );
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const accepted = deferred<void>();
    const running = runtime.runTurn(
      turn({
        secretValues: [secret],
        authorize,
        onPromptAccepted: () => {
          accepted.resolve();
        },
      }),
    );
    const settled = running.catch((error: unknown) => error);
    await accepted.promise;
    const config = h.natives[1]?.configs[0];
    if (!config?.onEvent || !config.hooks?.onPreToolUse)
      throw new Error('Missing session');
    const args = { content: twice };
    config.onEvent({
      id: 'encoded-start',
      type: 'tool.execution_start',
      timestamp: new Date(0).toISOString(),
      parentId: null,
      data: { toolCallId: 'encoded-call', toolName: 'view', arguments: args },
    });
    const decision = await config.hooks.onPreToolUse(
      {
        sessionId: 'session-1',
        timestamp: new Date(),
        workingDirectory: '/trusted/workspace',
        toolName: 'view',
        toolArgs: args,
      },
      { sessionId: 'session-1' },
    );
    config.onEvent({
      id: 'idle',
      type: 'session.idle',
      ephemeral: true,
      timestamp: new Date(0).toISOString(),
      parentId: null,
      data: {},
    });
    const result = await settled;
    expect(authorize).not.toHaveBeenCalled();
    expect(decision).toMatchObject({ permissionDecision: 'deny' });
    expect(result).toMatchObject({ code: 'unavailable' });
    expect(frames.join('')).not.toContain('private');
    expect(String(result)).not.toContain('private');
  } finally {
    h.pilot.close();
  }
});

it.each(
  (['allow', 'deny'] as const).flatMap((decision) =>
    (['plain', 'sensitive', 'oversized'] as const).map((reason) => ({
      decision,
      reason,
    })),
  ),
)(
  'preserves $decision authority with a $reason approval reason',
  async ({ decision, reason }) => {
    const h = fixture(true);
    const secret = 'caller-private-value-12345';
    const message =
      reason === 'sensitive'
        ? `Host policy hides ${secret} in /trusted/workspace under /trusted/config.`
        : reason === 'oversized'
          ? 'x'.repeat(65_537)
          : 'Host policy explains this decision.';
    const frames: string[] = [];
    try {
      ready(await h.pilot.setup(grant(), null));
      const open = h.port.open.bind(h.port);
      jest
        .spyOn(h.port, 'open')
        .mockImplementation((purpose, audience, policy, write) =>
          open(purpose, audience, policy, write).then((channel) => ({
            ...channel,
            receive: (encoded: string): Promise<void> => {
              frames.push(encoded);
              return channel.receive(encoded);
            },
          })),
        );
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const accepted = deferred<void>();
      const running = runtime.runTurn(
        turn({
          secretValues: [secret],
          onPromptAccepted: () => {
            accepted.resolve();
          },
          authorize: () => Promise.resolve({ decision, message }),
        }),
      );
      const settled = running.then(
        () => undefined,
        (error: unknown) => error,
      );
      await accepted.promise;
      const config = h.natives[1]?.configs[0];
      if (!config?.onEvent || !config.hooks?.onPreToolUse)
        throw new Error('Missing session');
      config.onEvent({
        id: 'reason-start',
        type: 'tool.execution_start',
        timestamp: new Date(0).toISOString(),
        parentId: null,
        data: { toolCallId: 'reason-call', toolName: 'view', arguments: {} },
      });
      const result = await config.hooks.onPreToolUse(
        {
          sessionId: 'session-1',
          timestamp: new Date(),
          workingDirectory: '/trusted/workspace',
          toolName: 'view',
          toolArgs: {},
        },
        { sessionId: 'session-1' },
      );
      config.onEvent({
        id: 'idle',
        type: 'session.idle',
        ephemeral: true,
        timestamp: new Date(0).toISOString(),
        parentId: null,
        data: {},
      });
      const error = await settled;
      if (reason === 'oversized') {
        expect(result).toMatchObject({ permissionDecision: 'deny' });
        expect(error).toMatchObject({ code: 'unavailable' });
      } else {
        expect(error).toBeUndefined();
        expect(result).toMatchObject({
          permissionDecision: decision,
          permissionDecisionReason:
            reason === 'sensitive'
              ? 'Host policy hides *** in *** under ***.'
              : message,
        });
      }
      expect(frames.join('')).not.toMatch(
        /caller-private-value-12345|\/trusted\/workspace|\/trusted\/config/,
      );
    } finally {
      h.pilot.close();
    }
  },
);

// These matrices are the P6 admission/equivalence contract, not a copied census.
type ParityLog = unknown[];
interface TurnParityRow {
  request(log: ParityLog): Partial<CopilotTurnRequest>;
  config?: Partial<SessionConfig>;
  notice?: unknown;
  prompt?: string;
  drive?: 'approval' | 'input' | 'tool' | 'observation' | 'permission';
  missing?: boolean;
  unavailable?: boolean;
}
const TURN_PARITY = {
  workingDirectory: {
    request: (): Partial<CopilotTurnRequest> => ({
      workingDirectory: '/other/workspace',
    }),
    config: { workingDirectory: '/other/workspace' },
  },
  configDirectory: {
    request: (): Partial<CopilotTurnRequest> => ({
      configDirectory: '/other/config',
    }),
    config: { configDirectory: '/other/config' },
  },
  model: {
    request: (): Partial<CopilotTurnRequest> => ({ model: 'other-model' }),
    config: { model: 'other-model' },
  },
  reasoningEffort: {
    request: (): Partial<CopilotTurnRequest> => ({ reasoningEffort: 'high' }),
    config: { reasoningEffort: 'high' },
  },
  signal: {
    request: (): Partial<CopilotTurnRequest> => ({
      signal: AbortSignal.abort(new Error('withdrawn')),
    }),
  },
  authorize: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      authorize: (input): ReturnType<CopilotTurnRequest['authorize']> => {
        log.push(['approval', input.toolName, input.toolArgs]);
        return Promise.resolve({ decision: 'deny', message: 'policy denied' });
      },
    }),
    drive: 'approval',
    notice: ['approval', 'edit', { path: 'file' }],
  },
  requestManagedPermission: {
    unavailable: true,
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      requestManagedPermission: (): { kind: 'approved' } => {
        log.push('managed');
        return { kind: 'approved' };
      },
    }),
    drive: 'permission',
    notice: 'managed',
  },
  systemPrompt: {
    request: (): Partial<CopilotTurnRequest> => ({
      systemPrompt: 'host policy',
    }),
    config: { systemMessage: { mode: 'append', content: 'host policy' } },
  },
  tools: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      tools: [
        {
          name: 'host_tool',
          description: 'fixture',
          parameters: { type: 'object', properties: {} },
          handler: (args): string => {
            log.push(['tool', args]);
            return 'tool answer';
          },
        },
      ],
    }),
    drive: 'tool',
    notice: ['tool', { value: 7 }],
  },
  mcpServers: {
    request: (): Partial<CopilotTurnRequest> => ({
      mcpServers: {
        selected: {
          type: 'http',
          url: 'http://127.0.0.1:4000/mcp',
          tools: ['*'],
        },
      },
    }),
    config: {
      mcpServers: {
        selected: {
          type: 'http',
          url: 'http://127.0.0.1:4000/mcp',
          tools: ['*'],
        },
      },
    },
  },
  skillDirectories: {
    request: (): Partial<CopilotTurnRequest> => ({
      skillDirectories: ['/selected/skills'],
    }),
    config: { skillDirectories: ['/selected/skills'], enableSkills: true },
  },
  onUserInputRequest: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      onUserInputRequest: (input): { answer: string; wasFreeform: boolean } => {
        log.push(['input', input.question]);
        return { answer: 'chosen', wasFreeform: false };
      },
    }),
    drive: 'input',
    notice: ['input', 'choose'],
  },
  onEvent: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      onEvent: (event): void => {
        log.push(['event', event.type]);
      },
    }),
    drive: 'observation',
    notice: ['event', 'tool.execution_start'],
  },
  turnId: {
    request: (): Partial<CopilotTurnRequest> => ({ turnId: 'different-turn' }),
  },
  sessionId: {
    request: (): Partial<CopilotTurnRequest> => ({
      sessionId: 'retained-session',
    }),
  },
  prompt: {
    request: (): Partial<CopilotTurnRequest> => ({
      prompt: 'different prompt',
    }),
    prompt: 'different prompt',
  },
  preparePrompt: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      preparePrompt: (id): Promise<string> => {
        log.push(['history', id]);
        return Promise.resolve('prepared history');
      },
    }),
    prompt: 'prepared history',
    notice: ['history', 'session-1'],
  },
  onPromptAccepted: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      onPromptAccepted: (id): void => {
        log.push(['accepted', id]);
      },
    }),
    notice: ['accepted', 'session-1'],
  },
  timeoutMs: {
    request: (): Partial<CopilotTurnRequest> => ({ timeoutMs: 10000 }),
  },
  secretValues: {
    request: (): Partial<CopilotTurnRequest> => ({
      secretValues: ['Verified evidence'],
    }),
  },
  emit: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      emit: (): void => {
        log.push('patch');
      },
    }),
  },
  onSession: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      onSession: (id): void => {
        log.push(['session', id]);
      },
    }),
    notice: ['session', 'session-1'],
  },
  onToolsReady: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      onToolsReady: (snapshot, servers): void => {
        log.push(['ready', snapshot, servers]);
      },
    }),
  },
  onMcpToolsReady: {
    unavailable: true,
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      onMcpToolsReady: (evidence): void => {
        log.push(['mcp', evidence]);
      },
    }),
    notice: ['mcp', []],
  },
  onSessionUnavailable: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      sessionId: 'missing',
      onSessionUnavailable: (): void => {
        log.push('missing');
      },
    }),
    missing: true,
    notice: 'missing',
  },
  beforePrompt: {
    request: (log: ParityLog): Partial<CopilotTurnRequest> => ({
      beforePrompt: (): Promise<void> => {
        log.push('before');
        return Promise.resolve();
      },
    }),
    notice: 'before',
  },
} satisfies Record<keyof CopilotTurnRequest, TurnParityRow>;

type OpenOptions = Parameters<
  CopilotConnectionBackend['openManagedCopilotRuntime']
>[0];
const OPEN_PARITY: Record<keyof OpenOptions, Partial<OpenOptions>[]> = {
  owner: [
    { owner: { kind: 'turn', id: 'chat-turn' } },
    { owner: { kind: 'subagent', id: 'delegate' } },
    { owner: { kind: 'pipeline', id: 'pipeline-step' } },
    { owner: { kind: 'helper', id: 'helper' } },
    { owner: { kind: 'discovery', id: 'copilot-models' } },
    { owner: { kind: 'discovery', id: 'copilot-quota' } },
    { owner: { kind: 'turn', id: '' } },
    { owner: { kind: 'turn', id: 'a'.repeat(200) } },
    { owner: { kind: 'turn', id: 'a'.repeat(201) } },
  ],
  signal: [{ signal: AbortSignal.abort(new Error('withdrawn')) }],
  cwd: [{ cwd: '/launch/workspace' }, { cwd: '' }],
  workspaceId: [{ workspaceId: 'workspace' }, { workspaceId: '' }],
  executionKind: [{ executionKind: 'agent' }, { executionKind: 'pipeline' }],
  restrictedEnvironment: [
    { restrictedEnvironment: true },
    { restrictedEnvironment: false },
  ],
  environment: [{ environment: { PARITY: 'value' } }, { environment: {} }],
  purpose: [
    { purpose: 'session' },
    { purpose: 'models' },
    { purpose: 'quota' },
    { purpose: 'setup-probe' },
    { purpose: 'thinking-levels' },
  ],
  requireAccount: [{ requireAccount: true }, { requireAccount: false }],
} satisfies Record<keyof OpenOptions, Partial<OpenOptions>[]>;

function parityNative(
  native: ReturnType<typeof nativeRuntime>,
  row: TurnParityRow,
  sdk: ParityLog,
): void {
  const create = native.runtime.client.createSession.getMockImplementation();
  if (!create) throw new Error('Missing SDK fixture');
  native.runtime.client.createSession.mockImplementation(async (config) => {
    const session = await create(config);
    return {
      ...session,
      send: async (input): Promise<string> => {
        if (row.drive === 'approval' || row.drive === 'observation') {
          config.onEvent?.({
            id: 'tool',
            type: 'tool.execution_start',
            timestamp: new Date(0).toISOString(),
            parentId: null,
            data: {
              toolCallId: 'call',
              toolName: 'edit',
              arguments: { path: 'file' },
            },
          });
          if (row.drive === 'approval')
            sdk.push(
              await config.hooks?.onPreToolUse?.(
                {
                  toolName: 'edit',
                  toolArgs: { path: 'file' },
                  sessionId: session.sessionId,
                  workingDirectory: config.workingDirectory ?? '',
                  timestamp: new Date(0),
                },
                { sessionId: session.sessionId },
              ),
            );
        }
        if (row.drive === 'input')
          sdk.push(
            await config.onUserInputRequest?.(
              { question: 'choose', choices: ['chosen'], allowFreeform: false },
              { sessionId: session.sessionId },
            ),
          );
        if (row.drive === 'tool') {
          const tool = config.tools?.[0];
          const handler = tool?.handler;
          if (!tool || !handler) throw new Error('Missing host tool');
          sdk.push(
            await handler(
              { value: 7 },
              {
                sessionId: session.sessionId,
                toolName: tool.name,
                toolCallId: 'call',
                arguments: { value: 7 },
                signal: new AbortController().signal,
              },
            ),
          );
        }
        if (row.drive === 'permission')
          sdk.push(
            await config.onPermissionRequest?.(
              {
                kind: 'read',
                path: 'file',
                intention: 'read fixture',
                managedApprovalRequired: true,
              },
              { sessionId: session.sessionId },
            ),
          );
        return session.send(input);
      },
    };
  });
  native.runtime.client.resumeSession.mockImplementation(async (id, config) => {
    if (row.missing) throw new Error('Session not found');
    return {
      ...(await native.runtime.client.createSession(config)),
      sessionId: id,
    };
  });
}

function consumePatchStream(patches: Record<string, unknown>[]): unknown {
  let revision = 0;
  const recorder = new DelegationTranscriptRecorder();
  const clock = jest.spyOn(Date, 'now').mockReturnValue(123);
  try {
    for (const event of patches) {
      expect(isAssistantPatch(event)).toBe(true);
      if (typeof event.revision !== 'number')
        throw new Error('Invalid patch revision');
      expect(event.revision).toBeGreaterThan(revision);
      revision = event.revision;
      recorder.cursor(event);
    }
    return {
      patches: patches.map(({ revision, ...event }) => {
        void revision;
        return event;
      }),
      transcript: parseAgentTranscriptLines(
        patches.map((event) => JSON.stringify(event)),
        'copilot',
      ).messages,
      delegation: recorder.snapshot(),
    };
  } finally {
    clock.mockRestore();
  }
}

async function fieldOutcome(
  field: keyof CopilotTurnRequest,
  row: TurnParityRow,
  selected: boolean,
): Promise<unknown> {
  const log: ParityLog = [],
    sdk: ParityLog = [],
    patches: Record<string, unknown>[] = [];
  const h = fixture(
    false,
    undefined,
    (native) => parityNative(native, row, sdk),
    'session-1',
  );
  const native = nativeRuntime({ sessionId: 'session-1' });
  parityNative(native, row, sdk);
  const legacyOpen = jest.fn(() =>
    Promise.resolve({
      ...native.runtime,
      listModels: () => Promise.resolve([]),
      getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
    }),
  );
  const proxy = createCopilotConnectionProxy({
    legacy: { ...h.backend, openManagedCopilotRuntime: legacyOpen },
    selected: () => Promise.resolve(selected),
    vault: () => h.backend,
    assertEnabled: () => undefined,
  });
  try {
    if (selected) ready(await h.pilot.setup(grant(), null));
    if (row.missing && selected) h.missingResume();
    const runtime = await proxy.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const project = jest.spyOn(h.port, 'projectPolicy');
    const request = turn(row.request(log));
    const emit = request.emit;
    request.emit = (event): void | Promise<void> => {
      patches.push(event);
      return emit(event);
    };
    const running = runtime.runTurn(request);
    if (selected && row.unavailable) {
      await expect(running).rejects.toMatchObject({ code: 'unavailable' });
      expect(project).not.toHaveBeenCalled();
      expect(legacyOpen).not.toHaveBeenCalled();
      return 'unavailable';
    }
    if (field === 'signal') {
      await expect(running).rejects.toThrow('withdrawn');
      return 'cancelled';
    }
    const result = await running;
    const observed = selected
      ? h.natives.find((n) => n.sends.length > 0)
      : native;
    expect(observed?.sends).toEqual([row.prompt ?? request.prompt]);
    if (row.config) expect(observed?.configs.at(-1)).toMatchObject(row.config);
    if (row.notice) expect(log).toContainEqual(row.notice);
    if (field === 'turnId')
      expect(patches).toContainEqual(
        expect.objectContaining({ messageId: 'different-turn:message:answer' }),
      );
    if (field === 'sessionId')
      expect(result.sessionId).toBe('retained-session');
    if (field === 'onToolsReady') {
      const digest: unknown = expect.stringMatching(/^[a-f0-9]{64}$/);
      expect(log).toContainEqual(['ready', { version: 1, digest }, []]);
    }
    if (field === 'emit') expect(log).toContain('patch');
    if (field === 'secretValues') expect(result.text).toBe('***');
    // P5 deliberately exposes tool provenance, not raw assistant/usage SDK events.
    const notices =
      field === 'onEvent'
        ? log.filter(
            (item) => Array.isArray(item) && item[1] === 'tool.execution_start',
          )
        : log;
    if (field === 'onEvent' && selected) expect(log).toEqual(notices);
    return {
      result,
      notices,
      sdk,
      projection: consumePatchStream(patches),
      sends: observed?.sends,
    };
  } finally {
    h.pilot.close();
    await native.runtime.close();
  }
}

const UNCOVERED_FIELDS = {
  unknown: (input: object): void => {
    Object.defineProperty(input, 'futureLegacyField', {
      value: 'unknown',
      enumerable: true,
    });
  },
  'hidden unknown': (input: object): void => {
    Object.defineProperty(input, 'futureLegacyField', { value: 'unknown' });
  },
  'hidden known': (input: object, field: string): void => {
    Object.defineProperty(input, field, { value: undefined });
  },
  accessor: (input: object, field: string): void => {
    Object.defineProperty(input, field, {
      enumerable: true,
      get: (): never => {
        throw new Error('Admission must not evaluate a getter');
      },
    });
  },
  inherited: (input: object): void => {
    Object.setPrototypeOf(input, { onMcpToolsReady: (): void => undefined });
  },
  symbol: (input: object): void => {
    Object.defineProperty(input, Symbol('future'), {
      value: true,
      enumerable: true,
    });
  },
} satisfies Record<string, (input: object, field: string) => void>;

describe('registered legacy-vault equivalence contract', () => {
  it('requires a case for every admitted turn and launch field', () => {
    expect(Object.keys(TURN_PARITY).sort()).toEqual(
      Object.keys(COPILOT_VAULT_TURN_FIELDS).sort(),
    );
    expect(Object.keys(OPEN_PARITY).sort()).toEqual(
      Object.keys(COPILOT_VAULT_OPEN_FIELDS).sort(),
    );
  });

  it.each(Object.entries(TURN_PARITY))(
    'paired turn field %s',
    async (field, row) => {
      // Iterating the typed keys without a cast keeps added legacy fields exhaustive.
      const key = Object.keys(TURN_PARITY).find(
        (key): key is keyof CopilotTurnRequest =>
          key === field &&
          Object.prototype.hasOwnProperty.call(TURN_PARITY, key),
      );
      if (!key) throw new Error('Unlisted turn field');
      const legacy = await fieldOutcome(key, row, false);
      const vault = await fieldOutcome(key, row, true);
      if ('unavailable' in row && row.unavailable)
        expect(vault).toBe('unavailable');
      else expect(vault).toEqual(legacy);
    },
  );

  it.each(
    (['turn', 'open'] as const).flatMap((kind) =>
      Object.entries(UNCOVERED_FIELDS).map(([shape, apply]) => ({
        kind,
        shape,
        apply,
      })),
    ),
  )(
    'refuses $shape $kind fields before proxy projection without changing custody or invoking legacy',
    async ({ kind, apply }) => {
      const h = fixture();
      try {
        ready(await h.pilot.setup(grant(), null));
        const legacy = jest.fn(h.backend.openManagedCopilotRuntime);
        const proxy = createCopilotConnectionProxy({
          legacy: { ...h.backend, openManagedCopilotRuntime: legacy },
          selected: () => Promise.resolve(true),
          vault: () => h.backend,
          assertEnabled: () => undefined,
        });
        const project = jest.spyOn(h.port, 'projectPolicy');
        const input = {
          owner: TEST_OWNER,
          signal: new AbortController().signal,
        };
        if (kind === 'open') {
          apply(input, 'requireAccount');
          await expect(
            proxy.openManagedCopilotRuntime(input),
          ).rejects.toMatchObject({ code: 'unavailable' });
        } else {
          const handle = await proxy.openManagedCopilotRuntime(input);
          const request = turn();
          apply(request, 'timeoutMs');
          await expect(handle.runTurn(request)).rejects.toMatchObject({
            code: 'unavailable',
          });
        }
        expect(project).not.toHaveBeenCalled();
        expect(legacy).not.toHaveBeenCalled();
        expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
        expect(
          copilotVaultFieldsCovered(
            { [Symbol('future')]: true },
            COPILOT_VAULT_TURN_FIELDS,
          ),
        ).toBe(false);
      } finally {
        h.pilot.close();
      }
    },
  );
});

const PENDING_STATES = {
  create: ['pin', 'cancelling', 'unprobed'],
  refresh: ['orphan'],
  replace: ['unknown'],
  delete: ['rejection', 'cancellation'],
  remove: ['fence', 'deleting'],
} satisfies Record<
  Extract<CopilotGrantResult, { kind: 'pending' }>['operation']['kind'],
  readonly string[]
>;
const PENDING_ENTRIES = {
  connect: (backend: CopilotConnectionBackend): Promise<unknown> =>
    backend.connectCopilot(new AbortController().signal, () => undefined),
  disconnect: (backend: CopilotConnectionBackend): Promise<unknown> =>
    backend.disconnectCopilot(),
  'change-account': (backend: CopilotConnectionBackend): Promise<unknown> =>
    backend.connectCopilot(new AbortController().signal, () => undefined, true),
  'setup-cancel': (
    backend: CopilotConnectionBackend,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    backend.connectCopilot(
      signal ?? new AbortController().signal,
      () => undefined,
    ),
  status: (backend: CopilotConnectionBackend): Promise<unknown> =>
    backend.copilotConnectionStatus(),
  startup: (backend: CopilotConnectionBackend): Promise<unknown> =>
    backend.recoverCopilotAtStartup(),
  open: (backend: CopilotConnectionBackend): Promise<unknown> =>
    backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    }),
} satisfies Record<
  keyof (typeof COPILOT_VAULT_PENDING_PATHS)['create'],
  (backend: CopilotConnectionBackend, signal?: AbortSignal) => Promise<unknown>
>;
const PENDING_ORIGINS = { setup: true, import: true } satisfies Record<
  CopilotGrantHead['origin'],
  boolean
>;

async function seedPending(
  h: Fixture,
  kind: keyof typeof PENDING_STATES,
  variant: string,
  origin: CopilotGrantHead['origin'],
): Promise<string> {
  if (kind === 'create' && variant === 'unprobed') {
    h.list.mockRejectedValueOnce(new Error('Entitlement interrupted'));
    const abandon = jest
      .spyOn(h.selection, 'abandon')
      .mockRejectedValueOnce(new Error('Lost cleanup acknowledgement'));
    await h.pilot.setup(grant(), null);
    abandon.mockRestore();
    const state = h.state(),
      receipt = h.preferences().copilotVaultSelection;
    const mutation = state.mutation;
    if (!mutation || !receipt) throw new Error('Missing failed-probe intent');
    h.setPreferences({
      ...h.preferences(),
      copilotVaultSelection: {
        ...receipt,
        identity: { ...receipt.identity, origin },
      },
    });
    expect(
      await h.pilotOptions.journal.compareExchange(state.sequence, {
        ...state,
        sequence: state.sequence + 1,
        mutation: { ...mutation, origin, cancelling: false },
      }),
    ).toBe(true);
    return mutation.operationId;
  }
  const original = ready(await h.pilot.setup(grant(), null));
  const head = { ...original, origin };
  const selected = h.preferences().copilotVaultSelection;
  if (!selected) throw new Error('Missing seed receipt');
  h.setPreferences({
    ...h.preferences(),
    copilotVaultSelection: {
      ...selected,
      state: variant === 'cancellation' ? 'disabled' : selected.state,
      identity: { ...selected.identity, origin },
    },
  });
  const before = h.state();
  const creating = kind === 'create';
  const removing = kind === 'remove';
  const deleting = kind === 'delete' || variant === 'deleting';
  const mutation: CopilotAuthorityRecord['mutation'] =
    removing && !deleting
      ? null
      : {
          operationId: creating ? head.operationId : 'matrix-mutation',
          epoch: head.epoch,
          account: head.account,
          origin,
          kind: removing ? 'delete' : kind,
          from: creating ? null : head.pin,
          committed: creating && variant !== 'unprobed' ? head.pin : null,
          probeConfirmed: variant !== 'unprobed',
          cancelling: variant === 'cancelling',
        };
  expect(
    await h.pilotOptions.journal.compareExchange(before.sequence, {
      ...before,
      sequence: before.sequence + 1,
      head: creating || variant === 'cancellation' ? null : head,
      mutation,
      removal: removing
        ? { operationId: 'matrix-removal', epoch: head.epoch }
        : null,
    }),
  ).toBe(true);
  const pending = await h.port.status();
  expect(pending).toMatchObject({
    kind: 'pending',
    operation: { kind, origin },
  });
  if (pending.kind !== 'pending')
    throw new Error('Missing authority pending state');
  return pending.operationId;
}

it('pending contract enumerates every reported operation kind and entry point', () => {
  expect(Object.keys(PENDING_STATES).sort()).toEqual(
    Object.keys(COPILOT_VAULT_PENDING_PATHS).sort(),
  );
  for (const paths of Object.values(COPILOT_VAULT_PENDING_PATHS))
    expect(Object.keys(paths).sort()).toEqual(
      Object.keys(PENDING_ENTRIES).sort(),
    );
});

it.each(
  Object.entries(PENDING_STATES).flatMap(([kind, variants]) =>
    variants.flatMap((variant) =>
      Object.keys(PENDING_ORIGINS).flatMap((origin) =>
        Object.entries(PENDING_ENTRIES).map(([entry, invoke]) => ({
          kind,
          variant,
          origin,
          entry,
          invoke,
        })),
      ),
    ),
  ),
)(
  'pending equivalence $origin/$kind/$variant x $entry',
  async ({ kind, variant, origin, entry, invoke }) => {
    const mutationKind = Object.keys(PENDING_STATES).find(
      (key): key is keyof typeof PENDING_STATES =>
        key === kind &&
        Object.prototype.hasOwnProperty.call(PENDING_STATES, key),
    );
    if (!mutationKind || (origin !== 'setup' && origin !== 'import'))
      throw new Error('Unlisted pending state');
    const h = fixture();
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: h.port,
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize,
    });
    try {
      const id = await seedPending(h, mutationKind, variant, origin);
      const retained = structuredClone(h.state());
      const preferences = structuredClone(h.preferences());
      const resume = jest.spyOn(h.port, 'resume'),
        cancel = jest.spyOn(h.port, 'cancel');
      const remove = jest.spyOn(h.port, 'remove');
      const creates = h.put.mock.calls.length;
      const removePending = jest.spyOn(h.port, 'removePending');
      const explicitRemoval =
        (kind === 'refresh' || kind === 'replace') &&
        (entry === 'disconnect' || entry === 'change-account');
      const abort = new AbortController();
      if (entry === 'setup-cancel') {
        const pending = await h.port.status();
        jest
          .spyOn(h.port, 'status')
          .mockResolvedValueOnce({ kind: 'blocked', reason: 'absent' });
        jest.spyOn(h.port, 'setup').mockImplementationOnce(() => {
          abort.abort();
          return Promise.resolve(pending);
        });
      }
      if (entry === 'setup-cancel' && kind === 'create')
        await expect(invoke(backend, abort.signal)).rejects.toMatchObject({
          name: 'AbortError',
        });
      else if (entry === 'status')
        await expect(invoke(backend)).resolves.toMatchObject({
          enabled: false,
          phase: 'idle',
        });
      else if (entry === 'startup')
        await expect(invoke(backend)).resolves.toBeUndefined();
      else if (
        entry === 'open' ||
        entry === 'setup-cancel' ||
        ((kind === 'refresh' || kind === 'replace') && !explicitRemoval) ||
        (entry === 'connect' && variant === 'unprobed' && origin === 'import')
      )
        await expect(invoke(backend, abort.signal)).rejects.toMatchObject({
          code: 'unavailable',
        });
      else if (entry === 'disconnect') {
        await expect(invoke(backend)).resolves.toBeUndefined();
        expect(await h.port.status()).toEqual({
          kind: 'blocked',
          reason: 'absent',
        });
        expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
      } else
        await expect(invoke(backend)).resolves.toMatchObject({ enabled: true });
      if (entry === 'status' || entry === 'startup' || entry === 'open') {
        expect(h.state()).toEqual(retained);
        expect(h.preferences()).toEqual(preferences);
        expect(resume).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
      } else if (explicitRemoval) {
        expect(removePending).toHaveBeenCalledTimes(1);
        expect(removePending).toHaveBeenCalledWith(id);
        expect(resume).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(h.remove).toHaveBeenCalledTimes(1);
        const deleted = h.remove.mock.calls[0]?.[0];
        expect(deleted).toMatchObject({
          ref: retained.head?.pin.ref,
          expectedRevision: retained.head?.pin.revision,
        });
        expect(deleted?.idempotencyKey).toEqual(expect.any(String));
        if (entry === 'disconnect') {
          expect(h.state().head).toBeNull();
          expect(h.state().mutation).toBeNull();
          expect(h.state().removal).toBeNull();
          await expect(backend.disconnectCopilot()).resolves.toBeUndefined();
          expect(h.remove).toHaveBeenCalledTimes(1);
          expect(h.remove.mock.calls[0]?.[0]).toEqual(deleted);
        } else {
          expect(h.state().head?.epoch).not.toBe(retained.head?.epoch);
          expect(h.state().head?.operationId).not.toBe(id);
          expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
          expect(authorize).toHaveBeenCalledTimes(1);
        }
      } else {
        const cancelling =
          kind === 'create' &&
          (entry === 'disconnect' ||
            entry === 'change-account' ||
            entry === 'setup-cancel');
        if (entry !== 'setup-cancel' || cancelling)
          expect(cancelling ? cancel : resume).toHaveBeenCalledWith(id);
        expect(cancelling ? resume : cancel).not.toHaveBeenCalled();
        if (entry === 'setup-cancel') expect(resume).not.toHaveBeenCalled();
        if (kind === 'refresh' || kind === 'replace') {
          expect(h.state()).toEqual(retained);
          expect(h.preferences()).toEqual(preferences);
        }
      }
      if (entry === 'setup-cancel') expect(authorize).toHaveBeenCalledTimes(1);
      else if (
        entry === 'open' ||
        entry === 'status' ||
        entry === 'startup' ||
        entry === 'disconnect' ||
        ((kind === 'refresh' || kind === 'replace') && !explicitRemoval) ||
        (entry === 'connect' &&
          kind === 'create' &&
          (variant === 'pin' ||
            (variant === 'unprobed' && origin === 'import')))
      )
        expect(authorize).not.toHaveBeenCalled();
      else expect(authorize).toHaveBeenCalledTimes(1);
      if (explicitRemoval) {
        expect(h.put).toHaveBeenCalledTimes(
          creates + (entry === 'change-account' ? 1 : 0),
        );
      } else if (kind === 'refresh' || kind === 'replace') {
        expect(h.put).toHaveBeenCalledTimes(creates);
        expect(h.remove).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
      }
      expect(h.refresh).not.toHaveBeenCalled();
    } finally {
      h.pilot.close();
    }
  },
);

it.each(Object.entries(PENDING_ENTRIES))(
  'refuses an unlisted pending kind on %s without cleanup inference',
  async (_entry, invoke) => {
    const h = fixture();
    try {
      const pending: Extract<CopilotGrantResult, { kind: 'pending' }> = {
        kind: 'pending',
        operationId: 'future',
        operation: { kind: 'refresh', origin: 'setup' },
      };
      Object.defineProperty(pending.operation, 'kind', {
        value: 'future-operation',
      });
      jest.spyOn(h.port, 'status').mockResolvedValue(pending);
      const resume = jest.spyOn(h.port, 'resume'),
        cancel = jest.spyOn(h.port, 'cancel');
      await expect(invoke(h.backend)).rejects.toMatchObject({
        code: 'unavailable',
      });
      expect(resume).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(h.put).not.toHaveBeenCalled();
      expect(h.remove).not.toHaveBeenCalled();
    } finally {
      h.pilot.close();
    }
  },
);

async function openOutcome(
  input: Partial<OpenOptions>,
  purpose: 'session' | 'models' | 'quota',
  selected: boolean,
): Promise<unknown> {
  const h = fixture();
  const launch: unknown[] = [];
  const legacyOpen = jest.fn(
    (options: OpenOptions): Promise<CopilotRecipientHandle> => {
      const context = Object.fromEntries(
        Object.entries(options).filter(
          ([key]) => !['signal', 'purpose', 'requireAccount'].includes(key),
        ),
      );
      launch.push(context);
      const native = nativeRuntime({ sessionId: 'session-1' });
      return Promise.resolve({
        ...native.runtime,
        listModels: () => Promise.resolve([]),
        getQuota: () => Promise.resolve({ quotaSnapshots: {} }),
      });
    },
  );
  const proxy = createCopilotConnectionProxy({
    legacy: { ...h.backend, openManagedCopilotRuntime: legacyOpen },
    selected: () => Promise.resolve(selected),
    vault: () => h.backend,
    assertEnabled: () => undefined,
  });
  try {
    if (selected) ready(await h.pilot.setup(grant(), null));
    // Empty catalog/quota responses are legal and exercise the zero-result path.
    h.list.mockResolvedValue({ models: [] });
    h.quota.mockResolvedValue({ quotaSnapshots: {} });
    const options: OpenOptions = {
      owner: TEST_OWNER,
      signal: new AbortController().signal,
      purpose,
      ...input,
    };
    const effectivePurpose = options.purpose ?? 'session';
    const refused =
      options.requireAccount === false ||
      effectivePurpose === 'setup-probe' ||
      effectivePurpose === 'thinking-levels';
    const opening = proxy.openManagedCopilotRuntime(options);
    if (options.signal.aborted) {
      await expect(opening).rejects.toThrow();
      return 'cancelled';
    }
    if (selected && refused) {
      await expect(opening).rejects.toMatchObject({ code: 'unavailable' });
      expect(legacyOpen).not.toHaveBeenCalled();
      expect(h.natives).toHaveLength(1);
      return 'unavailable';
    }
    const handle = await opening;
    try {
      let outcome: unknown;
      if (effectivePurpose === 'models') {
        outcome = await handle.listModels(options.signal);
        expect(outcome).toEqual([]);
      } else if (effectivePurpose === 'quota') {
        outcome = await handle.getQuota(options.signal);
        expect(outcome).toEqual({ quotaSnapshots: {} });
      } else if (effectivePurpose === 'session') {
        outcome = await handle.runTurn(turn());
        expect(outcome).toMatchObject({ text: 'Verified evidence' });
      }
      const projected = selected ? h.launches[1] : launch[0];
      const expected = Object.fromEntries(
        Object.entries(options).filter(
          ([key]) => !['signal', 'purpose', 'requireAccount'].includes(key),
        ),
      );
      expect(projected).toEqual(expected);
      if (!selected)
        expect(legacyOpen.mock.calls[0]?.[0].owner).toBe(options.owner);
      return { projected, outcome };
    } finally {
      await handle.close();
    }
  } finally {
    h.pilot.close();
  }
}

it.each(
  Object.entries(OPEN_PARITY).flatMap(([field, values]) =>
    values.flatMap((input) =>
      (['session', 'models', 'quota'] as const).map((purpose) => ({
        field,
        input,
        purpose,
      })),
    ),
  ),
)(
  'paired launch field $field for $purpose: $input',
  async ({ input, purpose }) => {
    const legacy = await openOutcome(input, purpose, false);
    const vault = await openOutcome(input, purpose, true);
    if (
      input.requireAccount === false ||
      input.purpose === 'setup-probe' ||
      input.purpose === 'thinking-levels'
    )
      expect(vault).toBe('unavailable');
    else expect(vault).toEqual(legacy);
  },
);

it.each(
  (['models', 'quota'] as const).flatMap((purpose) =>
    [false, true].map((empty) => ({ purpose, empty })),
  ),
)(
  'paired $purpose consumer output with empty=$empty',
  async ({ purpose, empty }) => {
    const results: unknown[] = [];
    for (const selected of [false, true]) {
      const h = fixture();
      const legacyNatives: ReturnType<typeof nativeRuntime>[] = [];
      const proxy = createCopilotConnectionProxy({
        legacy: parityLegacyBackend(h, legacyNatives),
        selected: () => Promise.resolve(selected),
        vault: () => h.backend,
        assertEnabled: () => undefined,
      });
      try {
        if (selected) ready(await h.pilot.setup(grant(), null));
        if (empty) h.list.mockResolvedValue({ models: [] });
        h.quota.mockResolvedValue({
          quotaSnapshots: empty
            ? {}
            : {
                premium_interactions: {
                  remainingPercentage: 75,
                  isUnlimitedEntitlement: false,
                  resetDate: '2027-01-01T00:00:00.000Z',
                },
                chat: {
                  remainingPercentage: 100,
                  isUnlimitedEntitlement: true,
                },
              },
        });
        const signal = new AbortController().signal;
        const handle = await proxy.openManagedCopilotRuntime({
          owner: TEST_OWNER,
          signal,
          purpose,
        });
        try {
          const result =
            purpose === 'models'
              ? await handle.listModels(signal)
              : await handle.getQuota(signal);
          if (purpose === 'models')
            expect(result).toEqual(
              empty ? [] : [expect.objectContaining({ id: 'copilot:model' })],
            );
          else
            expect(result).toEqual({
              quotaSnapshots: empty
                ? {}
                : {
                    premium_interactions: {
                      remainingPercentage: 75,
                      isUnlimitedEntitlement: false,
                      resetDate: '2027-01-01T00:00:00.000Z',
                    },
                    chat: {
                      remainingPercentage: 100,
                      isUnlimitedEntitlement: true,
                    },
                  },
            });
          results.push(result);
        } finally {
          await handle.close();
        }
      } finally {
        h.pilot.close();
      }
    }
    expect(results[1]).toEqual(results[0]);
  },
);

it.each([false, true])(
  'cancels owned unconfirmed setup with reconciliation unavailable=%s',
  async (unavailable) => {
    const h = fixture();
    h.losePin();
    const abort = new AbortController();
    let restore = (): void => undefined;
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: {
        ...h.port,
        setup: async (...args) => {
          const result = await h.pilot.setup(...args);
          expect(result).toMatchObject({
            kind: 'blocked',
            reason: 'unconfirmed',
          });
          if (unavailable) {
            const confirm = jest
              .spyOn(h.selection, 'confirm')
              .mockResolvedValue({ kind: 'unconfirmed' });
            restore = (): void => confirm.mockRestore();
          }
          abort.abort();
          return result;
        },
      },
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize,
    });
    try {
      await expect(
        backend.connectCopilot(abort.signal, () => undefined),
      ).rejects.toMatchObject({ name: 'AbortError' });
      if (unavailable) {
        expect(h.state().mutation?.cancelling).toBe(true);
        await expect(
          backend.connectCopilot(new AbortController().signal, () => undefined),
        ).rejects.toMatchObject({ code: 'unavailable' });
        expect(authorize).toHaveBeenCalledTimes(1);
      }
      restore();
      authorize.mockRejectedValueOnce(new Error('Fresh device flow required'));
      await expect(
        backend.connectCopilot(new AbortController().signal, () => undefined),
      ).rejects.toThrow('Fresh device flow required');
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(await backend.copilotConnectionStatus()).toMatchObject({
        enabled: false,
      });
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
      expect(h.put).toHaveBeenCalledTimes(1);
      expect(h.list).toHaveBeenCalledTimes(1);
    } finally {
      restore();
      h.pilot.close();
    }
  },
);

type SetupOutcome = Awaited<ReturnType<CopilotVaultConnectionPort['setup']>>;
const SETUP_CANCEL_OUTCOMES = {
  ready: (h: Fixture): Promise<SetupOutcome> => h.pilot.setup(grant(), null),
  pending: (h: Fixture): Promise<SetupOutcome> => {
    h.put.mockResolvedValueOnce({ kind: 'blocked', reason: 'unavailable' });
    return h.pilot.setup(grant(), null);
  },
  blocked: (h: Fixture): Promise<SetupOutcome> => {
    h.losePin();
    return h.pilot.setup(grant(), null);
  },
  'probe-failed': (h: Fixture): Promise<SetupOutcome> => {
    h.list.mockRejectedValueOnce(new Error('Entitlement interrupted'));
    jest
      .spyOn(h.selection, 'abandon')
      .mockRejectedValueOnce(new Error('Cleanup interrupted'));
    return h.pilot.setup(grant(), null);
  },
  removed: async (h: Fixture): Promise<SetupOutcome> => {
    const head = ready(await h.pilot.setup(grant(), null));
    return h.port.remove(head.epoch);
  },
  delivered: async (h: Fixture): Promise<SetupOutcome> => {
    // This is not a normal setup result, but must not bypass owned cleanup.
    h.losePin();
    const result = await h.pilot.setup(grant(), null);
    return {
      kind: 'delivered',
      expiresAt: 0,
      committedPin: null,
      setupOperationId: result.setupOperationId,
    };
  },
} satisfies Record<SetupOutcome['kind'], (h: Fixture) => Promise<SetupOutcome>>;

it('setup cancellation enumerates every setup outcome', () => {
  expect(Object.keys(SETUP_CANCEL_OUTCOMES).sort()).toEqual(
    Object.keys(COPILOT_VAULT_SETUP_CANCEL_PATHS).sort(),
  );
});
it.each(Object.entries(SETUP_CANCEL_OUTCOMES))(
  'routes owned setup cancellation after %s without resuming the cancelled account',
  async (kind, outcome) => {
    const h = fixture();
    const abort = new AbortController();
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: {
        ...h.port,
        setup: async () => {
          const result = await outcome(h);
          expect(result.kind).toBe(kind);
          abort.abort();
          return result;
        },
      },
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize,
    });
    try {
      await expect(
        backend.connectCopilot(abort.signal, () => undefined),
      ).rejects.toMatchObject({ name: 'AbortError' });
      authorize.mockRejectedValueOnce(new Error('Fresh device flow required'));
      await expect(
        backend.connectCopilot(new AbortController().signal, () => undefined),
      ).rejects.toThrow('Fresh device flow required');
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(h.state().mutation).toBeNull();
      expect(h.state().head).toBeNull();
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
      expect(h.refresh).not.toHaveBeenCalled();
    } finally {
      h.pilot.close();
    }
  },
);

it('cancelled setup without an owned operation never deletes another connected account', async () => {
  const h = fixture();
  const abort = new AbortController();
  try {
    const head = ready(await h.pilot.setup(grant(), null));
    const cancel = jest.spyOn(h.port, 'cancel');
    const remove = jest.spyOn(h.port, 'remove');
    const backend = createCopilotVaultConnection({
      port: {
        ...h.port,
        status: () => Promise.resolve({ kind: 'blocked', reason: 'absent' }),
        setup: () => {
          abort.abort();
          return Promise.resolve({ kind: 'blocked', reason: 'busy' });
        },
      },
      authorize: () => Promise.resolve(grant()),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
    });
    await expect(
      backend.connectCopilot(abort.signal, () => undefined),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.state().head).toEqual(head);
    expect(h.preferences().copilotVaultSelection?.state).toBe('selected');
    expect(cancel).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  } finally {
    h.pilot.close();
  }
});

it.each([false, true])(
  'cancels owned setup during the final connection status read, rejected=%s',
  async (rejected) => {
    const h = fixture();
    const abort = new AbortController();
    let reads = 0;
    const authorize = jest.fn(() => Promise.resolve(grant()));
    const backend = createCopilotVaultConnection({
      port: {
        ...h.port,
        status: async () => {
          const state = await h.port.status();
          if (++reads === 2) {
            abort.abort();
            if (rejected) throw new Error('Final status unavailable');
          }
          return state;
        },
      },
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize,
    });
    try {
      await expect(
        backend.connectCopilot(abort.signal, () => undefined),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(h.preferences().copilotEnabled).toBe(false);
      authorize.mockRejectedValueOnce(new Error('Fresh device flow required'));
      await expect(
        backend.connectCopilot(new AbortController().signal, () => undefined),
      ).rejects.toThrow('Fresh device flow required');
      expect(authorize).toHaveBeenCalledTimes(2);
    } finally {
      h.pilot.close();
    }
  },
);

it('a concurrent create cannot donate its checkpoint identity to an unrelated setup', async () => {
  const h = fixture();
  try {
    const external = h.pilot.authority.create(grant(), 'setup');
    const attempted = h.pilot.setup(grant(), null);
    const result = await attempted;
    const other = await external;
    expect(result).toMatchObject({ kind: 'blocked' });
    const concurrentHead = ready(other);
    expect(result.setupOperationId).toBeDefined();
    expect(result.setupOperationId).not.toBe(concurrentHead.operationId);
    if (!result.setupOperationId) throw new Error('Missing owned proposal');
    expect(await h.pilot.authority.cancel(result.setupOperationId)).toEqual({
      kind: 'blocked',
      reason: 'changed',
    });
    expect(ready(await h.pilot.authority.status())).toEqual(concurrentHead);
  } finally {
    h.pilot.close();
  }
});

it('restart retains cancelled setup cleanup while receipt reconciliation is unavailable', async () => {
  const h = fixture();
  h.losePin();
  const abort = new AbortController();
  const authorize = jest.fn(() => Promise.resolve(grant()));
  let pilot = h.pilot;
  const backend = createCopilotVaultConnection({
    port: {
      ...h.port,
      setup: async (...args) => {
        const result = await pilot.setup(...args);
        jest
          .spyOn(h.selection, 'confirm')
          .mockResolvedValue({ kind: 'unconfirmed' });
        abort.abort();
        return result;
      },
    },
    installation: () => Promise.resolve(base),
    preferences: () =>
      Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
    authorize,
  });
  try {
    await expect(
      backend.connectCopilot(abort.signal, () => undefined),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.state().mutation?.cancelling).toBe(true);
    pilot.close();
    pilot = createCopilotVaultPilot({
      ...h.pilotOptions,
      processLifetime: {},
      journal: { ...h.pilotOptions.journal },
    });
    const restarted = createCopilotVaultConnection({
      port: {
        ...h.port,
        ...pilot,
        status: () => pilot.authority.status(),
        resume: (id) => pilot.authority.resume(id),
        cancel: (id) => pilot.authority.cancel(id),
        remove: (epoch) => pilot.authority.remove(epoch),
      },
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
      authorize,
    });
    await expect(
      restarted.connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toMatchObject({ code: 'unavailable' });
    expect(authorize).toHaveBeenCalledTimes(1);
    jest.restoreAllMocks();
    authorize.mockRejectedValueOnce(new Error('Fresh device flow required'));
    await expect(
      restarted.connectCopilot(new AbortController().signal, () => undefined),
    ).rejects.toThrow('Fresh device flow required');
    expect(h.preferences().copilotEnabled).toBe(false);
  } finally {
    pilot.close();
  }
});

it.each([
  { shape: 'two', sameCall: false },
  { shape: 'three', sameCall: false },
  { shape: 'boundary', sameCall: false },
  { shape: 'mixed-fields', sameCall: false },
  { shape: 'two', sameCall: true },
  { shape: 'three', sameCall: true },
] as const)(
  'observation confidentiality across $shape completion fragments, sameCall=$sameCall',
  async ({ shape, sameCall }) => {
    const h = fixture(true);
    const observations: SessionEvent[] = [];
    const patches: Record<string, unknown>[] = [];
    const frames: string[] = [];
    const open = h.port.open.bind(h.port);
    jest
      .spyOn(h.port, 'open')
      .mockImplementation((purpose, audience, policy, write) =>
        open(purpose, audience, policy, (encoded) => {
          frames.push(encoded);
          return write(encoded);
        }),
      );
    const accepted = deferred<void>();
    const firstObserved = deferred<void>();
    try {
      ready(await h.pilot.setup(grant(), null));
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const running = runtime.runTurn(
        turn({
          onPromptAccepted: () => {
            accepted.resolve();
          },
          onEvent: (event) => {
            observations.push(event);
            if (event.type === 'tool.execution_complete')
              firstObserved.resolve();
          },
          emit: (event) => {
            patches.push(event);
          },
        }),
      );
      void running.catch(() => undefined);
      await accepted.promise;
      const config = h.natives[1]?.configs[0];
      if (!config?.onEvent) throw new Error('Missing selected SDK session');
      const parts =
        shape === 'boundary'
          ? ['x'.repeat(16_380) + ACCESS + 'x'.repeat(70_000)]
          : shape === 'two'
            ? [ACCESS.slice(0, 10), ACCESS.slice(10)]
            : [ACCESS.slice(0, 10), ACCESS.slice(10, 17), ACCESS.slice(17)];
      for (const [index, content] of parts.entries()) {
        const base = { timestamp: new Date(0).toISOString(), parentId: null };
        if (!sameCall || index === 0)
          config.onEvent({
            ...base,
            id: `start-${index}`,
            type: 'tool.execution_start',
            data: {
              toolCallId: `call-${index}`,
              toolName: 'view',
              arguments: { path: '/trusted/workspace/file' },
            },
          });
        config.onEvent({
          ...base,
          id: `complete-${index}`,
          type: 'tool.execution_complete',
          data: {
            toolCallId: `call-${sameCall ? 0 : index}`,
            success: true,
            result: {
              content:
                shape === 'mixed-fields' && index === 1 ? 'summary' : content,
              ...(shape === 'mixed-fields' && index !== 1
                ? {}
                : { detailedContent: content }),
              contents: [{ type: 'text', text: content }],
            },
          },
        });
        if (index === 0) await firstObserved.promise;
      }
      config.onEvent({
        id: 'idle',
        type: 'session.idle',
        ephemeral: true,
        timestamp: new Date(0).toISOString(),
        parentId: null,
        data: {},
      });
      if (sameCall)
        await expect(running).rejects.toMatchObject({ code: 'unavailable' });
      else
        await expect(running).resolves.toMatchObject({
          text: 'Verified evidence',
        });
      expect(
        observations.filter(
          (event) => event.type === 'tool.execution_complete',
        ),
      ).toHaveLength(sameCall ? 1 : parts.length);
      const delivered = JSON.stringify(observations);
      expect(delivered).not.toContain(ACCESS);
      for (const fragment of shape === 'boundary'
        ? [ACCESS.slice(0, 4)]
        : parts) {
        expect(delivered).not.toContain(fragment);
        expect(frames.join('')).not.toContain(fragment);
      }
      if (!sameCall) expect(JSON.stringify(patches)).toContain('***');
      expect(JSON.stringify(patches)).not.toContain(ACCESS);
      if (shape !== 'boundary')
        for (const fragment of parts)
          expect(JSON.stringify(patches)).not.toContain(fragment);
    } finally {
      h.pilot.close();
    }
  },
);

it.each(['benign', 'masked', 'prefix'] as const)(
  'selected chat reload receipt is immediate or expires without hanging (%s)',
  async (shape) => {
    const root = await mkdtemp(join(tmpdir(), 'p6-receipt-'));
    const accepted = deferred<void>();
    const h = fixture(true, () => accepted.resolve());
    const operations = new OperationService({
      openLedger: (): OperationLedger =>
        OperationLedger.open(join(root, 'operations.db')),
    });
    const validation = deferred<string | null>();
    const host = {
      revalidate: jest.fn(() => validation.promise),
      capture: jest.fn(() =>
        Promise.resolve({
          userMessageId: 'receipt-turn',
          sdkSessionId: 'session-1',
        }),
      ),
      enable: jest.fn(() => Promise.resolve({ sdkSessionId: 'session-1' })),
      resume: jest.fn(() => Promise.resolve()),
      settleInterruptedTurn: jest.fn(() => Promise.resolve()),
    };
    const timers: { callback(): void; delay: number; cancelled: boolean }[] =
      [];
    const reloads =
      new CoreDeferredToolReloads<DesktopDeferredToolReloadPayload>({
        operations,
        host,
        setTimer: (callback, delay): { cancel(): void } => {
          const timer = { callback, delay, cancelled: false };
          timers.push(timer);
          return {
            cancel: (): void => {
              timer.cancelled = true;
            },
          };
        },
      });
    let session: AgentSession | undefined;
    const acknowledged = deferred<void>();
    const worker = getCopilotWorkerRuntime();
    const acknowledge = worker.acknowledgeToolResult.bind(worker);
    const delivered = jest
      .spyOn(worker, 'acknowledgeToolResult')
      .mockImplementation((...args) => {
        const result = acknowledge(...args);
        acknowledged.resolve();
        return result;
      });
    const approval = jest
      .spyOn(CursorToolApproval, 'authorizeCursorMcpTool')
      .mockResolvedValue({ decision: 'allow' });
    try {
      prepareChatHost(root);
      setDeferredToolReloads(reloads);
      ready(await h.pilot.setup(grant(), null));
      mockCallerConnection = createCopilotConnectionProxy({
        legacy: h.backend,
        selected: () => Promise.resolve(true),
        vault: () => h.backend,
        assertEnabled: () => undefined,
      });
      const ended = deferred<void>();
      const events: unknown[] = [];
      session = chatSession((event) => {
        events.push(event);
        if (
          event &&
          typeof event === 'object' &&
          'type' in event &&
          (event.type === 'result' || event.type === 'error')
        )
          ended.resolve();
      });
      sendChatMessage(session, 'receipt-worker', 'Load a tool', {
        userMessageId: 'receipt-turn',
      });
      await accepted.promise;
      const native = h.natives.find((entry) => entry.sends.length > 0);
      const config = native?.configs[0];
      const route = mockRegisterRoute.mock.calls.at(-1)?.[0];
      if (
        !config?.onEvent ||
        !config.hooks?.onPreToolUse ||
        !route?.nativeToolResultDelivery ||
        !route.authorizeToolCall
      )
        throw new Error('Missing native receipt path');
      const args = { items: [{ ref: 'deferred:v1:fixture' }] };
      const base = { timestamp: new Date(0).toISOString(), parentId: null };
      config.onEvent({
        ...base,
        id: 'reload-start',
        type: 'tool.execution_start',
        data: {
          toolCallId: 'reload-call',
          toolName: 'fixture-loader',
          arguments: args,
          mcpConfigServerName: cursorCanopyMcpServerNames('default').main,
          mcpToolName: 'LoadDeferredTools',
        },
      });
      await expect(
        config.hooks.onPreToolUse(
          {
            sessionId: 'session-1',
            timestamp: new Date(),
            workingDirectory: root,
            toolName: 'fixture-loader',
            toolArgs: args,
          },
          { sessionId: 'session-1' },
        ),
      ).resolves.toMatchObject({ permissionDecision: 'allow' });
      await expect(
        route.authorizeToolCall('load_deferred_tools', args, {
          requestId: 'rpc-1',
        }),
      ).resolves.toBe(true);
      const scope = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
      };
      const request = {
        scope,
        toolCallId: 'route:rpc-1',
        providerType: 'copilot' as const,
        additions: { skillRefs: [], pluginRefs: [], mcpServerRefs: [] },
        enabledResources: [],
      };
      await expect(
        deferredToolsReloadCoordinator.request(request),
      ).resolves.toMatchObject({ accepted: true });
      const content =
        shape === 'benign'
          ? 'accepted'
          : shape === 'masked'
            ? `accepted ${ACCESS}`
            : 'accepted p';
      route.nativeToolResultDelivery({
        requestId: 'rpc-1',
        toolUseId: 'route:rpc-1',
        result: { content: [{ type: 'text', text: content }] },
      });
      // The next host authorization waits for all preceding observations.
      config.onEvent({
        ...base,
        id: 'reload-complete',
        type: 'tool.execution_complete',
        data: {
          toolCallId: 'reload-call',
          success: true,
          result: {
            content,
            detailedContent: content,
            contents: [{ type: 'text', text: content }],
          },
        },
      });
      if (shape === 'benign') {
        await acknowledged.promise;
        expect(delivered).toHaveBeenCalledWith(scope, 'route:rpc-1');
        expect(
          reloads.active({
            workspaceId: 'project',
            worktreeId: 'worktree',
            chatId: 'chat',
          })?.acknowledged,
        ).toBe(true);
      } else {
        // A subsequent tool approval is an observation-delivery barrier, not a timer or poll.
        config.onEvent({
          ...base,
          id: 'after-reload',
          type: 'tool.execution_start',
          data: {
            toolCallId: 'after-call',
            toolName: 'view',
            arguments: { path: join(root, 'file') },
          },
        });
        await config.hooks.onPreToolUse(
          {
            sessionId: 'session-1',
            timestamp: new Date(),
            workingDirectory: root,
            toolName: 'view',
            toolArgs: { path: join(root, 'file') },
          },
          { sessionId: 'session-1' },
        );
        expect(delivered).not.toHaveBeenCalled();
        config.onEvent({
          ...base,
          id: 'idle',
          type: 'session.idle',
          ephemeral: true,
          data: {},
        });
        await ended.promise;
        expect(events.at(-1)).toMatchObject({
          type: 'result',
          is_error: false,
        });
        expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(
          true,
        );
        const timer = timers.find(
          (timer) => timer.delay === 30_000 && !timer.cancelled,
        );
        if (!timer) throw new Error('Missing unacknowledged reload deadline');
        timer.callback();
        expect(deferredToolsReloadCoordinator.hasActiveReload(scope)).toBe(
          false,
        );
        expect(
          deferredToolsReloadCoordinator.shouldSuppressProviderTerminal(scope),
        ).toBe(false);
        expect(host.revalidate).not.toHaveBeenCalled();
        expect(host.enable).not.toHaveBeenCalled();
        expect(host.resume).not.toHaveBeenCalled();
        await expect(
          deferredToolsReloadCoordinator.request({
            ...request,
            toolCallId: 'next-load',
          }),
        ).resolves.toMatchObject({ accepted: true });
      }
    } finally {
      reloads.close();
      setDeferredToolReloads(null);
      validation.resolve(null);
      delivered.mockRestore();
      approval.mockRestore();
      await session?.destroy();
      operations.close();
      mockCallerConnection = undefined;
      h.pilot.close();
      mockHostSessions.clear();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  { shape: 'blocks-within' },
  { shape: 'blocks-switch' },
  { shape: 'block-detail' },
  { shape: 'secondary-error' },
] as const)(
  'observation confidentiality across $shape completion fragments, text-field projections',
  async ({ shape }) => {
    const h = fixture(true);
    const observations: SessionEvent[] = [];
    const patches: Record<string, unknown>[] = [];
    const frames: string[] = [];
    const open = h.port.open.bind(h.port);
    jest
      .spyOn(h.port, 'open')
      .mockImplementation((purpose, audience, policy, write) =>
        open(purpose, audience, policy, (encoded) => {
          frames.push(encoded);
          return write(encoded);
        }),
      );
    const accepted = deferred<void>();
    const firstObserved = deferred<void>();
    try {
      ready(await h.pilot.setup(grant(), null));
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const running = runtime.runTurn(
        turn({
          onPromptAccepted: () => {
            accepted.resolve();
          },
          onEvent: (event) => {
            observations.push(event);
            if (event.type === 'tool.execution_complete')
              firstObserved.resolve();
          },
          emit: (event) => {
            patches.push(event);
          },
        }),
      );
      void running.catch(() => undefined);
      await accepted.promise;
      const config = h.natives[1]?.configs[0];
      if (!config?.onEvent) throw new Error('Missing selected SDK session');
      const parts =
        shape === 'blocks-within'
          ? [ACCESS]
          : [ACCESS.slice(0, 10), ACCESS.slice(10, 17), ACCESS.slice(17)];
      const summaryBlock: { type: 'text'; text: string } = {
        type: 'text',
        text: 'summary',
      };
      for (const [index, content] of parts.entries()) {
        const base = { timestamp: new Date(0).toISOString(), parentId: null };
        config.onEvent({
          ...base,
          id: `start-${index}`,
          type: 'tool.execution_start',
          data: {
            toolCallId: `call-${index}`,
            toolName: 'view',
            arguments: { path: '/trusted/workspace/file' },
          },
        });
        config.onEvent({
          ...base,
          id: `complete-${index}`,
          type: 'tool.execution_complete',
          data: {
            toolCallId: `call-${index}`,
            success: true,
            ...(shape === 'secondary-error' && index === 2
              ? { error: { message: content } }
              : {
                  result: {
                    content:
                      shape === 'secondary-error' && index === 0
                        ? content
                        : 'summary',
                    ...(shape === 'block-detail' && index > 0
                      ? { detailedContent: content }
                      : {}),
                    ...(shape === 'secondary-error' && index < 2
                      ? { detailedContent: index === 1 ? content : 'summary' }
                      : {}),
                    contents:
                      shape === 'blocks-within'
                        ? [
                            { type: 'text', text: ACCESS.slice(0, 10) },
                            { type: 'text', text: ACCESS.slice(10) },
                          ]
                        : shape === 'secondary-error' ||
                            (shape === 'block-detail' && index > 0)
                          ? []
                          : [
                              ...(index % 2 ? [summaryBlock] : []),
                              { type: 'text', text: content },
                            ],
                  },
                }),
          },
        });
        if (index === 0) await firstObserved.promise;
      }
      config.onEvent({
        id: 'idle',
        type: 'session.idle',
        ephemeral: true,
        timestamp: new Date(0).toISOString(),
        parentId: null,
        data: {},
      });
      await expect(running).resolves.toMatchObject({
        text: 'Verified evidence',
      });
      expect(
        observations.filter(
          (event) => event.type === 'tool.execution_complete',
        ),
      ).toHaveLength(parts.length);
      const delivered = JSON.stringify(observations);
      expect(delivered).toContain('***');
      expect(delivered).not.toContain(ACCESS);
      for (const fragment of shape === 'blocks-within'
        ? [ACCESS.slice(0, 10), ACCESS.slice(10)]
        : parts) {
        expect(delivered).not.toContain(fragment);
        expect(frames.join('')).not.toContain(fragment);
        expect(JSON.stringify(patches)).not.toContain(fragment);
      }
      expect(JSON.stringify(patches)).not.toContain(ACCESS);
    } finally {
      h.pilot.close();
    }
  },
);

it.each(['dropped', 'refused', 'hung', 'delayed'] as const)(
  'a %s renewal denies pending approval and terminates the selected caller without fallback',
  async (fault) => {
    const h = fixture(true);
    ready(await h.pilot.setup(grant(), null));
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
      ],
    });
    const open = h.port.open.bind(h.port);
    let renewals = 0;
    const late = deferred<void>();
    const lateSettled = deferred<void>();
    let lateRejected = false;
    h.port.open = async (...args): ReturnType<typeof h.port.open> => {
      const channel = await open(...args);
      return {
        ...channel,
        receive: async (encoded): Promise<void> => {
          const frame = CopilotLocalRequestSchema.parse(JSON.parse(encoded));
          if (frame.command.kind === 'renew' && ++renewals === 3) {
            if (fault === 'delayed') {
              await late.promise;
              try {
                await args[3](
                  JSON.stringify({
                    kind: 'response',
                    requestId: frame.requestId,
                    outcome: { kind: 'accepted' },
                  }),
                );
              } catch {
                lateRejected = true;
              } finally {
                lateSettled.resolve();
              }
              return;
            }
            if (fault === 'hung') return new Promise<void>(() => undefined);
            if (fault === 'refused')
              await args[3](
                JSON.stringify({
                  kind: 'response',
                  requestId: frame.requestId,
                  outcome: { kind: 'refused', reason: 'stale' },
                }),
              );
            return;
          }
          await channel.receive(encoded);
        },
      };
    };
    const oldOpen = jest.fn(h.backend.openManagedCopilotRuntime);
    const proxy = createCopilotConnectionProxy({
      legacy: { ...h.backend, openManagedCopilotRuntime: oldOpen },
      selected: () => Promise.resolve(true),
      vault: () => h.backend,
      assertEnabled: () => undefined,
    });
    try {
      const accepted = deferred<void>();
      const asked = deferred<void>();
      const answer = deferred<{ decision: 'allow' }>();
      const runtime = await proxy.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const running = runtime.runTurn(
        turn({
          onPromptAccepted: () => {
            accepted.resolve();
          },
          authorize: () => {
            asked.resolve();
            return answer.promise;
          },
        }),
      );
      const result = running.then(
        () => 'completed',
        () => 'refused',
      );
      await accepted.promise;
      await jest.advanceTimersByTimeAsync(119_000);
      const config = h.natives[1]?.configs[0];
      if (!config?.onEvent || !config.hooks?.onPreToolUse)
        throw new Error('Missing approval hook');
      config.onEvent({
        id: 'renewal-start',
        type: 'tool.execution_start',
        timestamp: new Date().toISOString(),
        parentId: null,
        data: { toolCallId: 'renewal-call', toolName: 'edit', arguments: {} },
      });
      const approving = config.hooks.onPreToolUse(
        {
          sessionId: 'session-1',
          timestamp: new Date(),
          workingDirectory: '/trusted/workspace',
          toolName: 'edit',
          toolArgs: {},
        },
        { sessionId: 'session-1' },
      );
      await asked.promise;
      await jest.advanceTimersByTimeAsync(31_001);
      expect(await result).toBe('refused');
      expect(await approving).toMatchObject({ permissionDecision: 'deny' });
      answer.resolve({ decision: 'allow' });
      expect(oldOpen).not.toHaveBeenCalled();
      expect(renewals).toBe(3);
      if (fault === 'delayed') {
        late.resolve();
        await lateSettled.promise;
        expect(lateRejected).toBe(true);
        expect(await result).toBe('refused');
      }
    } finally {
      h.pilot.close();
      jest.useRealTimers();
    }
  },
);

it(RENEWAL_PARITY['slow-open'], async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
  });
  const open = h.port.open.bind(h.port);
  const acquired = deferred<void>();
  const release = deferred<void>();
  const commands: string[] = [];
  h.port.open = async (...args): ReturnType<typeof h.port.open> => {
    const channel = await open(...args);
    acquired.resolve();
    await release.promise;
    return {
      ...channel,
      receive: async (encoded): Promise<void> => {
        commands.push(
          CopilotLocalRequestSchema.parse(JSON.parse(encoded)).command.kind,
        );
        await channel.receive(encoded);
      },
    };
  };
  try {
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const running = runtime.runTurn(turn());
    await acquired.promise;
    await jest.advanceTimersByTimeAsync(119_000);
    expect(commands).toEqual([]);
    release.resolve();
    await expect(running).resolves.toMatchObject({ sessionId: 'session-1' });
    expect(commands.slice(0, 2)).toEqual(['renew', 'run']);
    const count = commands.length;
    await jest.advanceTimersByTimeAsync(240_000);
    expect(commands).toHaveLength(count);
  } finally {
    h.pilot.close();
    jest.useRealTimers();
  }
});

it.each(['completion-first', 'renewal-first'] as const)(
  RENEWAL_PARITY['completion-race'],
  async (order) => {
    const h = fixture(true);
    ready(await h.pilot.setup(grant(), null));
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
      ],
    });
    const open = h.port.open.bind(h.port);
    const held = deferred<void>();
    const release = deferred<void>();
    let renewals = 0;
    h.port.open = async (...args): ReturnType<typeof h.port.open> => {
      const channel = await open(...args);
      return {
        ...channel,
        receive: async (encoded): Promise<void> => {
          const frame = CopilotLocalRequestSchema.parse(JSON.parse(encoded));
          if (frame.command.kind === 'renew' && ++renewals === 2) {
            held.resolve();
            await release.promise;
            // Its admission raced the host's completion teardown.
            await args[3](
              JSON.stringify({
                kind: 'response',
                requestId: frame.requestId,
                outcome: { kind: 'refused', reason: 'stale' },
              }),
            );
            return;
          }
          await channel.receive(encoded);
        },
      };
    };
    try {
      const accepted = deferred<void>();
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const running = runtime.runTurn(
        turn({
          onPromptAccepted: () => {
            accepted.resolve();
          },
        }),
      );
      const result = running.then(
        () => 'completed',
        () => 'refused',
      );
      await accepted.promise;
      await jest.advanceTimersByTimeAsync(60_000);
      await held.promise;
      const idle = (): void =>
        h.natives[1]?.configs[0]?.onEvent?.({
          id: 'race-idle',
          type: 'session.idle',
          ephemeral: true,
          timestamp: new Date().toISOString(),
          parentId: null,
          data: {},
        });
      if (order === 'renewal-first') {
        release.resolve();
        expect(await result).toBe('refused');
        idle();
      } else {
        idle();
        expect(await result).toBe('completed');
        release.resolve();
      }
      await jest.advanceTimersByTimeAsync(COPILOT_RECIPIENT_LIMITS.callbackMs);
      expect(renewals).toBe(2);
    } finally {
      h.pilot.close();
      jest.useRealTimers();
    }
  },
);

it.each(['duplicate', 'unknown'] as const)(
  'refuses a live %s renewal acknowledgement using exact request membership',
  async (kind) => {
    const h = fixture(true);
    ready(await h.pilot.setup(grant(), null));
    const open = h.port.open.bind(h.port);
    let write: ((encoded: string) => Promise<void>) | undefined;
    h.port.open = async (...args): ReturnType<typeof h.port.open> => {
      write = args[3];
      return open(...args);
    };
    try {
      const accepted = deferred<void>();
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const running = runtime.runTurn(
        turn({
          onPromptAccepted: () => {
            accepted.resolve();
          },
        }),
      );
      const result = running.then(
        () => 'completed',
        () => 'refused',
      );
      await accepted.promise;
      if (!write) throw new Error('Missing channel writer');
      await expect(
        write(
          JSON.stringify({
            kind: 'response',
            requestId: kind === 'duplicate' ? 1 : 4096,
            outcome: { kind: 'accepted' },
          }),
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(await result).toBe('refused');
    } finally {
      h.pilot.close();
    }
  },
);

it('caller timeout still wins after an admitted renewal extends the lease', async () => {
  const h = fixture(true);
  ready(await h.pilot.setup(grant(), null));
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
  });
  try {
    const accepted = deferred<void>();
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const running = runtime.runTurn(
      turn({
        timeoutMs: 125_000,
        onPromptAccepted: () => {
          accepted.resolve();
        },
      }),
    );
    const result = running.then(
      () => 'completed',
      () => 'refused',
    );
    await accepted.promise;
    await jest.advanceTimersByTimeAsync(125_001);
    expect(await result).toBe('refused');
  } finally {
    h.pilot.close();
    jest.useRealTimers();
  }
});

it.each([
  'abort',
  'hung',
  'unknown-response',
  'replayed-renewal',
  'replayed-run',
] as const)(
  'completion still requires a bounded acknowledged delivery: %s',
  async (fault) => {
    const h = fixture();
    ready(await h.pilot.setup(grant(), null));
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
      ],
    });
    const open = h.port.open.bind(h.port);
    const delivered = deferred<void>();
    let write: ((encoded: string) => Promise<void>) | undefined;
    h.port.open = async (...args): ReturnType<typeof h.port.open> => {
      write = args[3];
      const channel = await open(...args);
      return {
        ...channel,
        receive: async (encoded): Promise<void> => {
          await channel.receive(encoded);
          if (
            CopilotLocalRequestSchema.parse(JSON.parse(encoded)).command
              .kind === 'run'
          ) {
            delivered.resolve();
            await new Promise<void>(() => undefined);
          }
        },
      };
    };
    const abort = new AbortController();
    try {
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: abort.signal,
      });
      let result = 'pending';
      const running = runtime.runTurn(turn({ signal: abort.signal })).then(
        () => {
          result = 'completed';
        },
        () => {
          result = 'refused';
        },
      );
      await delivered.promise;
      if (fault === 'abort') abort.abort();
      else if (fault !== 'hung') {
        if (!write) throw new Error('Missing channel writer');
        await expect(
          write(
            JSON.stringify({
              kind: 'response',
              requestId:
                fault === 'replayed-renewal'
                  ? 1
                  : fault === 'replayed-run'
                    ? 2
                    : 4096,
              outcome: { kind: 'accepted' },
            }),
          ),
        ).rejects.toMatchObject({ code: 'unavailable' });
      } else {
        await jest.advanceTimersByTimeAsync(
          COPILOT_RECIPIENT_LIMITS.callbackMs + 1,
        );
        expect(result).toBe('refused');
      }
      await running;
      expect(result).toBe('refused');
    } finally {
      h.pilot.close();
      jest.useRealTimers();
    }
  },
);

it.each(['accepted', 'refused', 'duplicate', 'wrong-kind'] as const)(
  'completion admits only one exact outstanding ancillary response: %s',
  async (outcome) => {
    const h = fixture(true);
    ready(await h.pilot.setup(grant(), null));
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'queueMicrotask',
        'setImmediate',
        'clearImmediate',
      ],
    });
    const open = h.port.open.bind(h.port);
    const release = deferred<void>();
    const renewed = deferred<void>();
    let renewals = 0;
    h.port.open = async (...args): ReturnType<typeof h.port.open> => {
      const channel = await open(
        args[0],
        args[1],
        args[2],
        async (encoded): Promise<void> => {
          await args[3](encoded);
          const frame = CopilotLocalFrameSchema.parse(JSON.parse(encoded));
          if (frame.kind === 'response' && frame.outcome.kind === 'completed') {
            release.resolve();
            await renewed.promise;
          }
        },
        args[4],
      );
      return {
        ...channel,
        receive: async (encoded): Promise<void> => {
          const frame = CopilotLocalRequestSchema.parse(JSON.parse(encoded));
          if (frame.command.kind === 'renew' && ++renewals === 2) {
            await release.promise;
            const response = JSON.stringify({
              kind: 'response',
              requestId: frame.requestId,
              outcome:
                outcome === 'refused'
                  ? { kind: 'refused', reason: 'stale' }
                  : outcome === 'wrong-kind'
                    ? {
                        kind: 'completed',
                        result: { kind: 'models', models: [] },
                      }
                    : { kind: 'accepted' },
            });
            try {
              if (outcome === 'duplicate') await args[3](response);
              if (outcome === 'duplicate' || outcome === 'wrong-kind')
                await expect(args[3](response)).rejects.toMatchObject({
                  code: 'unavailable',
                });
              else await args[3](response);
            } finally {
              renewed.resolve();
            }
          } else await channel.receive(encoded);
        },
      };
    };
    try {
      const accepted = deferred<void>();
      const runtime = await h.backend.openManagedCopilotRuntime({
        owner: TEST_OWNER,
        signal: new AbortController().signal,
      });
      const running = runtime.runTurn(
        turn({ onPromptAccepted: () => accepted.resolve() }),
      );
      const result = running.then(
        () => 'completed',
        () => 'refused',
      );
      await accepted.promise;
      await jest.advanceTimersByTimeAsync(60_000);
      expect(renewals).toBe(2);
      h.natives[1]?.configs[0]?.onEvent?.({
        id: 'acknowledgement-race-idle',
        type: 'session.idle',
        ephemeral: true,
        timestamp: new Date().toISOString(),
        parentId: null,
        data: {},
      });
      expect(await result).toBe(
        outcome === 'duplicate' || outcome === 'wrong-kind'
          ? 'refused'
          : 'completed',
      );
    } finally {
      release.resolve();
      h.pilot.close();
      jest.useRealTimers();
    }
  },
);

it('a refused run stops renewal before its delivery acknowledgement settles', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  jest.useFakeTimers({
    doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate', 'clearImmediate'],
  });
  const open = h.port.open.bind(h.port);
  const started = deferred<void>();
  const refuse = deferred<void>();
  const delivered = deferred<void>();
  let renewals = 0;
  h.port.open = async (...args): ReturnType<typeof h.port.open> => {
    const channel = await open(...args);
    return {
      ...channel,
      receive: async (encoded): Promise<void> => {
        const frame = CopilotLocalRequestSchema.parse(JSON.parse(encoded));
        if (frame.command.kind === 'run') {
          started.resolve();
          await refuse.promise;
          await args[3](
            JSON.stringify({
              kind: 'response',
              requestId: frame.requestId,
              outcome: { kind: 'refused', reason: 'stale' },
            }),
          );
          delivered.resolve();
          await new Promise<void>(() => undefined);
        } else {
          if (frame.command.kind === 'renew') renewals++;
          await channel.receive(encoded);
        }
      },
    };
  };
  try {
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    const running = runtime.runTurn(turn()).then(
      () => 'completed',
      () => 'refused',
    );
    await started.promise;
    await jest.advanceTimersByTimeAsync(45_000);
    refuse.resolve();
    await delivered.promise;
    await jest.advanceTimersByTimeAsync(15_001);
    expect(renewals).toBe(1);
    await jest.advanceTimersByTimeAsync(COPILOT_RECIPIENT_LIMITS.callbackMs);
    expect(await running).toBe('refused');
  } finally {
    h.pilot.close();
    jest.useRealTimers();
  }
});

it('the selected consumer closes at 4096 allocated requests without sending or wrapping the next ID', async () => {
  const h = fixture();
  ready(await h.pilot.setup(grant(), null));
  const start = h.pilotOptions.start.bind(h.pilotOptions);
  h.pilotOptions.start = async (...args): ReturnType<typeof start> => ({
    ...(await start(...args)),
    async execute(_purpose, context): Promise<never> {
      for (let index = 0; index < 4096; index++) {
        await context.callback({ kind: 'notice', name: 'before-prompt' });
      }
      throw new Error('The request ceiling did not close the recipient.');
    },
  });
  const open = h.port.open.bind(h.port);
  const ids: number[] = [];
  h.port.open = async (...args): ReturnType<typeof h.port.open> => {
    const channel = await open(...args);
    return {
      ...channel,
      receive: async (encoded): Promise<void> => {
        ids.push(
          CopilotLocalRequestSchema.parse(JSON.parse(encoded)).requestId,
        );
        await channel.receive(encoded);
      },
    };
  };
  try {
    const runtime = await h.backend.openManagedCopilotRuntime({
      owner: TEST_OWNER,
      signal: new AbortController().signal,
    });
    await expect(runtime.runTurn(turn())).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(ids).toEqual(Array.from({ length: 4096 }, (_, index) => index + 1));
    expect(h.natives[1]?.runtime.close).toHaveBeenCalledTimes(1);
  } finally {
    h.pilot.close();
  }
});

const P7_IMPORT_MATRIX = Object.entries(COPILOT_VAULT_IMPORT_PATHS).flatMap(
  ([phase, paths]) =>
    Object.entries(paths).map(([entry, path]) => ({
      phase: CopilotHandoffPhaseSchema.parse(phase),
      entry,
      path,
    })),
);
it('q-48 remeasures unchanged consumer shapes and covers every authenticated P7 admission state', () => {
  expect(Object.keys(COPILOT_VAULT_TURN_FIELDS)).toHaveLength(26);
  expect(Object.keys(COPILOT_VAULT_OPEN_FIELDS)).toHaveLength(9);
  expect(Object.keys(COPILOT_VAULT_PENDING_PATHS)).toHaveLength(5);
  expect(Object.keys(COPILOT_VAULT_SETUP_CANCEL_PATHS)).toHaveLength(6);
  expect(Object.keys(COPILOT_VAULT_IMPORT_PATHS)).toEqual(
    CopilotHandoffPhaseSchema.options,
  );
  expect(P7_IMPORT_MATRIX).toHaveLength(63);
  expect(
    Object.values(PENDING_STATES).reduce(
      (n, variants) => n + variants.length,
      0,
    ) *
      Object.keys(PENDING_ENTRIES).length *
      Object.keys(PENDING_ORIGINS).length,
  ).toBe(126);
  const coverage: readonly CopilotVaultFieldCoverage[] = [
    ...Object.values(COPILOT_VAULT_TURN_FIELDS),
    ...Object.values(COPILOT_VAULT_OPEN_FIELDS),
  ];
  for (const row of coverage) {
    if (row.renewalCases)
      for (const renewal of row.renewalCases)
        expect(RENEWAL_PARITY[renewal]).toBeDefined();
  }
  expect(
    copilotVaultFieldsCovered(
      {},
      COPILOT_VAULT_OPEN_FIELDS,
      'bound_pre_ingress',
    ),
  ).toBe(false);
  for (const phase of CopilotHandoffPhaseSchema.options) {
    expect(
      copilotVaultFieldsCovered(
        { prompt: 'prompt' },
        COPILOT_VAULT_TURN_FIELDS,
        phase,
      ),
    ).toBe(phase === 'published');
    expect(
      copilotVaultFieldsCovered(
        { requireAccount: true },
        COPILOT_VAULT_OPEN_FIELDS,
        phase,
      ),
    ).toBe(phase === 'published');
  }
});
it.each(P7_IMPORT_MATRIX)(
  'q-48 P7 $phase/$entry = $path never confuses bound recovery with generic setup',
  async ({ phase, entry, path }) => {
    const h = fixture();
    let cancelled: boolean | undefined;
    let legacyCalls = 0;
    const selectedCalls: string[] = [];
    const selectedFailure = (): Promise<never> => {
      selectedCalls.push(entry);
      return Promise.reject(new Error('selected marker'));
    };
    const selected = {
      ...h.backend,
      copilotConnectionStatus: selectedFailure,
      openManagedCopilotRuntime: selectedFailure,
      connectCopilot: selectedFailure,
      disconnectCopilot: selectedFailure,
    };
    const handoff: CopilotQualificationHandoff = {
      ordinarySetup: () => Promise.resolve(false),
      phase: () => Promise.resolve(phase),
      custody: () =>
        Promise.resolve(phase === 'published' ? 'selected' : 'pending'),
      connect: (cancel) => {
        cancelled = !!cancel;
        return Promise.resolve([]);
      },
      verify: () => Promise.resolve([]),
      cleanup: () => Promise.resolve([]),
      close: () => Promise.resolve(),
    };
    const backend = createCopilotQualificationConnection({
      handoff,
      legacy: {
        ...selected,
        connectCopilot: () => {
          legacyCalls++;
          return selectedFailure();
        },
      },
      vault: selected,
      agreed: () => phase === 'published',
      closeAdmission: () => undefined,
    });
    try {
      const signal = new AbortController().signal;
      const invocation =
        entry === 'connect' || entry === 'change-account'
          ? backend.connectCopilot(
              signal,
              () => undefined,
              entry === 'change-account',
            )
          : entry === 'disconnect' || entry === 'setup-cancel'
            ? backend.disconnectCopilot()
            : entry === 'startup'
              ? backend.recoverCopilotAtStartup()
              : entry === 'status'
                ? backend.copilotConnectionStatus()
                : backend.openManagedCopilotRuntime({
                    owner: TEST_OWNER,
                    signal,
                  });
      await invocation.catch(() => undefined);
      expect(legacyCalls).toBe(0);
      if (path === 'cancel') expect(cancelled).toBe(true);
      else if (path === 'recover') expect(cancelled).toBe(false);
      else expect(cancelled).toBeUndefined();
      if (path === 'unavailable' || entry === 'startup')
        expect(selectedCalls).toEqual([]);
      if (phase !== 'published') expect(selectedCalls).toEqual([]);
    } finally {
      h.pilot.close();
    }
  },
);

it('P8 D27 supported caller demand uses its owned successor without predecessor fallback', async () => {
  const h = fixture();
  ready(
    await h.pilot.setup(
      {
        ...grant(),
        accessTokenExpiresAt: new Date(Date.now() + 1000).toISOString(),
      },
      null,
    ),
  );
  h.refreshSuccess();
  const storing = deferred<void>();
  h.put.mockImplementation(() => {
    storing.resolve();
    return Promise.resolve({ kind: 'blocked', reason: 'locked' });
  });
  try {
    await h.backend.listCopilotModels(new AbortController().signal);
    await storing.promise;
    expect(h.state().mutation?.kind).toBe('replace');
    const count = h.refresh.mock.calls.length;
    await expect(
      h.backend.listCopilotModels(new AbortController().signal),
    ).resolves.toHaveLength(1);
    expect(h.refresh).toHaveBeenCalledTimes(count);
    expect(h.remove).not.toHaveBeenCalled();
  } finally {
    h.pilot.close();
  }
});

it('P8 receipt recovery failure blocks setup admission and retries without touching grants', async () => {
  const h = fixture();
  const recover = jest.fn<Promise<void>, []>(() =>
    Promise.reject(new Error('unresolved receipt')),
  );
  h.pilotOptions.recoverRuntimeReceipts = recover;
  try {
    expect((await h.pilot.setup(grant(), null)).kind).not.toBe('ready');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(h.natives).toHaveLength(0);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
    recover.mockResolvedValue(undefined);
    ready(
      await h.pilot.setup(
        grant(),
        h.preferences().copilotVaultSelection?.pinGeneration ?? null,
      ),
    );
    expect(recover).toHaveBeenCalledTimes(2);
    expect(h.natives).toHaveLength(1);
    await h.backend.listCopilotModels(new AbortController().signal);
    await h.backend.readCopilotAccountUsage(new AbortController().signal);
    await h.backend.recoverCopilotAtStartup();
    expect(recover).toHaveBeenCalledTimes(2); // Never reap this boot's newly created receipts.
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  } finally {
    h.pilot.close();
  }
});

it('P8 boot receipt recovery is single-flight and a terminal fence prevents post-recovery spawn', async () => {
  const h = fixture();
  const entered = deferred<void>();
  const release = deferred<void>();
  const recover = jest.fn(() => {
    entered.resolve();
    return release.promise;
  });
  h.pilotOptions.recoverRuntimeReceipts = recover;
  const first = h.pilot.recoverRuntimeReceipts();
  expect(h.pilot.recoverRuntimeReceipts()).toBe(first);
  const setup = h.pilot.setup(grant(), null);
  try {
    await entered.promise;
    await h.pilot.quiesce();
    release.resolve();
    await first;
    expect((await setup).kind).not.toBe('ready');
    expect(recover).toHaveBeenCalledTimes(1);
    expect(h.natives).toHaveLength(0);
    expect(h.refresh).not.toHaveBeenCalled();
    expect(h.put).not.toHaveBeenCalled();
  } finally {
    release.resolve();
    h.pilot.close();
  }
});

it.each(['failed', 'unconfirmed'] as const)(
  'P8 Change account waits for confirmed pending retirement after preference disable %s',
  async (outcome) => {
    const h = fixture();
    const authorize = jest.fn(() => {
      expect(h.state().head).toBeNull();
      expect(h.state().mutation).toBeNull();
      expect(h.preferences().copilotVaultSelection?.state).toBe('disabled');
      expect(h.remove).toHaveBeenCalledTimes(1);
      return Promise.resolve(grant());
    });
    const backend = createCopilotVaultConnection({
      port: h.port,
      authorize,
      installation: () => Promise.resolve(base),
      preferences: () =>
        Promise.resolve({ ...DEFAULT_PREFERENCES, ...h.preferences() }),
    });
    try {
      const head = ready(await h.pilot.setup(grant(), null));
      const before = h.state();
      const operationId = 'P8-change-pending';
      expect(
        await h.pilotOptions.journal.compareExchange(before.sequence, {
          ...before,
          sequence: before.sequence + 1,
          mutation: {
            kind: 'replace',
            operationId,
            epoch: head.epoch,
            account: head.account,
            origin: head.origin,
            from: head.pin,
            committed: null,
            probeConfirmed: true,
            cancelling: false,
          },
        }),
      ).toBe(true);
      const disable = jest.spyOn(h.selection, 'disable');
      disable.mockResolvedValueOnce({ kind: outcome });
      await expect(
        backend.connectCopilot(
          new AbortController().signal,
          () => undefined,
          true,
        ),
      ).rejects.toMatchObject({ code: 'unavailable' });
      expect(authorize).not.toHaveBeenCalled();
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.state().head).toEqual(head);
      expect(h.state().mutation?.operationId).toBe(operationId);
      const retained = h.state().removal;
      expect(retained === null).toBe(outcome === 'failed');
      await expect(
        backend.connectCopilot(
          new AbortController().signal,
          () => undefined,
          true,
        ),
      ).resolves.toMatchObject({ phase: 'connected' });
      expect(authorize).toHaveBeenCalledTimes(1);
      expect(h.remove).toHaveBeenCalledTimes(1);
      expect(h.refresh).not.toHaveBeenCalled();
      if (retained)
        expect(disable.mock.calls[1]?.[0].operationId).toBe(
          retained.operationId,
        );
    } finally {
      h.pilot.close();
    }
  },
);
