import { constants } from 'node:fs';
import { access, mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import {
  connectAcp,
  type AcpClient,
  type AcpClientOptions,
} from '@canopy/desktop-shared/node/acp';
import type { ProviderProcessOwner } from '@canopy/desktop-shared/node/provider-process/spawn';
import { hostPlatformOperatingSystem } from '@canopy/core-platform';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import type {
  ProviderProcessCleanup,
  ProviderProcessSpawner,
} from '../provider-process/spawn';

import { ANTIGRAVITY_RUNTIME_VERSION } from './runtime-metadata';
import {
  antigravityExecutableIdentityForLaunch,
  verifyAntigravityExecutable,
} from './runtime-integrity';
import {
  assertAntigravityWorkspaceConfigurationIsolated,
  writesAntigravityProfile,
} from './workspace-configuration';
import {
  antigravityNativeOperation,
  isRoutedAntigravityMcpCall,
} from './tool-approval';
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
 * decision or exits non-zero. It runs under bash (/bin/bash, or on Linux the
 * first of ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS.bash), whose printf builtin
 * reports a failed write; macOS /usr/bin/printf and zsh's builtin do not.
 * An MCP tool qualifies only when its name starts with mcp_<server>_ for a
 * server the host routed into this process (MCP_SERVERS_ENV). Server names
 * may contain `_`, so an unrouted server sharing a routed prefix would also
 * match; that is safe only because no unrouted server can be present: the
 * profile's MCP configuration is empty, launches refuse workspace MCP
 * (workspace-configuration.ts), chat turns are checked by
 * assertAntigravityMcpServersRouted, and pipeline, CLI, discovery and sign-in
 * launches route and deliver no MCP.
 * Only the tool-name extraction differs by platform: macOS reads it with
 * /usr/bin/plutil, and Linux, which has no plutil, with grep and awk from
 * fixed paths (see antigravityLinuxToolName and resolveAntigravityHookTools).
 * resolveAntigravityExecutable refuses other platforms before the profile is
 * prepared.
 */
function antigravityToolGateHeader(bash: string): string[] {
  return [
    `#!${bash}`,
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
  ];
}

const ANTIGRAVITY_DARWIN_TOOL_NAME = [
  'type=$(printf \'%s\' "$input" | /usr/bin/plutil -type toolCall.name - 2>/dev/null) || type=',
  'name=',
  'if [ "$type" = string ]; then',
  // A sentinel keeps trailing newlines, so names match exactly.
  '  name=$(printf \'%s\' "$input" | /usr/bin/plutil -extract toolCall.name raw -o - - 2>/dev/null && printf .) || name=',
  '  name=${name%.}',
  "  name=${name%$'\\n'}",
  'fi',
];

/**
 * Linux tool-name extraction (CAN-6718). `grep -o` splits the payload into
 * JSON tokens in linear time, one per line; any byte outside a token becomes
 * its own line, which awk then rejects. awk walks the tokens as strict JSON
 * and prints `toolCall.name` only when the payload is one object whose
 * `toolCall` is an object holding a string `name`. It is stricter than
 * plutil and fails closed: a duplicate `toolCall` or `name` key, an escaped
 * key at those levels, an escape inside the name (no qualifying name needs
 * one), a raw C0 control character (0x01-0x1F; JSON forbids them unescaped)
 * in any string, an invalid escape, number or literal, or trailing input
 * prints nothing, which denies. Escapes are checked in one left-to-right
 * pass, each where it starts in the original string, so removing one escape
 * can never join the characters around it into another (`\u12\n34` is not
 * `\u1234`). A raw DEL (0x7F) is valid JSON, and common
 * serializers emit it unescaped, so it passes here; the decision still
 * denies a name that contains one. A NUL never reaches awk: the header
 * denies it. A string cannot span lines, so a printed name holds no newline.
 * POSIX awk only: Debian and Ubuntu ship mawk as their awk.
 *
 * grep and awk run through bash's `exec -c`, with an empty environment: the
 * hook inherits the runtime's environment, which workflow inputs reach, and
 * these tools read it. An empty environment is the C locale, and it drops
 * GREP_OPTIONS (older GNU grep) and GAWK_PERSIST_FILE, which would let GNU
 * awk keep the parser's globals, such as its duplicate-key counters, from
 * one call to the next. Removing the whole environment covers variables a
 * future grep or awk adds as well.
 */
const ANTIGRAVITY_LINUX_TOOL_NAME_AWK = String.raw`
function fail() { bad = 1; exit }
function str(t) { return length(t) >= 2 && t ~ /^".*"$/ }
function scalar(t,  u) {
  if (str(t)) {
    if (t ~ /[\001-\037]/) return 0
    u = substr(t, 2, length(t) - 2)
    gsub(/\\(["\\\/bfnrt]|u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f])/, "", u)
    return index(u, "\\") == 0
  }
  return t == "true" || t == "false" || t == "null" ||
    t ~ /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/
}
function closed() { d--; st = d ? "comma" : "end" }
function value(t,  role) {
  role = ""
  if (d == 1 && key[1] == "toolCall") role = "tool"
  else if (d == 2 && tool[2] && key[2] == "name") role = "name"
  if (t == "{" || t == "[") {
    if (d == 0 && t != "{") fail()
    d++
    kind[d] = t
    tool[d] = role == "tool" && t == "{"
    key[d] = ""
    st = t == "{" ? "key_or_end" : "value_or_end"
    return
  }
  if (d == 0 || !scalar(t)) fail()
  if (role == "name" && str(t) && index(t, "\\") == 0)
    name = substr(t, 2, length(t) - 2)
  st = "comma"
}
BEGIN { st = "value"; d = 0; name = "" }
/^[ \t\r]+$/ { next }
{
  t = $0
  if (st == "end") fail()
  if (st == "value") value(t)
  else if (st == "value_or_end") { if (t == "]") closed(); else value(t) }
  else if (st == "key" || st == "key_or_end") {
    if (st == "key_or_end" && t == "}") { closed(); next }
    if (!str(t) || !scalar(t)) fail()
    key[d] = substr(t, 2, length(t) - 2)
    if ((d == 1 || tool[d]) && index(key[d], "\\")) fail()
    if (d == 1 && key[d] == "toolCall" && ++calls > 1) fail()
    if (d == 2 && tool[d] && key[d] == "name" && ++names > 1) fail()
    st = "colon"
  }
  else if (st == "colon") { if (t != ":") fail(); st = "value" }
  else if (st == "comma") {
    if (t == ",") st = kind[d] == "{" ? "key" : "value"
    else if ((t == "}" && kind[d] == "{") || (t == "]" && kind[d] == "[")) closed()
    else fail()
  }
}
END { if (!bad && st == "end") printf "%s", name }
`;

function antigravityLinuxToolName(tools: AntigravityHookTools): string[] {
  return [
    `name=$(printf '%s' "$input" | exec -c ${tools.grep} -a -o -E '"([^"\\\\]|\\\\.)*"|[][{}:,]|[^][{}:,"[:space:]]+|[[:space:]]+|.' | exec -c ${tools.awk} '${ANTIGRAVITY_LINUX_TOOL_NAME_AWK}' 2>/dev/null) || name=`,
  ];
}

const ANTIGRAVITY_TOOL_GATE_DECISION = [
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
];

/** The absolute paths the approval hook runs its interpreter and tools from. */
export interface AntigravityHookTools {
  readonly bash: string;
  readonly grep: string;
  readonly awk: string;
}

/** macOS always has these; its script is fixed and never probes. */
const ANTIGRAVITY_SYSTEM_HOOK_TOOLS: AntigravityHookTools = {
  bash: '/bin/bash',
  grep: '/usr/bin/grep',
  awk: '/usr/bin/awk',
};

/**
 * The only places the Linux hook may take its tools from, in order. Distros
 * without a merged /usr keep grep and bash only under /bin. PATH is never
 * searched: the hook runs inside the runtime's environment, so a PATH entry
 * could choose the parser that decides which tools run unapproved.
 */
export const ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS: {
  readonly [Tool in keyof AntigravityHookTools]: readonly string[];
} = {
  bash: ['/bin/bash', '/usr/bin/bash'],
  grep: ['/usr/bin/grep', '/bin/grep'],
  awk: ['/usr/bin/awk', '/bin/awk'],
};

async function isExecutableFile(file: string): Promise<boolean> {
  try {
    if (!(await stat(file)).isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The hook's tools for a host platform. On Linux, each is the first
 * executable file in ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS; a missing tool
 * refuses the launch, because a hook that cannot run denies every tool.
 * `usable` is replaceable for tests.
 */
export async function resolveAntigravityHookTools(
  platform: string = hostPlatformOperatingSystem(),
  usable: (file: string) => Promise<boolean> = isExecutableFile,
): Promise<AntigravityHookTools> {
  if (platform !== 'linux') return ANTIGRAVITY_SYSTEM_HOOK_TOOLS;
  const pick = async (tool: keyof AntigravityHookTools): Promise<string> => {
    const candidates = ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS[tool];
    for (const candidate of candidates)
      if (await usable(candidate)) return candidate;
    throw new Error(
      `Google chats need ${tool}, which wasn't found at ${candidates.join(' or ')}. Install it, then try again.`,
    );
  };
  return {
    bash: await pick('bash'),
    grep: await pick('grep'),
    awk: await pick('awk'),
  };
}

/**
 * The approval hook script for a host platform. Linux scripts embed the
 * tools prepareAntigravityProfile resolved; the macOS script ignores `tools`.
 */
export function antigravityToolGateScript(
  platform: string = hostPlatformOperatingSystem(),
  tools: AntigravityHookTools = ANTIGRAVITY_SYSTEM_HOOK_TOOLS,
): string {
  const linux = platform === 'linux';
  return [
    ...antigravityToolGateHeader(
      linux ? tools.bash : ANTIGRAVITY_SYSTEM_HOOK_TOOLS.bash,
    ),
    ...(linux ? antigravityLinuxToolName(tools) : ANTIGRAVITY_DARWIN_TOOL_NAME),
    ...ANTIGRAVITY_TOOL_GATE_DECISION,
  ].join('\n');
}

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
  // Resolved first, so a host without the hook's tools refuses the launch
  // before anything is written.
  const platform = hostPlatformOperatingSystem();
  const tools = await resolveAntigravityHookTools(platform);
  const config = join(profile, 'config');
  await mkdir(config, { recursive: true, mode: 0o700 });
  const script = join(profile, 'approval-hook.sh');
  await replacePrivateFile(script, antigravityToolGateScript(platform, tools));
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
                // -p (privileged mode): bash skips BASH_ENV and ENV and
                // ignores inherited functions, SHELLOPTS and BASHOPTS, so no
                // variable in the runtime's environment runs code first.
                command: `${tools.bash} -p ${quote(script)}`,
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
  /**
   * The verified file this runtime launched, which passed every launch check
   * and reported the pinned version, and that file's identity when it was
   * spawned. Set by openAntigravityRuntime.
   */
  executable?: string;
  executableIdentity?: string;
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
  const executableIdentity =
    await antigravityExecutableIdentityForLaunch(executable);
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
        if (request.signal.aborted) return 'deny';
        // Routed MCP tools authorize in the host at execution.
        if (isRoutedAntigravityMcpCall(request, input.mcpServerNames ?? []))
          return 'allow';
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
        `This version of Antigravity has not been verified. Use Antigravity CLI ${ANTIGRAVITY_RUNTIME_VERSION}.`,
      );
    }
    return {
      client,
      executable,
      executableIdentity,
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
