import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type RefObject,
} from 'react';
import { useShallow } from 'zustand/shallow';
import {
  Picker,
  PickerList,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionDescription,
  PickerOptionLabel,
  PickerOptionLeading,
  PickerOptionTrailing,
  PickerSearchHeader,
  PickerSearchCombobox,
  PickerSection,
  PickerSectionLabel,
  PickerState,
  PickerTab,
  PickerTabList,
  PickerTrigger,
  PickerTriggerChevron,
  PullRequestPickerOption,
  SOURCE_NO_COMMITS_HINT,
  Tooltip,
  WordBoundaryTruncatedText,
} from '@canopy/ui-shared';
import {
  scrollPickerOptionIntoView,
  usePickerActiveScrollIntent,
} from '@canopy/ui-shared/lib';
import {
  BranchIcon,
  GitHubIcon,
  GitPullRequestIcon,
  GlobeIcon,
  LinearIcon,
  MacbookIcon,
  WorktreeIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  parsePullRequestReference,
  type ParsedPullRequestReference,
} from '@canopy/protocol/portable-tasks/pull-request-reference';
import {
  normalizePullRequestTitleQuery,
  PR_TITLE_SEARCH_MAX_INPUT_LENGTH,
} from '@canopy/desktop-shared/lib/pull-request-search';
import type {
  HomeBranchTargetsResponse,
  LinearTicketSearchResult,
  PullRequestSummary,
  RepoSlug,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  homeSendUsesSourceHead,
  useHomeComposerStore,
  type HomeBranchTarget,
} from '@/stores/homeComposerStore';
import { useNavigationStore } from '@/stores/navigationStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { useLinearAvailability } from '@/hooks/useLinearStatus';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  subscribeToConnectionChange,
} from '@/lib/integrationConnectionEvents';
import { probeGitHubConnected } from '@/lib/githubConnection';
import {
  resolveCreateFromReferenceInput,
  workspaceRepoPathForCreateFrom,
} from '@/lib/createFromSource';
import { extractIpcErrorMessage } from '@/lib/errors';
import {
  collapseBranchDuplicates,
  filterBranchesBySearch,
  getBranchProvenanceBadge,
} from '../worktree/branch-options';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { openIntegrationSettings } from '@/lib/navigation/settings-destinations';

/** The four tabs of the Create-from dropdown, in render order. */
type HomeBranchTab = 'new' | 'prs' | 'branches' | 'issues';

/** Lazy per-workspace fetch state for the PRs tab's open-PR list. */
type PrFetchState =
  | { status: 'loading' }
  | { status: 'loaded'; pullRequests: PullRequestSummary[] }
  | { status: 'error'; message: string };

/**
 * GitHub title-search fallback state for the PRs tab. Every non-idle state
 * carries the request identity it belongs to, so a render only shows results
 * that match the current repository, query, and GitHub connection.
 */
type PrSearchState =
  | { status: 'idle' }
  | { status: 'searching'; requestKey: string }
  | {
      status: 'loaded';
      requestKey: string;
      pullRequests: PullRequestSummary[];
    }
  | { status: 'error'; requestKey: string; message: string };

/** What the PRs tab renders for the title-search fallback. */
type PrSearchView =
  | { status: 'idle' }
  | { status: 'searching' }
  | { status: 'loaded'; pullRequests: PullRequestSummary[] }
  | { status: 'error'; message: string };

/** The title query derived from the search box, before eligibility checks. */
type PrTitleQuery =
  | { kind: 'none' }
  | { kind: 'valid'; normalized: string; requestQuery: string }
  | { kind: 'invalid'; message: string };

/**
 * One keyboard-navigable row in the active tab's flat option list. `key`
 * doubles as the `data-active`/`aria-activedescendant` identity; `onSelect`
 * is what Enter (or a click) commits.
 */
interface PickerNavOption {
  key: string;
  onSelect: () => void;
}

const PICKER_TABS = [
  {
    id: 'new',
    label: 'Worktrees',
    ariaLabel: 'Worktrees',
    testid: 'home-branch-picker-tab-new',
  },
  {
    id: 'prs',
    label: 'PRs',
    ariaLabel: 'Pull requests',
    testid: 'home-branch-picker-tab-prs',
  },
  {
    id: 'branches',
    label: 'Branches',
    ariaLabel: 'Branches',
    testid: 'home-branch-picker-tab-branches',
  },
  {
    id: 'issues',
    label: 'Issues',
    ariaLabel: 'Issues',
    testid: 'home-branch-picker-tab-issues',
  },
] as const;

/** An existing worktree can switch to a PR, branch or issue, not a worktree. */
const WORKTREE_PICKER_TABS = PICKER_TABS.filter((tab) => tab.id !== 'new');

const LINEAR_SEARCH_DEBOUNCE_MS = 300;
/** Debounce before the PRs tab searches GitHub for an unmatched title. */
const PR_TITLE_SEARCH_DEBOUNCE_MS = 300;
/** Shorter input stays a local filter; it never searches GitHub. */
const PR_TITLE_SEARCH_MIN_INPUT_LENGTH = 2;
/** GitHub returns at most this many title-search results. */
const PR_TITLE_SEARCH_RESULT_LIMIT = 20;
const PR_SEARCH_IDLE: PrSearchState = { status: 'idle' };

const EMPTY_PULL_REQUESTS: readonly PullRequestSummary[] = [];

/** Stable identity for a branch target, used to match active/selected rows.
 * PR / Linear-issue keys mirror `homeBranchTargetsEqual`'s identity fields
 * (PR by number, Linear issue by identifier). */
function targetKey(target: HomeBranchTarget): string {
  if (target.kind === 'new-worktree') return 'new-worktree';
  if (target.kind === 'worktree') return `worktree:${target.worktreeId}`;
  if (target.kind === 'pr') return `pr:${target.number}`;
  if (target.kind === 'linear-issue') {
    return `linear-issue:${target.identifier}`;
  }
  return `branch:${target.isRemote ? 'remote' : 'local'}:${target.branchName}`;
}

/** The tab that owns a given selected target, used to restore the picker to
 * the right tab when it reopens. */
function tabForTarget(target: HomeBranchTarget): HomeBranchTab {
  if (target.kind === 'branch') return 'branches';
  if (target.kind === 'pr') return 'prs';
  if (target.kind === 'linear-issue') return 'issues';
  return 'new';
}

/** Case-insensitive PR filter over number, title, and author. */
function prMatchesSearch(pr: PullRequestSummary, needle: string): boolean {
  if (!needle) return true;
  const lower = needle.toLowerCase();
  return (
    String(pr.number).includes(needle) ||
    pr.title.toLowerCase().includes(lower) ||
    pr.authorLogin.toLowerCase().includes(lower)
  );
}

/**
 * The search box as a GitHub title query. Uses the host's normalization so
 * the picker never sends input the host would reject; over-long input is a
 * validation error rather than a silently truncated search. The request
 * carries the original input so the host applies the same policy itself.
 */
function prTitleQueryFor(search: string): PrTitleQuery {
  const trimmed = search.trim();
  if (trimmed.length < PR_TITLE_SEARCH_MIN_INPUT_LENGTH) {
    return { kind: 'none' };
  }
  try {
    const normalized = normalizePullRequestTitleQuery(trimmed);
    return {
      kind: 'valid',
      normalized,
      requestQuery: search,
    };
  } catch (err: unknown) {
    if (trimmed.length > PR_TITLE_SEARCH_MAX_INPUT_LENGTH) {
      return { kind: 'invalid', message: extractIpcErrorMessage(err) };
    }
    return { kind: 'none' };
  }
}
/** Local-only branch provenance tooltip. */
const LOCAL_BRANCH_TOOLTIP = 'Local branch';
/** Remote-only branch provenance tooltip. */
const REMOTE_BRANCH_TOOLTIP = 'Remote branch';

/**
 * Whether a loaded PR is the one a parsed reference points at. A bare `#n`/`n`
 * reference (no owner/repo) matches by number alone; a full
 * `github.com/{owner}/{repo}/pull/n` URL must also name that PR's own
 * repository (case-insensitive), so pasting a foreign-repo URL never silently
 * selects a same-numbered local PR. This keeps the list shortcut in step with
 * the resolver (`github-pr-resolver.ts`), which explicitly rejects cross-repo
 * references; a URL that fails this match falls through to the resolve row,
 * whose resolver then surfaces the proper cross-repo rejection.
 */
function prMatchesReference(
  pr: PullRequestSummary,
  reference: ParsedPullRequestReference,
): boolean {
  if (pr.number !== reference.number) return false;
  if (reference.owner === undefined || reference.repo === undefined) {
    return true;
  }
  const parsedPrUrl = parsePullRequestReference(pr.url);
  return (
    parsedPrUrl !== null &&
    parsedPrUrl.owner?.toLowerCase() === reference.owner.toLowerCase() &&
    parsedPrUrl.repo?.toLowerCase() === reference.repo.toLowerCase() &&
    parsedPrUrl.number === reference.number
  );
}

/**
 * Create-from branch target picker for the Home composer. A Conductor-style
 * tabbed dropdown (New worktree · PRs · Branches · Issues) that replaced both
 * the old flat branch list and the standalone "Create from…" button
 * (ECW-8121 v2). The component name and `home-branch-picker*` testid family
 * are retained deliberately.
 *
 * - _New worktree:_ the pinned new-worktree option plus this workspace's
 *   existing worktrees; the shared search filters them.
 * - _PRs:_ the workspace repo's open pull requests, fetched lazily on first
 *   activation per workspace, with a paste-to-resolve row for a PR that isn't
 *   in the list.
 * - _Branches:_ the "Other branches" group (unused local/remote branches).
 * - _Issues:_ debounced Linear issue search; without a Linear key the tab
 *   stays enabled and shows a connect prompt that opens the Linear settings.
 *
 * The caller (`HomeSurface`) is responsible for not rendering this component
 * at all for cowork workspaces, since cowork has no worktrees or branch
 * concept.
 */
export function HomeBranchPicker(): JSX.Element {
  return <BranchTargetPicker host={{ kind: 'home-draft' }} />;
}

/** The picker bound to an existing worktree, opened from its own control. */
export interface WorktreeBranchTargetPickerProps {
  workspaceId: string;
  currentBranch: string;
  branchTargets: HomeBranchTargetsResponse | null;
  onSelect: (target: HomeBranchTarget) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The control the menu opens from and returns focus to. */
  anchorRef: RefObject<HTMLElement | null>;
  'data-testid'?: string;
}

/**
 * The Create-from menu without its trigger, editing an existing worktree's
 * branch instead of the Home draft. It has no Worktrees tab and none of the
 * Home-only handoffs (cross-repository switching, the add-project offer and
 * staged tab requests).
 */
export function WorktreeBranchTargetPicker(
  props: WorktreeBranchTargetPickerProps,
): JSX.Element {
  return <BranchTargetPicker host={{ kind: 'worktree', ...props }} />;
}

type BranchTargetPickerHost =
  | { kind: 'home-draft' }
  | ({ kind: 'worktree' } & WorktreeBranchTargetPickerProps);

function BranchTargetPicker({
  host,
}: {
  host: BranchTargetPickerHost;
}): JSX.Element {
  const worktreeHost = host.kind === 'worktree' ? host : null;
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = worktreeHost ? worktreeHost.open : localOpen;
  const setIsOpen = worktreeHost ? worktreeHost.onOpenChange : setLocalOpen;
  const pickerTabs = worktreeHost ? WORKTREE_PICKER_TABS : PICKER_TABS;
  const fallbackTab: HomeBranchTab = worktreeHost ? 'branches' : 'new';
  const [activeTab, setActiveTab] = useState<HomeBranchTab>('new');
  const [search, setSearch] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const {
    markActiveOptionScrollIntent,
    clearActiveOptionScrollIntent,
    consumeActiveOptionScrollIntent,
  } = usePickerActiveScrollIntent();

  const projects = useProjectsStore((s) => s.projects);
  const homeDraft = useHomeComposerStore(
    useShallow((s) => ({
      workspaceId: s.workspaceId,
      branchTarget: s.branchTarget,
      branchTargets: s.branchTargets,
      newWorktreeBaseTarget: s.newWorktreeBaseTarget,
      setBranchTarget: s.setBranchTarget,
      pendingCreateFromReference: s.pendingCreateFromReference,
      setPendingCreateFromReference: s.setPendingCreateFromReference,
      pendingBranchPickerRequest: s.pendingBranchPickerRequest,
    })),
  );
  const workspaceId = worktreeHost
    ? worktreeHost.workspaceId
    : homeDraft.workspaceId;
  const branchTarget: HomeBranchTarget = worktreeHost
    ? {
        kind: 'branch',
        branchName: worktreeHost.currentBranch,
        isRemote: false,
      }
    : homeDraft.branchTarget;
  const branchTargets = worktreeHost
    ? worktreeHost.branchTargets
    : homeDraft.branchTargets;
  const setBranchTarget = worktreeHost
    ? worktreeHost.onSelect
    : homeDraft.setBranchTarget;
  // Home-only handoffs; a worktree picker never reads or writes the draft.
  const pendingCreateFromReference = worktreeHost
    ? null
    : homeDraft.pendingCreateFromReference;
  const pendingBranchPickerRequest = worktreeHost
    ? null
    : homeDraft.pendingBranchPickerRequest;
  const { setPendingCreateFromReference } = homeDraft;

  const project = useMemo(
    () => projects.find((candidate) => candidate.id === workspaceId) ?? null,
    [projects, workspaceId],
  );
  const repoPath = useMemo(
    () => (project ? workspaceRepoPathForCreateFrom(project) : null),
    [project],
  );
  const allWorktrees = useMemo(
    () => (project && project.type !== 'cowork' ? project.worktrees : []),
    [project],
  );

  // --- Linear availability. The hook re-reads the key when Settings writes
  // one, which matters here because this picker stays mounted underneath the
  // Settings overlay for the whole session. ---
  const {
    available: linearAvailable,
    status: linearStatus,
    tokenLoaded: linearTokenLoaded,
    tokenPresent: linearTokenPresent,
  } = useLinearAvailability();
  // "Unavailable" and "still loading" must not be conflated when deciding a
  // staged Issues landing: right after an onboarding Cowork→code retarget
  // this picker mounts fresh with the request already staged, before the
  // async token read/validation resolves. Settled = the token read finished
  // and, when a token exists, its validation has produced a status.
  const linearAvailabilitySettled =
    linearTokenLoaded && (!linearTokenPresent || linearStatus !== null);

  // --- New worktree tab: existing worktrees, filtered by the search box. ---
  const filteredWorktrees = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return allWorktrees;
    return allWorktrees.filter((worktree) =>
      worktree.branchName.toLowerCase().includes(needle),
    );
  }, [allWorktrees, search]);

  // --- Branches tab: unused local/remote branches, filtered by search. ---
  const allOtherBranches = useMemo(() => {
    if (!branchTargets || branchTargets.supported === false) {
      return [];
    }
    return collapseBranchDuplicates(branchTargets.branches).filter(
      (branch) => !branch.isUsedByWorktree && !branch.isCurrent,
    );
  }, [branchTargets]);
  const otherBranches = useMemo(
    () => filterBranchesBySearch(allOtherBranches, search),
    [allOtherBranches, search],
  );

  // --- PRs tab: lazy per-workspace open-PR list. ---
  const [prCache, setPrCache] = useState<Record<string, PrFetchState>>({});
  const prFetchStartedRef = useRef<Set<string>>(new Set());
  const [prResolving, setPrResolving] = useState(false);
  const [prResolveError, setPrResolveError] = useState<string | null>(null);
  // Records the cross-repo auto-switch scan's "no eligible workspace owns this
  // foreign repo" outcome, keyed to the exact attempted reference so the render
  // can distinguish scan-pending (`null` → keep the resolve row) from a settled
  // no-match (→ show the "Add {owner}/{repo} as a project…" offer row instead
  // of the dead-end resolve row). Cleared on search change / picker open.
  const [noWorkspaceMatch, setNoWorkspaceMatch] = useState<{
    attemptKey: string;
    owner: string;
    repo: string;
  } | null>(null);
  // GitHub connectivity, resolved lazily the first time the PR list enters its
  // error state (see the effect below) and cached for the open picker session.
  // `null` = not yet checked; `false` = neither a PAT nor a signed-in gh CLI.
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);

  // A PR list is fetched at most once per workspace per picker lifetime, and
  // this picker outlives the Settings overlay. So a fetch that failed only
  // because GitHub wasn't connected yet would stay failed for the rest of the
  // session. Dropping the memo on a credential change — and bumping a nonce the
  // fetch effect depends on, since none of its other inputs move — retries
  // against the new auth.
  const [githubAuthNonce, setGithubAuthNonce] = useState(0);
  const githubAuthGenerationRef = useRef(0);
  const prListKey =
    workspaceId && repoPath
      ? JSON.stringify([workspaceId, repoPath, githubAuthNonce])
      : null;
  useEffect(() => {
    return subscribeToConnectionChange(
      GITHUB_CONNECTION_CHANGED_EVENT,
      (): void => {
        githubAuthGenerationRef.current += 1;
        prFetchStartedRef.current.clear();
        setPrCache({});
        setGithubConnected(null);
        setGithubAuthNonce((nonce) => nonce + 1);
      },
    );
  }, []);

  useEffect(() => {
    if (!isOpen || activeTab !== 'prs' || !prListKey || !repoPath) {
      return;
    }
    if (prFetchStartedRef.current.has(prListKey)) {
      return;
    }
    prFetchStartedRef.current.add(prListKey);
    const targetListKey = prListKey;
    const targetRepoPath = repoPath;
    const generation = githubAuthGenerationRef.current;
    setPrCache((prev) => ({
      ...prev,
      [targetListKey]: { status: 'loading' },
    }));
    // Repository identity scopes each workspace's slot. Credential changes
    // also invalidate outstanding writes before the fresh listing starts.
    void (async (): Promise<void> => {
      try {
        const response = await window.api.listPullRequests({
          repoPath: targetRepoPath,
        });
        if (githubAuthGenerationRef.current !== generation) return;
        setPrCache((prev) => ({
          ...prev,
          [targetListKey]: {
            status: 'loaded',
            pullRequests: response.pullRequests,
          },
        }));
      } catch (err: unknown) {
        if (githubAuthGenerationRef.current !== generation) return;
        setPrCache((prev) => ({
          ...prev,
          [targetListKey]: {
            status: 'error',
            message: extractIpcErrorMessage(err),
          },
        }));
      }
    })();
  }, [isOpen, activeTab, prListKey, repoPath]);

  const prState = prListKey ? prCache[prListKey] : undefined;
  const loadedPrs = useMemo(
    () =>
      prState?.status === 'loaded' ? prState.pullRequests : EMPTY_PULL_REQUESTS,
    [prState],
  );
  const parsedPrReference = parsePullRequestReference(search);
  // A full `github.com/{owner}/{repo}/pull/n` URL (only a paste produces one)
  // carries an explicit owner/repo — a bare `#n`/`n` reference does not, and
  // never triggers the cross-repo auto-switch below. Both derived keys are
  // stable primitives so the auto-switch effect only re-runs when the pasted
  // repo/number actually changes: `pastedForeignRepoKey` is what a workspace's
  // origin slug is matched against, `pastedAttemptKey` is the once-per-session
  // dedup identity.
  const pastedForeignRepoKey =
    parsedPrReference &&
    parsedPrReference.owner !== undefined &&
    parsedPrReference.repo !== undefined
      ? `${parsedPrReference.owner.toLowerCase()}/${parsedPrReference.repo.toLowerCase()}`
      : null;
  const pastedAttemptKey =
    pastedForeignRepoKey !== null && parsedPrReference !== null
      ? `${pastedForeignRepoKey}/${parsedPrReference.number}`
      : null;
  // Original-case owner/repo for the offer-row label (the key above is
  // lowercased for slug matching). Primitive so the auto-switch effect can
  // depend on them without re-running on every render.
  const pastedForeignOwner = parsedPrReference?.owner ?? null;
  const pastedForeignRepo = parsedPrReference?.repo ?? null;
  const filteredPrs = useMemo(() => {
    if (parsedPrReference) {
      return loadedPrs.filter((pr) =>
        prMatchesReference(pr, parsedPrReference),
      );
    }
    return loadedPrs.filter((pr) => prMatchesSearch(pr, search.trim()));
  }, [loadedPrs, search, parsedPrReference]);
  const showPrResolveRow =
    repoPath !== null &&
    parsedPrReference !== null &&
    !loadedPrs.some((pr) => prMatchesReference(pr, parsedPrReference));
  // The resolve/offer rows (and any resolve error) are only rendered once the
  // list fetch settles — in both the `loaded` and `error` states — so paste
  // resolution stays reachable offline.
  const prListSettled =
    prState?.status === 'loaded' || prState?.status === 'error';
  // The "Add {owner}/{repo} as a project…" offer row: a foreign-repo PR URL
  // whose owner/repo the cross-repo scan matched to NO eligible workspace. It
  // REPLACES the dead-end resolve row (whose resolver would only reject the
  // cross-repo reference). Gated on the scan outcome being current with the
  // pasted reference so a stale outcome never surfaces.
  const addWorkspaceOfferVisible =
    repoPath !== null &&
    prListSettled &&
    pastedAttemptKey !== null &&
    noWorkspaceMatch !== null &&
    noWorkspaceMatch.attemptKey === pastedAttemptKey;
  // Keyboard nav mirrors this exactly: the row is excluded while loading (when
  // it is not rendered), so `aria-activedescendant` never points at a missing
  // id and Enter can never trigger an invisible resolve. The offer row wins
  // over the resolve row so a foreign-repo paste never shows both.
  const prResolveRowVisible =
    showPrResolveRow && prListSettled && !addWorkspaceOfferVisible;

  // --- PRs tab: GitHub title search when the loaded list has no match. The
  // initial list holds only the most recently updated PRs, so an older PR is
  // only findable by asking GitHub. References keep the resolve path above,
  // and a local match never searches. ---
  const prTitleQuery = useMemo(() => prTitleQueryFor(search), [search]);
  const prSearchContextEligible =
    isOpen &&
    activeTab === 'prs' &&
    workspaceId !== null &&
    repoPath !== null &&
    prState?.status === 'loaded' &&
    parsedPrReference === null &&
    filteredPrs.length === 0;
  // The request identity: any change in it — query, repository, workspace,
  // GitHub connection — makes earlier results and errors obsolete. Closing the
  // picker or leaving the tab drops eligibility, so a reopen searches afresh.
  const prSearchRequest =
    prSearchContextEligible &&
    repoPath !== null &&
    prTitleQuery.kind === 'valid'
      ? {
          key: JSON.stringify([
            workspaceId,
            repoPath,
            prTitleQuery.normalized,
            search,
            githubAuthNonce,
          ]),
          repoPath,
          query: prTitleQuery.requestQuery,
        }
      : null;
  const prSearchKey = prSearchRequest?.key ?? null;
  const prSearchRepoPath = prSearchRequest?.repoPath ?? null;
  const prSearchQuery = prSearchRequest?.query ?? null;
  const [prSearch, setPrSearch] = useState<PrSearchState>(PR_SEARCH_IDLE);
  const prSearchSeqRef = useRef(0);
  useEffect(() => {
    if (
      prSearchKey === null ||
      prSearchRepoPath === null ||
      prSearchQuery === null
    ) {
      prSearchSeqRef.current += 1;
      setPrSearch(PR_SEARCH_IDLE);
      return;
    }
    const seq = ++prSearchSeqRef.current;
    setPrSearch({ status: 'searching', requestKey: prSearchKey });
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        try {
          const response = await window.api.searchPullRequests({
            repoPath: prSearchRepoPath,
            query: prSearchQuery,
          });
          if (prSearchSeqRef.current !== seq) return;
          setPrSearch({
            status: 'loaded',
            requestKey: prSearchKey,
            pullRequests: response.pullRequests,
          });
        } catch (err: unknown) {
          if (prSearchSeqRef.current !== seq) return;
          setPrSearch({
            status: 'error',
            requestKey: prSearchKey,
            message: extractIpcErrorMessage(err),
          });
        }
      })();
    }, PR_TITLE_SEARCH_DEBOUNCE_MS);
    // Discards a late response; an already-issued request still completes.
    return (): void => {
      prSearchSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [prSearchKey, prSearchRepoPath, prSearchQuery]);

  // Derived from the current request identity, so the render never shows a
  // previous query's results, and eligible input shows the loading state from
  // the first keystroke rather than flashing the empty state.
  const prSearchView = useMemo((): PrSearchView => {
    if (prSearchContextEligible && prTitleQuery.kind === 'invalid') {
      return { status: 'error', message: prTitleQuery.message };
    }
    if (prSearchKey === null) return { status: 'idle' };
    if (prSearch.status === 'idle' || prSearch.requestKey !== prSearchKey) {
      return { status: 'searching' };
    }
    if (prSearch.status === 'loaded') {
      // Drop rows already visible locally and duplicates within the response.
      // A result present only in the unfiltered list stays: GitHub's title
      // match can find a loaded PR the local substring filter missed.
      const seen = new Set(filteredPrs.map((pr) => pr.number));
      const pullRequests: PullRequestSummary[] = [];
      for (const pr of prSearch.pullRequests) {
        if (seen.has(pr.number)) continue;
        seen.add(pr.number);
        pullRequests.push(pr);
        if (pullRequests.length === PR_TITLE_SEARCH_RESULT_LIMIT) break;
      }
      return { status: 'loaded', pullRequests };
    }
    if (prSearch.status === 'error') {
      return { status: 'error', message: prSearch.message };
    }
    return { status: 'searching' };
  }, [
    prSearchContextEligible,
    prTitleQuery,
    prSearchKey,
    prSearch,
    filteredPrs,
  ]);
  const prSearchResults =
    prSearchView.status === 'loaded'
      ? prSearchView.pullRequests
      : EMPTY_PULL_REQUESTS;

  // When the PR list fetch fails for an unauthenticated user on a private repo
  // the raw error is unhelpful ("Not Found"). Resolve GitHub connectivity
  // lazily — only once an error state actually needs rendering — and swap in a
  // connect prompt when NEITHER a PAT nor a signed-in gh CLI is present. The
  // check is cached for the open picker session (reset on each reopen) so a
  // late/failed source never flips the row after the fact.
  useEffect(() => {
    if (
      !isOpen ||
      activeTab !== 'prs' ||
      prState?.status !== 'error' ||
      githubConnected !== null
    ) {
      return;
    }
    let cancelled = false;
    void (async (): Promise<void> => {
      const connection = await probeGitHubConnected();
      if (cancelled) return;
      if (connection !== 'unknown')
        setGithubConnected(connection === 'connected');
    })();
    return (): void => {
      cancelled = true;
    };
  }, [isOpen, activeTab, prState?.status, githubConnected]);

  // The connect prompt replaces the raw PR error only once both sources are
  // confirmed absent; a still-pending (`null`) or connected check keeps today's
  // raw error rendering. Kept in lockstep with the render below and the nav
  // model so `aria-activedescendant` never points at a missing row.
  // Gated on repoPath like the resolve row, so the nav model and the render
  // can never disagree about this row in any state.
  const prConnectRowVisible =
    repoPath !== null &&
    prState?.status === 'error' &&
    githubConnected === false;

  // --- Cross-repo auto-switch: a pasted PR URL that belongs to another repo.
  // A full `github.com/{owner}/{repo}/pull/n` URL names a specific repository.
  // When it does NOT match the current workspace's origin slug (a repo with no
  // GitHub remote reports a null slug, which counts as a mismatch), scan the
  // OTHER eligible workspaces for one whose origin slug matches and switch the
  // composer to it. That workspace's per-workspace PR fetch then loads its list,
  // where `prMatchesReference` selects the pasted URL. When no eligible
  // workspace matches, the scan records `noWorkspaceMatch` so the render swaps
  // the dead-end resolve row for the "Add {owner}/{repo} as a project…" offer
  // row. Attempted at most once per distinct pasted owner/repo/number per
  // open session (`switchAttemptKeyRef`, cleared on each reopen), and a late
  // lookup never switches if the search changed or the picker closed meanwhile
  // (the `cancelled` guard — `pastedAttemptKey`/`isOpen` are effect deps, so any
  // such change tears down the in-flight run first).
  const switchAttemptKeyRef = useRef<string | null>(null);
  // The composite key argument capture for the two-phase resume handoff: the
  // workspace active when the offer row was clicked (so the resume effect can
  // wait until the composer switches OFF it to the newly created workspace),
  // and the reference to apply on the next picker open.
  const createFromResumeOriginRef = useRef<string | null>(null);
  const pendingResumeReferenceRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      // Switching workspaces retargets the Home draft, never a worktree.
      worktreeHost !== null ||
      !isOpen ||
      pastedAttemptKey === null ||
      pastedForeignRepoKey === null ||
      switchAttemptKeyRef.current === pastedAttemptKey
    ) {
      return;
    }
    switchAttemptKeyRef.current = pastedAttemptKey;
    const attemptKey = pastedAttemptKey;

    let cancelled = false;
    void (async (): Promise<void> => {
      const slugMatchesReference = (slug: RepoSlug | null): boolean =>
        slug !== null &&
        `${slug.owner.toLowerCase()}/${slug.repo.toLowerCase()}` ===
          pastedForeignRepoKey;

      // The current workspace already owns this repo — its own PR list resolves
      // the URL — so there is nothing to switch to.
      let currentSlug: RepoSlug | null = null;
      if (repoPath) {
        try {
          currentSlug = await window.api.getRepoSlug({ repoPath });
        } catch {
          currentSlug = null;
        }
      }
      if (cancelled) return;
      if (slugMatchesReference(currentSlug)) return;

      const candidates: { id: string; repoPath: string }[] = [];
      for (const candidate of projects) {
        if (candidate.id === workspaceId) continue;
        const candidateRepoPath = workspaceRepoPathForCreateFrom(candidate);
        if (candidateRepoPath === null) continue;
        candidates.push({ id: candidate.id, repoPath: candidateRepoPath });
      }

      const resolved = await Promise.all(
        candidates.map(
          async (candidate): Promise<{ id: string; slug: RepoSlug | null }> => {
            try {
              return {
                id: candidate.id,
                slug: await window.api.getRepoSlug({
                  repoPath: candidate.repoPath,
                }),
              };
            } catch {
              // A per-workspace slug lookup failure simply counts as no-match.
              return { id: candidate.id, slug: null };
            }
          },
        ),
      );
      if (cancelled) return;

      const match = resolved.find((entry) => slugMatchesReference(entry.slug));
      if (!match) {
        // No eligible workspace owns this foreign repo — record the outcome so
        // the render swaps the dead-end resolve row for the "Add {owner}/{repo}
        // as a workspace…" offer row.
        if (pastedForeignOwner !== null && pastedForeignRepo !== null) {
          setNoWorkspaceMatch({
            attemptKey,
            owner: pastedForeignOwner,
            repo: pastedForeignRepo,
          });
        }
        return;
      }

      // Keep the picker open, the search text, and the PRs tab active — only the
      // active workspace changes, so the workspace pill updates and the new
      // list resolves the pasted URL.
      useHomeComposerStore.getState().selectWorkspace(match.id);
      setActiveTab('prs');
      setActiveIndex(0);
    })();

    return (): void => {
      cancelled = true;
    };
  }, [
    worktreeHost,
    isOpen,
    pastedAttemptKey,
    pastedForeignRepoKey,
    pastedForeignOwner,
    pastedForeignRepo,
    workspaceId,
    repoPath,
    projects,
  ]);

  // --- Issues tab: debounced Linear issue search. ---
  const [linearResults, setLinearResults] = useState<
    LinearTicketSearchResult[]
  >([]);
  const [linearSearching, setLinearSearching] = useState(false);
  const linearSeqRef = useRef(0);
  useEffect(() => {
    if (!isOpen || activeTab !== 'issues' || !linearAvailable) {
      return;
    }
    const trimmed = search.trim();
    if (trimmed.length === 0) {
      linearSeqRef.current += 1;
      setLinearSearching(false);
      setLinearResults([]);
      return;
    }
    const seq = ++linearSeqRef.current;
    setLinearSearching(true);
    const timer = window.setTimeout(() => {
      void (async (): Promise<void> => {
        let results: LinearTicketSearchResult[] = [];
        try {
          results = await window.api.searchLinearIssues(trimmed);
        } catch {
          results = [];
        }
        if (linearSeqRef.current !== seq) return;
        setLinearResults(results);
        setLinearSearching(false);
      })();
    }, LINEAR_SEARCH_DEBOUNCE_MS);
    return (): void => {
      linearSeqRef.current += 1;
      window.clearTimeout(timer);
    };
  }, [isOpen, activeTab, linearAvailable, search]);

  const returnFocusRef = worktreeHost?.anchorRef ?? buttonRef;
  const closePicker = useCallback((): void => {
    setIsOpen(false);
    returnFocusRef.current?.focus();
  }, [returnFocusRef, setIsOpen]);

  const commitTarget = useCallback(
    (target: HomeBranchTarget): void => {
      setBranchTarget(target);
      closePicker();
    },
    [setBranchTarget, closePicker],
  );

  // Shared by loaded and GitHub-searched PR rows, for mouse and keyboard.
  const commitPullRequest = useCallback(
    (pr: PullRequestSummary): void => {
      commitTarget({
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        url: pr.url,
      });
    },
    [commitTarget],
  );

  // Shared by the Linear and GitHub "connect" rows: send the user to
  // their Settings destination and close the picker so focus returns to the
  // trigger.
  const openConnectSettings = useCallback((): void => {
    openIntegrationSettings();
    closePicker();
  }, [closePicker]);

  // Bumped when the picker closes, unmounts or edits another target, so a PR
  // lookup that finishes after that never selects: a late worktree pick
  // would check out over the user's newer choice.
  const pickerSessionRef = useRef(0);
  useEffect((): void => {
    if (!isOpen) pickerSessionRef.current += 1;
  }, [isOpen]);
  useEffect(
    () => (): void => {
      pickerSessionRef.current += 1;
    },
    [workspaceId, setBranchTarget],
  );

  const handleResolvePr = useCallback(async (): Promise<void> => {
    if (!repoPath) return;
    const session = pickerSessionRef.current;
    setPrResolving(true);
    setPrResolveError(null);
    try {
      const pr = await window.api.resolvePullRequest({
        repoPath,
        reference: search.trim(),
      });
      if (pickerSessionRef.current !== session) return;
      commitTarget({
        kind: 'pr',
        number: pr.number,
        title: pr.title,
        headRefName: pr.headRefName,
        url: pr.url,
      });
    } catch (err: unknown) {
      setPrResolveError(extractIpcErrorMessage(err));
    } finally {
      setPrResolving(false);
    }
  }, [repoPath, search, commitTarget]);

  // Personal repository projects must start in Personal scope. Switch before
  // opening the prefilled dialog so organization mode never renders or creates
  // a Personal draft (CAN-3453).
  const handleOfferAddWorkspace = useCallback((): void => {
    if (!noWorkspaceMatch) return;
    const openPersonalCloneDialog = (): void => {
      createFromResumeOriginRef.current = workspaceId;
      setPendingCreateFromReference(search.trim());
      useNavigationStore.getState().openAddWorkspaceModal({
        initialRepoUrl: `https://github.com/${noWorkspaceMatch.owner}/${noWorkspaceMatch.repo}`,
      });
      closePicker();
    };
    const currentContext = useWorkspaceContextStore.getState().state.context;
    if (currentContext.kind !== 'organization') {
      openPersonalCloneDialog();
      return;
    }
    void useWorkspaceContextStore
      .getState()
      .setContext({ kind: 'personal' })
      .then(openPersonalCloneDialog)
      .catch((error: unknown): void => {
        setPrResolveError(extractIpcErrorMessage(error));
      });
  }, [
    noWorkspaceMatch,
    workspaceId,
    search,
    setPendingCreateFromReference,
    closePicker,
  ]);

  // Resume handoff: once the Add Workspace modal reports a created workspace,
  // the host selects it in the composer (switching `workspaceId`). Only then —
  // when the active workspace differs from the one the offer row was triggered
  // from — do we consume the stashed reference: reopen the picker, which the
  // open-time effect below re-seeds onto the PRs tab with the reference in the
  // search box so the new workspace's PR list surfaces the matching row.
  useEffect(() => {
    if (!pendingCreateFromReference) return;
    if (createFromResumeOriginRef.current === workspaceId) return;
    createFromResumeOriginRef.current = null;
    pendingResumeReferenceRef.current = pendingCreateFromReference;
    setPendingCreateFromReference(null);
    setIsOpen(true);
  }, [
    pendingCreateFromReference,
    workspaceId,
    setPendingCreateFromReference,
    setIsOpen,
  ]);

  // One-shot "open on this tab" request (the onboarding suggestions module's
  // A staged Issues-tab request seeds and briefly highlights that tab. When
  // the picker is already open, it switches in place.
  const pendingTabRequestRef = useRef<HomeBranchTab | null>(null);
  const pendingGrantRef = useRef<HomeBranchTab | null>(null);
  const [highlightedTab, setHighlightedTab] = useState<HomeBranchTab | null>(
    null,
  );

  /**
   * Lands a staged tab request. When Linear availability has settled this is
   * the grant decision itself: an Issues request falls back to 'new' when
   * Linear is unavailable, and only a GRANTED Issues landing highlights it.
   * While availability is still
   * loading, the requested tab is shown optimistically (the request only
   * fires from connected states, so this is the expected outcome) and the
   * grant is deferred to the settle effect below — deciding immediately
   * would conflate "loading" with "disconnected" and bounce the user's
   * first click to the New tab.
   */
  const landStagedTab = (requestedTab: HomeBranchTab): void => {
    if (requestedTab === 'issues' && !linearAvailabilitySettled) {
      setActiveTab(requestedTab);
      setActiveIndex(0);
      pendingGrantRef.current = requestedTab;
      return;
    }
    const grantedTab =
      requestedTab === 'issues' && !linearAvailable ? 'new' : requestedTab;
    setActiveTab(grantedTab);
    setActiveIndex(0);
    setHighlightedTab(grantedTab === requestedTab ? requestedTab : null);
  };

  useEffect(() => {
    if (!pendingBranchPickerRequest) return;
    useHomeComposerStore.getState().consumeBranchPickerRequest();
    const requestedTab: HomeBranchTab = pendingBranchPickerRequest.tab;
    if (isOpen) {
      landStagedTab(requestedTab);
      return;
    }
    pendingTabRequestRef.current = requestedTab;
    setIsOpen(true);
    // isOpen is deliberately not a dependency: only a new request nonce may
    // trigger this consumption, never an unrelated open/close.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingBranchPickerRequest]);

  // Resolves a deferred grant once availability settles: highlight
  // for a genuine Issues landing, or the same fall-back-to-'new' an
  // immediately-settled unavailable decision would have made. The grant is
  // abandoned if the picker closed or the user moved to
  // another tab before availability settled.
  useEffect(() => {
    if (pendingGrantRef.current === null) return;
    if (!isOpen) {
      pendingGrantRef.current = null;
      return;
    }
    if (!linearAvailabilitySettled) return;
    const requested = pendingGrantRef.current;
    pendingGrantRef.current = null;
    if (requested !== 'issues' || activeTab !== 'issues') return;
    if (linearAvailable) {
      setHighlightedTab('issues');
    } else {
      setActiveTab('new');
      setActiveIndex(0);
    }
  }, [linearAvailabilitySettled, linearAvailable, activeTab, isOpen]);

  useEffect(() => {
    if (highlightedTab === null) return;
    const timer = window.setTimeout(() => setHighlightedTab(null), 2500);
    return (): void => window.clearTimeout(timer);
  }, [highlightedTab]);

  /**
   * The active tab's rendered rows flattened into one keyboard-navigation
   * order. Disabled rows (fork PRs) are excluded so arrowing only ever lands
   * on something selectable; the Linear/GitHub "connect" rows participate like
   * any other row exactly when they are rendered.
   */
  const navOptions = useMemo((): PickerNavOption[] => {
    if (activeTab === 'new') {
      return [
        {
          key: 'new-worktree',
          onSelect: (): void => commitTarget({ kind: 'new-worktree' }),
        },
        ...filteredWorktrees.map(
          (worktree): PickerNavOption => ({
            key: `worktree:${worktree.id}`,
            onSelect: (): void =>
              commitTarget({ kind: 'worktree', worktreeId: worktree.id }),
          }),
        ),
      ];
    }
    if (activeTab === 'branches') {
      return otherBranches.map(
        (branch): PickerNavOption => ({
          key: `branch:${branch.isRemote ? 'remote' : 'local'}:${branch.name}`,
          onSelect: (): void =>
            commitTarget({
              kind: 'branch',
              branchName: branch.name,
              isRemote: branch.isRemote,
            }),
        }),
      );
    }
    if (activeTab === 'prs') {
      // Local rows first, then the GitHub search rows, matching the render.
      const options: PickerNavOption[] = [...filteredPrs, ...prSearchResults]
        .filter((pr) => !pr.isCrossRepo)
        .map(
          (pr): PickerNavOption => ({
            key: `pr:${pr.number}`,
            onSelect: (): void => commitPullRequest(pr),
          }),
        );
      if (prConnectRowVisible) {
        options.push({ key: 'pr-connect', onSelect: openConnectSettings });
      }
      if (addWorkspaceOfferVisible) {
        options.push({
          key: 'pr-add-workspace',
          onSelect: handleOfferAddWorkspace,
        });
      }
      if (prResolveRowVisible) {
        options.push({
          key: 'pr-resolve',
          onSelect: (): void => void handleResolvePr(),
        });
      }
      return options;
    }
    if (!linearAvailable) {
      return [{ key: 'issues-connect', onSelect: openConnectSettings }];
    }
    return linearResults.map(
      (ticket): PickerNavOption => ({
        key: `linear-issue:${ticket.identifier}`,
        onSelect: (): void =>
          commitTarget({
            kind: 'linear-issue',
            identifier: ticket.identifier,
            title: ticket.title,
            branchName: ticket.branchName,
          }),
      }),
    );
  }, [
    activeTab,
    filteredWorktrees,
    otherBranches,
    filteredPrs,
    prSearchResults,
    prConnectRowVisible,
    prResolveRowVisible,
    addWorkspaceOfferVisible,
    linearAvailable,
    linearResults,
    commitTarget,
    commitPullRequest,
    openConnectSettings,
    handleResolvePr,
    handleOfferAddWorkspace,
  ]);

  const navIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    navOptions.forEach((option, index) => map.set(option.key, index));
    return map;
  }, [navOptions]);
  const activeKey = navOptions[activeIndex]?.key ?? null;

  function setActiveKey(key: string): void {
    clearActiveOptionScrollIntent();
    const index = navIndexByKey.get(key);
    if (index !== undefined) setActiveIndex(index);
  }

  // Clear the previous query, restore the tab + active row for the current
  // target, and focus the search input each time the picker expands.
  useEffect(() => {
    if (!isOpen) return;
    setPrResolveError(null);
    setGithubConnected(null);
    // Each open session gets a fresh cross-repo auto-switch budget and a clean
    // no-match/offer outcome.
    switchAttemptKeyRef.current = null;
    setNoWorkspaceMatch(null);

    // Resume handoff: a pending create-from reference re-seeds the picker onto
    // the PRs tab with the reference in the search box (the newly created
    // workspace's PR fetch then surfaces the matching row). Takes precedence
    // over the normal cleared-search / restore-selected-row open behavior.
    const resumeReference = pendingResumeReferenceRef.current;
    pendingResumeReferenceRef.current = null;
    if (resumeReference) {
      setSearch(resumeReference);
      setActiveTab('prs');
      setActiveIndex(0);
      searchRef.current?.focus();
      return;
    }

    // A staged tab request (onboarding "Try it") wins over the normal
    // restore-selected-row open behavior. Grant/fallback/latch semantics —
    // including the deferred decision while availability is still loading —
    // live in `landStagedTab`.
    const requestedTab = pendingTabRequestRef.current;
    pendingTabRequestRef.current = null;
    if (requestedTab) {
      setSearch('');
      landStagedTab(requestedTab);
      searchRef.current?.focus();
      return;
    }

    setSearch('');
    const targetTab = tabForTarget(branchTarget);
    const nextTab =
      targetTab === 'issues' && !linearAvailable ? fallbackTab : targetTab;
    setActiveTab(nextTab);

    // Index within the tab's UNFILTERED option list (search was just cleared).
    const selectedKey = targetKey(branchTarget);
    const keys =
      nextTab === 'new'
        ? ['new-worktree', ...allWorktrees.map((wt) => `worktree:${wt.id}`)]
        : nextTab === 'branches'
          ? allOtherBranches.map(
              (b) => `branch:${b.isRemote ? 'remote' : 'local'}:${b.name}`,
            )
          : nextTab === 'prs'
            ? loadedPrs
                .filter((pr) => !pr.isCrossRepo)
                .map((pr) => `pr:${pr.number}`)
            : linearResults.map(
                (ticket) => `linear-issue:${ticket.identifier}`,
              );
    const restoredIndex = keys.findIndex((key) => key === selectedKey);
    // Target the restored row — see `usePickerActiveScrollIntent`: this effect
    // shares a passive flush with the scroll effect below, which first runs
    // against the stale active key.
    markActiveOptionScrollIntent(
      restoredIndex >= 0 ? keys[restoredIndex] : undefined,
    );
    setActiveIndex(restoredIndex >= 0 ? restoredIndex : 0);
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open-time snapshot only
  }, [isOpen, markActiveOptionScrollIntent]);

  // Keep the active row visible as the user arrows past the scroll edges.
  useEffect(() => {
    if (!isOpen || !activeKey) return;
    if (!consumeActiveOptionScrollIntent(activeKey)) return;
    scrollPickerOptionIntoView(listRef.current, activeKey, 'data-option-key');
  }, [isOpen, activeKey, consumeActiveOptionScrollIntent]);

  // Auto-detect on change (never effect-driven): only an UNAMBIGUOUS PR
  // reference — a full GitHub PR URL, or an explicit `#123` — jumps to the
  // PRs tab. A Linear identifier/URL jumps to Issues even without a Linear
  // key — landing on the connect prompt is the desired guidance. A bare
  // number (no `#`, no URL) never switches tabs: the search box doubles as
  // each tab's filter box, so a bare number is left as filter text — it
  // could be a Linear ticket number typed on the Issues tab, or digits used
  // to filter branches/worktrees — and on the PRs tab it still
  // exact-number-filters via `prMatchesReference`. Plain text never switches
  // tabs. Manual tab clicks always stick because nothing re-detects on
  // click.
  function handleSearchChange(value: string): void {
    const { detected, referenceQuery } = resolveCreateFromReferenceInput(
      value,
      linearAvailable,
    );
    setSearch(referenceQuery);
    setActiveIndex(0);
    // Any search edit invalidates a prior cross-repo scan outcome; the effect
    // re-runs for the new reference and re-populates it if still a no-match.
    setNoWorkspaceMatch(null);
    if (!detected) return;
    if (detected.mode === 'pr') {
      const parsedReference = parsePullRequestReference(detected.value);
      const isUnambiguousPrReference =
        (parsedReference?.owner !== undefined &&
          parsedReference?.repo !== undefined) ||
        detected.value.startsWith('#');
      if (isUnambiguousPrReference) {
        setActiveTab('prs');
      }
    } else if (detected.mode === 'linear') {
      setActiveTab('issues');
    }
  }

  function selectTab(tab: HomeBranchTab): void {
    setActiveTab(tab);
    setActiveIndex(0);
  }

  function handleTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ): void {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % pickerTabs.length;
    } else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + pickerTabs.length) % pickerTabs.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = pickerTabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = pickerTabs[nextIndex];
    selectTab(nextTab.id);
    const nextButton = tabRefs.current[nextIndex];
    nextButton?.focus();
    nextButton?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }

  function selectedLabel(): string {
    if (branchTarget.kind === 'new-worktree') {
      // Default label names the default target; a selected target replaces
      // it with the selection.
      return 'New worktree';
    }
    if (branchTarget.kind === 'worktree') {
      // Always resolve against the unfiltered list — the trigger label must
      // keep showing the selected worktree while the search narrows the list.
      const worktree = allWorktrees.find(
        (w) => w.id === branchTarget.worktreeId,
      );
      return worktree ? worktree.branchName : branchTarget.worktreeId;
    }
    if (branchTarget.kind === 'pr') {
      return `PR #${branchTarget.number}`;
    }
    if (branchTarget.kind === 'linear-issue') {
      return branchTarget.identifier;
    }
    return branchTarget.branchName;
  }

  // Trigger glyph: WorktreeIcon (arrow-split-right) for new/existing
  // worktrees, BranchIcon for branches, PR / Linear for those sources.
  const triggerIconKind: 'worktree' | 'branch' | 'pr' | 'linear' =
    branchTarget.kind === 'pr'
      ? 'pr'
      : branchTarget.kind === 'linear-issue'
        ? 'linear'
        : branchTarget.kind === 'new-worktree' ||
            branchTarget.kind === 'worktree'
          ? 'worktree'
          : 'branch';
  const triggerLabel = selectedLabel();
  // CAN-6016: a verified unborn source branch cannot start a new worktree
  // from HEAD. Absent state is unknown and shows nothing; the label stays.
  const sourceHeadUnborn = !worktreeHost && branchTargets?.headUnborn === true;
  const newWorktreeNeedsCommit =
    sourceHeadUnborn &&
    homeSendUsesSourceHead({
      projectType: project?.type,
      branchTarget: { kind: 'new-worktree' },
      newWorktreeBaseTarget: homeDraft.newWorktreeBaseTarget,
      branches: branchTargets?.branches ?? [],
      defaultBranch: branchTargets?.defaultBranch,
    });
  const selectionNeedsCommit =
    sourceHeadUnborn &&
    homeSendUsesSourceHead({
      projectType: project?.type,
      branchTarget,
      newWorktreeBaseTarget: homeDraft.newWorktreeBaseTarget,
      branches: branchTargets?.branches ?? [],
      defaultBranch: branchTargets?.defaultBranch,
    });

  function renderPullRequestOption(pr: PullRequestSummary): JSX.Element {
    const key = `pr:${pr.number}`;
    return (
      <PullRequestPickerOption
        key={pr.number}
        pullRequest={pr}
        optionKey={key}
        optionId={`home-branch-picker-option-${key}`}
        testId={`home-branch-picker-pr-${pr.number}`}
        active={activeKey === key}
        selected={
          branchTarget.kind === 'pr' && branchTarget.number === pr.number
        }
        onSelect={() => commitPullRequest(pr)}
        onActivate={() => setActiveKey(key)}
      />
    );
  }

  const searchPlaceholder =
    activeTab === 'prs'
      ? 'Search pull requests…'
      : activeTab === 'branches'
        ? 'Search branches…'
        : activeTab === 'issues'
          ? 'Search Linear issues…'
          : 'Search worktrees…';

  const menu = (
    <Picker
      id="home-branch-picker-menu"
      open={isOpen}
      onOpenChange={setIsOpen}
      anchorRef={worktreeHost?.anchorRef ?? buttonRef}
      returnFocusRef={worktreeHost?.anchorRef}
      placement="bottom-left"
      minimumWidth="18.5rem"
      heightLimit={384}
      initialFocusRef={searchRef}
      role="dialog"
      aria-modal="false"
      aria-label="Select branch target"
      data-testid={worktreeHost?.['data-testid'] ?? 'home-branch-picker-menu'}
    >
      <PickerSearchHeader>
        <PickerSearchCombobox
          ref={searchRef}
          type="text"
          value={search}
          onChange={(event) => handleSearchChange(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          keyboard={{
            keys: navOptions.map(({ key }) => key),
            activeKey,
            onActiveKeyChange: (key) => {
              markActiveOptionScrollIntent();
              setActiveIndex(
                navOptions.findIndex((option) => option.key === key),
              );
            },
            onPick: (key) =>
              navOptions.find((option) => option.key === key)?.onSelect(),
            onEscape: closePicker,
          }}
          listId="home-branch-picker-options"
          activeDescendant={
            activeKey ? `home-branch-picker-option-${activeKey}` : undefined
          }
          data-testid="home-branch-picker-search"
        />
      </PickerSearchHeader>

      <PickerTabList aria-label="Branch target sources">
        {pickerTabs.map((tab, index) => {
          const isActive = activeTab === tab.id;
          return (
            <PickerTab
              key={tab.id}
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              id={`home-branch-picker-tab-${tab.id}-control`}
              role="tab"
              aria-selected={isActive}
              aria-controls="home-branch-picker-options"
              aria-label={tab.ariaLabel}
              tabIndex={isActive ? 0 : -1}
              active={isActive}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
              data-testid={tab.testid}
              highlighted={highlightedTab === tab.id}
            >
              {tab.label}
            </PickerTab>
          );
        })}
      </PickerTabList>

      <PickerList
        ref={listRef}
        id="home-branch-picker-options"
        aria-label="Select branch target"
        aria-labelledby={`home-branch-picker-tab-${activeTab}-control`}
        data-testid="home-branch-picker-list"
      >
        {activeTab === 'new' && (
          <PickerOption
            role="option"
            id="home-branch-picker-option-new-worktree"
            aria-selected={branchTarget.kind === 'new-worktree'}
            tabIndex={-1}
            onClick={() => commitTarget({ kind: 'new-worktree' })}
            onMouseEnter={() => setActiveKey('new-worktree')}
            data-testid="home-branch-picker-new-worktree"
            active={activeKey === 'new-worktree'}
            selected={branchTarget.kind === 'new-worktree'}
          >
            <PickerOptionLeading>
              <WorktreeIcon />
            </PickerOptionLeading>
            <PickerOptionContent>
              <PickerOptionLabel>New worktree</PickerOptionLabel>
              {newWorktreeNeedsCommit && (
                <PickerOptionDescription data-testid="home-branch-picker-new-worktree-no-commits">
                  {SOURCE_NO_COMMITS_HINT}
                </PickerOptionDescription>
              )}
            </PickerOptionContent>
            <PickerOptionCheck
              selected={branchTarget.kind === 'new-worktree'}
            />
          </PickerOption>
        )}

        <>
          {activeTab === 'new' && (
            <>
              {filteredWorktrees.length === 0 && (
                <PickerState data-testid="home-branch-picker-empty">
                  No matching worktrees
                </PickerState>
              )}
              {filteredWorktrees.length > 0 && (
                <PickerSection>
                  <PickerSectionLabel>Existing worktrees</PickerSectionLabel>
                  {filteredWorktrees.map((worktree) => {
                    const isSelected =
                      branchTarget.kind === 'worktree' &&
                      branchTarget.worktreeId === worktree.id;
                    const key = `worktree:${worktree.id}`;
                    return (
                      <PickerOption
                        key={worktree.id}
                        role="option"
                        id={`home-branch-picker-option-${key}`}
                        aria-selected={isSelected}
                        tabIndex={-1}
                        onClick={() =>
                          commitTarget({
                            kind: 'worktree',
                            worktreeId: worktree.id,
                          })
                        }
                        onMouseEnter={() => setActiveKey(key)}
                        data-option-key={key}
                        data-testid={`home-branch-picker-worktree-${worktree.id}`}
                        active={activeKey === key}
                        selected={isSelected}
                      >
                        <PickerOptionLeading>
                          <WorktreeIcon />
                        </PickerOptionLeading>
                        <PickerOptionContent>
                          <PickerOptionLabel>
                            <span className={POSTHOG_REPLAY_MASK_CLASS}>
                              {worktree.branchName}
                            </span>
                          </PickerOptionLabel>
                        </PickerOptionContent>
                        <PickerOptionCheck selected={isSelected} />
                      </PickerOption>
                    );
                  })}
                </PickerSection>
              )}
            </>
          )}

          {activeTab === 'prs' && (
            <>
              {!repoPath && (
                <PickerState data-testid="home-branch-picker-pr-error">
                  This project has no repository to list pull requests.
                </PickerState>
              )}
              {repoPath &&
                prState?.status === 'error' &&
                !prConnectRowVisible && (
                  <PickerState data-testid="home-branch-picker-pr-error">
                    {prState.message}
                  </PickerState>
                )}
              {prConnectRowVisible && (
                <>
                  <PickerState>
                    Connect GitHub to see pull requests.
                  </PickerState>
                  <PickerOption
                    role="option"
                    id="home-branch-picker-option-pr-connect"
                    aria-selected={false}
                    tabIndex={-1}
                    onClick={openConnectSettings}
                    onMouseEnter={() => setActiveKey('pr-connect')}
                    data-option-key="pr-connect"
                    data-testid="home-branch-picker-pr-connect"
                    active={activeKey === 'pr-connect'}
                    tone="accent"
                  >
                    <PickerOptionLeading>
                      <GitHubIcon />
                    </PickerOptionLeading>
                    <PickerOptionContent>
                      <PickerOptionLabel>Connect GitHub</PickerOptionLabel>
                    </PickerOptionContent>
                    <PickerOptionCheck selected={false} />
                  </PickerOption>
                </>
              )}
              {repoPath && (!prState || prState.status === 'loading') && (
                <PickerState data-testid="home-branch-picker-pr-loading">
                  Loading pull requests…
                </PickerState>
              )}
              {repoPath && prState?.status === 'loaded' && (
                <>
                  {filteredPrs.map(renderPullRequestOption)}
                  {prSearchView.status === 'searching' && (
                    <PickerState data-testid="home-branch-picker-pr-search-loading">
                      Searching GitHub…
                    </PickerState>
                  )}
                  {prSearchView.status === 'error' && (
                    <PickerState data-testid="home-branch-picker-pr-search-error">
                      {prSearchView.message}
                    </PickerState>
                  )}
                  {prSearchResults.length > 0 && (
                    <PickerSection data-testid="home-branch-picker-pr-search-results">
                      <PickerSectionLabel>From GitHub</PickerSectionLabel>
                      {prSearchResults.map(renderPullRequestOption)}
                    </PickerSection>
                  )}
                  {prSearchView.status === 'loaded' &&
                    prSearchResults.length === 0 && (
                      <PickerState data-testid="home-branch-picker-pr-empty">
                        No matching open pull requests
                      </PickerState>
                    )}
                  {prSearchView.status === 'idle' &&
                    filteredPrs.length === 0 &&
                    !showPrResolveRow && (
                      <PickerState data-testid="home-branch-picker-pr-empty">
                        No open pull requests
                      </PickerState>
                    )}
                </>
              )}
              {/* A foreign-repo PR URL that no eligible workspace owns:
                  offer to add that repo as a project instead of the
                  dead-end resolve row. Replaces `-pr-resolve` in this state
                  (both are gated on the list fetch settling). */}
              {addWorkspaceOfferVisible && noWorkspaceMatch && (
                <PickerOption
                  role="option"
                  id="home-branch-picker-option-pr-add-workspace"
                  aria-selected={false}
                  tabIndex={-1}
                  onClick={handleOfferAddWorkspace}
                  onMouseEnter={() => setActiveKey('pr-add-workspace')}
                  data-option-key="pr-add-workspace"
                  data-testid="home-branch-picker-pr-add-workspace"
                  active={activeKey === 'pr-add-workspace'}
                >
                  <PickerOptionLeading>
                    <GitHubIcon />
                  </PickerOptionLeading>
                  <PickerOptionContent>
                    <PickerOptionLabel>
                      Add {noWorkspaceMatch.owner}/{noWorkspaceMatch.repo} as a
                      project…
                    </PickerOptionLabel>
                  </PickerOptionContent>
                  <PickerOptionCheck selected={false} />
                </PickerOption>
              )}
              {/* Rendered outside the `loaded`-only block so paste
                  resolution stays reachable in the fetch-error state too. */}
              {prResolveRowVisible && (
                <PickerOption
                  role="option"
                  id="home-branch-picker-option-pr-resolve"
                  aria-selected={false}
                  tabIndex={-1}
                  disabled={prResolving}
                  onClick={() => void handleResolvePr()}
                  onMouseEnter={() => setActiveKey('pr-resolve')}
                  data-option-key="pr-resolve"
                  data-testid="home-branch-picker-pr-resolve"
                  active={activeKey === 'pr-resolve'}
                >
                  <PickerOptionLeading>
                    <GitHubIcon />
                  </PickerOptionLeading>
                  <PickerOptionContent>
                    <PickerOptionLabel>
                      {prResolving
                        ? 'Resolving…'
                        : `Resolve PR ${search.trim()}…`}
                    </PickerOptionLabel>
                  </PickerOptionContent>
                  <PickerOptionCheck selected={false} />
                </PickerOption>
              )}
              {(prState?.status === 'loaded' || prState?.status === 'error') &&
                prResolveError && (
                  <PickerState data-testid="home-branch-picker-pr-resolve-error">
                    {prResolveError}
                  </PickerState>
                )}
            </>
          )}

          {activeTab === 'branches' && (
            <>
              {otherBranches.length === 0 && (
                <PickerState data-testid="home-branch-picker-branches-empty">
                  No matching branches
                </PickerState>
              )}
              {otherBranches.map((branch) => {
                const isSelected =
                  branchTarget.kind === 'branch' &&
                  branchTarget.branchName === branch.name;
                const provenance = getBranchProvenanceBadge(branch);
                const key = `branch:${branch.isRemote ? 'remote' : 'local'}:${branch.name}`;
                return (
                  <PickerOption
                    key={`${branch.isRemote ? 'remote' : 'local'}-${branch.name}`}
                    role="option"
                    id={`home-branch-picker-option-${key}`}
                    aria-selected={isSelected}
                    tabIndex={-1}
                    onClick={() =>
                      commitTarget({
                        kind: 'branch',
                        branchName: branch.name,
                        isRemote: branch.isRemote,
                      })
                    }
                    onMouseEnter={() => setActiveKey(key)}
                    data-option-key={key}
                    data-testid={`home-branch-picker-branch-${branch.name}`}
                    active={activeKey === key}
                    selected={isSelected}
                  >
                    <PickerOptionLeading>
                      <BranchIcon size="md" />
                    </PickerOptionLeading>
                    <PickerOptionContent>
                      <PickerOptionLabel>{branch.name}</PickerOptionLabel>
                    </PickerOptionContent>
                    {isSelected ? (
                      <PickerOptionCheck selected />
                    ) : (
                      provenance && (
                        <PickerOptionTrailing
                          aria-label={
                            provenance === 'local'
                              ? LOCAL_BRANCH_TOOLTIP
                              : REMOTE_BRANCH_TOOLTIP
                          }
                          interactive
                        >
                          <Tooltip
                            label={
                              provenance === 'local'
                                ? LOCAL_BRANCH_TOOLTIP
                                : REMOTE_BRANCH_TOOLTIP
                            }
                            placement="right"
                            tone="inverse"
                          >
                            <span
                              className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:!h-4 [&>svg]:!w-4"
                              data-testid={
                                provenance === 'local'
                                  ? `home-branch-picker-local-badge-${branch.name}`
                                  : `home-branch-picker-remote-badge-${branch.name}`
                              }
                            >
                              {provenance === 'local' ? (
                                <MacbookIcon />
                              ) : (
                                <GlobeIcon />
                              )}
                            </span>
                          </Tooltip>
                        </PickerOptionTrailing>
                      )
                    )}
                  </PickerOption>
                );
              })}
            </>
          )}

          {activeTab === 'issues' && (
            <>
              {!linearAvailable && (
                <>
                  <PickerState>Linear tasks require an API key.</PickerState>
                  <PickerOption
                    role="option"
                    id="home-branch-picker-option-issues-connect"
                    aria-selected={false}
                    tabIndex={-1}
                    onClick={openConnectSettings}
                    onMouseEnter={() => setActiveKey('issues-connect')}
                    data-option-key="issues-connect"
                    data-testid="home-branch-picker-issues-connect"
                    active={activeKey === 'issues-connect'}
                    tone="accent"
                  >
                    <PickerOptionLeading>
                      <LinearIcon size="md" />
                    </PickerOptionLeading>
                    <PickerOptionContent>
                      <PickerOptionLabel>Connect Linear</PickerOptionLabel>
                    </PickerOptionContent>
                    <PickerOptionCheck selected={false} />
                  </PickerOption>
                </>
              )}
              {linearAvailable && linearSearching && (
                <PickerState data-testid="home-branch-picker-issue-loading">
                  Searching Linear…
                </PickerState>
              )}
              {linearAvailable &&
                !linearSearching &&
                search.trim().length === 0 && (
                  <PickerState>Search Linear by id or title…</PickerState>
                )}
              {linearAvailable &&
                !linearSearching &&
                search.trim().length > 0 &&
                linearResults.length === 0 && (
                  <PickerState data-testid="home-branch-picker-issue-empty">
                    No matching tickets
                  </PickerState>
                )}
              {linearAvailable &&
                linearResults.map((ticket) => {
                  const isSelected =
                    branchTarget.kind === 'linear-issue' &&
                    branchTarget.identifier === ticket.identifier;
                  const key = `linear-issue:${ticket.identifier}`;
                  return (
                    <PickerOption
                      key={ticket.id}
                      role="option"
                      id={`home-branch-picker-option-${key}`}
                      aria-selected={isSelected}
                      tabIndex={-1}
                      onClick={() =>
                        commitTarget({
                          kind: 'linear-issue',
                          identifier: ticket.identifier,
                          title: ticket.title,
                          branchName: ticket.branchName,
                        })
                      }
                      onMouseEnter={() => setActiveKey(key)}
                      data-option-key={key}
                      data-testid={`home-branch-picker-issue-${ticket.identifier}`}
                      active={activeKey === key}
                      selected={isSelected}
                    >
                      <PickerOptionLeading>
                        <LinearIcon size="md" />
                      </PickerOptionLeading>
                      <PickerOptionContent>
                        <PickerOptionLabel>
                          <WordBoundaryTruncatedText
                            text={ticket.title}
                            hoverTitle
                            data-testid="home-branch-picker-issue-title"
                            className="block"
                          />
                        </PickerOptionLabel>
                        <PickerOptionDescription>
                          {ticket.identifier}
                        </PickerOptionDescription>
                      </PickerOptionContent>
                      <PickerOptionCheck selected={isSelected} />
                    </PickerOption>
                  );
                })}
            </>
          )}
        </>
      </PickerList>
    </Picker>
  );

  if (worktreeHost) return menu;

  return (
    <div data-testid="home-branch-picker" className="relative">
      <PickerTrigger
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        data-testid="home-branch-picker-button"
        aria-label={
          selectionNeedsCommit
            ? `${triggerLabel}. ${SOURCE_NO_COMMITS_HINT}`
            : triggerLabel
        }
        data-source-no-commits={selectionNeedsCommit || undefined}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? 'home-branch-picker-menu' : undefined}
        variant="capsule"
        className="max-w-52"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span
            data-testid="home-branch-picker-source-icons"
            data-icon={triggerIconKind}
            className="flex items-center justify-center fg-tertiary"
            aria-hidden="true"
          >
            {triggerIconKind === 'pr' ? (
              <GitPullRequestIcon size="sm" />
            ) : triggerIconKind === 'linear' ? (
              <LinearIcon size="md" />
            ) : triggerIconKind === 'worktree' ? (
              <WorktreeIcon size="sm" />
            ) : (
              <BranchIcon size="sm" />
            )}
          </span>
          <span className="min-w-0 flex-1 truncate fg-primary">
            {triggerLabel}
          </span>
        </span>
        <PickerTriggerChevron open={isOpen} />
      </PickerTrigger>

      {menu}
    </div>
  );
}
