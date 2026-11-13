import { CanopyOperationError } from '@canopy/core-runtime';
import {
  PIPELINE_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { withAgentPlace } from '../canopy-runtime/agent-place';
import { activeAgentCoreOperations } from './active-agent-core-operations';

export interface PipelineYamlLineRange {
  startLine: number;
  endLine?: number;
}

export interface PipelineYamlReadRequest {
  projectId: string;
  worktreeId: string;
  pipelineId: string;
  repoId?: string;
  startLine?: number;
  endLine?: number;
  ranges?: PipelineYamlLineRange[];
  pattern?: string;
  fixedString?: boolean;
  ignoreCase?: boolean;
  invertMatch?: boolean;
  context?: number;
  beforeContext?: number;
  afterContext?: number;
  maxMatches?: number;
}

export interface PipelineYamlReadResult {
  ok: boolean;
  text?: string;
  error?: string;
}

interface LoadedPipelineYaml {
  info: { id: string; name: string; source: string };
  raw: string;
}

interface NumberedLine {
  lineNumber: number;
  text: string;
}

const MAX_REGEX_PATTERN_LENGTH = 1000;

function splitLines(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) {
    lines.pop();
  }
  return lines;
}

function selectRange(
  totalLines: number,
  range: PipelineYamlLineRange,
): number[] {
  const start = range.startLine;
  const end = range.endLine ?? totalLines;
  if (start > end) {
    throw new Error('startLine must be less than or equal to endLine.');
  }
  const clampedStart = Math.max(1, start);
  const clampedEnd = Math.min(totalLines, end);
  const selected: number[] = [];
  for (let line = clampedStart; line <= clampedEnd; line += 1) {
    selected.push(line);
  }
  return selected;
}

function selectLineNumbers(
  request: PipelineYamlReadRequest,
  totalLines: number,
): number[] {
  const requestedRanges =
    request.ranges && request.ranges.length > 0
      ? request.ranges
      : [
          {
            startLine: request.startLine ?? 1,
            endLine: request.endLine ?? totalLines,
          },
        ];
  const selected = new Set<number>();
  for (const range of requestedRanges) {
    for (const lineNumber of selectRange(totalLines, range)) {
      selected.add(lineNumber);
    }
  }
  return Array.from(selected).sort((left, right) => left - right);
}

function createMatcher(
  request: PipelineYamlReadRequest,
): ((line: string) => boolean) | null {
  const pattern = request.pattern;
  if (!pattern) return null;
  if (request.fixedString) {
    const needle = request.ignoreCase ? pattern.toLowerCase() : pattern;
    return (line: string) => {
      const haystack = request.ignoreCase ? line.toLowerCase() : line;
      return haystack.includes(needle);
    };
  }
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `Regex pattern must be at most ${MAX_REGEX_PATTERN_LENGTH} characters.`,
    );
  }
  const regex = new RegExp(pattern, request.ignoreCase ? 'i' : undefined);
  return (line: string) => regex.test(line);
}

function filterLines(
  entries: NumberedLine[],
  request: PipelineYamlReadRequest,
): {
  lines: NumberedLine[];
  matchedLineCount: number;
  truncatedMatches: boolean;
} {
  const matcher = createMatcher(request);
  if (!matcher) {
    return {
      lines: entries,
      matchedLineCount: entries.length,
      truncatedMatches: false,
    };
  }

  const before = request.context ?? request.beforeContext ?? 0;
  const after = request.context ?? request.afterContext ?? 0;
  const maxMatches = request.maxMatches;
  const matchedIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const matched = matcher(entry.text);
    if (request.invertMatch ? !matched : matched) {
      if (maxMatches !== undefined && matchedIndexes.length >= maxMatches) {
        return {
          lines: expandContext(entries, matchedIndexes, before, after),
          matchedLineCount: matchedIndexes.length,
          truncatedMatches: true,
        };
      }
      matchedIndexes.push(index);
    }
  }
  return {
    lines: expandContext(entries, matchedIndexes, before, after),
    matchedLineCount: matchedIndexes.length,
    truncatedMatches: false,
  };
}

function expandContext(
  entries: NumberedLine[],
  matchedIndexes: number[],
  before: number,
  after: number,
): NumberedLine[] {
  const selected = new Set<number>();
  for (const index of matchedIndexes) {
    const start = Math.max(0, index - before);
    const end = Math.min(entries.length - 1, index + after);
    for (let selectedIndex = start; selectedIndex <= end; selectedIndex += 1) {
      selected.add(selectedIndex);
    }
  }
  return Array.from(selected)
    .sort((left, right) => left - right)
    .map((index) => entries[index])
    .filter((entry): entry is NumberedLine => entry !== undefined);
}

function formatLine(entry: NumberedLine, width: number): string {
  return `${String(entry.lineNumber).padStart(width, ' ')}: ${entry.text}`;
}

/** ReadPipelineYaml reads definitions as its own principal, with only the read grant (CAN-5991). */
const AGENT_PIPELINE_YAML_CALLER: CanopyCallerDescriptor = {
  principalId: 'desktop-agent-pipeline-yaml',
  clientInstanceId: 'desktop-main',
  authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
  interfaceKind: 'mcp',
  grants: [PIPELINE_GRANTS.read],
};

async function loadPipelineYaml(
  request: PipelineYamlReadRequest,
): Promise<LoadedPipelineYaml | null> {
  try {
    // The session's place reaches core's owned-workflow rule host-locally,
    // never from the read's scope (CAN-6032).
    const { definition } = await withAgentPlace(
      AGENT_PIPELINE_YAML_CALLER,
      { workspaceId: request.projectId, worktreeId: request.worktreeId },
      () =>
        activeAgentCoreOperations('pipelineYaml').query(
          'core.pipeline.definition.get',
          {
            definitionId: request.pipelineId,
            scope: {
              workspaceId: request.projectId,
              worktreeId: request.worktreeId,
              ...(request.repoId ? { repoId: request.repoId } : {}),
            },
          },
          { caller: AGENT_PIPELINE_YAML_CALLER },
        ),
    );
    return {
      info: {
        id: definition.definitionId,
        name: definition.name,
        source: definition.source,
      },
      raw: definition.document,
    };
  } catch (error) {
    if (
      error instanceof CanopyOperationError &&
      error.payload.code === 'core.pipeline.definitionNotFound'
    )
      return null;
    throw error;
  }
}

export async function readWorktreePipelineYaml(
  request: PipelineYamlReadRequest,
): Promise<PipelineYamlReadResult> {
  let loaded: LoadedPipelineYaml | null;
  try {
    loaded = await loadPipelineYaml(request);
  } catch (error) {
    return {
      ok: false,
      error: `Failed to load pipeline YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!loaded) {
    return {
      ok: false,
      error: `Pipeline ${request.pipelineId} was not found.`,
    };
  }

  const rawLines = splitLines(loaded.raw);
  let selectedLineNumbers: number[];
  try {
    selectedLineNumbers = selectLineNumbers(request, rawLines.length);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const rangedLines = selectedLineNumbers.map((lineNumber) => ({
    lineNumber,
    text: rawLines[lineNumber - 1] ?? '',
  }));

  let filtered: ReturnType<typeof filterLines>;
  try {
    filtered = filterLines(rangedLines, request);
  } catch (error) {
    return {
      ok: false,
      error: `Invalid grep pattern: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const width = String(rawLines.length).length;
  const filterSummary = request.pattern
    ? [
        `Pattern: ${request.pattern}`,
        `Matched lines: ${String(filtered.matchedLineCount)}`,
        ...(filtered.truncatedMatches
          ? ['Matches truncated by maxMatches.']
          : []),
      ]
    : [];
  const body =
    filtered.lines.length > 0
      ? filtered.lines.map((entry) => formatLine(entry, width)).join('\n')
      : 'No lines matched.';

  return {
    ok: true,
    text: [
      `Pipeline YAML: ${loaded.info.name} (${loaded.info.id})`,
      `Source: ${loaded.info.source}`,
      `Total lines: ${String(rawLines.length)}`,
      ...filterSummary,
      '---',
      body,
    ].join('\n'),
  };
}
