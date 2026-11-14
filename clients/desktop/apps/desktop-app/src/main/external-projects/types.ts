import type {
  ExternalProjectProvider,
  ExternalProjectSurface,
} from '@canopy/desktop-shared/types';

/**
 * Internal evidence model shared by the discovery adapters and the
 * normalizer. Adapters emit one {@link DiscoveredRoot} per observed folder
 * root; the normalizer canonicalizes paths, groups repository families, and
 * folds several roots into one renderer-facing candidate.
 */

export type DiscoveredSessionKind =
  | 'claude-jsonl'
  | 'codex-rollout'
  | 't3-thread'
  | 'opencode-session';

export interface DiscoveredSession {
  id: string;
  provider: ExternalProjectProvider;
  surface: ExternalProjectSurface;
  kind: DiscoveredSessionKind;
  /** Working directory the provider recorded for the session. */
  cwd: string;
  /** Absolute path of the transcript or rollout file. */
  sourcePath: string;
  title: string | null;
  startedAt: string | null;
  lastActivityAt: string | null;
  sizeBytes: number;
  /**
   * False for sessions Canopy or another SDK host generated. Those never
   * become importable chats; they still count as evidence that the folder is
   * a project.
   */
  native: boolean;
  /**
   * The transcript behind a session whose own record is only an index entry
   * (a T3 Code thread pointing at a Claude or Codex file, for example).
   */
  backing?: {
    provider: 'claude' | 'codex' | 'opencode';
    kind: 'claude-jsonl' | 'codex-rollout' | 'opencode-session';
    sourcePath: string;
    id: string;
    /** Size of the native record: the file, or an OpenCode session's message bytes. */
    sizeBytes: number;
  };
  /** The source marks the session archived. */
  archived?: boolean;
  /**
   * T3 `thread_id` or OpenCode `session_v2.id`, when `id` is a native id
   * rather than the store's own.
   */
  storeId?: string;
  /**
   * Other ids the conversation is known by in the import ledger. A T3 thread
   * names its agent's native session id here whether or not that record still
   * resolves, so a chat imported earlier through the agent's own record is
   * still found after the record is compressed or deleted.
   */
  aliasIds?: string[];
  /** T3 Code's driver id for the agent that ran a T3 thread (`codex`, `cursor`, `grok`, …). */
  driver?: string;
}

export interface DiscoveredRoot {
  provider: ExternalProjectProvider;
  surface: ExternalProjectSurface;
  /** Every surface merged into this root by its adapter; `surface` is the first. */
  surfaces?: ExternalProjectSurface[];
  /** Folder path exactly as the provider recorded it (not yet canonical). */
  rootPath: string;
  /** Provider-assigned project name, when the surface has one. */
  displayName?: string;
  lastActivityAt: string | null;
  sessions: DiscoveredSession[];
}

export interface DiscoveryDiagnostic {
  source: string;
  message: string;
}

export interface AdapterResult {
  roots: DiscoveredRoot[];
  diagnostics: DiscoveryDiagnostic[];
  /** Whether the provider store exists on this machine at all. */
  detected: boolean;
}

export interface DiscoveryLimits {
  /** Provider session files inspected per adapter. */
  maxSessionFiles: number;
  /** Session files inspected per Claude project directory. */
  maxSessionFilesPerProject: number;
  /** Bytes read from the head of a session file for metadata. */
  headBytes: number;
  /** Provider desktop records inspected per record tree. */
  maxDesktopRecords: number;
  /** Explicit project keys accepted from a provider registry file. */
  maxRegistryEntries: number;
  /**
   * Largest provider registry file (`~/.claude.json`) read in full. Beyond
   * this the file is skipped with a diagnostic instead of parsing tens of
   * megabytes on the Electron main thread.
   */
  maxGlobalConfigBytes: number;
  /** Largest Claude Desktop session record read; larger records are skipped. */
  maxDesktopRecordBytes: number;
  /**
   * Stats and file reads in flight at once across one adapter's whole scan:
   * one pool is shared by every directory and every file, so the bound is
   * this number, not a product of nested pools. A scan is bound by per-call
   * latency, not bytes, so the pool shortens it by roughly this factor
   * without changing what is read.
   */
  maxConcurrentReads: number;
}

// Sized for a heavy local store: several thousand transcripts across
// hundreds of project directories. Session metadata (cwd, id, entrypoint,
// first prompt) sits in the first few KiB, so a small head per file buys
// a larger file budget for the same bytes read.
export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = {
  maxSessionFiles: 8000,
  maxSessionFilesPerProject: 40,
  headBytes: 16 * 1024,
  maxDesktopRecords: 1500,
  maxRegistryEntries: 5000,
  maxGlobalConfigBytes: 16 * 1024 * 1024,
  maxDesktopRecordBytes: 1024 * 1024,
  maxConcurrentReads: 16,
};
