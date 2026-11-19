'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { GitHubRepositoryPickerPage } from '@canopy/protocol/settings/organization-repositories';
import type {
  ReviewApprovalOwner,
  ReviewApprovalPolicy,
  ReviewApprovalPolicyReadResult,
} from '@canopy/protocol/settings/github-review-approvals';
import { useSettingsClient } from '../host';
import {
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
} from '../errors';
import type { GitHubRepositoryPageRequest } from './GitHubRepositoryMultiPicker';

// ---------------------------------------------------------------------------
// The code review approval policy of one owner (an organization or the
// signed-in person), over the six `*.github.reviewApprovals.*` settings
// operations. The owner picks the operation names; the host never matters.
//
// Every change applies optimistically and sends the whole policy. One save is
// in flight at a time: a change made meanwhile is sent after it, from the
// latest state, so two controls never overwrite each other. A failed save
// rolls back to the last policy the server confirmed and drops any change
// queued behind it.
// ---------------------------------------------------------------------------

export const REVIEW_APPROVALS_ERROR_SCOPE = 'settings.github.reviewApprovals';

/** The policy routes' own codes, as fixed local copy. Never server text. */
export const REVIEW_APPROVALS_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  { serverCode: 'not_connected', copy: 'Connect GitHub first.' },
  {
    serverCode: 'invalid_repository',
    copy: "Couldn't use one of the selected repositories. Remove it and try again.",
  },
  {
    serverCode: 'unavailable',
    copy: "AI review approvals aren't available right now.",
  },
];

function readPolicy(
  client: AccountOrganizationSettingsClient,
  owner: ReviewApprovalOwner,
): Promise<ReviewApprovalPolicyReadResult> {
  return owner.kind === 'organization'
    ? client.read('organization.github.reviewApprovals.read', {
        organizationId: owner.organizationId,
      })
    : client.read('account.github.reviewApprovals.read', {});
}

function writePolicy(
  client: AccountOrganizationSettingsClient,
  owner: ReviewApprovalOwner,
  policy: ReviewApprovalPolicy,
): Promise<ReviewApprovalPolicyReadResult> {
  const fields = {
    enabled: policy.enabled,
    minScore: policy.minScore,
    repoScope: policy.repoScope,
    repositoryIds: policy.repositories.map((repository) => repository.id),
  };
  return owner.kind === 'organization'
    ? client.write('organization.github.reviewApprovals.update', {
        organizationId: owner.organizationId,
        ...fields,
      })
    : client.write('account.github.reviewApprovals.update', fields);
}

function listPolicyRepositories(
  client: AccountOrganizationSettingsClient,
  owner: ReviewApprovalOwner,
  request: GitHubRepositoryPageRequest,
): Promise<GitHubRepositoryPickerPage> {
  const page = {
    ...(request.cursor ? { cursor: request.cursor } : {}),
    ...(request.query !== '' ? { query: request.query } : {}),
  };
  return owner.kind === 'organization'
    ? client.read('organization.github.reviewApprovals.repositories', {
        organizationId: owner.organizationId,
        ...page,
      })
    : client.read('account.github.reviewApprovals.repositories', page);
}

export interface ReviewApprovalPolicyController {
  /** `loading` until the first read answers. */
  readonly status: 'loading' | 'ready' | 'error';
  readonly available: boolean;
  /** The policy as shown: the server's, plus any change not yet confirmed. */
  readonly policy: ReviewApprovalPolicy | null;
  readonly scopeLabel: string | null;
  readonly saving: boolean;
  readonly loadError: SettingsFailure | null;
  readonly saveError: SettingsFailure | null;
  /** Reads the policy again after a failed read. */
  readonly reload: () => void;
  /** Applies a change optimistically and saves the whole policy. */
  readonly update: (change: Partial<ReviewApprovalPolicy>) => void;
  /** Sends the change that failed to save again. */
  readonly retrySave: () => void;
  readonly listRepositories: (
    request: GitHubRepositoryPageRequest,
  ) => Promise<GitHubRepositoryPickerPage>;
}

export function useReviewApprovalPolicy(
  owner: ReviewApprovalOwner,
): ReviewApprovalPolicyController {
  const client = useSettingsClient();
  const errorCopy = useSettingsErrorCopy(REVIEW_APPROVALS_ERROR_SCOPE);
  const ownerKey =
    owner.kind === 'organization' ? `org:${owner.organizationId}` : 'personal';
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [available, setAvailable] = useState(false);
  const [policy, setPolicy] = useState<ReviewApprovalPolicy | null>(null);
  const [scopeLabel, setScopeLabel] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<SettingsFailure | null>(null);
  const [saveError, setSaveError] = useState<SettingsFailure | null>(null);
  const [reloadCount, setReloadCount] = useState(0);

  /** The last policy the server confirmed. */
  const confirmed = useRef<ReviewApprovalPolicy | null>(null);
  /** The policy as shown, read synchronously by `update`. */
  const latest = useRef<ReviewApprovalPolicy | null>(null);
  const failedPolicy = useRef<ReviewApprovalPolicy | null>(null);
  const inFlight = useRef(false);
  const dirty = useRef(false);
  /** Bumped per owner and on unmount, so a stale answer is dropped. */
  const generation = useRef(0);

  const apply = (next: ReviewApprovalPolicy | null): void => {
    latest.current = next;
    setPolicy(next);
  };

  useEffect(() => {
    const current = ++generation.current;
    confirmed.current = null;
    failedPolicy.current = null;
    dirty.current = false;
    inFlight.current = false;
    latest.current = null;
    setPolicy(null);
    setStatus('loading');
    setLoadError(null);
    setSaveError(null);
    setSaving(false);
    readPolicy(client, ownerRef.current).then(
      (result) => {
        if (generation.current !== current) return;
        confirmed.current = result.policy;
        latest.current = result.policy;
        setPolicy(result.policy);
        setAvailable(result.available);
        setScopeLabel(result.scopeLabel);
        setStatus('ready');
      },
      (error: unknown) => {
        if (generation.current !== current) return;
        setLoadError(
          errorCopy.loadFailure(error, REVIEW_APPROVALS_KNOWN_ERRORS),
        );
        setStatus('error');
      },
    );
    return (): void => {
      generation.current += 1;
    };
  }, [client, errorCopy, ownerKey, reloadCount]);

  const pump = useCallback((): void => {
    if (inFlight.current || !dirty.current) return;
    const sending = latest.current;
    if (sending === null) return;
    const current = generation.current;
    inFlight.current = true;
    dirty.current = false;
    setSaving(true);
    writePolicy(client, ownerRef.current, sending).then(
      (result) => {
        if (generation.current !== current) return;
        confirmed.current = result.policy;
        failedPolicy.current = null;
        setAvailable(result.available);
        setScopeLabel(result.scopeLabel);
        // A change made meanwhile stays shown; it is sent next.
        if (!dirty.current) apply(result.policy);
        inFlight.current = false;
        if (dirty.current) pump();
        else setSaving(false);
      },
      (error: unknown) => {
        if (generation.current !== current) return;
        failedPolicy.current = latest.current;
        dirty.current = false;
        inFlight.current = false;
        apply(confirmed.current);
        setSaving(false);
        setSaveError(
          errorCopy.actionFailure(error, {
            action: 'save AI review approvals',
            known: REVIEW_APPROVALS_KNOWN_ERRORS,
          }),
        );
      },
    );
  }, [client, errorCopy]);

  const update = useCallback(
    (change: Partial<ReviewApprovalPolicy>): void => {
      const base = latest.current;
      if (base === null) return;
      apply({ ...base, ...change });
      setSaveError(null);
      dirty.current = true;
      pump();
    },
    [pump],
  );

  const retrySave = useCallback((): void => {
    const failed = failedPolicy.current;
    if (failed === null) return;
    update(failed);
  }, [update]);

  const reload = useCallback((): void => {
    setReloadCount((count) => count + 1);
  }, []);

  const listRepositories = useCallback(
    (
      request: GitHubRepositoryPageRequest,
    ): Promise<GitHubRepositoryPickerPage> =>
      listPolicyRepositories(client, ownerRef.current, request),
    [client],
  );

  return {
    status,
    available,
    policy,
    scopeLabel,
    saving,
    loadError,
    saveError,
    reload,
    update,
    retrySave,
    listRepositories,
  };
}
