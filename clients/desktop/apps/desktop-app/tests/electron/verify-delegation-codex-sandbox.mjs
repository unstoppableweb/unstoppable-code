#!/usr/bin/env node
// Opt-in check of the delegated Codex sandbox profiles against the bundled
// Codex binary. It runs on macOS (Seatbelt) and Linux (the pinned default
// bwrap/seccomp backend). It is not part of any default npm script and makes
// no model call, network access, or real-credential access.
//
// Run: node --import tsx apps/desktop-app/tests/electron/verify-delegation-codex-sandbox.mjs
//
// Builds `delegated_read_only` and `delegated_write` with the production
// profile builder, writes them to a temporary CODEX_HOME (never the user's),
// and runs shell probes through `codex sandbox -P <profile>`. It checks that a
// whole-worktree (`.`) grant and a single-file grant are writable only under
// `delegated_write`, and that private names, nested repositories and the
// repository's Git metadata stay denied or read-only under both profiles. A
// real loopback listener confirms that a network-disabled profile denies even
// a local TCP connection (an actually measured denial, not just a declared
// one).
//
// Scope: this verifier supplies primary-checkout metadata grants itself. It
// does not exercise git-access.ts validation, its `execute` runtime probes, or
// linked-checkout sibling isolation. Those need separate native preparation
// evidence; a passing run here alone does not qualify that boundary.
//
// The probes run with a private, credential-free HOME and CODEX_HOME. HOME is a
// sibling of the sandbox-writable TMPDIR, never a descendant, so a private-HOME
// denial is not masked by the TMPDIR write grant.
//
// Platform specifics:
//   - macOS: the Seatbelt backend applies the profile in-process.
//   - Linux: the pinned runtime uses the bundled `bwrap` staged beside the
//     Codex binary (by PR6010, which this verifier does not reimplement) and
//     seccomp. Codex itself generates the `codex-linux-sandbox` argv[0] alias
//     under the private CODEX_HOME at run time, so there is nothing to stage
//     or point at here — the same invocation as macOS applies.
//   - Windows: the OS sandbox is unsupported there, so the check is skipped.
//
// It also drives the bundled app-server through the shared, Node-only
// `CodexRuntimeService` (the maintained path for app-server interaction, which
// runs standalone outside Electron) to check that a thread selects either
// profile from its thread config, which is how the runner chooses one per run.
// It reports whether `turn/start` accepts a profile.
import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { accessSync, constants as fsConstants, existsSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import profileModule from '../../src/main/agents/delegation/codex-sandbox-profile.ts';
import { createRequire } from 'node:module';

// Playwright 1.64 compiles this TypeScript as CommonJS once another module
// requires it; ESM imports of it then see no exports, so require it too.
const { hostOperatingSystem } = createRequire(import.meta.url)(
  '@canopy/core-platform/host-platform',
);

// The tsx loader does not expose this module's named exports to the static ESM
// linker, so resolve the canonical staged-binary API through a dynamic import,
// tolerating the CJS `default`-vs-namespace interop. Import and resolution
// failures surface rather than falling back.
const configPaths =
  await import('../../../../packages/execution-engine/src/pipelines/config-paths.ts');
const { getBundledCodexBinaryPath } = configPaths.default ?? configPaths;

const { buildCodexDelegationPermissionProfiles } = profileModule;

const os = hostOperatingSystem();
if (os === 'win32') {
  process.stdout.write(
    'Skipped: the OS sandbox is unsupported on Windows; the approval gate is its boundary.\n',
  );
  process.exit(0);
}
if (os !== 'darwin' && os !== 'linux') {
  process.stdout.write(
    `Skipped: the Codex sandbox check runs on macOS and Linux only (platform ${os ?? 'unsupported'}).\n`,
  );
  process.exit(0);
}

// The canonical staged-binary resolver (bundled runtime docs). Import and
// resolution failures surface rather than falling back to a guessed path.
const resolvedCodex = getBundledCodexBinaryPath();
if (!existsSync(resolvedCodex)) {
  process.stderr.write(`Missing bundled Codex binary: ${resolvedCodex}\n`);
  process.exit(1);
}
// Pin an absolute, symlink-resolved path up front (no cwd ever changes here, so
// relative resolution cannot drift). The CLI probes and the shared runtime both
// use this exact path, so neither can select a different Codex installation.
const codex = await realpath(resolvedCodex);

if (os === 'linux') {
  // The pinned Linux runtime shells out to a bundled `bwrap` staged beside the
  // Codex binary (by PR6010, not reimplemented here). Require that sibling;
  // Codex then generates its own `codex-linux-sandbox` argv[0] alias under the
  // private CODEX_HOME at run time, so there is nothing else to point at.
  const bwrap = path.join(path.dirname(codex), 'bwrap');
  try {
    await access(bwrap, fsConstants.X_OK);
  } catch {
    process.stderr.write(
      `Cannot qualify the Linux Codex sandbox: the bundled \`bwrap\` is not staged beside the Codex binary (${bwrap}). PR6010 stages it; stage it, then rerun.\n`,
    );
    process.exit(1);
  }
}

/** TOML basic strings accept JSON string escapes for these paths. */
const tomlKey = (value) => JSON.stringify(value);

function profileToml(name, profile) {
  const lines = [`[permissions.${name}.filesystem]`];
  for (const [entry, access] of Object.entries(profile.filesystem))
    lines.push(`${tomlKey(entry)} = ${tomlKey(access)}`);
  lines.push(`[permissions.${name}.network]`, 'enabled = false', '');
  return lines.join('\n');
}

const temporary = await realpath(
  await mkdtemp(path.join(tmpdir(), 'codex-delegation-sandbox-')),
);
const failures = [];
const sharedFixtures = [];
let checks = 0;
try {
  const cwd = path.join(temporary, 'worktree');
  const outside = path.join(temporary, 'outside');
  const scratch = path.join(temporary, 'tmpdir');
  const codexHome = path.join(temporary, 'codex-home');
  // A private, credential-free HOME. It is a sibling of the writable TMPDIR,
  // never a descendant, so the TMPDIR write grant cannot mask a HOME denial.
  const fixtureHome = path.join(temporary, 'home');
  // Private app-data roots so the shared runtime never reads real app state.
  const dataDir = path.join(temporary, 'app-data');
  const secureDataDir = path.join(temporary, 'app-secure');
  await Promise.all(
    [cwd, outside, scratch, codexHome, fixtureHome, dataDir, secureDataDir].map(
      (dir) => mkdir(dir, { recursive: true }),
    ),
  );
  execFileSync('git', ['init', '--quiet', cwd]);
  execFileSync('git', ['init', '--quiet', path.join(cwd, 'nested')]);
  const files = {
    'notes.txt': 'notes\n',
    'src/file.ts': 'source\n',
    '.env': 'SECRET=1\n',
    '.npmrc': 'token\n',
    'sub/.env.local': 'SECRET=2\n',
    'certs/key.pem': 'pem\n',
    '.claude/settings.json': '{}\n',
  };
  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await writeFile(path.join(cwd, relative), content);
  }
  await writeFile(path.join(outside, 'file.txt'), 'outside\n');

  const childEnv = {
    PATH: '/usr/bin:/bin',
    HOME: fixtureHome,
    CODEX_HOME: codexHome,
    TMPDIR: scratch,
  };

  // Every probe is bounded in time and captured output, and leaves nothing
  // behind beyond the temporary tree removed in the outer `finally`.
  const runWith = (profile, argv) =>
    spawnSync(codex, ['sandbox', '-P', profile, '-C', cwd, '--', ...argv], {
      cwd,
      encoding: 'utf8',
      env: childEnv,
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
    });
  const probeStarted = 'CANOPY_SANDBOX_PROBE_STARTED';
  // bwrap reports EROFS for writes outside its writable binds.
  const denialPattern =
    os === 'linux'
      ? /Operation not permitted|Permission denied|Read-only file system/i
      : /Operation not permitted|Permission denied/i;
  const run = (profile, script) =>
    runWith(profile, [
      '/bin/sh',
      '-c',
      `cat ${JSON.stringify(path.join(cwd, 'notes.txt'))} >/dev/null || exit 99; printf '${probeStarted}\\n'; ${script}`,
    ]);
  const expectResult = (label, profile, script, allowed) => {
    checks += 1;
    // These probes have one literal cat/redirection target. Check it on the
    // host; a missing create target requires an accessible parent instead.
    const match = script.match(/(?:^cat |>>? )(.+)$/);
    if (match) {
      const target = path.resolve(cwd, match[1].replace(/^"|"$/g, ''));
      const hostTarget = existsSync(target) ? target : path.dirname(target);
      accessSync(hostTarget, fsConstants.R_OK);
      if (script.startsWith('cat ')) accessSync(target, fsConstants.R_OK);
    }
    const result = run(profile, script);
    const succeeded = result.status === 0;
    if (
      result.error ||
      result.signal ||
      !result.stdout?.includes(probeStarted) ||
      succeeded !== allowed ||
      (!allowed && !denialPattern.test(result.stderr))
    )
      failures.push(
        `${label} [${profile}]: expected ${allowed ? 'allowed' : 'permission denial after authorized control'}, exit ${result.status}, signal ${result.signal}, error ${result.error?.message ?? 'none'}: ${(result.stderr || result.stdout || '').trim().slice(0, 300)}`,
      );
  };

  const scenarios = [
    { name: 'whole-worktree grant', writePaths: [cwd] },
    { name: 'single-file grant', writePaths: [path.join(cwd, 'notes.txt')] },
  ];
  for (const scenario of scenarios) {
    const profiles = buildCodexDelegationPermissionProfiles({
      cwd,
      writePaths: scenario.writePaths,
      gitRoots: [path.join(cwd, '.git')],
      gitPrivateRoots: [],
      temporaryDirectory: scratch,
    });
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'default_permissions = "delegated_read_only"\n' +
        Object.entries(profiles)
          .map(([name, profile]) => profileToml(name, profile))
          .join('\n'),
    );
    const label = (text) => `${scenario.name}: ${text}`;
    const whole = scenario.name === 'whole-worktree grant';
    // The grant: writable under the write profile only.
    expectResult(
      label('append to notes.txt'),
      'delegated_write',
      'echo x >> notes.txt',
      true,
    );
    expectResult(
      label('append to notes.txt'),
      'delegated_read_only',
      'echo x >> notes.txt',
      false,
    );
    expectResult(
      label('create src/new.ts'),
      'delegated_write',
      'echo x > src/new.ts',
      whole,
    );
    expectResult(
      label('create src/new.ts'),
      'delegated_read_only',
      'echo x > src/new.ts',
      false,
    );
    // The private TMPDIR is writable under both.
    for (const profile of ['delegated_write', 'delegated_read_only'])
      expectResult(
        label('write TMPDIR'),
        profile,
        `echo x > "${scratch}/t.txt"`,
        true,
      );
    // Denied or read-only under both profiles, whatever the grant.
    for (const profile of ['delegated_write', 'delegated_read_only']) {
      expectResult(label('read .env'), profile, 'cat .env', false);
      expectResult(label('write .env'), profile, 'echo x >> .env', false);
      expectResult(label('write .npmrc'), profile, 'echo x >> .npmrc', false);
      expectResult(
        label('write sub/.env.local'),
        profile,
        'echo x >> sub/.env.local',
        false,
      );
      expectResult(
        label('read certs/key.pem'),
        profile,
        'cat certs/key.pem',
        false,
      );
      expectResult(
        label('write certs/key.pem'),
        profile,
        'echo x >> certs/key.pem',
        false,
      );
      expectResult(
        label('write .claude/settings.json'),
        profile,
        'echo x >> .claude/settings.json',
        false,
      );
      expectResult(label('read .git/HEAD'), profile, 'cat .git/HEAD', true);
      expectResult(
        label('write .git/config'),
        profile,
        'echo x >> .git/config',
        false,
      );
      expectResult(
        label('create .git/new'),
        profile,
        'echo x > .git/new',
        false,
      );
      expectResult(
        label('read nested/.git/HEAD'),
        profile,
        'cat nested/.git/HEAD',
        false,
      );
      expectResult(
        label('write nested/.git/config'),
        profile,
        'echo x >> nested/.git/config',
        false,
      );
      expectResult(
        label('write outside the worktree'),
        profile,
        `echo x >> "${outside}/file.txt"`,
        false,
      );
    }
  }
  const env = await readFile(path.join(cwd, '.env'), 'utf8');
  if (env !== files['.env']) failures.push('.env changed on disk');

  // Shared-temp filesystem policy changes are macOS-only.
  // Canaries deliberately remain in the exposed namespaces, not a relocated
  // short socket fixture. Per-user T was already denied on the unchanged base.
  if (os === 'darwin') {
    for (const root of [
      '/private/tmp',
      '/private/var/tmp',
      await realpath(tmpdir()),
    ]) {
      const other = await realpath(
        await mkdtemp(path.join(root, 'canopy-other-task-')),
      );
      sharedFixtures.push(other);
      await writeFile(path.join(other, 'ordinary'), 'other task\n');
      await writeFile(path.join(other, '.env'), 'SYNTHETIC_OTHER_TASK=1\n');
      const selected = path.join(other, 'selected');
      const selectedTemporary = path.join(other, 'private-tmp');
      const capability = path.join(other, 'selected-capability');
      for (const directory of [selected, selectedTemporary, capability])
        await mkdir(directory);
      await writeFile(path.join(selected, 'source'), 'authorized\n');
      await writeFile(path.join(selected, '.env'), 'SYNTHETIC_PRIVATE=1\n');
      await writeFile(
        path.join(capability, 'SKILL.md'),
        'selected capability\n',
      );
      const profiles = buildCodexDelegationPermissionProfiles({
        cwd: selected,
        writePaths: [selected],
        readRoots: [cwd, capability],
        gitRoots: [],
        temporaryDirectory: selectedTemporary,
      });
      await writeFile(
        path.join(codexHome, 'config.toml'),
        Object.entries(profiles)
          .map(([name, profile]) => profileToml(name, profile))
          .join('\n'),
      );
      // Not present when the permission maps were built or written.
      await writeFile(path.join(other, 'late'), 'late other task\n');
      for (const profile of ['delegated_read_only', 'delegated_write']) {
        for (const spelling of new Set([
          other,
          other.replace(/^\/private\//, '/'),
        ])) {
          for (const name of ['ordinary', '.env', 'late'])
            expectResult(
              `unrelated temporary read ${spelling}/${name}`,
              profile,
              `cat "${spelling}/${name}"`,
              false,
            );
        }
        expectResult(
          'selected temporary checkout read',
          profile,
          `cat "${selected}/source"`,
          true,
        );
        expectResult(
          'selected temporary checkout private file',
          profile,
          `cat "${selected}/.env"`,
          false,
        );
        expectResult(
          'selected capability read',
          profile,
          `cat "${capability}/SKILL.md"`,
          true,
        );
        expectResult(
          'selected capability stays read-only',
          profile,
          `echo x >> "${capability}/SKILL.md"`,
          false,
        );
        expectResult(
          'selected private TMPDIR write',
          profile,
          `echo x > "${selectedTemporary}/writable"`,
          true,
        );
        expectResult(
          'selected temporary checkout write',
          profile,
          `echo x >> "${selected}/source"`,
          profile === 'delegated_write',
        );
      }
    }
  }

  // A network-disabled profile must deny even a loopback TCP connection. A real
  // listener on the host measures the denial instead of merely declaring it.
  // This proof is required, so a missing shell or an unreachable control fails
  // the run rather than skipping silently.
  const bash = ['/bin/bash', '/usr/bin/bash'].find((candidate) =>
    existsSync(candidate),
  );
  if (!bash) {
    checks += 1;
    failures.push(
      'network-denial check: no bash with /dev/tcp support was found to measure a real denied connection',
    );
  } else {
    const profiles = buildCodexDelegationPermissionProfiles({
      cwd,
      writePaths: [cwd],
      gitRoots: [path.join(cwd, '.git')],
      gitPrivateRoots: [],
      temporaryDirectory: scratch,
    });
    await writeFile(
      path.join(codexHome, 'config.toml'),
      'default_permissions = "delegated_read_only"\n' +
        Object.entries(profiles)
          .map(([name, profile]) => profileToml(name, profile))
          .join('\n'),
    );
    const listener = net.createServer((socket) => socket.destroy());
    await new Promise((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const { port } = listener.address();
    const connect = `exec 3<>/dev/tcp/127.0.0.1/${port}`;
    try {
      // Control: the listener is reachable from the host (no sandbox). Without
      // it, a denied result could be a dead port rather than a real denial.
      const control = spawnSync(bash, ['-c', connect], {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
      if (control.status !== 0) {
        checks += 1;
        failures.push(
          `network-denial check: the loopback control connection failed (exit ${control.status}), so a sandbox denial cannot be distinguished from a dead port`,
        );
      } else {
        for (const profile of ['delegated_write', 'delegated_read_only']) {
          checks += 1;
          const result = runWith(profile, [
            bash,
            '-c',
            `printf '${probeStarted}\\n'; ${connect}`,
          ]);
          if (
            result.error ||
            result.signal ||
            result.status === 0 ||
            !result.stdout?.includes(probeStarted) ||
            !/Operation not permitted|Permission denied/i.test(result.stderr)
          )
            failures.push(
              `loopback connect [${profile}]: expected permission denial after startup, exit ${result.status}, signal ${result.signal}, error ${result.error?.message ?? 'none'}: ${result.stderr}`,
            );
        }
      }
    } finally {
      await new Promise((resolve) => listener.close(resolve));
    }
  }

  // Profile selection through the shared Codex runtime, standalone. Point HOME,
  // CODEX_HOME, TMPDIR and the app-data roots at the private fixtures before
  // importing the runtime so its startup never reads the real HOME, CODEX_HOME
  // or app state, then restore the original environment after shutdown.
  const privateEnv = {
    HOME: fixtureHome,
    CODEX_HOME: codexHome,
    TMPDIR: scratch,
    CANOPY_DATA_DIR: dataDir,
    CANOPY_SECURE_DATA_DIR: secureDataDir,
    // Pin the runtime's Codex to the exact binary the CLI probes used.
    CODEX_EXECUTABLE: codex,
  };
  const savedEnv = Object.fromEntries(
    Object.keys(privateEnv).map((key) => [key, process.env[key]]),
  );
  const originalWorkingDirectory = process.cwd();
  Object.assign(process.env, privateEnv);
  process.chdir(cwd);
  const ownedChildren = new Set();
  try {
    const hooksModule =
      await import('../../../../packages/execution-engine/src/node/codex-runtime/host-hooks.ts');
    const runtimeModule =
      await import('../../../../packages/execution-engine/src/node/codex-runtime/runtime-service.ts');
    const { configureCodexRuntimeHostHooks } =
      hooksModule.default ?? hooksModule;
    const { createCodexRuntimeService } =
      runtimeModule.default ?? runtimeModule;
    configureCodexRuntimeHostHooks({
      clientInfo: () => ({
        name: 'canopy-delegation-profile-verify',
        title: 'Delegation profile verifier',
        version: '1',
      }),
      productDisplayName: () => 'Delegation profile verifier',
      registerProcess: () => ({ update() {}, unregister() {} }),
      registerProcessOwner: (child) => ownedChildren.add(child),
      unregisterProcessOwner: (child) => ownedChildren.delete(child),
      recordDiagnostic: () => {},
    });
    const service = createCodexRuntimeService({
      mcpLauncher: { command: 'unused-mcp-launcher', args: [] },
    });
    const adminProfile = {
      environmentPolicy: 'restricted',
      includeCanopySecrets: false,
      configArgs: ['-c', 'check_for_update_on_startup=false'],
    };
    try {
      // The runtime must operate on the private fixture app state, not the real
      // user's: its canonical CODEX_HOME is the fixture CODEX_HOME.
      checks += 1;
      try {
        const { codexHome: observedCodexHome } =
          await service.getCanonicalState();
        if (observedCodexHome !== codexHome)
          failures.push(
            `runtime canonical CODEX_HOME ${observedCodexHome} is not the private fixture ${codexHome}`,
          );
      } catch (error) {
        failures.push(`runtime canonical state unavailable: ${error.message}`);
      }
      const profiles = buildCodexDelegationPermissionProfiles({
        cwd,
        writePaths: [path.join(cwd, 'notes.txt')],
        gitRoots: [path.join(cwd, '.git')],
        temporaryDirectory: scratch,
      });
      const threadConfig = {
        permissions: profiles,
        model_provider: 'unreachable',
        model_providers: {
          unreachable: {
            name: 'unreachable',
            base_url: 'http://127.0.0.1:9/v1',
            wire_api: 'responses',
            request_max_retries: 0,
            stream_max_retries: 0,
          },
        },
      };
      let threadId;
      for (const selected of ['delegated_write', 'delegated_read_only']) {
        checks += 1;
        let active;
        try {
          const started = await service.admin().request(
            'thread/start',
            {
              cwd,
              model: 'unreachable-model',
              approvalPolicy: 'untrusted',
              permissions: selected,
              experimentalRawEvents: false,
              config: { ...threadConfig, default_permissions: selected },
            },
            adminProfile,
          );
          active = started?.activePermissionProfile?.id;
          threadId = started?.thread?.id ?? threadId;
        } catch (error) {
          active = `error: ${error.message}`;
        }
        if (active !== selected)
          failures.push(
            `thread/start ${selected}: active profile ${active ?? '(none)'}`,
          );
      }
      try {
        await service.admin().request(
          'turn/start',
          {
            threadId,
            input: [{ type: 'text', text: 'probe', text_elements: [] }],
            permissions: 'delegated_write',
          },
          adminProfile,
        );
        process.stdout.write(
          'Note: turn/start now accepts a profile; per-turn selection may be possible.\n',
        );
      } catch (error) {
        process.stdout.write(
          `turn/start profile selection is rejected by this runtime (${error.message}); the runner selects the profile per thread.\n`,
        );
      }
    } finally {
      await service.shutdown();
      for (const child of ownedChildren) {
        try {
          child.kill();
        } catch {
          // The runtime shutdown already reaped it.
        }
      }
    }
  } finally {
    // Restore the caller context after the runtime has shut down.
    process.chdir(originalWorkingDirectory);
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
} finally {
  for (const directory of sharedFixtures)
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
}

if (failures.length) {
  process.stderr.write(
    `Delegated Codex sandbox: ${failures.length} of ${checks} checks failed\n${failures.map((line) => `- ${line}`).join('\n')}\n`,
  );
  process.exit(1);
}
process.stdout.write(`Delegated Codex sandbox: all ${checks} checks passed\n`);
