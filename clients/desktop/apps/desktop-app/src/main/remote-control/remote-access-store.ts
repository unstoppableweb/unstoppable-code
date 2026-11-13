import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  DEVICE_KINDS,
  DEVICE_PLATFORMS,
  deviceKindOrDefault,
  isDeviceId,
} from '@canopy/protocol/device-relay';
import { writeFileAtomically } from '../lib/atomic-file';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import type { SecureStorageFailure } from '@canopy/execution-engine/types/secure-storage';
import {
  getSecureStorageFailure,
  type SecretStoragePolicy,
} from '../lib/secure-storage-policy';
import {
  exportDeviceKeyPair,
  generateDeviceKeyPair,
  importDeviceKeyPair,
  publicKeyMatchesDeviceId,
  type DeviceKeyPair,
} from './crypto/device-key';

const PairedDeviceSchema = z
  .object({
    deviceId: z.string().refine(isDeviceId),
    name: z.string().min(1).max(120),
    platform: z.enum(DEVICE_PLATFORMS),
    /**
     * The controller profile the relay authenticated when it paired or last
     * narrowed. Absent in pairings saved before kinds: those are desktop.
     */
    kind: z.enum(DEVICE_KINDS).optional(),
    publicKey: z.string().min(1),
    pairedAt: z.string().min(1),
  })
  .refine((device) =>
    publicKeyMatchesDeviceId(device.publicKey, device.deviceId),
  );

export type PairedDevice = z.infer<typeof PairedDeviceSchema>;

const RemoteControlFileSchema = z.object({
  version: z.literal(1),
  allowIncoming: z.boolean(),
  /**
   * Paired computers that control this one may install its updates. Absent
   * until first set; the service supplies the platform's default.
   */
  allowRemoteUpdates: z.boolean().optional(),
  /** Computers this device may control. */
  pairedHosts: z.array(PairedDeviceSchema),
  /** Devices allowed to control this computer. */
  pairedControllers: z.array(PairedDeviceSchema),
  /**
   * Set once the Portal opt-in was folded into `allowIncoming`, so the
   * one-time migration never runs again.
   */
  migratedOptIn: z.boolean().optional(),
});

export type RemoteControlFile = z.infer<typeof RemoteControlFileSchema>;

const EMPTY_FILE: RemoteControlFile = {
  version: 1,
  allowIncoming: false,
  pairedHosts: [],
  pairedControllers: [],
};

const IDENTITY_ENCRYPTED_PREFIX = 'safe-storage:';
const IDENTITY_PLAIN_PREFIX = 'pkcs8:';

/** This device's key exists but cannot be read right now. */
export class RemoteIdentityUnavailableError extends Error {
  readonly secureStorageFailure: SecureStorageFailure | undefined;

  constructor(error?: unknown) {
    super(
      "This computer's remote-control key could not be read. Unlock the system keychain and try again.",
    );
    this.name = 'RemoteIdentityUnavailableError';
    this.secureStorageFailure = getSecureStorageFailure(error) ?? undefined;
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function isKnownDevice(
  devices: readonly PairedDevice[],
  device: PairedDevice,
): boolean {
  return devices.some(
    (known) =>
      known.deviceId === device.deviceId &&
      known.publicKey === device.publicKey,
  );
}

/**
 * The controller `previous` already allowed for this device: the new record
 * when it grants nothing more (same kind, or desktop narrowed to a restricted
 * profile), the old one while a different profile waits for its save, or
 * null when the device is new.
 */
function withoutNewControllerGrant(
  previous: readonly PairedDevice[],
  device: PairedDevice,
): PairedDevice | null {
  const known = previous.find(
    (entry) =>
      entry.deviceId === device.deviceId &&
      entry.publicKey === device.publicKey,
  );
  if (!known) return null;
  const before = deviceKindOrDefault(known);
  const after = deviceKindOrDefault(device);
  return before === after || before === 'desktop' ? device : known;
}

/** `next` with every permission `previous` did not already grant removed. */
function withoutNewGrants(
  next: RemoteControlFile,
  previous: RemoteControlFile,
): RemoteControlFile {
  return {
    ...next,
    allowIncoming: next.allowIncoming && previous.allowIncoming,
    ...(next.allowRemoteUpdates === undefined
      ? {}
      : {
          // Only a saved opt-in counts: a missing value means off on Linux.
          allowRemoteUpdates:
            next.allowRemoteUpdates && previous.allowRemoteUpdates === true,
        }),
    pairedHosts: next.pairedHosts.filter((device) =>
      isKnownDevice(previous.pairedHosts, device),
    ),
    pairedControllers: next.pairedControllers.flatMap((device) => {
      const allowed = withoutNewControllerGrant(
        previous.pairedControllers,
        device,
      );
      return allowed ? [allowed] : [];
    }),
  };
}

export interface RemoteAccessStoreOptions {
  settingsPath: string;
  identityPath: string;
  secretStorage: SecretStoragePolicy;
}

/**
 * Persists this device's remote-control identity, its "allow incoming"
 * setting, and both directions of pinned pairings. The identity key is
 * encrypted with the OS keychain when available and written owner-only
 * either way.
 */
export class RemoteAccessStore {
  private cache: RemoteControlFile | null = null;
  private identityCache: DeviceKeyPair | null = null;
  private identityLoad: Promise<DeviceKeyPair> | null = null;
  private settingsLoad: Promise<RemoteControlFile> | null = null;
  private updateChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: RemoteAccessStoreOptions) {}

  /** Last loaded settings without IO; null before the first read. */
  peek(): RemoteControlFile | null {
    return this.cache;
  }

  read(): Promise<RemoteControlFile> {
    if (this.cache) return Promise.resolve(this.cache);
    // Every caller, updates included, shares one load.
    this.settingsLoad ??= this.loadSettings().finally(() => {
      this.settingsLoad = null;
    });
    return this.settingsLoad;
  }

  private async loadSettings(): Promise<RemoteControlFile> {
    let parsed: RemoteControlFile = EMPTY_FILE;
    try {
      const raw: unknown = JSON.parse(
        await readFile(this.options.settingsPath, 'utf8'),
      );
      const result = RemoteControlFileSchema.safeParse(raw);
      if (result.success) parsed = result.data;
    } catch {
      // Missing or unreadable settings start from the safe default: off.
    }
    // A change committed meanwhile is newer than the file just read.
    this.cache ??= parsed;
    return this.cache;
  }

  /**
   * Applies a change and persists it. Updates run one at a time, each on the
   * state the previous one committed, so concurrent changes are never lost.
   * Revocations reach the cache before the write, so authorization checks see
   * them at once; grants reach it only once they are saved.
   */
  update(
    mutate: (current: RemoteControlFile) => RemoteControlFile,
  ): Promise<RemoteControlFile> {
    const run = this.updateChain.then(async () => {
      const previous = await this.read();
      const validated = RemoteControlFileSchema.parse(mutate(previous));
      this.cache = withoutNewGrants(validated, previous);
      await mkdir(dirname(this.options.settingsPath), { recursive: true });
      await writeFileAtomically(
        this.options.settingsPath,
        `${JSON.stringify(validated, null, 2)}\n`,
        { mode: 0o600 },
      );
      this.cache = validated;
      return validated;
    });
    this.updateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Settles once every update queued so far has finished, saved or not. */
  whenIdle(): Promise<void> {
    return this.updateChain;
  }

  /**
   * This device's key, created on first use. A key that exists but cannot be
   * read (for example while the OS keychain is locked) is an error rather
   * than a reason to replace it: every paired computer pinned that key.
   */
  async identity(): Promise<DeviceKeyPair> {
    if (this.identityCache) return this.identityCache;
    this.identityLoad ??= this.loadIdentity().finally(() => {
      this.identityLoad = null;
    });
    return this.identityLoad;
  }

  private async loadIdentity(): Promise<DeviceKeyPair> {
    const text = await this.readIdentityFile();
    const keyPair =
      text === null ? await this.createIdentity() : this.parseIdentity(text);
    this.identityCache = keyPair;
    return keyPair;
  }

  private async readIdentityFile(): Promise<string | null> {
    try {
      return (await readFile(this.options.identityPath, 'utf8')).trim();
    } catch (error) {
      if (isMissingFileError(error)) return null;
      throw new RemoteIdentityUnavailableError();
    }
  }

  private async createIdentity(): Promise<DeviceKeyPair> {
    const created = generateDeviceKeyPair();
    await this.writeIdentity(created);
    return created;
  }

  private parseIdentity(text: string): DeviceKeyPair {
    try {
      if (text.startsWith(IDENTITY_ENCRYPTED_PREFIX)) {
        const decrypted = this.options.secretStorage.decrypt(
          Buffer.from(text.slice(IDENTITY_ENCRYPTED_PREFIX.length), 'base64'),
        );
        return importDeviceKeyPair(Buffer.from(decrypted, 'base64'));
      }
      if (text.startsWith(IDENTITY_PLAIN_PREFIX)) {
        return importDeviceKeyPair(
          Buffer.from(text.slice(IDENTITY_PLAIN_PREFIX.length), 'base64'),
        );
      }
    } catch (error) {
      throw new RemoteIdentityUnavailableError(error);
    }
    throw new RemoteIdentityUnavailableError();
  }

  private async writeIdentity(keyPair: DeviceKeyPair): Promise<void> {
    const pkcs8 = exportDeviceKeyPair(keyPair).toString('base64');
    const platform = hostOperatingSystem();
    let contents: string;
    if (platform === 'darwin' || platform === 'win32') {
      // Retain only the existing explicit native-false/missing fallback.
      contents = this.options.secretStorage.nativeEncryptionAvailable()
        ? `${IDENTITY_ENCRYPTED_PREFIX}${this.options.secretStorage.encrypt(pkcs8).toString('base64')}`
        : `${IDENTITY_PLAIN_PREFIX}${pkcs8}`;
    } else {
      contents = `${IDENTITY_ENCRYPTED_PREFIX}${this.options.secretStorage.encrypt(pkcs8).toString('base64')}`;
    }
    await mkdir(dirname(this.options.identityPath), { recursive: true });
    if (contents.startsWith(IDENTITY_ENCRYPTED_PREFIX)) {
      this.options.secretStorage.assertCanWrite();
    }
    await writeFileAtomically(this.options.identityPath, `${contents}\n`, {
      mode: 0o600,
    });
  }
}

export function upsertPairedDevice(
  list: ReadonlyArray<PairedDevice>,
  device: PairedDevice,
): PairedDevice[] {
  return [
    ...list.filter((entry) => entry.deviceId !== device.deviceId),
    device,
  ];
}
