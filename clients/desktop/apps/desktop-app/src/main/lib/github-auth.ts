import { execFile } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import {
  getGitHubPatFilePath,
  getInternalLegacySharedGitHubPatFilePath,
  getLegacyGitHubPatFilePath,
} from './paths';
import type {
  GitHubCliStatus,
  StoredSecretReadResult,
} from '@canopy/desktop-shared/types';
import { GITHUB_CLI_ENVIRONMENT_VARIABLES } from '@canopy/protocol/canopy-core';
import {
  parseGitHubCliStatusOutput,
  type GitHubCliHostEntry,
  type GitHubCliObservation,
  type GitHubCredentialDescription,
} from '@canopy/core-runtime/node/github';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import {
  getSecretStoragePolicy,
  getSecureStorageFailure,
} from './secure-storage-policy';
import { migrateSecureStorageFile } from './secure-storage-migration';
import { isMissingFileError } from './fs-utils';
import { createAppError } from '@canopy/protocol/app-errors';
import { reportMainAppError } from '@canopy/desktop-instrumentation/electron/main';
import { reportSecureStorageFailure } from '../observability/secure-storage-failure-reporter';
import {
  getBundledGhBinaryPath,
  getEnhancedEnv,
} from '../pipelines/config-paths';

const execFileAsync = promisify(execFile);

const TOKEN_TTL_MS = 5 * 60 * 1000;

export type GitHubTokenSource = 'pat' | 'gh-cli' | 'none';

let cachedToken: string | null = null;
let cachedSource: GitHubTokenSource = 'none';
let cachedAt = 0;
let cachedBackend: string | null = null;
/**
 * Whether the latest credential resolution found a token. Read
 * synchronously by the local-only egress guard (docs/local-only-build.md),
 * which allows the GitHub hosts only while GitHub is connected.
 */
let lastResolutionHadToken = false;
/**
 * Bumped by `invalidateTokenCache()`, so a resolution that was in flight when
 * GitHub was disconnected can't set `lastResolutionHadToken` back to true.
 */
let credentialGeneration = 0;

export function hasResolvedGitHubCredential(): boolean {
  return lastResolutionHadToken;
}

function noteResolution(generation: number, token: string): void {
  if (generation === credentialGeneration) {
    lastResolutionHadToken = token !== '';
  }
}

type StoredTokenRead = StoredSecretReadResult<string> & {
  migrationDeferred?: boolean;
};

export async function readStoredPatWithStatus(): Promise<
  StoredSecretReadResult<string>
> {
  const result = await readStoredPatResult();
  if (result.status !== 'ok') return result;
  return {
    status: 'ok',
    value: result.value,
    ...(result.migrationWriteFailure
      ? { migrationWriteFailure: result.migrationWriteFailure }
      : {}),
  };
}

/**
 * The PAT read returns a secure-storage failure as a result, so the user just
 * appears signed out of GitHub. Report it: the closed storage record for a
 * storage failure, and a static source (never the error) for an unreadable file.
 */
async function readStoredPatResult(): Promise<StoredTokenRead> {
  const result = await readStoredPatUnreported();
  if (result.status === 'storage-error') {
    reportSecureStorageFailure('github-pat', result.failure);
  } else if (result.status === 'error') {
    reportMainAppError(
      createAppError('external.service_unavailable', {
        source: 'secure-storage.github-pat.read.unreadable',
      }),
    );
  }
  return result;
}

async function readStoredPatUnreported(): Promise<StoredTokenRead> {
  const policy = getSecretStoragePolicy();
  const filePath = getGitHubPatFilePath();
  try {
    const migration = await migrateSecureStorageFile<string>({
      currentPath: filePath,
      legacyPath: getInternalLegacySharedGitHubPatFilePath(),
      decode: (raw) => policy.decrypt(raw),
      encode: (token) => policy.encrypt(token),
      storeKind: 'github-pat',
      beforeWrite: async () => {
        await mkdir(dirname(filePath), { recursive: true });
        policy.assertCanWrite();
      },
      writeOptions: { mode: 0o600 },
    });
    switch (migration.status) {
      case 'current':
      case 'migrated':
        return { status: 'ok', value: migration.value };
      case 'legacy-decoded-write-deferred':
        return {
          migrationDeferred: true,
          status: 'ok',
          value: migration.value,
          ...(migration.secureStorageFailure
            ? { migrationWriteFailure: migration.secureStorageFailure }
            : {}),
        };
      case 'storage-error':
        return {
          status: 'storage-error',
          failure: migration.secureStorageFailure,
        };
      case 'current-error':
        return { status: 'error', error: migration.error };
      case 'foreign-legacy-skipped':
        return migration.secureStorageFailure
          ? { status: 'ok', value: null, migrationDeferred: true }
          : { status: 'error', error: new Error('Secure store read failed') };
      case 'absent':
        try {
          return {
            status: 'ok',
            value: policy.decrypt(await readFile(getLegacyGitHubPatFilePath())),
          };
        } catch (error) {
          if (isMissingFileError(error)) return { status: 'ok', value: null };
          throw error;
        }
      default:
        return {
          status: 'error',
          error: new Error('Secure store read failed'),
        };
    }
  } catch (error) {
    const failure = getSecureStorageFailure(error);
    return failure
      ? { status: 'storage-error', failure }
      : { status: 'error', error };
  }
}

function backendIdentity(): string {
  return JSON.stringify([
    hostOperatingSystem(),
    getSecretStoragePolicy().getStatus().backend,
  ]);
}

export async function loadStoredPat(): Promise<string> {
  const result = await readStoredPatWithStatus();
  return result.status === 'ok' ? (result.value ?? '') : '';
}

export async function loadGhCliToken(): Promise<string> {
  try {
    // Bypass the Canopy-managed PAT injection so this returns gh's own
    // credential-store token, not whatever we injected as GH_TOKEN.
    // Externally-set GH_TOKEN still passes through (we never strip
    // user-provided env vars).
    const { stdout } = await execFileAsync(
      getBundledGhBinaryPath(),
      ['auth', 'token'],
      {
        timeout: 10_000,
        env: getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
        windowsHide: process.platform === 'win32',
      },
    );
    return stdout.trim();
  } catch {
    return '';
  }
}

export async function resolveGitHubToken(): Promise<string> {
  const { token } = await resolveGitHubTokenWithSource();
  return token;
}

type StoredCredentialState = GitHubCredentialDescription['storedCredential'];

function storedCredentialState(stored: StoredTokenRead): StoredCredentialState {
  if (stored.status === 'storage-error') return 'storage-unavailable';
  if (stored.status === 'error') return 'unreadable';
  return stored.value ? 'present' : 'absent';
}

/** One credential resolution, with what it saw of the secure store. */
async function resolveGitHubCredential(): Promise<{
  token: string;
  source: GitHubTokenSource;
  storedCredential: StoredCredentialState;
}> {
  if (cachedToken && Date.now() - cachedAt < TOKEN_TTL_MS) {
    // Only a readable store's PAT, or its absence, is ever cached.
    if (cachedSource === 'gh-cli')
      return {
        token: cachedToken,
        source: cachedSource,
        storedCredential: 'absent',
      };
    try {
      getSecretStoragePolicy().assertCanRead();
      if (cachedBackend === backendIdentity())
        return {
          token: cachedToken,
          source: cachedSource,
          storedCredential: 'present',
        };
    } catch (error) {
      // The cached PAT is no longer readable: the user appears signed out.
      const failure = getSecureStorageFailure(error);
      if (failure) reportSecureStorageFailure('github-pat', failure);
      const token = await loadGhCliToken();
      return {
        token,
        source: token ? 'gh-cli' : 'none',
        storedCredential: 'storage-unavailable',
      };
    }
  }

  const stored = await readStoredPatResult();
  let token = stored.status === 'ok' ? (stored.value ?? '') : '';
  let source: GitHubTokenSource = token ? 'pat' : 'none';

  if (!token) {
    token = await loadGhCliToken();
    if (token) {
      source = 'gh-cli';
    }
  }

  if (token && stored.status === 'ok' && !stored.migrationDeferred) {
    cachedToken = token;
    cachedSource = source;
    cachedAt = Date.now();
    cachedBackend = backendIdentity();
  } else if (stored.status === 'ok' && !token) {
    invalidateTokenCache();
  }

  return { token, source, storedCredential: storedCredentialState(stored) };
}

export async function resolveGitHubTokenWithSource(): Promise<{
  token: string;
  source: GitHubTokenSource;
}> {
  const generation = credentialGeneration;
  const { token, source } = await resolveGitHubCredential();
  noteResolution(generation, token);
  return { token, source };
}

/**
 * The credential's source and the secure store's state, from the same
 * resolution and cache as `resolveGitHubToken`; the token is dropped here.
 */
export async function describeGitHubCredential(): Promise<GitHubCredentialDescription> {
  const generation = credentialGeneration;
  const { token, source, storedCredential } = await resolveGitHubCredential();
  noteResolution(generation, token);
  return { tokenSource: source, storedCredential };
}

export function invalidateTokenCache(): void {
  credentialGeneration += 1;
  lastResolutionHadToken = false;
  cachedToken = null;
  cachedSource = 'none';
  cachedAt = 0;
  cachedBackend = null;
}

const GH_ENV_TOKEN_SOURCES: ReadonlySet<string> = new Set(
  GITHUB_CLI_ENVIRONMENT_VARIABLES,
);

/**
 * Runs the bundled `gh auth status --json hosts` without Canopy secrets or the
 * user environment, so it reports gh's own credential store (or an externally
 * set GH_TOKEN/GITHUB_TOKEN), not whether Canopy injected a PAT.
 */
export async function observeGitHubCli(): Promise<GitHubCliObservation> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      getBundledGhBinaryPath(),
      ['auth', 'status', '--json', 'hosts'],
      {
        timeout: 10_000,
        env: getEnhancedEnv({
          includeCanopySecrets: false,
          environment: false,
        }),
        windowsHide: hostOperatingSystem() === 'win32',
      },
    );
    stdout = result.stdout;
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT')
      return { kind: 'not-installed' };
    return { kind: 'failed' };
  }
  return parseGitHubCliStatusOutput(stdout);
}

function unauthenticatedGitHubCliStatus(error: string): GitHubCliStatus {
  return {
    authenticated: false,
    username: null,
    error,
    tokenSource: null,
    envOverride: false,
    envOverrideName: null,
    hasCredentialStoreLogin: false,
  };
}

function summarizeGhHostEntries(
  entries: readonly GitHubCliHostEntry[],
): GitHubCliStatus {
  const active = entries.find((entry) => entry.active) ?? null;
  const tokenSource = active?.tokenSource ?? null;
  const envOverride =
    tokenSource !== null && GH_ENV_TOKEN_SOURCES.has(tokenSource);
  const hasCredentialStoreLogin = entries.some(
    (entry) => !GH_ENV_TOKEN_SOURCES.has(entry.tokenSource),
  );

  if (!active) {
    return {
      ...unauthenticatedGitHubCliStatus('GitHub CLI is not authenticated.'),
      hasCredentialStoreLogin,
    };
  }

  return {
    authenticated: true,
    username: active.login || null,
    error: null,
    tokenSource,
    envOverride,
    envOverrideName: envOverride ? tokenSource : null,
    hasCredentialStoreLogin,
  };
}

/** The `settings:github-cli-status` response for one observation. */
export function legacyGitHubCliStatus(
  observation: GitHubCliObservation,
): GitHubCliStatus {
  switch (observation.kind) {
    case 'not-installed':
      return unauthenticatedGitHubCliStatus(
        'GitHub CLI (gh) is not installed.',
      );
    case 'unparseable-output':
      return unauthenticatedGitHubCliStatus(
        'Unable to parse GitHub CLI status output.',
      );
    case 'failed':
      return unauthenticatedGitHubCliStatus('GitHub CLI is not authenticated.');
    case 'hosts':
      return observation.entries.length === 0
        ? unauthenticatedGitHubCliStatus('GitHub CLI is not authenticated.')
        : summarizeGhHostEntries(observation.entries);
  }
}

/**
 * The GitHub CLI status, read directly. Retained direct callers only
 * (`check:core-pull-request-boundary`); interfaces read
 * `core.integration.get`.
 */
export async function checkGitHubCliStatus(): Promise<GitHubCliStatus> {
  return legacyGitHubCliStatus(await observeGitHubCli());
}
