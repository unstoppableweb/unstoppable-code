import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  GitHubCliStatus,
  LinearStatus,
} from '@canopy/desktop-shared/types';
import {
  GITHUB_CLI_INTEGRATION_ID,
  type CoreIntegration,
  type CoreIntegrationCredentialValidateParams,
  type CoreIntegrationCredentialValidateResult,
  type CoreIntegrationGetParams,
  type CoreIntegrationListParams,
  type CoreIntegrationListResult,
  type CoreIntegrationResourceGetParams,
  type CoreIntegrationResourceGetResult,
  type CoreIntegrationResourceListParams,
  type CoreIntegrationResourceListResult,
  type CoreIntegrationSourceRepositoryStarParams,
  type CoreIntegrationSourceRepositoryStarResult,
} from '@canopy/protocol/canopy-core';
import type {
  LinearIssuePreviewResult,
  LinearTeamKeysResult,
} from '@canopy/protocol/reference-previews';
import { parseGitHubRepositoryUrl } from '@canopy/protocol/settings/github-repository-url';
import type {
  CanopyInstructionOptions,
  CanopyQueryOptions,
} from '@canopy/core-runtime';
import {
  createCoreIntegrationHandlers,
  createCoreIntegrationInstructionHandlers,
  type CoreIntegrationHandlers,
  type CoreIntegrationHost,
  type CoreIntegrationInstructionHandlers,
  type GitHubRepositoryTarget,
  type LinearIntegrationPort,
} from '@canopy/core-runtime/node/github';
import { BRAND } from '@canopy/brand/current';
import type { DesktopBrandRuntime } from '@canopy/protocol/brand';
import { desktopGitHubRequestHandle } from '../github/request-handle';
import { legacyGitHubCliStatus, observeGitHubCli } from '../lib/github-auth';
import { starGitHubRepositoryWithCli } from '../lib/github-cli-star';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** The dispatcher surface the `core.integration.*` projections use. */
export interface CoreIntegrationDispatcher {
  query(
    name: 'core.integration.get',
    params: CoreIntegrationGetParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegration>;
  query(
    name: 'core.integration.list',
    params: CoreIntegrationListParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegrationListResult>;
  query(
    name: 'core.integration.resource.list',
    params: CoreIntegrationResourceListParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegrationResourceListResult>;
  query(
    name: 'core.integration.resource.get',
    params: CoreIntegrationResourceGetParams,
    options: CanopyQueryOptions,
  ): Promise<CoreIntegrationResourceGetResult>;
  instruction(
    name: 'core.integration.sourceRepository.star',
    params: CoreIntegrationSourceRepositoryStarParams,
    options: CanopyInstructionOptions,
  ): Promise<CoreIntegrationSourceRepositoryStarResult>;
  instruction(
    name: 'core.integration.credential.validate',
    params: CoreIntegrationCredentialValidateParams,
    options: CanopyInstructionOptions,
  ): Promise<CoreIntegrationCredentialValidateResult>;
}

/** One projected call's capture of the legacy status its observation made. */
interface GitHubCliCapture {
  legacy?: GitHubCliStatus;
}

const gitHubCliCapture = new AsyncLocalStorage<GitHubCliCapture>();

/** One projected call's capture of the legacy Linear result its read made. */
interface LinearCapture {
  issue?: LinearIssuePreviewResult;
  teams?: LinearTeamKeysResult;
  validation?: LinearStatus;
}

const linearCapture = new AsyncLocalStorage<LinearCapture>();

export const INVALID_LINEAR_TOKEN =
  'Invalid API key or unable to reach Linear.';

/**
 * The machine's Linear connection over the reference-preview reader the
 * preview IPC shares, and the viewer probe, each loaded on first use so
 * startup pays nothing for them. Inside a projection it captures the legacy
 * result its read made.
 */
const desktopLinearIntegrationPort: LinearIntegrationPort = {
  readCredentialState: async () => {
    const { readStoredLinearTokenWithStatus } =
      await import('../lib/linear-auth');
    const read = await readStoredLinearTokenWithStatus();
    if (read.status !== 'ok') return 'unreadable';
    return read.value?.trim() ? 'stored' : 'absent';
  },
  readCurrentScope: async () => {
    const { sharedLinearReferencePreviewReader } =
      await import('../lib/linear-reference-preview');
    return (await sharedLinearReferencePreviewReader().readScope()).scope;
  },
  // The reader coalesces reads across windows and caches the catalog for
  // five minutes, so one caller's signal must not abort them.
  readTeamKeys: async () => {
    const { sharedLinearReferencePreviewReader } =
      await import('../lib/linear-reference-preview');
    const result = await sharedLinearReferencePreviewReader().readTeamKeys();
    const capture = linearCapture.getStore();
    if (capture) capture.teams = result;
    return result;
  },
  readIssue: async (request) => {
    const { sharedLinearReferencePreviewReader } =
      await import('../lib/linear-reference-preview');
    const result =
      await sharedLinearReferencePreviewReader().readIssue(request);
    const capture = linearCapture.getStore();
    if (capture) capture.issue = result;
    return result;
  },
  validate: async (secret, { signal }) => {
    const { isLinearApiError, readLinearViewer } =
      await import('../lib/linear-api');
    const capture = linearCapture.getStore();
    try {
      const viewer = await readLinearViewer(secret.trim(), { signal });
      const displayName = viewer.displayName ?? viewer.name;
      if (capture)
        capture.validation = { authenticated: true, displayName, error: null };
      return displayName === ''
        ? { valid: true }
        : { valid: true, displayName };
    } catch (error: unknown) {
      if (capture)
        capture.validation = {
          authenticated: false,
          displayName: null,
          error: INVALID_LINEAR_TOKEN,
        };
      if (!isLinearApiError(error))
        return { valid: false, errorKind: 'unreachable' };
      return {
        valid: false,
        errorKind:
          error.type === 'authentication' || error.type === 'forbidden'
            ? 'unauthorized'
            : // Malformed input, or a response Linear's schema doesn't match.
              error.type === 'invalid_input' || error.type === 'unknown'
              ? 'invalid'
              : 'unreachable',
      };
    }
  },
};

// The annotated alias: the generated per-brand module infers a narrow `web`
// shape that omits `marketing` for brands that do not declare it.
const brand: DesktopBrandRuntime = BRAND;

/**
 * The github.com repository a brand's `sourceRepository` names, or `null`
 * when it declares none or the URL is not a github.com repository.
 */
export function resolveBrandSourceRepository(
  url: string | undefined,
): GitHubRepositoryTarget | null {
  if (url === undefined) return null;
  const parsed = parseGitHubRepositoryUrl(url);
  return parsed.ok ? { owner: parsed.owner, repo: parsed.repo } : null;
}

/**
 * The desktop host for `core.integration.*`: Canopy's credential through the
 * results-only request handle, and the bundled GitHub CLI's own status.
 * Inside the `settings:github-cli-status` projection it also captures the
 * legacy status computed from the same observation.
 */
export const desktopCoreIntegrationHost: CoreIntegrationHost = {
  // No enrolled targets: any explicit target is refused.
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  github: desktopGitHubRequestHandle,
  observeGitHubCli: async () => {
    const observation = await observeGitHubCli();
    const capture = gitHubCliCapture.getStore();
    if (capture) capture.legacy = legacyGitHubCliStatus(observation);
    return observation;
  },
  sourceRepository: resolveBrandSourceRepository(
    brand.web.marketing?.sourceRepository?.url,
  ),
  starRepository: starGitHubRepositoryWithCli,
  linear: desktopLinearIntegrationPort,
};

/** `core.integration.*` handlers over the desktop host. */
export function createCoreIntegrationAdapter(
  host: CoreIntegrationHost = desktopCoreIntegrationHost,
): {
  queries: CoreIntegrationHandlers;
  instructions: CoreIntegrationInstructionHandlers;
} {
  return {
    queries: createCoreIntegrationHandlers(host),
    instructions: createCoreIntegrationInstructionHandlers(host),
  };
}

/**
 * Dispatches `core.integration.get` for `github-cli` in the projection
 * context and returns the legacy status the host computed, error message and
 * raw CLI token source included, for the IPC channel to return byte for
 * byte. Once the host has read the CLI, a canonical mapping or validation
 * failure answers `canonicalResult: null` instead of replacing it.
 */
export async function queryGitHubCliStatusForLegacyIpc(
  dispatcher: CoreIntegrationDispatcher,
  options: CanopyQueryOptions,
): Promise<{
  canonicalResult: CoreIntegration | null;
  legacyResult: GitHubCliStatus;
}> {
  const capture: GitHubCliCapture = {};
  try {
    const canonicalResult = await gitHubCliCapture.run(capture, () =>
      dispatcher.query(
        'core.integration.get',
        { integrationId: GITHUB_CLI_INTEGRATION_ID },
        options,
      ),
    );
    if (capture.legacy === undefined)
      throw new Error('GitHub CLI status projection was not captured.');
    return { canonicalResult, legacyResult: capture.legacy };
  } catch (error) {
    if (capture.legacy !== undefined)
      return { canonicalResult: null, legacyResult: capture.legacy };
    throw error;
  }
}

/**
 * Runs one Linear projection's dispatch and returns the legacy result the
 * host captured, for the IPC channel to return byte for byte. As with the
 * GitHub CLI status, once the host has read Linear a canonical mapping,
 * typed failure or validation failure still answers the captured result.
 */
export async function captureLinearForLegacyIpc<
  Key extends keyof LinearCapture,
>(
  key: Key,
  dispatch: () => Promise<unknown>,
): Promise<NonNullable<LinearCapture[Key]>> {
  const capture: LinearCapture = {};
  try {
    await linearCapture.run(capture, dispatch);
  } catch (error) {
    const legacy = capture[key];
    if (legacy !== undefined) return legacy;
    throw error;
  }
  const legacy = capture[key];
  if (legacy === undefined)
    throw new Error('Linear projection was not captured.');
  return legacy;
}
