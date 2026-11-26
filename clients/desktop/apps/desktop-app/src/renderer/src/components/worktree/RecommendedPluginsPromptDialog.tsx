import { Badge } from '@canopy/ui-shared/primitives/Badge';
import { Stack, Button, Heading, Surface } from '@canopy/ui-shared/components';
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type {
  RecommendedPluginApplyResult,
  RecommendedPluginItem,
} from '@canopy/desktop-shared/types';
import { DialogModal } from '../shared';
import {
  useProjectsStore,
  type PendingRecommendedPluginPrompt,
} from '@/stores/projectsStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { pipelinePackageRequirementKindLabel } from '@canopy/ui-shared/lib/pipeline-package-display';
import { Checkbox, ErrorBanner } from '@canopy/ui-shared/components';
import { OrganizationRecommendationList } from './OrganizationRecommendationList';

interface RecommendedPluginsPromptDialogProps {
  prompt: PendingRecommendedPluginPrompt;
}

/**
 * Per-row UI status. Combines "what will happen if applied" with terminal
 * "what happened" labels so the dialog can render a single label per row.
 */
type RowStatus =
  | { state: 'pending-select' }
  | { state: 'pending-install-and-select' }
  | { state: 'installing' }
  | { state: 'selected' }
  | { state: 'installed-and-selected' }
  | { state: 'error'; message: string };

interface ActionableEntry {
  item: RecommendedPluginItem;
}

function isActionable(item: RecommendedPluginItem): boolean {
  return item.action === 'select' || item.action === 'install-and-select';
}

function pendingLabelForItem(item: RecommendedPluginItem): RowStatus {
  if (item.action === 'select') {
    return { state: 'pending-select' };
  }
  return { state: 'pending-install-and-select' };
}

function describeStatus(status: RowStatus): string {
  switch (status.state) {
    case 'pending-select':
      return 'Will select by default';
    case 'pending-install-and-select':
      return 'Will install and select by default';
    case 'installing':
      return 'Installing…';
    case 'selected':
      return 'Selected';
    case 'installed-and-selected':
      return 'Installed and selected';
    case 'error':
      return `Failed: ${status.message}`;
  }
}

const TERMINAL_STATES: ReadonlySet<RowStatus['state']> = new Set<
  RowStatus['state']
>(['selected', 'installed-and-selected', 'error']);

/**
 * Post-create / scope-change recommendation prompt for source-controlled
 * `canopy.json.plugins` recommendations. The dialog is mounted globally by
 * `WorktreeManager` whenever `pendingRecommendedPluginPrompt` is non-null;
 * dismissing or applying clears that store field via the corresponding
 * actions.
 */
export function RecommendedPluginsPromptDialog({
  prompt,
}: RecommendedPluginsPromptDialogProps): JSX.Element {
  // A prompt for another scope starts fresh: rows decided in one project's
  // prompt never hide another's, and work still running for the old one
  // can't reach the new one (CAN-6241).
  return <PromptDialog key={promptIdentity(prompt)} prompt={prompt} />;
}

function promptIdentity(prompt: PendingRecommendedPluginPrompt): string {
  return [
    prompt.projectId,
    prompt.worktreeId,
    prompt.repoId ?? '',
    prompt.organization?.setupProjectId ?? '',
  ].join('\n');
}

function PromptDialog({
  prompt,
}: RecommendedPluginsPromptDialogProps): JSX.Element {
  const applyRecommendedPlugins = useProjectsStore(
    (state) => state.applyRecommendedPlugins,
  );
  const dismissPendingRecommendedPluginPrompt = useProjectsStore(
    (state) => state.dismissPendingRecommendedPluginPrompt,
  );
  const openSettings = useNavigationStore((state) => state.openSettings);
  const openPluginsNavigation = useNavigationStore(
    (state) => state.openPluginsNavigation,
  );

  const actionable = useMemo<ActionableEntry[]>(
    () => prompt.items.filter(isActionable).map((item) => ({ item })),
    [prompt.items],
  );
  const informational = useMemo(
    () => prompt.items.filter((item) => !isActionable(item)),
    [prompt.items],
  );

  // Default every actionable row checked. Most users want the full set.
  const [checked, setChecked] = useState<Set<string>>(() => {
    const next = new Set<string>();
    for (const entry of actionable) {
      next.add(entry.item.key);
    }
    return next;
  });
  // Re-seed checked when the prompt items change (e.g., re-inspection after
  // a partial failure replaces the prompt with the latest state).
  useEffect(() => {
    setChecked(() => {
      const next = new Set<string>();
      for (const entry of actionable) {
        next.add(entry.item.key);
      }
      return next;
    });
  }, [actionable]);

  // An organization project's recommendations are decided for everyone
  // (CAN-6241); the rows leave as each is added or dismissed.
  const [decidedKeys, setDecidedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const organizationItems = useMemo(
    () => prompt.items.filter((item) => !decidedKeys.has(item.key)),
    [prompt.items, decidedKeys],
  );
  /**
   * Set when a decision found the person can no longer change the project's
   * setup: the rows go, and the dialog stays open so the message is read.
   */
  const [lostAccess, setLostAccess] = useState<string | null>(null);
  useEffect(() => {
    if (
      prompt.organization &&
      lostAccess === null &&
      organizationItems.length === 0 &&
      prompt.requirements.length === 0
    )
      dismissPendingRecommendedPluginPrompt();
  }, [
    lostAccess,
    prompt.organization,
    organizationItems.length,
    prompt.requirements.length,
    dismissPendingRecommendedPluginPrompt,
  ]);

  const [rowStatuses, setRowStatuses] = useState<Record<string, RowStatus>>({});
  const [applying, setApplying] = useState(false);
  const [hasErrors, setHasErrors] = useState(false);

  const handleDismissClose = useCallback((): void => {
    if (applying) {
      return;
    }
    dismissPendingRecommendedPluginPrompt({ remember: true });
  }, [applying, dismissPendingRecommendedPluginPrompt]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' && !applying) {
        handleDismissClose();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return (): void => document.removeEventListener('keydown', onKeyDown);
  }, [handleDismissClose, applying]);

  function toggleChecked(key: string): void {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  const checkedCount = useMemo(
    () =>
      actionable.reduce(
        (count, entry) => (checked.has(entry.item.key) ? count + 1 : count),
        0,
      ),
    [actionable, checked],
  );

  const allChecked = checkedCount === actionable.length;
  const noneChecked = checkedCount === 0;

  async function runApply(opts: { skip: boolean }): Promise<void> {
    if (applying) {
      return;
    }
    const { skip } = opts;
    const selectedKeys: string[] = [];
    const optOutKeys: string[] = [];
    for (const entry of actionable) {
      if (!skip && checked.has(entry.item.key)) {
        selectedKeys.push(entry.item.key);
      } else {
        optOutKeys.push(entry.item.key);
      }
    }

    setApplying(true);
    setHasErrors(false);

    // Mark all selected rows as installing/selecting up front so the dialog
    // gives immediate feedback. Rows that aren't in `selectedKeys` are left
    // untouched (their status reflects the prior render).
    setRowStatuses((current) => {
      const next: Record<string, RowStatus> = { ...current };
      for (const entry of actionable) {
        if (!selectedKeys.includes(entry.item.key)) {
          continue;
        }
        next[entry.item.key] =
          entry.item.action === 'install-and-select'
            ? { state: 'installing' }
            : { state: 'selected' };
      }
      return next;
    });

    let results: RecommendedPluginApplyResult[] = [];
    try {
      const response = await applyRecommendedPlugins({
        projectId: prompt.projectId,
        worktreeId: prompt.worktreeId,
        repoId: prompt.repoId,
        selectedKeys,
        optOutKeys,
        dismissPromptOnSuccess: true,
      });
      results = response.results;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRowStatuses((current) => {
        const next: Record<string, RowStatus> = { ...current };
        for (const key of selectedKeys) {
          next[key] = { state: 'error', message };
        }
        return next;
      });
      setHasErrors(true);
      setApplying(false);
      return;
    }

    let nextHasErrors = false;
    setRowStatuses((current) => {
      const next: Record<string, RowStatus> = { ...current };
      for (const result of results) {
        if (result.status === 'installed-and-selected') {
          next[result.key] = { state: 'installed-and-selected' };
        } else if (result.status === 'selected') {
          next[result.key] = { state: 'selected' };
        } else if (result.status === 'error') {
          nextHasErrors = true;
          next[result.key] = {
            state: 'error',
            message: result.message ?? 'Failed to apply recommendation.',
          };
        }
      }
      return next;
    });
    setHasErrors(nextHasErrors);
    setApplying(false);
  }

  function handleAskMeLater(): void {
    handleDismissClose();
  }

  const primaryLabel = applying
    ? 'Applying…'
    : hasErrors
      ? 'Try again'
      : noneChecked
        ? 'Skip recommendations'
        : 'Apply selected';

  return (
    <DialogModal
      onClose={(): void => {
        handleDismissClose();
      }}
      title="Recommended plugins"
      subtitle={prompt.scopeLabel}
      titleId="recommended-plugins-prompt-dialog-title"
      maxWidth="2xl"
      closeOnBackdrop={!applying}
    >
      <div className="flex flex-col gap-4 text-s fg-primary">
        {prompt.organization ? (
          lostAccess !== null ? (
            <ErrorBanner
              errorSource="organization-recommendations-access"
              testId="organization-recommendations-lost-access"
              className=""
              error={lostAccess}
            />
          ) : (
            organizationItems.length > 0 && (
              <OrganizationRecommendationList
                setupProjectId={prompt.organization.setupProjectId}
                items={organizationItems}
                onDecided={(keys) =>
                  setDecidedKeys((current) => new Set([...current, ...keys]))
                }
                onLostAccess={setLostAccess}
              />
            )
          )
        ) : (
          <p className="text-xs fg-secondary">
            This project&apos;s canopy.json recommends plugins or skills that
            are not installed or selected as project defaults. Keep items
            checked to install/select them by default. Unchecked items will not
            be suggested again for this project.
          </p>
        )}

        {!prompt.organization && actionable.length > 0 && (
          <Surface variant="outline">
            <ul className="divide-y">
              {actionable.map((entry) => {
                const { item } = entry;
                const status: RowStatus =
                  rowStatuses[item.key] ?? pendingLabelForItem(item);
                const isChecked = checked.has(item.key);
                const checkboxDisabled =
                  applying || TERMINAL_STATES.has(status.state);
                return (
                  <li
                    key={item.key}
                    className="flex items-start gap-3 p-3 text-xs"
                  >
                    <Checkbox
                      checked={isChecked}
                      disabled={checkboxDisabled}
                      onChange={(): void => toggleChecked(item.key)}
                      className="mt-0.5"
                      aria-label={`Apply ${item.displayName}`}
                    />
                    <Stack gap="tight" className="min-w-0 flex-1">
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium fg-primary">
                            {item.displayName}
                          </span>
                          <Badge>
                            {item.kind === 'claude_plugin'
                              ? 'plugin'
                              : item.kind}
                          </Badge>
                        </div>
                        <div className="fg-secondary">{item.displaySource}</div>
                      </div>
                      <div
                        className={`text-2xs ${
                          status.state === 'error'
                            ? 'fg-destructive-strong'
                            : status.state === 'selected' ||
                                status.state === 'installed-and-selected'
                              ? 'fg-success-strong'
                              : 'fg-secondary'
                        }`}
                      >
                        {describeStatus(status)}
                      </div>
                    </Stack>
                  </li>
                );
              })}
            </ul>
          </Surface>
        )}

        {!prompt.organization && informational.length > 0 && (
          <div className="flex flex-col gap-2">
            <div className="text-2xs font-medium fg-secondary">
              Already configured
            </div>
            <Surface variant="outline">
              <ul className="divide-y">
                {informational.map((item) => (
                  <li key={item.key} className="p-3 text-xs">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium fg-primary">
                          {item.displayName}
                        </span>
                        <Badge>
                          {item.kind === 'claude_plugin' ? 'plugin' : item.kind}
                        </Badge>
                      </div>
                      <div className="fg-secondary">{item.displaySource}</div>
                    </div>
                  </li>
                ))}
              </ul>
            </Surface>
          </div>
        )}

        {prompt.requirements.length > 0 && (
          <Surface
            gap="item"
            as="section"
            variant="outline"
            padding="compact"
            data-testid="recommended-plugin-requirements"
          >
            <Stack gap="inline">
              <Heading level={3} variant="title">
                Environment setup
              </Heading>
              <ul className="flex flex-col gap-2">
                {prompt.requirements.map((requirement) => (
                  <li
                    key={requirement.id}
                    className="flex items-start justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium fg-primary">
                          {requirement.displayName}
                        </span>
                        <span className="fg-secondary">
                          {pipelinePackageRequirementKindLabel(
                            requirement.kind,
                          )}
                        </span>
                        <Badge>
                          {requirement.status === 'available'
                            ? 'Available'
                            : requirement.status === 'missing'
                              ? 'Needs setup'
                              : 'Unknown'}
                        </Badge>
                      </div>
                      <p className="mt-0.5 fg-secondary">
                        {requirement.detail ?? requirement.setupHint}
                      </p>
                    </div>
                    {requirement.status !== 'available' &&
                      (requirement.kind === 'mcp' ||
                        requirement.kind === 'connector') && (
                        <Button
                          size="compact"
                          data-testid={`recommended-plugin-requirement-setup-${requirement.id}`}
                          onClick={() =>
                            openPluginsNavigation({
                              kind: 'entry-detail',
                              entryId:
                                requirement.kind === 'mcp'
                                  ? `mcp-catalog:${requirement.displayName}`
                                  : `provider-connector:${requirement.displayName}`,
                            })
                          }
                        >
                          Set up
                        </Button>
                      )}
                  </li>
                ))}
              </ul>
              {prompt.requirements.some(
                (requirement) =>
                  requirement.status !== 'available' &&
                  requirement.kind !== 'mcp' &&
                  requirement.kind !== 'connector',
              ) && (
                <Button
                  className="self-start"
                  size="compact"
                  onClick={() => openSettings('environment')}
                >
                  Open environment setup
                </Button>
              )}
              <p className="text-2xs fg-secondary">
                Missing setup does not block applying recommendations.
              </p>
            </Stack>
          </Surface>
        )}

        <div className="flex items-center justify-between gap-2">
          <div className="text-2xs fg-secondary">
            {prompt.organization
              ? null
              : actionable.length === 0
                ? 'No recommendations need action'
                : allChecked
                  ? `${checkedCount} of ${actionable.length} selected`
                  : noneChecked
                    ? `0 of ${actionable.length} selected`
                    : `${checkedCount} of ${actionable.length} selected`}
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="compact"
              onClick={handleAskMeLater}
              disabled={applying}
            >
              Ask me later
            </Button>
            {!prompt.organization && actionable.length > 0 && (
              <Button
                variant="primary"
                size="compact"
                onClick={(): void => {
                  void runApply({ skip: noneChecked });
                }}
                disabled={applying}
              >
                {primaryLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </DialogModal>
  );
}
