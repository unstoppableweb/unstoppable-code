/**
 * `diff.read` over `activity:file-diff`.
 *
 * The host returns a file's two sides (`oldValue` / `newValue`) for one
 * source (uncommitted, committed or combined); the shared diff viewer wants a
 * unified patch. This module builds it with a bounded Myers line diff. A
 * change too large to diff within the bounds returns `oversized: true` and no
 * patch, as a bounded host does. The combined worktree diff (no path) has no
 * channel and is refused explicitly.
 */
import type {
  RemoteControlDiffPayload,
  RemoteControlDiffReadPayload,
} from '@canopy/protocol/remote-control/shell';
import { REMOTE_IPC_CHANNELS as C } from '@canopy/protocol/remote-control/channels';
import {
  UnsupportedOperationError,
  type ChannelClient,
} from './channel-client';
import { isRecord, reply } from './decoders';
import type { WireFileDiff } from './wire';

const CONTEXT_LINES = 3;
/** Lines per side above which the patch is not computed. */
const MAX_DIFF_LINES = 20_000;
/** Edit distance above which the patch is not computed. */
const MAX_EDIT_DISTANCE = 2_000;
/** Patch text above which the patch is cut at a line boundary. */
const MAX_PATCH_CHARS = 1_000_000;

const isFileDiff = reply<WireFileDiff>(
  (value) =>
    isRecord(value) &&
    typeof value.oldValue === 'string' &&
    typeof value.newValue === 'string' &&
    typeof value.truncated === 'boolean' &&
    typeof value.binary === 'boolean',
);

type Edit = { readonly kind: ' ' | '-' | '+'; readonly line: string };

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Myers' O(ND) shortest edit script, or `null` past the distance bound. */
function lineDiff(before: string[], after: string[]): Edit[] | null {
  const n = before.length;
  const m = after.length;
  const max = Math.min(n + m, MAX_EDIT_DISTANCE);
  const offset = max + 1;
  const frontier: number[] = new Array<number>(2 * max + 3).fill(0);
  // Each step keeps only the diagonals backtracking reads: k in [-d-1, d+1].
  const trace: number[][] = [];
  for (let d = 0; d <= max; d += 1) {
    trace.push(frontier.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down =
        k === -d ||
        (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1]);
      let x = down ? frontier[offset + k + 1] : frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && before[x] === after[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, before, after, d);
    }
  }
  return null;
}

function backtrack(
  trace: number[][],
  before: string[],
  after: string[],
  distance: number,
): Edit[] {
  const edits: Edit[] = [];
  let x = before.length;
  let y = after.length;
  for (let d = distance; d > 0; d -= 1) {
    const step = trace[d];
    const at = (diagonal: number): number => step[diagonal + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: ' ', line: before[x] });
    }
    if (down) {
      y -= 1;
      edits.push({ kind: '+', line: after[y] });
    } else {
      x -= 1;
      edits.push({ kind: '-', line: before[x] });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ kind: ' ', line: before[x] });
  }
  return edits.reverse();
}

export interface UnifiedPatch {
  readonly patch?: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly oversized: boolean;
}

/** A unified diff of one file, `a/<path>` to `b/<path>`. */
export function unifiedPatch(
  filePath: string,
  oldValue: string,
  newValue: string,
): UnifiedPatch {
  const before = splitLines(oldValue);
  const after = splitLines(newValue);
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES) {
    return { insertions: 0, deletions: 0, oversized: true };
  }
  const edits = lineDiff(before, after);
  if (edits === null) return { insertions: 0, deletions: 0, oversized: true };
  const insertions = edits.filter((edit) => edit.kind === '+').length;
  const deletions = edits.filter((edit) => edit.kind === '-').length;
  if (insertions === 0 && deletions === 0) {
    return { insertions, deletions, oversized: false };
  }
  const hunks: Array<[number, number]> = [];
  edits.forEach(({ kind }, index) => {
    if (kind === ' ') return;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(edits.length, index + CONTEXT_LINES + 1);
    const last = hunks[hunks.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else hunks.push([start, end]);
  });
  const beforeNumbers: number[] = [];
  const afterNumbers: number[] = [];
  let beforeNumber = 1;
  let afterNumber = 1;
  for (const { kind } of edits) {
    beforeNumbers.push(beforeNumber);
    afterNumbers.push(afterNumber);
    if (kind !== '+') beforeNumber += 1;
    if (kind !== '-') afterNumber += 1;
  }
  const lines = [
    oldValue.length === 0 ? '--- /dev/null' : `--- a/${filePath}`,
    newValue.length === 0 ? '+++ /dev/null' : `+++ b/${filePath}`,
  ];
  let size = lines.join('\n').length;
  for (const [start, end] of hunks) {
    let beforeCount = 0;
    let afterCount = 0;
    for (let index = start; index < end; index += 1) {
      if (edits[index].kind !== '+') beforeCount += 1;
      if (edits[index].kind !== '-') afterCount += 1;
    }
    const beforeStart = beforeNumbers[start] - (beforeCount ? 0 : 1);
    const afterStart = afterNumbers[start] - (afterCount ? 0 : 1);
    const hunk = [
      `@@ -${beforeStart},${beforeCount} +${afterStart},${afterCount} @@`,
      ...edits.slice(start, end).map(({ kind, line }) => `${kind}${line}`),
    ];
    for (const line of hunk) {
      size += line.length + 1;
      if (size > MAX_PATCH_CHARS) {
        return {
          patch: `${lines.join('\n')}\n`,
          insertions,
          deletions,
          oversized: true,
        };
      }
      lines.push(line);
    }
  }
  return {
    patch: `${lines.join('\n')}\n`,
    insertions,
    deletions,
    oversized: false,
  };
}

export async function readFileDiff(
  channels: ChannelClient,
  args: RemoteControlDiffReadPayload,
): Promise<RemoteControlDiffPayload> {
  if (!args.path) {
    throw new UnsupportedOperationError(
      'diff.read',
      'The combined worktree diff is not available over this connection. Open one file’s diff instead.',
    );
  }
  const source = args.source ?? 'uncommitted';
  const diff = await channels.invoke(C.activityFileDiff, isFileDiff, {
    projectId: args.workspaceId,
    worktreeId: args.worktreeId,
    filePath: args.path,
    source,
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
  });
  const base = {
    workspaceLocalId: args.workspaceId,
    worktreeLocalId: args.worktreeId,
    filePath: args.path,
  };
  const status =
    diff.oldValue.length === 0 && diff.newValue.length > 0
      ? 'added'
      : diff.newValue.length === 0 && diff.oldValue.length > 0
        ? 'deleted'
        : 'modified';
  const file = {
    filePath: args.path,
    status,
    ...(args.repoId !== undefined ? { repoId: args.repoId } : {}),
  };
  if (diff.binary) {
    return { ...base, files: [file], binary: true };
  }
  const patch = unifiedPatch(args.path, diff.oldValue, diff.newValue);
  return {
    ...base,
    files: [
      { ...file, insertions: patch.insertions, deletions: patch.deletions },
    ],
    ...(patch.patch !== undefined ? { patch: patch.patch } : {}),
    ...(patch.oversized || diff.truncated ? { oversized: true } : {}),
  };
}
