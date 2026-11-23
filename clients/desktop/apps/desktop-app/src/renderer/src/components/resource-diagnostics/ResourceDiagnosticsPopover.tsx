import { Surface } from '@canopy/ui-shared/components';
import { Heading } from '@canopy/ui-shared/components';
import { useEffect, useMemo, useState, type JSX } from 'react';
import type {
  ResourceGroupId,
  ResourceMonitorSnapshot,
  ResourceProcessSnapshot,
  SidebarItem,
} from '@canopy/desktop-shared/types';
import { CHAT_LABEL } from '@canopy/protocol';
import { useNavigationStore } from '@/stores/navigationStore';
import { useChatStore } from '@/stores/chatStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useMemoryReportStore } from '@/stores/memoryReportStore';
import { canNavigateToWorktreeFromSidebarItems } from '@/lib/worktreeNavigation';
import { formatCpuPercent, formatMemoryBytes } from './format';
import {
  getResourceDiagnosticsSortState,
  setResourceDiagnosticsSortState,
  type ResourceDiagnosticsSortColumn,
  type ResourceDiagnosticsSortState,
} from './sortState';
import { RailIconButton } from '@canopy/ui-shared';
import {
  Button,
  DataTableBody,
  DataTableCell,
  DataTableFrame,
  DataTableHead,
  DataTableHeaderCell,
  DataTableRow,
  ErrorBanner,
  EmptyStateRow,
  Tooltip,
  DisclosureChevron,
  DisclosureToggle,
} from '@canopy/ui-shared/components';
import { SettingsIcon } from '@canopy/ui-shared/icons/AppIcons';

interface ResourceDiagnosticsPopoverProps {
  snapshot: ResourceMonitorSnapshot | null;
  error: string | null;
  onClose: () => void;
  loading?: boolean;
}

const GROUP_LABELS: Record<ResourceGroupId, string> = {
  app: 'App',
  browser: 'Browser',
  codex: 'Codex',
  claude: 'Claude',
  chat: CHAT_LABEL,
  pipelines: 'Workflows',
  terminal: 'Terminal',
  scripts: 'Script',
  other: 'Other',
};

const GROUP_PRIORITY: Record<ResourceGroupId, number> = {
  app: 0,
  browser: 1,
  pipelines: 2,
  codex: 3,
  claude: 4,
  chat: 5,
  terminal: 6,
  scripts: 7,
  other: 8,
};

const ELECTRON_PROCESS_LABEL_PREFIX = 'Electron ';

/**
 * Rows carry no source glyph: most rows share a source, so the glyphs did not
 * tell rows apart. The source leads each name's details instead. A row with
 * children carries its chevron after its name, so every name, and the footer
 * labels, start at the same edge; children indent under their parent.
 */
const TREE_INDENT_PX = 12;

/**
 * Deeper rows stop indenting: the chevron follows the name inside the
 * clipped Name cell, so unbounded indentation could push it out of reach.
 * Past this depth the name truncates instead, and the chevron stays.
 */
const TREE_INDENT_MAX_DEPTH = 4;

/**
 * Sources whose processes the app runs for itself (Electron and the commands
 * it spawns, such as git), as opposed to agents, scripts, terminals, and
 * browser tabs it runs on someone's behalf.
 */
const APP_MANAGED_GROUPS: ReadonlySet<ResourceGroupId> =
  new Set<ResourceGroupId>(['app', 'other']);

interface FlattenedRow {
  id: string;
  groupId: ResourceGroupId;
  groupLabel: string;
  process: ResourceProcessSnapshot;
  secondaryText: string | null;
  navigationTarget: WorktreeNavigationTarget | null;
  attributionLabel: string | null;
  depth: number;
  hasChildren: boolean;
}

interface WorktreeNavigationTarget {
  projectId: string;
  worktreeId: string;
}

interface WorktreeAttribution extends WorktreeNavigationTarget {
  label: string;
  navigable: boolean;
}

interface ResourceDiagnosticsContext {
  projects: SidebarItem[];
  hasHydratedProjects: boolean;
}

interface InheritedRowContext {
  attributionLabel: string | null;
  navigationTarget: WorktreeNavigationTarget | null;
}

interface ResourceRowDetails extends InheritedRowContext {
  secondaryText: string | null;
}

function getProcessPathSegment(process: ResourceProcessSnapshot): string {
  if (typeof process.pid === 'number' && process.pid > 0) {
    return `${process.id}:pid:${process.pid}`;
  }
  return process.id;
}

function compareByGroupPriority(
  a: Pick<FlattenedRow, 'groupId'>,
  b: Pick<FlattenedRow, 'groupId'>,
): number {
  return GROUP_PRIORITY[a.groupId] - GROUP_PRIORITY[b.groupId];
}

function compareByGroupThenName(
  a: Pick<FlattenedRow, 'groupId' | 'process'>,
  b: Pick<FlattenedRow, 'groupId' | 'process'>,
): number {
  const priorityDelta = compareByGroupPriority(a, b);
  if (priorityDelta !== 0) return priorityDelta;
  return getProcessDisplayLabel(a.process).localeCompare(
    getProcessDisplayLabel(b.process),
  );
}

function compareByGroupNameThenId(
  a: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
  b: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
): number {
  const primary = compareByGroupThenName(a, b);
  if (primary !== 0) return primary;
  return a.id.localeCompare(b.id);
}

function compareNumeric(a: number, b: number): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareRows(
  a: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
  b: Pick<FlattenedRow, 'id' | 'groupId' | 'process'>,
  sort: ResourceDiagnosticsSortState,
): number {
  const sign = sort.direction === 'asc' ? 1 : -1;
  if (sort.column === 'name') {
    const groupDelta = compareByGroupPriority(a, b);
    if (groupDelta !== 0) return groupDelta;
    const nameDelta = getProcessDisplayLabel(a.process).localeCompare(
      getProcessDisplayLabel(b.process),
    );
    if (nameDelta !== 0) return sign * nameDelta;
    // Fallback: Memory desc.
    const memoryDelta = compareNumeric(
      b.process.memoryRssBytes,
      a.process.memoryRssBytes,
    );
    if (memoryDelta !== 0) return memoryDelta;
    return a.id.localeCompare(b.id);
  }

  const primary =
    sort.column === 'cpu'
      ? compareNumeric(a.process.cpuPercent, b.process.cpuPercent)
      : compareNumeric(a.process.memoryRssBytes, b.process.memoryRssBytes);
  if (primary !== 0) return sign * primary;
  // Fallback: Name/type asc.
  return compareByGroupNameThenId(a, b);
}

function shouldRenderProcess(process: ResourceProcessSnapshot): boolean {
  return !(
    process.kind === 'codex-app-server-pool' && typeof process.pid !== 'number'
  );
}

function getProcessDisplayLabel(process: ResourceProcessSnapshot): string {
  if (
    process.groupId !== 'app' ||
    !process.label.startsWith(ELECTRON_PROCESS_LABEL_PREFIX)
  ) {
    return process.label;
  }
  const stripped = process.label.slice(ELECTRON_PROCESS_LABEL_PREFIX.length);
  if (stripped.length === 0) {
    return process.label;
  }
  return stripped.charAt(0).toUpperCase() + stripped.slice(1);
}

/**
 * Unregistered processes arrive as flat roots. Nests each under the root that
 * spawned it, so an agent's shells and commands roll up under the agent, and
 * gives a parent its subtree's usage the way registered rows already carry.
 * Electron processes never adopt: what they spawn is its own source.
 */
function adoptChildProcesses(
  items: ResourceProcessSnapshot[],
): ResourceProcessSnapshot[] {
  const parentsByPid = new Map<number, ResourceProcessSnapshot>();
  for (const item of items) {
    if (typeof item.pid === 'number' && item.groupId !== 'app') {
      parentsByPid.set(item.pid, item);
    }
  }
  const adopted = new Map<ResourceProcessSnapshot, ResourceProcessSnapshot[]>();
  const roots: ResourceProcessSnapshot[] = [];
  for (const item of items) {
    const parent =
      item.metadata?.type === 'generic' && typeof item.ppid === 'number'
        ? parentsByPid.get(item.ppid)
        : undefined;
    if (parent && parent !== item) {
      adopted.set(parent, [...(adopted.get(parent) ?? []), item]);
    } else {
      roots.push(item);
    }
  }
  const withChildren = (
    item: ResourceProcessSnapshot,
  ): ResourceProcessSnapshot => {
    const children = (adopted.get(item) ?? []).map(withChildren);
    if (children.length === 0) return item;
    return {
      ...item,
      cpuPercent: children.reduce(
        (total, child) => total + child.cpuPercent,
        item.cpuPercent,
      ),
      memoryRssBytes: children.reduce(
        (total, child) => total + child.memoryRssBytes,
        item.memoryRssBytes,
      ),
      processCount: children.reduce(
        (total, child) => total + child.processCount,
        item.processCount,
      ),
      children: [...(item.children ?? []), ...children],
    };
  };
  return roots.map(withChildren);
}

function getRootProcesses(
  snapshot: ResourceMonitorSnapshot,
): ResourceProcessSnapshot[] {
  return adoptChildProcesses(
    snapshot.groups.flatMap((group) =>
      group.items
        .filter(shouldRenderProcess)
        // Rows take the group they were reported in, whatever the item says.
        .map((item) =>
          item.groupId === group.id ? item : { ...item, groupId: group.id },
        ),
    ),
  );
}

function getAppManagedTotals(roots: ResourceProcessSnapshot[]): {
  cpuPercent: number;
  memoryRssBytes: number;
} {
  const appRoots = roots.filter((root) => APP_MANAGED_GROUPS.has(root.groupId));
  return {
    cpuPercent: appRoots.reduce((total, root) => total + root.cpuPercent, 0),
    memoryRssBytes: appRoots.reduce(
      (total, root) => total + root.memoryRssBytes,
      0,
    ),
  };
}

function flattenRows(
  roots: ResourceProcessSnapshot[],
  sort: ResourceDiagnosticsSortState,
  context: ResourceDiagnosticsContext,
  expanded: ReadonlySet<string>,
): FlattenedRow[] {
  const rows: FlattenedRow[] = [];
  const rootRows = roots.map((item) => {
    const details = deriveRowDetails(item, context, null);
    return {
      id: `${item.groupId}:${getProcessPathSegment(item)}`,
      groupId: item.groupId,
      groupLabel: GROUP_LABELS[item.groupId],
      process: item,
      secondaryText: details.secondaryText,
      navigationTarget: details.navigationTarget,
      attributionLabel: details.attributionLabel,
      depth: 0,
      hasChildren: (item.children ?? []).some(shouldRenderProcess),
      path: getProcessPathSegment(item),
    };
  });

  const appendProcess = (row: FlattenedRow & { path: string }): void => {
    rows.push(row);
    if (!expanded.has(row.id)) return;
    const children = [...(row.process.children ?? [])]
      .filter(shouldRenderProcess)
      .map((child) => {
        const childSegment = getProcessPathSegment(child);
        const path = `${row.path}:child:${childSegment}`;
        const details = deriveRowDetails(child, context, {
          attributionLabel: row.attributionLabel,
          navigationTarget: row.navigationTarget,
        });
        return {
          id: `${row.groupId}:${path}`,
          groupId: row.groupId,
          groupLabel: row.groupLabel,
          process: child,
          secondaryText: details.secondaryText,
          navigationTarget: details.navigationTarget,
          attributionLabel: details.attributionLabel,
          depth: row.depth + 1,
          hasChildren: (child.children ?? []).some(shouldRenderProcess),
          path,
        };
      })
      .sort((a, b) => compareRows(a, b, sort));
    children.forEach(appendProcess);
  };

  rootRows.sort((a, b) => compareRows(a, b, sort)).forEach(appendProcess);
  return rows;
}

function resolveWorktreeAttribution(
  context: ResourceDiagnosticsContext,
  target: WorktreeNavigationTarget,
): WorktreeAttribution {
  const project = context.projects.find(
    (candidate) => candidate.id === target.projectId,
  );
  const worktree =
    project && project.type !== 'cowork'
      ? project.worktrees.find(
          (candidate) => candidate.id === target.worktreeId,
        )
      : undefined;
  const workspaceLabel = project?.name ?? target.projectId;
  const worktreeLabel =
    worktree?.branchName ?? worktree?.id ?? target.worktreeId;
  return {
    ...target,
    label: `${workspaceLabel} / ${worktreeLabel}`,
    navigable: canNavigateToWorktreeFromSidebarItems(
      context.projects,
      target.projectId,
      target.worktreeId,
      context.hasHydratedProjects,
    ),
  };
}

function pidLabel(process: ResourceProcessSnapshot): string | null {
  return typeof process.pid === 'number' && process.pid > 0
    ? `PID ${process.pid}`
    : null;
}

function deriveInheritedRowDetails(
  process: ResourceProcessSnapshot,
  inherited: InheritedRowContext | null,
): ResourceRowDetails | null {
  if (!inherited?.attributionLabel) {
    return null;
  }
  const parts = [inherited.attributionLabel, pidLabel(process)].filter(
    (part): part is string => Boolean(part),
  );
  return {
    secondaryText: parts.join(' / '),
    attributionLabel: inherited.attributionLabel,
    navigationTarget: inherited.navigationTarget,
  };
}

function deriveRowDetails(
  process: ResourceProcessSnapshot,
  context: ResourceDiagnosticsContext,
  inherited: InheritedRowContext | null,
): ResourceRowDetails {
  const meta = process.metadata;
  if (!meta) {
    return (
      deriveInheritedRowDetails(process, inherited) ?? {
        secondaryText: null,
        attributionLabel: inherited?.attributionLabel ?? null,
        navigationTarget: inherited?.navigationTarget ?? null,
      }
    );
  }
  if (meta.type === 'codex-pool') {
    const { codexPool } = meta;
    const pidLabel =
      typeof process.pid === 'number' && process.pid > 0
        ? `PID ${process.pid}`
        : 'not running';
    if (codexPool.pooled === false) {
      return {
        secondaryText: `Dedicated pool / ${codexPool.clientCount} clients / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    const label = codexPool.poolKeyLabel ?? '';
    if (label === 'Default pool') {
      return {
        secondaryText: `Default pool / ${codexPool.clientCount} clients / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    if (label === 'Dedicated pool') {
      return {
        secondaryText: `Dedicated pool / ${codexPool.clientCount} clients / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    const envMatch = /^Env pool ([0-9a-fA-F]{8})$/.exec(label);
    const hash8 = envMatch?.[1] ?? label;
    return {
      secondaryText: `Env pool ${hash8} / ${codexPool.clientCount} clients / ${pidLabel}`,
      attributionLabel: null,
      navigationTarget: null,
    };
  }
  if (meta.type === 'pipeline') {
    const pipelineMeta = meta.pipeline;
    const shortExecutionId = pipelineMeta.executionId.slice(0, 8);
    if (pipelineMeta.jobId && pipelineMeta.stepId) {
      const pidLabel =
        typeof process.pid === 'number' && process.pid > 0
          ? `PID ${process.pid}`
          : 'not running';
      return {
        secondaryText: `${pipelineMeta.jobId} / ${pipelineMeta.stepId} / ${pidLabel}`,
        attributionLabel: null,
        navigationTarget: null,
      };
    }
    return {
      secondaryText: `Execution ${shortExecutionId}`,
      attributionLabel: null,
      navigationTarget: null,
    };
  }
  if (meta.type === 'browser') {
    const { browser } = meta;
    const attribution = resolveWorktreeAttribution(context, {
      projectId: browser.projectId,
      worktreeId: browser.worktreeId,
    });
    const parts = [
      attribution.label,
      pidLabel(process),
      browser.visible ? 'visible' : 'hidden',
      browser.status,
      browser.displayUrl,
    ].filter((part): part is string => Boolean(part));
    return {
      secondaryText: parts.join(' / '),
      attributionLabel: attribution.label,
      navigationTarget: attribution.navigable
        ? { projectId: browser.projectId, worktreeId: browser.worktreeId }
        : null,
    };
  }
  if (meta.type === 'script') {
    const { script } = meta;
    const attribution = resolveWorktreeAttribution(context, {
      projectId: script.projectId,
      worktreeId: script.worktreeId,
    });
    const parts = [
      attribution.label,
      pidLabel(process),
      script.repoName,
      script.invocation,
    ].filter((part): part is string => Boolean(part));
    return {
      secondaryText: parts.join(' / '),
      attributionLabel: attribution.label,
      navigationTarget: attribution.navigable
        ? { projectId: script.projectId, worktreeId: script.worktreeId }
        : null,
    };
  }
  if (meta.type === 'generic') {
    const inheritedDetails = deriveInheritedRowDetails(process, inherited);
    if (inheritedDetails) {
      return inheritedDetails;
    }
    return {
      secondaryText: pidLabel(process),
      attributionLabel: null,
      navigationTarget: null,
    };
  }
  return (
    deriveInheritedRowDetails(process, inherited) ?? {
      secondaryText: null,
      attributionLabel: null,
      navigationTarget: null,
    }
  );
}

/**
 * The Resources panel's contents. `ResourceDiagnosticsControl` hosts it in the
 * shared `Popover`, which owns the surface, placement and dismissal.
 */
export function ResourceDiagnosticsPopover({
  snapshot,
  error,
  onClose,
  loading = false,
}: ResourceDiagnosticsPopoverProps): JSX.Element {
  const openSettings = useNavigationStore((s) => s.openSettings);
  const navigate = useNavigationStore((s) => s.navigate);
  const selectWorktree = useChatStore((s) => s.selectWorktree);
  const projects = useProjectsStore((s) => s.projects);
  const hasHydratedProjects = useProjectsStore((s) => s.hasHydratedProjects);
  const [sort, setSortLocal] = useState<ResourceDiagnosticsSortState>(
    getResourceDiagnosticsSortState,
  );
  // Trees start collapsed; row ids are stable across samples.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  function toggleExpanded(rowId: string): void {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(rowId)) next.add(rowId);
      return next;
    });
  }

  function setSort(next: ResourceDiagnosticsSortState): void {
    setResourceDiagnosticsSortState(next);
    setSortLocal(next);
  }

  function handleHeaderClick(column: ResourceDiagnosticsSortColumn): void {
    if (sort.column === column) {
      setSort({
        column,
        direction: sort.direction === 'asc' ? 'desc' : 'asc',
      });
      return;
    }
    setSort({ column, direction: column === 'name' ? 'asc' : 'desc' });
  }

  function handleOpenPerformanceSettings(): void {
    openSettings('performance');
    onClose();
  }

  function handleNavigateToWorktree(target: WorktreeNavigationTarget): void {
    navigate('main');
    selectWorktree(target.projectId, target.worktreeId);
    onClose();
  }

  const diagnosticsContext = useMemo(
    (): ResourceDiagnosticsContext => ({
      projects,
      hasHydratedProjects,
    }),
    [projects, hasHydratedProjects],
  );
  const roots = useMemo(
    () => (snapshot ? getRootProcesses(snapshot) : []),
    [snapshot],
  );
  const rows = useMemo(
    () => flattenRows(roots, sort, diagnosticsContext, expanded),
    [roots, sort, diagnosticsContext, expanded],
  );
  const appManagedTotals = useMemo(() => getAppManagedTotals(roots), [roots]);

  // Portaled over titlebar/sidebar drag rects; app-region ignores z-order,
  // so the controls' container opts out.
  // One column, so only the list shrinks. The content never outgrows the
  // popover's room (`--floating-menu-max-height`, less its 24px of inset): the
  // list gives up height down to its header and two rows, and past that the
  // parts run on below the popover's foot and the popover scrolls. The title,
  // banners, totals and Memory report never shrink, so nothing overlaps. The
  // column's gaps differ by pair (8px under the title and a banner, flush
  // between the rows), so they are each part's own padding.
  return (
    <div
      className="electron-no-drag flex max-h-[calc(var(--floating-menu-max-height,100vh)_-_1.5rem)] flex-col"
      data-testid="resource-diagnostics-popover-content"
    >
      <div className="flex shrink-0 items-center gap-3 pb-2">
        <Heading level={3} variant="title" truncate className="min-w-0 flex-1">
          Resources
        </Heading>
        {snapshot && (
          <span
            className="flex gap-2 text-xs tabular-nums fg-tertiary"
            data-testid="resource-diagnostics-popover-totals"
          >
            <span>{formatCpuPercent(snapshot.cpuPercent)}% CPU</span>
            <span>{formatMemoryBytes(snapshot.memoryRssBytes)}</span>
          </span>
        )}
        <RailIconButton
          icon={SettingsIcon}
          hoverSurface
          aria-label="Open performance settings"
          tooltipLabel="Performance settings"
          data-testid="resource-diagnostics-popover-settings"
          onClick={handleOpenPerformanceSettings}
          // The glyph, not the button, meets the 12px content inset.
          inset="tight-end"
        />
      </div>

      {loading && (
        <p className="shrink-0 text-xs fg-tertiary">Measuring resources…</p>
      )}

      {!loading && !snapshot && error && (
        <div className="shrink-0">
          <ErrorBanner
            errorSource="resource-diagnostics-popover"
            className=""
            error="Resource metrics unavailable"
          />
        </div>
      )}

      {!loading && !snapshot && !error && (
        <div className="shrink-0">
          <EmptyStateRow title="No resource samples yet." />
        </div>
      )}

      {snapshot && error && (
        <div className="shrink-0 pb-2">
          <ErrorBanner
            errorSource="resource-diagnostics-popover-error"
            className=""
            error="Resource metrics unavailable"
            testId="resource-diagnostics-popover-error"
          />
        </div>
      )}

      {snapshot && rows.length === 0 && (
        <div className="shrink-0">
          <EmptyStateRow title="No resource samples yet." />
        </div>
      )}

      {/* The rows and the footer rows share one 36px rhythm with a hairline
          between them, so they sit flush. A table row draws its hairline
          inside its 36px; a footer row's section border takes the
          hairline's space, so the row gives it back. */}
      {snapshot && rows.length > 0 && (
        <div className="flex min-h-25 flex-col">
          <DataTableFrame
            caption="Resource usage"
            layout="fixed"
            appearance="plain"
            // Shrinks when the popover is short; otherwise the 28px
            // header and ten 36px rows, so it stops between rows.
            fill
            maxHeight="24.25rem"
          >
            <DataTableHead sticky>
              {/* CPU fits its widest sort label; Memory is 8px wider
              than its widest value, so the numbers stand clear of
              CPU's. The totals row below repeats these widths. */}
              <SortHeader
                label="Name"
                column="name"
                sort={sort}
                onClick={handleHeaderClick}
                align="start"
              />
              <SortHeader
                label="CPU"
                column="cpu"
                sort={sort}
                onClick={handleHeaderClick}
                align="end"
                width="3.5rem"
              />
              <SortHeader
                label="Memory"
                column="memory"
                sort={sort}
                onClick={handleHeaderClick}
                align="end"
                width="6rem"
              />
            </DataTableHead>
            <DataTableBody>
              {rows.map((row) => (
                <ResourceRow
                  key={row.id}
                  row={row}
                  expanded={expanded.has(row.id)}
                  onToggle={toggleExpanded}
                  onNavigate={handleNavigateToWorktree}
                />
              ))}
            </DataTableBody>
          </DataTableFrame>
        </div>
      )}

      {snapshot && (
        <Surface
          variant="section"
          boundary="top"
          className="shrink-0"
          data-testid="resource-diagnostics-popover-app-totals"
        >
          {/* A row like the table's: the label in a name's ink where names
          start, the totals in the numbers' ink under the CPU (3.5rem
          column) and Memory (6rem column, less the plain table's 8px
          end inset) values. */}
          <div className="flex h-[calc(2.25rem_-_var(--border-hairline))] items-center text-s fg-secondary">
            <span className="min-w-0 flex-1 truncate fg-primary">
              App processes
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums">
              {formatCpuPercent(appManagedTotals.cpuPercent)}%
              <span className="sr-only"> CPU</span>
            </span>
            <span className="w-22 shrink-0 text-right tabular-nums">
              {formatMemoryBytes(appManagedTotals.memoryRssBytes)}
              <span className="sr-only"> memory</span>
            </span>
          </div>
        </Surface>
      )}
      <MemoryReportFooter onClose={onClose} />
    </div>
  );
}

/**
 * Creates a memory report, and opens the newest one's folder, while memory
 * diagnostics are on in Performance settings. The report's confirmation and
 * progress overlay are app-wide, so starting one closes this popover.
 *
 * The row reads the store's last known setting, so after the first read the
 * popover opens with it in place; each open refreshes it.
 */
function MemoryReportFooter({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element | null {
  const [revealFailed, setRevealFailed] = useState(false);
  const enabled = useMemoryReportStore((state) => state.diagnosticsEnabled);
  const setEnabled = useMemoryReportStore(
    (state) => state.setDiagnosticsEnabled,
  );
  const lastReport = useMemoryReportStore((state) => state.lastReport);
  const setLastReport = useMemoryReportStore((state) => state.setLastReport);
  const reportBusy = useMemoryReportStore(
    (state) => state.checking || state.flow.phase !== 'idle',
  );
  const requestReport = useMemoryReportStore((state) => state.request);
  const revealReport = useMemoryReportStore((state) => state.reveal);

  useEffect(() => {
    let active = true;
    void (async (): Promise<void> => {
      try {
        const status = await window.api.memoryDiagnostics.getStatus();
        if (!active) return;
        setEnabled(status.enabled);
        setLastReport(status.lastReport);
      } catch {
        // Without a status the row keeps its last known state.
      }
    })();
    return (): void => {
      active = false;
    };
  }, [setEnabled, setLastReport]);

  if (enabled !== true) return null;
  return (
    <Surface
      // An action band, not another data row: it meets the popover's edges
      // through its 12px inset and pads its content by the same 12px, so
      // the buttons sit as far below its edge as above the popover's.
      variant="popover-footer"
      boundary="top"
      padding="compact"
      className="-mx-3 -mb-3 shrink-0"
      data-testid="resource-diagnostics-popover-memory-report"
    >
      <div className="flex flex-col gap-2">
        {revealFailed && (
          <ErrorBanner
            errorSource="memory-report-footer"
            className=""
            error="Couldn't open the folder"
          />
        )}
        <div className="flex items-center gap-2 text-s fg-secondary">
          <span className="min-w-0 flex-1 truncate fg-primary">
            Memory report
          </span>
          <span className="flex shrink-0 items-center gap-2">
            {lastReport ? (
              <Button
                size="compact"
                variant="secondary"
                data-testid="resource-diagnostics-popover-open-report"
                onClick={() => {
                  void revealReport(lastReport.reportId).then((revealed) => {
                    setRevealFailed(!revealed);
                  });
                }}
              >
                Open folder
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="secondary"
              disabled={reportBusy}
              data-testid="resource-diagnostics-popover-create-report"
              // The row's label names the report, so the action can stay short.
              aria-label="Create memory report"
              onClick={() => {
                onClose();
                void requestReport();
              }}
            >
              Create
            </Button>
          </span>
        </div>
      </div>
    </Surface>
  );
}

interface SortHeaderProps {
  label: string;
  column: ResourceDiagnosticsSortColumn;
  sort: ResourceDiagnosticsSortState;
  onClick: (column: ResourceDiagnosticsSortColumn) => void;
  /** Numbers right-align so their digits line up. */
  align: 'start' | 'end';
  width?: string;
}

function SortHeader({
  label,
  column,
  sort,
  onClick,
  align,
  width,
}: SortHeaderProps): JSX.Element {
  return (
    <DataTableHeaderCell
      align={align === 'end' ? 'right' : 'left'}
      width={width}
      testId={`resource-diagnostics-popover-sort-${column}`}
      sort={{
        direction: sort.column === column ? sort.direction : null,
        onToggle: (): void => onClick(column),
      }}
    >
      {label}
    </DataTableHeaderCell>
  );
}

function ResourceRow({
  row,
  expanded,
  onToggle,
  onNavigate,
}: {
  row: FlattenedRow;
  expanded: boolean;
  onToggle: (rowId: string) => void;
  onNavigate: (target: WorktreeNavigationTarget) => void;
}): JSX.Element {
  const { process, groupLabel, secondaryText, depth, navigationTarget } = row;
  const displayLabel = getProcessDisplayLabel(process);
  // One line per process: the group, PID, and owner are details, shown on
  // hover and read out with the name rather than taking a second line.
  const details = `${groupLabel}${secondaryText ? ` · ${secondaryText}` : ''}`;
  const clickable = navigationTarget !== null;
  const handleClick = (): void => {
    if (navigationTarget) {
      onNavigate(navigationTarget);
    }
  };
  return (
    <DataTableRow
      data-testid={`resource-row-${process.id}`}
      onActivate={clickable ? handleClick : undefined}
      activateOnSpace
    >
      <DataTableCell overflow="truncate">
        <div
          className="flex min-w-0 items-center gap-1"
          style={{
            paddingLeft:
              Math.min(depth, TREE_INDENT_MAX_DEPTH) * TREE_INDENT_PX,
          }}
        >
          <Tooltip
            label={
              <span className="flex flex-col">
                <span>{displayLabel}</span>
                <span className="fg-secondary">{details}</span>
                {clickable ? (
                  <span className="fg-secondary">Open worktree</span>
                ) : null}
              </span>
            }
            delay="long"
            allowShrink
            className="min-w-0"
            contentClassName="max-w-80 whitespace-normal wrap-anywhere"
          >
            <div className="min-w-0 truncate">
              <span className="fg-primary">{displayLabel}</span>
              <span className="sr-only">, {details}</span>
            </div>
          </Tooltip>
          {/* After the name, so rows that expand keep the names' edge. */}
          {row.hasChildren ? (
            <DisclosureToggle
              variant="tree"
              open={expanded}
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${displayLabel}`}
              data-testid={`resource-row-toggle-${process.id}`}
              onClick={(event): void => {
                event.stopPropagation();
                onToggle(row.id);
              }}
            >
              <DisclosureChevron
                direction={expanded ? 'down' : 'right'}
                size="xs"
                animated
              />
            </DisclosureToggle>
          ) : null}
        </div>
      </DataTableCell>
      <DataTableCell align="right">
        {formatCpuPercent(process.cpuPercent)}%
      </DataTableCell>
      <DataTableCell align="right">
        {formatMemoryBytes(process.memoryRssBytes)}
      </DataTableCell>
    </DataTableRow>
  );
}
