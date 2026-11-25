// Golden: on Linux x64 and arm64 the Cursor, Copilot and OpenCode harnesses
// follow their pinned runtimes into the provider host and delegation, an
// OpenCode pipeline step's launched process never receives step-declared
// loader or shell-startup variables (the Cursor runner's equivalent is
// cursor-step-environment.golden.test.ts), Cursor's account-usage read uses
// the managed sign-in from the private profile, never the user's own, and a
// Copilot pipeline step's runtime gets the same loader filter. Real runtime
// metadata, with the host platform and architecture overridden.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('../antigravity/feature-flag', () => ({
  isAntigravityHarnessEnabled: jest.fn(() => true),
}));
jest.mock('../cursor/feature-flag', () => ({
  isCursorHarnessEnabled: jest.fn(() => true),
}));
jest.mock('../copilot/feature-flag', () => ({
  isCopilotHarnessEnabled: jest.fn(() => true),
  assertCopilotHarnessEnabled: jest.fn(),
}));
jest.mock('../opencode/feature-flag', () => ({
  isOpenCodeHarnessEnabled: jest.fn(() => true),
  assertOpenCodeHarnessEnabled: jest.fn(),
}));
// The Cursor usage cases resolve the managed runtime to a stand-in launcher,
// with Cursor connected.
let mockCursorLaunch = { command: '', prefix: [] as string[] };
jest.mock('../cursor/runtime-installer', () => ({
  ...jest.requireActual<object>('../cursor/runtime-installer'),
  CursorRuntimeInstaller: class {
    verify(): Promise<typeof mockCursorLaunch> {
      return Promise.resolve(mockCursorLaunch);
    }
  },
}));
jest.mock('../cursor/runtime-status', () => ({
  cursorConnectionStatus: jest.fn(() =>
    Promise.resolve({ enabled: true, supported: true, installed: true }),
  ),
}));
// The OpenCode step case opens the desktop's managed runtime over a stand-in
// executable, with OpenCode connected.
let mockOpenCodeExecutable = '';
jest.mock('../opencode/runtime-installer', () => ({
  OpenCodeRuntimeInstaller: class {
    verify(): Promise<string> {
      return Promise.resolve(mockOpenCodeExecutable);
    }
  },
}));
// The Copilot step case opens the desktop's managed runtime over a stand-in
// executable, with an account connected and its grant present.
let mockCopilotExecutable = '';
jest.mock('../copilot/runtime-installer', () => ({
  CopilotRuntimeInstaller: class {
    verify(): Promise<string> {
      return Promise.resolve(mockCopilotExecutable);
    }
  },
}));
jest.mock('../copilot/grant-authority', () => ({
  ...jest.requireActual<object>('../copilot/grant-authority'),
  copilotGrantAuthority: jest.fn(() => ({
    binding: (): Promise<{ host: string; id: string; entryId: string }> =>
      Promise.resolve({ host: 'github.com', id: 'grant', entryId: 'entry' }),
  })),
}));
// Process ownership is the host's; the launch itself is the direct spawner's.
jest.mock('../agent-runs/provider-process-host', () => ({
  spawnProviderProcess: jest.fn((request: unknown) =>
    jest
      .requireActual<{
        spawnProviderProcessDirect: (request: unknown) => unknown;
      }>('@canopy/desktop-shared/node/provider-process/spawn')
      .spawnProviderProcessDirect(request),
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  ...jest.requireActual<object>('../lib/preferences-store'),
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      opencodeEnabled: true,
      copilotEnabled: true,
      copilotAccount: { host: 'github.com', login: 'octocat' },
    }),
  ),
}));
jest.mock('../feature-flags', () => ({
  ...jest.requireActual<object>('../feature-flags'),
  getFeatureFlagService: jest.fn(() => ({
    isEnabled: jest.fn(() => true),
    onSnapshotChanged: jest.fn(),
  })),
}));
jest.mock('../lib/model-policy-state', () => ({
  isOrgModelPolicyActiveForStoredAccount: jest.fn(() => Promise.resolve(false)),
  isModelBlockedByCurrentPolicy: jest.fn(() => false),
}));
jest.mock('../agent-providers/provider-usage-projection', () => ({
  projectRemoteControlProviderUsage: jest.fn(),
  readRemoteControlProviderUsageAccountProxySource: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/platform-capabilities', () => ({
  isOllamaSupportedOnPlatform: jest.fn(() => true),
}));

const realPlatform = process.platform;
const realArch = process.arch;
function presentAs(platform: NodeJS.Platform, arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'platform', { value: platform });
  Object.defineProperty(process, 'arch', { value: arch });
}
afterEach(() => {
  presentAs(realPlatform, realArch);
});

describe('provider host and delegation on Linux', () => {
  it.each(['x64', 'arm64'] as const)(
    'linux-%s supports Cursor, Copilot and OpenCode',
    async (arch) => {
      const { desktopProviderSources } =
        await import('../agent-providers/desktop-provider-host');
      const { delegationRuntimeUnavailableReason } =
        await import('../agents/delegation/runtime-support');
      presentAs('linux', arch);
      expect(await desktopProviderSources.supported()).toMatchObject({
        cursor: true,
        copilot: true,
        opencode: true,
      });
      for (const harness of ['cursor', 'copilot', 'opencode'])
        expect(
          await delegationRuntimeUnavailableReason(harness),
        ).toBeUndefined();
    },
  );

  it('an unpinned Linux architecture has none, with its reason', async () => {
    const { desktopProviderSources } =
      await import('../agent-providers/desktop-provider-host');
    const {
      delegationRuntimeUnavailableReason,
      DELEGATION_RUNTIME_NO_PIN_REASON,
    } = await import('../agents/delegation/runtime-support');
    presentAs('linux', 'ia32');
    expect(await desktopProviderSources.supported()).toMatchObject({
      cursor: false,
      copilot: false,
      opencode: false,
    });
    for (const harness of ['cursor', 'copilot', 'opencode'])
      expect(await delegationRuntimeUnavailableReason(harness)).toBe(
        DELEGATION_RUNTIME_NO_PIN_REASON,
      );
  });
});

// An OpenCode pipeline step's own environment reaches the runtime the desktop
// opens for it, and through it the launched process. glibc reports a preload
// it cannot open on stderr, and bash would run PS4 under SHELLOPTS=xtrace, so
// a leaked value is visible in a real child without loading any code.
const linux = process.platform === 'linux' ? describe : describe.skip;
linux('an OpenCode pipeline step on Linux', () => {
  let root: string;
  const savedLibraryPath = process.env.LD_LIBRARY_PATH;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'opencode-linux-step-'));
    // The app's own environment keeps its library path; only the step's
    // values are refused.
    process.env.LD_LIBRARY_PATH = join(root, 'inherited-lib');
    mkdirSync(process.env.LD_LIBRARY_PATH);
  });
  afterEach(() => {
    if (savedLibraryPath === undefined) delete process.env.LD_LIBRARY_PATH;
    else process.env.LD_LIBRARY_PATH = savedLibraryPath;
    rmSync(root, { recursive: true, force: true });
  });

  async function launchStep(
    step: (markers: string) => Record<string, string>,
  ): Promise<void> {
    const markers = join(root, 'markers');
    mkdirSync(markers);
    const executable = join(root, 'opencode');
    writeFileSync(
      executable,
      `#!/usr/bin/env bash\nenv > '${root}/seen.env'\n`,
      { mode: 0o755 },
    );
    mockOpenCodeExecutable = executable;
    const { openManagedOpenCodeRuntime } =
      await import('../opencode/connection');
    const { spawnProviderProcessDirect } =
      await import('@canopy/desktop-shared/node/provider-process/spawn');
    const runtime = await openManagedOpenCodeRuntime({
      signal: new AbortController().signal,
      executionKind: 'pipeline',
      providerConfiguration: 'host-inference',
      environment: { ...step(markers), STEP_VALUE: 'kept' },
    });
    try {
      // The pipeline launch: the verified executable with the runtime's env.
      const child = spawnProviderProcessDirect({
        command: runtime.executable,
        args: ['acp'],
        cwd: root,
        env: runtime.env,
        owner: { kind: 'pipeline', id: 'opencode-step' },
      });
      child.stdin?.end();
      child.stdout.resume();
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => (stderr += String(chunk)));
      expect(await new Promise((resolve) => child.once('close', resolve))).toBe(
        0,
      );
      expect(stderr).not.toMatch(/ld\.so|missing/);
      expect(readdirSync(markers)).toEqual([]);
      const inherited = `LD_LIBRARY_PATH=${join(root, 'inherited-lib')}`;
      const seen = readFileSync(join(root, 'seen.env'), 'utf8').split('\n');
      expect(seen).toContain('STEP_VALUE=kept');
      expect(seen).toContain(inherited);
      expect(
        seen.filter(
          (line) =>
            /^(LD_|GCONV_PATH=|BASH_ENV=|SHELLOPTS=|PS4=)/.test(line) &&
            line !== inherited,
        ),
      ).toEqual([]);
    } finally {
      await runtime.close();
    }
  }

  it('never hands step-declared loader or shell-startup variables to the launched process', async () => {
    await launchStep((markers) => {
      const preload = join(root, 'missing-preload.so');
      return {
        LD_PRELOAD: preload,
        LD_AUDIT: preload,
        LD_LIBRARY_PATH: join(root, 'step-lib'),
        GCONV_PATH: root,
        SHELLOPTS: 'xtrace',
        PS4: `$(touch '${markers}/ps4')`,
      };
    });
  });

  it('refuses a key the child would read as a refused name', async () => {
    // A child reads `LD_PRELOAD=<dir>/missing` = `preload.so` as LD_PRELOAD,
    // and `BASH_ENV=<dir>/startup` = `sh` as BASH_ENV.
    await launchStep((markers) => {
      writeFileSync(join(root, 'startup=sh'), `touch '${markers}/bash-env'\n`);
      return {
        [`LD_PRELOAD=${join(root, 'missing')}`]: 'preload.so',
        [`BASH_ENV=${join(root, 'startup')}`]: 'sh',
      };
    });
  });
});

// A Copilot pipeline step's own environment reaches the runtime the desktop
// opens for it on the managed (legacy) path; the vault pilot refuses Linux.
// The Copilot CLI is a native executable, so a step's LD_PRELOAD or LD_AUDIT
// would load code into it before any tool approval. The stand-in records the
// environment it was launched with, then exits without serving, so the open
// fails after the launch.
linux('a Copilot pipeline step on Linux', () => {
  let root: string;
  const saved = {
    libraryPath: process.env.LD_LIBRARY_PATH,
    dataDir: process.env.CANOPY_DATA_DIR,
  };
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'copilot-linux-step-'));
    mkdirSync(join(root, 'data'));
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    process.env.LD_LIBRARY_PATH = join(root, 'inherited-lib');
    mkdirSync(process.env.LD_LIBRARY_PATH);
  });
  afterEach(() => {
    restore('LD_LIBRARY_PATH', saved.libraryPath);
    restore('CANOPY_DATA_DIR', saved.dataDir);
    rmSync(root, { recursive: true, force: true });
  });

  async function launchStep(
    step: (markers: string) => Record<string, string>,
  ): Promise<void> {
    const markers = join(root, 'markers');
    mkdirSync(markers);
    const executable = join(root, 'copilot');
    writeFileSync(
      executable,
      `#!/usr/bin/env bash\nenv > '${root}/seen.env'\n`,
      { mode: 0o755 },
    );
    mockCopilotExecutable = executable;
    const { openManagedCopilotRuntime } = await import('../copilot/connection');
    await expect(
      openManagedCopilotRuntime({
        signal: AbortSignal.timeout(20_000),
        cwd: root,
        workspaceId: 'project',
        executionKind: 'pipeline',
        environment: { ...step(markers), STEP_VALUE: 'kept' },
        owner: { kind: 'pipeline', id: 'copilot-step' },
      }),
    ).rejects.toThrow('Copilot stopped during startup.');
    expect(readdirSync(markers)).toEqual([]);
    const inherited = `LD_LIBRARY_PATH=${join(root, 'inherited-lib')}`;
    const seen = readFileSync(join(root, 'seen.env'), 'utf8').split('\n');
    expect(seen).toContain('STEP_VALUE=kept');
    expect(seen).toContain(inherited);
    expect(
      seen.filter(
        (line) =>
          /^(LD_|GCONV_PATH=|BASH_ENV=|SHELLOPTS=|PS4=)/.test(line) &&
          line !== inherited,
      ),
    ).toEqual([]);
  }

  it('never hands step-declared loader or shell-startup variables to the Copilot runtime', async () => {
    await launchStep((markers) => {
      const preload = join(root, 'missing-preload.so');
      return {
        LD_PRELOAD: preload,
        LD_AUDIT: preload,
        LD_LIBRARY_PATH: join(root, 'step-lib'),
        GCONV_PATH: root,
        SHELLOPTS: 'xtrace',
        PS4: `$(touch '${markers}/ps4')`,
      };
    });
  });

  it('refuses a key the child would read as a refused name', async () => {
    await launchStep((markers) => {
      writeFileSync(join(root, 'startup=sh'), `touch '${markers}/bash-env'\n`);
      return {
        [`LD_PRELOAD=${join(root, 'missing')}`]: 'preload.so',
        [`BASH_ENV=${join(root, 'startup')}`]: 'sh',
      };
    });
  });
});

// The Cursor account-usage read on Linux, end to end through its production
// entry: the managed runtime is resolved and its private profile prepared for
// real, the pinned CLI's `status` runs (a bash stand-in that, like the real
// CLI, keeps its sign-in in $XDG_CONFIG_HOME/cursor/auth.json), the token is
// read from that profile, and Cursor's backend is a stub that records the
// token each request carries.
linux('Cursor account usage on Linux', () => {
  let root: string;
  let requests: Array<{ url: string; authorization: string | null }>;
  const saved = {
    dataDir: process.env.CANOPY_DATA_DIR,
    home: process.env.HOME,
    configHome: process.env.XDG_CONFIG_HOME,
  };
  const realFetch = globalThis.fetch;
  const restore = (name: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cursor-linux-usage-'));
    mkdirSync(join(root, 'data'));
    process.env.CANOPY_DATA_DIR = join(root, 'data');
    // The user's own Cursor CLI, signed in as someone else, under the real
    // HOME and XDG_CONFIG_HOME the app inherits.
    process.env.HOME = join(root, 'user-home');
    process.env.XDG_CONFIG_HOME = join(root, 'user-home', '.config');
    mkdirSync(join(process.env.XDG_CONFIG_HOME, 'cursor'), { recursive: true });
    writeFileSync(
      join(process.env.XDG_CONFIG_HOME, 'cursor', 'auth.json'),
      JSON.stringify({ accessToken: 'user-token' }),
    );
    requests = [];
    globalThis.fetch = jest.fn((input: string | URL | Request, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      const method = url.slice(url.lastIndexOf('/') + 1);
      const body =
        method === 'GetMe'
          ? { email: 'managed@example.com', userId: 'managed-user' }
          : method === 'GetCurrentPeriodUsage'
            ? {
                planUsage: { limit: 2000, includedSpend: 500, remaining: 1500 },
              }
            : {};
      return Promise.resolve(new Response(JSON.stringify(body)));
    });
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    restore('CANOPY_DATA_DIR', saved.dataDir);
    restore('HOME', saved.home);
    restore('XDG_CONFIG_HOME', saved.configHome);
    rmSync(root, { recursive: true, force: true });
  });

  /** The managed `cursor-agent`; `signIn` is bash run in its environment. */
  function installCli(signIn: string): void {
    const launcher = join(root, 'runtime', 'cursor-agent');
    mkdirSync(join(root, 'runtime'));
    writeFileSync(
      launcher,
      [
        '#!/usr/bin/env bash',
        'mkdir -p "$XDG_CONFIG_HOME/cursor"',
        'auth="$XDG_CONFIG_HOME/cursor/auth.json"',
        signIn,
        `echo '${JSON.stringify({
          isAuthenticated: true,
          userInfo: { email: 'managed@example.com', userId: 'managed-user' },
        })}'`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    mockCursorLaunch = { command: launcher, prefix: [] };
  }

  async function readUsage(): Promise<unknown> {
    const { readCursorAccountUsage } = await import('../cursor/account-usage');
    // A read that blocks (on a FIFO, say) must not hold the test either.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        readCursorAccountUsage(new AbortController().signal),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('stuck'), 3_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('reads usage with the managed sign-in from the private profile', async () => {
    installCli(
      `printf '%s' '${JSON.stringify({ accessToken: ' managed-token ' })}' > "$auth"`,
    );
    expect(await readUsage()).toMatchObject({
      provider: 'cursor',
      authState: 'authenticated',
      accountEmail: 'managed@example.com',
    });
    expect(requests.map(({ url }) => url.split('/').pop()).sort()).toEqual([
      'GetCurrentPeriodUsage',
      'GetHardLimit',
      'GetMe',
      'GetPlanInfo',
    ]);
    for (const request of requests)
      expect(request.authorization).toBe('Bearer managed-token');
  });

  it("never uses the user's own CLI sign-in when the managed one is missing", async () => {
    installCli(': no managed sign-in');
    expect(await readUsage()).toMatchObject({
      authState: 'unauthenticated',
      errorInfo: { kind: 'auth' },
    });
    expect(requests).toEqual([]);
  });

  it('treats an oversized sign-in as signed out', async () => {
    // Valid JSON padded past 64 KiB: only the size limit refuses it.
    installCli(
      `printf '%-65537s' '${JSON.stringify({ accessToken: 'oversized' })}' > "$auth"`,
    );
    expect(await readUsage()).toMatchObject({ authState: 'unauthenticated' });
    expect(requests).toEqual([]);
  });

  it('returns promptly when the sign-in is a FIFO, not a file', async () => {
    installCli('[ -p "$auth" ] || mkfifo "$auth"');
    const fifo = join(
      root,
      'data',
      'cursor-runtime-state',
      'home',
      '.config',
      'cursor',
      'auth.json',
    );
    try {
      expect(await readUsage()).toMatchObject({
        authState: 'unauthenticated',
      });
      expect(requests).toEqual([]);
    } finally {
      // Release a reader stuck in open(), so nothing outlives the test.
      const { constants } = await import('node:fs');
      const { open } = await import('node:fs/promises');
      const writer = await open(
        fifo,
        constants.O_WRONLY | constants.O_NONBLOCK,
      ).catch(() => null);
      await writer?.close();
    }
  });
});
