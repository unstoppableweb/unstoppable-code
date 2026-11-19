import { describeErrorForAppDiagnostic } from './app-diagnostic-privacy';
import type { AppDiagnosticRecord, SessionDiagnosticRecord } from './service';

export type MainProcessErrorKind =
  | 'main_unhandled_rejection'
  | 'main_uncaught_exception';

interface MainProcessErrorRecorder {
  recordAppDiagnostic(event: AppDiagnosticRecord): void;
  recordSessionDiagnostic(event: SessionDiagnosticRecord): void;
}

export function formatUnknownError(value: unknown): string {
  // A rejection can be any value, including one whose coercion, `instanceof`
  // or `stack` access throws. This runs inside a crash handler, so it must
  // describe such a value by its type instead of throwing.
  try {
    return value instanceof Error
      ? (value.stack ?? value.message)
      : String(value);
  } catch {
    return `[unformattable ${typeof value}]`;
  }
}

/**
 * Records a main-process `unhandledRejection` or `uncaughtException`. The
 * global app-events record keeps the error's name, code and stack frames; its
 * full text, which can quote worktree or chat identifiers, goes only to
 * session-events as `main_error_detail`.
 */
export function recordMainProcessError(
  recorder: MainProcessErrorRecorder,
  kind: MainProcessErrorKind,
  value: unknown,
  timestamp: string = new Date().toISOString(),
): void {
  recorder.recordAppDiagnostic({
    version: 1,
    timestamp,
    kind,
    error: describeErrorForAppDiagnostic(value, 'bounded'),
  });
  recorder.recordSessionDiagnostic({
    version: 1,
    timestamp,
    kind: 'main_error_detail',
    sessionKey: 'main-process',
    projectId: '',
    worktreeId: '',
    chatId: '',
    providerType: 'unknown',
    mainErrorKind: kind,
    error: formatUnknownError(value),
  });
}
