import { memo, useMemo, useState, type JSX } from 'react';
import {
  Stack,
  Button,
  Chip,
  Disclosure,
  Notice,
  Surface,
} from '@canopy/ui-shared/components';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { FormField } from '@/components/pipeline/shared/FormField';
import { SelectField } from '@/components/pipeline/shared/SelectField';
import { TextField } from '@/components/pipeline/shared/TextField';
import {
  validateSplitPlan,
  computeChildLineStats,
} from '@canopy/desktop-shared/lib/pr-split-plan';
import type {
  SplitPlanIssue,
  SplitPlanIssueCode,
} from '@canopy/desktop-shared/types/pr-split-plan';
import type {
  ChildChange,
  DiffFileEntry,
  DiffHunk,
  PrDiffSnapshot,
  SplitPlan,
  SplitPlanChild,
  SplitPrPlanResponse,
} from '@canopy/desktop-shared/types/github';

export interface SplitPlanReviewPanelProps {
  projectId: string;
  worktreeId: string;
  planResponse: SplitPrPlanResponse;
  onApprove: (edited: SplitPlan) => void;
  onRegenerate: () => void;
  onCancel: () => void;
}

const TYPE_PREFIX_RE = /^(refactor|feat):/i;
const TYPE_OPTIONS = [
  { value: 'refactor', label: 'Refactor' },
  { value: 'feature', label: 'Feature' },
];
const RISK_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'med', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const ISSUE_CODE_LABELS: Record<SplitPlanIssueCode, string> = {
  'unassigned-hunk': 'Unassigned change',
  'duplicate-hunk': 'Duplicate ownership',
  'duplicate-child-index': 'Duplicate or invalid child index',
  'unknown-file': 'Unknown file',
  'unknown-hunk-index': 'Unknown hunk',
  'shared-file-not-stacked': 'Shared file not stacked',
  'dependson-forward-ref': 'Invalid dependency',
  'dependson-cycle': 'Dependency cycle',
  'binary-not-whole': 'Binary file split',
  'non-modified-not-whole': 'Whole-file change split',
  'rename-split': 'Rename split across children',
  'aggregate-mismatch': 'Line count mismatch',
  'depth-warning': 'Deep dependency chain',
  'fragment-warning': 'Fragment child',
  'multi-parent-unsupported': 'Multiple parents not supported',
};

/**
 * Renumbers children to 1..N following their current array order, and remaps
 * every `dependsOn` reference from the old index to the new index. `changes`
 * entries reference files/hunks (not child indices), so they never need
 * remapping — only `dependsOn` does.
 */
function renumberChildren(children: SplitPlanChild[]): SplitPlanChild[] {
  const oldToNew = new Map<number, number>();
  children.forEach((child, position) => {
    oldToNew.set(child.index, position + 1);
  });
  return children.map((child, position) => ({
    ...child,
    index: position + 1,
    dependsOn: child.dependsOn
      .map((dep) => oldToNew.get(dep))
      .filter((dep): dep is number => dep !== undefined)
      .sort((a, b) => a - b),
  }));
}

function moveChild(
  children: SplitPlanChild[],
  fromPosition: number,
  toPosition: number,
): SplitPlanChild[] {
  if (
    toPosition < 0 ||
    toPosition >= children.length ||
    fromPosition === toPosition
  ) {
    return children;
  }
  const next = [...children];
  const [moved] = next.splice(fromPosition, 1);
  next.splice(toPosition, 0, moved);
  return renumberChildren(next);
}

/** All hunk keys (`file#hunkIndex`, or `file#-1` for zero-hunk/binary files) owned by a change entry. */
function changeHunkKeys(change: ChildChange, file: DiffFileEntry): string[] {
  if (change.hunks === 'all') {
    if (file.hunks.length === 0) return [`${file.path}#-1`];
    return file.hunks.map((h) => `${file.path}#${h.hunkIndex}`);
  }
  return change.hunks.map((hunkIndex) => `${file.path}#${hunkIndex}`);
}

/**
 * Reassigns one file's changes (whole-file or a single hunk) from its current
 * owning child to `targetChildIndex`. Always results in the moved portion
 * being owned by exactly one child, so `unassignedHunks` stays empty.
 */
function reassignHunk(
  children: SplitPlanChild[],
  file: DiffFileEntry,
  hunkIndex: number | 'all',
  targetChildIndex: number,
): SplitPlanChild[] {
  const movedKeys =
    hunkIndex === 'all'
      ? changeHunkKeys({ file: file.path, hunks: 'all' }, file)
      : [`${file.path}#${hunkIndex}`];
  const movedKeySet = new Set(movedKeys);

  return children.map((child) => {
    let changed = false;
    const otherFileChanges: ChildChange[] = [];
    // Hunk indices of `file.path` this child still owns after removing the
    // moved portion (unaffected by this reassignment when the child isn't
    // touched at all).
    let remainingFileIndices: number[] | 'all' | null = null;

    for (const change of child.changes) {
      if (change.file !== file.path) {
        otherFileChanges.push(change);
        continue;
      }
      const ownedKeys = changeHunkKeys(change, file);
      const remainingKeys = ownedKeys.filter((key) => !movedKeySet.has(key));
      if (remainingKeys.length === ownedKeys.length) {
        // This change doesn't own any of the moved portion; keep as-is.
        remainingFileIndices = change.hunks;
        continue;
      }
      changed = true;
      if (remainingKeys.length > 0) {
        remainingFileIndices = remainingKeys.map((key) =>
          Number(key.slice(key.lastIndexOf('#') + 1)),
        );
      }
    }

    let targetFileIndices: number[] | 'all' | null = null;
    if (child.index === targetChildIndex) {
      changed = true;
      const baseIndices =
        remainingFileIndices !== null && remainingFileIndices !== 'all'
          ? remainingFileIndices
          : [];
      const addedIndices =
        hunkIndex === 'all' ? file.hunks.map((h) => h.hunkIndex) : [hunkIndex];
      const merged = Array.from(
        new Set([...baseIndices, ...addedIndices]),
      ).sort((a, b) => a - b);
      // A zero-hunk file (binary or otherwise hunk-less) is always owned whole:
      // reassigning it via the `'all'` path yields no hunk indices to merge, so
      // treat it as whole-file ownership directly. Without this the target
      // child would receive `hunks: []`, tripping `unassigned-hunk` (the
      // `file#-1` sentinel goes unowned) and `binary-not-whole`.
      const isWholeFile =
        file.hunks.length === 0 ||
        (merged.length === file.hunks.length &&
          file.hunks.every((h) => merged.includes(h.hunkIndex)));
      targetFileIndices = isWholeFile ? 'all' : merged;
    } else {
      targetFileIndices = remainingFileIndices;
    }

    if (!changed) return child;

    const nextChanges =
      targetFileIndices === null
        ? otherFileChanges
        : [...otherFileChanges, { file: file.path, hunks: targetFileIndices }];
    return { ...child, changes: nextChanges };
  });
}

/** Maps every snapshot file/hunk to its current owning child index (or -1 if unowned). */
function computeOwnership(
  snapshot: PrDiffSnapshot,
  children: SplitPlanChild[],
): Map<string, number> {
  const owners = new Map<string, number>();
  for (const child of children) {
    for (const change of child.changes) {
      const file = snapshot.files.find((f) => f.path === change.file);
      if (!file) continue;
      for (const key of changeHunkKeys(change, file)) {
        owners.set(key, child.index);
      }
    }
  }
  return owners;
}

function issuesByCode(
  issues: SplitPlanIssue[],
): Map<SplitPlanIssueCode, SplitPlanIssue[]> {
  const map = new Map<SplitPlanIssueCode, SplitPlanIssue[]>();
  for (const issue of issues) {
    const list = map.get(issue.code);
    if (list) {
      list.push(issue);
    } else {
      map.set(issue.code, [issue]);
    }
  }
  return map;
}

interface IssueBannerProps {
  issues: SplitPlanIssue[];
  severity: 'error' | 'warning';
}

function IssueBanner({
  issues,
  severity,
}: IssueBannerProps): JSX.Element | null {
  const filtered = issues.filter((issue) => issue.severity === severity);
  if (filtered.length === 0) return null;
  const grouped = issuesByCode(filtered);
  return (
    <Notice
      errorSource="split-plan-review-panel"
      intent={severity === 'error' ? 'destructive' : 'attention'}
      data-testid={`split-plan-${severity}-banner`}
      className=""
    >
      <Stack gap="tight">
        {Array.from(grouped.entries()).map(([code, codeIssues]) => (
          <div key={code}>
            <span className="font-medium">{ISSUE_CODE_LABELS[code]}</span>
            {codeIssues.length > 1 ? ` (${codeIssues.length})` : ''}:{' '}
            {codeIssues[0].message}
          </div>
        ))}
      </Stack>
    </Notice>
  );
}

interface HunkRowProps {
  file: DiffFileEntry;
  hunk: DiffHunk | null;
  ownerChildIndex: number;
  childOptions: { value: string; label: string }[];
  onReassign: (targetChildIndex: number) => void;
}

function HunkRow({
  file,
  hunk,
  ownerChildIndex,
  childOptions,
  onReassign,
}: HunkRowProps): JSX.Element {
  return (
    <Surface variant="group" size="small">
      <div className="flex items-start justify-between gap-2 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-2xs fg-secondary">
            {hunk ? hunk.header : '(whole file)'}
          </div>
          {hunk && (
            <>
              <pre
                className={`${POSTHOG_REPLAY_BLOCK_CLASS} mt-0.5 max-h-24 overflow-y-auto whitespace-pre-wrap break-all font-mono text-3xs fg-primary/80`}
              >
                {hunk.preview}
              </pre>
              <div className="mt-0.5 text-3xs fg-secondary">
                <span className="fg-success-strong">+{hunk.additions}</span>{' '}
                <span className="fg-destructive">-{hunk.deletions}</span>
              </div>
            </>
          )}
        </div>
        <SelectField
          aria-label={`Reassign ${file.path}${hunk ? ` hunk ${hunk.hunkIndex}` : ''}`}
          value={ownerChildIndex >= 0 ? String(ownerChildIndex) : ''}
          onChange={(e) => onReassign(Number(e.target.value))}
          options={childOptions}
          className="w-28 shrink-0 text-xs"
        />
      </div>
    </Surface>
  );
}

interface SplitPlanChangesEditorProps {
  child: SplitPlanChild;
  snapshot: PrDiffSnapshot;
  ownership: Map<string, number>;
  allChildIndices: number[];
  onReassign: (
    file: DiffFileEntry,
    hunkIndex: number | 'all',
    targetChildIndex: number,
  ) => void;
}

const SplitPlanChangesEditor = memo(function SplitPlanChangesEditor({
  child,
  snapshot,
  ownership,
  allChildIndices,
  onReassign,
}: SplitPlanChangesEditorProps): JSX.Element {
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(
    () => new Set(),
  );

  const childOptions = useMemo(
    () =>
      allChildIndices.map((index) => ({
        value: String(index),
        label: `Child ${index}`,
      })),
    [allChildIndices],
  );

  const ownedFiles = child.changes
    .map((change) => snapshot.files.find((f) => f.path === change.file))
    .filter((file): file is DiffFileEntry => file !== undefined);

  function toggleExpanded(path: string): void {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  if (ownedFiles.length === 0) {
    return <div className="text-xs italic fg-secondary">No files assigned</div>;
  }

  return (
    <div className="flex flex-col gap-1.5">
      {ownedFiles.map((file) => {
        const change = child.changes.find((c) => c.file === file.path);
        const isWholeFile = change?.hunks === 'all';
        const isExpanded = expandedFiles.has(file.path);
        const wholeFileOwner = ownership.get(`${file.path}#-1`) ?? -1;

        return (
          <Disclosure
            key={file.path}
            variant="box"
            open={isExpanded}
            onOpenChange={() => toggleExpanded(file.path)}
            dataTestId={`split-plan-changes-file-${child.index}-${file.path}`}
            label={<span className="font-mono">{file.path}</span>}
            meta={
              isWholeFile ? 'whole file' : `${change?.hunks.length} hunk(s)`
            }
          >
            <Stack gap="tight">
              {file.hunks.length === 0 ? (
                <HunkRow
                  file={file}
                  hunk={null}
                  ownerChildIndex={wholeFileOwner}
                  childOptions={childOptions}
                  onReassign={(target) => onReassign(file, 'all', target)}
                />
              ) : isWholeFile ? (
                <HunkRow
                  file={file}
                  hunk={null}
                  ownerChildIndex={child.index}
                  childOptions={childOptions}
                  onReassign={(target) => onReassign(file, 'all', target)}
                />
              ) : (
                file.hunks.map((hunk) => {
                  const owner =
                    ownership.get(`${file.path}#${hunk.hunkIndex}`) ?? -1;
                  return (
                    <HunkRow
                      key={hunk.hunkIndex}
                      file={file}
                      hunk={hunk}
                      ownerChildIndex={owner}
                      childOptions={childOptions}
                      onReassign={(target) =>
                        onReassign(file, hunk.hunkIndex, target)
                      }
                    />
                  );
                })
              )}
            </Stack>
          </Disclosure>
        );
      })}
    </div>
  );
});

interface SplitPlanChildRowProps {
  child: SplitPlanChild;
  position: number;
  total: number;
  snapshot: PrDiffSnapshot;
  ownership: Map<string, number>;
  allChildIndices: number[];
  lineStats: { additions: number; deletions: number };
  onUpdate: (index: number, updates: Partial<SplitPlanChild>) => void;
  onMoveUp: (position: number) => void;
  onMoveDown: (position: number) => void;
  onReassign: (
    file: DiffFileEntry,
    hunkIndex: number | 'all',
    targetChildIndex: number,
  ) => void;
}

const SplitPlanChildRow = memo(function SplitPlanChildRow({
  child,
  position,
  total,
  snapshot,
  ownership,
  allChildIndices,
  lineStats,
  onUpdate,
  onMoveUp,
  onMoveDown,
  onReassign,
}: SplitPlanChildRowProps): JSX.Element {
  const missingPrefix = !TYPE_PREFIX_RE.test(child.title);
  const dependsOnOptions = allChildIndices.filter((idx) => idx < child.index);

  function toggleDependsOn(depIndex: number): void {
    const next = child.dependsOn.includes(depIndex)
      ? child.dependsOn.filter((d) => d !== depIndex)
      : [...child.dependsOn, depIndex].sort((a, b) => a - b);
    onUpdate(child.index, { dependsOn: next });
  }

  return (
    <Surface
      data-testid={`split-plan-row-${child.index}`}
      variant="group"
      gap="inline"
      padding="compact"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium fg-secondary">
          [{child.index}/{total}]
        </span>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={() => onMoveUp(position)}
              disabled={position === 0}
              aria-label={`Move child ${child.index} up`}
            >
              &#8593;
            </Button>
            <Button
              variant="ghost"
              size="compact"
              iconOnly
              onClick={() => onMoveDown(position)}
              disabled={position === total - 1}
              aria-label={`Move child ${child.index} down`}
            >
              &#8595;
            </Button>
          </div>
          <span className="text-3xs fg-secondary">
            <span className="fg-success-strong">+{lineStats.additions}</span>{' '}
            <span className="fg-destructive">-{lineStats.deletions}</span>
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormField label="Title" htmlFor={`split-plan-title-${child.index}`}>
          <TextField
            id={`split-plan-title-${child.index}`}
            data-testid={`split-plan-title-${child.index}`}
            value={child.title}
            onChange={(e) => onUpdate(child.index, { title: e.target.value })}
          />
          {missingPrefix && (
            <p
              className="text-xs fg-warning"
              data-testid={`split-plan-title-warning-${child.index}`}
            >
              Title should start with &quot;refactor:&quot; or
              &quot;feat:&quot;.
            </p>
          )}
        </FormField>

        <FormField label="Type" htmlFor={`split-plan-type-${child.index}`}>
          <SelectField
            id={`split-plan-type-${child.index}`}
            data-testid={`split-plan-type-${child.index}`}
            value={child.type}
            onChange={(e) =>
              onUpdate(child.index, {
                type: e.target.value === 'feature' ? 'feature' : 'refactor',
              })
            }
            options={TYPE_OPTIONS}
          />
        </FormField>

        <FormField
          label="Test proof"
          htmlFor={`split-plan-test-${child.index}`}
        >
          <TextField
            id={`split-plan-test-${child.index}`}
            data-testid={`split-plan-test-${child.index}`}
            value={child.testProof}
            onChange={(e) =>
              onUpdate(child.index, { testProof: e.target.value })
            }
          />
        </FormField>

        <FormField label="Risk" htmlFor={`split-plan-risk-${child.index}`}>
          <SelectField
            id={`split-plan-risk-${child.index}`}
            data-testid={`split-plan-risk-${child.index}`}
            value={child.risk}
            onChange={(e) => {
              const value = e.target.value;
              const risk =
                value === 'med' || value === 'high' || value === 'low'
                  ? value
                  : 'low';
              onUpdate(child.index, { risk });
            }}
            options={RISK_OPTIONS}
          />
        </FormField>
      </div>

      {dependsOnOptions.length > 0 && (
        <Stack gap="tight">
          <span className="block text-xs font-medium fg-secondary">
            Depends on
          </span>
          <div
            className="flex flex-wrap gap-1"
            data-testid={`split-plan-dependson-${child.index}`}
          >
            {dependsOnOptions.map((depIndex) => {
              const selected = child.dependsOn.includes(depIndex);
              return (
                <Chip
                  key={depIndex}
                  onClick={() => toggleDependsOn(depIndex)}
                  selected={selected}
                  actionTestId={`split-plan-dependson-${child.index}-${depIndex}`}
                >
                  Child {depIndex}
                </Chip>
              );
            })}
          </div>
        </Stack>
      )}

      <Stack gap="tight">
        <span className="block text-xs font-medium fg-secondary">Changes</span>
        <SplitPlanChangesEditor
          child={child}
          snapshot={snapshot}
          ownership={ownership}
          allChildIndices={allChildIndices}
          onReassign={onReassign}
        />
      </Stack>
    </Surface>
  );
});

/**
 * Embeddable split-plan review UI: the editable child table, validation
 * banners, aggregate check, and the Cancel/Regenerate/Approve action row —
 * WITHOUT any dialog chrome. `SplitWorkflowView` renders this as the
 * embedded "review" workflow step. It re-seeds its local edit state whenever
 * the parent hands it a new `planResponse` identity (e.g. after Regenerate).
 */
export function SplitPlanReviewPanel({
  planResponse,
  onApprove,
  onRegenerate,
  onCancel,
}: SplitPlanReviewPanelProps): JSX.Element {
  const [plan, setPlan] = useState<SplitPlan>(() =>
    structuredClone(planResponse.plan),
  );
  // Render-time "previous value" pattern: when the parent hands us a new
  // `planResponse` (e.g. after Regenerate), reset local edit state to match
  // it instead of continuing to show edits made against the old plan. This
  // runs during render rather than in a `useEffect` so the stale plan is
  // never painted. `expandedFiles` in `SplitPlanChangesEditor` is left alone
  // — it's pure UI state keyed by file path, not derived from plan content.
  const [previousPlanResponse, setPreviousPlanResponse] =
    useState(planResponse);
  if (previousPlanResponse !== planResponse) {
    setPreviousPlanResponse(planResponse);
    setPlan(structuredClone(planResponse.plan));
  }

  const { snapshot } = planResponse;

  const validation = useMemo(
    () => validateSplitPlan(plan, snapshot),
    [plan, snapshot],
  );

  const lineStats = useMemo(
    () => computeChildLineStats(plan, snapshot),
    [plan, snapshot],
  );

  const lineStatsByIndex = useMemo(() => {
    const map = new Map<number, { additions: number; deletions: number }>();
    for (const stat of lineStats) {
      map.set(stat.index, {
        additions: stat.additions,
        deletions: stat.deletions,
      });
    }
    return map;
  }, [lineStats]);

  const aggregateAdditions = lineStats.reduce((sum, s) => sum + s.additions, 0);
  const aggregateDeletions = lineStats.reduce((sum, s) => sum + s.deletions, 0);
  const aggregateMatches =
    aggregateAdditions === snapshot.totalAdditions &&
    aggregateDeletions === snapshot.totalDeletions;

  const ownership = useMemo(
    () => computeOwnership(snapshot, plan.children),
    [snapshot, plan.children],
  );

  const allChildIndices = useMemo(
    () => plan.children.map((c) => c.index),
    [plan.children],
  );

  function handleUpdateChild(
    index: number,
    updates: Partial<SplitPlanChild>,
  ): void {
    setPlan((prev) => ({
      ...prev,
      children: prev.children.map((child) =>
        child.index === index ? { ...child, ...updates } : child,
      ),
    }));
  }

  function handleMoveUp(position: number): void {
    setPlan((prev) => ({
      ...prev,
      children: moveChild(prev.children, position, position - 1),
    }));
  }

  function handleMoveDown(position: number): void {
    setPlan((prev) => ({
      ...prev,
      children: moveChild(prev.children, position, position + 1),
    }));
  }

  function handleReassign(
    file: DiffFileEntry,
    hunkIndex: number | 'all',
    targetChildIndex: number,
  ): void {
    setPlan((prev) => ({
      ...prev,
      children: reassignHunk(prev.children, file, hunkIndex, targetChildIndex),
    }));
  }

  function handleBuildTestCommandChange(value: string): void {
    setPlan((prev) => ({ ...prev, buildTestCommand: value }));
  }

  return (
    <div
      data-testid="split-plan-panel"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex flex-col flex-1 overflow-y-auto px-5 py-3 gap-3">
        <Surface variant="group" className="">
          <div className="px-3 py-2.5">
            <div className="text-xs font-medium fg-secondary">Final goal</div>
            <div
              className="mt-0.5 text-s fg-primary"
              data-testid="split-plan-final-goal"
            >
              {plan.finalGoal}
            </div>
          </div>
        </Surface>

        <div>
          <FormField
            label="Build/test command"
            htmlFor="split-plan-build-command"
            hint="Runs after the worktree setup script finishes, so it can assume a set-up worktree (e.g. npm test). If your repo has no setup script, keep it self-contained (e.g. npm ci && npm test). Leave it empty to skip verification."
          >
            <TextField
              id="split-plan-build-command"
              data-testid="split-plan-build-command"
              value={plan.buildTestCommand}
              onChange={(e) => handleBuildTestCommandChange(e.target.value)}
              placeholder="e.g. npm ci && npm test"
            />
          </FormField>
        </div>

        <Surface
          variant="outline"
          className=" "
          data-testid="split-plan-aggregate-check"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-xs">
            <span
              className={
                aggregateMatches ? 'fg-success-strong' : 'fg-destructive'
              }
            >
              {aggregateMatches ? '✅' : '❌'}
            </span>
            <span className="fg-secondary">
              Children total{' '}
              <span className="fg-primary">
                +{aggregateAdditions}/-{aggregateDeletions}
              </span>{' '}
              vs. original{' '}
              <span className="fg-primary">
                +{snapshot.totalAdditions}/-{snapshot.totalDeletions}
              </span>
            </span>
          </div>
        </Surface>

        <div className="flex flex-col gap-2">
          <IssueBanner issues={validation.issues} severity="error" />
          <IssueBanner issues={validation.issues} severity="warning" />

          <Stack gap="inline">
            {plan.children.map((child, position) => (
              <SplitPlanChildRow
                key={child.index}
                child={child}
                position={position}
                total={plan.children.length}
                snapshot={snapshot}
                ownership={ownership}
                allChildIndices={allChildIndices}
                lineStats={
                  lineStatsByIndex.get(child.index) ?? {
                    additions: 0,
                    deletions: 0,
                  }
                }
                onUpdate={handleUpdateChild}
                onMoveUp={handleMoveUp}
                onMoveDown={handleMoveDown}
                onReassign={handleReassign}
              />
            ))}
          </Stack>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
        <Button
          size="compact"
          onClick={onCancel}
          data-testid="split-plan-cancel"
        >
          Cancel
        </Button>
        <Button
          size="compact"
          onClick={onRegenerate}
          data-testid="split-plan-regenerate"
        >
          Regenerate plan
        </Button>
        <Button
          variant="primary"
          size="compact"
          disabled={!validation.valid}
          onClick={() => onApprove(plan)}
          data-testid="split-plan-approve"
        >
          Approve &amp; split
        </Button>
      </div>
    </div>
  );
}
