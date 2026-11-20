import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  connectAcp,
  type AcpClient,
  type AcpClientOptions,
} from '@canopy/desktop-shared/node/acp';
import type { ProviderProcessOwner } from '@canopy/desktop-shared/node/provider-process/spawn';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import type {
  ProviderProcessCleanup,
  ProviderProcessSpawner,
} from '../provider-process/spawn';

import { ANTIGRAVITY_RUNTIME_VERSION } from './runtime-metadata';
import {
  assertAntigravityExecutableUnchanged,
  verifyAntigravityExecutable,
} from './runtime-integrity';
import {
  assertAntigravityWorkspaceConfigurationIsolated,
  writesAntigravityProfile,
} from './workspace-configuration';
import { antigravityNativeOperation } from './tool-approval';
import {
  antigravityEnvironment,
  resolveAntigravityExecutable,
} from './runtime-resolution';
export {
  antigravityEnvironment,
  resolveAntigravityExecutable,
} from './runtime-resolution';
export { ANTIGRAVITY_RUNTIME_VERSION } from './runtime-metadata';

export function antigravityProfileDirectory(): string {
  return join(getCanopyDataDir(), 'antigravity');
}

async function replacePrivateFile(
  file: string,
  contents: string,
): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' });
  await rename(temporary, file);
}

/** Host-routed MCP server names for this native process, one per line. */
const MCP_SERVERS_ENV = brandEnvName('ANTIGRAVITY_MCP_SERVERS');

/**
 * PreToolUse gate for every native tool call, including subagents' (CAN-6714).
 * Only tools whose ACP permission request reaches the host approval service
 * (read_file, write_file, run_command) and host-routed MCP tools, which
 * authorize at execution, are sent to `force_ask`. Every other tool, an
 * unreadable payload or a missing name is denied: 1.5.1 runs built-in tools
 * such as invoke_subagent and search_web without a permission request.
 * The runtime treats empty hook output as allow, so every path prints one
 * decision or exits non-zero. It runs under /bin/bash, whose printf builtin
 * reports a failed write; macOS /usr/bin/printf and zsh's builtin do not.
 * An MCP tool qualifies only when its name starts with mcp_<server>_ for a
 * server the host routed into this process (MCP_SERVERS_ENV). Server names
 * may contain `_`, so an unrouted server sharing a routed prefix would also
 * match; that is safe only because no unrouted server can be present: the
 * profile's MCP configuration is empty, launches refuse workspace MCP
 * (workspace-configuration.ts), chat turns are checked by
 * assertAntigravityMcpServersRouted, and pipeline, CLI, discovery and sign-in
 * launches route and deliver no MCP.
 * /bin/bash and /usr/bin/plutil are macOS paths; resolveAntigravityExecutable
 * refuses other platforms before the profile is prepared.
 */
const ANTIGRAVITY_TOOL_GATE_SCRIPT = [
  '#!/bin/bash',
  // Pattern classes follow the shell's locale; a multibyte locale such as
  // ja_JP.eucJP can hide a control byte, so matching is byte-wise ASCII.
  'LC_ALL=C',
  // Bash command substitution silently removes NUL bytes. Read until a NUL
  // instead: success means a NUL was found and the malformed payload is denied;
  // EOF retains the full text, including trailing newlines. The builtin printf
  // does not exec, so large writes do not hit argument limits.
  // Only a string name is accepted:
  // plutil prints a dictionary's keys for `raw`.
  'input=',
  "if IFS= read -r -d '' input; then",
  `  printf '%s\\n' '{"decision":"deny","reason":"This tool is unavailable in this app."}' || exit 1`,
  '  exit 0',
  'fi',
  'type=$(printf \'%s\' "$input" | /usr/bin/plutil -type toolCall.name - 2>/dev/null) || type=',
  'name=',
  'if [ "$type" = string ]; then',
  // A sentinel keeps trailing newlines, so names match exactly.
  '  name=$(printf \'%s\' "$input" | /usr/bin/plutil -extract toolCall.name raw -o - - 2>/dev/null && printf .) || name=',
  '  name=${name%.}',
  "  name=${name%$'\\n'}",
  'fi',
  // No tool name may contain an ASCII control character or DEL.
  'case "$name" in *[[:cntrl:]]*) name= ;; esac',
  'decision=deny',
  'case "$name" in',
  '  read_file|write_file|run_command) decision=force_ask ;;',
  '  mcp_?*)',
  // Only servers the host routed into this process qualify.
  '    while IFS= read -r server; do',
  '      case "$server" in \'\'|*[!A-Za-z0-9_-]*) continue ;; esac',
  '      case "$name" in "mcp_${server}_"?*) decision=force_ask ;; esac',
  `    done <<< "\${${MCP_SERVERS_ENV}-}" ;;`,
  'esac',
  'if [ "$decision" = force_ask ]; then',
  `  printf '%s\\n' '{"decision":"force_ask"}' || exit 1`,
  'else',
  `  printf '%s\\n' '{"decision":"deny","reason":"This tool is unavailable in this app."}' || exit 1`,
  'fi',
  '',
].join('\n');

export const ANTIGRAVITY_AGENT_NAME = 'canopy';

/**
 * The private-profile agent every launch selects (CAP-02). It inherits no
 * workspace or default customizations, so repository skills, rules and
 * workflows never reach the model, and it offers only the native tools the
 * approval hook sends to the host. Antigravity 1.5.1 silently falls back to
 * its default agent on any key or value outside the qualified schema, and the
 * session handshake does not name the active agent: change these values only
 * with a re-probe on the pinned runtime.
 */
export const ANTIGRAVITY_AGENT_DEFINITION = [
  '---',
  `name: ${ANTIGRAVITY_AGENT_NAME}`,
  'description: App session agent',
  'mainAgent: true',
  'subagent: false',
  'inheritCustomizations: false',
  'excludeDefaultComponents: true',
  'tools: [read_file, write_file, run_command]',
  '---',
  '# Session agent',
  '',
  'You work for the user inside the app. Work only in the workspace roots this',
  'session names, and keep every read, write and command inside them.',
  '',
  'Every file read, file write and command goes through the app for approval.',
  'If a call is denied, tell the user it was denied and why, if a reason was',
  'given. Do not retry it, and do not reach the same result another way.',
  '',
  "MCP tools this session provides are the app's own tools. Use them under",
  'the same rules.',
  '',
  'In plan mode, make no edits and run no commands. Answer with the plan.',
  '',
  'If a tool you need is unavailable, say which one and stop.',
  '',
].join('\n');

/** Where the Canopy agent lives in the private profile. */
export function antigravityAgentPath(profile: string): string {
  return join(profile, 'config', 'agents', `${ANTIGRAVITY_AGENT_NAME}.md`);
}

function antigravityMcpServerList(names: readonly string[] = []): string {
  const seen = new Set<string>();
  for (const name of names) {
    if (!/^[A-Za-z0-9_-]+$/.test(name))
      throw new Error(
        `Google chats can't use the MCP server name ${JSON.stringify(name)}.`,
      );
    if (seen.has(name))
      throw new Error("Google chats can't use the same MCP server twice.");
    seen.add(name);
  }
  return names.join('\n');
}

/**
 * Fails closed before session/new or resume unless the delivered MCP servers
 * are exactly the routed list: the same raw names, each once, with no
 * normalization. Both lists are compared as sorted lists, so a duplicate on
 * either side or a name missing from either side refuses the turn.
 */
export function assertAntigravityMcpServersRouted(
  servers: readonly { name: string }[],
  routed: readonly string[],
): void {
  antigravityMcpServerList(routed);
  // Routed names are unique, so the comparison also refuses a delivered
  // duplicate.
  const left = servers.map((server) => server.name).sort();
  const right = [...routed].sort();
  if (
    left.length !== right.length ||
    left.some((name, index) => name !== right[index])
  )
    throw new Error(
      "Google chats couldn't start this turn because its MCP servers didn't match.",
    );
}

/** Google retains custody of credentials and native conversations in its own runtime. */
export async function prepareAntigravityProfile(
  profile = antigravityProfileDirectory(),
): Promise<string> {
  const config = join(profile, 'config');
  await mkdir(config, { recursive: true, mode: 0o700 });
  const script = join(profile, 'approval-hook.sh');
  await replacePrivateFile(script, ANTIGRAVITY_TOOL_GATE_SCRIPT);
  const quote = (value: string): string => {
    return `'${value.replace(/'/g, `'"'"'`)}'`;
  };
  await replacePrivateFile(
    join(config, 'hooks.json'),
    JSON.stringify({
      'canopy-approval': {
        PreToolUse: [
          {
            matcher: '.*',
            hooks: [
              {
                type: 'command',
                command: `/bin/bash ${quote(script)}`,
                timeout: 10,
              },
            ],
          },
        ],
      },
    }),
  );
  // Native configuration must not import unselected MCP servers into the chat.
  await replacePrivateFile(
    join(config, 'mcp_config.json'),
    JSON.stringify({ mcpServers: {} }),
  );
  const agent = antigravityAgentPath(profile);
  await mkdir(dirname(agent), { recursive: true, mode: 0o700 });
  await replacePrivateFile(agent, ANTIGRAVITY_AGENT_DEFINITION);
  return profile;
}

export function antigravityArguments(profile: string): string[] {
  return [
    'acp',
    '--gemini-dir',
    profile,
    '--disable-telemetry',
    '--include-default-customizations=false',
    '--process-per-session',
    '--agent',
    ANTIGRAVITY_AGENT_NAME,
  ];
}

export interface AntigravityRuntime {
  client: AcpClient;
  close(): Promise<void>;
  /**
   * After close: whether the stop proved its escaped descendants gone
   * (CAN-6738). A cancelled turn alone never means `reaped`.
   */
  descendantCleanup?(): Promise<ProviderProcessCleanup | undefined>;
}

export async function openAntigravityRuntime(input: {
  cwd: string;
  profile?: string;
  spawnProcess: ProviderProcessSpawner;
  assertEnabled: () => void | Promise<void>;
  signal?: AbortSignal;
  environment?: Record<string, string>;
  owner: ProviderProcessOwner;
  onUpdate: AcpClientOptions['onUpdate'];
  onPermission?: AcpClientOptions['onPermission'];
  requestTimeoutMs?: number;
  /** Host-routed MCP servers this process may call; others are denied. */
  mcpServerNames?: readonly string[];
  /**
   * Where the managed copy is looked up; defaults to
   * getAntigravityRuntimeRootDir(). Tests pass an empty directory so a
   * developer's installed copy cannot replace the file a case launches.
   */
  managedRootDir?: string;
}): Promise<AntigravityRuntime> {
  input.signal?.throwIfAborted();
  await input.assertEnabled();
  // Every native launch (turn, resume, discovery, sign-in, pipeline, CLI)
  // refuses workspace hooks and MCP servers the runtime would run unapproved.
  await assertAntigravityWorkspaceConfigurationIsolated(
    input.cwd,
    input.signal,
  );
  const mcpServers = antigravityMcpServerList(input.mcpServerNames);
  const executable = await verifyAntigravityExecutable(
    await resolveAntigravityExecutable({
      managedRootDir: input.managedRootDir,
      signal: input.signal,
    }),
    input.signal,
  );
  input.signal?.throwIfAborted();
  await input.assertEnabled();
  const profile = await prepareAntigravityProfile(input.profile);
  input.signal?.throwIfAborted();
  await input.assertEnabled();
  await assertAntigravityExecutableUnchanged(executable);
  const child = input.spawnProcess({
    command: executable,
    args: antigravityArguments(profile),
    cwd: input.cwd,
    env: {
      ...antigravityEnvironment(input.environment),
      [MCP_SERVERS_ENV]: mcpServers,
    },
    owner: input.owner,
    // Approved commands run in their own process groups (CAN-6726).
    reapDescendantGroups: true,
  });
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => (stopping ??= child.stop());
  const abort = (): void => {
    void stop().catch(() => undefined);
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  child.once('error', () => {
    child.stdout.destroy();
    child.stdin?.destroy();
  });
  child.stderr.resume();
  if (!child.stdin) {
    input.signal?.removeEventListener('abort', abort);
    await stop();
    throw new Error('Google could not start.');
  }
  try {
    const client = await connectAcp({
      transport: {
        input: Readable.toWeb(child.stdout),
        output: Writable.toWeb(child.stdin),
        close: () => {
          void stop().catch(() => undefined);
        },
      },
      clientInfo: { name: 'canopy', version: '1.0.0' },
      resourceGeneration: 1,
      onUpdate: (update, resourceGeneration) => {
        // Approved commands start in their own process groups; record them
        // while they run so a stop can reap them without delaying its first
        // signal (CAN-6738).
        const kind = update.update.sessionUpdate;
        if (kind === 'tool_call' || kind === 'tool_call_update')
          child.recordDescendants?.();
        return input.onUpdate(update, resourceGeneration);
      },
      onPermission: async (request) => {
        // The opener knows the actual profile, including execution-scoped
        // profiles used by the CLI and workflows. Guard it before any host
        // approval; an outside-workspace approval must not rewrite this gate.
        const operation = antigravityNativeOperation(request);
        if (
          request.signal.aborted ||
          !operation ||
          (await writesAntigravityProfile(operation, input.cwd, profile))
        )
          return 'deny';
        if (request.signal.aborted) return 'deny';
        return (await input.onPermission?.(request)) ?? 'deny';
      },
      timeouts: {
        promptMs: null,
        permissionMs: 300_000,
        requestMs: input.requestTimeoutMs ?? 30_000,
      },
    });
    if (
      client.getInitialization().agentInfo?.version !==
      ANTIGRAVITY_RUNTIME_VERSION
    ) {
      client.close();
      throw new Error(
        'This version of Antigravity has not been verified. Use Antigravity CLI 1.5.1.',
      );
    }
    return {
      client,
      close: async (): Promise<void> => {
        input.signal?.removeEventListener('abort', abort);
        client.close();
        await stop();
      },
      descendantCleanup: async () => await child.stopCleanup?.(),
    };
  } catch (error) {
    input.signal?.removeEventListener('abort', abort);
    await stop();
    throw error;
  }
}
