import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  observeWindowsColdProcesses,
  observeLinuxColdProcesses,
  observeLinuxColdProcess,
  parseWindowsColdObservation,
  LinuxColdInspectionError,
  WindowsColdInspectionError,
  type NativeColdProcess,
} from '@canopy/core-platform';
import { InternalRootMigrationRefused } from '@canopy/core-runtime/node/internal-root-migration';
import {
  assertInternalRootNativeCold,
  internalRootColdHost,
} from '../native-cold';
import canopy from '../../../../../../brands/canopy/brand.json';
import unstoppable from '../../../../../../brands/unstoppable-code/brand.json';
const root = resolve(__dirname, '../../../../../..');
const helper = join(root, '.cache/bin/win32-x64/canopy-process-identity.exe');
const brands = [canopy, unstoppable];
const mounts = '10 0 8:1 / / rw - ext4 /dev/sda1 rw\n';
const row = (executable: string, pid = 42): NativeColdProcess => ({
  pid,
  scope: 'same-user',
  parentPid: 1,
  startIdentity: `linux:v1:${pid}:boot:123`,
  executable,
  paths: [],
  comm: 'fixture',
  linuxMountInfo: mounts,
});
const self = row('/usr/bin/node', 99);
function observedWindowsProductImage(image: string): boolean {
  const parts = image.split(/[\\/]/);
  const name = parts.pop() ?? '';
  if (
    /^(?:(?:canopy|unstoppable[- ]code)(?:d|-desktop| \(Internal\)| \(RC\))?(?: helper(?: \([^)]+\))?)?|canopy-(?:file-broker|dictate|process-identity))\.exe$/i.test(
      name,
    )
  )
    return true;
  return (
    /^(?:chrome_)?crashpad_handler\.exe$/i.test(name) &&
    parts.some((part) =>
      /^(?:canopy|unstoppable[- ]code)(?: \(Internal\)| \(RC\))?$/i.test(part),
    )
  );
}
async function windowsObserverOwnerIsUser(): Promise<boolean> {
  const { stdout, stderr } = await promisify(execFile)(
    join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); ($identity.Owner.Value -eq $identity.User.Value).ToString()',
    ],
    { windowsHide: true, timeout: 15_000 },
  );
  expect(stderr).toBe('');
  expect(stdout.trim()).toMatch(/^(True|False)$/);
  return stdout.trim() === 'True';
}
function assertLinuxManagersClassified(
  rows: readonly NativeColdProcess[],
  refusals: LinuxColdInspectionError['refusals'] = [],
): void {
  const manager = rows.find(
    (row) => row.scope === 'linux-user-manager' && row.executable === 'systemd',
  );
  expect(manager).toMatchObject({ parentPid: 1, paths: [] });
  const pam = rows.find(
    (row) =>
      row.scope === 'linux-user-manager' &&
      row.executable === '(sd-pam)' &&
      row.parentPid === manager?.pid,
  );
  expect(pam).toMatchObject({ paths: [] });
  for (const row of rows.filter((row) => row.scope === 'linux-user-manager')) {
    expect(refusals.some((refusal) => refusal.pid === row.pid)).toBe(false);
    if (row.executable === '(sd-pam)') {
      expect(rows.find((parent) => parent.pid === row.parentPid)).toMatchObject(
        {
          scope: 'linux-user-manager',
          executable: 'systemd',
          parentPid: 1,
        },
      );
    } else expect(row.executable).toBe('systemd');
  }
}

/** Qualification evidence only: neither branch admits an incomplete snapshot. */
function windowsColdRefusalFacts(error: unknown): string {
  if (!(error instanceof WindowsColdInspectionError)) throw error;
  expect(error.code).toBe('inspection-incomplete');
  expect(Number.isInteger(error.pid)).toBe(true);
  expect(error.pid).toBeGreaterThanOrEqual(2);
  expect(error.pid).toBeLessThanOrEqual(2147483647);
  expect(error.image.length).toBeGreaterThan(0);
  expect(error.image).not.toContain('\0');
  if (error.reason === 'pid-reuse') {
    const { before, after } = error;
    if (!before || !after) throw error;
    for (const observation of [before, after]) {
      expect(observation.pid).toBe(error.pid);
      expect(observation.image.length).toBeGreaterThan(0);
      expect(observation.image).not.toContain('\0');
      expect(observation.creationIdentity).toMatch(/^\d{20}$/);
      const ticks = BigInt(observation.creationIdentity);
      expect(ticks === 0n || ticks > 9n).toBe(true);
      expect(ticks <= 2650467743999999999n).toBe(true);
      expect([
        'same-owner',
        'same-token',
        'foreign-owner',
        'foreign-token',
        'owner-rights-denied',
        'kernel-idle',
        'post-t',
        'exited',
      ]).toContain(observation.scope);
    }
    expect(error.stage).toBe('process-continuity');
    expect(error.image).toBe(before.image);
    expect(error.startIdentity).toBe(
      `win32:v1:${error.pid}:${before.creationIdentity}`,
    );
    expect(
      before.image !== after.image ||
        (BigInt(before.creationIdentity) > 9n &&
          BigInt(after.creationIdentity) > 9n &&
          before.creationIdentity !== after.creationIdentity),
    ).toBe(true);
    return `pid-reuse: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
  }
  // Rail can-5879-pid-reuse (b): no other typed or generic incompleteness qualifies.
  expect(error.reason).toBe('retry-exhausted');
  expect(Number.isSafeInteger(error.elapsedMs)).toBe(true);
  expect(error.elapsedMs).toBeGreaterThanOrEqual(1000);
  expect(Number.isInteger(error.attempts)).toBe(true);
  expect(error.attempts).toBeGreaterThanOrEqual(1);
  expect(error.attempts).toBeLessThanOrEqual(7);
  expect(['image-name', 'mapping-query', 'mapping-name']).toContain(
    error.stage,
  );
  expect(error.startIdentity).toMatch(
    new RegExp(`^win32:v1:${error.pid}:\\d{20}$`),
  );
  const ticks = BigInt(error.startIdentity.split(':').pop() ?? '');
  expect(ticks > 9n && ticks <= 2650467743999999999n).toBe(true);
  expect(error.message).toBe(
    `close ${error.image} (pid ${error.pid}) and retry`,
  );
  return `retry-exhausted: pid=${error.pid} image=${JSON.stringify(error.image)} identity=${error.startIdentity} stage=${error.stage} attempts=${error.attempts} elapsedMs=${error.elapsedMs}`;
}

/** Ambient churn may defer a fixture assertion, never satisfy it. */
async function observeWindowsFixtureSnapshot<T>(
  fixturePid: number,
  observe: () => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await observe();
    } catch (error) {
      if (
        !(error instanceof WindowsColdInspectionError) ||
        error.pid === fixturePid
      )
        throw error;
      const facts = windowsColdRefusalFacts(error);
      process.stdout.write(
        `fixture snapshot refusal: fixturePid=${fixturePid} attempt=${attempt} unrelated refusal: ${facts}; next=${attempt < 3 ? 're-observe' : 'fail'}\n`,
      );
      if (attempt >= 3) throw error;
    }
  }
}

/** Product presence does not make a complete enumeration incomplete or cold. */
function windowsEnumerationSuccessFacts(
  rows: readonly NativeColdProcess[],
): string {
  const products = rows.filter((row) => {
    if (row.pid === process.pid || !row.executable) return false;
    const parts = row.executable.split(/[\\/]/);
    const name = parts.pop() ?? '';
    return (
      /^(?:(?:canopy|unstoppable[- ]code)(?:d|-desktop| \(Internal\)| \(RC\))?(?: helper(?: \([^)]+\))?)?|canopy-(?:file-broker|dictate|process-identity))\.exe$/i.test(
        name,
      ) ||
      (/^(?:chrome_)?crashpad_handler\.exe$/i.test(name) &&
        parts.some((part) =>
          /^(?:canopy|unstoppable[- ]code)(?: \(Internal\)| \(RC\))?$/i.test(
            part,
          ),
        ))
    );
  });
  const facts = products
    .map(
      (row) =>
        `pid=${row.pid} scope=${row.scope} image=${JSON.stringify(row.executable)}`,
    )
    .join('; ');
  return `${rows.length} unfiltered native rows${facts ? `; observed product image: ${facts}` : ''}`;
}

async function protectedKernel(): Promise<void> {
  // Non-admin Windows 11 is the acceptance host; elevated CI proves refusal.
  const ownerIsUser = await windowsObserverOwnerIsUser();
  const observation = promisify(execFile)(helper, ['--cold-classify', '4'], {
    env: {},
    windowsHide: true,
    timeout: 35_000,
    maxBuffer: 64 << 20,
  });
  if (!ownerIsUser) {
    await expect(observation).rejects.toMatchObject({
      code: 1,
      stdout: '',
    });
    await expect(observation).rejects.toHaveProperty(
      'stderr',
      expect.stringContaining(
        'cold observer owner mismatch: TokenOwner is not TokenUser',
      ),
    );
  } else {
    const output = await observation;
    expect(output.stderr).toBe('');
    expect(output.stdout).toMatch(
      /^canopy-cold-classification-v1 4 (owner-rights-denied|foreign-owner|foreign-token)\r?\n/,
    );
  }
}
async function enumerateWindows(): Promise<void> {
  const ownerIsUser = await windowsObserverOwnerIsUser();
  if (!ownerIsUser) {
    const observation = promisify(execFile)(
      helper,
      ['--cold-snapshot', String(process.pid)],
      { env: {}, windowsHide: true, timeout: 35_000, maxBuffer: 64 << 20 },
    );
    await expect(observation).rejects.toMatchObject({
      code: 1,
      stdout: '',
    });
    await expect(observation).rejects.toHaveProperty(
      'stderr',
      expect.stringContaining(
        'cold observer owner mismatch: TokenOwner is not TokenUser',
      ),
    );
    process.stdout.write(
      'whole-host enumeration refusal: independently observed elevated principal: TokenOwner != TokenUser; helper refused TokenOwner/TokenUser mismatch\n',
    );
  } else {
    let rows: readonly NativeColdProcess[];
    try {
      rows = await observeWindowsColdProcesses(helper);
    } catch (error) {
      const facts = windowsColdRefusalFacts(error);
      process.stdout.write(`whole-host enumeration refusal: ${facts}\n`);
      return;
    }
    expect(rows.find((row) => row.pid === process.pid)).toMatchObject({
      scope: 'same-user',
    });
    expect(rows.find((row) => row.pid === 4)).toMatchObject({
      scope: 'foreign',
    });
    process.stdout.write(
      `whole-host enumeration success: ${windowsEnumerationSuccessFacts(rows)}\n`,
    );
  }
}
async function coldWindows(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cold-whole-host-'));
  const host = internalRootColdHost('win32', {
    kind: 'repository',
    root: resolve(__dirname, '../../../../../..'),
  });
  try {
    const owner = await promisify(execFile)(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); ($identity.Owner.Value -eq $identity.User.Value).ToString()',
      ],
      { windowsHide: true, timeout: 15_000 },
    );
    expect(owner.stderr).toBe('');
    expect(owner.stdout.trim()).toMatch(/^(True|False)$/);
    if (owner.stdout.trim() === 'False') {
      await expect(host.observe()).rejects.toMatchObject({
        reason: 'cold-proof-unavailable',
      });
      process.stdout.write(
        'whole-host cold refusal: independently observed TokenOwner/TokenUser mismatch (elevated observer)\n',
      );
      return;
    }
    // No process filtering or path fixtures: the entire native receipt reaches policy.
    let rows: readonly NativeColdProcess[];
    try {
      rows = await host.observe();
    } catch (error) {
      if (!host.windowsProcessPath) throw error;
      const diagnostic = await promisify(execFile)(
        host.windowsProcessPath,
        ['--cold-snapshot', String(process.pid)],
        { env: {}, windowsHide: true, timeout: 35_000, maxBuffer: 64 << 20 },
      ).catch((failure: unknown) => {
        throw new Error(
          `Whole-host observation failed: ${failure instanceof Error ? failure.message : String(failure)} stderr=${JSON.stringify(typeof failure === 'object' && failure !== null && 'stderr' in failure ? failure.stderr : null)}`,
          { cause: error },
        );
      });
      throw new Error(
        `Whole-host observer refused; diagnostic receipt tail=${diagnostic.stdout.slice(-1000)} stderr=${diagnostic.stderr}`,
        { cause: error },
      );
    }
    try {
      await assertInternalRootNativeCold({
        os: 'win32',
        rows,
        roots: [root],
        brands,
        managedPids: new Set(),
        selfPid: process.pid,
      });
      coldSuccesses++;
      process.stdout.write(
        `whole-host cold success: ${rows.length} unfiltered native rows\n`,
      );
    } catch (error) {
      process.stdout.write(
        `whole-host cold refusal: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      if (
        !(error instanceof InternalRootMigrationRefused) ||
        error.reason !== 'writer-active'
      )
        throw error;
      const product = /Product executable ([1-9]\d*) remains;/.exec(
        error.message,
      );
      if (!product) throw error;
      const observed = rows.find((entry) => entry.pid === Number(product[1]));
      expect(observed?.pid).not.toBe(process.pid);
      if (!observed?.executable) throw error;
      process.stdout.write(
        `whole-host observed product: pid=${observed.pid} scope=${observed.scope} image=${JSON.stringify(observed.executable)}\n`,
      );
      // Independently recognize the native kernel image, not the policy's refusal text.
      expect(observedWindowsProductImage(observed.executable)).toBe(true);
      // The image-only branch, not an inaccessible path, is the sole allowed refusal.
      expect(error.message).toContain('stop the app, CLI, daemon and helpers');
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function deletedWindows(): Promise<void> {
  const stdout = nativeFixtureOutput;
  if (stdout.includes('cold-delete-pending-owner-mismatch\n')) {
    throw new Error(
      'Native delete-pending fixture requires a non-admin observer',
    );
  }
  const receipt = /^cold-delete-pending-receipt ([A-Za-z0-9+/=]+)$/m.exec(
    stdout,
  )?.[1];
  if (!receipt)
    throw new Error('Missing non-admin native delete-pending evidence');
  const rows = parseWindowsColdObservation(
    Buffer.from(receipt, 'base64').toString('utf8'),
  );
  const root = await mkdtemp(join(tmpdir(), 'cold-unlinked-policy-'));
  try {
    await expect(
      assertInternalRootNativeCold({
        os: 'win32',
        rows: [{ ...row(process.execPath, process.pid) }, ...rows],
        roots: [root],
        brands,
        managedPids: new Set(),
      }),
    ).resolves.toBeUndefined();
    const mappedReceipt =
      /^cold-deleted-mapping-receipt ([A-Za-z0-9+/=]+)$/m.exec(stdout)?.[1];
    const lookalikeReceipt =
      /^cold-lookalike-mapping-receipt ([A-Za-z0-9+/=]+)$/m.exec(stdout)?.[1];
    const lookalikePath = /^cold-lookalike-mapping-path ([0-9a-f]+)$/m.exec(
      stdout,
    )?.[1];
    if (!mappedReceipt || !lookalikeReceipt || !lookalikePath)
      throw new Error('Missing native mapped deletion/location evidence');
    const mappedRows = parseWindowsColdObservation(
      Buffer.from(mappedReceipt, 'base64').toString('utf8'),
    );
    expect(
      mappedRows.some(
        (entry) => (entry.windowsDeletedMappings?.length ?? 0) > 0,
      ),
    ).toBe(true);
    await expect(
      assertInternalRootNativeCold({
        os: 'win32',
        rows: [row(process.execPath, process.pid), ...mappedRows],
        roots: [root],
        brands,
        managedPids: new Set(),
      }),
    ).resolves.toBeUndefined();
    const lookalike = parseWindowsColdObservation(
      Buffer.from(lookalikeReceipt, 'base64').toString('utf8'),
    );
    const affected = (lookalikePath.match(/.{4}/g) ?? [])
      .map((code) => String.fromCharCode(parseInt(code, 16)))
      .join('');
    expect(
      lookalike.every((entry) => !entry.windowsDeletedMappings?.length),
    ).toBe(true);
    expect(lookalike.some((entry) => entry.paths.includes(affected))).toBe(
      true,
    );
    await expect(
      assertInternalRootNativeCold({
        os: 'win32',
        rows: [row(process.execPath, process.pid), ...lookalike],
        roots: [affected],
        brands,
        managedPids: new Set(),
      }),
    ).rejects.toMatchObject({ reason: 'writer-active' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function reusedSlotWindows(): Promise<void> {
  const stdout = nativeFixtureOutput;
  if (stdout.includes('cold-reuse-owner-mismatch\n')) {
    throw new Error('Native reused-slot fixture requires a non-admin observer');
  }
  const encoded = /^cold-reuse-path ((?:[0-9a-f]{4})+)$/m.exec(stdout)?.[1];
  const receipt = /^cold-reuse-receipt ([A-Za-z0-9+/=]+)$/m.exec(stdout)?.[1];
  if (!encoded || !receipt)
    throw new Error('Missing native reused-slot evidence');
  const affectedPath = (encoded.match(/.{4}/g) ?? [])
    .map((code) => String.fromCharCode(parseInt(code, 16)))
    .join('');
  const rows = parseWindowsColdObservation(
    Buffer.from(receipt, 'base64').toString('utf8'),
  );
  expect(rows.some((entry) => entry.paths.includes(affectedPath))).toBe(true);
  await expect(
    assertInternalRootNativeCold({
      os: 'win32',
      rows: [{ ...row(process.execPath, process.pid) }, ...rows],
      roots: [affectedPath],
      brands,
      managedPids: new Set(),
      selfPid: process.pid,
    }),
  ).rejects.toMatchObject({ reason: 'writer-active' });
}
async function ownerRightsWindows(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cold-owner-'));
  const executable = join(directory, 'Canopy.exe');
  const helper = resolve(
    __dirname,
    '../../../../../..',
    '.cache/bin/win32-x64/canopy-process-identity.exe',
  );
  await copyFile(process.execPath, executable);
  const child = spawn(
    executable,
    ['-e', "process.on('message',()=>process.exit(0));process.send('ready')"],
    {
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    },
  );
  try {
    await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const pid = child.pid;
    if (!pid) throw new Error('No protected product PID');
    const setup = await promisify(execFile)(
      join(
        process.env.SystemRoot ?? 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        String.raw`
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if ($identity.Owner.Value -ne $identity.User.Value) { 'owner-mismatch'; exit 0 }
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class ColdOwnerFixture {
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr pointer);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, uint revision, out IntPtr descriptor, IntPtr size);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, uint type, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  public static void Protect(uint pid, string sid) {
    IntPtr descriptor = IntPtr.Zero, process = IntPtr.Zero, dacl;
    bool present, defaulted;
    try {
      if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(D;;RC;;;OW)(A;;GA;;;" + sid + ")", 1, out descriptor, IntPtr.Zero)) throw new Win32Exception();
      if (!GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted) || !present) throw new Win32Exception();
      process = OpenProcess(0x40000, false, pid);
      if (process == IntPtr.Zero) throw new Win32Exception();
      uint error = SetSecurityInfo(process, 6, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
      if (error != 0) throw new Win32Exception((int)error);
    } finally {
      if (process != IntPtr.Zero) CloseHandle(process);
      if (descriptor != IntPtr.Zero) LocalFree(descriptor);
    }
  }
}
'@
[ColdOwnerFixture]::Protect(${pid}, $identity.User.Value)
'owner-is-user'
`,
      ],
      { windowsHide: true, timeout: 20_000 },
    );
    expect(setup.stderr).toBe('');
    expect(setup.stdout.trim()).toMatch(/^(owner-is-user|owner-mismatch)$/);
    const observation = promisify(execFile)(
      helper,
      ['--cold-classify', String(pid)],
      { env: {}, windowsHide: true, timeout: 35_000, maxBuffer: 64 << 20 },
    );
    if (setup.stdout.trim() === 'owner-mismatch') {
      await expect(observation).rejects.toMatchObject({
        code: 1,
        stdout: '',
      });
      await expect(observation).rejects.toHaveProperty(
        'stderr',
        expect.stringContaining(
          'cold observer owner mismatch: TokenOwner is not TokenUser',
        ),
      );
    } else {
      const { stdout, stderr } = await observation;
      const snapshot = await observeWindowsFixtureSnapshot(pid, () =>
        observeWindowsColdProcesses(helper),
      );
      const protectedProduct = snapshot.find((row) => row.pid === pid);
      expect(protectedProduct).toMatchObject({ scope: 'foreign' });
      if (!protectedProduct)
        throw new Error('Protected product missing from complete snapshot');
      expect(protectedProduct.executable?.toLowerCase()).toContain(
        'canopy.exe',
      );
      await expect(
        assertInternalRootNativeCold({
          os: 'win32',
          rows: snapshot,
          roots: [join(directory, 'unaffected')],
          brands,
          managedPids: new Set(),
        }),
      ).rejects.toMatchObject({
        reason: 'writer-active',
      });
      expect(stderr).toBe('');
      const header = `canopy-cold-classification-v1 ${pid} owner-rights-denied`;
      expect(stdout).toMatch(new RegExp(`^${header}\\r?\\n`));
      const rows = parseWindowsColdObservation(
        `canopy-cold-v1\nowner-is-user\n${stdout.replace(header, `x ${pid} owner-rights-denied`)}end\ncomplete 1\n`,
      );
      expect(rows[0]).toMatchObject({
        pid,
        scope: 'foreign',
        executable: protectedProduct.executable,
      });
      await expect(
        assertInternalRootNativeCold({
          os: 'win32',
          rows: [{ ...self, executable: process.execPath }, ...rows],
          roots: [join(directory, 'unaffected')],
          brands,
          managedPids: new Set(),
          selfPid: 99,
        }),
      ).rejects.toMatchObject({ reason: 'writer-active' });
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill();
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
async function finishNamespaceChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close', {
    signal: AbortSignal.timeout(5000),
  });
  child.stdin?.end('\n');
  try {
    await closed;
  } catch (error) {
    child.kill();
    throw error;
  }
}

async function mountNamespacesLinux(): Promise<void> {
  for (const { namespace, scenario } of [
    ...[
      'fd',
      'deleted',
      'maps',
      'deleted-maps',
      'cwd',
      'anonymous',
      'shared-anonymous',
      'memfd',
    ].map((scenario) => ({ namespace: 'private', scenario })),
    { namespace: 'shared', scenario: 'memfd' },
    { namespace: 'shared', scenario: 'shared-anonymous' },
  ]) {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (!uid || gid === undefined)
      throw new Error(
        'Qualify as an ordinary Linux user with passwordless sudo for mount setup',
      );
    if (namespace === 'private') {
      try {
        await promisify(execFile)('sudo', ['-n', 'true'], { timeout: 2000 });
      } catch {
        throw new Error(
          'Private mount qualification requires passwordless sudo (sudo -n true); no namespace child was started.',
        );
      }
    }
    const directory = await mkdtemp(join(tmpdir(), 'cold-mntns-'));
    const target = join(directory, 'target');
    const unrelated = join(directory, 'unrelated');
    const alias = join(directory, 'alias');
    const source = join(directory, 'fixture.c');
    const binary = join(directory, 'fixture');
    try {
      await mkdir(target);
      await mkdir(unrelated);
      await mkdir(alias);
      await writeFile(
        source,
        `#define _GNU_SOURCE
#include <sys/mman.h>
#include <sys/prctl.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3 || getuid() == 0 || prctl(PR_SET_DUMPABLE, 1)) return 1;
  char name[4096]; if (snprintf(name, sizeof(name), "%s/database", argv[1]) >= sizeof(name)) return 2;
  if (mmap(0, 4096, PROT_READ|PROT_WRITE, MAP_SHARED|MAP_ANONYMOUS, -1, 0) == MAP_FAILED) return 8;
  if (!strcmp(argv[2], "anonymous")) { if (mmap(0, 4096, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0) == MAP_FAILED) return 3; }
  else if (!strcmp(argv[2], "memfd")) { int fd = memfd_create("cold-fixture", 0); if (fd < 0 || ftruncate(fd, 4096) || mmap(0, 4096, PROT_READ, MAP_PRIVATE, fd, 0) == MAP_FAILED) return 7; }
  else if (!strcmp(argv[2], "cwd")) { if (chdir(argv[1])) return 4; }
  else if (strcmp(argv[2], "shared-anonymous")) {
    int fd = open(name, O_RDONLY); if (fd < 0) return 5;
    if (strstr(argv[2], "maps")) { if (mmap(0, 4096, PROT_READ, MAP_PRIVATE, fd, 0) == MAP_FAILED || close(fd)) return 6; }
  }
  printf("%d\\n", getpid()); fflush(stdout); return getchar() == EOF;
}`,
      );
      await promisify(execFile)('cc', [source, '-o', binary], {
        timeout: 15_000,
      });
      for (const affected of [false, true]) {
        await writeFile(join(target, 'database'), Buffer.alloc(4096));
        await writeFile(join(unrelated, 'database'), Buffer.alloc(4096));
        const child =
          namespace === 'shared'
            ? spawn(binary, [alias, scenario], {
                stdio: ['pipe', 'pipe', 'inherit'],
              })
            : spawn(
                'sudo',
                [
                  '-n',
                  'unshare',
                  '--mount',
                  '--propagation',
                  'private',
                  '/bin/sh',
                  '-c',
                  'mount --bind "$1" "$2" && exec setpriv --reuid "$3" --regid "$4" --clear-groups --no-new-privs "$5" "$2" "$6"',
                  'cold-mntns',
                  affected ? target : unrelated,
                  alias,
                  String(uid),
                  String(gid),
                  binary,
                  scenario,
                ],
                { stdio: ['pipe', 'pipe', 'inherit'] },
              );
        try {
          const output: unknown = (
            await once(child.stdout, 'data', {
              signal: AbortSignal.timeout(5000),
            })
          )[0];
          const pid = Number(String(output).trim());
          if (!Number.isSafeInteger(pid) || pid < 2)
            throw new Error('No namespace fixture PID');
          for (const kind of ['user', 'pid'])
            expect(await readlink(`/proc/${pid}/ns/${kind}`)).toBe(
              await readlink(`/proc/self/ns/${kind}`),
            );
          const mountNamespace = await readlink(`/proc/${pid}/ns/mnt`);
          const ownMountNamespace = await readlink('/proc/self/ns/mnt');
          if (namespace === 'private')
            expect(mountNamespace).not.toBe(ownMountNamespace);
          else expect(mountNamespace).toBe(ownMountNamespace);
          const status = await readFile(`/proc/${pid}/status`, 'utf8');
          expect(status).toMatch(/^CapEff:\s+0+$/m);
          expect(status).toMatch(
            new RegExp(`Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}`),
          );
          if (scenario.startsWith('deleted'))
            await rm(join(affected ? target : unrelated, 'database'));
          if (scenario === 'shared-anonymous')
            expect(await readFile(`/proc/${pid}/maps`, 'utf8')).toMatch(
              /rw-s .* \/dev\/zero \(deleted\)$/m,
            );
          const observation = observeLinuxColdProcess(pid, undefined, [target]);
          if (scenario === 'deleted-maps') {
            try {
              await observation;
              throw new Error('Expected unprivileged deleted-map refusal');
            } catch (error) {
              if (!(error instanceof LinuxColdInspectionError)) throw error;
              expect(error.refusals).toHaveLength(1);
              const [refusal] = error.refusals;
              expect(refusal?.pid).toBe(pid);
              expect(refusal?.comm).toBe('fixture');
              expect(refusal?.reason).toMatch(
                new RegExp(
                  `^(?:EACCES|EPERM): .*'/proc/${pid}/map_files/[0-9a-f]+-[0-9a-f]+'$`,
                ),
              );
              process.stdout.write(
                `Linux mount child: ${JSON.stringify({
                  namespace,
                  scenario,
                  affected,
                  pid,
                  uid,
                  gid,
                  mountNamespace,
                  ownMountNamespace,
                  outcome: error.code,
                  refusals: error.refusals.map(({ pid, comm, reason }) => ({
                    pid,
                    comm,
                    reason,
                  })),
                })}\n`,
              );
            }
            continue;
          }
          const observed = await observation;
          const expectedAffected =
            !['anonymous', 'shared-anonymous', 'memfd'].includes(scenario) &&
            affected;
          expect(observed.linuxPrivateMountUse).toEqual({
            roots: [target],
            affected: expectedAffected,
          });
          const observer = await observeLinuxColdProcess(
            process.pid,
            undefined,
            [target],
          );
          const proof = assertInternalRootNativeCold({
            os: 'linux',
            rows: [observer, observed],
            roots: [target],
            brands,
            managedPids: new Set(),
          });
          if (expectedAffected)
            await expect(proof).rejects.toMatchObject({
              reason: 'writer-active',
            });
          else await proof;
          process.stdout.write(
            `Linux mount child: ${JSON.stringify({
              namespace,
              scenario,
              affected,
              pid,
              uid,
              gid,
              mountNamespace,
              ownMountNamespace,
              outcome: observed.linuxPrivateMountUse,
              policyOutcome: expectedAffected ? 'writer-active' : 'cold',
            })}\n`,
          );
        } finally {
          await finishNamespaceChild(child);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

async function pamLinux(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cold-pam-'));
  const source = join(directory, 'fixture.c');
  const binary = join(directory, 'fixture');
  await writeFile(
    source,
    '#include <sys/prctl.h>\n#include <stdio.h>\nint main(void) { if (prctl(PR_SET_NAME, "(sd-pam)", 0, 0, 0) || prctl(PR_SET_DUMPABLE, 0, 0, 0, 0)) return 1; puts("ready"); fflush(stdout); return getchar() == EOF; }\n',
  );
  try {
    await promisify(execFile)('cc', [source, '-o', binary], {
      timeout: 15_000,
    });
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
    try {
      await once(child.stdout, 'data', {
        signal: AbortSignal.timeout(5000),
      });
      if (!child.pid) throw new Error('No PAM fixture PID');
      try {
        await observeLinuxColdProcesses({ roots: [directory] });
        throw new Error('Non-dumpable PAM fixture was not refused');
      } catch (error) {
        if (!(error instanceof LinuxColdInspectionError)) throw error;
        expect(error.refusals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ pid: child.pid, comm: '(sd-pam)' }),
          ]),
        );
        assertLinuxManagersClassified(
          error.classifiedProcesses,
          error.refusals,
        );
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function deletedLinux(): Promise<void> {
  for (const scenario of ['unlinked', 'ambiguous-name']) {
    const directory = await mkdtemp(join(tmpdir(), 'cold-deleted-'));
    const file = join(
      directory,
      scenario === 'unlinked' ? 'database' : 'database (deleted)',
    );
    await writeFile(file, 'opaque');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `require('fs').openSync(${JSON.stringify(file)},'r');process.on('message',()=>process.exit(0));process.send('ready')`,
      ],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
    );
    try {
      await once(child, 'message', { signal: AbortSignal.timeout(5000) });
      const pid = child.pid;
      if (!pid) throw new Error('No open-file child PID');
      if (scenario === 'unlinked') await rm(file);
      const observation = observeLinuxColdProcess(pid);
      await expect(observation).rejects.toMatchObject({
        code: 'inspection-incomplete',
        pid,
      });
      await expect(observation).rejects.toThrow('path=');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill();
        await closed;
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}
let coldSuccesses = 0;
let nativeFixtureOutput = '';
const requested = process.env.CANOPY_COLD_PROOF_QUALIFICATION === '1';
const qualify = requested ? describe : describe.skip;
qualify('CAN-5879 manual exact-head cold proof qualification', () => {
  const runs: {
    run: number;
    status: string;
    coldSuccess: boolean;
    nativeFixtureSha256?: string;
    helperSha256?: string;
    error?: string;
  }[] = [];
  let revision = '';
  const sourceHashes: Record<string, string> = {};
  let helperSha256: string | undefined;
  let nativeFixtureSha256: string | undefined;
  const git = process.platform === 'win32' ? 'git.exe' : 'git';
  async function assertExactHead(): Promise<void> {
    const head = await promisify(execFile)(git, ['rev-parse', 'HEAD'], {
      cwd: root,
    });
    expect(head.stdout.trim()).toBe(revision);
    const dirty = await promisify(execFile)(
      git,
      ['status', '--porcelain', '--untracked-files=normal'],
      { cwd: root },
    );
    if (dirty.stdout.trim())
      throw new Error('Commit the exact qualification head first');
    for (const [file, expected] of Object.entries(sourceHashes))
      expect(
        createHash('sha256')
          .update(await readFile(join(root, file)))
          .digest('hex'),
      ).toBe(expected);
    if (helperSha256)
      expect(
        createHash('sha256')
          .update(await readFile(helper))
          .digest('hex'),
      ).toBe(helperSha256);
  }
  beforeAll(async () => {
    if (process.platform !== 'win32' && process.platform !== 'linux')
      throw new Error(
        'Cold proof qualification requires native Windows or Linux',
      );
    revision = (
      await promisify(execFile)(git, ['rev-parse', 'HEAD'], { cwd: root })
    ).stdout.trim();
    await assertExactHead();
    for (const file of [
      'packages/core-platform/native/windows-process/process-identity.c',
      'packages/core-platform/native/windows-process/process-identity-test.c',
      'packages/core-platform/native/windows-process/cold-observation-test.c',
      'packages/core-platform/native/windows-process/cold-observation.h',
      'scripts/build-windows-process-identity.mjs',
      'scripts/lib/windows-process-helper.mjs',
      'packages/core-platform/src/internal-root-cold/linux.ts',
      'packages/core-platform/src/internal-root-cold/linux-mounts.ts',
      'packages/core-platform/src/internal-root-cold/linux-membership.ts',
      'packages/core-platform/src/internal-root-cold/types.ts',
      'packages/desktop-shared/src/node/internal-root-migration/native-cold.ts',
      'packages/desktop-shared/src/node/internal-root-migration/__tests__/cold-proof-qualification.test.ts',
    ])
      sourceHashes[file] = createHash('sha256')
        .update(await readFile(join(root, file)))
        .digest('hex');
    if (process.platform === 'win32') {
      if (!(await windowsObserverOwnerIsUser()))
        throw new Error(
          'Qualify with a non-admin TokenOwner=TokenUser account',
        );
      await promisify(execFile)(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "import { assertProcessHelper } from './scripts/lib/windows-process-helper.mjs'; assertProcessHelper(process.cwd());",
        ],
        { cwd: root, timeout: 15_000 },
      ).catch((cause: unknown) => {
        throw new Error(
          'Build a fresh helper first: pnpm run build:windows-process-identity',
          { cause },
        );
      });
      helperSha256 = createHash('sha256')
        .update(await readFile(helper))
        .digest('hex');
    } else if (process.getuid?.() === 0)
      throw new Error('Qualify with a non-root user');
  }, 30_000);
  it.each([1, 2, 3, 4, 5])(
    'serial run %s requires real whole-host cold success',
    async (run) => {
      const before = coldSuccesses;
      try {
        await assertExactHead();
        if (process.platform === 'win32') {
          const output = await promisify(execFile)(
            process.execPath,
            [
              join(root, 'scripts/build-windows-process-identity.mjs'),
              '--test',
            ],
            { windowsHide: true, timeout: 240_000, maxBuffer: 64 << 20 },
          );
          expect(output.stderr).toBe('');
          expect(output.stdout).not.toContain('owner-mismatch');
          nativeFixtureOutput = output.stdout;
          nativeFixtureSha256 = createHash('sha256')
            .update(output.stdout)
            .digest('hex');
          process.stdout.write(
            `native fixture run ${run}:\n${output.stdout}\n`,
          );
          await protectedKernel();
          await enumerateWindows();
          await deletedWindows();
          await reusedSlotWindows();
          await ownerRightsWindows();
          // Run only after every product fixture has closed.
          await coldWindows();
        } else {
          await mountNamespacesLinux();
          await pamLinux();
          await deletedLinux();
          const directory = await mkdtemp(join(tmpdir(), 'cold-whole-host-'));
          try {
            const rows = await observeLinuxColdProcesses({
              roots: [directory],
            });
            assertLinuxManagersClassified(rows);
            if (process.env.CANOPY_LINUX_DESKTOP_QUALIFICATION === '1') {
              const integration = rows.filter((row) =>
                /^\/snap\/snapd-desktop-integration\/[^/]+\//.test(
                  row.executable ?? '',
                ),
              );
              expect(integration.length).toBeGreaterThan(0);
              for (const row of integration) {
                expect(row.linuxPrivateMountUse).toEqual({
                  roots: [directory],
                  affected: false,
                });
                const mountNamespace = await readlink(
                  `/proc/${row.pid}/ns/mnt`,
                );
                expect(mountNamespace).not.toBe(
                  await readlink('/proc/self/ns/mnt'),
                );
                process.stdout.write(
                  `stock snapd integration: ${JSON.stringify({
                    pid: row.pid,
                    comm: row.comm,
                    executable: row.executable,
                    mountNamespace,
                    membership: row.linuxPrivateMountUse,
                  })}\n`,
                );
              }
            }
            process.stdout.write(
              `root-principal residuals: ${JSON.stringify(
                rows
                  .filter((row) => row.scope === 'linux-root-principal')
                  .map(({ pid, comm }) => ({ pid, comm })),
              )}\n`,
            );
            await assertInternalRootNativeCold({
              os: 'linux',
              rows,
              roots: [directory],
              brands,
              managedPids: new Set(),
            });
            coldSuccesses++;
            process.stdout.write(
              `whole-host cold success: ${rows.length} unfiltered native rows\n`,
            );
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
        await assertExactHead();
        expect(coldSuccesses - before).toBe(1);
        runs.push({
          run,
          status: 'passed',
          coldSuccess: true,
          nativeFixtureSha256,
          helperSha256,
        });
      } catch (error) {
        runs.push({
          run,
          status: 'failed',
          coldSuccess: coldSuccesses > before,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        nativeFixtureOutput = '';
      }
    },
    600_000,
  );
  afterAll(async () => {
    let exactHead = false;
    try {
      if (revision) {
        await assertExactHead();
        exactHead = true;
      }
    } catch {
      /* Receipt remains incomplete. */
    }
    const qualified =
      exactHead &&
      runs.length === 5 &&
      runs.every((run) => run.status === 'passed' && run.coldSuccess) &&
      coldSuccesses === 5;
    const receipt = JSON.stringify({
      status: qualified ? 'qualified' : 'incomplete',
      revision,
      platform: process.platform,
      arch: process.arch,
      os: release(),
      node: process.version,
      helperSha256,
      sourceHashes,
      runs,
      coldSuccesses,
    });
    if (process.env.CANOPY_COLD_PROOF_RECEIPT)
      await writeFile(process.env.CANOPY_COLD_PROOF_RECEIPT, receipt);
    process.stdout.write(`CAN-5879 qualification receipt: ${receipt}\n`);
    expect(qualified).toBe(true);
  });
});
