import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type JSX,
  type ReactNode,
  type SetStateAction,
} from 'react';
import type {
  ExternalProjectCandidate,
  ExternalProjectDiscoverResponse,
  ExternalProjectImportResponse,
  ExternalProjectProvider,
} from '@canopy/desktop-shared/types';
import { Button, Checkbox, Notice } from '@canopy/ui-shared/components';
import { FolderIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatCompactAge } from '@canopy/ui-shared/lib';
import { SourceBranchCommitHint } from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { FirstRunAccountRowHost } from '@/components/onboarding/FirstRunAccountRowHost';
import { FirstRunProviderGroup } from '@/components/onboarding/FirstRunProviderGroup';
import { ProviderAuthPanel } from '@/components/auth/ProviderAuthPanel';
import {
  bulkSelection,
  CODE_REPOSITORY_DETAIL,
  isBulkSelectable,
  isDirectPick,
  isCurrentSelection,
  isPickerCandidate,
  isRepositoryParent,
  orderPickedGroups,
  pickedSummary,
  PLAIN_FOLDER_DETAIL,
  reconcileSelection,
  selectAllExclusive,
  selectExclusive,
  type PickedSummary,
} from '@/components/import-projects/pickedFolders';
import {
  detectedSources,
  importSourcesLabel,
  OTHER_TOOLS_LABEL,
  sourceProjects,
} from '@/components/import-projects/importProjectsCopy';
import { ImportLocation } from '@/components/import-projects/ImportLocation';
import { ImportSourceLogos } from '@/components/import-projects/ImportSourceLogos';
import {
  SettingsGroup,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { offerCursorRulesReview } from '@/lib/cursorRulesOffer';
import {
  agentConnectionsIntro,
  PROVIDER_ROW_DESCRIPTIONS,
} from '@canopy/ui-app/onboarding';
import { brandText } from '@/lib/brand';
import {
  captureProjectImportSubmission,
  openImportedProject,
  type ProjectImportSubmission,
} from '@/lib/importedProjectNavigation';
import {
  createFirstRunImportVisit,
  providerConnection,
  startProjectImportSubmission,
  UNKNOWN_IMPORT_SCAN,
  type ImportScanState,
  type ProjectImportResultCounts,
  type ProviderConnections,
} from '@/lib/projectImportTelemetry';
import { useProjectsStore } from '@/stores/projectsStore';

/**
 * Prototype first-run page (v0): import projects from the tools found on this
 * computer (Claude, Codex, T3 Code, OpenCode), confirm
 * the signed-in providers, and land in a chat. Replaces the old wizard once
 * the UX settles.
 */

export const FIRST_RUN_IMPORT_MARKER = 'first-run-import-v0';

const OLD_PROJECT_MS = 90 * 24 * 60 * 60 * 1000;

function activityMs(value: string | null): number {
  return value ? Date.parse(value) : 0;
}

function isRecent(candidate: ExternalProjectCandidate): boolean {
  return Date.now() - activityMs(candidate.lastActivityAt) < OLD_PROJECT_MS;
}

// shortcut: detects Claude Desktop folder-less Cowork sessions by path, since
// the scan DTO does not flag them; add a field to the candidate when hardening.
function isScratchSession(candidate: ExternalProjectCandidate): boolean {
  return candidate.rootPath.includes('local-agent-mode-sessions');
}

function RowDetail({
  candidate,
  now,
}: {
  candidate: ExternalProjectCandidate;
  now: number;
}): JSX.Element {
  // A picked folder says what kind it is, ahead of any chat history.
  const pickedType = isPickerCandidate(candidate)
    ? candidate.kind === 'git'
      ? CODE_REPOSITORY_DETAIL
      : PLAIN_FOLDER_DETAIL
    : null;
  const activity = candidate.lastActivityAt
    ? formatCompactAge(candidate.lastActivityAt, now)
    : pickedType === null
      ? 'No chat history'
      : null;
  return (
    <ImportLocation
      rootPath={candidate.rootPath}
      suffix={
        <>
          {pickedType !== null && (
            <span className="shrink-0">· {pickedType}</span>
          )}
          {/* Advisory only: the repository stays selectable and importable. */}
          {candidate.kind === 'git' && (
            <SourceBranchCommitHint
              headUnborn={candidate.headUnborn}
              className="shrink-0"
              testId={`first-run-import-row-no-commits-${candidate.id}`}
              leadingSeparator
            />
          )}
          {activity !== null && <span className="shrink-0">· {activity}</span>}
        </>
      }
    />
  );
}

async function markFirstRunDone(): Promise<void> {
  const prefs = await window.api.loadPreferences();
  const prior = Array.isArray(prefs.onboardingCompleted)
    ? prefs.onboardingCompleted
    : [];
  if (!prior.includes(FIRST_RUN_IMPORT_MARKER)) {
    await window.api.savePreferences({
      onboardingCompleted: [...prior, FIRST_RUN_IMPORT_MARKER],
    });
  }
}

// A folder holding repositories, or one whose scan is uncertain, waits for an
// explicit choice; so does a repository found inside a picked folder.
function initialSelection(
  response: ExternalProjectDiscoverResponse,
  include: (candidate: ExternalProjectCandidate) => boolean,
): Set<string> {
  return reconcileSelection(
    response.candidates.map((c) => c.id),
    response.candidates,
    (c) => c.status === 'available' && isBulkSelectable(c) && include(c),
  );
}

// Names the projects that didn't import, for the page's error.
function failedImportMessage(response: ExternalProjectImportResponse): string {
  const failed = response.results.filter(
    (result) => result.status !== 'imported',
  );
  if (failed.length === 0 || failed.length > 2)
    return "Couldn't import those projects. Try again.";
  const names = failed.map((result) => result.displayName).join(' and ');
  return `Couldn't import ${names}. Try again.`;
}

function importedWorkspaceIds(
  response: ExternalProjectImportResponse,
  order: string[],
): string[] {
  // Results follow selection order, which is not recency; sort by `order`.
  return response.results
    .filter((result) => result.status === 'imported' && result.workspaceId)
    .sort((a, b) => order.indexOf(a.candidateId) - order.indexOf(b.candidateId))
    .flatMap((result) => (result.workspaceId ? [result.workspaceId] : []));
}

// New projects have no worktrees yet; collapsed, they don't each show a
// "No worktrees" row in the sidebar.
async function collapseInSidebar(workspaceIds: string[]): Promise<void> {
  const projects = useProjectsStore.getState();
  await projects.loadProjects({ silent: true });
  const imported = new Set(workspaceIds);
  for (const item of useProjectsStore.getState().projects) {
    if (imported.has(item.id) && !item.collapsed)
      await projects.toggleCollapsed(item.id);
  }
}

const PROJECTS_DESCRIPTION =
  'A project is a folder you work in. Its chats, settings, and instructions stay together.';

// `formatCompactAge` buckets, spelled out as singular and plural words.
const AGE_UNIT_WORDS = new Map<string, readonly [string, string]>([
  ['m', ['minute', 'minutes']],
  ['h', ['hour', 'hours']],
  ['d', ['day', 'days']],
  ['w', ['week', 'weeks']],
  ['mo', ['month', 'months']],
  ['y', ['year', 'years']],
]);

interface WordedAge {
  readonly value: number;
  readonly unit: readonly [string, string];
}

function wordedAge(timestamp: number, now: number): WordedAge | null {
  const match = /^(\d+)(mo|m|h|d|w|y)$/.exec(formatCompactAge(timestamp, now));
  const unit = AGE_UNIT_WORDS.get(match?.[2] ?? '');
  if (!match || !unit) return null;
  return { value: Number(match[1]), unit };
}

function ageWords({ value, unit }: WordedAge): string {
  return `${value} ${value === 1 ? unit[0] : unit[1]}`;
}

// Newest to oldest, sharing the unit only when both ends use it:
// `3–5 months`, `3 months`, or `11 months–1 year`.
function ageRange(newest: WordedAge, oldest: WordedAge): string {
  if (newest.unit !== oldest.unit)
    return `${ageWords(newest)}–${ageWords(oldest)}`;
  if (newest.value === oldest.value) return ageWords(oldest);
  return `${newest.value}–${oldest.value} ${oldest.unit[1]}`;
}

/**
 * Says what was found when every project is older, such as `Found 3 Claude
 * projects · last used 3–5 months ago`. Tools are named only when every
 * project has one and there are at most two of them, and the age covers only
 * parseable activity.
 */
function foundProjectsDescription(
  importable: ExternalProjectCandidate[],
  now: number,
): string {
  const count = importable.length;
  const label = importable.every((c) => c.providers.length > 0)
    ? importSourcesLabel(importable.flatMap((c) => c.providers))
    : OTHER_TOOLS_LABEL;
  const harnesses = label === OTHER_TOOLS_LABEL ? '' : label;
  const found = `Found ${count} ${harnesses ? `${harnesses} ` : ''}${count === 1 ? 'project' : 'projects'}`;
  const known = importable
    .filter((c) => c.lastActivityAt)
    .map((c) => activityMs(c.lastActivityAt))
    .filter((ms) => Number.isFinite(ms));
  if (known.length === 0) return found;
  const newest = wordedAge(Math.max(...known), now);
  const oldest = wordedAge(Math.min(...known), now);
  if (!newest || !oldest) return found;
  const lead = known.length === count ? 'last used' : 'known activity';
  return `${found} · ${lead} ${ageRange(newest, oldest)} ago`;
}

/**
 * What the Projects box holds: the scan running, the scan failed (its error
 * shows by the actions), what it found, or nothing to import.
 */
type ProjectsBody =
  | { readonly kind: 'scanning' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'candidates';
      readonly importable: ExternalProjectCandidate[];
    }
  | { readonly kind: 'empty' };

function CandidateRows({
  importable,
  allOlder,
  selected,
  setSelected,
  expanded,
  setExpanded,
  now,
}: {
  importable: ExternalProjectCandidate[];
  allOlder: boolean;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  now: number;
}): JSX.Element {
  // Recent projects start checked and always show, so nothing checked is
  // hidden; older ones start unchecked behind the toggle. When none is
  // recent, every project shows unchecked and there is no toggle (CAN-4712).
  // A picked folder's rows always show, checked or not (CAN-5487).
  const visible =
    expanded || allOlder
      ? importable
      : importable.filter(
          (c) => isRecent(c) || selected.has(c.id) || isPickerCandidate(c),
        );
  const hiddenCount = importable.length - visible.length;
  // Select all skips folders holding repositories and uncertain picks.
  const bulk = bulkSelection(visible);
  const allOn =
    bulk.size > 0 && Array.from(bulk).every((id) => selected.has(id));
  const toggle = (id: string): void =>
    setSelected((current) => {
      if (!current.has(id)) return selectExclusive(current, id, importable);
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  const toggleAll = (): void =>
    setSelected((current) => {
      if (!allOn) return selectAllExclusive(current, bulk, importable);
      const next = new Set(current);
      for (const id of bulk) next.delete(id);
      return next;
    });
  return (
    <>
      {visible.length > 1 && (
        <SettingsRow
          dataTestId="first-run-import-select-all"
          label="Select all"
          htmlFor="first-run-select-all"
          control={
            <Checkbox
              id="first-run-select-all"
              checked={allOn}
              disabled={bulk.size === 0}
              onChange={toggleAll}
            />
          }
        />
      )}
      {visible.map((candidate) => (
        <SettingsRow
          key={candidate.id}
          dataTestId={`first-run-import-row-${candidate.id}`}
          label={
            isRepositoryParent(candidate) ? (
              // Secondary, not disabled: the folder is still a valid choice.
              <span className="block min-w-0 truncate fg-secondary">
                Add{' '}
                <span className={POSTHOG_REPLAY_MASK_CLASS}>
                  {candidate.displayName}
                </span>{' '}
                as a plain folder
              </span>
            ) : (
              <span className="flex min-w-0 items-center gap-2">
                <span className={`truncate ${POSTHOG_REPLAY_MASK_CLASS}`}>
                  {candidate.displayName}
                </span>
                <ImportSourceLogos
                  providers={candidate.providers}
                  dataTestId="first-run-import-row-tools"
                />
              </span>
            )
          }
          description={<RowDetail candidate={candidate} now={now} />}
          htmlFor={`first-run-${candidate.id}`}
          control={
            <Checkbox
              id={`first-run-${candidate.id}`}
              checked={selected.has(candidate.id)}
              onChange={(): void => toggle(candidate.id)}
            />
          }
        />
      ))}
      {!allOlder && (expanded || hiddenCount > 0) && (
        <Button
          data-testid="first-run-import-older"
          size="compact"
          variant="ghost"
          className="self-start"
          onClick={(): void => setExpanded(!expanded)}
        >
          {expanded
            ? 'Hide older projects'
            : `Show ${hiddenCount} older ${hiddenCount === 1 ? 'project' : 'projects'}`}
        </Button>
      )}
    </>
  );
}

/**
 * The Projects box, from the first render: it is as tall as its rows, up to
 * the page under the providers, past which its rows scroll inside it, and
 * the page's actions sit at its bottom, so finishing the scan or showing
 * older projects never pushes them out of view (CAN-4679).
 */
function PickedSummaryText({
  summary,
}: {
  summary: PickedSummary;
}): JSX.Element {
  return (
    // One run of sentences, not a line per fact.
    <span data-testid="first-run-import-picked-summary">
      {summary.lines.map((line, index) => (
        <span key={line.key}>
          {index > 0 && ' '}
          {line.lead}
          {line.name !== null && (
            <span className={POSTHOG_REPLAY_MASK_CLASS}>{line.name}</span>
          )}
          {line.tail}.
        </span>
      ))}
      {summary.notes.map((note) => (
        <span key={note}> {note}.</span>
      ))}
    </span>
  );
}

function ProjectsSection({
  body,
  picked,
  selected,
  setSelected,
  chooseFolder,
  actions,
}: {
  body: ProjectsBody;
  /** What the picked folders found; it outranks the generic description. */
  picked: PickedSummary | null;
  selected: Set<string>;
  setSelected: Dispatch<SetStateAction<Set<string>>>;
  chooseFolder: () => void;
  actions: ReactNode;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const now = Date.now();
  // Picked rows always show, so they count as recent here.
  const allOlder =
    body.kind === 'candidates' &&
    !body.importable.some((c) => isRecent(c) || isPickerCandidate(c));
  return (
    <SettingsSection
      fill
      title="Projects"
      description={
        picked ? (
          <PickedSummaryText summary={picked} />
        ) : allOlder ? (
          foundProjectsDescription(body.importable, now)
        ) : (
          PROJECTS_DESCRIPTION
        )
      }
      dataTestId="first-run-import-projects"
    >
      <SettingsGroup fill>
        {/* The box pads its direct children. Only the inner rows own the
            list's vertical padding, so its last control stays scrollable.
            The list grows up to its rows' height and scrolls past it, so
            the box never holds blank space. */}
        <div
          data-testid="first-run-import-list"
          className="settings-fill-list -mx-4 px-4 scroll-py-1 list-scroll-gutter"
          style={{ paddingBlock: 0 }}
        >
          <SettingsGroup surface="plain">
            {body.kind === 'scanning' && (
              <SettingsLoading
                rows={2}
                dataTestId="first-run-import-projects-loading"
              />
            )}
            {body.kind === 'candidates' && (
              <CandidateRows
                importable={body.importable}
                allOlder={allOlder}
                selected={selected}
                setSelected={setSelected}
                expanded={expanded}
                setExpanded={setExpanded}
                now={now}
              />
            )}
            {body.kind === 'empty' && (
              <SettingsRow
                dataTestId="first-run-import-empty"
                label={
                  <span className="inline-flex items-center gap-2">
                    <FolderIcon size="sm" className="shrink-0" aria-hidden />
                    Add a project
                  </span>
                }
                description="Add the folder you want to work in"
                control={
                  <Button
                    data-testid="first-run-import-choose-folder"
                    size="compact"
                    variant="primary"
                    onClick={chooseFolder}
                  >
                    Choose a folder
                  </Button>
                }
              />
            )}
          </SettingsGroup>
        </div>
        <div
          data-testid="first-run-import-actions"
          className="flex shrink-0 flex-col gap-3"
        >
          {actions}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}

function pageDescription(
  scan: ExternalProjectDiscoverResponse | null,
  foundAny: boolean,
): string | undefined {
  if (scan === null) return 'Finding your recent work…';
  return foundAny
    ? 'Import your work. Source folders stay where they are, and nothing runs until you start it.'
    : undefined;
}

export function FirstRunImportPage({
  onDone,
}: {
  onDone: () => void;
}): JSX.Element {
  const claude = useClaudeAuthStatus();
  const codex = useCodexAuthStatus();
  const [scan, setScan] = useState<ExternalProjectDiscoverResponse | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanFailed, setScanFailed] = useState(false);
  const importing = useRef(false);
  const mounted = useRef(false);
  // Latest pick wins: a slower earlier scan never replaces a newer one.
  const pickRequest = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void window.api.externalProjects
      .discover({})
      .then((response) => {
        if (cancelled || pickRequest.current > 0) return;
        setScan(response);
        setSelected(
          initialSelection(
            response,
            (c) => !isScratchSession(c) && isRecent(c),
          ),
        );
      })
      .catch(async () => {
        if (cancelled || pickRequest.current > 0) return;
        setScanFailed(true);
        // Names the tools found on this computer; without that answer it
        // says "projects from other tools".
        const found = await window.api.externalProjects
          .readProviderPresence()
          .then((presence) => detectedSources(presence.providers))
          .catch((presenceError: unknown): ExternalProjectProvider[] => {
            reportClientAppError(presenceError);
            return [];
          });
        if (cancelled || pickRequest.current > 0) return;
        setError(
          `Couldn't look for ${sourceProjects(importSourcesLabel(found))}. Try again.`,
        );
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  const importable = useMemo(
    () =>
      orderPickedGroups(
        (scan?.candidates ?? []).filter(
          (candidate) =>
            candidate.status === 'available' && !isScratchSession(candidate),
        ),
        (a, b) =>
          activityMs(b.lastActivityAt) - activityMs(a.lastActivityAt) ||
          a.displayName.localeCompare(b.displayName) ||
          a.rootPath.localeCompare(b.rootPath),
      ),
    [scan],
  );
  // Built from every picked folder before availability filtering.
  const picked = useMemo(
    () =>
      scan
        ? pickedSummary(
            scan.candidates,
            new Set(importable.map((candidate) => candidate.id)),
          )
        : null,
    [scan, importable],
  );

  // Telemetry only (CAN-4635): one visit per mount, so effect replay keeps
  // it and a real remount starts a new one.
  const [visit] = useState(createFirstRunImportVisit);
  const connections: ProviderConnections = {
    claude: providerConnection(claude),
    codex: providerConnection(codex),
  };
  // A failed folder rescan keeps the earlier scan on screen, so it stays
  // the scan reported.
  const scanState: ImportScanState = scan
    ? { kind: 'completed', scan, found: importable }
    : scanFailed
      ? { kind: 'failed' }
      : UNKNOWN_IMPORT_SCAN;
  const latest = useRef({ connections, scanState });
  useEffect(() => {
    latest.current = { connections, scanState };
  });
  useEffect(() => {
    mounted.current = true;
    visit.begin(latest.current.connections);
    return (): void => {
      mounted.current = false;
    };
  }, [visit]);

  const finish = async (imported?: {
    submission: ProjectImportSubmission;
    workspaceId: string;
  }): Promise<void> => {
    if (mounted.current)
      visit.complete(latest.current.scanState, latest.current.connections);
    await markFirstRunDone().catch((): void => {});
    onDone();
    if (imported)
      await openImportedProject(imported.submission, imported.workspaceId);
  };

  const runImport = async (): Promise<void> => {
    if (!scan || selected.size === 0 || importing.current) return;
    if (
      !isCurrentSelection(
        selected,
        importable,
        (candidate) => candidate.status === 'available',
      )
    ) {
      setSelected(
        reconcileSelection(
          selected,
          importable,
          (candidate) => candidate.status === 'available',
        ),
      );
      setError('Your project choices changed. Review them before importing.');
      return;
    }
    const selectedIds = Array.from(selected);
    importing.current = true;
    const submission = captureProjectImportSubmission();
    const tracking =
      selectedIds.length > 0
        ? startProjectImportSubmission({
            surface: { source: 'first_run', connections },
            scan: scanState,
            selectedIds,
            pickedFolder: visit.pickedFolder,
          })
        : null;
    let recorded: ProjectImportResultCounts | null = null;
    setBusy(true);
    setError(null);
    try {
      const response = await window.api.externalProjects.importProjects({
        scanId: scan.scanId,
        selections: selectedIds.map((candidateId) => ({
          candidateId,
          // shortcut: projects only until import keeps each chat's worktree
          // and uncommitted changes; chats now would land on the default branch.
          importChats: false,
        })),
      });
      if (tracking) {
        recorded = tracking.settle(response);
        visit.recordSubmission(recorded);
      }
      const workspaceIds = importedWorkspaceIds(
        response,
        importable.map((candidate) => candidate.id),
      );
      const [first] = workspaceIds;
      if (first === undefined) {
        // Nothing imported: stay here so the member can retry or skip.
        setError(failedImportMessage(response));
        setBusy(false);
        return;
      }
      // Cosmetic: the projects are imported even if the sidebar can't fold.
      await collapseInSidebar(workspaceIds).catch((): void => {});
      // Imported repositories with Cursor rules get the review offered as
      // soon as the member lands in the app (CAN-2053).
      void offerCursorRulesReview(
        response.results.flatMap((item) =>
          item.status === 'imported' && item.workspaceId
            ? [{ workspaceId: item.workspaceId, displayName: item.displayName }]
            : [],
        ),
        'first-run-import',
      );
      // Land in the most recently active imported project (CAN-4674).
      await finish({ submission, workspaceId: first });
    } catch {
      // A failure after the response was recorded is not a request failure.
      if (tracking && recorded === null)
        visit.recordSubmission(tracking.fail());
      setError("Couldn't import projects. Try again.");
      setBusy(false);
    } finally {
      importing.current = false;
    }
  };

  const chooseFolder = (): void => {
    let request = 0;
    void window.api.externalProjects
      .pickFolder()
      .then(async (folder) => {
        if (!folder) return;
        request = ++pickRequest.current;
        visit.markPickedFolder();
        const response = await window.api.externalProjects.discover({
          customRoots: [folder],
        });
        if (request !== pickRequest.current) return;
        setScan(response);
        // Only the picked folder: the rescan also returns the default finds,
        // including hidden scratch sessions and older projects. Its root is
        // canonicalized, so match the custom-folder surface, not the path.
        // Repositories found inside it start unticked.
        setSelected(initialSelection(response, isDirectPick));
      })
      .catch(() => {
        // A failed dialog has no request; a stale scan's failure is moot.
        if (request === 0 || request === pickRequest.current)
          setError("Couldn't add that folder. Try again.");
      });
  };

  // CAN-4765: the account row always shows, so `credits_offered` is always
  // true. The field stays for schema continuity.
  useEffect(() => {
    visit.markCreditsOffered();
  }, [visit]);

  const foundAny = importable.length > 0;
  const nothingToImport = scan !== null && !foundAny;
  // Only a failed scan leaves an error with no scan to show.
  const body: ProjectsBody =
    scan === null
      ? error === null
        ? { kind: 'scanning' }
        : { kind: 'failed' }
      : foundAny
        ? { kind: 'candidates', importable }
        : { kind: 'empty' };
  return (
    <div
      className="first-run-import-page page-scroll-gutter settings-content-scroll-mask h-full w-full overflow-y-auto pt-10 wrap-anywhere"
      data-testid="first-run-import-page"
    >
      <SettingsPage
        fill
        title="Let's get started"
        description={pageDescription(scan, foundAny)}
      >
        <SettingsSection
          description={agentConnectionsIntro({ appName: brandText.appName })}
        >
          <FirstRunProviderGroup>
            <ProviderAuthPanel
              provider="claude"
              layout="row"
              unauthenticatedTone="neutral"
              signedOutDescription={PROVIDER_ROW_DESCRIPTIONS.claude}
            />
            <ProviderAuthPanel
              provider="codex"
              layout="row"
              unauthenticatedTone="neutral"
              signedOutDescription={PROVIDER_ROW_DESCRIPTIONS.codex}
            />
            <FirstRunAccountRowHost />
          </FirstRunProviderGroup>
        </SettingsSection>

        <ProjectsSection
          body={body}
          picked={picked}
          selected={selected}
          setSelected={setSelected}
          chooseFolder={chooseFolder}
          actions={
            <>
              {/* A project name can be one long word; it wraps in the box. */}
              {error && (
                <Notice
                  errorSource="first-run-import-page"
                  intent="destructive"
                >
                  <span className="wrap-anywhere">{error}</span>
                </Notice>
              )}
              {/* An import primary comes last, at the trailing edge. With
                  nothing to import, the primary is Choose a folder in the
                  Projects box. */}
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  data-testid="first-run-import-skip"
                  size="compact"
                  variant="ghost"
                  disabled={busy}
                  onClick={(): void => {
                    void finish();
                  }}
                >
                  {nothingToImport
                    ? 'Continue without a project'
                    : 'Skip for now'}
                </Button>
                {foundAny && (
                  <Button
                    data-testid="first-run-import-submit"
                    size="compact"
                    variant="primary"
                    disabled={busy || selected.size === 0}
                    onClick={(): void => {
                      void runImport();
                    }}
                  >
                    {busy
                      ? 'Importing…'
                      : selected.size === 0
                        ? 'Select a project to import'
                        : `Import ${selected.size} ${selected.size === 1 ? 'project' : 'projects'}`}
                  </Button>
                )}
              </div>
            </>
          }
        />
      </SettingsPage>
    </div>
  );
}
