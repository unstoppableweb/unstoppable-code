import { hasExactWorktreeBaseCatalogue } from '@/lib/remote-control/worktree-base-availability';
import { resolveClientAppError } from '@canopy/desktop-instrumentation/client';
import { toAppError } from '@canopy/protocol/app-errors';
import {
  Surface,
  Stack,
  Button,
  FloatingMenu,
  ListRow,
} from '@canopy/ui-shared/components';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from 'react';
import { refreshCheckoutBranches } from '@/lib/refresh-checkout-branches';
import { showBranchCheckoutWarning } from '@/lib/branch-checkout-warning';
import { DesktopErrorBanner } from '@/components/shared/DesktopErrorBanner';
import { inlineFailure, type InlineFailure } from '@/lib/inline-app-error';
import type {
  BranchEntry,
  ListBranchesResponse,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  getBranchProvenanceBadge,
  type BranchOption,
} from './branch-options';
import { resolveBranchPickerBaseSelection } from './branch-picker-base-selection';
import { Tooltip } from '@canopy/ui-shared';
import {
  FormField,
  SearchField,
  TextInput,
} from '@canopy/ui-shared/components';
import {
  PlusIcon as AppCatalogPlusIcon,
  ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { Badge } from '@canopy/ui-shared/components';

interface BranchPickerProps {
  projectId: string;
  worktreeId: string;
  repoId?: string;
  baseBranch?: string | null;
  onBranchSwitched: () => void;
  onClose: () => void;
}

type PickerView = 'list' | 'create';

export function BranchPicker({
  projectId,
  worktreeId,
  repoId,
  baseBranch,
  onBranchSwitched,
  onClose,
}: BranchPickerProps): JSX.Element {
  const [view, setView] = useState<PickerView>('list');
  const [catalogue, setCatalogue] = useState<ListBranchesResponse | null>(null);
  const branches = useMemo(() => catalogue?.branches ?? [], [catalogue]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<InlineFailure | null>(null);
  const [loadError, setLoadError] = useState<InlineFailure | null>(null);
  // Bumped by Try again on a failed branch load to fetch the list again.
  const [loadAttempt, setLoadAttempt] = useState(0);
  const refreshPending = useRef(false);
  const [search, setSearch] = useState('');
  const [switching, setSwitching] = useState<string | null>(null);

  // Create branch state
  const [newBranchName, setNewBranchName] = useState('');
  const [newBaseBranch, setNewBaseBranch] = useState('');
  const [newBaseBranchIsRemote, setNewBaseBranchIsRemote] = useState(false);
  const exactCatalogue = hasExactWorktreeBaseCatalogue(catalogue);
  const [newBaseBranchSource, setNewBaseBranchSource] = useState<
    'catalog' | undefined
  >();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<InlineFailure | null>(null);
  const unconfirmedCreate = useRef<{
    branchName: string;
    error: InlineFailure | null;
  } | null>(null);
  const [showBasePicker, setShowBasePicker] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const newBranchInputRef = useRef<HTMLInputElement>(null);
  const baseBranchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const consumeCreateDraft = useCallback((failure: InlineFailure | null) => {
    setNewBranchName('');
    setShowBasePicker(false);
    setCreateError(null);
    setError(failure);
    setView('list');
  }, []);

  // Fetch branches on mount and reconcile a create when its first refresh failed.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    const request = { projectId, worktreeId, repoId };
    const list = refreshPending.current
      ? refreshCheckoutBranches(request)
      : window.api.listBranches(request);
    list
      .then((response) => {
        if (cancelled) return;
        refreshPending.current = false;
        setCatalogue(response);
        const attempt = unconfirmedCreate.current;
        unconfirmedCreate.current = null;
        if (
          attempt &&
          response.branches.some(
            (branch) =>
              branch.hasLocalRef && branch.name === attempt.branchName,
          )
        )
          consumeCreateDraft(attempt.error);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoading(false);
        const appError = toAppError(resolveClientAppError(err));
        if (appError)
          setLoadError(inlineFailure(appError, "Couldn't load branches."));
      });
    return (): void => {
      cancelled = true;
    };
  }, [projectId, worktreeId, repoId, loadAttempt, consumeCreateDraft]);

  // Focus search input when list view opens
  useEffect(() => {
    if (view === 'list' && !loading) {
      setTimeout(() => searchInputRef.current?.focus(), 0);
    }
  }, [view, loading]);

  // Focus new branch input when create view opens
  useEffect(() => {
    if (view === 'create') {
      setTimeout(() => newBranchInputRef.current?.focus(), 0);
    }
  }, [view]);

  // Filter branches: hide remote entries when a same-name local exists
  const filteredBranches = useMemo(() => {
    return filterBranchesBySearch(collapseBranchDuplicates(branches), search);
  }, [branches, search]);

  const localBranches = useMemo(
    () => filteredBranches.filter((b) => b.hasLocalRef),
    [filteredBranches],
  );

  const remoteBranches = useMemo(
    () => filteredBranches.filter((b) => !b.hasLocalRef && b.hasRemoteRef),
    [filteredBranches],
  );

  const refreshAfterCheckout = useCallback(async () => {
    try {
      const refreshed = await refreshCheckoutBranches({
        projectId,
        worktreeId,
        repoId,
      });
      setCatalogue(refreshed);
      setLoadError(null);
      return refreshed;
    } catch (err: unknown) {
      refreshPending.current = true;
      setCatalogue(null);
      const appError = toAppError(resolveClientAppError(err));
      setLoadError(
        appError
          ? inlineFailure(appError, "Couldn't load branches.")
          : { error: "Couldn't load branches." },
      );
      return null;
    }
  }, [projectId, worktreeId, repoId]);

  const handleSwitch = useCallback(
    async (branch: BranchEntry) => {
      if (switching || branch.isCurrent || branch.isUsedByWorktree) return;
      setSwitching(branch.name);
      setError(null);
      let succeeded = false;
      try {
        const response = await window.api.switchBranch({
          projectId,
          worktreeId,
          branchName: branch.name,
          isRemote: branch.isRemote,
          repoId,
        });
        succeeded = response.success;
      } catch (err: unknown) {
        const appError = toAppError(resolveClientAppError(err));
        if (appError)
          setError(
            inlineFailure(appError, `Couldn't switch to ${branch.name}.`),
          );
      } finally {
        const refreshed = await refreshAfterCheckout();
        setSwitching(null);
        if (succeeded && refreshed?.branchName === branch.name)
          onBranchSwitched();
      }
    },
    [
      projectId,
      worktreeId,
      repoId,
      switching,
      onBranchSwitched,
      refreshAfterCheckout,
    ],
  );

  const handleCreate = useCallback(async () => {
    if (loading || loadError || creating || !newBranchName) return;
    setCreating(true);
    setCreateError(null);
    setError(null);
    let attemptedBranch: string | undefined;
    let branchExists: boolean | undefined;
    let failure: InlineFailure | null = null;
    let baseSaved = false;
    try {
      const response = await window.api.createBranch({
        projectId,
        worktreeId,
        newBranchName,
        baseBranch: newBaseBranch,
        baseBranchIsRemote: newBaseBranchIsRemote,
        baseBranchSource: newBaseBranchSource,
        repoId,
      });
      attemptedBranch = response.branchName;
      branchExists = response.success ? true : response.branchExists;
      if (response.success) {
        showBranchCheckoutWarning(response.warning, projectId, worktreeId);
        await useProjectsStore
          .getState()
          .setTrackedBaseBranch(projectId, worktreeId, newBaseBranch, repoId);
        baseSaved = true;
      } else if (response.failureMessage) {
        failure = { error: response.failureMessage };
      }
    } catch (err: unknown) {
      const appError = toAppError(resolveClientAppError(err));
      if (appError) {
        failure = inlineFailure(
          appError,
          branchExists
            ? "Couldn't save the comparison base."
            : `Couldn't create ${newBranchName}.`,
        );
      }
    } finally {
      const refreshed = await refreshAfterCheckout();
      const branchFound = refreshed?.branches.some(
        (branch) => branch.hasLocalRef && branch.name === attemptedBranch,
      );
      if (branchExists === true || branchFound) {
        consumeCreateDraft(failure);
      } else {
        setCreateError(failure);
        if (attemptedBranch && !refreshed)
          unconfirmedCreate.current = {
            branchName: attemptedBranch,
            error: failure,
          };
      }
      setCreating(false);
      if (baseSaved && refreshed?.branchName === attemptedBranch)
        onBranchSwitched();
    }
  }, [
    creating,
    loading,
    loadError,
    projectId,
    worktreeId,
    repoId,
    newBranchName,
    newBaseBranch,
    newBaseBranchIsRemote,
    newBaseBranchSource,
    consumeCreateDraft,
    onBranchSwitched,
    refreshAfterCheckout,
  ]);

  // Base branch picker filter for the create view
  const baseFilteredBranches = useMemo(() => {
    if (!showBasePicker) return [];
    return filterBranchesBySearch(
      collapseBranchDuplicates(branches),
      newBaseBranch,
    );
  }, [branches, newBaseBranch, showBasePicker]);

  const currentBranch = branches.find((branch) => branch.isCurrent)?.name;

  const renderBranchItem = (branch: BranchOption): JSX.Element => {
    const isSwitching = switching === branch.name;
    const isDisabled =
      creating ||
      switching !== null ||
      branch.isCurrent ||
      branch.isUsedByWorktree;
    const provenanceBadge = getBranchProvenanceBadge(branch);

    return (
      <Tooltip
        key={`${branch.isRemote ? 'remote' : 'local'}-${branch.name}`}
        label={
          branch.isUsedByWorktree
            ? 'Used by another worktree'
            : branch.isCurrent
              ? 'Current branch'
              : `Switch to ${branch.name}`
        }
        disabled={!branch.isUsedByWorktree && !branch.isCurrent}
        className="w-full"
      >
        <ListRow
          disabled={isDisabled || isSwitching}
          selected={branch.isCurrent}
          aria-current={branch.isCurrent ? 'true' : undefined}
          onClick={() => void handleSwitch(branch)}
          trailing={
            branch.isCurrent ||
            branch.isUsedByWorktree ||
            provenanceBadge ||
            isSwitching ? (
              <span className="flex items-center gap-2">
                {branch.isCurrent && <Badge>current</Badge>}
                {branch.isUsedByWorktree && !branch.isCurrent && (
                  <Badge tone="warning">in use</Badge>
                )}
                {provenanceBadge && <Badge>{provenanceBadge}</Badge>}
                {isSwitching && <span>switching…</span>}
              </span>
            ) : undefined
          }
        >
          <span className="font-mono">{branch.name}</span>
        </ListRow>
      </Tooltip>
    );
  };

  return (
    <div className="w-full rounded-lg bg-card shadow-lg">
      {view === 'list' && (
        <>
          {/* Search input */}
          <Surface variant="section" boundary="bottom" padding="tight">
            <SearchField
              ref={searchInputRef}
              value={search}
              onValueChange={setSearch}
              onEscapeEmpty={onClose}
              aria-label="Search branches"
              placeholder={
                currentBranch
                  ? `Search branches (on ${currentBranch})…`
                  : 'Search branches…'
              }
            />
          </Surface>

          {/* Branch list */}
          <div
            ref={listRef}
            className="flex max-h-60 flex-col gap-1 overflow-y-auto p-1 [&>*]:shrink-0"
          >
            {loading && (
              <div className="flex items-center justify-center py-4">
                <span className="text-xs fg-secondary">Loading branches…</span>
              </div>
            )}

            {!loading && !loadError && filteredBranches.length === 0 && (
              <div className="py-3 text-center text-xs fg-secondary">
                {search ? 'No matching branches' : 'No branches found'}
              </div>
            )}

            {!loading && localBranches.length > 0 && (
              <div>
                <div className="px-2 py-1 text-3xs font-semibold fg-secondary">
                  Local
                </div>
                {localBranches.map(renderBranchItem)}
              </div>
            )}

            {!loading && remoteBranches.length > 0 && (
              <div>
                <div className="px-2 py-1 text-3xs font-semibold fg-secondary">
                  Remote
                </div>
                {remoteBranches.map(renderBranchItem)}
              </div>
            )}
          </div>

          {/* Error display */}
          {(loadError || error) && (
            <div className="flex flex-col gap-1.5 border-t px-2 py-1.5">
              <DesktopErrorBanner
                errorSource="branch-picker-load"
                className=""
                error={loadError?.error}
                details={loadError?.details}
                onRetry={() => setLoadAttempt((n) => n + 1)}
              />
              <DesktopErrorBanner
                errorSource="branch-picker"
                className=""
                error={error?.error}
                details={error?.details}
                blockMessageFromReplay
                onDismiss={() => setError(null)}
              />
            </div>
          )}

          {/* New branch option */}
          <div className="border-t p-1">
            <ListRow
              disabled={
                loading || creating || switching !== null || loadError !== null
              }
              onClick={() => {
                const defaultBranch = catalogue?.defaultBranch ?? null;
                const initialBase = resolveBranchPickerBaseSelection(
                  branches,
                  baseBranch,
                  defaultBranch,
                );
                setNewBaseBranch(initialBase.name);
                setNewBaseBranchIsRemote(initialBase.isRemote);
                setNewBaseBranchSource(
                  exactCatalogue && baseBranch == null && defaultBranch !== null
                    ? 'catalog'
                    : undefined,
                );
                setView('create');
                setCreateError(null);
              }}
              icon={<AppCatalogPlusIcon size="sm" />}
            >
              New branch…
            </ListRow>
          </div>
        </>
      )}

      {view === 'create' && (
        <div className="flex flex-col p-3 gap-2">
          <div className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={() => {
                setView('list');
                setCreateError(null);
              }}
              aria-label="Back to branch list"
            >
              <AppCatalogChevronLeftMediumIcon size="sm" />
            </Button>
            <span className="text-xs font-semibold fg-primary">
              Create new branch
            </span>
          </div>

          {/* Branch name input */}
          <Stack gap="inline">
            <FormField label="Branch name">
              {(control) => (
                <TextInput
                  {...control}
                  ref={newBranchInputRef}
                  density="compact"
                  mono
                  type="text"
                  value={newBranchName}
                  onChange={(e) => {
                    setNewBranchName(e.target.value);
                    setCreateError(null);
                  }}
                  onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') {
                      void handleCreate();
                    } else if (e.key === 'Escape') {
                      setView('list');
                      setCreateError(null);
                    }
                  }}
                  placeholder="feature/my-branch"
                  disabled={creating}
                />
              )}
            </FormField>

            {/* Base branch input */}
            <div className="relative">
              <FormField label="From base branch">
                {(control) => (
                  <TextInput
                    {...control}
                    ref={baseBranchInputRef}
                    density="compact"
                    mono
                    type="text"
                    value={newBaseBranch}
                    onChange={(e) => {
                      const nextBaseSelection =
                        resolveBranchPickerBaseSelection(
                          branches,
                          e.target.value,
                          null,
                        );
                      setNewBaseBranch(nextBaseSelection.name);
                      setNewBaseBranchIsRemote(nextBaseSelection.isRemote);
                      setNewBaseBranchSource(undefined);
                      setShowBasePicker(true);
                    }}
                    onFocus={() => setShowBasePicker(true)}
                    onBlur={() => {
                      // Delay to allow click on picker item
                      setTimeout(() => setShowBasePicker(false), 150);
                    }}
                    onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === 'Escape') {
                        setShowBasePicker(false);
                      }
                    }}
                    disabled={creating}
                  />
                )}
              </FormField>
              {/* Suggestions while typing: focus stays in the field, and the
                  shared menu layer places and dismisses the list. */}
              <FloatingMenu
                open={showBasePicker && baseFilteredBranches.length > 0}
                onOpenChange={setShowBasePicker}
                anchorRef={baseBranchInputRef}
                interaction="manual"
                openOnArrowKeys={false}
                // Any press outside closes the suggestions and still does
                // what it says: Create, Cancel, the other field, or the
                // dialog around the picker (its Close, tabs and rows).
                outsidePressSwallowsClick={false}
                heightLimit={160}
                role="listbox"
                aria-label="Base branches"
                className="w-[var(--floating-menu-anchor-width)] overflow-y-auto"
              >
                {baseFilteredBranches.map((b) => {
                  const provenanceBadge = getBranchProvenanceBadge(b);
                  return (
                    <ListRow
                      key={`base-${b.isRemote ? 'remote' : 'local'}-${b.name}`}
                      role="option"
                      aria-selected={b.name === newBaseBranch}
                      selected={b.name === newBaseBranch}
                      tabIndex={-1}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setNewBaseBranch(b.name);
                        setNewBaseBranchIsRemote(b.hasRemoteRef);
                        setNewBaseBranchSource(
                          exactCatalogue ? 'catalog' : undefined,
                        );
                        setShowBasePicker(false);
                      }}
                      trailing={provenanceBadge || undefined}
                    >
                      <span className="font-mono">{b.name}</span>
                    </ListRow>
                  );
                })}
              </FloatingMenu>
            </div>

            <DesktopErrorBanner
              errorSource="branch-picker-create-load"
              className=""
              error={loadError?.error}
              details={loadError?.details}
              onRetry={() => setLoadAttempt((n) => n + 1)}
            />
            <DesktopErrorBanner
              errorSource="branch-picker-create"
              className=""
              error={createError?.error}
              details={createError?.details}
              blockMessageFromReplay
              onDismiss={() => setCreateError(null)}
            />
            <div className="flex justify-end gap-1.5">
              <Button
                size="compact"
                onClick={() => {
                  setView('list');
                  setCreateError(null);
                }}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="compact"
                disabled={
                  loading || creating || !newBranchName || loadError !== null
                }
                onClick={() => void handleCreate()}
              >
                {creating ? 'Creating…' : 'Create'}
              </Button>
            </div>
          </Stack>
        </div>
      )}
    </div>
  );
}
