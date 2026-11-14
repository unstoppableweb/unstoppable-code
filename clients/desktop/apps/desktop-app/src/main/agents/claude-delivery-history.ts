import { Buffer } from 'node:buffer';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  claudeProjectDirCandidates,
  findClaudeCodeSessionTranscriptCandidates,
  getClaudeCodeProjectsDir,
} from '../lib/claude-project-paths';

export type DeliveryHistoryVerdict = 'found' | 'not-found' | 'unreadable';

const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_LINES = 200_000;

interface ClaudeSessionLogRecord {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is ClaudeSessionLogRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Decides from the Claude CLI session log whether a steer reached the provider. */
export async function readClaudeDeliveryHistory(query: {
  sessionId: string;
  cwd: string;
  attemptId: string;
  /** The row id; a managed-delegation parent can yield it as the native uuid. */
  rowId: string;
  /** How many attempts the row has (a row-id match is ambiguous when > 1). */
  rowAttemptCount: number;
  /** The attempt was created before the current app process started. */
  previousRun: boolean;
  configDir?: string;
}): Promise<DeliveryHistoryVerdict> {
  try {
    const candidates = await findClaudeCodeSessionTranscriptCandidates(
      query.sessionId,
      query.cwd,
      query.configDir,
    );
    const projectsDir = getClaudeCodeProjectsDir(query.configDir, query.cwd);
    // Claude resumes the first current-cwd slug; migration retains old originals.
    const currentPath = (await claudeProjectDirCandidates(query.cwd))
      .map((slug) => path.join(projectsDir, slug, `${query.sessionId}.jsonl`))
      .find((candidate) => candidates.paths.includes(candidate));
    const transcriptPath = currentPath ?? candidates.paths[0];
    if (
      (!currentPath &&
        (candidates.scanExhausted || candidates.paths.length !== 1)) ||
      !transcriptPath
    ) {
      return 'unreadable';
    }

    const stream = createReadStream(transcriptPath);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    let byteCount = 0;
    let streamFailed = false;
    let byteBudgetExceeded = false;
    let lineBudgetExceeded = false;
    let invalidLine = false;
    let identityFound = false;
    let foreignSessionIdFound = false;
    let matchingUuidFound = false;
    let ambiguousRowMatch = false;
    let evidenceFound = false;

    stream.on('error', () => {
      streamFailed = true;
    });
    stream.on('data', (chunk: string | Buffer) => {
      byteCount += Buffer.isBuffer(chunk)
        ? chunk.length
        : Buffer.byteLength(chunk);
      if (byteCount > MAX_TRANSCRIPT_BYTES) {
        byteBudgetExceeded = true;
        lines.close();
        stream.destroy();
      }
    });

    let lineCount = 0;
    try {
      for await (const line of lines) {
        lineCount += 1;
        if (lineCount > MAX_TRANSCRIPT_LINES) {
          lineBudgetExceeded = true;
          stream.destroy();
          break;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          invalidLine = true;
          stream.destroy();
          break;
        }

        if (!isRecord(parsed)) continue;
        if ('sessionId' in parsed) {
          if (parsed.sessionId === query.sessionId) {
            identityFound = true;
          } else {
            foreignSessionIdFound = true;
          }
        }

        const uuid = parsed.uuid;
        const isAttemptMatch = uuid === query.attemptId;
        const isRowMatch = uuid === query.rowId;
        if (!isAttemptMatch && !isRowMatch) continue;

        matchingUuidFound = true;
        if (parsed.type !== 'user' || parsed.isSidechain === true) continue;
        if (isAttemptMatch) evidenceFound = true;
        if (isRowMatch) {
          if (query.rowAttemptCount === 1) {
            evidenceFound = true;
          } else {
            ambiguousRowMatch = true;
          }
        }
      }
    } catch {
      return 'unreadable';
    } finally {
      lines.close();
      stream.destroy();
    }

    if (
      byteBudgetExceeded ||
      streamFailed ||
      lineBudgetExceeded ||
      invalidLine ||
      foreignSessionIdFound ||
      !identityFound
    ) {
      return 'unreadable';
    }
    if (ambiguousRowMatch) return 'unreadable';
    if (evidenceFound) return 'found';
    if (matchingUuidFound || !query.previousRun) return 'unreadable';
    return 'not-found';
  } catch {
    return 'unreadable';
  }
}
