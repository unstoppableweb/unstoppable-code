// Golden (CAN-6714, CAN-6718): the private Antigravity profile's PreToolUse
// hook is the only gate for native tools that skip the ACP permission request.
// Antigravity 1.5.1 treats empty hook output with exit 0 as allow, so the hook
// must print exactly one decision or exit non-zero on every path. The hook
// reads the tool name with macOS /usr/bin/plutil or, on Linux, with grep and
// awk from fixed system paths, so this contract runs on the macOS and Linux
// platform-services lanes.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type * as FsPromises from 'node:fs/promises';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import {
  ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS,
  antigravityToolGateScript,
  prepareAntigravityProfile,
  resolveAntigravityHookTools,
} from '../runtime';

jest.mock('@canopy/desktop-shared/node/acp', () => ({ connectAcp: jest.fn() }));

/** Paths a case makes unusable, as if the host had no such file. */
let missingFiles = new Set<string>();

jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    access: (...args: Parameters<typeof actual.access>): Promise<void> =>
      missingFiles.has(String(args[0]))
        ? Promise.reject(
            Object.assign(new Error('ENOENT: no such file'), {
              code: 'ENOENT',
            }),
          )
        : actual.access(...args),
  };
});

const darwin = process.platform === 'darwin';
const linux = process.platform === 'linux';
const gateDescribe = darwin || linux ? describe : describe.skip;
const linuxIt = linux ? it : it.skip;

let profile: string;
let command: string;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function at(value: unknown, ...path: (string | number)[]): unknown {
  let current = value;
  for (const key of path) {
    if (Array.isArray(current) && typeof key === 'number')
      current = current[key];
    else if (isRecord(current) && typeof key === 'string')
      current = current[key];
    else return undefined;
  }
  return current;
}

gateDescribe('Antigravity native tool gate', () => {
  beforeAll(async () => {
    profile = await mkdtemp(join(tmpdir(), 'agy-gate-golden-'));
    await prepareAntigravityProfile(profile);
    const hooks: unknown = JSON.parse(
      await readFile(join(profile, 'config/hooks.json'), 'utf8'),
    );
    command = String(
      at(hooks, 'canopy-approval', 'PreToolUse', 0, 'hooks', 0, 'command'),
    );
  });

  afterAll(async () => {
    await rm(profile, { recursive: true, force: true });
  });

  /** The test environment. A given locale replaces every inherited LANG and
   * LC_* variable; without one, the environment is inherited unchanged. */
  function withLocale(locale?: Record<string, string>): NodeJS.ProcessEnv {
    const env = { ...process.env };
    if (locale === undefined) return env;
    for (const key of Object.keys(env))
      if (key === 'LANG' || key.startsWith('LC_')) delete env[key];
    return { ...env, ...locale };
  }

  /** Runs the hook as the runtime does and enforces the no-fail-open contract. */
  function decide(
    stdin: string | Buffer,
    redirect = '',
    servers: string | null = 'canopy\nselected\nsel-ected',
    locale?: Record<string, string>,
  ): string {
    // The runtime opener lists this process's host-routed MCP servers.
    const env = withLocale(locale);
    delete env[brandEnvName('ANTIGRAVITY_MCP_SERVERS')];
    if (servers !== null)
      env[brandEnvName('ANTIGRAVITY_MCP_SERVERS')] = servers;
    const run = spawnSync('/bin/sh', ['-c', `${command}${redirect}`], {
      input: stdin,
      env,
    });
    if (run.status !== 0) return 'failed';
    const lines = run.stdout.toString().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0]);
    const decision = at(parsed, 'decision');
    expect(['force_ask', 'deny']).toContain(decision);
    return String(decision);
  }

  const call = (name: unknown, args: Record<string, unknown> = {}): string =>
    JSON.stringify({ conversationId: 'c', toolCall: { args, name } });

  it('sends approval-mapped native tools and host MCP tools to the host', () => {
    for (const name of [
      'read_file',
      'write_file',
      'run_command',
      'mcp_canopy_GetGitPreferences',
      'mcp_selected_tool',
      'mcp_sel-ected_tool',
    ])
      expect([name, decide(call(name))]).toEqual([name, 'force_ask']);
    expect(
      decide(call('write_file', { Content: 'x'.repeat(3 * 1024 * 1024) })),
    ).toBe('force_ask');
  });

  it('denies native tools that would run without a host approval', () => {
    for (const name of [
      'invoke_subagent',
      'manage_subagents',
      'search_web',
      'edit_file',
      'mcp_',
      'mcp_canopy_',
      'mcp_rogue_tool',
      'read_file\n',
      'mcp_canopy_\nread_file',
      'mcp_canopy_x\r',
      'mcp_canopy_a\tb',
    ])
      expect([name, decide(call(name))]).toEqual([name, 'deny']);
    expect(decide(call('invoke_subagent', { name: 'read_file' }))).toBe('deny');
    // The hook pins its locale: a multibyte locale must not hide a control,
    // whether it arrives as an exported LC_ALL or only as LANG or LC_CTYPE.
    // Only the eucJP shapes fail without the pin; UTF-8 is a sanity case.
    // Linux runners generate no eucJP locale; the Linux hook also runs grep
    // and awk with an empty environment (the C locale), so it runs under the
    // built-in C.UTF-8.
    for (const [locale, charmap] of darwin
      ? ([
          [{ LC_ALL: 'en_US.UTF-8' }, 'UTF-8'],
          [{ LC_ALL: 'ja_JP.eucJP' }, 'eucJP'],
          [{ LANG: 'ja_JP.eucJP' }, 'eucJP'],
          [{ LC_CTYPE: 'ja_JP.eucJP' }, 'eucJP'],
        ] as const)
      : ([
          [{ LC_ALL: 'C.UTF-8' }, 'UTF-8'],
          [{ LANG: 'C.UTF-8' }, 'UTF-8'],
        ] as const)) {
      // A missing locale falls back to C, which would make these cases vacuous.
      const active = spawnSync('/usr/bin/locale', ['charmap'], {
        env: withLocale(locale),
        encoding: 'utf8',
      });
      // locale exits 0 even for an unknown locale; the charmap is the guard.
      expect([locale, active.error?.message, active.status]).toEqual([
        locale,
        undefined,
        0,
      ]);
      expect([locale, active.stdout.trim()]).toEqual([locale, charmap]);
      for (const name of ['mcp_canopy_\u4e2d\nx', 'mcp_canopy_x\u4e2d\r'])
        expect([
          locale,
          name,
          decide(call(name), '', 'canopy', locale),
        ]).toEqual([locale, name, 'deny']);
    }
  });

  it('never fails open on bad input or a failed write', () => {
    for (const stdin of [
      '',
      'not json',
      '{"toolCall":{}}',
      call(7),
      call({ read_file: 1 }),
      call(['read_file']),
    ])
      expect(decide(stdin)).toBe('deny');
    expect(decide(call('read_file'), ' >&-')).toBe('failed');
    // Workflow steps, the CLI, discovery and sign-in route no MCP servers.
    for (const servers of [null, ''])
      expect(decide(call('mcp_canopy_GetGitPreferences'), '', servers)).toBe(
        'deny',
      );
  });

  it('never sources a startup file named in the environment', async () => {
    // bash sources BASH_ENV (and, in POSIX mode, ENV) before the hook's first
    // line; workflow inputs reach the runtime's environment, so the hook's
    // interpreter must ignore both, as the runtime spawns it.
    const marker = join(profile, 'startup-sourced');
    const startup = join(profile, 'startup.sh');
    await writeFile(startup, `/usr/bin/touch '${marker}'\n`);
    const env = {
      ...process.env,
      BASH_ENV: startup,
      ENV: startup,
      [brandEnvName('ANTIGRAVITY_MCP_SERVERS')]: 'canopy',
    };
    const run = spawnSync('/bin/sh', ['-c', command], {
      input: call('read_file'),
      env,
    });
    expect(run.stdout.toString().trim()).toBe('{"decision":"force_ask"}');
    expect(existsSync(marker)).toBe(false);
  });

  // The Linux parser is stricter than plutil, which reads a duplicate name
  // last-wins: anything it cannot read as one unambiguous JSON object with a
  // plain string name is denied.
  linuxIt('denies payloads the Linux parser cannot read unambiguously', () => {
    for (const stdin of [
      '{"toolCall":{"name":"invoke_subagent","name":"read_file"}}',
      '{"toolCall":{"name":"read_file"},"toolCall":{"name":"read_file"}}',
      '{"toolCall":{"name":"read\\u005ffile"}}',
      '{"tool\\u0043all":{"name":"read_file"}}',
      '{"toolCall":{"na\\u006de":"read_file"}}',
      '{"toolCall":{"name":"read_file"}} trailing',
      '{"toolCall":{"name":"read_file"}}{}',
      '{"toolCall":{"name":"read_file"},}',
      '{"toolCall":{"name":"read_file",}}',
      '["read_file"]',
      '"read_file"',
      '{"toolCall":["read_file"]}',
      '{"toolCall":{"args":{"x":"bad\\q"},"name":"read_file"}}',
      // A simple escape inside a \u escape must not join its digits.
      '{"toolCall":{"args":{"x":"\\u12\\n34"},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":"\\u0\\t00e9"},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":"\\u12\\\\34"},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":"tab\there"},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":01},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":True},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":"unterminated},"name":"read_file"}}',
      '{"toolCall":{"args":{"x":"line\nbreak"},"name":"read_file"}}',
      '{"toolCall":{"name":"read_file"}\u000b}',
      '{"args":{"toolCall":{"name":"read_file"}}}',
    ])
      expect([stdin, decide(stdin)]).toEqual([stdin, 'deny']);
  });

  linuxIt('reads valid payloads in any JSON layout', () => {
    for (const stdin of [
      ' {\r\n "toolCall" :\t{ "name" : "run_command" } }\n',
      JSON.stringify(
        {
          conversationId: 'c',
          toolCall: {
            args: {
              name: 'invoke_subagent',
              nested: [1, -2.5e3, true, null, { s: 'q"\\/\u00e9\n' }],
              toolCall: { name: 'search_web' },
            },
            name: 'write_file',
          },
        },
        null,
        2,
      ),
      '{"toolCall":{"name":"read_file","args":{}},"conversationId":"c"}',
      // JSON allows a raw DEL in a string, and JSON.stringify and Go's
      // encoding/json emit it unescaped; only C0 controls are invalid.
      call('run_command', { CommandLine: 'a\u007fb' }),
      // Escapes in sequence: an escaped backslash, then a literal u12, a
      // newline and a \u escape.
      '{"toolCall":{"args":{"x":"\\\\u12\\n\\u00e9\\\\"},"name":"read_file"}}',
    ])
      expect([stdin, decide(stdin)]).toEqual([stdin, 'force_ask']);
    expect(
      decide(call('invoke_subagent', { toolCall: { name: 'read_file' } })),
    ).toBe('deny');
    // A DEL in a tool name still denies.
    for (const name of ['run_command\u007f', 'read\u007f_file'])
      expect([name, decide(call(name))]).toEqual([name, 'deny']);
  });

  linuxIt('runs grep and awk without the inherited environment', async () => {
    const run = (env: NodeJS.ProcessEnv, name: string): string => {
      const result = spawnSync('/bin/sh', ['-c', command], {
        input: call(name),
        env: {
          ...env,
          [brandEnvName('ANTIGRAVITY_MCP_SERVERS')]: 'canopy',
        },
      });
      return result.stdout.toString().trim();
    };
    const denied =
      '{"decision":"deny","reason":"This tool is unavailable in this app."}';
    for (const env of [
      { ...process.env, GREP_OPTIONS: '-v' },
      { ...process.env, LC_ALL: 'C.UTF-8', POSIXLY_CORRECT: '1' },
    ])
      expect(run(env, 'invoke_subagent')).toBe(denied);
    // GNU awk keeps a script's globals across runs in a persistent heap named
    // by GAWK_PERSIST_FILE; the parser's duplicate-key counters must not
    // carry over, so every call starts clean. Other awks ignore the variable.
    const heap = join(profile, 'gawk-heap.pma');
    await writeFile(heap, '');
    await truncate(heap, 64 * 1024 * 1024);
    const persisted = { ...process.env, GAWK_PERSIST_FILE: heap };
    for (const attempt of [1, 2, 3])
      expect([attempt, run(persisted, 'read_file')]).toEqual([
        attempt,
        '{"decision":"force_ask"}',
      ]);
    expect(run(persisted, 'invoke_subagent')).toBe(denied);
  });

  linuxIt('runs bash, grep and awk from the paths it resolved', async () => {
    const tools = await resolveAntigravityHookTools('linux');
    const script = await readFile(join(profile, 'approval-hook.sh'), 'utf8');
    expect(command.startsWith(`${tools.bash} -p '`)).toBe(true);
    expect(script.startsWith(`#!${tools.bash}\n`)).toBe(true);
    expect(script).toContain(`| exec -c ${tools.grep} -a -o -E `);
    expect(script).toContain(`| exec -c ${tools.awk} '`);
  });
});

// Linux distributions differ in where grep, awk and bash live (/bin without a
// merged /usr). The hook takes each from a fixed list, never PATH, and a host
// with none of a tool's paths refuses the launch instead of denying every tool.
describe('Antigravity hook tool paths', () => {
  afterEach(() => {
    missingFiles = new Set();
  });

  it('takes the first usable fixed path for each tool', async () => {
    const probed: string[] = [];
    const present = new Set(['/usr/bin/bash', '/bin/grep', '/usr/bin/awk']);
    const tools = await resolveAntigravityHookTools('linux', (file) => {
      probed.push(file);
      return Promise.resolve(present.has(file));
    });
    expect(tools).toEqual({
      bash: '/usr/bin/bash',
      grep: '/bin/grep',
      awk: '/usr/bin/awk',
    });
    // Only the fixed candidates are probed, in order; PATH never is.
    expect(probed).toEqual([
      '/bin/bash',
      '/usr/bin/bash',
      '/usr/bin/grep',
      '/bin/grep',
      '/usr/bin/awk',
    ]);
    const script = antigravityToolGateScript('linux', tools);
    expect(script.startsWith('#!/usr/bin/bash\n')).toBe(true);
    expect(script).toContain('| exec -c /bin/grep -a -o -E ');
    expect(script).toContain("| exec -c /usr/bin/awk '");
    expect(script).not.toContain('/usr/bin/grep');
    expect(script).not.toContain(' /bin/awk ');
    expect(script).not.toContain('#!/bin/bash');
  });

  it.each(['bash', 'grep', 'awk'] as const)(
    'refuses a Linux host without %s at any fixed path',
    async (tool) => {
      const candidates = ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS[tool];
      await expect(
        resolveAntigravityHookTools('linux', (file) =>
          Promise.resolve(!candidates.includes(file)),
        ),
      ).rejects.toThrow(
        `Google chats need ${tool}, which wasn't found at ${candidates.join(' or ')}. Install it, then try again.`,
      );
    },
  );

  it('keeps the fixed macOS tools without probing', async () => {
    const probe = jest.fn((): Promise<boolean> => Promise.resolve(false));
    await expect(resolveAntigravityHookTools('darwin', probe)).resolves.toEqual(
      { bash: '/bin/bash', grep: '/usr/bin/grep', awk: '/usr/bin/awk' },
    );
    expect(probe).not.toHaveBeenCalled();
    expect(
      antigravityToolGateScript('darwin').startsWith('#!/bin/bash\n'),
    ).toBe(true);
  });

  (process.platform === 'linux' ? it : it.skip)(
    'refuses to prepare a profile when awk is missing',
    async () => {
      missingFiles = new Set(ANTIGRAVITY_LINUX_HOOK_TOOL_PATHS.awk);
      const dir = await mkdtemp(join(tmpdir(), 'agy-gate-tools-'));
      try {
        await expect(prepareAntigravityProfile(dir)).rejects.toThrow(
          /Google chats need awk, which wasn't found at \/usr\/bin\/awk or \/bin\/awk/,
        );
        // Nothing was written, so no stale hook can run.
        await expect(readdir(dir)).resolves.toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
