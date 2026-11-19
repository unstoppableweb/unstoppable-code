import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildClaudeThinkingOptions,
  clampThinkingLevelForModel,
  DEFAULT_CLAUDE_MODEL,
  hasAnySelections,
  type ApprovalMode,
  type ChatModel,
  type ChatTabPluginSelections,
  type ThinkingLevel,
} from '@canopy/desktop-shared/types';
import { chatSurfaceUsesGlobalPluginDefaults } from '@canopy/desktop-shared/lib/effective-plugin-selections';
import type { SettingSource } from '@anthropic-ai/claude-agent-sdk';
import { BRAND } from '@canopy/brand/current';
import {
  brandEnvName,
  brandEnvCandidates,
} from '@canopy/execution-engine/brand/env';
import {
  getBundledClaudeBinaryPath,
  getBundledRgBinaryPath,
  getBundledRtkBinaryPath,
  getRtkManagedEnv,
} from '../pipelines/config-paths';
import {
  DESKTOP_INTEGRATION_HOOK_SCRIPT_FILENAME,
  DESKTOP_INTEGRATION_TOKEN_ENV_VAR,
} from '@canopy/desktop-shared/lib/desktop-integration-transport';
import { resolvePlugins } from '../plugins/plugin-resolver';
import { resolveEffectiveChatPluginContext } from '../plugins/global-plugin-overlay';
import { getDesktopIntegrationServer } from './desktop-integration-server';
import { getDesktopNodeRuntime } from '../lib/node-runtime';
import {
  isModelBlockedByStoredPolicy,
  isOrgModelPolicyActiveForStoredAccount,
} from '../lib/model-policy-state';
import { nativeMemorySettingsOverride } from '@canopy/execution-engine/node/lib/native-memory';
import { readLocalMemoryEnabledPreference } from '../lib/preferences-store';
import {
  buildClaudeTerminalHookCallbackScript,
  buildPosixNodeStub,
  buildWindowsNodeStub,
} from './claude-terminal-hooks';
import { buildRtkHookWrapperScript } from './rtk-hook-wrapper';
import { resolveSessionWorkOwner } from '../agents/work-owner';
import { claudeManagedSettingsGuard } from '../agents/claude-managed-settings';
import { resolveClaudeModAdmissionContext } from '../agents/claude-mod-admission-launch';
import { desktopTerminalEnvironmentFor } from '../terminal/worker-terminal';
import {
  mergeClaudeModAdmissionSettings,
  type ClaudeModAdmissionSettings,
} from '@canopy/execution-engine/node/plugins/claude-mod-admission';
import type { SkippedClaudeMod } from '@canopy/execution-engine/types/claude-mod-admission';

/**
 * `input.model` is pushed straight into the Claude Code CLI as `--model`, so
 * this is the only place a managed-terminal session can be held to an
 * organization model policy. The renderer's model registry reconciliation is a
 * best-effort UI filter on a 20-minute re-probe, not a control.
 *
 * Refusal is a throw: the launch is interactive and both callers already treat a
 * build failure as a clean, recoverable session error (route teardown, runtime
 * dir removal, `turnState: 'error'`), so nothing is left half-created. This
 * mirrors the interactive gate in `agents/session-manager.ts`.
 */
const CLAUDE_TERMINAL_MODEL_POLICY_REFUSAL =
  'This model is blocked by your organization policy.';

const RUNTIME_DIR_MODE = 0o700;
const TOKEN_FILE_MODE = 0o600;
const TERMINAL_MCP_ENTRY_NAME = BRAND.tools.namespace;
const TERMINAL_MCP_CONFLICT_SUFFIX = 'resolved';
export const CLAUDE_TERMINAL_APPROVAL_HOOK_TIMEOUT_SECONDS = 600;
export const CLAUDE_TERMINAL_APPROVAL_PROMPT_TIMEOUT_MS =
  (CLAUDE_TERMINAL_APPROVAL_HOOK_TIMEOUT_SECONDS - 10) * 1000;

export interface ClaudeTerminalLaunchConfigInput {
  projectId: string;
  worktreeId: string;
  chatId: string;
  cwd: string;
  runtimeDir: string;
  sessionKey: string;
  authToken: string;
  sdkSessionId: string;
  resumeExistingSession: boolean;
  planMode?: boolean;
  approvalMode?: ApprovalMode;
  permission?: ClaudeTerminalPermission;
  settingSources?: SettingSource[];
  maxTurns?: number;
  model?: ChatModel;
  thinkingLevel?: ThinkingLevel;
  systemPromptAppend?: string;
  initialPrompt?: string;
  pluginSelections?: ChatTabPluginSelections;
  rtkEnabled?: boolean;
  preventClaudeNativeCaffeinate?: boolean;
  canopyMcpServerName?: string;
  mcpServers?: Record<string, unknown>;
  claudeEnvOverride?: Record<string, string>;
  /** Install the Canopy approval callback only when the caller owns a session. */
  approvalHookEnabled?: boolean;
}

export interface ClaudeTerminalPermission {
  permissionMode?: 'plan' | 'bypassPermissions' | 'acceptEdits';
  allowDangerouslySkipPermissions?: boolean;
  /**
   * Built-in tools available for the session (CLI `--tools`). Enforces
   * read-only by construction (omit Edit/Write/Bash) so it composes with
   * `bypassPermissions`. `[]` disables all built-ins; undefined exposes the
   * full set.
   */
  tools?: string[];
  allowedTools?: string[];
  disallowedTools?: string[];
}

export interface ClaudeTerminalLaunchConfig {
  executable: string;
  args: string[];
  env: Record<string, string>;
  pathPrepend?: string[];
  cwd: string;
  runtimeDir: string;
  settingsPath: string;
  mcpConfigPath: string;
  sessionKey: string;
  authToken: string;
  sdkSessionId: string;
  claudeModAdmission?: {
    settings?: ClaudeModAdmissionSettings;
    skippedMods: readonly SkippedClaudeMod[];
  };
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function quoteCommandPath(filePath: string): string {
  return process.platform === 'win32'
    ? `"${filePath}"`
    : quotePosixShellArg(filePath);
}

function stubNames(base: string): { js: string; stub: string } {
  return {
    js: `${base}.js`,
    stub: process.platform === 'win32' ? `${base}.cmd` : `${base}.sh`,
  };
}

async function writeHookScriptPair(input: {
  runtimeDir: string;
  baseName: string;
  jsSource: string;
  nodePath: string;
}): Promise<string> {
  const names = stubNames(input.baseName);
  const jsPath = path.join(input.runtimeDir, names.js);
  const stubPath = path.join(input.runtimeDir, names.stub);
  await writeFile(jsPath, input.jsSource, 'utf8');
  await writeFile(
    stubPath,
    hostOperatingSystem() === 'win32'
      ? buildWindowsNodeStub(names.js, input.nodePath)
      : buildPosixNodeStub(names.js, input.nodePath),
    'utf8',
  );
  if (process.platform !== 'win32') {
    await chmod(stubPath, 0o755);
  }
  return stubPath;
}

async function chmodIfSupported(filePath: string, mode: number): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  try {
    await chmod(filePath, mode);
  } catch {
    // chmod may be unavailable or partially mapped in packaged environments.
  }
}

async function writeNoopCaffeinateShim(runtimeDir: string): Promise<string[]> {
  if (process.platform !== 'darwin') {
    return [];
  }
  const shimDir = path.join(runtimeDir, 'bin');
  const shimPath = path.join(shimDir, 'caffeinate');
  await mkdir(shimDir, { recursive: true, mode: RUNTIME_DIR_MODE });
  await writeFile(shimPath, '#!/bin/sh\nexit 0\n', 'utf8');
  await chmodIfSupported(shimPath, 0o755);
  return [shimDir];
}

function buildSettings(
  callbackStub: string,
  rtkStub: string,
  requireNativeApprovalFallback: boolean,
  approvalHookEnabled: boolean,
  localMemoryEnabled: boolean,
): Record<string, unknown> {
  const callback = (event: string): string =>
    `${quoteCommandPath(callbackStub)} ${event}`;
  return {
    // Suppresses harness-native auto-memory only while the opt-in local
    // memory preference is enabled (CAN-1969).
    ...nativeMemorySettingsOverride(localMemoryEnabled),
    permissions: {
      // This flag-tier rule outranks repository permission allowlists. It is a
      // fail-closed fallback if repository settings disable the Canopy hook.
      ...(requireNativeApprovalFallback ? { ask: ['*'] } : {}),
      skipDangerousModePermissionPrompt: true,
    },
    hooks: {
      SessionStart: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('SessionStart'), timeout: 5 },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          matcher: '*',
          hooks: [
            {
              type: 'command',
              command: callback('UserPromptSubmit'),
              timeout: 5,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: quoteCommandPath(rtkStub), timeout: 2 },
          ],
        },
        ...(approvalHookEnabled
          ? [
              {
                matcher: '*',
                hooks: [
                  {
                    type: 'command',
                    command: callback('PreToolUse'),
                    timeout: CLAUDE_TERMINAL_APPROVAL_HOOK_TIMEOUT_SECONDS,
                  },
                ],
              },
            ]
          : []),
      ],
      PostToolUse: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('PostToolUse'), timeout: 5 },
          ],
        },
      ],
      Stop: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: callback('Stop'), timeout: 10 }],
        },
      ],
      StopFailure: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('StopFailure'), timeout: 10 },
          ],
        },
      ],
      SubagentStart: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('SubagentStart'), timeout: 5 },
          ],
        },
      ],
      SubagentStop: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('SubagentStop'), timeout: 10 },
          ],
        },
      ],
      Notification: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('Notification'), timeout: 5 },
          ],
        },
      ],
      SessionEnd: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('SessionEnd'), timeout: 10 },
          ],
        },
      ],
      PostCompact: [
        {
          matcher: '*',
          hooks: [
            { type: 'command', command: callback('PostCompact'), timeout: 10 },
          ],
        },
      ],
    },
    sandbox: {
      ripgrep: {
        command: getBundledRgBinaryPath(),
      },
    },
  };
}

function resolvePermission(
  input: ClaudeTerminalLaunchConfigInput,
): Required<Pick<ClaudeTerminalPermission, 'allowDangerouslySkipPermissions'>> &
  Omit<ClaudeTerminalPermission, 'allowDangerouslySkipPermissions'> {
  if (input.permission) {
    return {
      allowDangerouslySkipPermissions: false,
      ...input.permission,
    };
  }
  const approvalMode = input.approvalMode ?? 'ask';
  if (input.planMode) {
    return {
      permissionMode: 'plan',
      allowDangerouslySkipPermissions: false,
    };
  }
  // Terminal tool decisions are returned by the Canopy PreToolUse hook.
  // Keep Claude's native bypass/accept modes disabled so they cannot skip the
  // application policy session.
  void approvalMode;
  return { allowDangerouslySkipPermissions: false };
}

function buildMcpConfig(input: {
  appMcpUrl: string;
  authToken: string;
  resolvedMcpServers: Record<string, unknown>;
  canopyServerName?: string;
}): Record<string, unknown> {
  const canopyServerName = input.canopyServerName ?? TERMINAL_MCP_ENTRY_NAME;
  const mcpServers: Record<string, unknown> = {
    [canopyServerName]: {
      type: 'http',
      url: input.appMcpUrl,
      headers: {
        Authorization: `Bearer ${input.authToken}`,
      },
    },
  };
  for (const [name, server] of Object.entries(input.resolvedMcpServers)) {
    const targetName =
      name === canopyServerName
        ? `${canopyServerName}_${TERMINAL_MCP_CONFLICT_SUFFIX}`
        : name;
    if (targetName !== name) {
      // eslint-disable-next-line no-console
      console.warn(
        '[claude-terminal-settings]',
        `Resolved MCP server "${name}" conflicts with the reserved terminal ${BRAND.displayName} entry; renamed to "${targetName}".`,
      );
    }
    mcpServers[targetName] = server;
  }
  return { mcpServers };
}

function compactEnv(
  env: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key === 'ELECTRON_RUN_AS_NODE') {
      continue;
    }
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

export async function buildClaudeTerminalLaunchConfig(
  input: ClaudeTerminalLaunchConfigInput,
): Promise<ClaudeTerminalLaunchConfig> {
  const workOwner = await resolveSessionWorkOwner(input);
  // `input.model` is optional and `--model` is simply omitted when it is
  // absent (see the arg build below), so the CLI would pick its own implicit
  // default — which no policy check ever sees, because
  // `isModelBlockedByStoredPolicy(undefined)` answers `false`. Unlike an SDK
  // turn, nothing downstream re-checks: a managed terminal never reaches
  // `getOrCreateSession`, so this function is the last gate.
  //
  // Under an active policy, PIN `DEFAULT_CLAUDE_MODEL` rather than refuse. This
  // mirrors the pipeline runtime's `provider-default` pin, for the reason
  // stated there: probing the default without pinning it is a guess about what
  // the provider would have chosen, and the guess can under-refuse if the
  // provider's default drifts to an unreviewed id.
  //
  // Refusing outright was tried and is too blunt. A model-less tab is genuinely
  // reachable — a Portal/mobile New Task mints one main-side, `readChatTabsFile`
  // does not backfill legacy tabs, and this PR's own `clearStaleEmptyTabModel`
  // creates them — while the composer still displays a default model name. A
  // governed user would have seen "This model is blocked" for a model they never
  // picked. Pinning fails closed identically when the default is unapproved,
  // without inventing a refusal when it is fine.
  //
  // An ungoverned account keeps the previous behavior exactly: no pin, and
  // `--model` stays omitted.
  const effectiveModel =
    input.model ??
    ((await isOrgModelPolicyActiveForStoredAccount(workOwner))
      ? DEFAULT_CLAUDE_MODEL
      : undefined);
  // Gated before any runtime directory, settings file, or auth token is written
  // so a blocked model never reaches the CLI as `--model`.
  if (await isModelBlockedByStoredPolicy(effectiveModel, workOwner)) {
    throw new Error(CLAUDE_TERMINAL_MODEL_POLICY_REFUSAL);
  }

  await mkdir(input.runtimeDir, { recursive: true, mode: RUNTIME_DIR_MODE });
  await chmodIfSupported(input.runtimeDir, RUNTIME_DIR_MODE);
  const nodePath = (await getDesktopNodeRuntime()).nodeProcess.command;
  const server = getDesktopIntegrationServer();
  const appMcpUrl = server.getCanopyWorktreeMcpUrl(input.sessionKey);
  const hookUrl = server.getClaudeTerminalHookUrl(input.sessionKey);
  const baseUrl = new URL(appMcpUrl).origin;

  const callbackStub = await writeHookScriptPair({
    nodePath,
    runtimeDir: input.runtimeDir,
    baseName: DESKTOP_INTEGRATION_HOOK_SCRIPT_FILENAME.replace(/\.js$/, ''),
    jsSource: buildClaudeTerminalHookCallbackScript({
      hookUrl,
    }),
  });
  const rtkStub = await writeHookScriptPair({
    nodePath,
    runtimeDir: input.runtimeDir,
    baseName: 'rtk-hook-wrapper',
    jsSource: buildRtkHookWrapperScript(),
  });
  const pathPrepend =
    input.preventClaudeNativeCaffeinate === false
      ? []
      : await writeNoopCaffeinateShim(input.runtimeDir);

  // Managed terminals for regular worktree/cowork chats participate in the
  // global default-plugin overlay; purpose-built surfaces keep only their
  // explicit selections. One overlay pass — the effective selections are
  // computed here and passed straight into resolvePlugins.
  const pluginContext = await resolveEffectiveChatPluginContext(
    input.pluginSelections,
    input,
    chatSurfaceUsesGlobalPluginDefaults(input.projectId),
  );
  const effectiveSelections = pluginContext.selections;
  const requestedSettingSources: SettingSource[] = input.settingSources ?? [
    'user',
    'project',
    'local',
  ];
  // Admission reads the config folder the terminal's Claude will: the
  // worktree's terminal environment (workspace assignments included), then
  // the launch override.
  const terminalEnv = desktopTerminalEnvironmentFor(
    input.projectId,
    input.worktreeId,
  );
  const claudeConfigDir =
    input.claudeEnvOverride?.CLAUDE_CONFIG_DIR ?? terminalEnv.CLAUDE_CONFIG_DIR;
  const claudeHome = input.claudeEnvOverride?.HOME || terminalEnv.HOME;
  const claudeModAdmissionContext = await resolveClaudeModAdmissionContext({
    cwd: input.cwd,
    settingSources: requestedSettingSources,
    environment: false,
    ...(claudeConfigDir !== undefined ? { claudeConfigDir } : {}),
    ...(claudeHome ? { home: claudeHome } : {}),
    // The terminal runs this session id, so a resume reloads its own Mods.
    sessionId: input.sdkSessionId,
  });
  let claudeModAdmission: ClaudeTerminalLaunchConfig['claudeModAdmission'];
  let resolvedMcpServers: Record<string, unknown> = {};
  if (
    hasAnySelections(effectiveSelections) ||
    claudeModAdmissionContext !== undefined
  ) {
    const resolved = await resolvePlugins(
      effectiveSelections,
      input.projectId,
      input.worktreeId,
      input.chatId,
      {
        purpose: 'claude-session',
        cwd: input.cwd,
        settingSources: requestedSettingSources,
        installExternalPlugins: true,
        enableHttpMcpProxy: true,
        mcpHttpProxyService: server,
        sessionId: input.sessionKey,
        claudeModAdmissionContext,
        ...(pluginContext.preferences
          ? { preferences: pluginContext.preferences }
          : {}),
      },
    );
    resolvedMcpServers = resolved.mcpServers;
    claudeModAdmission = resolved.claudeModAdmission;
    for (const warning of resolved.warnings) {
      // eslint-disable-next-line no-console
      console.warn('[claude-terminal-settings]', warning);
    }
  }
  resolvedMcpServers = {
    ...resolvedMcpServers,
    ...(input.mcpServers ?? {}),
  };

  const settingsPath = path.join(
    input.runtimeDir,
    `${BRAND.internalName}-settings.json`,
  );
  const mcpConfigPath = path.join(
    input.runtimeDir,
    `${BRAND.internalName}-mcp.json`,
  );
  const runtimePath = path.join(input.runtimeDir, 'runtime.json');
  // Clamp to the model's supported tiers, then merge thinking-derived session
  // settings (currently only `ultracode` for the Ultra tier) into the settings
  // file passed via `--settings`.
  const thinking = buildClaudeThinkingOptions(
    clampThinkingLevelForModel(
      input.thinkingLevel ?? 'high',
      input.model,
      'claude',
    ),
  );
  const localMemoryEnabled = await readLocalMemoryEnabledPreference();
  const terminalSettings = {
    ...buildSettings(
      callbackStub,
      rtkStub,
      input.approvalMode !== 'full-access',
      input.approvalHookEnabled !== false,
      localMemoryEnabled,
    ),
    ...(thinking.settings ?? {}),
  };
  const settings = mergeClaudeModAdmissionSettings(
    terminalSettings,
    claudeModAdmission?.settings,
  );
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
  await writeFile(
    mcpConfigPath,
    JSON.stringify(
      buildMcpConfig({
        appMcpUrl,
        authToken: input.authToken,
        resolvedMcpServers,
        canopyServerName: input.canopyMcpServerName,
      }),
      null,
      2,
    ),
    { encoding: 'utf8', mode: TOKEN_FILE_MODE },
  );
  await chmodIfSupported(mcpConfigPath, TOKEN_FILE_MODE);
  await writeFile(
    runtimePath,
    JSON.stringify(
      {
        version: 1,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
        chatId: input.chatId,
        sessionKey: input.sessionKey,
        sdkSessionId: input.sdkSessionId,
        createdAt: Date.now(),
      },
      null,
      2,
    ),
    'utf8',
  );
  await writeFile(
    path.join(input.runtimeDir, `${BRAND.internalName}-env.json`),
    JSON.stringify(
      {
        [brandEnvName('CLAUDE_TERMINAL_MODE')]: '1',
        [brandEnvName('PROJECT_ID')]: input.projectId,
        [brandEnvName('WORKTREE_ID')]: input.worktreeId,
        [brandEnvName('CHAT_ID')]: input.chatId,
        [brandEnvName('CLAUDE_SESSION_ID')]: input.sdkSessionId,
      },
      null,
      2,
    ),
    'utf8',
  );

  const permission = resolvePermission(input);
  const args = [
    '--settings',
    settingsPath,
    '--mcp-config',
    mcpConfigPath,
    '--strict-mcp-config',
    '--setting-sources',
    requestedSettingSources.join(','),
    '--managed-settings',
    JSON.stringify(claudeManagedSettingsGuard()),
  ];
  if (permission.allowDangerouslySkipPermissions) {
    args.push('--allow-dangerously-skip-permissions');
  }
  if (permission.permissionMode) {
    args.push('--permission-mode', permission.permissionMode);
  }
  if (permission.tools !== undefined) {
    // Pass even when empty: `--tools ""` disables all built-in tools, which is
    // how a read-only/no-tools posture is enforced.
    args.push('--tools', permission.tools.join(','));
  }
  if (permission.allowedTools && permission.allowedTools.length > 0) {
    args.push('--allowedTools', permission.allowedTools.join(','));
  }
  args.push(
    '--disallowedTools',
    Array.from(
      new Set([...(permission.disallowedTools ?? []), 'ScheduleWakeup']),
    ).join(','),
  );
  if (input.maxTurns && input.maxTurns > 0) {
    args.push('--max-turns', String(input.maxTurns));
  }
  if (input.resumeExistingSession) {
    args.push('--resume', input.sdkSessionId);
  } else {
    args.push('--session-id', input.sdkSessionId);
  }
  if (effectiveModel) {
    // `effectiveModel`, not `input.model`: a policy-pinned default has to
    // actually reach the CLI, or the check above would have validated a model
    // the session does not run.
    args.push('--model', effectiveModel);
  }
  if (thinking.effort) {
    args.push('--effort', thinking.effort);
  }
  if (input.systemPromptAppend) {
    args.push('--append-system-prompt', input.systemPromptAppend);
  }
  if (input.initialPrompt) {
    args.push('--', input.initialPrompt);
  }

  const environmentOverride = { ...input.claudeEnvOverride };
  const runtimeAliases = brandEnvCandidates('ELECTRON_NODE_PATH').map((name) =>
    name.toUpperCase(),
  );
  for (const name of Object.keys(environmentOverride))
    if (runtimeAliases.includes(name.toUpperCase()))
      delete environmentOverride[name];

  return {
    executable: getBundledClaudeBinaryPath(),
    args,
    cwd: input.cwd,
    runtimeDir: input.runtimeDir,
    settingsPath,
    mcpConfigPath,
    pathPrepend,
    sessionKey: input.sessionKey,
    authToken: input.authToken,
    sdkSessionId: input.sdkSessionId,
    ...(claudeModAdmission ? { claudeModAdmission } : {}),
    env: compactEnv({
      [brandEnvName('CLAUDE_TERMINAL_MODE')]: '1',
      [brandEnvName('PROJECT_ID')]: input.projectId,
      [brandEnvName('WORKTREE_ID')]: input.worktreeId,
      [brandEnvName('CHAT_ID')]: input.chatId,
      [brandEnvName('CLAUDE_SESSION_ID')]: input.sdkSessionId,
      [brandEnvName('DESKTOP_INTEGRATION_BASE_URL')]: baseUrl,
      [brandEnvName('DESKTOP_INTEGRATION_SESSION_KEY')]: input.sessionKey,
      [DESKTOP_INTEGRATION_TOKEN_ENV_VAR]: input.authToken,
      [brandEnvName('RTK_BINARY_PATH')]: getBundledRtkBinaryPath(),
      [brandEnvName('PREF_RTK_ENABLED')]:
        input.rtkEnabled === false ? 'false' : 'true',
      ...getRtkManagedEnv(),
      ...environmentOverride,
      [brandEnvName('ELECTRON_NODE_PATH')]: nodePath,
    }),
  };
}
