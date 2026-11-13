/**
 * Runtime guard for the provider contract (turn-state phases 43a, 43b). The update
 * gate checks the bundled harness, but a user-supplied binary or a
 * server-side change can still emit frames the lifecycle tables don't know.
 * The guard reports them, without payload text, and never changes behavior.
 */
import { CLAUDE_LIFECYCLE } from '@canopy/desktop-shared/node/harness-contract/claude-lifecycle';
import { CODEX_LIFECYCLE } from '@canopy/execution-engine/node/harness-contract/codex-lifecycle';
import type { SessionDiagnosticRecord } from '../observability/service';

interface GuardScope {
  sessionKey: string;
  projectId: string;
  worktreeId: string;
  chatId: string;
}

// A label is a provider identifier, never text: bounded and identifier-shaped.
const LABEL_PATTERN = /^[a-z0-9_./-]{1,64}$/i;

function label(value: string): string {
  return LABEL_PATTERN.test(value) ? value : 'unrecognized';
}

function hasOwn(table: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(table, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The bounded name of a Claude SDK frame the lifecycle tables don't classify,
 * or undefined. Host events (`canopy_*`) are not provider frames.
 */
export function unclassifiedClaudeEvent(data: unknown): string | undefined {
  if (!isRecord(data) || typeof data.type !== 'string') return undefined;
  const type = data.type;
  if (type.startsWith('canopy_')) return undefined;
  if (!hasOwn(CLAUDE_LIFECYCLE.messageTypes, type)) return label(type);
  if (typeof data.subtype !== 'string') return undefined;
  if (
    type === 'system' &&
    !hasOwn(CLAUDE_LIFECYCLE.systemSubtypes, data.subtype)
  )
    return label(`system/${data.subtype}`);
  if (
    type === 'result' &&
    !hasOwn(CLAUDE_LIFECYCLE.resultSubtypes, data.subtype)
  )
    return label(`result/${data.subtype}`);
  return undefined;
}

export interface ClaudeContractGuard {
  /**
   * Observe one SDK frame as the session receives it, and whether the session
   * treats it as a root result. Only provider frames reach it, so a
   * host-synthesized terminal never counts as a result.
   */
  observe(data: unknown, rootResult?: boolean): void;
  /** A new CLI process: its version and gate health are checked again. */
  processRestarted(): void;
}

type GuardEmit = (
  kind:
    | 'provider_contract_unknown_event'
    | 'provider_contract_gate_missing'
    | 'provider_harness_version',
  fields: Pick<
    SessionDiagnosticRecord,
    'providerContractEvent' | 'providerHarnessVersion'
  >,
) => void;

function guardEmitter(
  scope: GuardScope,
  providerType: 'claude' | 'codex',
  record: (diagnostic: SessionDiagnosticRecord) => void,
): GuardEmit {
  return (kind, fields) => {
    try {
      record({
        version: 1,
        timestamp: new Date().toISOString(),
        kind,
        ...scope,
        providerType,
        ...fields,
      });
    } catch {
      // Diagnostics are best-effort and must never change provider ingestion.
    }
  };
}

/**
 * `expectsSessionState`: the session asked the CLI for `session_state_changed`
 * events, so a root result that arrives before any is a missing gate.
 */
export function createClaudeContractGuard(
  scope: GuardScope,
  record: (diagnostic: SessionDiagnosticRecord) => void,
  expectsSessionState: boolean,
): ClaudeContractGuard {
  const unknownEvents = new Set<string>();
  let versionRecorded = false;
  let sessionStateSeen = false;
  let gateMissingRecorded = false;
  const emit = guardEmitter(scope, 'claude', record);
  return {
    observe(data, rootResult = false): void {
      const unknown = unclassifiedClaudeEvent(data);
      if (unknown !== undefined && !unknownEvents.has(unknown)) {
        unknownEvents.add(unknown);
        emit('provider_contract_unknown_event', {
          providerContractEvent: unknown,
        });
      }
      if (
        !versionRecorded &&
        isRecord(data) &&
        data.type === 'system' &&
        data.subtype === 'init' &&
        typeof data.claude_code_version === 'string'
      ) {
        versionRecorded = true;
        emit('provider_harness_version', {
          providerHarnessVersion: label(data.claude_code_version),
        });
      }
      if (
        isRecord(data) &&
        data.type === 'system' &&
        data.subtype === 'session_state_changed'
      ) {
        sessionStateSeen = true;
      } else if (
        rootResult &&
        expectsSessionState &&
        !sessionStateSeen &&
        !gateMissingRecorded
      ) {
        gateMissingRecorded = true;
        emit('provider_contract_gate_missing', {
          providerContractEvent: 'system/session_state_changed',
        });
      }
    },
    processRestarted(): void {
      versionRecorded = false;
      sessionStateSeen = false;
      gateMissingRecorded = false;
    },
  };
}

/**
 * The bounded name of a Codex notification method the lifecycle table doesn't
 * classify, or undefined. The table covers the generated protocol, so a hit
 * is a binary newer or older than the bundled one.
 */
export function unclassifiedCodexNotification(
  method: string,
): string | undefined {
  return hasOwn(CODEX_LIFECYCLE.notificationMethods, method)
    ? undefined
    : label(method);
}

export interface CodexContractGuard {
  /**
   * Observe one app-server notification as the session receives it, with the
   * user agent its process reported to `initialize` (undefined before then).
   */
  observe(method: string, userAgent: string | undefined): void;
}

export function createCodexContractGuard(
  scope: GuardScope,
  record: (diagnostic: SessionDiagnosticRecord) => void,
): CodexContractGuard {
  const unknownMethods = new Set<string>();
  let recordedVersion: string | undefined;
  const emit = guardEmitter(scope, 'codex', record);
  return {
    observe(method, userAgent): void {
      const unknown = unclassifiedCodexNotification(method);
      if (unknown !== undefined && !unknownMethods.has(unknown)) {
        unknownMethods.add(unknown);
        emit('provider_contract_unknown_event', {
          providerContractEvent: unknown,
        });
      }
      // The agent is `<originator>/<version> (<os>; <arch>) <terminal>`; keep
      // the leading token. The process is pooled, so record each new value.
      const version =
        userAgent === undefined
          ? undefined
          : label(userAgent.split(' ', 1)[0] ?? '');
      if (version !== undefined && version !== recordedVersion) {
        recordedVersion = version;
        emit('provider_harness_version', { providerHarnessVersion: version });
      }
    },
  };
}
