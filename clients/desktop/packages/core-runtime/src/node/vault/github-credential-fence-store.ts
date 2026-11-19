import { randomUUID } from 'node:crypto';
import { lstat, open, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { VaultSecretPinSchema } from '@canopy/protocol/canopy-core';
import type { PlatformSecureFileServices } from '../../platform/platform-services';
import type {
  GitHubCredentialFence,
  GitHubCredentialFenceStore,
} from './github-credential-authority';
import {
  fenceReadFailureFromCode,
  GitHubCredentialFenceReadError,
} from './github-credential-authority';

function decode(value: unknown): GitHubCredentialFence | null {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('source' in value) ||
    !('pin' in value) ||
    !('legacyGeneration' in value)
  )
    return null;
  const source = value.source;
  if (
    typeof source !== 'object' ||
    source === null ||
    !('brandId' in source) ||
    !('build' in source) ||
    typeof source.brandId !== 'string' ||
    !source.brandId.trim() ||
    typeof source.build !== 'string' ||
    !source.build.trim()
  )
    return null;
  if (
    typeof value.legacyGeneration !== 'string' ||
    !value.legacyGeneration.length ||
    value.legacyGeneration.length > 4096
  )
    return null;
  const pin = VaultSecretPinSchema.safeParse(value.pin);
  if (!pin.success) return null;
  return {
    source: { brandId: source.brandId, build: source.build },
    pin: pin.data,
    legacyGeneration: value.legacyGeneration,
  };
}

/** Secret-free A1 sidecar. D-V5-1's same-transaction state table is still open. */
export function createGitHubCredentialFenceStore(options: {
  readonly secureDataRoot: string;
  readonly secureFiles: PlatformSecureFileServices;
}): GitHubCredentialFenceStore {
  if (!isAbsolute(options.secureDataRoot))
    throw new TypeError('The credential fence root must be absolute.');
  const folder = options.secureDataRoot;
  const path = join(folder, 'github-pat-fence.json');
  const files = options.secureFiles;
  async function privatePath(
    path: string,
    kind: 'file' | 'directory',
    action: 'verify' | 'restrict',
  ): Promise<void> {
    const stat = await lstat(path);
    if (
      stat.isSymbolicLink() ||
      (kind === 'file'
        ? !stat.isFile() || stat.nlink !== 1
        : !stat.isDirectory())
    )
      throw new GitHubCredentialFenceReadError('privacy_check_failed');
    try {
      if (
        (await files.permissions({ path, kind, mode: 'owner-only', action }))
          .state !== 'private'
      )
        throw new GitHubCredentialFenceReadError('privacy_check_failed');
    } catch {
      throw new GitHubCredentialFenceReadError('privacy_check_failed');
    }
  }
  return {
    async read() {
      try {
        await privatePath(folder, 'directory', 'verify');
        await privatePath(path, 'file', 'verify');
        const file = await open(path, 'r');
        try {
          if ((await file.stat()).size > 16_384) return null;
          const contents = await file.readFile('utf8');
          let parsed: unknown;
          try {
            parsed = JSON.parse(contents);
          } catch {
            throw new GitHubCredentialFenceReadError('parse_failed');
          }
          return decode(parsed);
        } finally {
          await file.close();
        }
      } catch (error) {
        if (error instanceof GitHubCredentialFenceReadError) throw error;
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? error.code
            : undefined;
        // Only a missing fence is unbound; other failures must not delete.
        if (code === 'ENOENT') return null;
        throw new GitHubCredentialFenceReadError(
          fenceReadFailureFromCode(code),
        );
      }
    },
    async write(fence) {
      const record = decode({ version: 1, ...fence });
      if (!record) throw new TypeError('Invalid credential fence.');
      await privatePath(folder, 'directory', 'verify');
      const temporary = join(folder, `.github-pat-fence-${randomUUID()}`);
      try {
        const file = await open(temporary, 'wx', 0o600);
        try {
          await privatePath(temporary, 'file', 'restrict');
          await file.writeFile(JSON.stringify({ version: 1, ...record }));
          await file.sync();
        } finally {
          await file.close();
        }
        const renamed = await files.rename({
          from: temporary,
          to: path,
          mode: 'replace',
        });
        if (renamed.kind !== 'renamed' || renamed.sourceState !== 'removed')
          throw new Error('Credential fence rename unconfirmed.');
        await files.syncDirectory(folder);
      } finally {
        await unlink(temporary).catch(() => undefined);
      }
    },
  };
}
