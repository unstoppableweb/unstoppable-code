import {
  allowlistedErrorCode,
  allowlistedErrorName,
} from './telemetry-error-details';
import type { AppDiagnosticRecord } from './service';

/**
 * `diagnostics/app-events/` is global, so it must never carry an identifier
 * that locates a worktree or chat (`CLAUDE.md`, Agent Observability). Those
 * diagnostics belong in `diagnostics/session-events/`.
 *
 * The record type declares no such field, and the privacy test fails when one
 * is added or a call site builds one. This sanitizer is the runtime guard for
 * what the type cannot see: a property copied in by a spread, and an
 * identifier embedded in free text such as an error message's path.
 */

// A worktree, chat, tab, session, Work Entry or chat-storage scope id, or the
// workspace (project) id that together with one of them locates it. In Cowork
// the worktree slot holds a Work Entry id.
const IDENTIFIER_KEY =
  /(?:^|[a-z])(?:[Ww]orktree|[Cc]hat|[Tt]ab|[Ss]ession|[Ww]orkEntry|[Ee]ntry|[Ss]cope|[Pp]roject|[Ww]orkspace)(?:Id|Ids|Key|Keys)$/;

/**
 * Directories of the unified data layout whose next path segment is a
 * workspace, worktree, Work Entry, chat-storage scope or chat id.
 */
const IDENTIFIER_DIRECTORIES = [
  'workspaces',
  'worktrees',
  'worktree-data',
  'chat-storage-v2',
  'chat-storage-manifests',
  'chat-history',
  'chat-archives',
  'chat-journals',
  'chats',
  'summaries',
  'attachments',
  'script-runs',
  'plans',
  'detected-plans',
  'archived-containers',
];

const IDENTIFIER_SEGMENT = new RegExp(
  `([\\\\/])(${IDENTIFIER_DIRECTORIES.join('|')})([\\\\/])[^\\\\/\\s'"\`]+`,
  'g',
);

export const REDACTED_SEGMENT = '<redacted>';

/**
 * Fields named like an identifier that hold a one-way key instead: the value
 * groups records about one chat without locating it. Each entry names the
 * producer that derives it, and the privacy test checks that derivation.
 *
 * - `chatTranscriptRewriteChatKey`: `chat-transcript-rewrite-diagnostics.ts`
 *   writes the first 16 hex characters of a domain-separated SHA-256 of the
 *   chat id, so a chat's full-rewrite records can be correlated and rate
 *   limited.
 */
const OPAQUE_KEY_FIELDS: ReadonlySet<string> = new Set([
  'chatTranscriptRewriteChatKey',
]);

/** Whether a property name holds a worktree, chat, or scope identifier. */
export function isAppDiagnosticIdentifierKey(key: string): boolean {
  return IDENTIFIER_KEY.test(key) && !OPAQUE_KEY_FIELDS.has(key);
}

function redactIdentifierSegments(value: string): string {
  return value.replace(IDENTIFIER_SEGMENT, `$1$2$3${REDACTED_SEGMENT}`);
}

/**
 * Drops identifier-named properties and redacts identifier path segments.
 * Returns the record itself when it carries neither, so the common case
 * allocates nothing.
 */
export function sanitizeAppDiagnosticRecord(
  record: AppDiagnosticRecord,
): AppDiagnosticRecord {
  let sanitized: AppDiagnosticRecord | undefined;
  for (const [key, value] of Object.entries(record)) {
    if (isAppDiagnosticIdentifierKey(key)) {
      sanitized ??= { ...record };
      Reflect.deleteProperty(sanitized, key);
      continue;
    }
    if (typeof value !== 'string') continue;
    const redacted = redactIdentifierSegments(value);
    if (redacted === value) continue;
    sanitized ??= { ...record };
    Reflect.set(sanitized, key, redacted);
  }
  return sanitized ?? record;
}

/**
 * An error as the global app-events may keep it: its name, its code when it
 * has one, and its stack frames, which are code locations. The message is
 * dropped because it can quote any worktree or chat identifier, including a
 * bare `<workspaceId>/<worktreeId>` pair no path rule recognizes. A value that
 * is not an Error is described by its type alone.
 * Main-process producers select bounded metadata; local-only org-fork records
 * keep their existing custom names and string/numeric codes.
 */
export function describeErrorForAppDiagnostic(
  value: unknown,
  metadata: 'local' | 'bounded' = 'local',
): string {
  // Runs inside the crash handler on any thrown or rejected value, so a value
  // whose `instanceof`, `name` or `stack` access throws is described by its
  // type instead.
  try {
    if (!(value instanceof Error)) return `non-error ${typeof value} value`;
    const rawCode: unknown = Reflect.get(value, 'code');
    const code =
      metadata === 'bounded' ? allowlistedErrorCode(rawCode) : rawCode;
    const name =
      metadata === 'bounded' ? allowlistedErrorName(value.name) : value.name;
    const head =
      typeof code === 'string' || typeof code === 'number'
        ? `${name} [${code}]`
        : name;
    const stack: unknown = value.stack;
    const frames = (typeof stack === 'string' ? stack : '')
      .split('\n')
      .filter((line) => /^\s+at /.test(line));
    return [head, ...frames].join('\n');
  } catch {
    return `[unformattable ${typeof value}]`;
  }
}
