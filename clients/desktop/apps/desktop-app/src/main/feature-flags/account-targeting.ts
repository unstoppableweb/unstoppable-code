import { BRAND } from '@canopy/brand/current';
import { getGitHubClient } from '../lib/github-client';
import { getCanopyCloudBaseUrl } from '../canopy-cloud/config';
import { loadCanopyCloudAccount } from '../lib/canopy-cloud-account-store';
import { readClaudeAuthInfo } from '../lib/claude-auth';
import type { CanopyAccountResponse } from '@canopy/protocol/canopy-server';
import type {
  CanopyOrganizationSummary,
  CanopyTeamSummary,
} from '@canopy/protocol/pipelines';
import type { GetAccountResponse } from '@canopy/execution-engine/node/codex-runtime/generated/v2/GetAccountResponse';

const PROBE_TIMEOUT_MS = 3_000;

export interface GitHubTargetingInfo {
  id: string | null;
  username: string | null;
  email: string | null;
}

export interface ProviderTargetingInfo {
  email: string | null;
  accountLabel: string | null;
}

export interface CanopyServerTargetingInfo {
  userIds: string[];
  emails: string[];
  organizationIds: string[];
  teamIds: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortUnique(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.filter((value) => value.trim().length > 0)),
  ).sort();
}

function readString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  return typeof field === 'string' && field.trim().length > 0
    ? field.trim()
    : null;
}

function normalizeOrganization(
  value: unknown,
): CanopyOrganizationSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const createdAt = readString(value, 'createdAt');
  const updatedAt = readString(value, 'updatedAt');
  return id && name && createdAt && updatedAt
    ? { id, name, createdAt, updatedAt }
    : null;
}

function normalizeTeam(value: unknown): CanopyTeamSummary | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = readString(value, 'id');
  const name = readString(value, 'name');
  const organization = normalizeOrganization(value.organization);
  const createdAt = readString(value, 'createdAt');
  const updatedAt = readString(value, 'updatedAt');
  return id && name && organization && createdAt && updatedAt
    ? { id, name, organization, createdAt, updatedAt }
    : null;
}

async function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    promise.catch(() => undefined);
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => {
          onTimeout?.();
          resolve(fallback);
        }, PROBE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function warnProbeFailure(label: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `[feature-flags] ${label} targeting probe failed: ${message}\n`,
  );
}

export async function readGitHubTargetingInfo(): Promise<GitHubTargetingInfo> {
  const controller = new AbortController();
  return withTimeout(
    (async (): Promise<GitHubTargetingInfo> => {
      try {
        const client = getGitHubClient();
        const authenticated = await client.enqueue(
          (octokit) =>
            octokit.rest.users.getAuthenticated({
              request: { signal: controller.signal },
            }),
          'high',
          {
            operation: 'read',
            idempotency: 'safe',
            signal: controller.signal,
            timeoutMs: PROBE_TIMEOUT_MS,
          },
        );
        let email = authenticated.data.email ?? null;
        if (!email) {
          try {
            const emails = await client.enqueue(
              (octokit) =>
                octokit.rest.users.listEmailsForAuthenticatedUser({
                  request: { signal: controller.signal },
                }),
              'high',
              {
                operation: 'read',
                idempotency: 'safe',
                signal: controller.signal,
                timeoutMs: PROBE_TIMEOUT_MS,
              },
            );
            email =
              emails.data.find((entry) => entry.primary && entry.verified)
                ?.email ?? null;
          } catch (error) {
            warnProbeFailure('GitHub email', error);
          }
        }
        return {
          id: String(authenticated.data.id),
          username: authenticated.data.login ?? null,
          email,
        };
      } catch (error) {
        warnProbeFailure('GitHub', error);
        return { id: null, username: null, email: null };
      }
    })(),
    { id: null, username: null, email: null },
    () => {
      controller.abort();
    },
  );
}

export async function readClaudeTargetingInfo(): Promise<ProviderTargetingInfo> {
  return withTimeout(
    readClaudeAuthInfo(PROBE_TIMEOUT_MS)
      .then((info) => ({
        email: info.email,
        accountLabel: info.accountLabel,
      }))
      .catch(() => ({ email: null, accountLabel: null })),
    { email: null, accountLabel: null },
  );
}

async function readCodexAccount(): Promise<GetAccountResponse | null> {
  // Both Codex modules reach plugin resolution, which reads feature flags.
  // Load them only when probing so flag-service initialization does not cycle.
  const { parseGetAccountResponsePayload } =
    await import('../codex/app-server-client');
  const { getCodexRuntimeService } = await import('../codex/runtime-service');
  return withTimeout(
    getCodexRuntimeService()
      .admin()
      .request('account/read', { refreshToken: false })
      .then((response) => parseGetAccountResponsePayload(response)),
    null,
  );
}

export async function readCodexTargetingInfo(): Promise<ProviderTargetingInfo> {
  return withTimeout(
    readCodexAccount()
      .then((response) => {
        if (!response) {
          return { email: null, accountLabel: null };
        }
        const account = response.account;
        if (account?.type !== 'chatgpt') {
          return { email: null, accountLabel: null };
        }
        return { email: account.email, accountLabel: account.email };
      })
      .catch(() => ({ email: null, accountLabel: null })),
    { email: null, accountLabel: null },
  );
}

function normalizeAccountResponse(
  value: unknown,
): CanopyAccountResponse | null {
  if (!isRecord(value) || !isRecord(value.account)) {
    return null;
  }
  const account = value.account;
  if (
    typeof account.id !== 'string' ||
    typeof account.name !== 'string' ||
    typeof account.email !== 'string' ||
    (account.role !== 'VIEWER' &&
      account.role !== 'DEVELOPER' &&
      account.role !== 'ADMIN') ||
    !Array.isArray(value.capabilities) ||
    !Array.isArray(value.organizations) ||
    !Array.isArray(value.teams)
  ) {
    return null;
  }
  const capabilities = value.capabilities.filter(
    (capability): capability is string => typeof capability === 'string',
  );
  if (capabilities.length !== value.capabilities.length) {
    return null;
  }
  const organizations = value.organizations
    .map(normalizeOrganization)
    .filter((entry): entry is CanopyOrganizationSummary => entry !== null);
  const teams = value.teams
    .map(normalizeTeam)
    .filter((entry): entry is CanopyTeamSummary => entry !== null);
  if (
    organizations.length !== value.organizations.length ||
    teams.length !== value.teams.length
  ) {
    return null;
  }
  return {
    account: {
      id: account.id,
      name: account.name,
      email: account.email,
      role: account.role,
      ...(typeof account.image === 'string' && account.image.trim().length > 0
        ? { image: account.image }
        : {}),
    },
    capabilities,
    organizations,
    teams,
  };
}

export async function readCanopyServerTargetingInfo(): Promise<CanopyServerTargetingInfo> {
  const entry = await loadCanopyCloudAccount().catch(() => null);
  if (!entry || entry.apiKey.trim().length === 0) {
    return {
      userIds: [],
      emails: [],
      organizationIds: [],
      teamIds: [],
    };
  }

  try {
    const baseUrl = getCanopyCloudBaseUrl();
    const response = await fetch(
      `${baseUrl}/api/v1/${BRAND.web.apiNamespace}/account`,
      {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${entry.apiKey}`,
        },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`.trim());
    }
    const payload = normalizeAccountResponse(await response.json());
    if (!payload) {
      throw new Error('Invalid account response.');
    }
    return {
      userIds: [payload.account.id],
      emails: [payload.account.email],
      organizationIds: payload.organizations.map(
        (organization) => organization.id,
      ),
      teamIds: payload.teams.map((team) => team.id),
    };
  } catch (error) {
    warnProbeFailure(`${BRAND.displayName} Cloud`, error);
  }

  return {
    userIds: entry.account ? [entry.account.id] : [],
    emails: entry.account ? [entry.account.email] : [],
    organizationIds: sortUnique(
      (entry.organizations ?? []).map((organization) => organization.id),
    ),
    teamIds: sortUnique((entry.teams ?? []).map((team) => team.id)),
  };
}
