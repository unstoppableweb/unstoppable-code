import { parseGitHubPullRequestReference } from '@canopy/protocol/portable-tasks/pull-request-reference';
import { z } from 'zod';
import type { AgentActionBrand } from '../brand';
import {
  AgentPullRequestStatusError,
  type AgentPullRequestRef,
  type AgentPullRequestStatus,
  type AgentPullRequestStatusFailureCode,
  type AgentPullRequestStatusPort,
} from '../port/pull-request-status-port';
import type { AgentActionCall } from '../surface/family';
import type { AgentActionToolResult, AgentJsonSchema } from './definition';

const GITHUB_PULL_REQUEST_REFERENCE_FIELD_DESCRIPTION =
  'GitHub.com pull request URL (https://github.com/owner/repository/pull/123) or owner/repository#123.';

export const getGitHubPullRequestStatusInputSchema = z
  .object({
    pullRequest: z
      .string()
      .min(1)
      .max(512)
      .describe(GITHUB_PULL_REQUEST_REFERENCE_FIELD_DESCRIPTION),
  })
  .strict();

export type GetGitHubPullRequestStatusInput = z.infer<
  typeof getGitHubPullRequestStatusInputSchema
>;

export const GET_GITHUB_PULL_REQUEST_STATUS_JSON_SCHEMA: AgentJsonSchema = {
  type: 'object',
  required: ['pullRequest'],
  properties: {
    pullRequest: {
      type: 'string',
      minLength: 1,
      maxLength: 512,
      description: GITHUB_PULL_REQUEST_REFERENCE_FIELD_DESCRIPTION,
    },
  },
  additionalProperties: false,
};

/**
 * The GetGitHubPullRequestStatus description. A host with WatchGitHubItems
 * names it, so the read and the watcher steer to each other; one without
 * says not to wait by calling the read repeatedly.
 */
export function getGitHubPullRequestStatusDescription(
  brand: AgentActionBrand,
  options: { watchGitHubItemsName?: string } = {},
): string {
  const appName = brand.displayName;
  const waiting =
    options.watchGitHubItemsName === undefined
      ? "Don't call it repeatedly to wait for CI, a merge, a close, or a merge queue change."
      : `To wait for CI, a merge, a close, or a merge queue change, use ${options.watchGitHubItemsName} instead of calling this repeatedly.`;
  return `Read one GitHub.com pull request's current status from ${appName}'s shared, briefly cached read model: state (open, closed, merged), draft, head and base branches, head commit, mergeability, review decision, a checks summary with failing check names, and merge queue position. Pass pullRequest as a pull request URL or owner/repository#number. Read-only: repeated and concurrent reads share one GitHub request, and fetchedAt says how fresh the result is. Use it for a one-off status check instead of gh pr view, gh pr checks, or gh api. ${waiting} Never poll GitHub from the shell (gh pr checks --watch, gh run watch, or repeated gh pr view or gh api loops): agents and ${appName} share one GitHub rate limit.`;
}

interface Failure {
  ok: false;
  code: AgentPullRequestStatusFailureCode;
  message: string;
  retryAt?: string;
  retryAfterSeconds?: number;
}

function failure(value: Failure): AgentActionToolResult {
  return { text: JSON.stringify(value), isError: true };
}

function readFailure(error: unknown, label: string, nowMs: number): Failure {
  if (!(error instanceof AgentPullRequestStatusError)) {
    return {
      ok: false,
      code: 'unavailable',
      message: `Could not read ${label} from GitHub. Try again in a few minutes.`,
    };
  }
  const retryAtMs = error.retryAt?.getTime();
  if (
    error.code !== 'rate_limited' ||
    retryAtMs === undefined ||
    Number.isNaN(retryAtMs) ||
    retryAtMs <= nowMs
  ) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: 'rate_limited',
    message: error.message,
    retryAt: new Date(retryAtMs).toISOString(),
    retryAfterSeconds: Math.ceil((retryAtMs - nowMs) / 1000),
  };
}

function successPayload(
  ref: AgentPullRequestRef,
  status: AgentPullRequestStatus,
): unknown {
  return {
    ok: true,
    pullRequest: {
      repository: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      ...status,
    },
  };
}

/**
 * GetGitHubPullRequestStatus over a host port: validates the input, parses
 * the reference with the GitHub.com-only rules WatchGitHubItems uses, and
 * returns `{ ok: true, pullRequest }` or `{ ok: false, code, message }`.
 */
export async function executeGetGitHubPullRequestStatus<H>(
  rawArgs: unknown,
  port: AgentPullRequestStatusPort<H>,
  call: AgentActionCall<H>,
  now: () => number = Date.now,
): Promise<AgentActionToolResult> {
  const parsed = getGitHubPullRequestStatusInputSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return failure({
      ok: false,
      code: 'invalid_input',
      message:
        'Invalid arguments for GetGitHubPullRequestStatus. Pass {"pullRequest":"<PR URL or owner/repository#number>"}.',
    });
  }
  const reference = parseGitHubPullRequestReference(parsed.data.pullRequest);
  if (!reference.ok) {
    return failure({
      ok: false,
      code: 'invalid_reference',
      message: reference.message,
    });
  }
  const [owner = '', repo = ''] = reference.value.repository.split('/');
  const ref: AgentPullRequestRef = {
    owner,
    repo,
    number: reference.value.number,
  };
  const label = `${reference.value.repository}#${ref.number}`;
  try {
    const status = await port.read(ref, call);
    return { text: JSON.stringify(successPayload(ref, status)) };
  } catch (error) {
    return failure(readFailure(error, label, now()));
  }
}
