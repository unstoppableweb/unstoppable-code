import { locateTurnFilePath } from '@canopy/protocol/turn-files';
export { turnFilePath } from '@canopy/protocol/file-path';
import type { TranscriptTurnFile } from '@canopy/agent-transcript/transcript-storage';
import {
  collectTurnFiles as collectTranscriptTurnFiles,
  type TurnFileCollectionOptions,
} from '@canopy/agent-transcript/lib/turn-files';
export {
  turnFileTarget,
  turnFileWritePaths,
} from '@canopy/agent-transcript/lib/turn-files';
import type { TurnMessage } from './turn-utils';
import { CANOPY_INJECTED_TOOL_REGISTRY } from './canopy-injected-tools';
import { getCanonicalAppAdvisorToolKey } from './app-advisor-tools';

const SHOW_FILES_NAMES = new Set([
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.displayName,
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.claudeToolName,
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.codexToolName,
  CANOPY_INJECTED_TOOL_REGISTRY.show_files.cursorToolName,
  ...CANOPY_INJECTED_TOOL_REGISTRY.show_files.legacyToolNames,
]);

const collectionOptions: TurnFileCollectionOptions = {
  presentationTool: (name) =>
    getCanonicalAppAdvisorToolKey(name) === 'show_files'
      ? 'advisor'
      : SHOW_FILES_NAMES.has(name)
        ? 'files'
        : undefined,
};

/** Shared derivation with the desktop registry's exact presentation identities. */
export function collectTurnFiles(
  messages: readonly TurnMessage[],
  retained: readonly TranscriptTurnFile[] = [],
): TranscriptTurnFile[] {
  return collectTranscriptTurnFiles(messages, retained, collectionOptions);
}

/** Windows paths compare case-insensitively. */
function foldsCase(file: TurnFileLocation): boolean {
  return /^(?:[a-z]:\/|\/\/)/i.test(file.absolutePath);
}

function changedPathKey(repoId: string, path: string): string {
  return `${repoId}\0${path}`;
}

export interface TurnFileRoot {
  repoId: string;
  absolutePath: string;
}

/** A turn file projected onto one of the target's advertised roots. */
export interface TurnFileLocation {
  /** Transcript path identity, unchanged, for opening and keys. */
  path: string;
  /** Normalized absolute path with forward slashes. */
  absolutePath: string;
  repoId: string;
  /** Root-relative path with forward slashes, the changed-file record form. */
  relativePath: string;
  /** Explicit workspace selected by an App Advisor ShowFiles call. */
  target?: TranscriptTurnFile['target'];
  /** Edit of an existing file; omitted for saved files. */
  change?: TranscriptTurnFile['change'];
  /** Successful Write/add evidence, retained for canonical deduplication. */
  saved?: true;
}

/** Project a path into the host roots; existence is checked separately. */
export function locateTurnFile(
  path: string,
  roots: readonly TurnFileRoot[],
): TurnFileLocation | undefined {
  const result = locateTurnFilePath(
    path,
    roots.map((root) => ({ id: root.repoId, absolutePath: root.absolutePath })),
  );
  return result
    ? {
        path,
        absolutePath: result.absolutePath,
        repoId: result.rootId,
        relativePath: result.relativePath,
      }
    : undefined;
}

/** Files the turn diff does not already list; a diff is the primary home. */
export function turnFilesOutsideDiff<T extends TurnFileLocation>(
  files: readonly T[],
  turnDiff: { files: readonly { path: string; repoId?: string }[] } | undefined,
  primaryRepoId?: string,
): T[] {
  if (!turnDiff?.files.length) return [...files];
  // Index the diff once: it can list thousands of paths.
  const exact = new Set<string>();
  const folded = new Set<string>();
  for (const changed of turnDiff.files) {
    const repoId = changed.repoId ?? primaryRepoId;
    if (repoId === undefined) continue;
    const path = changed.path.replace(/\\/g, '/');
    exact.add(changedPathKey(repoId, path));
    folded.add(changedPathKey(repoId, path.toLowerCase()));
  }
  return files.filter((file) =>
    foldsCase(file)
      ? !folded.has(
          changedPathKey(file.repoId, file.relativePath.toLowerCase()),
        )
      : !exact.has(changedPathKey(file.repoId, file.relativePath)),
  );
}
