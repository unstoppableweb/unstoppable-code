import {
  copyFile,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createWindowsMigrationVerifier,
  type PreparedWindowsMigrationTrust,
  type WindowsMigrationCapture,
} from '@canopy/core-runtime/node/vault';
import {
  qualifyWindowsMigrationComposition,
  prepareWindowsMigrationTrust,
} from '../windows-migration';
import {
  captureWindowsMigrationPeer,
  createOwnedChildServices,
  OWNED_CHILD_FILE,
  type OwnedChildLaunch,
} from '../supervision/owned-child';
import { loadOwnedChildProbe } from './fixtures/owned-child-probe';

// CAN-5864 / CAN-4504 §6 W2 migration evidence. Native custody/signature/pins
// with an INJECTED trust fixture, not authenticated release-package eligibility.
const suite = process.platform === 'win32' ? describe : describe.skip;
const root = path.resolve(__dirname, '../../../..');
const addon = process.env.CANOPY_OWNED_CHILD_ADDON
  ? path.resolve(root, process.env.CANOPY_OWNED_CHILD_ADDON)
  : path.join(
      root,
      '.cache/native-owned-child',
      `win32-${process.arch}`,
      OWNED_CHILD_FILE,
    );
const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '../supervision/owned-child.ts'),
).href;
const verifierUrl = pathToFileURL(
  path.join(
    root,
    'packages/core-runtime/src/node/vault/migration-windows-verifier.ts',
  ),
).href;
const loader = pathToFileURL(
  path.join(root, 'node_modules/tsx/dist/loader.mjs'),
).href;
const compositionUrl = pathToFileURL(
  path.join(root, 'packages/core-platform/src/windows-migration.ts'),
).href;
const launches = new Set<OwnedChildLaunch>();
const directories = new Set<string>();

let probe: object = {};
function deleteAccess(file: string): number {
  const method: unknown = Reflect.get(probe, 'deleteAccess');
  if (typeof method !== 'function')
    throw new Error('Native probe method absent: deleteAccess');
  const result: unknown = Reflect.apply(method, probe, [file]);
  if (typeof result !== 'number' || !Number.isSafeInteger(result) || result < 0)
    throw new Error('Invalid native delete-access result');
  return result;
}

async function expectWriteRefused(executable: string): Promise<void> {
  const writing = open(executable, 'r+');
  try {
    await expect(writing).rejects.toHaveProperty('code');
  } finally {
    // A regression must not leave an unexpectedly writable file locked.
    await writing.then(
      (file) => file.close(),
      () => undefined,
    );
  }
}

function trustFixture(
  image: WindowsMigrationCapture,
): PreparedWindowsMigrationTrust {
  const hash = `sha256:${'a'.repeat(64)}`;
  return {
    expectations: {
      os: 'win32',
      publisher: image.signing.publisher ?? '',
      certificateDigest: image.signing.certificateDigest ?? hash,
      launcherDigest: image.digest,
      daemonDigest: image.digest,
      package: {
        flavorId: 'com.fixture.app',
        secureMode: 'secure',
        buildId: 'fixture',
        packageDigest: hash,
        codeDigest: hash,
        nativeDigest: hash,
        updateEpoch: 'fixture-1',
      },
    },
    image: () => ({
      fileId: image.fileId,
      digest: image.digest,
      commandLine: image.commandLine,
    }),
    current: () => true,
    onInvalidate: () => () => undefined,
  };
}

async function launch(
  executable = process.execPath,
  scenario = 'positive',
): Promise<OwnedChildLaunch> {
  const code = `
(async () => {
  setTimeout(() => process.exit(25), 20000).unref();
  const fs = require('node:fs');
  const api = await import(${JSON.stringify(moduleUrl)});
  const { createWindowsMigrationVerifier } = await import(${JSON.stringify(verifierUrl)});
  const channel = api.connectWindowsLauncherChannel(${JSON.stringify(addon)}, fs.readFileSync(0, 'utf8'));
  const image = api.captureWindowsMigrationPeer(channel);
  if (!image) throw new Error('No native launcher image');
  const trust = (${trustFixture.toString()})(image);
  const verifier = createWindowsMigrationVerifier({ trust, capture: api.captureWindowsMigrationPeer });
  const result = verifier.verifyLauncher(channel);
  // Injected post-launch policy is intentional fixture evidence, not unit T
  // prelaunch package authentication or a signed Canopy release.
  const { prepareWindowsMigrationTrust, createWindowsMigrationComposition, qualifyWindowsMigrationComposition } = await import(${JSON.stringify(compositionUrl)});
  const scenario = ${JSON.stringify(scenario)};
  const packageReport = { migrationRole: scenario === 'disabled' ? 'disabled' : 'eligible',
    disabledReasons: scenario === 'disabled-reason' ? ['role:unqualified'] : [],
    violations: scenario === 'violation' ? ['wrong build'] : [] };
  if (scenario === 'image') trust.expectations.launcherDigest = 'sha256:' + 'b'.repeat(64);
  if (scenario === 'publisher') trust.expectations.publisher = 'Wrong publisher';
  if (scenario === 'certificate') trust.expectations.certificateDigest = 'sha256:' + 'b'.repeat(64);
  if (scenario === 'role') {
    const expectedImage = trust.image('launcher');
    trust.image = () => ({ ...expectedImage, commandLine: 'other.exe' });
  }
  const prepared = prepareWindowsMigrationTrust({ policy: trust, checkPackage: () => {
    if (scenario === 'throwing-checker') throw new Error('Package checker unavailable');
    return scenario === 'missing-report' ? null : packageReport;
  } });
  let admitted = false, retiredSessions = 0, afterInvalidate = null;
  if (prepared) {
    const compose = scenario === 'production' ? createWindowsMigrationComposition : qualifyWindowsMigrationComposition;
    const composed = compose({
      prepared: prepared.capability, capture: api.captureWindowsMigrationPeer,
      host: () => ({ authorityId: 'fixture', coreAuthority: 'fixture', coreIncarnation: 'fixture',
        coreDigest: trust.expectations.daemonDigest, buildId: scenario === 'host-build' ? 'other-build' : trust.expectations.package.buildId,
        packageDigest: trust.expectations.package.packageDigest, updateEpoch: trust.expectations.package.updateEpoch }),
      retireSessions: () => { retiredSessions++; } });
    if (scenario === 'update') trust.expectations.package.updateEpoch = 'changed';
    if (scenario === 'digest') trust.expectations.launcherDigest = 'sha256:' + 'b'.repeat(64);
    const decision = composed.admit(scenario === 'forged' ? {} : channel);
    admitted = decision.admitted;
    if (scenario === 'replay') admitted = composed.admit(channel).admitted;
    prepared.invalidate();
    afterInvalidate = composed.port.channel(channel);
    composed.close();
  }
  await channel.write(Buffer.from(JSON.stringify({ admitted, retiredSessions, afterInvalidate, verified: result.verified, reason: result.reason,
    pid: image.identity.pid, creationTime: String(image.identity.creationTime),
    role: image.role, signing: image.signing.status }) + '\\n'));
  image.close();
  await channel.read(AbortSignal.timeout(15000));
  verifier.close(); channel.close();
})().catch(() => process.exit(21));`;
  const environment: Record<string, string> = {
    NODE_ENV: scenario === 'non-test' ? 'production' : 'test',
  };
  for (const key of ['SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (
      value !== undefined &&
      !Object.keys(environment).some(
        (k) => k.toLowerCase() === key.toLowerCase(),
      )
    )
      environment[key] = value;
  }
  const result = await createOwnedChildServices({
    os: 'win32',
    nativePath: addon,
  }).spawnWithChannel({
    executable,
    args: ['--import', loader, '-e', code],
    environment,
  });
  launches.add(result);
  return result;
}

async function report(channel: OwnedChildLaunch['channel']): Promise<unknown> {
  let line = '';
  while (!line.includes('\n')) {
    const bytes = await channel.read(AbortSignal.timeout(15000));
    if (!bytes) throw new Error('W2 fixture closed before reporting');
    line += Buffer.from(bytes).toString();
  }
  return JSON.parse(line);
}

function capture(
  channel: OwnedChildLaunch['channel'],
): WindowsMigrationCapture {
  const result = captureWindowsMigrationPeer(channel);
  if (!result) throw new Error('No native image evidence');
  return result;
}

suite(
  'Windows W2 native image verification (disabled, injected prepared trust)',
  () => {
    beforeAll(async () => {
      probe = await loadOwnedChildProbe();
    }, 600_000);

    afterEach(async () => {
      const errors: unknown[] = [];
      for (const item of launches) {
        let released = true;
        try {
          item.channel.close();
        } catch (error) {
          released = false;
          errors.push(error);
        }
        try {
          await item.child.terminate(AbortSignal.timeout(10000));
        } catch (error) {
          released = false;
          errors.push(error);
        }
        if (released) launches.delete(item);
      }
      // Do not remove executable fixtures until every child is confirmed stopped.
      if (launches.size === 0) {
        for (const dir of directories) {
          try {
            await rm(dir, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 200,
            });
            directories.delete(dir);
          } catch (error) {
            errors.push(error);
          }
        }
      }
      if (errors.length) throw new AggregateError(errors, 'W2 cleanup failed');
    }, 30000);

    it('verifies native signed images in both orientations, with lossless identity and channel-confined receipts', async () => {
      const { channel, child } = await launch();
      expect(await report(channel)).toMatchObject({
        verified: true,
        pid: process.pid,
        role: 'launcher',
        signing: 'valid',
      });
      const image = capture(channel);
      try {
        expect(image.identity.pid).toBe(child.pid);
        expect(image.identity.creationTime).toBeGreaterThan(0xffffffffn);
        expect(image.role).toBe('daemon');
        expect(image.parentPid).toBe(process.pid);
        expect(image.signing.status).toBe('valid');
        const verifier = createWindowsMigrationVerifier({
          trust: trustFixture(image),
          capture: (candidate) =>
            candidate === channel ? captureWindowsMigrationPeer(channel) : null,
        });
        try {
          const result = verifier.verifyDestination(channel);
          expect(result.verified).toBe(true);
          if (!result.verified) throw new Error('No verification');
          expect(verifier.lookup(result.handle, channel)).not.toBeNull();
          expect(verifier.lookup(result.handle, {})).toBeNull();
          expect(verifier.verifyDestination(channel)).toEqual({
            verified: false,
            reason: 'replay',
          });
          await child.terminate(AbortSignal.timeout(10000));
          expect(verifier.lookup(result.handle, channel)).toBeNull();
          expect(image.current()).toBe(false);
          expect(captureWindowsMigrationPeer(channel)).toBeNull();
        } finally {
          verifier.close();
        }
      } finally {
        image.close();
      }
    }, 30000);

    it('qualifies W3 signed Node through W1/W2/scoped trust, NOT genuine signed-Canopy exact-package admission', async () => {
      const { channel } = await launch();
      expect(await report(channel)).toMatchObject({
        admitted: true,
        retiredSessions: 1,
        afterInvalidate: null,
      });
    }, 30000);

    it.each([
      'disabled',
      'disabled-reason',
      'violation',
      'missing-report',
      'throwing-checker',
      'production',
      'non-test',
      'host-build',
      'update',
      'digest',
      'forged',
      'image',
      'publisher',
      'certificate',
      'role',
      'replay',
    ])(
      'W3 refuses %s with a native signed Node channel and injected policy',
      async (scenario) => {
        const { channel } = await launch(process.execPath, scenario);
        expect(await report(channel)).toMatchObject({ admitted: false });
      },
      30000,
    );

    it('retires W3 destination trust on native process loss (injected signed Node policy)', async () => {
      const { channel, child } = await launch();
      await report(channel);
      const image = capture(channel);
      const prepared = prepareWindowsMigrationTrust({
        policy: trustFixture(image),
        checkPackage: () => ({
          migrationRole: 'eligible',
          disabledReasons: [],
          violations: [],
        }),
      });
      if (!prepared) throw new Error('No fixture preparation');
      const retireSessions = jest.fn();
      const composed = qualifyWindowsMigrationComposition({
        prepared: prepared.capability,
        capture: (candidate) =>
          candidate === channel ? captureWindowsMigrationPeer(channel) : null,
        host: () => {
          throw new Error('Destination verification has no admitted launcher');
        },
        retireSessions,
      });
      try {
        const result = composed.verifyDestination(channel);
        expect(result.verified).toBe(true);
        if (!result.verified) throw new Error('No destination verification');
        expect(composed.destination(result.handle, channel)).not.toBeNull();
        await child.terminate(AbortSignal.timeout(10000));
        expect(composed.destination(result.handle, channel)).toBeNull();
        expect(retireSessions).toHaveBeenCalledTimes(1);
      } finally {
        composed.close();
        prepared.invalidate();
        image.close();
      }
    }, 30000);

    it('refuses generic tokens and serialized peer evidence as native channels', async () => {
      const { channel } = await launch();
      await report(channel);
      expect(
        captureWindowsMigrationPeer({
          read: (signal?: AbortSignal): Promise<Uint8Array | null> =>
            channel.read(signal),
          write: (bytes: Uint8Array, signal?: AbortSignal): Promise<void> =>
            channel.write(bytes, signal),
          close: (): void => channel.close(),
        }),
      ).toBeNull();
      const image = capture(channel);
      const verifier = createWindowsMigrationVerifier({
        trust: trustFixture(image),
        capture: (candidate) =>
          candidate === channel ? captureWindowsMigrationPeer(channel) : null,
      });
      try {
        for (const candidate of [
          { token: 'generic' },
          { role: 'electron-main' },
          { remote: true },
        ])
          expect(verifier.verifyLauncher(candidate)).toEqual({
            verified: false,
            reason: 'no-native-peer',
          });
      } finally {
        verifier.close();
        image.close();
      }
    }, 30000);

    it('refuses native exact-image, publisher, certificate, role and direction mismatches', async () => {
      const { channel } = await launch();
      await report(channel);
      const image = capture(channel);
      try {
        for (const kind of [
          'digest',
          'fileId',
          'publisher',
          'certificate',
          'role',
          'direction',
        ]) {
          const trust = trustFixture(image);
          if (kind === 'digest')
            Object.assign(trust.expectations, {
              daemonDigest: `sha256:${'b'.repeat(64)}`,
            });
          if (kind === 'fileId')
            trust.image = (): ReturnType<
              PreparedWindowsMigrationTrust['image']
            > => ({
              fileId: '0'.repeat(24),
              digest: image.digest,
              commandLine: image.commandLine,
            });
          if (kind === 'publisher')
            Object.assign(trust.expectations, { publisher: 'Wrong publisher' });
          if (kind === 'certificate')
            Object.assign(trust.expectations, {
              certificateDigest: `sha256:${'b'.repeat(64)}`,
            });
          if (kind === 'role')
            trust.image = (): ReturnType<
              PreparedWindowsMigrationTrust['image']
            > => ({
              fileId: image.fileId,
              digest: image.digest,
              commandLine: 'other.exe',
            });
          const verifier = createWindowsMigrationVerifier({
            trust,
            capture: () => captureWindowsMigrationPeer(channel),
          });
          try {
            const result =
              kind === 'direction'
                ? verifier.verifyLauncher(channel)
                : verifier.verifyDestination(channel);
            expect(result).toEqual({
              verified: false,
              reason: ['digest', 'fileId'].includes(kind)
                ? 'image'
                : ['publisher', 'certificate'].includes(kind)
                  ? 'signing'
                  : 'role',
            });
          } finally {
            verifier.close();
          }
        }
      } finally {
        image.close();
      }
    }, 30000);

    it('pins a copied executable against write and replacement until retirement', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'w2-image-'));
      directories.add(dir);
      const executable = path.join(dir, 'node.exe');
      await copyFile(process.execPath, executable);
      const { channel, child } = await launch(executable);
      await report(channel);
      // DELETE access alone does not rename/delete an executing image.
      expect(deleteAccess(executable)).toBe(0);
      const image = capture(channel);
      let retirementImage: WindowsMigrationCapture | undefined;
      try {
        await expect(
          rename(executable, executable + '.replaced'),
        ).rejects.toHaveProperty('code');
        await expectWriteRefused(executable);
        expect(image.current()).toBe(true);
        expect(deleteAccess(executable)).toBe(32); // ERROR_SHARING_VIOLATION
        image.close();
        expect(image.current()).toBe(false);
        expect(deleteAccess(executable)).toBe(0);
        // Recapture before retirement to retain the exited-process pin proof.
        retirementImage = capture(channel);
        expect(retirementImage.current()).toBe(true);
        await child.terminate(AbortSignal.timeout(10000));
        expect(retirementImage.current()).toBe(false);
        // Image teardown alone cannot cause a DELETE-access sharing violation.
        expect(deleteAccess(executable)).toBe(32);
        await expect(
          rename(executable, executable + '.replaced'),
        ).rejects.toHaveProperty('code');
        await expectWriteRefused(executable);
      } finally {
        retirementImage?.close();
        image.close();
      }
      expect(deleteAccess(executable)).toBe(0);
    }, 30000);

    it('refuses a runnable unsigned image even with matching injected package/digest metadata', async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'w2-unsigned-'));
      directories.add(dir);
      const executable = path.join(dir, 'node.exe');
      const bytes = await readFile(process.execPath);
      const pe = bytes.readUInt32LE(0x3c),
        optional = pe + 24;
      expect(bytes.readUInt16LE(optional)).toBe(0x20b); // Supported Windows x64 target.
      bytes.fill(0, optional + 112 + 4 * 8, optional + 112 + 5 * 8); // PE security directory.
      await writeFile(executable, bytes);
      const { channel } = await launch(executable);
      await report(channel);
      const image = capture(channel);
      try {
        expect(image.signing.status).toBe('invalid');
        const verifier = createWindowsMigrationVerifier({
          trust: trustFixture(image),
          capture: () => captureWindowsMigrationPeer(channel),
        });
        try {
          expect(verifier.verifyDestination(channel)).toEqual({
            verified: false,
            reason: 'signing',
          });
        } finally {
          verifier.close();
        }
      } finally {
        image.close();
      }
    }, 30000);
  },
);
