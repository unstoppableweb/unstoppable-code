import { Badge } from '@canopy/ui-shared/components/Badge';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { useLinearAvailability } from '@/hooks/useLinearStatus';
import { useContextScopedWorkspaces } from '@/hooks/useContextScopedWorkspaces';
import { useWorkspaceContextReset } from '@/hooks/useWorkspaceContextReset';
import { DialogModal } from '../shared/DialogModal';
import { LoadingSpinner } from '../shared/loading';
import type {
  BranchEntry,
  LinearTicketSearchResult,
  ResolvePullRequestResponse,
} from '@canopy/desktop-shared/types';
import { parsePullRequestReference } from '@canopy/protocol/portable-tasks/pull-request-reference';
import type { CreateFromMode } from '@canopy/desktop-shared/lib/create-from-reference';
import {
  buildLinearTaskText,
  createOptionsForBranch,
  createOptionsForLinear,
  createOptionsForPr,
  isWorkspaceEligibleForCreateFrom,
  replaceGeneratedTaskText,
  resolveCreateFromReferenceInput,
  type CreateFromOptions,
} from '@/lib/createFromSource';
import {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  getBranchProvenanceBadge,
  type BranchOption,
} from './branch-options';
import { ChatIcon, PipelineIcon, PlanModeIcon } from '@canopy/ui-shared/icons';
import {
  Stack,
  Button,
  DelayedLoadingPlaceholder,
  DialogFormField,
  ListRow,
  SearchField,
  SegmentedControl,
  type SegmentedControlOption,
  Skeleton,
  Surface,
  TextArea,
  TextInput,
  WordBoundaryTruncatedText,
} from '@canopy/ui-shared/components';
import { WorkspaceDropdown } from '../shared/WorkspaceDropdown';
import { useSettingsLocationLabel } from '@/lib/navigation/settings-destinations';

interface CreateTaskModalProps {
  initialWorkspaceId?: string;
  onClose: () => void;
  onChooseChat: (
    workspaceId: string,
    taskText: string,
    createOptions?: CreateFromOptions,
  ) => void;
  onChoosePlan: (
    workspaceId: string,
    taskText: string,
    createOptions?: CreateFromOptions,
  ) => void;
  onChoosePipeline: (
    workspaceId: string,
    taskText: string,
    createOptions?: CreateFromOptions,
  ) => void;
}

const SEARCH_DEBOUNCE_MS = 300;

interface CreateFromControlProps {
  mode: CreateFromMode;
  linearAvailable: boolean;
  onChange: (mode: CreateFromMode) => void;
}

function CreateFromControl({
  mode,
  linearAvailable,
  onChange,
}: CreateFromControlProps): JSX.Element {
  const linearSettingsLocation = useSettingsLocationLabel('integrations');
  const options: readonly SegmentedControlOption<CreateFromMode>[] = [
    { value: 'new', label: 'New', dataTestId: 'create-task-mode-new' },
    { value: 'branch', label: 'Branch', dataTestId: 'create-task-mode-branch' },
    { value: 'pr', label: 'PR', dataTestId: 'create-task-mode-pr' },
    {
      value: 'linear',
      label: 'Linear',
      dataTestId: 'create-task-mode-linear',
      unavailable: !linearAvailable,
      tooltip: linearAvailable
        ? undefined
        : `Linear tasks require an API key. Add one in ${linearSettingsLocation}.`,
    },
  ];

  return (
    <div className="flex flex-col items-start gap-1.5">
      <span className="block text-xs fg-secondary">Create from</span>
      <SegmentedControl<CreateFromMode>
        label="Create from"
        value={mode}
        options={options}
        onChange={onChange}
        width="content"
        shape="capsule"
      />
    </div>
  );
}

interface LinearTicketCardProps {
  ticket: LinearTicketSearchResult;
  onClear: () => void;
}

function LinearTicketCard({
  ticket,
  onClear,
}: LinearTicketCardProps): JSX.Element {
  const description = ticket.description?.trim() ?? '';
  return (
    <Surface variant="inset" padding="compact">
      <div className="flex items-start gap-2">
        <Stack gap="inline" className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Badge>
              <span className="font-mono">{ticket.identifier}</span>
            </Badge>
            <span className="min-w-0 flex-1 text-s font-medium fg-primary">
              <WordBoundaryTruncatedText
                text={ticket.title}
                hoverTitle
                className="block"
              />
            </span>
          </div>
          {description.length > 0 && (
            <p className="line-clamp-6 whitespace-pre-wrap text-xs fg-secondary">
              {description}
            </p>
          )}
          <a
            href={ticket.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block break-all text-xs fg-info hover:underline"
          >
            {ticket.url}
          </a>
        </Stack>
        <Button size="compact" onClick={onClear}>
          Change ticket
        </Button>
      </div>
    </Surface>
  );
}

interface LinearSearchProps {
  query: string;
  onQueryChange: (value: string) => void;
  results: LinearTicketSearchResult[];
  searching: boolean;
  /** The last search failed; its results are not a "no match". */
  error: InlineFailure | null;
  onRetry: () => void;
  onSelect: (ticket: LinearTicketSearchResult) => void;
}

function LinearSearch({
  query,
  onQueryChange,
  results,
  searching,
  error,
  onRetry,
  onSelect,
}: LinearSearchProps): JSX.Element {
  const trimmedQuery = query.trim();
  let dropdownContent: JSX.Element | null = null;
  if (trimmedQuery.length > 0) {
    if (searching) {
      dropdownContent = (
        <div
          className="flex items-center justify-center px-3 py-3 fg-secondary"
          data-testid="create-task-linear-searching"
        >
          <LoadingSpinner />
        </div>
      );
    } else if (error) {
      dropdownContent = null;
    } else if (results.length === 0) {
      dropdownContent = (
        <p className="px-3 py-2 text-xs fg-secondary">No matching tickets</p>
      );
    } else {
      dropdownContent = (
        <ul className="p-1">
          {results.map((ticket) => {
            const description = ticket.description?.trim() ?? '';
            return (
              <li key={ticket.id}>
                <ListRow
                  onClick={() => onSelect(ticket)}
                  data-testid={`create-task-linear-result-${ticket.id}`}
                  description={description.length > 0 ? description : undefined}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs fg-secondary">
                      {ticket.identifier}
                    </span>
                    <WordBoundaryTruncatedText
                      text={ticket.title}
                      hoverTitle
                      className="block min-w-0 flex-1"
                    />
                  </span>
                </ListRow>
              </li>
            );
          })}
        </ul>
      );
    }
  }

  return (
    <Stack gap="inline">
      <SearchField
        value={query}
        onValueChange={onQueryChange}
        aria-label="Search Linear"
        placeholder="Search Linear by id or title…"
        data-testid="create-task-linear-search"
      />
      {dropdownContent && (
        <Surface variant="inset" className="overflow-hidden">
          <div className="max-h-64 overflow-y-auto">{dropdownContent}</div>
        </Surface>
      )}
      {trimmedQuery.length > 0 && !searching && (
        <DesktopErrorBanner
          errorSource="create-task-linear-search-error"
          className=""
          error={error?.error}
          details={error?.details}
          onRetry={onRetry}
          testId="create-task-linear-search-error"
        />
      )}
    </Stack>
  );
}

interface BranchResultsProps {
  loading: boolean;
  error: InlineFailure | null;
  onRetry: () => void;
  options: BranchOption[];
  onSelect: (name: string) => void;
}

/** Plain branches the loading skeleton lays out as the result list. */
const SAMPLE_BRANCH_OPTIONS: BranchOption[] = [
  {
    name: 'main',
    isRemote: false,
    isCurrent: true,
    isUsedByWorktree: false,
    hasLocalRef: true,
    hasRemoteRef: true,
  },
  {
    name: 'fix/checkout-retry',
    isRemote: false,
    isCurrent: false,
    isUsedByWorktree: false,
    hasLocalRef: true,
    hasRemoteRef: true,
  },
  {
    name: 'feature/release-notes',
    isRemote: false,
    isCurrent: false,
    isUsedByWorktree: false,
    hasLocalRef: true,
    hasRemoteRef: true,
  },
];

const noop = (): void => undefined;

function BranchResultList({
  options,
  onSelect,
}: Pick<BranchResultsProps, 'options' | 'onSelect'>): JSX.Element {
  return (
    <Surface variant="inset" className="overflow-hidden">
      <ul className="max-h-64 overflow-y-auto p-1">
        {options.map((option) => {
          const badge = getBranchProvenanceBadge(option);
          return (
            <li key={option.name}>
              <ListRow
                onClick={() => onSelect(option.name)}
                data-testid={`create-from-branch-result-${option.name}`}
                trailing={badge || undefined}
              >
                <span className="font-mono">{option.name}</span>
              </ListRow>
            </li>
          );
        })}
      </ul>
    </Surface>
  );
}

function BranchResults({
  loading,
  error,
  onRetry,
  options,
  onSelect,
}: BranchResultsProps): JSX.Element {
  if (loading) {
    return (
      <DelayedLoadingPlaceholder slowNote="Still loading branches…">
        <Skeleton
          loading
          label="Loading branches"
          testId="create-from-branch-loading"
        >
          <BranchResultList options={SAMPLE_BRANCH_OPTIONS} onSelect={noop} />
        </Skeleton>
      </DelayedLoadingPlaceholder>
    );
  }
  if (error) {
    return (
      <DesktopErrorBanner
        errorSource="create-from-branch-error"
        className=""
        error={error.error}
        details={error.details}
        onRetry={onRetry}
        testId="create-from-branch-error"
      />
    );
  }
  if (options.length === 0) {
    return (
      <Surface variant="inset">
        <p className="px-3 py-2 text-xs fg-secondary">No matching branches</p>
      </Surface>
    );
  }
  return <BranchResultList options={options} onSelect={onSelect} />;
}

interface PrPreviewProps {
  resolving: boolean;
  error: InlineFailure | null;
  pr: ResolvePullRequestResponse | null;
}

function PrPreview({
  resolving,
  error,
  pr,
}: PrPreviewProps): JSX.Element | null {
  if (resolving) {
    return (
      <Surface variant="inset">
        <div className="flex items-center justify-center px-3 py-3 fg-secondary">
          <LoadingSpinner />
        </div>
      </Surface>
    );
  }
  if (error) {
    return (
      <DesktopErrorBanner
        errorSource="create-from-pr-error"
        className=""
        error={error.error}
        details={error.details}
        testId="create-from-pr-error"
      />
    );
  }
  if (!pr) {
    return null;
  }
  return (
    <Surface
      data-testid="create-from-pr-card"
      variant="inset"
      gap="inline"
      padding="compact"
    >
      <div className="flex items-center gap-2">
        <Badge>
          <span className="font-mono">#{pr.number}</span>
        </Badge>
        <span className="min-w-0 flex-1 truncate text-s font-medium fg-primary">
          {pr.title}
        </span>
      </div>
      <p className="text-xs fg-secondary">
        Checks out <span className="font-mono">{pr.headRefName}</span> (into{' '}
        <span className="font-mono">{pr.baseRefName}</span>)
      </p>
    </Surface>
  );
}

export function CreateTaskModal({
  initialWorkspaceId,
  onClose,
  onChooseChat,
  onChoosePlan,
  onChoosePipeline,
}: CreateTaskModalProps): JSX.Element {
  const { workspaces: projects } = useContextScopedWorkspaces();

  const eligibleWorkspaces = useMemo(
    () =>
      [...projects]
        .filter(isWorkspaceEligibleForCreateFrom)
        .sort((a, b) => a.order - b.order),
    [projects],
  );

  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(
    () => initialWorkspaceId ?? eligibleWorkspaces[0]?.id ?? '',
  );
  const [taskText, setTaskText] = useState('');
  const [mode, setMode] = useState<CreateFromMode>('new');
  const [referenceQuery, setReferenceQuery] = useState('');
  const [selectedTicket, setSelectedTicket] =
    useState<LinearTicketSearchResult | null>(null);
  const [searchResults, setSearchResults] = useState<
    LinearTicketSearchResult[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<InlineFailure | null>(null);
  // Bumped by Try again to repeat a failed search or branch load.
  const [searchAttempt, setSearchAttempt] = useState(0);
  const [branchTargetsAttempt, setBranchTargetsAttempt] = useState(0);
  const [branchTargetsError, setBranchTargetsError] =
    useState<InlineFailure | null>(null);
  const [branchTargets, setBranchTargets] = useState<BranchEntry[]>([]);
  const [branchTargetsLoading, setBranchTargetsLoading] = useState(false);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [resolvedPr, setResolvedPr] =
    useState<ResolvePullRequestResponse | null>(null);
  const [prResolving, setPrResolving] = useState(false);
  const [prError, setPrError] = useState<InlineFailure | null>(null);
  const [contextChanged, setContextChanged] = useState(false);
  const lastGeneratedTaskTextRef = useRef('');

  const { available: linearAvailable } = useLinearAvailability();

  useWorkspaceContextReset((): void => {
    setSelectedWorkspaceId('');
    setTaskText('');
    setMode('new');
    setReferenceQuery('');
    setSelectedTicket(null);
    setSearchResults([]);
    setSelectedBranch(null);
    setResolvedPr(null);
    setPrError(null);
    setContextChanged(true);
  });

  // Keep the selected workspace valid if the projects list changes while open.
  useEffect(() => {
    if (
      selectedWorkspaceId &&
      !eligibleWorkspaces.some((w) => w.id === selectedWorkspaceId)
    ) {
      setSelectedWorkspaceId(eligibleWorkspaces[0]?.id ?? '');
    } else if (!selectedWorkspaceId && eligibleWorkspaces.length > 0) {
      setSelectedWorkspaceId(eligibleWorkspaces[0].id);
    }
  }, [eligibleWorkspaces, selectedWorkspaceId]);

  // Debounced Linear search. A monotonically increasing sequence number
  // ensures that a slow earlier response cannot overwrite results from a
  // later query.
  const searchSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== 'linear') {
      return;
    }
    const trimmed = referenceQuery.trim();
    setSearchError(null);
    if (trimmed.length === 0) {
      // Skip the IPC call entirely when input is empty.
      searchSeqRef.current += 1;
      setSearching(false);
      setSearchResults([]);
      return;
    }

    const seq = ++searchSeqRef.current;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        let results: LinearTicketSearchResult[] = [];
        let failure: InlineFailure | null = null;
        try {
          results = await window.api.searchLinearIssues(trimmed);
        } catch (error) {
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            failure = inlineFailure(appError, "Couldn't search Linear.");
        }
        if (searchSeqRef.current !== seq) {
          return;
        }
        setSearchResults(results);
        setSearchError(failure);
        setSearching(false);
      })();
    }, SEARCH_DEBOUNCE_MS);

    return (): void => {
      searchSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [mode, referenceQuery, searchAttempt]);

  // Branch targets for the selected workspace power both the Branch-mode list
  // and the Linear existing-vs-new-branch decision.
  useEffect(() => {
    setSelectedBranch(null);
    setResolvedPr(null);
    setPrError(null);
    setBranchTargetsError(null);
    if (!selectedWorkspaceId) {
      setBranchTargets([]);
      setBranchTargetsLoading(false);
      return;
    }
    let cancelled = false;
    setBranchTargetsLoading(true);
    window.api
      .homeListBranchTargets({ workspaceId: selectedWorkspaceId })
      .then((response) => {
        if (cancelled) return;
        setBranchTargets(response.supported ? response.branches : []);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setBranchTargets([]);
        const appError = toAppError(resolveClientAppError(error));
        if (appError)
          setBranchTargetsError(
            inlineFailure(appError, "Couldn't load branches."),
          );
      })
      .finally(() => {
        if (!cancelled) setBranchTargetsLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [selectedWorkspaceId, branchTargetsAttempt]);

  // Debounced PR resolution with a sequence guard (mirrors the Linear search).
  const prSeqRef = useRef(0);
  useEffect(() => {
    if (mode !== 'pr') return;
    const seq = ++prSeqRef.current;
    setResolvedPr(null);
    setPrError(null);
    const parsed = parsePullRequestReference(referenceQuery);
    if (!parsed) {
      setPrResolving(false);
      return;
    }
    const workspace = eligibleWorkspaces.find(
      (candidate) => candidate.id === selectedWorkspaceId,
    );
    const repoPath =
      workspace?.type === 'single-repo'
        ? workspace.repoPath
        : workspace?.type === 'multi-repo'
          ? (workspace.sourceRepoPath ?? null)
          : null;
    if (!repoPath) {
      setPrError({
        error:
          'This project has no repository to resolve a pull request against.',
      });
      setPrResolving(false);
      return;
    }
    setPrResolving(true);
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const pr = await window.api.resolvePullRequest({
            repoPath,
            reference: referenceQuery.trim(),
          });
          if (prSeqRef.current !== seq) return;
          setResolvedPr(pr);
          setPrResolving(false);
          const previousGeneratedTaskText = lastGeneratedTaskTextRef.current;
          setTaskText((current) =>
            replaceGeneratedTaskText(
              current,
              previousGeneratedTaskText,
              pr.title,
            ),
          );
          lastGeneratedTaskTextRef.current = pr.title;
        } catch (error) {
          if (prSeqRef.current !== seq) return;
          setPrResolving(false);
          const appError = toAppError(resolveClientAppError(error));
          if (appError)
            setPrError(
              inlineFailure(appError, "Couldn't find that pull request."),
            );
        }
      })();
    }, SEARCH_DEBOUNCE_MS);
    // Bump the sequence in cleanup so any dispatched-but-unresolved IPC is
    // invalidated on mode switch, unmount, or dependency change — a late
    // response can no longer set resolvedPr/taskText after the user leaves PR
    // mode. Cleanup runs before the next effect invocation, so it also covers
    // the early-return paths.
    return (): void => {
      prSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [mode, referenceQuery, selectedWorkspaceId, eligibleWorkspaces]);

  const handleModeChange = (next: CreateFromMode): void => {
    // Per-mode selections are intentionally preserved so pill round-trips are
    // non-destructive (matches the previous Manual ↔ Linear behavior).
    setMode(next);
  };

  // Auto-detect the source from the typed/pasted reference and flip the pill.
  // This runs only from the branch/PR reference input's onChange, so Linear
  // search typing is naturally excluded and clicking a pill (no text change)
  // never re-triggers detection — making manual overrides stick.
  const handleReferenceQueryChange = (value: string): void => {
    const { detected, referenceQuery: nextReferenceQuery } =
      resolveCreateFromReferenceInput(value, linearAvailable);
    setReferenceQuery(nextReferenceQuery);
    if (!detected) {
      return;
    }
    if (detected.mode === 'linear' && linearAvailable) {
      setMode('linear');
      return;
    }
    if (detected.mode !== 'linear' && detected.mode !== mode) {
      setMode(detected.mode);
    }
  };

  const branchOptions = useMemo(() => {
    const available = branchTargets.filter(
      (entry) => !entry.isUsedByWorktree && !entry.isCurrent,
    );
    return filterBranchesBySearch(
      collapseBranchDuplicates(available),
      referenceQuery,
    ).slice(0, 50);
  }, [branchTargets, referenceQuery]);

  const trimmedText = taskText.trim();

  const createOptions = useMemo((): CreateFromOptions | undefined => {
    if (mode === 'branch' && selectedBranch) {
      return createOptionsForBranch(selectedBranch);
    }
    if (mode === 'pr' && resolvedPr) {
      return createOptionsForPr(resolvedPr);
    }
    if (mode === 'linear' && selectedTicket) {
      return createOptionsForLinear(selectedTicket);
    }
    return undefined;
  }, [mode, selectedBranch, resolvedPr, selectedTicket]);

  const effectiveTaskText = useMemo(() => {
    if (mode === 'linear' && selectedTicket && trimmedText.length === 0) {
      return buildLinearTaskText(selectedTicket);
    }
    return trimmedText;
  }, [mode, selectedTicket, trimmedText]);

  const canSubmit =
    Boolean(selectedWorkspaceId) &&
    (mode === 'new'
      ? trimmedText.length > 0
      : mode === 'branch'
        ? selectedBranch !== null
        : mode === 'pr'
          ? resolvedPr !== null
          : selectedTicket !== null);
  // Pipelines consume the task text (`task_ready`), so it must be non-empty.
  const canSubmitPipeline = canSubmit && effectiveTaskText.length > 0;

  const handleChat = (): void => {
    if (!canSubmit) return;
    onChooseChat(selectedWorkspaceId, effectiveTaskText, createOptions);
  };

  const handlePlan = (): void => {
    if (!canSubmit) return;
    onChoosePlan(selectedWorkspaceId, effectiveTaskText, createOptions);
  };

  const handlePipeline = (): void => {
    if (!canSubmitPipeline) return;
    onChoosePipeline(selectedWorkspaceId, effectiveTaskText, createOptions);
  };

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title="Create task"
      subtitle="Describe the task and choose how to start work"
      titleId="create-task-title"
      maxWidth="lg"
      dataTestId="create-task-modal"
    >
      <div className="flex flex-col flex-1 overflow-y-auto px-6 py-4 text-s gap-4 [&>*]:shrink-0">
        {eligibleWorkspaces.length === 0 ? (
          <Surface variant="dashed" padding="default">
            <div className="text-s fg-secondary">
              No eligible projects available. Add a single-repo project or
              attach a source repository to a multi-repo project to create a
              task.
            </div>
          </Surface>
        ) : (
          <>
            {contextChanged && (
              <Surface variant="outline" size="small">
                <p
                  className="px-3 py-2 text-xs fg-secondary"
                  role="status"
                  data-testid="create-task-context-changed"
                >
                  The project and task draft were reset for the selected
                  context.
                </p>
              </Surface>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="block text-xs fg-secondary">Project</span>
              <WorkspaceDropdown
                workspaces={eligibleWorkspaces}
                selectedWorkspaceId={selectedWorkspaceId}
                onSelect={setSelectedWorkspaceId}
                testIdPrefix="create-task-workspace"
              />
            </div>

            <CreateFromControl
              mode={mode}
              linearAvailable={linearAvailable}
              onChange={handleModeChange}
            />

            {mode !== 'new' && mode !== 'linear' && (
              <Stack gap="inline">
                <TextInput
                  type="text"
                  value={referenceQuery}
                  onChange={(event) =>
                    handleReferenceQueryChange(event.target.value)
                  }
                  placeholder="Paste a branch, PR link/#, or Linear issue…"
                  data-testid="create-from-reference-input"
                  aria-label="Branch, PR, or Linear reference"
                />
                {mode === 'branch' &&
                  (selectedBranch ? (
                    <Surface
                      variant="inset"
                      padding="compact"
                      data-testid="create-from-branch-selected"
                    >
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-s fg-primary">
                          {selectedBranch}
                        </span>
                        <Button
                          size="compact"
                          onClick={() => setSelectedBranch(null)}
                        >
                          Change branch
                        </Button>
                      </div>
                    </Surface>
                  ) : (
                    <BranchResults
                      loading={branchTargetsLoading}
                      error={branchTargetsError}
                      onRetry={() => setBranchTargetsAttempt((n) => n + 1)}
                      options={branchOptions}
                      onSelect={setSelectedBranch}
                    />
                  ))}
                {mode === 'pr' && (
                  <PrPreview
                    resolving={prResolving}
                    error={prError}
                    pr={resolvedPr}
                  />
                )}
              </Stack>
            )}

            {mode === 'linear' && (
              <div className="flex flex-col gap-1.5">
                <span className="block text-xs fg-secondary">
                  Linear ticket
                </span>
                {selectedTicket ? (
                  <LinearTicketCard
                    ticket={selectedTicket}
                    onClear={() => setSelectedTicket(null)}
                  />
                ) : (
                  <LinearSearch
                    query={referenceQuery}
                    onQueryChange={setReferenceQuery}
                    results={searchResults}
                    searching={searching}
                    error={searchError}
                    onRetry={() => setSearchAttempt((n) => n + 1)}
                    onSelect={(ticket) => {
                      setSelectedTicket(ticket);
                      const generatedTaskText = buildLinearTaskText(ticket);
                      const previousGeneratedTaskText =
                        lastGeneratedTaskTextRef.current;
                      setTaskText((current) =>
                        replaceGeneratedTaskText(
                          current,
                          previousGeneratedTaskText,
                          generatedTaskText,
                        ),
                      );
                      lastGeneratedTaskTextRef.current = generatedTaskText;
                    }}
                  />
                )}
              </div>
            )}

            <DialogFormField
              label={
                mode === 'new'
                  ? 'Task description'
                  : 'Task description (optional)'
              }
              htmlFor="create-task-text"
            >
              <TextArea
                id="create-task-text"
                value={taskText}
                onChange={(event) => setTaskText(event.target.value)}
                placeholder="Describe the task in natural language…"
                rows={mode === 'new' ? 6 : 3}
                data-testid="create-task-text"
              />
            </DialogFormField>
          </>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-6 py-3">
        <Button size="compact" onClick={onClose}>
          Cancel
        </Button>
        <Button
          size="compact"
          onClick={handlePipeline}
          disabled={!canSubmitPipeline}
          data-testid="create-task-pipeline-button"
        >
          <PipelineIcon size="sm" />
          Workflow
        </Button>
        <Button
          size="compact"
          onClick={handlePlan}
          disabled={!canSubmit}
          data-testid="create-task-plan-button"
        >
          <PlanModeIcon size="sm" />
          Plan
        </Button>
        <Button
          variant="primary"
          size="compact"
          onClick={handleChat}
          disabled={!canSubmit}
          data-testid="create-task-chat-button"
        >
          <ChatIcon size="sm" />
          Chat
        </Button>
      </div>
    </DialogModal>
  );
}
