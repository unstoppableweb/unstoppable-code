import { useEffect, useState } from 'react';
import { PipelineDefinitionListResultSchema } from '@canopy/protocol/canopy-core';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { LibraryProjectPlace } from './libraryProjectPlace';

const NO_COUNT: OtherWorktreePipelineCount = { count: 0, complete: true };

/** Worktree listings in flight at once, so a large project reads in waves. */
const PARALLEL_LISTINGS = 4;
/**
 * Rows per page: small enough that a page of summaries with the longest
 * descriptions stays well under the renderer relay's reply cap.
 */
const PAGE_SIZE = 50;
/**
 * Pages read per worktree. Bounded discovery reads at most 200 files, so
 * five pages of 50 always hold a complete listing.
 */
const MAX_PAGES = 5;

/**
 * Scans run one after another in this window. Aborting a scan stops it
 * starting another wave, but a wave already sent finishes, so a new scan
 * (a Refresh, say) waits for it: never more than one wave of reads is in
 * flight.
 */
let scanQueue: Promise<unknown> = Promise.resolve();

function enqueueScan<T>(run: () => Promise<T>): Promise<T> {
  const scan = scanQueue.then(run);
  scanQueue = scan.then(
    () => undefined,
    () => undefined,
  );
  return scan;
}

/**
 * The project pipeline ids one other worktree's checkout holds, through the
 * same core read the Library's discovery uses. The read is unattended, so it
 * asks for bounded discovery, which writes nothing and reads a checkout over
 * the bounds as unavailable. `null` when the checkout cannot be read (a
 * worktree whose folder is gone, say), when the listing is incomplete, or
 * when `signal` aborts.
 */
async function listProjectPipelineIds(
  projectId: string,
  worktreeId: string,
  signal: AbortSignal,
): Promise<readonly string[] | null> {
  const ids: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (signal.aborted) return null;
    const reply = await window.canopyCore.invoke({
      kind: 'request',
      method: 'core.pipeline.definition.list',
      params: {
        scope: { workspaceId: projectId, worktreeId },
        sources: ['project'],
        projectDiscovery: 'bounded',
        limit: PAGE_SIZE,
        ...(cursor === null ? {} : { cursor }),
      },
    });
    if (!reply.ok) return null;
    const result = PipelineDefinitionListResultSchema.safeParse(reply.value);
    if (!result.success || result.data.unavailableSources.includes('project'))
      return null;
    ids.push(...result.data.items.map((item) => item.definitionId));
    cursor = result.data.nextCursor;
    if (cursor === null) return ids;
  }
  return null;
}

/**
 * Project pipelines found in other worktrees and not in the selected one, by
 * definition id (the pipeline's path in `.canopy/pipelines/`). A pipeline in
 * several other worktrees counts once.
 */
export function countOtherWorktreeOnlyPipelines(
  selected: readonly string[],
  others: readonly (readonly string[])[],
): number {
  const here = new Set(selected);
  const elsewhere = new Set<string>();
  for (const ids of others) {
    for (const id of ids) if (!here.has(id)) elsewhere.add(id);
  }
  return elsewhere.size;
}

/** Runs `run` over `items` a few at a time; stops starting waves on abort. */
async function mapInWaves<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  signal: AbortSignal,
): Promise<R[]> {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += PARALLEL_LISTINGS) {
    if (signal.aborted) break;
    results.push(
      ...(await Promise.all(
        items.slice(start, start + PARALLEL_LISTINGS).map(run),
      )),
    );
  }
  return results;
}

/** The other-worktree count, and whether every other worktree was read. */
export interface OtherWorktreePipelineCount {
  readonly count: number;
  /** `false` when some worktree couldn't be read: `count` is a lower bound. */
  readonly complete: boolean;
}

/**
 * Reads the project's other worktrees and counts the project pipelines only
 * they hold. The selected worktree is read with the same bounded reader, so
 * both sides of the comparison see the same files (a file the Library's
 * full validation rejects is still present here), joined with the ids the
 * Library already loaded so a selected checkout over the bounds still
 * compares. An unreadable other worktree is left out, which makes the count
 * a lower bound. `null` when `signal` aborts first.
 */
export async function readOtherWorktreeOnlyPipelineCount(
  selectedIds: readonly string[],
  projectId: string,
  worktreeId: string,
  otherWorktreeIds: readonly string[],
  signal: AbortSignal,
  list: (
    projectId: string,
    worktreeId: string,
    signal: AbortSignal,
  ) => Promise<readonly string[] | null> = listProjectPipelineIds,
): Promise<OtherWorktreePipelineCount | null> {
  const [selectedListing, ...listings] = await mapInWaves(
    [worktreeId, ...otherWorktreeIds],
    (id) =>
      list(projectId, id, signal).catch((error: unknown): null => {
        // One worktree's failed read must not hide the others' count.
        reportClientAppError(error);
        return null;
      }),
    signal,
  );
  if (signal.aborted) return null;
  // Without the selected worktree's own listing the comparison could only
  // use the Library's validated ids, which may miss a file both hold and so
  // overcount; no count is shown rather than a wrong one.
  if (selectedListing === null) return { count: 0, complete: false };
  const read = listings.flatMap((ids) => (ids ? [ids] : []));
  return {
    count: countOtherWorktreeOnlyPipelines(
      [...selectedIds, ...selectedListing],
      read,
    ),
    complete: read.length === otherWorktreeIds.length,
  };
}

/**
 * {@link readOtherWorktreeOnlyPipelineCount}, after every scan queued before
 * it in this window has settled.
 */
export function queueOtherWorktreeOnlyPipelineCount(
  ...args: Parameters<typeof readOtherWorktreeOnlyPipelineCount>
): Promise<OtherWorktreePipelineCount | null> {
  return enqueueScan(() => readOtherWorktreeOnlyPipelineCount(...args));
}

/**
 * The other-worktree count for the Library's hint (CAN-965). `selectedIds`
 * are the project pipeline ids the Library loaded for the selected worktree,
 * or `null` while that list loads; `listFailed` when it failed, which hides
 * the count. Reads the other worktrees again whenever a new list arrives
 * (Refresh included) or the project's worktrees change; leaving the Library
 * or a newer read aborts the one in flight. 0 until the first read for a
 * selection finishes; a reload keeps the last count until its read lands.
 */
export function useOtherWorktreeProjectPipelineCount(
  place: LibraryProjectPlace,
  selectedIds: readonly string[] | null,
  listFailed: boolean,
): OtherWorktreePipelineCount {
  const projectId = place.kind === 'worktree' ? place.projectId : '';
  const worktreeId = place.kind === 'worktree' ? place.worktreeId : '';
  // Worktree ids are path-safe slugs, so a newline never appears in one.
  const othersKey =
    place.kind === 'worktree' ? place.otherWorktreeIds.join('\n') : '';
  const placeKey = [projectId, worktreeId, othersKey].join('\0');
  const [read, setRead] = useState<{
    readonly placeKey: string;
    readonly result: OtherWorktreePipelineCount;
  } | null>(null);

  useEffect(() => {
    if (!projectId || !othersKey || selectedIds === null) return undefined;
    const controller = new AbortController();
    void queueOtherWorktreeOnlyPipelineCount(
      selectedIds,
      projectId,
      worktreeId,
      othersKey.split('\n'),
      controller.signal,
    ).then((result) => {
      if (result !== null && !controller.signal.aborted)
        setRead({ placeKey, result });
    });
    return (): void => {
      controller.abort();
    };
  }, [projectId, worktreeId, othersKey, placeKey, selectedIds]);

  if (listFailed || read?.placeKey !== placeKey) return NO_COUNT;
  return read.result;
}
