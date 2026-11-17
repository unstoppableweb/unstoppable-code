// Golden (CAN-6714): the private Antigravity profile's PreToolUse hook is the
// only gate for native tools that skip the ACP permission request. Antigravity
// 1.5.1 treats empty hook output with exit 0 as allow, so the hook must print
// exactly one decision or exit non-zero on every path. The hook uses macOS
// /usr/bin/plutil, so this contract runs on the macOS platform-services lane.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brandEnvName } from '@canopy/execution-engine/brand/env';
import { prepareAntigravityProfile } from '../runtime';

jest.mock('@canopy/desktop-shared/node/acp', () => ({ connectAcp: jest.fn() }));

const darwinDescribe = process.platform === 'darwin' ? describe : describe.skip;

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

darwinDescribe('Antigravity native tool gate', () => {
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
    for (const [locale, charmap] of [
      [{ LC_ALL: 'en_US.UTF-8' }, 'UTF-8'],
      [{ LC_ALL: 'ja_JP.eucJP' }, 'eucJP'],
      [{ LANG: 'ja_JP.eucJP' }, 'eucJP'],
      [{ LC_CTYPE: 'ja_JP.eucJP' }, 'eucJP'],
    ] as const) {
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
});
