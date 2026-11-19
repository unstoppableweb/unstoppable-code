import { getAttentionTracker } from '../services/attention-tracker';
import { isAgentSecretRequestsEnabled } from '../agent-secrets/feature-gate';
import {
  PIPELINE_EDITOR_TOOL_REGISTRY,
  type PipelineEditorToolKey,
} from '@canopy/desktop-shared/lib/pipeline-editor-tools';
import { CURSOR_PLAN_MODE_STEERING } from '@canopy/desktop-shared/node/cursor/headless-policy';
import { extractProposedPlan } from '@canopy/execution-engine/codex-plan-mode';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  type PlanExitRequestEvent,
} from '@canopy/desktop-shared/types';
import { commitPendingPlanExit } from '../services/chat-state-plan-exit';
import { chatVisualsPromptEligible } from '../lib/chat-visuals-feature-flag';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { randomUUID } from 'node:crypto';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { assertCursorHarnessEnabled } from '../cursor/feature-flag';
import {
  getRawCursorModelId,
  isCursorModel,
} from '@canopy/execution-engine/lib/cursor-models';
import type { BrowserWindow } from 'electron';
import type { AgentInterfacePort } from './agent-interface-port';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_TOOL_REGISTRY,
  type AppAdvisorToolKey,
} from '@canopy/desktop-shared/lib/app-advisor-tools';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  type CanopyInjectedToolKey,
} from '@canopy/execution-engine/lib/canopy-injected-tools';
import {
  cursorCanopyMcpServerNames,
  parseCursorMcpToolCall,
  resolveCursorCanopyToolKey,
  type CursorCanopyServerMode,
  type CursorCanopyToolSurface,
} from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import {
  createPreviewVisualTracker,
  projectPreviewVisualResult,
} from '@canopy/desktop-shared/lib/preview-visual-projection';

function isEventRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
import {
  getCursorModelEntries,
  getEffectiveSupportedThinkingLevelsForModel,
  hasAnySelections,
  initCursorModels,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalMode,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import type { AgentProvider, AgentSession, AgentSessionOptions } from './types';
import { CursorEventBuffer } from './cursor-event-buffer';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  runCursorTurn,
  type CursorTurnGates,
  type CursorTurnMcpSetup,
} from '@canopy/desktop-shared/node/cursor/turn-driver';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
} from './provider-turn-lifecycle';
import {
  authorizeCursorMcpTool,
  authorizeCursorTool,
} from '../cursor/tool-approval';
import { buildCursorMcpServers } from '../cursor/mcp-servers';
import {
  recordCursorMcpCapabilities,
  resolveMcpExecutable,
} from '../cursor/mcp-executable';
import { getManagedCursorRuntime } from '../cursor/connection';
import { cursorDataPolicyMessage } from '../cursor/model-data-policy';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import type { TurnBinding } from '@canopy/protocol/canopy-core';
import {
  buildCoworkInjectedToolPrompt,
  buildLedgerPlanModeInstruction,
  buildWorktreeInjectedToolPrompt,
} from '../canopy-tools/prompting';
import {
  mayExposeLedgerTools,
  openLedgerChatTools,
  type LedgerChatSettings,
  type LedgerChatTarget,
  type LedgerChatToolsSession,
} from '../canopy-tools/ledger-tools-runtime';
import { buildLocalMemoryPromptNudge } from '../lib/cowork-chat-system-prompt';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
import {
  emptyCursorCapabilityProjection,
  expandLeadingCursorCommand,
  type CursorCapabilityProjection,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeCursorCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { requestChatTombstones } from '../plugins/request-chat-tombstones';
import { resolvePlugins } from '../plugins/plugin-resolver';
import {
  discoverInheritedCursorCapabilities,
  emptyInheritedCursorCapabilities,
} from '@canopy/desktop-shared/node/cursor/inherited-capabilities';
import { resolveInheritedCursorRoots } from '../cursor/inherited-roots';
import { inheritedClaudePluginRefs } from '../plugins/inherited-cursor-plugins';
import { readClaudeEnabledPlugins } from '../plugins/claude-enabled-plugins';
import { loadMarketplacesCacheOnly } from '../plugins/plugin-service';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { verifyCursorVersion } from '../cursor/approval-check';
import type { CursorProviderProcess } from '@canopy/desktop-shared/node/cursor/runtime-process';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';
import { cursorProcessForWorkerRun } from '../agent-runs/cursor-worker-runtime';
import { CursorForkContext } from '../cursor/fork-context';
import { getWorktreeDataDir } from '../lib/paths';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { getCursorRuntimeTargetForHost } from '@canopy/desktop-shared/node/cursor/runtime-metadata';
import { readPreferencesFile } from '../lib/preferences-store';
import {
  isTrustedCursorShowVisualInvocation,
  openTurnLedger,
  type TurnVisualLedger,
} from '../services/visual-tool-identity';
import {
  getBundledRtkBinaryPath,
  getEnhancedEnv,
  getRtkManagedEnv,
} from '../pipelines/config-paths';
import {
  buildSessionKey,
  drainChatSessionEvents,
  registerSession,
} from './session-manager';
import { observeRoutedTurnBinding } from './session-event-router';
import { createOwnedTurnState } from './owned-turn-state';

/**
 * Fingerprint of the user's home-folder skills and commands the last Cursor
 * turn saw. A changed set rebuilds the slash-menu inventory, so a skill
 * installed through the Cursor CLI appears in the menu after the next
 * message rather than the next app start.
 */
let lastInheritedFingerprint: string | undefined;

function isAppAdvisorToolKey(key: string): key is AppAdvisorToolKey {
  return Object.prototype.hasOwnProperty.call(APP_ADVISOR_TOOL_REGISTRY, key);
}

function isPipelineEditorToolKey(key: string): key is PipelineEditorToolKey {
  return Object.prototype.hasOwnProperty.call(
    PIPELINE_EDITOR_TOOL_REGISTRY,
    key,
  );
}

function isCanopyInjectedToolKey(key: string): key is CanopyInjectedToolKey {
  return Object.prototype.hasOwnProperty.call(
    CANOPY_INJECTED_TOOL_REGISTRY,
    key,
  );
}

/**
 * How long a turn waits for the pre-turn catalog discovery before running
 * with the variant's own parameters. Longer than the 2 s startup race so
 * the first turn after a restart usually runs at the level the chip shows,
 * still far below the 45 s discovery deadline; Stop ends the wait at once.
 */
const PRE_TURN_DISCOVERY_WAIT_MS = 10_000;

// SessionManager creates one CursorProvider per chat. Keep this attempt flag
// at module scope so an unknown model does not re-discover in every chat.
let preTurnDiscoveryAttempted = false;

export function resetCursorPreTurnDiscoveryForTests(): void {
  preTurnDiscoveryAttempted = false;
}

function waitForAbortOrTimeout(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    function finish(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
    signal.addEventListener('abort', finish, { once: true });
  });
}

/** Opt-in interactive ACP provider. Every turn owns and drains its process group. */
export class CursorProvider implements AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (data: unknown) => void | Promise<void>,
    interfacePort: AgentInterfacePort,
  ): AgentSession {
    assertAgentWorkerContext('CursorProvider.createSession');
    const getWindow = (): BrowserWindow | null => interfacePort.legacyWindow();
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const lifecycleScope = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    const lifecycleProducer = getTurnLifecycleProducer(
      'cursor',
      lifecycleScope,
    );
    const turnState = createOwnedTurnState(key, () => session);
    const lifetime = new AbortController();
    let active: { abort: AbortController; done: Promise<void> } | undefined;
    let output: CursorEventBuffer | undefined;
    let managedDelegation: ManagedDelegationSession | undefined;
    let currentTurn: string | undefined;
    // Match Codex's Pipeline Assistant policy: persisted chats reopen with a
    // fresh native session. Later turns in this live instance may reuse it.
    let sessionId =
      opts.assistantMode === 'pipeline-editor' ? undefined : opts.sdkSessionId;
    let awaitingUser = false;
    let lifecycleProducerReleased = false;
    const forkContext = new CursorForkContext(opts);
    let selectedModel = opts.model;
    // Like the model, a level chosen during a turn applies to the next one.
    let thinkingLevel: ThinkingLevel | undefined = opts.thinkingLevel;
    let approvalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    let planMode = opts.planMode === true;
    // Cursor-specific notices are shown once per session, not on every turn.
    const announcedNotices = new Set<string>();
    // Same preference as the Claude PreToolUse hook; chat.ts forwards it and
    // keeps it current through setRtkEnabled.
    let rtkEnabled = opts.rtkEnabled !== false;
    let approval: ApprovalSessionHandle | undefined;
    // One live list: the approval session adds grants to it, and managed
    // delegates evaluate their approvals against it.
    const sessionRules = opts.sessionApprovalRules ?? [];
    lifetime.signal.addEventListener('abort', () => active?.abort.abort(), {
      once: true,
    });
    // The chat's Ledger tools. The exposure gate runs once per session, when
    // a turn first creates the app's MCP route: the tool list is part of the
    // ACP session's capabilities, as for a Codex thread, so a later turn
    // never adds or drops the tools and each call re-checks the flag and the
    // setting instead. App Advisor sessions carry the App Advisor tool set.
    const ledgerTarget: LedgerChatTarget = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
      ...(opts.assistantMode ? { assistantMode: opts.assistantMode } : {}),
    };
    const ledger: { decided: boolean; tools: LedgerChatToolsSession | null } = {
      decided: false,
      tools: null,
    };
    // An entry's author details: the settings the current turn runs with.
    let ledgerSettings: LedgerChatSettings = {
      model: selectedModel ?? null,
      thinkingEffort: null,
      planMode,
    };
    lifetime.signal.addEventListener(
      'abort',
      () => {
        ledger.tools?.dispose();
        ledger.tools = null;
      },
      { once: true },
    );

    function emit(
      data: Record<string, unknown>,
      userMessageId?: string,
    ): void | Promise<void> {
      if (
        awaitingUser &&
        data.type !== 'result' &&
        data.type !== 'error' &&
        currentTurn
      ) {
        awaitingUser = false;
        lifecycleProducer.sessionState({
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          state: 'running',
          source: 'provider',
          observedDuringTurnId: currentTurn,
        });
      }
      const event = {
        ...data,
        provider: 'cursor',
        ...(userMessageId
          ? { canopy_turn_user_message_id: userMessageId }
          : {}),
      };
      managedDelegation?.observe(event, userMessageId);
      turnState.recordSessionEvent(event);
      if (output && data.type !== 'result' && data.type !== 'error')
        return output.push(event);
      return onEvent(event);
    }

    async function run(
      text: string,
      abort: AbortController,
      visualLedger: TurnVisualLedger,
      userMessageId?: string,
    ): Promise<Record<string, unknown>> {
      const startedInPlanMode = planMode;
      const previewToolIds = new Set<string>();
      const previewTracker = createPreviewVisualTracker();
      let appRouteAvailable = false;
      const hostTurnId = currentTurn;
      if (!managedDelegation && managedDelegationEnabled(opts)) {
        // Defer the local delegation service until a Cursor turn needs it, so
        // its agent runtime graph stays off the main-process startup path.
        const { createManagedDelegationSession } =
          await import('./delegation/service');
        const created = await createManagedDelegationSession({
          harness: 'cursor',
          sessionKey: key,
          getWindow,
          currentTurn: () => currentTurn,
          currentOptions: () => ({
            ...opts,
            model: selectedModel,
            selectedModel,
            thinkingLevel,
            approvalMode,
            planMode,
            sessionApprovalRules: sessionRules,
          }),
          onTranscript: (delegation, options) => {
            void Promise.resolve(
              emit(
                {
                  type: 'canopy_delegation',
                  delegation,
                  ...(options?.replay ? { canopy_replay: true } : {}),
                },
                delegation.parentTurnId,
              ),
            ).catch((error: unknown) =>
              logMainProcessWarn(
                '[cursor-session] Delegation transcript delivery failed',
                error,
              ),
            );
          },
        });
        // A session destroyed while this attached must not stay attached to
        // its chat's delegation tree.
        if (lifetime.signal.aborted) created.detach();
        else managedDelegation = created;
      }
      // Model picks update the next turn; this turn keeps its selection through
      // initialization, streaming, and transcript metadata emission.
      const turnModel = selectedModel;
      // The composer shows the effort control only when discovery described
      // this variant's thinking support. Forward the chat's level under the
      // same condition, so a turn never runs at a level the user could not
      // see; otherwise the variant's own parameters apply, as for pipelines.
      // Support lives in main's in-memory Cursor catalog, which restarts
      // empty until a picker or setup refreshes it, so the first turn that
      // finds no entry describing its variant discovers first: bounded, ended
      // early by Stop, attempted once per app run, and left to finish in the
      // background so the published result restores the composer control.
      let turnThinkingLevel: ThinkingLevel | undefined;
      if (thinkingLevel !== undefined && turnModel !== undefined) {
        if (
          !preTurnDiscoveryAttempted &&
          !getCursorModelEntries().some(
            (entry) =>
              entry.id === turnModel &&
              entry.supportedThinkingLevels !== undefined,
          )
        ) {
          preTurnDiscoveryAttempted = true;
          // Deferred like the picker path: the discovery module carries the
          // ACP/installer graph, which stays off the desktop startup path.
          const { listCursorModels } = await import('../cursor/models');
          const { CursorModelAuthenticationError } =
            await import('../cursor/model-discovery-error');
          const discovery = listCursorModels().then(
            (models) => {
              initCursorModels(models);
              broadcastModelRegistryUpdated();
            },
            (error: unknown) => {
              // A confirmed sign-out revokes the catalog like the picker path;
              // a transient failure keeps the last published one.
              if (error instanceof CursorModelAuthenticationError) {
                initCursorModels([]);
                broadcastModelRegistryUpdated();
              }
            },
          );
          await Promise.race([
            discovery,
            waitForAbortOrTimeout(PRE_TURN_DISCOVERY_WAIT_MS, abort.signal),
          ]);
        }
        // Forward the level the composer shows: clamped to the catalog's
        // declared set, so the driver can treat a different live outcome as
        // a failure instead of quietly running elsewhere.
        const supported = getEffectiveSupportedThinkingLevelsForModel(
          turnModel,
          false,
          'cursor',
          'cursor',
        );
        if (supported.length > 0)
          turnThinkingLevel = clampThinkingLevelToDeclared(
            thinkingLevel,
            supported,
          );
      }
      ledgerSettings = {
        model: turnModel ?? null,
        thinkingEffort: turnThinkingLevel ?? null,
        planMode,
      };
      const proxy = getMcpHttpProxyService();
      let routeRegistered = false;
      const emitTurn = (
        event: Record<string, unknown>,
      ): void | Promise<void> => {
        const trustedIds = Array.isArray(event.patches)
          ? event.patches.flatMap((patch: unknown): string[] => {
              if (
                typeof patch !== 'object' ||
                patch === null ||
                !('block' in patch) ||
                typeof patch.block !== 'object' ||
                patch.block === null ||
                !('toolUseId' in patch.block) ||
                typeof patch.block.toolUseId !== 'string'
              )
                return [];
              return previewToolIds.has(patch.block.toolUseId)
                ? [patch.block.toolUseId]
                : [];
            })
          : [];
        const projected = projectPreviewVisualResult(
          {
            ...event,
            provider: 'cursor',
            canopyTrustedPreviewToolIds: trustedIds,
          },
          previewTracker,
        );
        return emit(
          isEventRecord(projected) ? projected : event,
          userMessageId,
        );
      };
      try {
        // A failed initialization is still a new attempt; do not leave the
        // previous response's counters beside its error.
        await emitTurn({ type: 'canopy_cursor_usage', usage: null });
        assertCursorHarnessEnabled();
        if (!getCursorRuntimeTargetForHost())
          throw new Error('Cursor chat is not available on this device.');
        const rawModelId = getRawCursorModelId(turnModel ?? '');
        if (!rawModelId || opts.aiCreditsRouting?.active)
          throw new Error(
            'Choose a Cursor model to use Cursor account billing.',
          );
        // Assistants use their owning runtime and isolated proxy tool set.
        const assistantMode = opts.assistantMode ?? 'default';
        const serverMode: CursorCanopyServerMode =
          assistantMode === 'app-advisor' && opts.appAdvisorRuntime
            ? 'app-advisor'
            : assistantMode === 'pipeline-editor' && opts.pipelineEditorRuntime
              ? 'pipeline-editor'
              : 'default';
        if (assistantMode !== 'default' && serverMode === 'default')
          throw new Error(
            'Cursor is not available for this assistant surface.',
          );
        const appAdvisorRuntime =
          serverMode === 'app-advisor' ? opts.appAdvisorRuntime : undefined;
        // Cowork chats run directory-scoped: the route advertises the Cowork
        // tool set (no git, GitHub-run, or base-branch tools; GetScriptOutput
        // stays for watcher output) and the steering below describes exactly
        // that set. Same server names, so remembered rules stay shared with
        // Claude Cowork chats.
        const cowork = isCoworkWorkspace(opts.projectId);
        const toolSurface: CursorCanopyToolSurface = cowork
          ? 'cursor-acp-standalone'
          : 'cursor-acp';
        const preferences = await readPreferencesFile();
        if (!preferences.cursorEnabled)
          throw new Error('Connect Cursor in Settings to start chatting.');
        const profileId = createHash('sha256')
          .update(JSON.stringify([key, opts.cwd]))
          .digest('hex');
        // Lives under the worktree's data directory so deleting the worktree
        // removes the CLI conversation state with everything else it owned. A
        // legacy standalone-chat sentinel is translated to the Cowork
        // workspace it borrows first, so the profile stays inside that
        // workspace and is removed with it.
        // Only that sentinel is translated: the plan-explore and code-review
        // sentinels keep their own profile location so their cleanup paths
        // still find it if they ever run Cursor.
        const profileTarget = (opts.projectId === STANDALONE_CHAT_PROJECT_ID
          ? resolveWorktreeTargetIds(opts.projectId, opts.worktreeId)
          : null) ?? { projectId: opts.projectId, worktreeId: opts.worktreeId };
        const profile = join(
          getWorktreeDataDir(profileTarget.projectId, profileTarget.worktreeId),
          'cursor-sessions',
          profileId,
        );
        // The chat's own home directory. The CLI discovers skills and
        // commands under `~/.cursor`, and this is what keeps one chat's
        // selection out of another's session. Sign-in and caches stay shared
        // (see prepareCursorRuntimeEnvironment); it dies with the worktree.
        const chatHome = join(profile, 'home');
        const managed = await getManagedCursorRuntime(
          abort.signal,
          {
            runtime: 'agent',
            workspaceId: opts.projectId,
          },
          { homeOverlay: chatHome },
        );
        const { launch, target } = managed;
        const env = {
          ...managed.env,
          NO_OPEN_BROWSER: '1',
        };
        // Packaged Electron disables RunAsNode. The managed archive's verified
        // Node executable runs approval hooks without starting another app.
        const hookRuntime = join(dirname(launch.command), target.hookRuntime);
        // CAN-4118: the CLI and its probe are children of the provider process host.
        const providerProcess: CursorProviderProcess =
          cursorProcessForWorkerRun('CursorSession.run');
        await verifyCursorVersion(providerProcess, launch, env, abort.signal);
        abort.signal.throwIfAborted();
        const currentApproval = createApprovalSession({
          sessionKey: key,
          getTurnUserMessageId: () => userMessageId,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          provider: 'cursor',
          workspaceRoot: opts.cwd,
          mode: approvalMode,
          sessionRules,
          getWindow,
          promptTimeoutMs: 60_000,
        });
        approval = currentApproval;
        // RTK runs as a helper of the host, not of the Cursor child: it needs
        // the login-shell PATH and the managed RTK state dirs, never the
        // chat's secrets.
        const rtkBinaryPath = getBundledRtkBinaryPath();
        const rtkEnv = {
          ...getEnhancedEnv({
            includeCanopySecrets: false,
            environment: false,
          }),
          ...getRtkManagedEnv(),
        };
        // The complete MCP selection is resolved once per turn: each turn owns
        // one CLI process, so session/new or session/load below always carries
        // the full current set and there is nothing to reconcile mid-turn.
        // Cursor layers Claude Code's plugins on top of the selection below,
        // so it needs the chat's opt-outs even when no default layer applies.
        const pluginContext = await resolveEffectiveChatPluginContext(
          opts.pluginSelections,
          opts,
          requestChatTombstones(opts.applyGlobalPluginDefaults),
        );
        // Limits specific to Cursor: a selection the other providers load but
        // Cursor cannot, or a server it cannot run. Shown once per session,
        // not per turn. Problems every provider shares go to the console,
        // exactly as the Claude and Codex sessions report them.
        const cursorLimitNotices: string[] = [];
        // The user's own home-folder skills and commands, the way a Claude or
        // Codex chat reads its native configuration (design:
        // 2026-10-05-cursor-inherited-capabilities). A broken home folder
        // must not stop the chat: a failed discovery inherits nothing.
        const inheritedRoots = resolveInheritedCursorRoots();
        let inherited = emptyInheritedCursorCapabilities();
        try {
          inherited = await discoverInheritedCursorCapabilities(inheritedRoots);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error(
            '[cursor-inherited-capabilities] discovery failed:',
            error,
          );
        }
        for (const entry of inherited.skipped) {
          // eslint-disable-next-line no-console
          console.warn(
            '[cursor-inherited-capabilities]',
            `${entry.label}: ${entry.reason}`,
          );
        }
        if (inherited.skipped.length > 0)
          cursorLimitNotices.push(
            `Some of your Cursor skills or commands could not be loaded: ${inherited.skipped
              .map((entry) => entry.label)
              .join(', ')}.`,
          );
        if (inherited.fingerprint !== lastInheritedFingerprint) {
          lastInheritedFingerprint = inherited.fingerprint;
          refreshInvocableInventoryAfterMutation(
            'cursor-inherited-capabilities',
          );
        }
        // Plugins enabled in Claude Code join resolution as inherited refs,
        // each read from the folder Claude Code installed, so their MCP
        // servers keep going through the proxy and approvals.
        const marketplaces = await loadMarketplacesCacheOnly()
          .then((result) =>
            result.success && result.data ? result.data.marketplaces : [],
          )
          .catch(() => []);
        // They ride as a resolver option rather than joining `selections`:
        // the resolver appends them after the selection AND its Collections,
        // the order the inventory numbers colliding ids in, so a Collection
        // member the user picked keeps its id over an inherited plugin's.
        const inheritedPluginRefs = inheritedClaudePluginRefs(
          marketplaces,
          pluginContext.selections,
          pluginContext.chatTombstones,
          // Claude Code plugins installed for one repository count only in
          // a chat working in that repository.
          readClaudeEnabledPlugins(inheritedRoots.claudeConfigDir, opts.cwd),
          (await readInstalledItemPolicy(pluginContext.preferences))
            .disabledPluginRefs,
        );
        const selections = pluginContext.selections;
        const hasInherited =
          inherited.skills.length > 0 ||
          inherited.commands.length > 0 ||
          inheritedPluginRefs.length > 0;
        let resolvedMcpServers: Record<string, unknown> = {};
        let cursorCapabilities: CursorCapabilityProjection =
          emptyCursorCapabilityProjection();
        let resolutionFailure: string | undefined;
        if (
          hasAnySelections(selections) ||
          hasInherited ||
          opts.packageOverlay
        ) {
          try {
            const resolved = await resolvePlugins(
              selections,
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
              {
                purpose: 'cursor-session',
                installExternalPlugins: true,
                enableHttpMcpProxy: true,
                mcpHttpProxyService: proxy,
                sessionId: key,
                inheritedCursorCapabilities: inherited,
                ...(inheritedPluginRefs.length > 0
                  ? { inheritedPluginRefs }
                  : {}),
                ...(opts.packageOverlay
                  ? { packageOverlay: opts.packageOverlay }
                  : {}),
                ...(opts.accountResolution
                  ? { accountResolution: opts.accountResolution }
                  : {}),
                ...(pluginContext.preferences
                  ? { preferences: pluginContext.preferences }
                  : {}),
              },
            );
            resolvedMcpServers = resolved.mcpServers;
            cursorLimitNotices.push(...resolved.cursorNotices);
            cursorCapabilities = resolved.cursorCapabilities;
            for (const warning of resolved.warnings) {
              // eslint-disable-next-line no-console
              console.warn('[cursor-plugin-resolver]', warning);
            }
          } catch (error) {
            resolutionFailure = `Selected plugins and MCP servers could not be resolved for this turn: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        }
        abort.signal.throwIfAborted();
        // Rebuilt every turn to exactly this selection — an empty one too, so
        // nothing a previous selection (or the CLI) left under ~/.cursor
        // reaches this turn. What the CLI then advertises is checked against
        // these ids once the session is up.
        // A root that cannot be prepared at all fails the turn, like the
        // private environment it lives in: running anyway would hand the CLI
        // whatever the last turn left there.
        const invocableLabels = new Map<string, string>();
        const root = await materializeCursorCapabilityRoot(
          chatHome,
          cursorCapabilities,
        );
        cursorLimitNotices.push(...root.warnings);
        for (const warning of root.warnings) {
          // eslint-disable-next-line no-console
          console.warn('[cursor-capability-root]', warning);
        }
        for (const skill of cursorCapabilities.skills)
          if (root.skillIds.includes(skill.id) && skill.userInvocable !== false)
            invocableLabels.set(skill.id, skill.label);
        for (const command of cursorCapabilities.commands)
          if (root.commandIds.includes(command.id))
            invocableLabels.set(command.id, command.label);
        const unannounced = (notices: readonly string[]): string[] => {
          const fresh = notices.filter((note) => !announcedNotices.has(note));
          for (const note of fresh) announcedNotices.add(note);
          return fresh;
        };
        // The CLI advertises its command and skill set right after the
        // session exists, which can be before or after `beforePrompt` runs;
        // whichever comes second performs the comparison.
        let advertised: string[] | undefined;
        let announceLater: ((text: string) => void) | undefined;
        const reportUnloaded = (): void => {
          if (!advertised || !announceLater) return;
          const names = new Set(advertised);
          // Reported once per id for the session, not once per combination:
          // a later turn that misses one more id names only the new one.
          // ACP advertises slash commands, not model-only skills.
          const missing = Array.from(invocableLabels)
            .filter(([id]) => !names.has(id))
            .filter(([id]) => unannounced([`unloaded:${id}`]).length > 0)
            .map(([id, label]) => `${label} (/${id})`);
          if (missing.length === 0) return;
          announceLater(`Cursor did not load: ${missing.join(', ')}.\n\n`);
        };
        // A command the user leads with is expanded here: the driver sends the
        // instructions before the text, so the CLI's own leading-command
        // parser would never see it. Only materialized ids expand.
        const promptText = expandLeadingCursorCommand(
          text,
          cursorCapabilities.commands.filter((command) =>
            invocableLabels.has(command.id),
          ),
        );
        const outcome = await runCursorTurn(
          {
            cwd: opts.cwd,
            text:
              managedDelegation?.applyPolicyGuidance(promptText) ?? promptText,
            launch,
            providerProcess,
            env,
            hookRuntime,
            profileDir: profile,
            rawModelId,
            ...(turnModel ? { model: turnModel } : {}),
            ...(turnThinkingLevel !== undefined
              ? { thinkingLevel: turnThinkingLevel }
              : {}),
            ...(sessionId ? { sessionId } : {}),
            signal: abort.signal,
          },
          {
            clientName: 'canopy-cursor-chat',
            planMode,
            onToolInvocation: (invocation): void => {
              const rawInput = invocation.rawInput;
              const parsedPreview =
                typeof rawInput === 'object' &&
                rawInput !== null &&
                !Array.isArray(rawInput) &&
                'providerIdentifier' in rawInput &&
                rawInput.providerIdentifier ===
                  cursorCanopyMcpServerNames().main &&
                'toolName' in rawInput &&
                rawInput.toolName ===
                  CANOPY_INJECTED_TOOL_REGISTRY.preview_visual.displayName
                  ? parseCursorMcpToolCall({
                      title: invocation.title,
                      rawInput,
                      kind: invocation.kind,
                    })
                  : null;
              if (
                serverMode === 'default' &&
                appRouteAvailable &&
                parsedPreview &&
                resolveCursorCanopyToolKey(parsedPreview, toolSurface) ===
                  'preview_visual'
              )
                previewToolIds.add(invocation.toolUseId);
              else previewToolIds.delete(invocation.toolUseId);
              if (
                isTrustedCursorShowVisualInvocation(invocation, {
                  serverMode,
                  appToolsReachedCli: appRouteAvailable,
                  toolSurface,
                })
              )
                visualLedger.record(invocation.toolUseId);
              else visualLedger.forget(invocation.toolUseId);
            },
            authorizeNative: (payload, context) =>
              authorizeCursorTool(payload, {
                cwd: opts.cwd,
                approval: currentApproval,
                planMode,
                signal: context.signal,
              }),
            authorizeMcp: (call, context) =>
              authorizeCursorMcpTool(call, {
                approval: currentApproval,
                toolCallId: context.toolCallId,
                cwd: opts.cwd,
                planMode,
                mode: serverMode,
                toolSurface,
                managedToolNames: managedDelegation?.tools.map(
                  (tool) => tool.name,
                ),
                signal: context.signal,
              }),
            prepareMcp: async (
              capabilities,
              gates: CursorTurnGates,
            ): Promise<CursorTurnMcpSetup> => {
              recordCursorMcpCapabilities(capabilities);
              // The app's route (and its bearer token) exists only for turns
              // whose CLI can actually receive an HTTP MCP server.
              let canopy: {
                mainUrl: string;
                uiUrl: string;
                authToken: string;
              } | null = null;
              if (capabilities?.http === true) {
                if (!ledger.decided && serverMode === 'default') {
                  ledger.decided = true;
                  // The Cowork Cursor route does not list the Ledger tools.
                  ledger.tools =
                    !isCoworkWorkspace(opts.projectId) &&
                    mayExposeLedgerTools(ledgerTarget)
                      ? await openLedgerChatTools({
                          target: ledgerTarget,
                          harness: 'cursor',
                          readSettings: () => ledgerSettings,
                          ...(opts.selectedRepoId
                            ? { selectedRepoId: opts.selectedRepoId }
                            : {}),
                        })
                      : null;
                  // A session that ended while they opened never uses them.
                  if (lifetime.signal.aborted) {
                    ledger.tools?.dispose();
                    ledger.tools = null;
                  }
                }
                const authToken = randomBytes(32).toString('base64url');
                await proxy.registerCanopyWorktreeSessionRoute({
                  turnSignal: gates.signal,
                  sessionKey: key,
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                  interfaceTools: opts.interfaceTools ?? [],
                  assistantMode,
                  ...(opts.projectId === CODE_REVIEW_CHAT_PROJECT_ID
                    ? { isCodeReview: true }
                    : {}),
                  ...(appAdvisorRuntime
                    ? { appAdvisorRuntime }
                    : serverMode === 'pipeline-editor'
                      ? { pipelineEditorRuntime: opts.pipelineEditorRuntime }
                      : { toolSurface }),
                  cwd: opts.cwd,
                  ...(opts.selectedRepoId
                    ? { repoId: opts.selectedRepoId }
                    : {}),
                  sdkSessionId: sessionId ?? key,
                  providerType: 'cursor',
                  // RequestSecrets on the `_ui` server: interactive root chats
                  // only, while the flag is on (re-checked per call). Tools
                  // only: this provider has no live environment for ambient
                  // secrets (agent-secrets/ambient-env.ts).
                  ...(serverMode === 'default' &&
                  opts.executionContext === undefined &&
                  isAgentSecretRequestsEnabled()
                    ? {
                        secretRequests: true,
                        getApprovalMode: (): ApprovalMode => approvalMode,
                      }
                    : {}),
                  pluginSelections: pluginContext.selections,
                  deferredToolsAllowed: false,
                  authToken,
                  createdAt: Date.now(),
                  hookHandler: () => undefined,
                  ...(managedDelegation
                    ? {
                        managedDelegation: {
                          tools: managedDelegation.mcpTools,
                          invoke: async (
                            name,
                            input,
                            transport,
                          ): Promise<{ text: string; isError: boolean }> => {
                            const managed = managedDelegation;
                            if (
                              !managed ||
                              !transport?.requestId ||
                              gates.signal.aborted ||
                              !hostTurnId ||
                              currentTurn !== hostTurnId
                            )
                              return {
                                text: 'The owning Cursor turn is unavailable.',
                                isError: true,
                              };
                            const call = {
                              server:
                                cursorCanopyMcpServerNames(serverMode).main,
                              tool: name,
                              args: input,
                            };
                            const identity = gates.pluginCallIdentity(
                              call.server,
                              name,
                              input,
                            );
                            const acpApproved =
                              gates.consumeAllowance(identity);
                            const decision = acpApproved
                              ? { decision: 'allow' as const }
                              : await authorizeCursorMcpTool(call, {
                                  approval: currentApproval,
                                  cwd: opts.cwd,
                                  toolCallId: transport.requestId,
                                  planMode,
                                  signal: gates.signal,
                                  managedToolNames:
                                    managedDelegation?.tools.map(
                                      (tool) => tool.name,
                                    ),
                                });
                            if (!acpApproved)
                              gates.recordGateDecision(
                                identity,
                                decision.decision,
                              );
                            if (decision.stopTurn) gates.abort();
                            if (
                              gates.signal.aborted ||
                              decision.decision !== 'allow'
                            )
                              return {
                                text: `${name} was denied.`,
                                isError: true,
                              };
                            const result = await managed.parent.invokeCursor(
                              name,
                              input,
                              {
                                callId: transport.requestId,
                                turnId: hostTurnId,
                              },
                            );
                            return {
                              text: JSON.stringify(result),
                              isError: !result.ok,
                            };
                          },
                        },
                      }
                    : {}),
                  codeGraphToolsAdvertised: false,
                  ...(ledger.tools ? { ledgerTools: ledger.tools } : {}),
                  ...(opts.model ? { model: opts.model } : {}),
                  // A question pause keeps the turn's message identity so an
                  // exact-turn stop still applies to it.
                  onAwaitingUser: (): void => {
                    turnState.markTurnAwaitingUser();
                    awaitingUser = true;
                    if (hostTurnId)
                      lifecycleProducer.sessionState({
                        ...(sessionId ? { providerSessionId: sessionId } : {}),
                        state: 'requires_action',
                        source: 'provider',
                        observedDuringTurnId: hostTurnId,
                      });
                  },
                  autoArchiveAvailable: true,
                  authorizeToolCall: async (
                    toolKey,
                    args,
                    callContext,
                  ): Promise<boolean> => {
                    // Stop wins over a stale allowance.
                    if (gates.signal.aborted) return false;
                    const names = cursorCanopyMcpServerNames(serverMode);
                    const server =
                      toolKey === 'ask_user_question' ||
                      toolKey === 'request_secrets'
                        ? names.ui
                        : names.main;
                    const tool =
                      serverMode === 'app-advisor'
                        ? isAppAdvisorToolKey(toolKey)
                          ? APP_ADVISOR_TOOL_REGISTRY[toolKey].displayName
                          : undefined
                        : serverMode === 'pipeline-editor'
                          ? isPipelineEditorToolKey(toolKey)
                            ? PIPELINE_EDITOR_TOOL_REGISTRY[toolKey].displayName
                            : undefined
                          : isCanopyInjectedToolKey(toolKey)
                            ? CANOPY_INJECTED_TOOL_REGISTRY[toolKey].displayName
                            : undefined;
                    if (tool === undefined) return false;
                    // The identity the driver filed the ACP allowance under:
                    // the driver resolves the `_ui` server and default-mode
                    // main server through the injected registry, and files an
                    // App Advisor main-server call like a plugin call.
                    const identity =
                      serverMode === 'app-advisor' ||
                      serverMode === 'pipeline-editor'
                        ? toolKey === 'ask_user_question'
                          ? gates.appToolCallIdentity('ask_user_question', args)
                          : gates.pluginCallIdentity(server, tool, args)
                        : isCanopyInjectedToolKey(toolKey)
                          ? gates.appToolCallIdentity(toolKey, args)
                          : undefined;
                    if (identity === undefined) return false;
                    if (gates.consumeAllowance(identity)) return true;
                    const decision = await authorizeCursorMcpTool(
                      { server, tool, args },
                      {
                        approval: currentApproval,
                        // The MCP request id is transport-local, but it is the
                        // only id this call has until the CLI reports it.
                        toolCallId:
                          callContext?.requestId ??
                          `app-tool-${randomBytes(6).toString('hex')}`,
                        cwd: opts.cwd,
                        planMode,
                        mode: serverMode,
                        toolSurface,
                        signal: gates.signal,
                      },
                    );
                    if (decision.stopTurn) gates.abort();
                    gates.recordGateDecision(identity, decision.decision);
                    return (
                      !gates.signal.aborted && decision.decision === 'allow'
                    );
                  },
                });
                routeRegistered = true;
                canopy = {
                  mainUrl: proxy.getCanopyWorktreeMcpUrl(key),
                  uiUrl: proxy.getCanopyWorktreeUiMcpUrl(key),
                  authToken,
                };
              } else {
                cursorLimitNotices.push(
                  "Cursor did not advertise HTTP MCP support, so the app's own tools are unavailable in this session.",
                );
              }
              const built = await buildCursorMcpServers({
                canopy,
                mode: serverMode,
                resolvedMcpServers,
                capabilities,
                resolveExecutable: (command, base) =>
                  resolveMcpExecutable(
                    command,
                    managed.env.PATH,
                    base ?? opts.cwd,
                    opts.cwd,
                  ),
              });
              const mcpServers = built.servers;
              const serverNames = cursorCanopyMcpServerNames(serverMode);
              const appToolsAvailable = mcpServers.some(
                (server) => server.name === serverNames.main,
              );
              // This turn's authenticated app route must have reached the CLI.
              appRouteAvailable = appToolsAvailable;
              // Plugin and standalone servers the app proxies are gated at the
              // proxy by the name the CLI knows them by.
              const serverNameByProxyUrl = new Map<string, string>();
              for (const server of mcpServers)
                if (
                  'url' in server &&
                  server.name !== serverNames.main &&
                  server.name !== serverNames.ui
                )
                  serverNameByProxyUrl.set(server.url, server.name);
              proxy.setSessionToolCallGate(
                key,
                async (call): Promise<boolean> => {
                  if (gates.signal.aborted) return false;
                  const server = serverNameByProxyUrl.get(call.proxyUrl);
                  if (!server) return false;
                  const identity = gates.pluginCallIdentity(
                    server,
                    call.tool,
                    call.args,
                  );
                  if (gates.consumeAllowance(identity)) return true;
                  const decision = await authorizeCursorMcpTool(
                    { server, tool: call.tool, args: call.args },
                    {
                      approval: currentApproval,
                      toolCallId:
                        call.requestId ??
                        `plugin-tool-${randomBytes(6).toString('hex')}`,
                      cwd: opts.cwd,
                      planMode,
                      mode: serverMode,
                      signal: gates.signal,
                    },
                  );
                  if (decision.stopTurn) gates.abort();
                  gates.recordGateDecision(identity, decision.decision);
                  return decision.decision === 'allow';
                },
              );
              const pluginServerNames = mcpServers
                .map((server) => server.name)
                .filter(
                  (name) =>
                    name !== serverNames.main && name !== serverNames.ui,
                );
              return {
                servers: mcpServers,
                notes: built.notes,
                notices: [...cursorLimitNotices, ...built.warnings],
                appToolsAvailable,
                pluginServerNames,
              };
            },
            beforePrompt: async ({
              sessionId: activeSessionId,
              contextLost,
              mcp,
              announce,
            }): Promise<{
              instructions: string;
              inheritedContext?: string;
            }> => {
              // Publish the live session id as soon as the driver resolves it
              // (session/new or session/load, before the prompt is sent), not
              // only after the whole turn completes below. getProviderSessionId()
              // is read mid-turn as an owner-bound fallback for renderer-write
              // timing (see call sites in ipc/chat.ts and
              // lib/worktree-chat-turn.ts); leaving it stale/undefined for the
              // full turn duration silently breaks that fallback.
              sessionId = activeSessionId;
              if (contextLost) {
                announce(
                  'Earlier Cursor context could not be restored, so this turn starts a new Cursor session.\n\n',
                );
              }
              // A resolution that failed outright belongs to this turn: the next
              // one may succeed, so it is reported every time it happens.
              if (resolutionFailure) announce(`${resolutionFailure}\n\n`);
              announceLater = announce;
              reportUnloaded();
              // The user selected these and Cursor cannot load them; say so once
              // so the gap is visible without repeating on every turn.
              const limitNotices = unannounced(mcp.notices);
              if (limitNotices.length > 0)
                announce(
                  `Some selections are not available in Cursor chats:\n- ${limitNotices.join('\n- ')}\n\n`,
                );
              // These servers did load; the note explains a difference from how
              // their definition expects to run.
              const serverNotes = unannounced(mcp.notes);
              if (serverNotes.length > 0)
                announce(
                  `MCP server notes:\n- ${serverNotes.join('\n- ')}\n\n`,
                );
              const serverNames = cursorCanopyMcpServerNames(serverMode);
              // This turn's route carries the Ledger tools only when the
              // app's servers reached the CLI. A normal turn then opens with a
              // bounded hint when entries assigned to this chat changed.
              const ledgerTools =
                serverMode === 'default' && mcp.appToolsAvailable
                  ? ledger.tools
                  : null;
              const ledgerHint = ledgerTools
                ? await ledgerTools.assignmentHint()
                : undefined;
              const memoryPolicy = await resolveLocalMemoryPolicy(opts);
              // The injected-tool steering is appended here, not by the turn
              // dispatcher, because only now is it known that the app's MCP
              // servers actually reached the CLI; a prompt naming tools Cursor
              // cannot call would contradict the availability line below. App
              // Advisor sessions carry their own system prompt instead.
              const appToolSteering = mcp.appToolsAvailable
                ? serverMode === 'default'
                  ? [
                      cowork
                        ? buildCoworkInjectedToolPrompt(
                            'cursor',
                            chatVisualsPromptEligible('cursor', 'cowork'),
                          )
                        : buildWorktreeInjectedToolPrompt(
                            'cursor',
                            false,
                            opts.projectId === CODE_REVIEW_CHAT_PROJECT_ID,
                            chatVisualsPromptEligible('cursor', 'worktree'),
                          ),
                      ledgerTools?.systemPrompt(),
                      buildLocalMemoryPromptNudge(
                        preferences.localMemoryEnabled === true,
                        memoryPolicy.kind === 'scoped' &&
                          memoryPolicy.privateMemory,
                      ),
                    ]
                      .filter(Boolean)
                      .join('\n\n')
                  : serverMode === 'pipeline-editor'
                    ? `Pipeline Assistant tools are available on the ${serverNames.main} MCP server and AskUserQuestion on ${serverNames.ui}. Deferred capability loading is unavailable.`
                    : // The App Advisor system prompt spells its tools for
                      // Claude and Codex and points at deferred loading; Cursor
                      // sees them under MCP titles and cannot reload mid-turn.
                      `In this Cursor chat the Orchestrator tools are MCP tools titled "${serverNames.main}: <Name>" (for example "${serverNames.main}: GetCurrentUiState") and "${serverNames.ui}: AskUserQuestion". SearchDeferredTools and LoadDeferredTools are unavailable here; work with the tools already listed.`
                : undefined;
              const pluginServerSteering =
                mcp.pluginServerNames.length > 0
                  ? ` and the ${mcp.pluginServerNames.join(', ')} MCP ${mcp.pluginServerNames.length === 1 ? 'server' : 'servers'}`
                  : '';
              // Skills and commands are loaded by the CLI from the chat's own
              // ~/.cursor, so the model is told they exist, not how to call
              // them; the CLI advertises the set itself.
              const capabilitySteering =
                root.skillIds.length > 0 || root.commandIds.length > 0
                  ? ' Selected skills and slash commands are loaded by Cursor itself.'
                  : '';
              const instructions = [
                opts.systemPromptAppend,
                mcp.appToolsAvailable
                  ? managedDelegation?.systemPromptGuidance
                  : undefined,
                appToolSteering,
                planMode ? CURSOR_PLAN_MODE_STEERING : undefined,
                // The bookkeeping exception authorizeCursorMcpTool applies.
                planMode && ledgerTools
                  ? buildLedgerPlanModeInstruction('cursor')
                  : undefined,
                mcp.appToolsAvailable
                  ? `This local Cursor chat supports native Read, Grep, Glob, List, ReadLints, Write, Delete, Shell, Fetch, WebFetch, and WebSearch, plus the MCP tools on the ${serverNames.main} and ${serverNames.ui} servers${pluginServerSteering}; call them directly when they fit the task.${capabilitySteering} Native Cursor subagents are unavailable.${managedDelegation ? ' Use the supplied managed delegation tools for delegated tasks.' : ''} Do not work around a denied operation.`
                  : mcp.pluginServerNames.length > 0
                    ? `This local Cursor chat supports native Read, Grep, Glob, List, ReadLints, Write, Delete, Shell, Fetch, WebFetch, and WebSearch, plus the MCP tools on the ${mcp.pluginServerNames.join(', ')} MCP ${mcp.pluginServerNames.length === 1 ? 'server' : 'servers'}.${capabilitySteering} The app's own tools and subagents are unavailable. Do not work around a denied operation.`
                    : `This local Cursor chat supports native Read, Grep, Glob, List, ReadLints, Write, Delete, Shell, Fetch, WebFetch, and WebSearch.${capabilitySteering} Other tools, plugins, MCP, and subagents are unavailable. Do not work around a denied operation.`,
                // Last, so it sits next to the text of the turn it opens.
                ledgerHint,
              ]
                .filter(Boolean)
                .join('\n\n');
              const inheritedContext = await forkContext.prompt(
                profile,
                activeSessionId,
                userMessageId,
              );
              if (inheritedContext)
                announce(
                  'Saved conversation context was copied to this independent session. Hidden Cursor state was not copied.\n\n',
                );
              return { instructions, inheritedContext };
            },
            emit: emitTurn,
            onUsage: (usage) =>
              emitTurn({ type: 'canopy_cursor_usage', usage }),
            onAvailableCommands: (names): void => {
              advertised = names;
              reportUnloaded();
            },
            // Resolved per call, not captured once: the RTK preference can be
            // toggled while this turn is running.
            rtk: () =>
              rtkEnabled
                ? { binaryPath: rtkBinaryPath, env: rtkEnv }
                : undefined,
            onRevoked: () => {
              currentApproval.invalidatePending?.();
              currentApproval.dispose();
            },
            // The driver has discarded the orphaned id. Stop advertising it to
            // mid-turn readers right now rather than leaving it live for the
            // two ACP round-trips until `beforePrompt` publishes a
            // replacement — a deferred capability load landing in that window
            // would otherwise resume against a session known to be gone.
            onSessionCleared: (): void => {
              sessionId = undefined;
            },
            cleanup: (): Promise<void> => {
              currentApproval.invalidatePending?.();
              currentApproval.dispose();
              // Plugin proxy routes are keyed by the session before the
              // worktree route registers, so release them even without it.
              if (turnState.ownsKeyResources()) {
                proxy.unregisterRoutesForSession(key);
                if (routeRegistered)
                  proxy.unregisterCanopyWorktreeSessionRoute(key);
              }
              return Promise.resolve();
            },
          },
        );
        sessionId = outcome.sessionId;
        if (outcome.inheritedContextDelivered && outcome.sessionId)
          await forkContext.delivered(profile, outcome.sessionId);
        // The CLI's settings notice hides which setting: for a model whose
        // data retention policy the account has not accepted, name it.
        // Every other refusal keeps the driver's copy.
        const message =
          outcome.actionRequired === 'config'
            ? ((await cursorDataPolicyMessage(rawModelId, env, abort.signal)) ??
              outcome.message)
            : outcome.message;
        if (abort.signal.aborted)
          return {
            type: 'result',
            is_error: false,
            result: 'Turn cancelled',
            subtype: 'cancelled',
          };
        const proposedPlan =
          startedInPlanMode &&
          !outcome.isError &&
          !outcome.cancelled &&
          !outcome.integrityFailure &&
          outcome.stopReason === 'end_turn'
            ? extractProposedPlan(outcome.responseText)
            : undefined;
        if (proposedPlan) {
          const event: PlanExitRequestEvent = {
            requestId: randomUUID(),
            projectId: opts.projectId,
            worktreeId: opts.worktreeId,
            chatId: opts.chatId,
            source: 'cursor',
            reviewMode: 'proposal',
            toolInput: {
              plan: proposedPlan,
              source: 'cursor',
              reviewMode: 'proposal',
            },
            ...(userMessageId ? { turnUserMessageId: userMessageId } : {}),
          };
          await commitPendingPlanExit(event);
          if (!abort.signal.aborted) {
            interfacePort.presentPlanExit(event);
            getAttentionTracker().mark({
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              state: 'needs_input',
              reason: 'plan_review',
              sourceId: 'plan-review',
            });
          }
        }
        return {
          type: 'result',
          is_error: outcome.isError,
          result: message,
          ...(outcome.providerErrorDetails
            ? { canopy_provider_error_details: outcome.providerErrorDetails }
            : {}),
          ...(outcome.cancelled ? { subtype: 'cancelled' } : {}),
        };
      } catch (error) {
        return {
          type: 'result',
          is_error: !abort.signal.aborted,
          result: abort.signal.aborted
            ? 'Turn cancelled'
            : error instanceof Error
              ? error.message
              : 'Cursor chat failed.',
          ...(abort.signal.aborted ? { subtype: 'cancelled' } : {}),
        };
      } finally {
        // The driver runs `cleanup` for every turn it started; a turn that
        // failed in preflight releases the same resources here.
        approval?.dispose();
        approval = undefined;
        if (turnState.ownsKeyResources()) {
          proxy.unregisterRoutesForSession(key);
          if (routeRegistered) proxy.unregisterCanopyWorktreeSessionRoute(key);
        }
      }
    }

    const session: AgentSession = {
      sendMessage(text, sendOptions): void {
        if (lifetime.signal.aborted)
          throw new Error('Cursor session has ended.');
        if (active)
          throw new Error('Wait for the current Cursor turn to finish.');
        const abort = new AbortController();
        const lifecycleTurnId =
          sendOptions?.lifecycleExecutionId ??
          sendOptions?.userMessageId ??
          randomUUID();
        currentTurn = lifecycleTurnId;
        const startedAtMs = Date.now();
        const lifecycleBinding: TurnBinding = {
          turnId: lifecycleTurnId,
          origin: 'user',
          binding: sendOptions?.userMessageId ? 'bound' : 'unbound',
          submissionIds: [],
          userMessageIds: sendOptions?.userMessageId
            ? [sendOptions.userMessageId]
            : [],
          providerUserMessageUuids: [],
        };
        awaitingUser = false;
        lifecycleProducer.turnStarted({
          ...lifecycleBinding,
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          phase: 'start',
          startedAtMs,
        });
        if (sendOptions?.userMessageId !== undefined)
          observeRoutedTurnBinding(
            lifecycleScope,
            session,
            [sendOptions.userMessageId],
            undefined,
            lifecycleTurnId,
          );
        lifecycleProducer.sessionState({
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          state: 'running',
          source: 'provider',
          observedDuringTurnId: lifecycleTurnId,
        });
        const turnOutput = new CursorEventBuffer(async (event) => {
          await onEvent(event);
          // The router acknowledges admission before persistence. Wait for
          // its existing owner so subsequent text can coalesce while this
          // commit runs, and ACP keeps its byte credits until delivery.
          await drainChatSessionEvents(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
        });
        output = turnOutput;
        turnState.markTurnActive(sendOptions?.userMessageId);
        // Trusted ShowVisual calls of this turn; closed after its final drain.
        const visualLedger = openTurnLedger({
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
        });
        const done = run(text, abort, visualLedger, sendOptions?.userMessageId)
          .finally(async () => {
            try {
              await turnOutput.flush();
              // Preflight notices and callbacks can outlive the prompt's own
              // update admissions. Idle must follow all admitted output.
              await drainChatSessionEvents(
                opts.projectId,
                opts.worktreeId,
                opts.chatId,
              );
            } finally {
              visualLedger.close();
            }
          })
          .catch((error: unknown) => ({
            type: 'result',
            is_error: true,
            result:
              error instanceof Error ? error.message : 'Cursor cleanup failed.',
          }))
          .then((result: Record<string, unknown>) => {
            active = undefined;
            output = undefined;
            // All answer output is durable. The terminal callback releases
            // the chat queue, so the provider must be reusable before it runs.
            turnState.markTurnIdle();
            // Emit one terminal event. `error` both settles the failed turn
            // and persists its message in the shared transcript renderer.
            awaitingUser = false;
            const endedAtMs = Date.now();
            lifecycleProducer.turnEnded({
              ...lifecycleBinding,
              ...(sessionId ? { providerSessionId: sessionId } : {}),
              endedAtMs,
              // The reducer derives the duration net of requires_action pauses.
              outcome:
                abort.signal.aborted || result.subtype === 'cancelled'
                  ? 'cancelled'
                  : result.is_error === true
                    ? 'failed'
                    : 'completed',
              ...(typeof result.result === 'string'
                ? { terminalReason: result.result }
                : {}),
              source: 'result',
            });
            lifecycleProducer.sessionState({
              ...(sessionId ? { providerSessionId: sessionId } : {}),
              state: 'idle',
              source: 'result-fallback',
              observedDuringTurnId: lifecycleTurnId,
            });
            return emit(
              result.is_error === true
                ? {
                    type: 'error',
                    error: result.result,
                    ...(typeof result.canopy_provider_error_details === 'string'
                      ? {
                          canopy_provider_error_details:
                            result.canopy_provider_error_details,
                        }
                      : {}),
                  }
                : result,
              sendOptions?.userMessageId,
            );
          });
        active = { abort, done };
      },
      isDisposed: (): boolean => lifetime.signal.aborted,
      getProviderSessionId: (): string | undefined => sessionId,
      cancel: async (): Promise<void> => {
        const turn = active;
        turn?.abort.abort();
        // Stop ends only the parent turn. Retire that turn's delegation tool
        // bindings; the chat's delegations keep running.
        managedDelegation?.retireTurn();
        await turn?.done;
      },
      destroy: async (): Promise<void> => {
        lifetime.abort();
        try {
          await session.cancel();
          // The session is gone; the chat's delegations outlive it. Closing
          // the chat closes its delegation scope before destroying the session.
          managedDelegation?.detach();
        } finally {
          if (!lifecycleProducerReleased) {
            lifecycleProducerReleased = true;
            releaseTurnLifecycleProducer('cursor', lifecycleScope);
          }
        }
      },
      setManagedDelegationMode: (mode) => {
        opts.managedDelegationMode = mode;
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
        return Promise.resolve();
      },
      setPlanMode: (enabled): Promise<void> => {
        if (active)
          return Promise.reject(
            new Error('Stop Cursor before changing plan mode.'),
          );
        planMode = enabled;
        return Promise.resolve();
      },
      setApprovalMode: (mode): Promise<void> => {
        approvalMode = mode;
        approval?.setMode(mode);
        return Promise.resolve();
      },
      setRtkEnabled: (enabled): Promise<void> => {
        rtkEnabled = enabled;
        return Promise.resolve();
      },
      setThinkingLevel: (level): Promise<void> => {
        thinkingLevel = level;
        return Promise.resolve();
      },
      setModel: (model): Promise<void> => {
        if (!isCursorModel(model))
          return Promise.reject(new Error('Choose a Cursor model.'));
        selectedModel = model;
        return Promise.resolve();
      },
    };
    registerSession(
      key,
      session,
      lifetime,
      'cursor',
      opts.model,
      opts.assistantMode,
      opts.toolProfileHash,
      false,
      'cursor',
    );
    return session;
  }
}
import { readInstalledItemPolicy } from '../installed-items/installed-item-policy';
