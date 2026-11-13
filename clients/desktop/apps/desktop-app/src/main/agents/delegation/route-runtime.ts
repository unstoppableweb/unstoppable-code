import {
  selectHomeCapabilityOverlay,
  mergeHomeCapabilityOverlay,
  isHomeOnlyCapabilityOverlay,
} from './home-overlay';

import type { AccountProxyQuotaWait } from '../../account-proxy/quota-wait';
import { resolveSessionAiCreditsAttribution } from '../ai-credits-routing';
import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import { OPENCODE_RUNTIME_VERSION } from '@canopy/desktop-shared/node/opencode/runtime-metadata';
import {
  assertOpenCodeSelectionAvailable,
  type OpenCodeSelection,
} from '../../opencode/selection';
import type { OpenCodeDelegationPreparation } from './opencode-runner';
import type { CopilotAccount } from '@canopy/desktop-shared/types';
import { getRawCopilotModelId } from '@canopy/execution-engine/lib/copilot-models';
import { COPILOT_RUNTIME_VERSION } from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import { readCopilotAccount } from '../../copilot/connection';
import { isCopilotHarnessEnabled } from '../../copilot/feature-flag';
import type { CopilotDelegationPreparation } from './copilot-runner';
import { getRawCursorModelId } from '@canopy/execution-engine/lib/cursor-models';
import { CURSOR_RUNTIME_VERSION } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import type { CursorTurnGates } from '@canopy/desktop-shared/node/cursor/turn-driver';
import { readCursorAccount } from '../../cursor/connection';
import { readPreferencesFile } from '../../lib/preferences-store';
import { assertCursorHarnessEnabled } from '../../cursor/feature-flag';
import type { CursorDelegationPreparation } from './cursor-runner';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { BrowserWindow } from 'electron';
import type {
  AgentDelegationResult,
  AgentDelegationSpawnRequest,
} from '@canopy/protocol/delegation';
import type {
  DelegationParentContext,
  ResolvedAgentRouteSnapshot,
  ResolvedDelegationRoute,
  RunnerAvailability,
} from '@canopy/desktop-shared/node/delegation';
import {
  AgentArtifactStore,
  capabilityOverlayFromAgentProjection,
  type AgentCapabilitySnapshot,
  type MaterializedAgentProjection,
  type MaterializedCapabilityOverlay,
  type RetainedHomeCapability,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import {
  delegationCapabilityDisplayName,
  summarizeDelegationCapabilities,
  type DelegationCapabilityContext,
  type DelegationCapabilityExtensionRefusal,
  type DelegationCapabilityExtensionRequest,
  type DelegationCapabilityExtensionResult,
} from '@canopy/desktop-shared/node/delegation/capability-grant';
import type { DelegationCapabilityDiscovery } from '@canopy/desktop-shared/node/delegation/projections';
import { assertPrivateDirectoryAcl } from '@canopy/desktop-shared/node/delegation/private-storage';
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import type { LocalDelegationContext } from '@canopy/desktop-shared/node/delegation/local-runner';
import { DelegationRunnerError } from '@canopy/desktop-shared/node/delegation/local-runner';
import {
  DELEGATION_WINDOWS_PROFILE_KEYS,
  buildDelegationClaudeEnvironment,
  type DelegationClaudeCredentials,
  type DelegationWindowsProfile,
} from '@canopy/desktop-shared/node/delegation/environment';
import { resolveWindowsGitBash } from '../../lib/windows-git-bash';
import {
  createLocalCapabilityRoot,
  isJsonValue,
  type CodexSpawnProfileRequest,
} from '@canopy/execution-engine/node/codex-runtime';
import type { CodexConfig } from '@canopy/execution-engine/lib/codex-model-config';
import {
  isAgentModel,
  type ApprovalCheck,
  type ApprovalRule,
  type ChatTabPluginSelections,
  type CodexSelectedCapabilityRoot,
} from '@canopy/desktop-shared/types';
import type { ThreadStartParams } from '@canopy/execution-engine/node/codex-runtime/generated/v2/ThreadStartParams';
import { resolveAnthropicMockEnvOverride } from '@canopy/execution-engine/node/e2e-mock-env';
import type { AgentSessionOptions } from '../types';
import { resolveSessionWorkOwner } from '../work-owner';
import { buildChatSessionKey } from '../session-key';
import {
  resolveDelegationModel,
  resumeDelegationModel,
} from '../delegation-model-runtime';
import { getAuthoritativeConfiguredModel } from '../../lib/model-config';
import { isModelBlockedByStoredPolicy } from '../../lib/model-policy-state';
import { resolveHelperInvocation } from '../../ollama/helper-invocation';
import { resolveCodexRuntimeEnvironmentProfile } from '../../lib/user-environment-runtime';
import { getLoginShellPath } from '@canopy/execution-engine/pipelines/config-paths';
import { delegatedCodexCommandEnvironment } from './codex-command-environment';
import {
  isProviderNativelyAuthenticatedForRouting,
  peekProviderAccountIdentity,
} from '../../auth/provider-auth-state';
import { readClaudeOauthCredentialsResult } from '../../auth/claude-oauth-credentials';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../../approvals/approval-service';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  DELEGATION_FILE_HELPER_MISSING_MESSAGE,
  delegationFileBoundaryAvailable,
  openDelegationFiles,
} from './file-process';
import { delegationRuntimeUnavailableReason } from './runtime-support';
import {
  materializeDelegationCapabilities,
  type DelegationCapabilityLayer,
} from './agent-projection';
import {
  delegatedMcpUnavailableGuidance,
  resolveDelegatedMcpCapabilities,
  type DelegatedMcpResolutionOptions,
  type DelegatedMcpUnavailable,
} from './agent-mcp-capabilities';
import {
  DelegationCapabilityReloadController,
  DelegationCapabilityReloadFailure,
  type DelegationCapabilityReloadHost,
} from './capability-reload';
import {
  createDelegateDeferredToolsSource,
  type DelegateDeferredToolsSource,
} from './delegate-deferred-tools';
import { getObservabilityService } from '../../observability';
import {
  DelegationAgentCapabilityError,
  delegationAgentCapabilityError,
  delegationCapabilitySkipReason,
} from './agent-capability-error';
import { DelegationCapabilityCache } from './capability-cache';
import { loadDelegationCapabilityCatalog } from './capability-catalog';
import {
  discoverDelegationCapabilityChoices,
  prepareDelegationCapabilities,
  resolveDelegateCallerCapabilities,
  resolveRootCallerCapabilities,
  selectionsFromRefs,
  type DelegationCallerCapabilities,
  type PreparedDelegationCapabilities,
} from './capability-grant';
import { DelegationNativePolicy } from './native-policy';
import { resolveDelegationGitAccess } from './git-access';
import { BRAND } from '@canopy/brand/current';
import { resolveIsolatedDelegationSetupHint } from './setup-hint';
import {
  createDelegateCanopyTools,
  type DelegateCanopyTools,
} from './canopy-tools';
import {
  delegatedClaudeConfigDirectory,
  resolveAmbientClaudePluginIds,
  resolveAutoLoadedClaudeModPluginIds,
} from './claude-settings';
import { isCodeGraphAvailableForWorkspace } from '../../lib/code-graph-availability';
import {
  DELEGATED_CLAUDE_SETTING_SOURCES,
  type ClaudeDelegationPreparation,
} from './claude-runner';
import type { CodexDelegationPreparation } from './codex-runner';
import { getMcpHttpProxyService } from '../../mcp/http-proxy-service';
import { getCodexRuntimeService } from '../../codex/runtime-service';
import { getDesktopCodexCapabilityStore } from '../../codex/capability-store';

/** Process-level Codex arguments for the restricted delegation worker. No
 * Windows sandbox level is selected: on Windows the worker runs without an OS
 * sandbox, and the approval gate is its boundary. */
export function delegationCodexConfigArgs(): string[] {
  return ['-c', 'features.hooks=false', '-c', 'features.apps=false'];
}

/** Windows host inputs for a delegated Claude child: Git Bash for its Bash
 * tool and the profile values Windows tools expect. */
export interface WindowsClaudeHost {
  readonly gitBashPath?: string;
  readonly windowsProfile: DelegationWindowsProfile;
}

/** Captured with the route, so a retained route is prepared with the same host
 * inputs it was authorized with. */
export function captureWindowsClaudeHost(
  environment: NodeJS.ProcessEnv = process.env,
  resolveGitBash: (environment: NodeJS.ProcessEnv) => string | null = (value) =>
    resolveWindowsGitBash(value),
): WindowsClaudeHost {
  return {
    gitBashPath: resolveGitBash(environment) ?? undefined,
    windowsProfile: Object.fromEntries(
      DELEGATION_WINDOWS_PROFILE_KEYS.map((key) => [key, environment[key]]),
    ),
  };
}

interface CapturedInvocation {
  readonly waitForQuotaRecovery?: AccountProxyQuotaWait;
  readonly model: string;
  readonly route: ResolvedAgentRouteSnapshot;
  readonly credentials: DelegationClaudeCredentials;
  readonly commandPath: string;
  readonly windowsHost?: WindowsClaudeHost;
  readonly config: NonNullable<ThreadStartParams['config']>;
  readonly profile: CodexSpawnProfileRequest;
  readonly authGeneration: number;
  readonly environmentFingerprint: string;
  readonly dispose: () => void;
  /** Set only when the helper took an account-proxy hold for this route. */
  readonly retained?: boolean;
  readonly projection?: MaterializedAgentProjection;
  readonly capabilities?: MaterializedCapabilityOverlay;
}

/** Per-run state shared by the launch and any in-run capability reload. */
interface DelegationRunSession {
  readonly context: LocalDelegationContext;
  readonly owner: AgentSessionOptions;
  captured: CapturedInvocation;
  readonly cwd: string;
  readonly isolated: boolean;
  readonly setupHint: string | undefined;
  readonly tools: DelegationNativePolicy;
  readonly backgroundTaskDirectory: string | undefined;
  /** Live native-policy inputs, replaced in place by each preparation. */
  readonly readRoots: string[];
  readonly mcpServerNames: string[];
  readonly skillNames: string[];
  readonly instructions: { text: string };
  readonly reload: DelegationCapabilityReloadController | undefined;
  /** Preparations so far; the first MCP session id has no reload suffix. */
  preparations: number;
  mcpSessionId?: string;
  cursorGates?: CursorTurnGates;
  /** The overlay the run currently uses. */
  overlay?: MaterializedCapabilityOverlay;
  /** The overlay a failed reload restores. */
  restoreOverlay?: MaterializedCapabilityOverlay;
}

interface PreparedDelegationMcp {
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly codexMcpServers: CodexConfig;
  readonly providerGatedServers: readonly string[];
  readonly unavailable: readonly DelegatedMcpUnavailable[];
  readonly names: readonly string[];
}

interface PreparedDelegationCapabilityRuntime {
  readonly appTools: DelegateCanopyTools;
  readonly claudePlugins: readonly {
    type: 'local';
    path: string;
    skipMcpDiscovery: true;
  }[];
  readonly claudeSkillNames: readonly string[];
  readonly codexCapabilityRoots: readonly CodexSelectedCapabilityRoot[];
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  readonly codexMcpServers: CodexConfig;
  readonly providerGatedMcpServers: readonly string[];
  readonly unavailableMcp: readonly DelegatedMcpUnavailable[];
}

function isEmptyOverlay(overlay: MaterializedCapabilityOverlay): boolean {
  const { capabilities } = overlay;
  return (
    !capabilities.claudePluginRoots.length &&
    !capabilities.claudeSkillNames.length &&
    !capabilities.codexCapabilityRoots.length &&
    !capabilities.mcpSelections.length
  );
}

/** The child's effective selections, for Load's already-enabled check. */
function overlaySelections(
  overlay: MaterializedCapabilityOverlay | undefined,
): ChatTabPluginSelections {
  return selectionsFromRefs(
    (overlay?.items ?? []).map((item) => item.ref),
    {
      mcpHttpAuthPreferences: [
        ...(overlay?.capabilities.mcpHttpAuthPreferences ?? []),
      ],
    },
  );
}

/** A path-free display name for a retained MCP selection. */
function mcpSelectionName(
  overlay: MaterializedCapabilityOverlay,
  selection: AgentCapabilitySnapshot['mcpSelections'][number],
): string {
  if (
    selection.source === 'plugin' ||
    selection.source === 'inherited-plugin'
  ) {
    const plugin = overlay.items.find(
      (item) =>
        item.ref.kind === 'plugin' &&
        item.ref.marketplaceId === selection.marketplaceId &&
        item.ref.pluginName === selection.pluginName,
    );
    return `${plugin?.name ?? selection.pluginName}/${selection.serverName}`;
  }
  const item = overlay.items.find(
    (entry) =>
      entry.ref.kind === 'mcp' &&
      entry.ref.serverId === selection.serverId &&
      entry.ref.configId === selection.configId,
  );
  return item?.name ?? 'An MCP server';
}

function unavailableReasonText(
  reason: DelegatedMcpUnavailable['reason'],
): string {
  switch (reason) {
    case 'sign_in_required':
      return 'sign-in required';
    case 'account_unavailable':
      return 'account connection unavailable';
    case 'provider_unsupported':
      return 'not supported for this model';
    default:
      return 'unavailable';
  }
}

function extensionRefusalText(
  reason: DelegationCapabilityExtensionRefusal,
): string {
  switch (reason) {
    case 'reload_limit':
      return 'This delegated task already loaded capabilities three times in this run.';
    case 'not_running':
    case 'generation_mismatch':
      return 'This delegated run is no longer active.';
    default:
      return 'The capabilities could not be recorded for this delegated task.';
  }
}

export interface DelegationRouteAuthoritySnapshot {
  readonly authGeneration: number;
  readonly environmentFingerprint: string;
}

function unavailable(
  code:
    | 'route_unavailable'
    | 'auth_required'
    | 'policy_blocked'
    | 'capability_unavailable' = 'route_unavailable',
  message?: string,
): Extract<AgentDelegationResult<never>, { ok: false }> {
  return {
    ok: false,
    error: {
      code,
      message:
        message ??
        (code === 'auth_required'
          ? 'Sign in to the selected child provider before delegating this task.'
          : 'The selected model, account, or confined runner is unavailable.'),
      retryable: false,
    },
  };
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function delegationProjectionInstructions(
  projection: MaterializedAgentProjection | undefined,
  readRoots: readonly string[],
): string {
  const prompt = projection?.systemPromptAppend;
  return [
    prompt && readRoots[0]
      ? prompt.split('@agent/').join(`${readRoots[0]}/`)
      : prompt,
    ...readRoots.map(
      (root) =>
        `Retained Agent files are available at ${root}. Use native read/search tools to inspect them.`,
    ),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function isDelegationRouteAuthorized(options: {
  readonly owner: AgentSessionOptions;
  readonly route: ResolvedAgentRouteSnapshot;
  readonly captured: DelegationRouteAuthoritySnapshot;
  readonly authGeneration: (
    provider: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
  ) => number;
}): Promise<boolean> {
  const { owner, route, captured } = options;
  const workOwner = await resolveSessionWorkOwner(owner);
  if (
    route.harnessId !== 'claude' &&
    route.harnessId !== 'codex' &&
    route.harnessId !== 'cursor' &&
    route.harnessId !== 'copilot' &&
    route.harnessId !== 'opencode'
  )
    return false;
  return (
    (route.harnessId !== 'cursor' ||
      (await readPreferencesFile()).cursorEnabled === true) &&
    (route.harnessId !== 'copilot' ||
      (isCopilotHarnessEnabled() &&
        (await readPreferencesFile()).copilotEnabled === true)) &&
    (route.harnessId !== 'opencode' ||
      (await readPreferencesFile()).opencodeEnabled === true) &&
    getAuthoritativeConfiguredModel(route.runtimeModelId)?.enabled === true &&
    !(await isModelBlockedByStoredPolicy(route.runtimeModelId, workOwner)) &&
    options.authGeneration(route.harnessId) === captured.authGeneration &&
    fingerprint(
      resolveCodexRuntimeEnvironmentProfile({
        runtime: 'agent',
        workspaceId: owner.projectId,
      }),
    ) === captured.environmentFingerprint
  );
}

/**
 * A child's approval handle evaluated against the root chat's live session
 * rules. Before every check, and whenever the policy context is read, the
 * handle's rule list is refreshed in place from the root: a rule the root
 * added applies to the child, and a rule the root removed or changed stops
 * applying as it was. A rule the child's own prompt granted stays for the
 * run. Any synced change (an addition, removal or change) also changes the
 * policy context key, so an approval in flight when the root's rules changed
 * fails its final context check instead of resolving under the old rules; a
 * retry is evaluated against the current ones.
 */
export function liveSessionRuleApproval(
  initialRules: readonly ApprovalRule[],
  currentRules: () => readonly ApprovalRule[] | undefined,
  create: (sessionRules: ApprovalRule[]) => ApprovalSessionHandle,
): ApprovalSessionHandle {
  const sessionRules: ApprovalRule[] = structuredClone([...initialRules]);
  const rootRuleIds = new Set(sessionRules.map((rule) => rule.id));
  let revision = 0;
  const synchronize = (): void => {
    const live = currentRules();
    // An unavailable root fails closed through the owner check instead.
    if (!live) return;
    const liveById = new Map(live.map((rule) => [rule.id, rule]));
    for (let index = sessionRules.length - 1; index >= 0; index -= 1) {
      const rule = sessionRules[index];
      if (!rule || !rootRuleIds.has(rule.id)) continue;
      const current = liveById.get(rule.id);
      if (!current) {
        sessionRules.splice(index, 1);
        rootRuleIds.delete(rule.id);
        revision += 1;
      } else if (JSON.stringify(current) !== JSON.stringify(rule)) {
        // A changed rule may be narrower; treat it like a removal.
        sessionRules[index] = structuredClone(current);
        revision += 1;
      }
    }
    for (const rule of live)
      if (!sessionRules.some((existing) => existing.id === rule.id)) {
        // Any added rule (a deny rule narrows) changes the policy an
        // in-flight approval was shown under, so that approval fails closed.
        // A rule the child's own prompt granted is already present here, so
        // it does not invalidate the approval that granted it.
        sessionRules.push(structuredClone(rule));
        rootRuleIds.add(rule.id);
        revision += 1;
      }
  };
  const handle = create(sessionRules);
  const evaluate = handle.evaluate?.bind(handle);
  return {
    check: (check, display): ReturnType<ApprovalSessionHandle['check']> => {
      synchronize();
      return handle.check(check, display);
    },
    ...(evaluate
      ? {
          evaluate: (
            check: ApprovalCheck,
          ): ReturnType<NonNullable<ApprovalSessionHandle['evaluate']>> => {
            synchronize();
            return evaluate(check);
          },
        }
      : {}),
    setMode: (mode): void => handle.setMode(mode),
    policyContextKey: (): string => {
      synchronize();
      return JSON.stringify([handle.policyContextKey?.() ?? '', revision]);
    },
    fileWriteNarrowingInFlight: (): boolean =>
      handle.fileWriteNarrowingInFlight?.() === true,
    reevaluatePendingApprovals: (mode, previousMode): Promise<void> =>
      handle.reevaluatePendingApprovals(mode, previousMode),
    invalidatePending: (): void => handle.invalidatePending?.(),
    dispose: (): void => handle.dispose(),
  };
}

/** Private resolved invocation state is never copied into a public route. */
export class DelegationRouteRuntime {
  private readonly captured = new Map<string, CapturedInvocation>();
  /** Each live run's working directory and root chat, for its watchers (CAN-6031). */
  private readonly workingDirectories = new Map<
    string,
    { readonly chatId: string; readonly cwd: string }
  >();
  /** Account-proxy holds by preparation signal, visible before capture completes. */
  private readonly retainedPreparations = new Map<
    AbortSignal,
    {
      readonly harness: string;
      dispose?: () => void;
      withdrawn?: boolean;
      routeId?: string;
    }
  >();
  private readonly artifacts: AgentArtifactStore;
  /** Materialized plugin and skill trees, shared by sibling spawns. */
  private readonly capabilityCache = new DelegationCapabilityCache();
  constructor(
    private readonly options: {
      directory: string;
      owner: (
        parent: DelegationParentContext,
      ) => AgentSessionOptions | undefined;
      getWindow: () => BrowserWindow | null;
      authGeneration: (
        provider: 'claude' | 'codex' | 'cursor' | 'copilot' | 'opencode',
      ) => number;
      /** Host-only lookup of a parent delegate's grant and retained route. */
      capabilityContext?: (
        delegationId: string,
      ) => DelegationCapabilityContext | undefined;
      /** False when the harness was revoked after this preparation's broker admission. */
      admissionCurrent?: (signal: AbortSignal, harness: string) => boolean;
      /** The broker's atomic mid-run grant extension; enables child loads. */
      extendCapabilityGrant?: (
        request: DelegationCapabilityExtensionRequest,
      ) => Promise<DelegationCapabilityExtensionResult>;
    },
  ) {
    this.artifacts = new AgentArtifactStore(
      path.join(options.directory, 'artifacts'),
    );
  }

  /** Called when the delegation actor closes. */
  dispose(): void {
    this.capabilityCache.clear();
  }

  /**
   * The caller's effective capability set. A root chat uses its live
   * selections; a delegate uses its retained overlay, never the root's.
   */
  private async callerCapabilities(
    parent: DelegationParentContext,
    owner: AgentSessionOptions,
  ): Promise<DelegationCallerCapabilities> {
    if (parent.depth === 0 || !parent.parentDelegationId)
      return resolveRootCallerCapabilities(owner);
    const context = this.options.capabilityContext?.(parent.parentDelegationId);
    const route = context?.route;
    let overlay: MaterializedCapabilityOverlay | undefined;
    if (route?.capabilityOverlay)
      overlay = await this.artifacts.loadCapabilityOverlay(
        route.capabilityOverlay,
      );
    else if (route?.agentOverlay)
      overlay = capabilityOverlayFromAgentProjection(
        await this.artifacts.load(route.agentOverlay),
      );
    return resolveDelegateCallerCapabilities({
      depth: parent.depth,
      owner,
      grant: context?.grant,
      overlay,
    });
  }

  /** List Delegates { includeCapabilities: true } for this caller. */
  async discoverCapabilities(
    parent: DelegationParentContext,
    signal?: AbortSignal,
  ): Promise<DelegationCapabilityDiscovery> {
    const owner = this.options.owner(parent);
    if (!owner || signal?.aborted) return { capabilities: [] };
    const harness =
      parent.harnessId === 'opencode'
        ? 'opencode'
        : parent.harnessId === 'copilot'
          ? 'copilot'
          : parent.harnessId === 'cursor'
            ? 'cursor'
            : parent.harnessId === 'codex'
              ? 'codex'
              : 'claude';
    const readSignal = signal ?? new AbortController().signal;
    const [caller, catalog] = await Promise.all([
      this.callerCapabilities(parent, owner),
      loadDelegationCapabilityCatalog(harness),
    ]);
    return discoverDelegationCapabilityChoices({
      caller,
      catalog,
      ...(signal ? { signal } : {}),
      dryRun: async (item): Promise<string | undefined> => {
        try {
          const result = await materializeDelegationCapabilities(
            [
              {
                source: 'explicit',
                selections: selectionsFromRefs([item.ref]),
              },
            ],
            (directory) => openDelegationFiles(directory, readSignal),
            harness,
            { cache: this.capabilityCache },
          );
          const skipped = result.skipped[0];
          return skipped
            ? new DelegationAgentCapabilityError(skipped.reason, {
                kind: skipped.kind,
                name: skipped.name,
              }).publicMessage
            : undefined;
        } catch (error) {
          // Discovery is advisory; the spawn materializes and checks again.
          return delegationAgentCapabilityError(error)?.publicMessage;
        }
      },
    });
  }

  release(route: ResolvedAgentRouteSnapshot): void {
    if (!route.routeId) return;
    const invocation = this.captured.get(route.routeId);
    this.captured.delete(route.routeId);
    for (const [signal, held] of Array.from(this.retainedPreparations))
      if (held.routeId === route.routeId)
        this.retainedPreparations.delete(signal);
    invocation?.dispose();
  }

  /** Drops this preparation's held route at an accepted stop; the broker still aborts the preparation later. */
  withdrawPreparation(signal: AbortSignal): void {
    const held = this.retainedPreparations.get(signal);
    if (!held) return;
    held.withdrawn = true;
    held.dispose?.();
  }

  retainsRoute(target: {
    readonly route: ResolvedAgentRouteSnapshot;
  }): boolean {
    const routeId = target.route.routeId;
    return routeId ? this.captured.get(routeId)?.retained === true : false;
  }

  /** Disposes held account-proxy routes for this harness; unheld routes keep their own lifetime. */
  revokeHarness(harnessId: string): void {
    for (const held of Array.from(this.retainedPreparations.values()))
      if (held.harness === harnessId) {
        held.withdrawn = true;
        held.dispose?.();
      }
    for (const [routeId, captured] of Array.from(this.captured)) {
      if (!captured.retained || captured.route.harnessId !== harnessId)
        continue;
      this.captured.delete(routeId);
      captured.dispose();
    }
  }

  async resolve(
    parent: DelegationParentContext,
    task: AgentDelegationSpawnRequest,
    signal: AbortSignal,
    retainedRoute?: ResolvedAgentRouteSnapshot,
  ): Promise<AgentDelegationResult<ResolvedDelegationRoute>> {
    const owner = this.options.owner(parent);
    if (!owner || signal.aborted) return unavailable();
    if (hostOperatingSystem() === null)
      return unavailable('capability_unavailable');
    // A direct spawn bypasses advisory discovery, so reject a missing or
    // invalid staged helper here, before any provider route is captured, with
    // the same actionable copy. The launch still rechecks in openNativeFiles.
    if (!(await delegationFileBoundaryAvailable()))
      return unavailable(
        'capability_unavailable',
        DELEGATION_FILE_HELPER_MISSING_MESSAGE,
      );
    // A continuation reuses its retained overlays; the grant is fixed at spawn.
    const retainedOverlay =
      retainedRoute?.agentOverlay || retainedRoute?.capabilityOverlay
        ? retainedRoute
        : undefined;
    if (retainedRoute && retainedRoute.selectedModelId !== task.modelId)
      return unavailable();
    if (
      retainedRoute &&
      isAgentModel(task.modelId) &&
      !retainedRoute.agentOverlay
    )
      return unavailable();
    let invocation:
      | Omit<CapturedInvocation, 'projection' | 'capabilities'>
      | undefined;
    let preparedCapabilities: PreparedDelegationCapabilities | undefined;
    const host: Parameters<typeof resolveDelegationModel>[2] = {
      artifacts: this.artifacts,
      lookupModel: getAuthoritativeConfiguredModel,
      materializeCapabilities: async ({ agentSelections, harness }) => {
        if (retainedRoute) return undefined;
        preparedCapabilities = await prepareDelegationCapabilities({
          task,
          caller: await this.callerCapabilities(parent, owner),
          agentSelections,
          harness,
          materialize: (layers) =>
            materializeDelegationCapabilities(
              layers,
              (directory) => openDelegationFiles(directory, signal),
              harness,
              { cache: this.capabilityCache },
            ),
          loadCatalog: loadDelegationCapabilityCatalog,
        });
        return preparedCapabilities.overlay;
      },
      captureRoute: async (runtime) => {
        const harness = runtime.executionHarness;
        if (task.fastMode === true && harness !== 'codex')
          return unavailable('capability_unavailable');
        const model = getAuthoritativeConfiguredModel(runtime.runtimeModel);
        if (
          (harness !== 'claude' &&
            harness !== 'codex' &&
            harness !== 'cursor' &&
            harness !== 'copilot' &&
            harness !== 'opencode') ||
          runtime.providerType === 'ollama' ||
          !model?.enabled
        )
          return unavailable('capability_unavailable');
        // No pinned managed runtime for this provider on this host (e.g. Linux
        // Cursor/Copilot/OpenCode). Reject before any provider auth or billing
        // probe, with the same reason advisory discovery shows. Static pin
        // check only — never installs a runtime or probes an account.
        const runtimeUnavailable =
          await delegationRuntimeUnavailableReason(harness);
        if (runtimeUnavailable)
          return unavailable('capability_unavailable', runtimeUnavailable);
        if (
          await isModelBlockedByStoredPolicy(
            runtime.runtimeModel,
            await resolveSessionWorkOwner(owner),
          )
        )
          return unavailable(
            'policy_blocked',
            'This model is blocked by your organization policy.',
          );
        const authGeneration = this.options.authGeneration(harness);
        const workspaceEnvironment = resolveCodexRuntimeEnvironmentProfile({
          runtime: 'agent',
          workspaceId: owner.projectId,
        });
        let cursorAccount:
          | Awaited<ReturnType<typeof readCursorAccount>>
          | undefined;
        let copilotAccount: CopilotAccount | null = null;
        let openCodeSelection: OpenCodeSelection | undefined;
        if (harness === 'opencode')
          openCodeSelection = await assertOpenCodeSelectionAvailable({
            model: runtime.runtimeModel,
            session: owner,
            signal,
          });
        if (harness === 'copilot') {
          copilotAccount = await readCopilotAccount();
          if (!copilotAccount) return unavailable('auth_required');
        }
        if (harness === 'cursor') {
          assertCursorHarnessEnabled();
          if (!(await readPreferencesFile()).cursorEnabled)
            return unavailable('auth_required');
          cursorAccount = await readCursorAccount(signal);
          if (!cursorAccount) return unavailable('auth_required');
        }
        const mock = resolveAnthropicMockEnvOverride();
        const routed =
          harness === 'cursor' ||
          harness === 'copilot' ||
          harness === 'opencode'
            ? {
                harness,
                providerType: runtime.providerType,
                sdkModel:
                  harness === 'opencode'
                    ? getRawOpenCodeModelId(runtime.runtimeModel)
                    : harness === 'copilot'
                      ? getRawCopilotModelId(runtime.runtimeModel)
                      : getRawCursorModelId(runtime.runtimeModel),
                aiCreditsRouted:
                  openCodeSelection?.kind === 'gateway' &&
                  openCodeSelection.funding === 'ai-credits',
                dispose: (): void => undefined,
                codexConfig: undefined,
                envOverride: undefined,
              }
            : await resolveHelperInvocation(
                runtime.runtimeModel,
                owner.aiCreditsRouting
                  ? { ...owner.aiCreditsRouting, modelId: runtime.runtimeModel }
                  : undefined,
                {
                  workspaceId: owner.projectId,
                  allowNoNativeAuthFallback: false,
                  signal,
                  // E2E mock routes keep the proxy's normal expiry.
                  retainRoutesUntilDisposed: !mock,
                  onRoutesRetained: (): void => {
                    this.retainedPreparations.set(signal, { harness });
                  },
                  subscriptionBillingOverride:
                    owner.subscriptionBillingOverride,
                  // A child's work belongs to whoever owns the parent chat; it never
                  // re-reads the sidebar selection (CAN-3456).
                  workOwner: await resolveSessionWorkOwner(owner),
                  // The account proxy keeps a child on its parent's account.
                  accountProxyParentSessionId: buildChatSessionKey(
                    owner.projectId,
                    owner.worktreeId,
                    owner.chatId,
                  ),
                },
              );
        let retained = false;
        const held = this.retainedPreparations.get(signal);
        if (held) {
          held.dispose = routed.dispose;
          // Revoked while routing, or after this preparation's admission: drop the hold now;
          // the broker refuses the spawn as before.
          if (
            held.withdrawn === true ||
            this.options.authGeneration(harness) !== authGeneration ||
            this.options.admissionCurrent?.(signal, harness) === false
          )
            routed.dispose();
        }
        try {
          if (
            routed.harness !== harness ||
            routed.providerType !== runtime.providerType ||
            signal.aborted
          )
            return unavailable();
          const userValue = (key: string): string | undefined =>
            workspaceEnvironment.environment[key] ?? process.env[key];
          let credentials: DelegationClaudeCredentials = {};
          const config: NonNullable<ThreadStartParams['config']> = {};
          for (const [key, value] of Object.entries(routed.codexConfig ?? {})) {
            if (!isJsonValue(value)) return unavailable();
            config[key] = value;
          }
          const accountProxyRouted =
            'accountProxyRouted' in routed &&
            routed.accountProxyRouted === true;
          // Both routes bring their own provider credential, so neither needs
          // a native login or counts as the user's own key.
          const brokerRouted = routed.aiCreditsRouted || accountProxyRouted;
          let billingAuthority =
            openCodeSelection?.kind === 'gateway'
              ? openCodeSelection.funding
              : routed.aiCreditsRouted
                ? 'ai-credits'
                : accountProxyRouted
                  ? 'account-proxy'
                  : 'native';
          if (harness === 'claude') {
            const routedEnvironment = routed.envOverride;
            const apiKey =
              routedEnvironment?.ANTHROPIC_API_KEY ??
              userValue('ANTHROPIC_API_KEY');
            const authToken =
              routedEnvironment?.ANTHROPIC_AUTH_TOKEN ??
              userValue('ANTHROPIC_AUTH_TOKEN');
            const baseUrl =
              routedEnvironment?.ANTHROPIC_BASE_URL ??
              userValue('ANTHROPIC_BASE_URL');
            credentials = {
              apiKey,
              authToken,
              baseUrl,
              customHeaders: routedEnvironment?.ANTHROPIC_CUSTOM_HEADERS,
              disableExperimentalBetas:
                routedEnvironment?.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS ===
                '1',
              disableInlineTools:
                routedEnvironment?.CLAUDE_CODE_INLINE_TOOLS === 'false',
            };
            if (!apiKey && !authToken) {
              // Never forward a subscription token to an alternate API endpoint.
              if (baseUrl) return unavailable('auth_required');
              const oauth = await readClaudeOauthCredentialsResult();
              if (oauth.status !== 'success')
                return unavailable('auth_required');
              credentials = {
                ...credentials,
                oauthToken: oauth.credentials.accessToken,
              };
            } else if (!brokerRouted && !mock)
              billingAuthority = 'user-credential';
          } else if (harness === 'codex' && mock) {
            config.model_provider = 'delegation_mock';
            config.model_providers = {
              delegation_mock: {
                name: 'Delegation mock',
                base_url: `${mock.ANTHROPIC_BASE_URL}/v1`,
                wire_api: 'responses',
                requires_openai_auth: false,
                http_headers: {
                  Authorization: `Bearer ${mock.ANTHROPIC_API_KEY}`,
                },
              },
            };
          } else if (harness === 'codex' && !brokerRouted) {
            // The restricted worker reads the canonical native auth store. An
            // environment-only API route is unavailable until separately supported.
            if (userValue('OPENAI_API_KEY') || userValue('OPENAI_BASE_URL'))
              return unavailable('capability_unavailable');
            if (
              !(await isProviderNativelyAuthenticatedForRouting(
                'codex',
                'delegation',
              ))
            )
              return unavailable('auth_required');
          }
          if (
            mock &&
            harness !== 'cursor' &&
            harness !== 'copilot' &&
            harness !== 'opencode'
          )
            billingAuthority = 'e2e';
          const supported = (
            openCodeSelection?.supportedThinkingLevels ??
            model.supportedThinkingLevels
          ).filter((level) => level !== 'ultra');
          const runtimeVersion =
            harness === 'opencode'
              ? OPENCODE_RUNTIME_VERSION
              : harness === 'copilot'
                ? COPILOT_RUNTIME_VERSION
                : harness === 'cursor'
                  ? CURSOR_RUNTIME_VERSION
                  : harness === 'claude'
                    ? __DEP_CLAUDE_CLI__
                    : __DEP_CODEX_CLI__;
          const route: ResolvedAgentRouteSnapshot = {
            selectedModelId: runtime.selectedModel,
            selectedModelLabel:
              runtime.agent?.name ??
              getAuthoritativeConfiguredModel(runtime.selectedModel)?.label ??
              runtime.selectedModel,
            runtimeModelLabel: model.label,
            runtimeModelId: runtime.runtimeModel,
            harnessId: harness,
            runtimeKind:
              harness === 'opencode'
                ? 'opencode-acp'
                : harness === 'copilot'
                  ? 'copilot-sdk'
                  : harness === 'cursor'
                    ? 'cursor-acp'
                    : harness === 'claude'
                      ? 'claude-sdk'
                      : 'codex-app-server',
            runnerRegistrationId: `local-delegation-${harness}-v1`,
            runtimeVersion,
            adapterVersion: '1',
            modelSource: model.modelSource,
            providerType: runtime.providerType,
            assignmentRevision: fingerprint({
              model: model.id,
              harness,
              source: model.modelSource,
            }),
            routeId: randomUUID(),
            billingAuthority,
            aiCreditsRouted: routed.aiCreditsRouted,
            effectiveThinkingLevel: supported.includes('high')
              ? 'high'
              : supported[0],
            capabilities: [
              'read',
              'search',
              'write',
              'resume',
              'follow_up',
              'worktree',
              'progress',
              'usage',
              'cancel',
              'foreground',
              'background',
            ],
            supportedThinkingLevels: supported,
            capabilitySnapshotHash: fingerprint({
              harness,
              runtimeVersion,
              policy: 'delegation-explicit-grants-v2',
              tools: ['read', 'search', 'write'],
            }),
            capabilityGeneration: 1,
            policyRevision: 'delegation-explicit-grants-v2',
            authAccountKey:
              harness === 'opencode'
                ? openCodeSelection?.kind === 'gateway'
                  ? openCodeSelection.inferenceBindingKey
                  : undefined
                : harness === 'copilot'
                  ? fingerprint(copilotAccount)
                  : harness === 'cursor'
                    ? fingerprint(cursorAccount)
                    : billingAuthority === 'native'
                      ? peekProviderAccountIdentity(harness)?.providerAccountKey
                      : // The loopback route is new on every resolution, so
                        // the proxy is identified by its connection instead.
                        billingAuthority === 'account-proxy' &&
                          'accountProxyAccountKey' in routed &&
                          routed.accountProxyAccountKey
                        ? fingerprint({
                            accountProxy: routed.accountProxyAccountKey,
                            harness,
                          })
                        : fingerprint({ credentials, config }),
          };
          invocation = {
            waitForQuotaRecovery:
              'waitForQuotaRecovery' in routed
                ? routed.waitForQuotaRecovery
                : undefined,
            model: routed.sdkModel ?? runtime.runtimeModel,
            route,
            credentials,
            commandPath: getLoginShellPath(),
            ...(hostOperatingSystem() === 'win32'
              ? { windowsHost: captureWindowsClaudeHost() }
              : {}),
            config,
            authGeneration,
            environmentFingerprint: fingerprint(workspaceEnvironment),
            dispose: routed.dispose,
            profile: {
              environmentPolicy: 'restricted',
              includeCanopySecrets: false,
              logicalWorkspaceEnvironmentId: `${workspaceEnvironment.logicalWorkspaceEnvironmentId}:delegation`,
              secretVersionFingerprint:
                workspaceEnvironment.secretVersionFingerprint,
              configArgs: delegationCodexConfigArgs(),
              ...(mock ? { mockProviderId: 'delegation-e2e' } : {}),
            },
          };
          retained = true;
          return { ok: true, value: route };
        } finally {
          if (!retained) routed.dispose();
        }
      },
      authorize: async (route): Promise<AgentDelegationResult<void>> =>
        invocation &&
        (await this.authorized(owner, route, invocation)) &&
        !signal.aborted
          ? { ok: true, value: undefined }
          : unavailable(),
    };
    const fresh = await resolveDelegationModel(
      retainedOverlay?.agentOverlay
        ? retainedOverlay.runtimeModelId
        : task.modelId,
      task.thinkingLevel,
      host,
      owner.projectId,
    );
    let result = fresh;
    if (retainedOverlay && fresh.ok) {
      const current = fresh.value.route;
      if (
        current.runtimeModelId !== retainedOverlay.runtimeModelId ||
        current.harnessId !== retainedOverlay.harnessId ||
        current.providerType !== retainedOverlay.providerType
      ) {
        this.retainedPreparations.delete(signal);
        invocation?.dispose();
        return unavailable();
      }
      result = await resumeDelegationModel(
        {
          ...current,
          selectedModelId: retainedOverlay.selectedModelId,
          ...(retainedOverlay.selectedModelLabel
            ? { selectedModelLabel: retainedOverlay.selectedModelLabel }
            : {}),
          requestedThinkingLevel: retainedOverlay.requestedThinkingLevel,
          effectiveThinkingLevel: retainedOverlay.effectiveThinkingLevel,
          ...(retainedOverlay.agentOverlay
            ? { agentOverlay: retainedOverlay.agentOverlay }
            : {}),
          ...(retainedOverlay.capabilityOverlay
            ? { capabilityOverlay: retainedOverlay.capabilityOverlay }
            : {}),
        },
        host,
      );
    }
    const heldPreparation = this.retainedPreparations.get(signal);
    const routeId = result.ok ? result.value.route.routeId : undefined;
    if (!result.ok || !invocation || !routeId || signal.aborted) {
      this.retainedPreparations.delete(signal);
      invocation?.dispose();
      return result.ok ? unavailable() : result;
    }
    const route = result.value.route;
    this.captured.set(routeId, {
      ...invocation,
      retained: heldPreparation !== undefined,
      route,
      projection: result.value.projection,
      capabilities: result.value.capabilities,
    });
    // Kept until release so an accepted stop can still withdraw it before the run starts.
    if (heldPreparation) heldPreparation.routeId = routeId;
    // The broker moves the grant onto the new record; routes never retain it.
    const capabilityGrant = retainedRoute
      ? undefined
      : preparedCapabilities?.grant(
          route.capabilityOverlay?.capabilityProjectionHash,
        );
    return {
      ok: true,
      value: capabilityGrant ? { ...route, capabilityGrant } : route,
    };
  }

  async authorize(
    parent: DelegationParentContext,
    route: ResolvedAgentRouteSnapshot,
    signal: AbortSignal,
  ): Promise<AgentDelegationResult<void>> {
    const owner = this.options.owner(parent);
    const captured = route.routeId
      ? this.captured.get(route.routeId)
      : undefined;
    return owner &&
      captured &&
      fingerprint(route) === fingerprint(captured.route) &&
      !signal.aborted &&
      (await this.authorized(owner, route, captured))
      ? { ok: true, value: undefined }
      : unavailable();
  }

  available = (
    route: ResolvedAgentRouteSnapshot,
  ): Promise<RunnerAvailability> => {
    const captured = route.routeId
      ? this.captured.get(route.routeId)
      : undefined;
    return Promise.resolve<RunnerAvailability>(
      captured && fingerprint(route) === fingerprint(captured.route)
        ? { available: true }
        : {
            available: false,
            error: unavailable('capability_unavailable').error,
          },
    );
  };

  async prepareClaude(
    context: LocalDelegationContext,
  ): Promise<ClaudeDelegationPreparation> {
    const session = await this.prepareSession(context);
    const prepared = await this.prepareCapabilities(
      session,
      session.captured.capabilities,
    );
    const temporary = await fs.mkdtemp(
      path.join(os.tmpdir(), 'delegated-runtime-'),
    );
    context.retain(() => fs.rm(temporary, { recursive: true, force: true }), {
      label: 'claude-temp-dir',
      phase: 'preparation',
    });
    const claudeConfigDirectory = delegatedClaudeConfigDirectory();
    const base = {
      model: session.captured.model,
      waitForQuotaRecovery: session.captured.waitForQuotaRecovery,
      tools: session.tools,
      ambientPluginIds: [
        ...(await resolveAmbientClaudePluginIds({
          home: os.homedir(),
          cwd: session.tools.cwd,
          ...(claudeConfigDirectory
            ? { configDir: claudeConfigDirectory }
            : {}),
        })),
        // Auto-loaded Mods have no settings entry, so they are switched off by id.
        ...resolveAutoLoadedClaudeModPluginIds({
          home: os.homedir(),
          cwd: session.tools.cwd,
          ...(claudeConfigDirectory
            ? { configDir: claudeConfigDirectory }
            : {}),
          settingSources: DELEGATED_CLAUDE_SETTING_SOURCES,
        }),
      ],
      environment: buildDelegationClaudeEnvironment({
        canonicalHome: os.homedir(),
        temporaryDirectory: temporary,
        ...(session.backgroundTaskDirectory
          ? { backgroundTaskDirectory: session.backgroundTaskDirectory }
          : {}),
        ...(claudeConfigDirectory ? { claudeConfigDirectory } : {}),
        credentials: session.captured.credentials,
        commandPath: session.captured.commandPath,
        windowsDirectory: process.env.SystemRoot ?? process.env.SYSTEMROOT,
        ...session.captured.windowsHost,
      }),
    };
    const build = (
      capabilities: PreparedDelegationCapabilityRuntime,
    ): ClaudeDelegationPreparation => ({
      ...base,
      plugins: capabilities.claudePlugins,
      skillNames: capabilities.claudeSkillNames,
      mcpServers: capabilities.mcpServers,
      providerGatedMcpServers: capabilities.providerGatedMcpServers,
      appTools: capabilities.appTools,
      ...(session.reload
        ? {
            capabilityReload: {
              controller: session.reload,
              host: this.reloadHost(session, build),
            },
          }
        : {}),
    });
    return build(prepared);
  }

  async prepareCursor(
    context: LocalDelegationContext,
  ): Promise<CursorDelegationPreparation> {
    const session = await this.prepareSession(context);
    const prepared = await this.prepareCapabilities(
      session,
      session.captured.capabilities,
    );
    const profileDir = path.join(
      this.options.directory,
      'cursor-sessions',
      context.request.delegationId,
    );
    session.readRoots.push(
      path.join(profileDir, 'home', '.cursor', 'skills'),
      path.join(profileDir, 'home', '.cursor', 'commands'),
    );
    return {
      model: session.captured.model,
      profileDir,
      tools: session.tools,
      appTools: prepared.appTools,
      plugins: prepared.claudePlugins,
      mcpServers: prepared.mcpServers,
      bindMcpGates: (gates): void => {
        session.cursorGates = gates;
      },
    };
  }

  async prepareCopilot(
    context: LocalDelegationContext,
  ): Promise<CopilotDelegationPreparation> {
    const session = await this.prepareSession(context);
    const prepared = await this.prepareCapabilities(
      session,
      session.captured.capabilities,
    );
    const profileDir = path.join(
      this.options.directory,
      'copilot-sessions',
      context.request.delegationId,
    );
    const retainedReadRoots = [...session.readRoots];
    session.readRoots.push(
      path.join(profileDir, 'selected-capabilities', 'skills'),
      path.join(profileDir, 'selected-capabilities', 'commands'),
    );
    return {
      model: session.captured.model,
      profileDir,
      tools: session.tools,
      retainedReadRoots,
      appTools: prepared.appTools,
      plugins: prepared.claudePlugins,
      mcpServers: prepared.mcpServers,
    };
  }

  async prepareOpenCode(
    context: LocalDelegationContext,
  ): Promise<OpenCodeDelegationPreparation> {
    const session = await this.prepareSession(context);
    const prepared = await this.prepareCapabilities(
      session,
      session.captured.capabilities,
    );
    const profileDir = path.join(
      this.options.directory,
      'opencode-sessions',
      context.request.delegationId,
    );
    const retainedReadRoots = session.readRoots.filter(
      (root) => root !== session.backgroundTaskDirectory,
    );
    session.readRoots.push(
      path.join(profileDir, 'selected-capabilities', 'skills'),
      path.join(profileDir, 'selected-capabilities', 'commands'),
    );
    return {
      model: session.captured.model,
      attribution: getRawOpenCodeModelId(context.request.route.runtimeModelId)
        ? undefined
        : await resolveSessionAiCreditsAttribution(session.owner),
      profileDir,
      tools: session.tools,
      retainedReadRoots,
      appTools: prepared.appTools,
      plugins: prepared.claudePlugins,
      mcpServers: prepared.mcpServers,
    };
  }

  async prepareCodex(
    context: LocalDelegationContext,
  ): Promise<CodexDelegationPreparation> {
    const session = await this.prepareSession(context);
    const prepared = await this.prepareCapabilities(
      session,
      session.captured.capabilities,
    );
    const commandEnvironment = await delegatedCodexCommandEnvironment(
      session.captured.commandPath,
      context,
    );
    const build = (
      capabilities: PreparedDelegationCapabilityRuntime,
    ): CodexDelegationPreparation => ({
      model: session.captured.model,
      waitForQuotaRecovery: session.captured.waitForQuotaRecovery,
      commandEnvironment,
      tools: session.tools,
      selectedCapabilityRoots: capabilities.codexCapabilityRoots,
      selectedMcpServers: capabilities.codexMcpServers,
      providerGatedMcpServers: capabilities.providerGatedMcpServers,
      appTools: capabilities.appTools,
      config: session.captured.config,
      profile: {
        ...session.captured.profile,
        commandDirectories: session.tools.gitAccess.commandDirectories,
      },
      ...(session.reload
        ? {
            capabilityReload: {
              controller: session.reload,
              host: this.reloadHost(session, build),
            },
          }
        : {}),
    });
    return build(prepared);
  }

  /**
   * The working directory of `delegationId`'s live run, the one its tools
   * use, when its root chat is `chatId`; undefined without a live run.
   */
  workingDirectory(delegationId: string, chatId: string): string | undefined {
    const directory = this.workingDirectories.get(delegationId);
    return directory?.chatId === chatId ? directory.cwd : undefined;
  }

  /** Per-run state shared by the launch and any in-run capability reload. */
  private async prepareSession(
    context: LocalDelegationContext,
  ): Promise<DelegationRunSession> {
    const { parent, route, delegationId } = context.request;
    const cwd = await fs.realpath(context.request.cwd);
    const owner = this.options.owner(parent);
    const captured = route.routeId
      ? this.captured.get(route.routeId)
      : undefined;
    if (
      !owner ||
      !captured ||
      fingerprint(route) !== fingerprint(captured.route) ||
      !(await this.authorized(owner, route, captured)) ||
      context.signal.aborted
    )
      throw new DelegationRunnerError({
        code: 'route_unavailable',
        message: 'The captured child route lost its authority before launch.',
        retryable: false,
      });
    const directory = { chatId: parent.chatId, cwd };
    this.workingDirectories.set(delegationId, directory);
    context.retain(
      (): Promise<void> => {
        if (this.workingDirectories.get(delegationId) === directory)
          this.workingDirectories.delete(delegationId);
        return Promise.resolve();
      },
      { label: 'watcher-directory', phase: 'preparation' },
    );
    // Prompts route to the root chat by identity, not through a live
    // provider session, so they reach the chat while no session is attached.
    const approval = liveSessionRuleApproval(
      owner.sessionApprovalRules ?? [],
      () => this.options.owner(parent)?.sessionApprovalRules,
      (sessionRules) =>
        createApprovalSession({
          sessionKey: `${parent.sessionKey}:delegated:${delegationId}`,
          projectId: parent.projectId,
          worktreeId: parent.worktreeId,
          chatId: parent.chatId,
          provider:
            route.harnessId === 'opencode'
              ? 'opencode'
              : route.harnessId === 'copilot'
                ? 'copilot'
                : route.harnessId === 'cursor'
                  ? 'cursor'
                  : route.harnessId === 'codex'
                    ? 'codex'
                    : 'claude',
          workspaceRoot: owner.cwd,
          mode: owner.approvalMode ?? 'auto',
          sessionRules,
          getWindow: this.options.getWindow,
        }),
    );
    const cancel = (): void => approval.invalidatePending?.();
    context.signal.addEventListener('abort', cancel, { once: true });
    context.retain(
      (): Promise<void> => {
        context.signal.removeEventListener('abort', cancel);
        approval.dispose();
        return Promise.resolve();
      },
      { label: 'approval-session', phase: 'preparation' },
    );
    // Isolated checkouts skip worktree setup; tell the child how to run it.
    const isolated = context.request.task.isolation === 'worktree';
    const setupHint = isolated
      ? await resolveIsolatedDelegationSetupHint({
          projectId: parent.projectId,
          ...(owner.selectedRepoId
            ? { selectedRepoId: owner.selectedRepoId }
            : {}),
          delegateCwd: cwd,
          harness:
            route.harnessId === 'opencode'
              ? 'opencode'
              : route.harnessId === 'copilot'
                ? 'copilot'
                : route.harnessId === 'cursor'
                  ? 'cursor'
                  : route.harnessId === 'codex'
                    ? 'codex'
                    : 'claude',
        })
      : undefined;
    // Claude writes `run_in_background` output under CLAUDE_CODE_TMPDIR. The
    // child reads it back, so the run gets a private readable directory
    // that ends with the run, like the tasks themselves.
    let backgroundTaskDirectory: string | undefined;
    if (route.harnessId === 'claude') {
      const directory = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-tasks-')),
      );
      backgroundTaskDirectory = directory;
      context.retain(() => fs.rm(directory, { recursive: true, force: true }), {
        label: 'background-task-dir',
        phase: 'preparation',
      });
      await assertPrivateDirectoryAcl(directory);
    }
    // Capability-dependent policy inputs. A reload replaces their contents in
    // place, so the one native policy (and its write capture) spans the run.
    const readRoots: string[] = backgroundTaskDirectory
      ? [backgroundTaskDirectory]
      : [];
    const mcpServerNames: string[] = [];
    const skillNames: string[] = [];
    const instructions = { text: setupHint ?? '' };
    const tools = new DelegationNativePolicy({
      cwd,
      ...(route.harnessId === 'codex'
        ? { gitAccess: await resolveDelegationGitAccess(cwd, context.signal) }
        : {}),
      approval,
      delegationId,
      signal: context.signal,
      instructions: (): string => instructions.text,
      readRoots,
      mcpServerNames,
      skillNames,
      // Fails closed: an owner that cannot be resolved is treated as
      // planning, so the child keeps no write access.
      writable: (): boolean => {
        const current = this.options.owner(parent);
        return current !== undefined && current.planMode !== true;
      },
      writePaths: context.request.task.permissions?.writePaths ?? [],
      emit: (event): Promise<void> => context.emit(event),
      mode: (): DelegationNativePolicy['mode'] =>
        this.options.owner(parent)?.approvalMode ?? 'auto',
      // Session rules are evaluated live by the approval handle; a changed
      // rule set no longer revokes the child's owner authority.
      allowed: async (): Promise<boolean> => {
        const current = this.options.owner(parent);
        return Boolean(
          current &&
          !context.signal.aborted &&
          (await this.authorized(current, route, captured)),
        );
      },
    });
    // A reload needs the broker's grant extension and a grant to extend.
    const reload =
      route.harnessId !== 'cursor' &&
      route.harnessId !== 'copilot' &&
      route.harnessId !== 'opencode' &&
      this.options.extendCapabilityGrant &&
      this.options.capabilityContext?.(delegationId)?.grant
        ? new DelegationCapabilityReloadController()
        : undefined;
    if (reload) context.signal.addEventListener('abort', () => reload.cancel());
    return {
      context,
      owner,
      captured,
      cwd,
      isolated,
      setupHint,
      tools,
      backgroundTaskDirectory,
      readRoots,
      mcpServerNames,
      skillNames,
      instructions,
      reload,
      preparations: 0,
      ...(captured.capabilities ? { overlay: captured.capabilities } : {}),
    };
  }

  /**
   * Stage one capability overlay for the run: retained plugin and skill
   * files, Codex capability roots, per-run MCP routes, and the app tools.
   * A reload calls this again with the new overlay; the previous MCP routes
   * are revoked before new ones register.
   */
  private async prepareCapabilities(
    session: DelegationRunSession,
    overlay: MaterializedCapabilityOverlay | undefined,
  ): Promise<PreparedDelegationCapabilityRuntime> {
    const { context } = session;
    const { parent, route, delegationId } = context.request;
    const index = session.preparations;
    session.preparations += 1;
    const readRoots: string[] = [];
    let stagedRootDir: string | undefined;
    // One overlay kind supplies the capabilities: a version 3 capability
    // overlay, or a legacy Agent artifact mapped to one.
    if (overlay) {
      const temporary = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), 'delegated-agent-files-')),
      );
      stagedRootDir = temporary;
      context.retain(() => fs.rm(temporary, { recursive: true, force: true }), {
        label: 'capability-overlay',
        phase: 'capability',
        preparation: index,
      });
      // Windows ignores the 0o600 file modes below; check the temp DACL.
      await assertPrivateDirectoryAcl(temporary);
      for (const [name, content] of Object.entries(overlay.pluginFiles)) {
        const destination = path.resolve(temporary, name);
        const relative = path.relative(temporary, destination);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('Invalid retained Agent file path');
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, content, { mode: 0o600 });
      }
      if (Object.keys(overlay.pluginFiles).length) readRoots.push(temporary);
    }
    const capabilities = overlay?.capabilities;
    if (capabilities?.hookDeclarations.length)
      throw new DelegationRunnerError({
        code: 'capability_unavailable',
        message:
          'Selected Agent plugin hooks are unavailable in managed delegation.',
        retryable: false,
      });
    const stagedAgentRoot = async (root: string): Promise<string> => {
      if (!stagedRootDir) throw new Error('Retained Agent files are missing');
      const absolute = path.resolve(stagedRootDir, root);
      const relative = path.relative(stagedRootDir, absolute);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative))
        throw new Error('Invalid retained Agent plugin root');
      if (!(await fs.stat(absolute)).isDirectory())
        throw new Error('Retained Agent plugin root is unavailable');
      return absolute;
    };
    const claudePlugins =
      route.harnessId !== 'codex'
        ? await Promise.all(
            (capabilities?.claudePluginRoots ?? []).map(async (root) => ({
              type: 'local' as const,
              path: await stagedAgentRoot(root),
              skipMcpDiscovery: true as const,
            })),
          )
        : [];
    let codexCapabilityRoots =
      route.harnessId === 'codex'
        ? await Promise.all(
            (capabilities?.codexCapabilityRoots ?? []).map(async (root) =>
              createLocalCapabilityRoot(await stagedAgentRoot(root)),
            ),
          )
        : [];
    if (codexCapabilityRoots.length) {
      const published =
        await getDesktopCodexCapabilityStore().publishSelectedRoots(
          codexCapabilityRoots,
        );
      if (
        context.signal.aborted ||
        published.roots.length !== codexCapabilityRoots.length
      )
        throw new DelegationRunnerError({
          code: 'capability_unavailable',
          message:
            'Selected Agent capabilities could not be prepared for Codex.',
          retryable: false,
        });
      codexCapabilityRoots = published.roots;
      for (const root of codexCapabilityRoots) {
        if (
          root.location.type !== 'environment' ||
          root.location.environmentId !== 'local'
        )
          throw new DelegationRunnerError({
            code: 'capability_unavailable',
            message:
              'Selected Agent capabilities could not be prepared for Codex.',
            retryable: false,
          });
        readRoots.push(fileURLToPath(root.location.path));
      }
    }
    const mcp = await this.prepareMcp(session, overlay, stagedRootDir, index);
    // Update the run's policy inputs in place for this overlay.
    session.readRoots.splice(
      0,
      session.readRoots.length,
      ...readRoots,
      ...(session.backgroundTaskDirectory
        ? [session.backgroundTaskDirectory]
        : []),
    );
    session.skillNames.splice(
      0,
      session.skillNames.length,
      ...(capabilities?.claudeSkillNames ?? []),
    );
    session.mcpServerNames.splice(
      0,
      session.mcpServerNames.length,
      ...mcp.names,
    );
    session.instructions.text = [
      delegationProjectionInstructions(session.captured.projection, readRoots),
      session.setupHint,
      delegatedMcpUnavailableGuidance(mcp.unavailable),
    ]
      .filter(Boolean)
      .join('\n\n');
    if (overlay) session.overlay = overlay;
    else delete session.overlay;
    const appTools = createDelegateCanopyTools(
      {
        projectId: parent.projectId,
        worktreeId: parent.worktreeId,
        chatId: parent.chatId,
        delegationId,
        delegationDescription: context.request.task.description,
        delegationDepth: parent.depth + 1,
        provider:
          route.harnessId === 'opencode'
            ? 'opencode'
            : route.harnessId === 'copilot'
              ? 'copilot'
              : route.harnessId === 'cursor'
                ? 'cursor'
                : route.harnessId === 'codex'
                  ? 'codex'
                  : 'claude',
        isolated: session.isolated,
        parentCwd: session.owner.cwd,
        executionCwd: session.cwd,
        codeGraphAvailable: isCodeGraphAvailableForWorkspace(parent.projectId),
        getWindow: this.options.getWindow,
        // A WatchCommand probe is approved like the child's own commands.
        authorizeCommand: (command, callId, signal) =>
          signal?.aborted
            ? Promise.resolve(false)
            : session.tools.authorize('Bash', { command }, callId),
        ...(session.reload
          ? { deferredTools: this.deferredToolsSource(session, session.reload) }
          : {}),
      },
      (tool, readOnly, callId, signal) =>
        session.tools.authorizeAppTool(
          BRAND.tools.namespace,
          tool,
          readOnly,
          callId,
          signal,
        ),
    );
    return {
      appTools,
      claudePlugins,
      claudeSkillNames: capabilities?.claudeSkillNames ?? [],
      codexCapabilityRoots,
      mcpServers: mcp.mcpServers,
      codexMcpServers: mcp.codexMcpServers,
      providerGatedMcpServers: mcp.providerGatedServers,
      unavailableMcp: mcp.unavailable,
    };
  }

  /** Per-run MCP routes for an overlay; unusable servers degrade per server. */
  private async prepareMcp(
    session: DelegationRunSession,
    overlay: MaterializedCapabilityOverlay | undefined,
    stagedRootDir: string | undefined,
    index: number,
  ): Promise<PreparedDelegationMcp> {
    const { context } = session;
    const { parent, route, delegationId } = context.request;
    const capabilities = overlay?.capabilities;
    const empty: PreparedDelegationMcp = {
      mcpServers: {},
      codexMcpServers: {},
      providerGatedServers: [],
      unavailable: [],
      names: [],
    };
    const baseSessionId = `${parent.sessionKey}:delegated:${delegationId}:${context.request.runGeneration}`;
    const mcpSessionId =
      index === 0 ? baseSessionId : `${baseSessionId}:reload-${index}`;
    const proxy = getMcpHttpProxyService();
    const runtime = getCodexRuntimeService();
    // A reload replaces the routes of the previous preparation first.
    if (session.mcpSessionId && session.mcpSessionId !== mcpSessionId) {
      const previous = session.mcpSessionId;
      proxy.unregisterRoutesForSession(previous);
      await runtime.revokeStdioMcpRoutes(previous);
      delete session.mcpSessionId;
    }
    if (!overlay || !capabilities?.mcpSelections.length) return empty;
    if (!stagedRootDir)
      throw new Error('Retained Agent capability directory is missing');
    session.mcpSessionId = mcpSessionId;
    context.retain(
      async () => {
        proxy.unregisterRoutesForSession(mcpSessionId);
        await runtime.revokeStdioMcpRoutes(mcpSessionId);
      },
      { label: 'mcp-session', phase: 'capability', preparation: index },
    );
    const authorizeMcp = async (
      server: string,
      tool: string,
      args: unknown,
      callId: string,
      signal?: AbortSignal,
    ): Promise<boolean> => {
      const gates = session.cursorGates;
      if (gates?.signal.aborted) return false;
      if (gates && !(await session.tools.canUseMcp(server, tool, signal)))
        return false;
      if (gates?.signal.aborted) return false;
      // ACP admits the call to the private transport; its receipt is not an
      // approval grant. Check live mode and rules at execution, exactly once.
      const acpAdmitted = gates?.consumeAllowance(
        gates.pluginCallIdentity(server, tool, args),
      );
      const allowed = await session.tools.authorizeMcp(
        server,
        tool,
        args,
        callId,
        signal,
      );
      if (gates && !acpAdmitted)
        gates.recordGateDecision(
          gates.pluginCallIdentity(server, tool, args),
          allowed ? 'allow' : 'deny',
        );
      return allowed && !gates?.signal.aborted;
    };
    const resolutionOptions: DelegatedMcpResolutionOptions = {
      inheritedPluginProjectPath: session.owner.cwd,
      projectId: parent.projectId,
      worktreeId: parent.worktreeId,
      chatId: parent.chatId,
      sessionId: mcpSessionId,
      stagedRootDir,
      signal: context.signal,
      provider:
        route.harnessId === 'opencode'
          ? 'opencode'
          : route.harnessId === 'copilot'
            ? 'copilot'
            : route.harnessId === 'cursor'
              ? 'cursor'
              : route.harnessId === 'codex'
                ? 'codex'
                : 'claude',
      mcpHttpProxyService: proxy,
      mcpStdioBroker: runtime,
      authorizeToolCall: (server, tool, args, signal): Promise<boolean> =>
        authorizeMcp(server, tool, args, randomUUID(), signal),
    };
    // Agent, assigned and loaded servers resolve together and fail the run
    // only when they cannot run at all (for example transport drift).
    // Inherited servers resolve one by one; one that cannot run is left out.
    const inherited = (index: number): boolean =>
      overlay.provenance.mcpSelections.length ===
        capabilities.mcpSelections.length &&
      overlay.provenance.mcpSelections[index] === 'inherited';
    const only = (
      selections: AgentCapabilitySnapshot['mcpSelections'],
    ): AgentCapabilitySnapshot => ({
      ...capabilities,
      mcpSelections: selections,
    });
    const cancelled = (): DelegationRunnerError =>
      new DelegationRunnerError({
        code: 'route_unavailable',
        message:
          'The managed child was cancelled during capability preparation.',
        retryable: false,
      });
    const resolved = await resolveDelegatedMcpCapabilities(
      only(capabilities.mcpSelections.filter((_, index) => !inherited(index))),
      resolutionOptions,
    ).catch((error: unknown): never => {
      const capability = delegationAgentCapabilityError(error);
      if (context.signal.aborted) throw cancelled();
      if (!capability) throw error;
      throw new DelegationRunnerError({
        code: 'capability_unavailable',
        message: capability.publicMessage,
        retryable: false,
      });
    });
    const merged = {
      mcpServers: { ...resolved.mcpServers },
      codexMcpServers: { ...resolved.codexMcpServers },
      serverNameByProxyUrl: { ...resolved.serverNameByProxyUrl },
      providerGatedServers: [...resolved.providerGatedServers],
      unavailable: [...resolved.unavailable],
    };
    // A plugin resolves as a whole (every server it declares, and none it
    // was not given), so its inherited servers resolve together; each
    // standalone server resolves on its own.
    const inheritedGroups = new Map<
      string,
      AgentCapabilitySnapshot['mcpSelections'][number][]
    >();
    capabilities.mcpSelections.forEach((selection, index) => {
      if (!inherited(index)) return;
      const key =
        selection.source === 'plugin' || selection.source === 'inherited-plugin'
          ? JSON.stringify([selection.marketplaceId, selection.pluginName])
          : String(index);
      inheritedGroups.set(key, [
        ...(inheritedGroups.get(key) ?? []),
        selection,
      ]);
    });
    for (const selections of Array.from(inheritedGroups.values())) {
      let optional: Awaited<ReturnType<typeof resolveDelegatedMcpCapabilities>>;
      try {
        optional = await resolveDelegatedMcpCapabilities(
          only(selections),
          resolutionOptions,
        );
      } catch (error) {
        if (context.signal.aborted) throw cancelled();
        const capability = delegationAgentCapabilityError(error);
        if (!capability) throw error;
        // Materialized at spawn but unusable now (for example its transport
        // changed): report it instead of dropping it silently.
        for (const selection of selections)
          merged.unavailable.push({
            name: mcpSelectionName(overlay, selection),
            reason: 'unavailable',
          });
        continue;
      }
      const names = Object.keys(
        route.harnessId === 'codex'
          ? optional.codexMcpServers
          : optional.mcpServers,
      );
      if (
        names.some(
          (name) => name in merged.mcpServers || name in merged.codexMcpServers,
        )
      )
        continue;
      Object.assign(merged.mcpServers, optional.mcpServers);
      Object.assign(merged.codexMcpServers, optional.codexMcpServers);
      Object.assign(merged.serverNameByProxyUrl, optional.serverNameByProxyUrl);
      merged.providerGatedServers.push(...optional.providerGatedServers);
      merged.unavailable.push(...optional.unavailable);
    }
    const names = Object.keys(
      route.harnessId === 'codex' ? merged.codexMcpServers : merged.mcpServers,
    );
    proxy.setSessionToolCallGate(mcpSessionId, (call) => {
      const server = merged.serverNameByProxyUrl[call.proxyUrl];
      return server
        ? authorizeMcp(
            server,
            call.tool,
            call.args,
            call.requestId ?? randomUUID(),
          )
        : Promise.resolve(false);
    });
    this.recordUnavailableMcp(session, merged.unavailable);
    return {
      mcpServers: merged.mcpServers,
      codexMcpServers: merged.codexMcpServers,
      providerGatedServers: Array.from(new Set(merged.providerGatedServers)),
      unavailable: merged.unavailable,
      names,
    };
  }

  /** Content-free session diagnostic for each degraded MCP server. */
  private recordUnavailableMcp(
    session: DelegationRunSession,
    unavailable: readonly DelegatedMcpUnavailable[],
  ): void {
    if (!unavailable.length) return;
    const { parent, route } = session.context.request;
    try {
      const observability = getObservabilityService();
      for (const entry of unavailable)
        observability.recordSessionDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'managed_delegation',
          sessionKey: parent.sessionKey,
          projectId: parent.projectId,
          worktreeId: parent.worktreeId,
          chatId: parent.chatId,
          providerType:
            route.harnessId === 'opencode'
              ? 'opencode'
              : route.harnessId === 'copilot'
                ? 'copilot'
                : route.harnessId === 'cursor'
                  ? 'cursor'
                  : route.harnessId === 'codex'
                    ? 'codex'
                    : 'claude',
          // The reason only: server names can carry user content.
          lastEventType: `delegated_mcp_unavailable:${entry.reason}`,
        });
    } catch {
      // Diagnostics are best effort and never fail a delegated run.
    }
  }

  /** Search/Load Deferred Tools for a child: gated live on every call. */
  private deferredToolsSource(
    session: DelegationRunSession,
    reload: DelegationCapabilityReloadController,
  ): DelegateDeferredToolsSource {
    const { parent, route, delegationId } = session.context.request;
    return createDelegateDeferredToolsSource({
      scope: {
        projectId: parent.projectId,
        worktreeId: parent.worktreeId,
        chatId: `delegation-${delegationId}`,
      },
      providerType: route.harnessId === 'codex' ? 'codex' : 'claude',
      pluginSelections: () => overlaySelections(session.overlay),
      rootDeferredToolsAllowed: () =>
        this.options.owner(parent)?.deferredToolsAllowed,
      grantDiscovery: () =>
        this.options.capabilityContext?.(delegationId)?.grant?.discovery ===
        true,
      reload,
    });
  }

  /**
   * Commit a Load to the grant and re-prepare the run with the new overlay.
   * The new overlay is staged and its routes registered before the grant is
   * extended, so an item that cannot run is never recorded as loaded.
   */
  private reloadHost<P>(
    session: DelegationRunSession,
    build: (capabilities: PreparedDelegationCapabilityRuntime) => P,
  ): DelegationCapabilityReloadHost<P> {
    const { route, delegationId, runGeneration } = session.context.request;
    const harness = route.harnessId === 'codex' ? 'codex' : 'claude';
    // Reasons for requested items a successful apply skipped, by reload.
    const partial = new Map<string, readonly string[]>();
    return {
      skipped: (reload): readonly string[] => {
        const reasons = partial.get(reload.reloadId) ?? [];
        partial.delete(reload.reloadId);
        return reasons;
      },
      apply: async (reload, signal): Promise<P> => {
        const extend = this.options.extendCapabilityGrant;
        const grant = this.options.capabilityContext?.(delegationId)?.grant;
        if (!extend || !grant)
          throw new DelegationCapabilityReloadFailure(
            'This delegated task cannot load capabilities.',
          );
        const current = session.overlay;
        session.restoreOverlay = current;
        const home = selectHomeCapabilityOverlay(current);
        if (
          current &&
          !current.items.length &&
          !isEmptyOverlay(current) &&
          !isHomeOnlyCapabilityOverlay(current, home)
        )
          throw new DelegationCapabilityReloadFailure(
            "This delegate's retained Agent capabilities cannot be extended. Start a new delegation to use more capabilities.",
          );
        const base = {
          mcpHttpAuthPreferences: [
            ...(current?.capabilities.mcpHttpAuthPreferences ?? []),
          ],
        };
        const layers: DelegationCapabilityLayer[] = [];
        for (const source of [
          'agent',
          'explicit',
          'inherited',
          'loaded',
        ] as const) {
          const refs = (current?.items ?? [])
            .filter((item) => item.source === source)
            .map((item) => item.ref);
          if (refs.length)
            layers.push({ source, selections: selectionsFromRefs(refs, base) });
        }
        const loadedLayer: DelegationCapabilityLayer = {
          source: 'loaded',
          selections: {
            collectionIds: [],
            skillRefs: [...reload.additions.skillRefs],
            pluginRefs: [...reload.additions.pluginRefs],
            mcpServerRefs: [...reload.additions.mcpServerRefs],
            ...(base.mcpHttpAuthPreferences.length ? base : {}),
          },
        };
        const materialized = await materializeDelegationCapabilities(
          [...layers, loadedLayer],
          (directory) => openDelegationFiles(directory, signal),
          harness,
          { cache: this.capabilityCache },
        );
        signal.throwIfAborted();
        const previousIds = new Set(
          (current?.items ?? []).map((item) => item.id),
        );
        const added = materialized.included.filter(
          (item) => item.source === 'loaded' && !previousIds.has(item.id),
        );
        const skippedLoaded = materialized.skipped.filter(
          (item) => item.source === 'loaded',
        );
        const refused = skippedLoaded[0];
        if (!added.length)
          throw refused
            ? new DelegationAgentCapabilityError(refused.reason, {
                kind: refused.kind,
                name: refused.name,
              })
            : new DelegationCapabilityReloadFailure(
                'None of the requested items could be enabled.',
              );
        const skippedHome: RetainedHomeCapability[] = [];
        const combined = mergeHomeCapabilityOverlay(
          {
            pluginFiles: materialized.files,
            capabilities: materialized.capabilities,
            provenance: materialized.provenance,
            items: materialized.included.map((item) =>
              Object.freeze({
                id: item.id,
                name: delegationCapabilityDisplayName(item.name),
                source: item.source,
                ref: item.ref,
              }),
            ),
          },
          home,
          (entry) => {
            skippedHome.push(entry);
          },
        );
        if (!combined)
          throw new DelegationCapabilityReloadFailure(
            'No capabilities could be retained.',
          );
        const snapshot = await this.artifacts.retainCapabilityOverlay(combined);
        // Launch consumes the bytes read back from the retained artifact.
        const overlay = await this.artifacts.loadCapabilityOverlay(snapshot);
        const previousSelections = new Set(
          (current?.capabilities.mcpSelections ?? []).map((selection) =>
            JSON.stringify(selection),
          ),
        );
        const prepared = await this.prepareCapabilities(session, overlay);
        const newlyUnavailable = prepared.unavailableMcp.filter((entry) =>
          overlay.capabilities.mcpSelections.some(
            (selection, index) =>
              overlay.provenance.mcpSelections[index] === 'loaded' &&
              !previousSelections.has(JSON.stringify(selection)) &&
              mcpSelectionName(overlay, selection) === entry.name,
          ),
        );
        if (newlyUnavailable[0])
          throw new DelegationCapabilityReloadFailure(
            `${newlyUnavailable[0].name} is unavailable (${unavailableReasonText(newlyUnavailable[0].reason)}).`,
          );
        signal.throwIfAborted();
        const extended = await extend({
          delegationId,
          runGeneration,
          loaded: added.map((item) => item.id),
          capabilityOverlay: snapshot,
          overlayHash: snapshot.capabilityProjectionHash,
          summary: summarizeDelegationCapabilities({
            inherit: grant.inherit,
            discovery: grant.discovery,
            items: [
              ...materialized.included.map((item) => ({
                kind: item.kind,
                name: item.name,
                source: item.source,
              })),
              ...(combined.homeEntries ?? []).map((entry) => ({
                kind:
                  entry.kind === 'plugin'
                    ? ('plugin' as const)
                    : ('skill' as const),
                name: entry.name,
                source: 'inherited' as const,
              })),
            ],
            skipped: [
              ...grant.summary.skipped,
              ...skippedHome.map((entry) => ({
                kind:
                  entry.kind === 'plugin'
                    ? ('plugin' as const)
                    : ('skill' as const),
                name: entry.name,
                reason: 'unavailable_asset' as const,
              })),
              ...skippedLoaded.map((item) => ({
                kind: item.kind,
                name: item.name,
                reason: delegationCapabilitySkipReason(item.reason),
              })),
            ],
          }),
        });
        if (!extended.ok)
          throw new DelegationCapabilityReloadFailure(
            extensionRefusalText(extended.reason),
          );
        // The retained route now references the new overlay; keep the
        // captured invocation current so follow-ups keep launch authority.
        const routeId = session.captured.route.routeId;
        if (routeId && this.captured.get(routeId) === session.captured) {
          session.captured = {
            ...session.captured,
            route: extended.route,
            capabilities: overlay,
          };
          this.captured.set(routeId, session.captured);
        }
        if (skippedLoaded.length)
          partial.set(
            reload.reloadId,
            skippedLoaded.map(
              (item) =>
                new DelegationAgentCapabilityError(item.reason, {
                  kind: item.kind,
                  name: item.name,
                }).publicMessage,
            ),
          );
        return build(prepared);
      },
      restore: async (_reload, signal): Promise<P> => {
        signal.throwIfAborted();
        return build(
          await this.prepareCapabilities(session, session.restoreOverlay),
        );
      },
    };
  }

  private async authorized(
    owner: AgentSessionOptions,
    route: ResolvedAgentRouteSnapshot,
    captured: Pick<
      CapturedInvocation,
      'authGeneration' | 'environmentFingerprint'
    >,
  ): Promise<boolean> {
    return isDelegationRouteAuthorized({
      owner,
      route,
      captured,
      authGeneration: this.options.authGeneration,
    });
  }
}
