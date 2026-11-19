'use client';

import { useId, type JSX } from 'react';
import {
  Button,
  ErrorBanner,
  Heading,
  Notice,
  SegmentedControl,
  SettingsRowsGroup,
  SettingsRowsRow,
  SettingsRowsSubRow,
  SettingsSelect,
  ToggleSwitch,
  type SegmentedControlOption,
  type SettingsSelectOption,
} from '@canopy/ui-shared/components';
import {
  REVIEW_APPROVAL_MAX_REPOSITORIES,
  REVIEW_APPROVAL_MIN_SCORE_MAX,
  REVIEW_APPROVAL_MIN_SCORE_MIN,
  type ReviewApprovalOwner,
  type ReviewApprovalRepoScope,
  type ReviewApprovalRepository,
} from '@canopy/protocol/settings/github-review-approvals';
import { useSettingsBrand, useSettingsPrivacy } from '../host';
import {
  GitHubRepositoryMultiPicker,
  type GitHubRepositoryMultiPickerItem,
} from './GitHubRepositoryMultiPicker';
import {
  REVIEW_APPROVALS_ERROR_SCOPE,
  REVIEW_APPROVALS_KNOWN_ERRORS,
  useReviewApprovalPolicy,
} from './use-review-approval-policy';

// ---------------------------------------------------------------------------
// "Code reviews": whether the GitHub App approves a pull request when a
// packaged code review passes. One section for both owners, mounted inside
// the organization's GitHub connection card and the personal "GitHub for
// cloud work" card. It renders nothing until the policy is known, while the
// rollout flag is off, or when the server sees no connection, so accounts
// without the feature get no layout jump.
// ---------------------------------------------------------------------------

const MIN_SCORE_OPTIONS: readonly SettingsSelectOption[] = Array.from(
  {
    length: REVIEW_APPROVAL_MIN_SCORE_MAX - REVIEW_APPROVAL_MIN_SCORE_MIN + 1,
  },
  (_, index) => {
    const value = String(REVIEW_APPROVAL_MIN_SCORE_MIN + index);
    return {
      value,
      label: value,
      testId: `code-review-approvals-score-${value}`,
    };
  },
);

const SCOPE_OPTIONS: readonly SegmentedControlOption<ReviewApprovalRepoScope>[] =
  [
    {
      value: 'all',
      label: 'All',
      dataTestId: 'code-review-approvals-scope-all',
    },
    {
      value: 'selected',
      label: 'Selected',
      dataTestId: 'code-review-approvals-scope-selected',
    },
  ];

/** A stored repository as a picker item; only its id and name are used. */
function pickerItem(
  repository: ReviewApprovalRepository,
): GitHubRepositoryMultiPickerItem {
  const slash = repository.fullName.indexOf('/');
  return {
    id: Number(repository.id),
    fullName: repository.fullName,
    owner: slash > 0 ? repository.fullName.slice(0, slash) : '',
    name:
      slash > 0 ? repository.fullName.slice(slash + 1) : repository.fullName,
    defaultBranch: '',
    private: false,
    archived: false,
    htmlUrl: '',
  };
}

function policyRepository(
  item: GitHubRepositoryMultiPickerItem,
): ReviewApprovalRepository {
  return { id: String(item.id), fullName: item.fullName };
}

export interface CodeReviewApprovalsSectionProps {
  readonly owner: ReviewApprovalOwner;
}

export function CodeReviewApprovalsSection({
  owner,
}: CodeReviewApprovalsSectionProps): JSX.Element | null {
  const brand = useSettingsBrand();
  const { blockClassName } = useSettingsPrivacy();
  const controller = useReviewApprovalPolicy(owner);
  const toggleId = useId();
  const scoreId = useId();
  const {
    status,
    available,
    policy,
    scopeLabel,
    saving,
    loadError,
    saveError,
  } = controller;

  if (status === 'loading') return null;
  if (status === 'error' || policy === null) {
    return (
      <section
        className="flex flex-col gap-3"
        data-testid="code-review-approvals-section"
      >
        <Heading level={3} variant="section">
          Code reviews
        </Heading>
        <Notice
          intent="attention"
          actions={
            <Button
              size="compact"
              variant="secondary"
              onClick={controller.reload}
              data-testid="code-review-approvals-reload"
            >
              Try again
            </Button>
          }
        >
          {loadError?.copy}
        </Notice>
      </section>
    );
  }
  if (!available || scopeLabel === null) return null;

  const login = (
    <span className={blockClassName || undefined}>@{scopeLabel}</span>
  );
  const scopeNote =
    owner.kind === 'organization' ? (
      <>Applies to repositories the app can access in {login}.</>
    ) : (
      <>
        Applies to repositories on your GitHub account, {login}. Repositories in
        GitHub organizations follow that organization&apos;s setting.
      </>
    );
  const selected = policy.repositories;

  return (
    <section
      className="flex flex-col gap-3"
      data-testid="code-review-approvals-section"
      aria-busy={saving}
    >
      <Heading level={3} variant="section">
        Code reviews
      </Heading>
      <SettingsRowsGroup ariaLabel="Code reviews">
        <SettingsRowsRow
          label="AI review approvals"
          htmlFor={toggleId}
          dataTestId="code-review-approvals-toggle-row"
          // The neutral description: that App approvals count toward
          // required reviews is unverified (plan Step 3), so it makes no
          // claim about branch protection.
          description={`Adds an approving review from ${brand.displayName} when a code review passes.`}
          control={
            <ToggleSwitch
              id={toggleId}
              label="AI review approvals"
              checked={policy.enabled}
              onChange={(enabled): void => controller.update({ enabled })}
              dataTestId="code-review-approvals-toggle"
            />
          }
        >
          {policy.enabled ? (
            <div
              className="flex flex-col gap-3 pl-4"
              data-testid="code-review-approvals-details"
            >
              <p
                className="text-xs text-pretty fg-secondary"
                data-testid="code-review-approvals-scope-note"
              >
                {scopeNote}
              </p>
              <SettingsRowsSubRow
                label="Minimum score"
                htmlFor={scoreId}
                description="The review must also be complete and cover the latest commit."
                control={
                  <SettingsSelect
                    id={scoreId}
                    aria-label="Minimum score"
                    options={MIN_SCORE_OPTIONS}
                    value={String(policy.minScore)}
                    onValueChange={(value): void =>
                      controller.update({ minScore: Number(value) })
                    }
                    data-testid="code-review-approvals-min-score"
                  />
                }
              />
              <SettingsRowsSubRow
                label="Repositories"
                control={
                  <SegmentedControl
                    label="Repositories"
                    semantics="toggle"
                    value={policy.repoScope}
                    options={SCOPE_OPTIONS}
                    onChange={(repoScope): void =>
                      controller.update({ repoScope })
                    }
                    dataTestId="code-review-approvals-scope"
                  />
                }
              />
              {policy.repoScope === 'selected' ? (
                <div className="flex flex-col gap-3">
                  {selected.length === 0 ? (
                    <div data-testid="code-review-approvals-empty">
                      <Notice>
                        No repositories selected, so nothing will be approved.
                      </Notice>
                    </div>
                  ) : (
                    <ul
                      className="flex flex-col gap-2"
                      aria-label="Selected repositories"
                      data-testid="code-review-approvals-selected"
                    >
                      {selected.map((repository) => (
                        <li
                          key={repository.id}
                          className="flex items-center justify-between gap-3 text-s"
                          data-testid={`code-review-approvals-selected-${repository.id}`}
                        >
                          <span
                            className={`min-w-0 break-words fg-primary ${blockClassName}`.trim()}
                          >
                            {repository.fullName}
                          </span>
                          <Button
                            size="compact"
                            variant="secondary"
                            aria-label={`Remove ${repository.fullName}`}
                            onClick={(): void =>
                              controller.update({
                                repositories: selected.filter(
                                  (entry) => entry.id !== repository.id,
                                ),
                              })
                            }
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <GitHubRepositoryMultiPicker
                    listRepositories={controller.listRepositories}
                    selected={selected.map(pickerItem)}
                    onSelectionChange={(items): void =>
                      controller.update({
                        repositories: items.map(policyRepository),
                      })
                    }
                    disabled={false}
                    maxSelected={REVIEW_APPROVAL_MAX_REPOSITORIES}
                    errorScope={REVIEW_APPROVALS_ERROR_SCOPE}
                    knownErrors={REVIEW_APPROVALS_KNOWN_ERRORS}
                    testIdPrefix="code-review-approvals-repo"
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </SettingsRowsRow>
      </SettingsRowsGroup>
      {saveError ? (
        <ErrorBanner
          errorSource="code-review-approvals-save"
          error={saveError.copy}
          details={saveError.details}
          testId="code-review-approvals-save-error"
          onRetry={controller.retrySave}
        />
      ) : null}
    </section>
  );
}
