import { isWatchDelegatesCompatibilityName } from '@canopy/desktop-shared/node/delegation/watch-delegates-tombstone';
import { isAgentSecretRequestsEnabled } from '../agent-secrets/feature-gate';
import { TranscriptForkContext } from './transcript-fork-context';
import { captureHomeCapabilities } from './delegation/capture-home-capabilities';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { managedDelegationEnabled } from './delegation/gate';
import type { ManagedDelegationSession } from './delegation/service';
import { runRtkRewrite } from '@canopy/execution-engine/node/rtk/rewrite';
import {
  getBundledRtkBinaryPath,
  getRtkManagedEnv,
} from '@canopy/execution-engine/pipelines/config-paths';
import { getEnhancedEnv } from '../pipelines/config-paths';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { AgentInterfacePort } from './agent-interface-port';
import {
  getRawCopilotModelId,
  isCopilotModel,
} from '@canopy/execution-engine/lib/copilot-models';
import {
  hasAnySelections,
  STANDALONE_CHAT_PROJECT_ID,
  type ApprovalMode,
  type McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';
import {
  emptyCursorCapabilityProjection,
  expandLeadingCursorCommand,
} from '@canopy/desktop-shared/lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '@canopy/desktop-shared/node/cursor/capability-root';
import type { CopilotTurnRequest } from '@canopy/copilot-recipient/turn-driver';
import { handleCopilotTurnCleanupError } from '@canopy/copilot-recipient/turn-cleanup';
import {
  collectCopilotMcpSecretValues,
  describeCopilotMcpServerError,
  type CopilotMcpServerReadiness,
} from '@canopy/copilot-recipient/tool-snapshot';
import { managedMcpServerFriendlyLabel } from '@canopy/execution-engine/node/plugins/mcp-server-name';
import {
  createCopilotCapabilitySnapshot,
  isCopilotCapabilitySnapshot,
  type CopilotCapabilitySnapshot,
} from '@canopy/copilot-recipient/capability-snapshot';
import { COPILOT_RUNTIME_VERSION } from '@canopy/desktop-shared/node/copilot/runtime-metadata';
import { COPILOT_NATIVE_TOOLS } from '@canopy/copilot-recipient/session-policy';
import { CopilotToolCorrelation } from '@canopy/copilot-recipient/tool-correlation';
import {
  CopilotMcpApprovals,
  CopilotToolReceipts,
  copilotReceiptText,
} from '@canopy/copilot-recipient/tool-receipts';
import { clampThinkingLevelToDeclared } from '@canopy/protocol/thinking';
import type { TurnBinding } from '@canopy/protocol/canopy-core';
import {
  createApprovalSession,
  type ApprovalSessionHandle,
} from '../approvals/approval-service';
import {
  assertCopilotConnectionGeneration,
  assertCopilotModelAvailable,
} from '../copilot/connection';
import { assertAgentWorkerContext } from '../agent-runs/agent-worker-context';
import { getCopilotWorkerRuntime } from '../agent-runs/copilot-worker-runtime';
import { authorizeCopilotNativeTool } from '../copilot/tool-approval';
import { buildCopilotMcpServers } from '../copilot/mcp-servers';
import { authorizeCursorMcpTool } from '../cursor/tool-approval';
import { getWorktreeDataDir } from '../lib/paths';
import { resolveWorktreeTargetIds } from '../lib/resolve-worktree';
import { readPreferencesFile } from '../lib/preferences-store';
import { buildLocalMemoryPromptNudge } from '../lib/cowork-chat-system-prompt';
import { resolveLocalMemoryPolicy } from '../memory/local/policy';
import { isCoworkWorkspace } from '../lib/workspace-registry';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { requestChatTombstones } from '../plugins/request-chat-tombstones';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { discoverHomeCapabilities } from '../plugins/home-capabilities';
import { refreshInvocableInventoryAfterMutation } from '../plugins/invocable-inventory-service';
import { getMcpHttpProxyService } from '../mcp/http-proxy-service';
import { requestAnswersFromRenderer } from '../canopy-tools/session-runtime';
import {
  buildCoworkInjectedToolPrompt,
  buildWorktreeInjectedToolPrompt,
} from '../canopy-tools/prompting';
import { CursorEventBuffer } from './cursor-event-buffer';
import {
  buildSessionKey,
  drainChatSessionEvents,
  registerSession,
} from './session-manager';
import { observeRoutedTurnBinding } from './session-event-router';
import {
  getTurnLifecycleProducer,
  releaseTurnLifecycleProducer,
} from './provider-turn-lifecycle';
import { createOwnedTurnState } from './owned-turn-state';
import type { AgentProvider, AgentSession, AgentSessionOptions } from './types';

/**
 * Fingerprint of the user's home-folder skills and commands the last Copilot
 * turn saw. A changed set rebuilds the slash-menu inventory, so a skill added
 * to a home folder appears in the menu after the next message rather than
 * the next app start. Copilot reads the same roots a Cursor chat does.
 */
let lastInheritedFingerprint: string | undefined;

function hasToolKey<T extends object>(
  registry: T,
  key: string,
): key is Extract<keyof T, string> {
  return Object.prototype.hasOwnProperty.call(registry, key);
}

function readCapabilityDigests(
  binding: unknown,
  sessionId: string,
  account: unknown,
): { host?: string; native?: string } {
  if (
    !binding ||
    typeof binding !== 'object' ||
    !('sessionId' in binding) ||
    binding.sessionId !== sessionId ||
    !('account' in binding) ||
    JSON.stringify(binding.account) !== JSON.stringify(account)
  )
    throw new Error(
      'This Copilot conversation belongs to another account or workspace. Start a new chat.',
    );
  if ('version' in binding && binding.version !== 1 && binding.version !== 2)
    throw new Error(
      'This Copilot conversation has unsupported session metadata. Start a new chat.',
    );
  const host =
    'capabilitySnapshot' in binding ? binding.capabilitySnapshot : undefined;
  if (host !== undefined && !isCopilotCapabilitySnapshot(host))
    throw new Error(
      'This Copilot conversation has invalid capability metadata. Start a new chat.',
    );
  // Interactive version-1 bindings can be upgraded after complete native verification.
  // Unlike unattended execution, an interactive turn explicitly permits capability changes.
  if (!('version' in binding) || binding.version === 1)
    return { host: host?.digest };
  if (
    !host ||
    !('nativeToolSnapshot' in binding) ||
    !isCopilotCapabilitySnapshot(binding.nativeToolSnapshot) ||
    !('runtimeVersion' in binding) ||
    binding.runtimeVersion !== COPILOT_RUNTIME_VERSION
  )
    throw new Error(
      'This Copilot conversation has incompatible saved configuration. Start a new chat.',
    );
  return { host: host.digest, native: binding.nativeToolSnapshot.digest };
}

/** "Linear and Slack", "Linear, Slack, and Gmail": names in a notice. */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`;
}

/** Copilot's reply to its user-input question: one string for the answer. */
export function copilotUserInputAnswer(answer: McpQuestionAnswer | undefined): {
  answer: string;
  wasFreeform: boolean;
} {
  const selected = answer?.selectedOptions ?? [];
  // A picked option keeps the text typed beside it (REG-3133).
  return {
    answer: [...selected, answer?.freeformText].filter(Boolean).join(', '),
    wasFreeform: selected.length === 0 && !!answer?.freeformText,
  };
}

/** SDK-backed desktop provider; canonical transcript ownership remains in chat state. */
export class CopilotProvider implements AgentProvider {
  createSession(
    opts: AgentSessionOptions,
    onEvent: (event: unknown) => void | Promise<void>,
    interfacePort: AgentInterfacePort,
  ): AgentSession {
    assertAgentWorkerContext('CopilotProvider.createSession');
    const getWindow = (): BrowserWindow | null => interfacePort.legacyWindow();
    const key = buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId);
    const lifecycleScope = {
      projectId: opts.projectId,
      worktreeId: opts.worktreeId,
      chatId: opts.chatId,
    };
    const lifecycleProducer = getTurnLifecycleProducer(
      'copilot',
      lifecycleScope,
    );
    const turnState = createOwnedTurnState(key, () => session);
    const cowork = isCoworkWorkspace(opts.projectId);
    const codeGraphToolsAdvertised =
      !cowork &&
      (!opts.assistantMode || opts.assistantMode === 'default') &&
      opts.codeGraphToolsAdvertised === true;
    const lifetime = new AbortController();
    let active: { abort: AbortController; done: Promise<void> } | undefined;
    let output: CursorEventBuffer | undefined;
    let sessionId = opts.sdkSessionId;
    const forkContext = new TranscriptForkContext(opts, 'Copilot');
    let currentTurn: string | undefined;
    let managedDelegation: ManagedDelegationSession | undefined;
    let inheritedCapabilityOverlay: AgentSessionOptions['inheritedCapabilityOverlay'];
    let rtkEnabled = opts.rtkEnabled !== false;
    let model = opts.model;
    let thinking = opts.thinkingLevel;
    let planMode = opts.planMode === true;
    let approvalMode: ApprovalMode = opts.approvalMode ?? 'ask';
    let approval: ApprovalSessionHandle | undefined;
    let awaitingUser = false;
    let lifecycleProducerReleased = false;
    // Home-folder entries that could not be loaded are reported once per
    // session, not once per turn.
    const announcedNotices = new Set<string>();
    // Selected MCP servers that sat out of the previous turn, keyed by name
    // with their status, so a notice repeats only when that mapping changes
    // (a server recovered and failed anew, or its status moved), never while
    // it simply stays down.
    let previousUnavailableMcp = new Map<string, string>();
    lifetime.signal.addEventListener('abort', () => active?.abort.abort(), {
      once: true,
    });
    const emit = (
      data: Record<string, unknown>,
      userMessageId?: string,
    ): void | Promise<void> => {
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
        provider: 'copilot',
        ...(userMessageId
          ? { canopy_turn_user_message_id: userMessageId }
          : {}),
      };
      managedDelegation?.observe(event, userMessageId);
      turnState.recordSessionEvent(event);
      return output && data.type !== 'result' && data.type !== 'error'
        ? output.push(event)
        : onEvent(event);
    };

    const run = async (
      prompt: string,
      turnId: string,
      abort: AbortController,
      userMessageId?: string,
    ): Promise<Record<string, unknown>> => {
      if (!managedDelegation && managedDelegationEnabled(opts)) {
        const created = await (
          await import('./delegation/service')
        ).createManagedDelegationSession({
          harness: 'copilot',
          sessionKey: key,
          interfacePort,
          currentTurn: () => currentTurn,
          currentOptions: () => ({
            ...opts,
            inheritedCapabilityOverlay,
            model,
            selectedModel: model,
            thinkingLevel: thinking,
            approvalMode,
            planMode,
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
                '[copilot-session] Delegation transcript delivery failed',
                error,
              ),
            );
          },
        });
        if (lifetime.signal.aborted) created.detach();
        else managedDelegation = created;
      }
      inheritedCapabilityOverlay = undefined;
      const turnModel = model;
      const rawModel = getRawCopilotModelId(turnModel ?? '');
      if (!rawModel || opts.aiCreditsRouting?.active)
        throw new Error(
          'Choose a GitHub Copilot model to use Copilot account billing.',
        );
      const serverMode =
        opts.assistantMode === 'app-advisor' && opts.appAdvisorRuntime
          ? ('app-advisor' as const)
          : ('default' as const);
      if (
        opts.assistantMode &&
        opts.assistantMode !== 'default' &&
        serverMode !== 'app-advisor'
      )
        throw new Error('Copilot is not available for this assistant surface.');
      const runtime = await getCopilotWorkerRuntime().openSessionRuntime(
        'CopilotSession.run',
        { signal: abort.signal, cwd: opts.cwd, workspaceId: opts.projectId },
      );
      const proxy = getMcpHttpProxyService();
      const receipts = new CopilotToolReceipts();
      const turnEmit = (event: Record<string, unknown>): void | Promise<void> =>
        emit(event, userMessageId);
      let turnFailed = false;
      try {
        const availableModel = await assertCopilotModelAvailable(
          turnModel,
          abort.signal,
        );
        assertCopilotConnectionGeneration(runtime.generation);
        const target =
          (opts.projectId === STANDALONE_CHAT_PROJECT_ID
            ? resolveWorktreeTargetIds(opts.projectId, opts.worktreeId)
            : null) ?? opts;
        const profile = join(
          getWorktreeDataDir(target.projectId, target.worktreeId),
          'copilot-sessions',
          createHash('sha256')
            .update(JSON.stringify([key, opts.cwd]))
            .digest('hex'),
        );
        await mkdir(profile, { recursive: true, mode: 0o700 });
        const bindingFile = join(profile, 'host-session.json');
        const notice = async (suffix: string, text: string): Promise<void> => {
          await turnEmit({
            type: 'canopy_assistant_patch',
            messageId: `${turnId}:${suffix}`,
            timestamp: Date.now(),
            revision: 1,
            role: 'system',
            patches: [{ index: 0, block: { type: 'text', text } }],
          });
        };
        const recoverSession = async (): Promise<void> => {
          sessionId = undefined;
          await notice(
            'lost-context',
            'Copilot could not restore the previous conversation. Starting a new conversation with your current message; earlier context is unavailable.',
          );
        };
        let previousCapabilityDigests: { host?: string; native?: string } = {};
        if (sessionId) {
          let contents: string | undefined;
          try {
            contents = await readFile(bindingFile, 'utf8');
          } catch (error) {
            if (
              !error ||
              typeof error !== 'object' ||
              !('code' in error) ||
              error.code !== 'ENOENT'
            )
              throw error;
            await recoverSession();
          }
          if (contents !== undefined) {
            const binding: unknown = JSON.parse(contents);
            previousCapabilityDigests = readCapabilityDigests(
              binding,
              sessionId,
              runtime.account,
            );
          }
        }
        const currentApproval = createApprovalSession({
          sessionKey: key,
          getTurnUserMessageId: () => userMessageId,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          provider: 'copilot',
          workspaceRoot: opts.cwd,
          mode: approvalMode,
          sessionRules: opts.sessionApprovalRules ?? [],
          getWindow,
          promptTimeoutMs: 60_000,
        });
        approval = currentApproval;
        // Copilot layers Claude Code's plugins on top of the selection, so it
        // needs the chat's opt-outs even when no default layer applies.
        const context = await resolveEffectiveChatPluginContext(
          opts.pluginSelections,
          opts,
          requestChatTombstones(opts.applyGlobalPluginDefaults),
        );
        const preferences =
          context.preferences ?? (await readPreferencesFile());
        // The user's own home-folder skills and commands, and the plugins
        // enabled in Claude Code, read the way a Cursor chat reads them
        // (design: 2026-10-05-cursor-inherited-capabilities). A broken home
        // folder must not stop the chat: a failed discovery inherits nothing.
        const { inherited, inheritedPluginRefs } =
          await discoverHomeCapabilities({
            cwd: opts.cwd,
            selections: context.selections,
            tombstones: context.chatTombstones,
            signal: abort.signal,
          });
        const inheritedNotices: string[] = [];
        for (const entry of inherited.skipped) {
          // eslint-disable-next-line no-console
          console.warn(
            '[copilot-inherited-capabilities]',
            `${entry.label}: ${entry.reason}`,
          );
        }
        if (inherited.skipped.length > 0) {
          const text = `Some of your Copilot skills or commands could not be loaded: ${inherited.skipped
            .map((entry) => entry.label)
            .join(', ')}.`;
          if (!announcedNotices.has(text)) {
            announcedNotices.add(text);
            inheritedNotices.push(text);
          }
        }
        if (inherited.fingerprint !== lastInheritedFingerprint) {
          lastInheritedFingerprint = inherited.fingerprint;
          refreshInvocableInventoryAfterMutation(
            'copilot-inherited-capabilities',
          );
        }
        // Plugins enabled in Claude Code join resolution as inherited refs,
        // each read from the folder Claude Code installed, so their MCP
        // servers keep going through the proxy and approvals.
        const hasInherited =
          inherited.skills.length > 0 ||
          inherited.commands.length > 0 ||
          inheritedPluginRefs.length > 0;
        const resolved =
          hasAnySelections(context.selections) ||
          hasInherited ||
          opts.packageOverlay
            ? await resolvePlugins(
                context.selections,
                opts.projectId,
                opts.worktreeId,
                opts.chatId,
                {
                  purpose: 'copilot-session',
                  installExternalPlugins: true,
                  enableHttpMcpProxy: true,
                  mcpHttpProxyService: proxy,
                  sessionId: key,
                  packageOverlay: opts.packageOverlay,
                  preferences: context.preferences,
                  ...(opts.accountResolution
                    ? { accountResolution: opts.accountResolution }
                    : {}),
                  inheritedCursorCapabilities: inherited,
                  ...(inheritedPluginRefs.length > 0
                    ? { inheritedPluginRefs }
                    : {}),
                },
              )
            : undefined;
        const capabilities =
          resolved?.cursorCapabilities ?? emptyCursorCapabilityProjection();
        const capabilityRoot = join(profile, 'selected-capabilities');
        const prepared = await materializeSelectedCapabilityRoot(
          capabilityRoot,
          capabilities,
          { verifyContent: true, signal: abort.signal },
        );
        inheritedCapabilityOverlay = undefined;
        if (managedDelegation) {
          const captured = await captureHomeCapabilities({
            root: capabilityRoot,
            projection: capabilities,
            inheritedPluginBindings: resolved?.inheritedPluginBindings,
            prepared,
            signal: abort.signal,
          });
          inheritedCapabilityOverlay = captured.overlay;
          if (captured.skipped.length) {
            const text = `Some home capabilities could not be passed to delegates: ${Array.from(new Set(captured.skipped)).join(', ')}.`;
            if (!announcedNotices.has(text)) {
              announcedNotices.add(text);
              // Child inheritance diagnostics do not belong in the parent chat.
              logMainProcessWarn('[copilot-delegation-capabilities]', text);
            }
          }
        }
        // Resolver warnings go to the log, as a Cursor chat's do; the notices
        // meant for the user show once per session, since an inherited plugin
        // that adds nothing would otherwise repeat on every turn.
        for (const warning of resolved?.warnings ?? []) {
          // eslint-disable-next-line no-console
          console.warn('[copilot-plugin-resolver]', warning);
        }
        const warnings = [
          ...inheritedNotices,
          ...[...(resolved?.cursorNotices ?? []), ...prepared.warnings].filter(
            (notice) => {
              if (announcedNotices.has(notice)) return false;
              announcedNotices.add(notice);
              return true;
            },
          ),
        ].map((warning) => warning.split('Cursor').join('Copilot'));
        if (warnings.length)
          await turnEmit({
            type: 'canopy_assistant_patch',
            messageId: `${turnId}:capabilities`,
            timestamp: Date.now(),
            revision: 1,
            role: 'system',
            patches: [
              { index: 0, block: { type: 'text', text: warnings.join('\n') } },
            ],
          });
        const deferredToolsAllowed = opts.deferredToolsAllowed !== false;
        const names = cursorCanopyMcpServerNames(serverMode);
        // The app's own tool servers carry the injected tools the prompt
        // relies on, so losing them fails the turn. Any other selected server
        // sits out with a notice naming it, as it would in a Claude, Codex or
        // Cursor chat, and rejoins on the next turn once it connects.
        const reportMcpReadiness = async (
          readiness: readonly CopilotMcpServerReadiness[],
        ): Promise<boolean> => {
          const unavailable = readiness.filter(
            (server) => server.status !== 'connected',
          );
          // Checked before anything is compared or remembered, so failing
          // closed never depends on what an earlier turn committed.
          if (
            unavailable.some(
              (server) =>
                server.name === names.main || server.name === names.ui,
            )
          )
            throw new Error(
              "Couldn't connect to the app's tools for Copilot. Send again.",
            );
          const current = new Map(
            unavailable.map((server) => [server.name, server.status] as const),
          );
          const previous = previousUnavailableMcp;
          const changed =
            current.size !== previous.size ||
            Array.from(current).some(
              ([name, status]) => previous.get(name) !== status,
            );
          // The sat-out set is unchanged, so it explains no digest change and
          // there is nothing new to say.
          if (!changed) return false;
          // A bound connection carries its display name; a managed name from
          // the resolver shows its friendly part, never its prefix or digest.
          const label = (name: string): string => {
            const binding = resolved?.mcpServerBindings[name];
            return (
              binding?.displayName ??
              managedMcpServerFriendlyLabel(name) ??
              name
            );
          };
          const secretValues = collectCopilotMcpSecretValues(servers);
          const reasons = new Map(
            unavailable.map(
              (server) =>
                [
                  server.name,
                  describeCopilotMcpServerError(server.error, secretValues),
                ] as const,
            ),
          );
          for (const server of unavailable) {
            const reason = reasons.get(server.name);
            // The log keeps the raw server id for diagnostics; only the
            // notice uses the friendly label.
            // eslint-disable-next-line no-console
            console.warn(
              '[copilot-mcp]',
              `MCP server "${server.name}" is ${server.status}${reason ? `: ${reason}` : ''}.`,
            );
          }
          const status = new Map(
            readiness.map((server) => [server.name, server.status] as const),
          );
          const recovered = Array.from(previous.keys())
            .filter((name) => status.get(name) === 'connected')
            .map(label);
          const needsSignIn = unavailable
            .filter((server) => server.status === 'needs-auth')
            .map((server) => label(server.name));
          // Statuses with a line of their own; anything else reads as a
          // connection the user can retry.
          const explained = new Set<string>([
            'needs-auth',
            'disabled',
            'stopped',
            'not_configured',
          ]);
          const lines = [
            ...(needsSignIn.length === 1
              ? [
                  `${needsSignIn[0]} needs sign-in. Connect it in the Activity panel to use its tools.`,
                ]
              : needsSignIn.length > 1
                ? [
                    `${listNames(needsSignIn)} need sign-in. Connect them in the Activity panel to use their tools.`,
                  ]
                : []),
            ...unavailable
              .filter((server) => server.status === 'disabled')
              .map(
                (server) =>
                  `${label(server.name)} is turned off. Copilot is continuing without its tools.`,
              ),
            ...unavailable
              .filter((server) => server.status === 'stopped')
              .map(
                (server) =>
                  `${label(server.name)} is stopped. Copilot is continuing without its tools.`,
              ),
            ...unavailable
              .filter((server) => server.status === 'not_configured')
              .map(
                (server) =>
                  `${label(server.name)} is not configured for this session. Copilot is continuing without its tools.`,
              ),
            ...unavailable
              .filter((server) => !explained.has(server.status))
              .map((server) => {
                const reason = reasons.get(server.name);
                return `Couldn't connect to the MCP server ${label(server.name)}${reason ? ` (${reason})` : ''}. Copilot is continuing without its tools.`;
              }),
            ...(recovered.length === 1
              ? [`${recovered[0]} is connected again. Its tools are available.`]
              : recovered.length > 1
                ? [
                    `${listNames(recovered)} are connected again. Their tools are available.`,
                  ]
                : []),
          ];
          if (lines.length) await notice('mcp-unavailable', lines.join('\n'));
          // Committed only once the notice is out, so an aborted turn
          // announces again on retry.
          previousUnavailableMcp = current;
          // Only a server joining or leaving the sat-out set moves the bound
          // tool set; a status change between two sat-out states, or a
          // deselected server, does not explain a digest change. The set
          // lives with the session while the digests are persisted, so after
          // an app restart a server that reconnected gets the generic
          // capabilities notice instead of "connected again", and a server
          // joining the set in the same turn as an unrelated tool change
          // suppresses that notice although it explains only part of the
          // change. Both cost one notice, never a tool, so the set stays in
          // memory.
          const joined = Array.from(current.keys()).some(
            (name) => !previous.has(name),
          );
          return lines.length > 0 && (joined || recovered.length > 0);
        };
        // Reuse the existing full interactive MCP tool allowlist and policy.
        const toolSurface = cowork
          ? ('copilot-sdk-standalone' as const)
          : ('copilot-sdk' as const);
        const approved = new CopilotMcpApprovals();
        const receiptRequests = new Map<string, string>();
        const checkMcp = async (
          server: string,
          tool: string,
          args: unknown,
          callId: string,
        ): Promise<boolean> => {
          assertCopilotConnectionGeneration(runtime.generation);
          const outcome = await authorizeCursorMcpTool(
            { server, tool, args },
            {
              approval: currentApproval,
              cwd: opts.cwd,
              toolCallId: `${turnId}:${callId}`,
              planMode,
              mode: serverMode,
              toolSurface,
              signal: abort.signal,
              providerLabel: 'Copilot',
              managedToolNames: managedDelegation?.tools.map(
                (tool) => tool.name,
              ),
            },
          );
          if (outcome.stopTurn) abort.abort();
          return !abort.signal.aborted && outcome.decision === 'allow';
        };
        const gate = async (
          server: string,
          tool: string,
          args: unknown,
          callId: string,
          receiptRequired = false,
        ): Promise<boolean> => {
          assertCopilotConnectionGeneration(runtime.generation);
          if (abort.signal.aborted) return false;
          if (
            server === names.main &&
            isWatchDelegatesCompatibilityName(tool, 'copilot')
          )
            return true;
          const nativeId = approved.take(server, tool, args);
          if (nativeId) {
            if (receiptRequired) {
              if (receiptRequests.size >= 1024 || receiptRequests.has(callId))
                return false;
              receiptRequests.set(callId, nativeId);
            }
            return true;
          }
          // A load without native provenance cannot authorize a restart.
          return !receiptRequired && checkMcp(server, tool, args, callId);
        };
        const token = randomBytes(32).toString('base64url');
        await proxy.registerCanopyWorktreeSessionRoute({
          sessionKey: key,
          projectId: opts.projectId,
          worktreeId: opts.worktreeId,
          chatId: opts.chatId,
          interfaceTools: opts.interfaceTools ?? [],
          assistantMode: opts.assistantMode,
          ...(serverMode === 'app-advisor'
            ? { appAdvisorRuntime: opts.appAdvisorRuntime }
            : {}),
          cwd: opts.cwd,
          repoId: opts.selectedRepoId,
          sdkSessionId: sessionId ?? key,
          providerType: 'copilot',
          // RequestSecrets on the `_ui` server: interactive root chats only,
          // while the flag is on (re-checked per call). Tools only: this
          // provider has no live environment for ambient secrets
          // (agent-secrets/ambient-env.ts).
          ...(serverMode === 'default' &&
          opts.executionContext === undefined &&
          isAgentSecretRequestsEnabled()
            ? {
                secretRequests: true,
                getApprovalMode: (): ApprovalMode => approvalMode,
              }
            : {}),
          model: turnModel,
          authToken: token,
          createdAt: Date.now(),
          hookHandler: () => undefined,
          toolSurface,
          pluginSelections: {
            ...context.selections,
            pluginRefs: [
              ...context.selections.pluginRefs,
              ...inheritedPluginRefs.map(({ marketplaceId, pluginName }) => ({
                marketplaceId,
                pluginName,
              })),
            ],
          },
          deferredToolsAllowed,
          nativeToolResultDelivery: ({ requestId, toolUseId, result }) => {
            const nativeId = receiptRequests.get(requestId);
            receiptRequests.delete(requestId);
            if (!nativeId) return;
            abort.signal.throwIfAborted();
            assertCopilotConnectionGeneration(runtime.generation);
            if (currentTurn !== turnId)
              throw new Error('The Copilot turn has ended.');
            const text = copilotReceiptText(result);
            if (
              text !== undefined &&
              !receipts.expect(nativeId, toolUseId, text)
            )
              throw new Error('Copilot could not verify the tool result.');
          },
          ...(managedDelegation
            ? {
                managedDelegation: {
                  tools: managedDelegation.mcpTools,
                  invoke: async (
                    name,
                    input,
                    transport,
                  ): Promise<{ text: string; isError: boolean }> => {
                    if (
                      !transport?.requestId ||
                      currentTurn !== turnId ||
                      abort.signal.aborted ||
                      !managedDelegation ||
                      !(await gate(
                        names.main,
                        name,
                        input,
                        transport.requestId,
                      ))
                    )
                      return {
                        text: 'The owning Copilot turn is unavailable or the call was denied.',
                        isError: true,
                      };
                    const result = await managedDelegation.parent.invokeCursor(
                      name,
                      input,
                      { callId: transport.requestId, turnId },
                    );
                    return {
                      text: JSON.stringify(result),
                      isError: !result.ok,
                    };
                  },
                },
              }
            : {}),
          codeGraphToolsAdvertised,
          onAwaitingUser: (): void => {
            turnState.markTurnAwaitingUser();
            awaitingUser = true;
            lifecycleProducer.sessionState({
              ...(sessionId ? { providerSessionId: sessionId } : {}),
              state: 'requires_action',
              source: 'provider',
              observedDuringTurnId: turnId,
            });
          },
          autoArchiveAvailable: true,
          authorizeToolCall: (toolKey, args, call) => {
            const tool =
              serverMode === 'app-advisor'
                ? hasToolKey(APP_ADVISOR_TOOL_REGISTRY, toolKey)
                  ? APP_ADVISOR_TOOL_REGISTRY[toolKey].displayName
                  : undefined
                : hasToolKey(CANOPY_INJECTED_TOOL_REGISTRY, toolKey)
                  ? CANOPY_INJECTED_TOOL_REGISTRY[toolKey].displayName
                  : undefined;
            return tool
              ? gate(
                  toolKey === 'ask_user_question' ||
                    toolKey === 'request_secrets'
                    ? names.ui
                    : names.main,
                  tool,
                  args,
                  call?.requestId ?? randomUUID(),
                  toolKey === 'load_deferred_tools',
                )
              : Promise.resolve(false);
          },
        });
        const servers = buildCopilotMcpServers({
          mode: serverMode,
          mainUrl: proxy.getCanopyWorktreeMcpUrl(key),
          uiUrl: proxy.getCanopyWorktreeUiMcpUrl(key),
          authToken: token,
          definitions: resolved?.mcpServers ?? {},
          cwd: opts.cwd,
        });
        const serverByUrl = new Map(
          Object.entries(servers).flatMap(([server, config]) =>
            'url' in config ? [[config.url, server] as const] : [],
          ),
        );
        proxy.setSessionToolCallGate(key, (call) => {
          const server = serverByUrl.get(call.proxyUrl);
          return server
            ? gate(server, call.tool, call.args, call.requestId ?? randomUUID())
            : Promise.resolve(false);
        });
        const correlation = new CopilotToolCorrelation();
        const nativeQuestions: Array<{ id: string; question: string }> = [];
        const declared = availableModel.supportedThinkingLevels ?? [];
        const level =
          thinking !== undefined && declared.length
            ? clampThinkingLevelToDeclared(thinking, declared)
            : undefined;
        const expanded = expandLeadingCursorCommand(
          prompt,
          capabilities.commands.filter((command) =>
            prepared.commandIds.includes(command.id),
          ),
        );
        const memoryPolicy = await resolveLocalMemoryPolicy(opts);
        let nativeToolSnapshot: CopilotCapabilitySnapshot | undefined;
        let inheritedContext = '';
        const userPrompt =
          managedDelegation?.applyPolicyGuidance(expanded) ?? expanded;
        const config: CopilotTurnRequest = {
          workingDirectory: opts.cwd,
          configDirectory: profile,
          model: rawModel,
          turnId,
          sessionId,
          onSessionUnavailable: recoverSession,
          signal: abort.signal,
          // The pinned SDK accepts low through max, but not off or ultra.
          reasoningEffort:
            level === 'off' || level === 'ultra' ? undefined : level,
          prompt: userPrompt,
          preparePrompt: async (id) => {
            inheritedContext = await forkContext.prompt(
              profile,
              id,
              userMessageId,
            );
            abort.signal.throwIfAborted();
            assertCopilotConnectionGeneration(runtime.generation);
            return inheritedContext
              ? `${inheritedContext}\n\n${userPrompt}`
              : userPrompt;
          },
          onPromptAccepted: async (id) => {
            if (inheritedContext) await forkContext.delivered(profile, id);
          },
          systemPrompt: [
            managedDelegation?.systemPromptGuidance,
            opts.globalInstructionsSnapshot ?? opts.globalInstructionsBlock,
            opts.systemPromptAppend,
            serverMode === 'app-advisor'
              ? 'Use the supplied Orchestrator tools to help with the app.'
              : cowork
                ? buildCoworkInjectedToolPrompt(
                    'copilot',
                    false,
                    deferredToolsAllowed,
                  )
                : buildWorktreeInjectedToolPrompt(
                    'copilot',
                    codeGraphToolsAdvertised,
                    true,
                    false,
                    deferredToolsAllowed,
                  ),
            serverMode === 'default'
              ? buildLocalMemoryPromptNudge(
                  preferences.localMemoryEnabled === true,
                  memoryPolicy.kind === 'scoped' && memoryPolicy.privateMemory,
                )
              : undefined,
            planMode
              ? 'Plan mode is read-only. Do not change files or run shell commands.'
              : '',
            'Use the supplied app tools directly. Native subagents, background scheduling, remote sessions, and plugin installation are unavailable. Do not work around denied operations.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          skillDirectories: prepared.skillIds.length
            ? [join(capabilityRoot, 'skills')]
            : [],
          mcpServers: servers,
          emit: turnEmit,
          onEvent: (event) => {
            correlation.observe(event);
            const toolUseId = receipts.observe(event);
            if (!toolUseId || abort.signal.aborted || currentTurn !== turnId)
              return;
            assertCopilotConnectionGeneration(runtime.generation);
            if (
              getCopilotWorkerRuntime().acknowledgeToolResult(
                {
                  projectId: opts.projectId,
                  worktreeId: opts.worktreeId,
                  chatId: opts.chatId,
                },
                toolUseId,
              )
            ) {
              // The SDK observer cannot backpressure native execution. Stop
              // this turn now; the existing coordinator owns the continuation.
              abort.abort(
                new DOMException(
                  'Copilot capabilities are reloading.',
                  'AbortError',
                ),
              );
            }
          },
          onToolsReady: async (snapshot, mcpReadiness) => {
            abort.signal.throwIfAborted();
            assertCopilotConnectionGeneration(runtime.generation);
            const mcpExplainsDigest = await reportMcpReadiness(mcpReadiness);
            const hostChanged = Boolean(
              previousCapabilityDigests.host &&
              previousCapabilityDigests.host !== capabilitySnapshot.digest,
            );
            // The bound tool set shrinks or grows with the servers that
            // connected; the MCP notice already explains that, so the generic
            // notice is for everything else.
            const nativeChanged = Boolean(
              previousCapabilityDigests.native &&
              previousCapabilityDigests.native !== snapshot.digest,
            );
            if (hostChanged || (nativeChanged && !mcpExplainsDigest))
              await notice(
                'capabilities-changed',
                'Selected capabilities changed. Copilot is continuing with the current skills and tools.',
              );
            nativeToolSnapshot = snapshot;
          },
          onSession: async (id) => {
            if (!nativeToolSnapshot)
              throw new Error(
                'Copilot could not verify the initialized tool list.',
              );
            const temporary = `${bindingFile}.${randomUUID()}.tmp`;
            try {
              await writeFile(
                temporary,
                JSON.stringify({
                  version: 2,
                  runtimeVersion: COPILOT_RUNTIME_VERSION,
                  nativeToolSnapshot,
                  sessionId: id,
                  account: runtime.account,
                  capabilitySnapshot,
                }),
                { mode: 0o600, flag: 'wx' },
              );
              abort.signal.throwIfAborted();
              assertCopilotConnectionGeneration(runtime.generation);
              await rename(temporary, bindingFile);
            } finally {
              await rm(temporary, { force: true });
            }
            sessionId = id;
            await turnEmit({
              type: 'system',
              subtype: 'init',
              session_id: id,
              model: turnModel,
            });
          },
          authorize: async (input) => {
            assertCopilotConnectionGeneration(runtime.generation);
            const identity = correlation.take(input.toolName, input.toolArgs);
            if (
              input.toolName === 'ask_user' &&
              identity &&
              input.toolArgs &&
              typeof input.toolArgs === 'object' &&
              'question' in input.toolArgs &&
              typeof input.toolArgs.question === 'string'
            ) {
              if (nativeQuestions.length >= 32) return { decision: 'deny' };
              nativeQuestions.push({
                id: `${turnId}:${identity.id}`,
                question: input.toolArgs.question,
              });
            }
            if (identity?.server && identity.tool) {
              const server = servers[identity.server];
              if (!server)
                return {
                  decision: 'deny',
                  message: 'This MCP server is not available in this chat.',
                };
              const allowed = await checkMcp(
                identity.server,
                identity.tool,
                input.toolArgs,
                identity.id,
              );
              if (
                allowed &&
                'url' in server &&
                !approved.approve(
                  identity.id,
                  identity.server,
                  identity.tool,
                  input.toolArgs,
                )
              )
                return { decision: 'deny' };
              return { decision: allowed ? 'allow' : 'deny' };
            }
            const outcome = await authorizeCopilotNativeTool(input, {
              cwd: opts.cwd,
              approval: currentApproval,
              planMode,
              signal: abort.signal,
              toolUseId: `${turnId}:${identity?.id ?? randomUUID()}`,
            });
            if (outcome.stopTurn) abort.abort();
            if (
              outcome.decision === 'allow' &&
              !outcome.stopTurn &&
              rtkEnabled &&
              input.toolName === 'bash' &&
              input.toolArgs &&
              typeof input.toolArgs === 'object' &&
              'command' in input.toolArgs &&
              typeof input.toolArgs.command === 'string'
            ) {
              const command = await runRtkRewrite(
                input.toolArgs.command,
                {
                  rtkBinaryPath: getBundledRtkBinaryPath(),
                  env: {
                    ...getEnhancedEnv({
                      includeCanopySecrets: false,
                      environment: false,
                    }),
                    ...getRtkManagedEnv(),
                  },
                },
                abort.signal,
              );
              if (command)
                return {
                  ...outcome,
                  modifiedArgs: { ...input.toolArgs, command },
                };
            }
            return outcome;
          },
          onUserInputRequest: async (request) => {
            assertCopilotConnectionGeneration(runtime.generation);
            const index = nativeQuestions.findIndex(
              (entry) => entry.question === request.question,
            );
            if (index < 0)
              throw new Error(
                'Copilot question could not be matched to its tool call.',
              );
            const [question] = nativeQuestions.splice(index, 1);
            const answers = await requestAnswersFromRenderer({
              toolUseId: question.id,
              sessionKey: key,
              projectId: opts.projectId,
              worktreeId: opts.worktreeId,
              chatId: opts.chatId,
              getWindow,
              providerType: 'copilot',
              model: turnModel,
              signal: abort.signal,
              onAwaitingUser: (): void => {
                turnState.markTurnAwaitingUser();
                awaitingUser = true;
                lifecycleProducer.sessionState({
                  ...(sessionId ? { providerSessionId: sessionId } : {}),
                  state: 'requires_action',
                  source: 'provider',
                  observedDuringTurnId: turnId,
                });
              },
              questions: [
                {
                  question: request.question,
                  options: request.choices ?? [],
                  allowOther: request.allowFreeform !== false,
                },
              ],
            });
            abort.signal.throwIfAborted();
            turnState.markTurnActive(userMessageId);
            if (awaitingUser) {
              awaitingUser = false;
              lifecycleProducer.sessionState({
                ...(sessionId ? { providerSessionId: sessionId } : {}),
                state: 'running',
                source: 'provider',
                observedDuringTurnId: turnId,
              });
            }
            return copilotUserInputAnswer(answers[0]);
          },
        };
        const capabilitySnapshot = createCopilotCapabilitySnapshot({
          selections: context.selections,
          packageDigest: opts.packageOverlay?.packageDigest,
          materialized: prepared.fingerprint,
          skills: prepared.skillIds,
          commands: capabilities.commands.filter((command) =>
            prepared.commandIds.includes(command.id),
          ),
          mcp: proxy.getMcpCapabilityDigests(
            Object.fromEntries(
              Object.entries(servers).filter(
                ([name]) => name !== names.main && name !== names.ui,
              ),
            ),
          ),
          nativeTools: COPILOT_NATIVE_TOOLS,
          toolSurface,
          appTools: proxy.getCanopyCapabilityDefinitions(key),
          managedTools: managedDelegation?.mcpTools ?? [],
          systemPrompt: config.systemPrompt,
          discovery: deferredToolsAllowed
            ? 'installed-catalog'
            : 'explicit-only',
          mcpTable: 'complete-replacement-per-turn',
        });
        const result = await runtime.runTurn(config);
        return {
          type: 'result',
          is_error: false,
          result: result.text,
          usage: result.usage,
        };
      } catch (error) {
        turnFailed = true;
        throw error;
      } finally {
        receipts.close();
        approval?.invalidatePending?.();
        approval?.dispose();
        approval = undefined;
        if (turnState.ownsKeyResources()) {
          proxy.unregisterRoutesForSession(key);
          proxy.unregisterCanopyWorktreeSessionRoute(key);
        }
        try {
          await runtime.close();
        } catch (error) {
          handleCopilotTurnCleanupError(error, turnFailed);
        }
      }
    };

    const session: AgentSession = {
      sendMessage(text, sendOptions): void {
        if (lifetime.signal.aborted)
          throw new Error('Copilot session has ended.');
        if (active)
          throw new Error('Wait for the current Copilot turn to finish.');
        const abort = new AbortController();
        const turnId =
          sendOptions?.lifecycleExecutionId ??
          sendOptions?.userMessageId ??
          randomUUID();
        currentTurn = turnId;
        const startedAtMs = Date.now();
        const lifecycleBinding: TurnBinding = {
          turnId,
          origin: 'user',
          binding: sendOptions?.userMessageId ? 'bound' : 'unbound',
          submissionIds: [],
          userMessageIds: sendOptions?.userMessageId
            ? [sendOptions.userMessageId]
            : [],
          providerUserMessageUuids: [],
        };
        awaitingUser = false;
        const buffer = new CursorEventBuffer(async (event) => {
          await onEvent(event);
          await drainChatSessionEvents(
            opts.projectId,
            opts.worktreeId,
            opts.chatId,
          );
        });
        output = buffer;
        turnState.markTurnActive(sendOptions?.userMessageId);
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
            turnId,
          );
        lifecycleProducer.sessionState({
          ...(sessionId ? { providerSessionId: sessionId } : {}),
          state: 'running',
          source: 'provider',
          observedDuringTurnId: turnId,
        });
        const done = run(text, turnId, abort, sendOptions?.userMessageId)
          .catch((error: unknown) => ({
            type: 'result',
            is_error: !abort.signal.aborted,
            result: abort.signal.aborted
              ? 'Turn cancelled'
              : error instanceof Error
                ? error.message
                : 'Copilot chat failed.',
            ...(abort.signal.aborted ? { subtype: 'cancelled' } : {}),
          }))
          .then(async (result) => {
            await buffer.flush();
            await drainChatSessionEvents(
              opts.projectId,
              opts.worktreeId,
              opts.chatId,
            );
            return result;
          })
          .catch((error: unknown) => ({
            type: 'result',
            is_error: true,
            result:
              error instanceof Error
                ? error.message
                : 'Copilot output could not be saved.',
          }))
          .then(async (result: Record<string, unknown>) => {
            active = undefined;
            output = undefined;
            turnState.markTurnIdle();
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
              observedDuringTurnId: turnId,
            });
            await emit(
              result.is_error
                ? { type: 'error', error: result.result }
                : result,
              sendOptions?.userMessageId,
            );
          });
        active = { abort, done };
      },
      isDisposed: () => lifetime.signal.aborted,
      getProviderSessionId: () => sessionId,
      cancel: async () => {
        const turn = active;
        turn?.abort.abort();
        approval?.invalidatePending?.();
        managedDelegation?.retireTurn();
        await turn?.done;
      },
      destroy: async () => {
        lifetime.abort();
        try {
          await session.cancel();
          managedDelegation?.detach();
        } finally {
          if (!lifecycleProducerReleased) {
            lifecycleProducerReleased = true;
            releaseTurnLifecycleProducer('copilot', lifecycleScope);
          }
        }
      },
      setManagedDelegationMode: (mode): Promise<void> => {
        opts.managedDelegationMode = mode;
        if (mode !== undefined) managedDelegation?.updatePolicy(mode);
        return Promise.resolve();
      },
      setRtkEnabled: (enabled): Promise<void> => {
        rtkEnabled = enabled;
        return Promise.resolve();
      },
      setPlanMode: (enabled): Promise<void> => {
        if (active)
          return Promise.reject(
            new Error('Stop Copilot before changing plan mode.'),
          );
        planMode = enabled;
        return Promise.resolve();
      },
      setApprovalMode: (mode): Promise<void> => {
        approvalMode = mode;
        approval?.setMode(mode);
        return Promise.resolve();
      },
      setThinkingLevel: (level): Promise<void> => {
        thinking = level;
        return Promise.resolve();
      },
      setModel: (next): Promise<void> => {
        if (!isCopilotModel(next))
          return Promise.reject(new Error('Choose a GitHub Copilot model.'));
        model = next;
        return Promise.resolve();
      },
    };
    registerSession(
      key,
      session,
      lifetime,
      'copilot',
      opts.model,
      opts.assistantMode,
      opts.toolProfileHash,
      codeGraphToolsAdvertised,
      'copilot',
    );
    return session;
  }
}
