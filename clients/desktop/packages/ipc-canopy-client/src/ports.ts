import type {
  CanopyCapabilities,
  CanopyClient,
  ConnectionStatusEvent,
  QueryMap,
  TranscriptReadClient,
  Unsubscribe,
} from '@canopy/app-core';
import type { MarketplaceSourcesClient } from '@canopy/app-core/client';
import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { ToolFamilyResolver } from '@canopy/agent-transcript/portal/persisted-chat-projection';
import type { FeedbackReportClient } from '@canopy/protocol/feedback-report';
import type { RemoteIpcTransport } from '@canopy/protocol/remote-control';
import type { TerminalOutputEvent } from '@canopy/protocol/terminal';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { WireFileTreeRoot } from './wire';

/** The active standalone (cowork) chat work this window shows, if any. */
export interface StandaloneChatActiveWork {
  readonly chatProjectId: string | null;
  readonly workEntryId: string | null;
}

/** The file queries a host serves for a work entry outside its IPC host. */
export type ScopedFileQueries = {
  readonly [Method in 'file.read' | 'file.resolveLink' | 'file.roots']: (
    args: QueryMap[Method]['args'],
  ) => Promise<QueryMap[Method]['result']>;
};

/** Carry the open tabs of a base worktree into a newly branched one. */
export interface WorktreeStateForkRequest {
  readonly projectId: string;
  readonly sourceWorktreeId: string;
  readonly destinationWorktreeId: string;
}

/**
 * Host services the adapter cannot reach over the IPC transport: window
 * state, host-local behavior and the sibling client slices each host serves
 * its own way. Every member is optional except the capability set and
 * `openExternalUrl`; an absent port takes the documented default.
 */
export interface IpcCanopyClientPorts {
  /**
   * The capabilities this client reports, already narrowed for the host
   * (platform and voice, settings bridge, organization operations) and for
   * the controller (`intersectCanopyCapabilities`).
   */
  readonly capabilities: CanopyCapabilities;
  /**
   * Channels this controller may use. When set, the adapter refuses any
   * other channel before the transport with
   * `RemoteIpcChannelUnauthorizedError`. Absent: the transport's policy.
   */
  readonly authorizedChannels?: ReadonlySet<string>;
  /** Open a URL on the device the person is using. */
  readonly openExternalUrl: (url: string) => void;
  /**
   * The workspace context this window is looking at. `orgProjects.setPreference`
   * files the preference under it. Default: Personal.
   */
  readonly workspaceContext?: () => WorkspaceContext;
  /**
   * The active standalone chat work. A standalone `chat.persistTabSettings`
   * without a Work Entry id falls back to it, then to the legacy home id.
   */
  readonly standaloneChatActiveWork?: () => StandaloneChatActiveWork;
  /**
   * Whether a project id is a cowork chat target (standalone chats, App
   * Advisor, cowork workspaces). Default: only the standalone project id.
   */
  readonly isCoworkChatTarget?: (projectId: string) => boolean;
  /** Carry open tabs for `worktree.create` with `forkOpenTabs`. Absent: skipped. */
  readonly forkWorktreeState?: (
    request: WorktreeStateForkRequest,
  ) => Promise<void>;
  /**
   * A host-local, read-only file root (archived attachments) by id. It wins
   * over the host's catalog roots for reads.
   */
  readonly resolveLocalFileRoot?: (
    rootId: string,
  ) => WireFileTreeRoot | undefined;
  /**
   * File reads for a work entry the host serves elsewhere, such as a cloud
   * chat over the web core (CAN-6175). Undefined keeps the IPC reads.
   */
  readonly scopedFiles?: (worktreeId: string) => ScopedFileQueries | undefined;
  /** Report a recovered, non-fatal failure. Default: dropped. */
  readonly logError?: (message: string, details: { error: unknown }) => void;
  /** Stamps `toolFamily` on projected `tool_use` parts. Absent leaves it unset. */
  readonly toolFamilyFor?: ToolFamilyResolver;
  /**
   * Host-local `chat:event-output-reset` for transports that deliver
   * encoded `chat:event` outputs. Never tunneled; see `createChatEventSource`.
   */
  readonly requestChatEventOutputReset?: (epoch: string) => Promise<void>;
  /**
   * The transport delivers `chat:event` already decoded (the desktop preload
   * decodes once per page), so the adapter only fans out. Default: decode.
   */
  readonly chatEventsDecoded?: boolean;
  /**
   * `connection.status`. Default: the link is always active (the local
   * desktop), emitted once.
   */
  readonly subscribeConnectionStatus?: (
    handler: (event: ConnectionStatusEvent) => void,
  ) => Unsubscribe;
  /** Wraps each `terminal.output` delivery; must call `deliver`. */
  readonly observeTerminalOutput?: (
    event: TerminalOutputEvent,
    deliver: () => void,
  ) => void;
  /** ISO time for derived `occurredAt` fields. Default: now. */
  readonly now?: () => string;
  /** A fresh command id. Default: `crypto.randomUUID()`. */
  readonly randomId?: () => string;
  /**
   * Stores a composer attachment on the computer and returns its path there
   * (a remote session's `upload.put`, CAN-5985). Absent: attachment uploads
   * and sends that carry them are refused.
   */
  readonly uploadFile?: (
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<string>;
  /**
   * The controller's App Advisor surface on the same session: where the
   * computer delivers Orchestrator questions and expects their answers
   * (CAN-5985). Calls on it use the same channel authorization. Absent: the
   * Orchestrator operations are refused.
   */
  readonly appAdvisorTransport?: RemoteIpcTransport;
  /** Sibling slices served by the host. Absent members stay unset. */
  readonly transcripts?: TranscriptReadClient;
  readonly feedback?: FeedbackReportClient;
  readonly marketplaceSources?: MarketplaceSourcesClient;
  readonly settings?: AccountOrganizationSettingsClient;
}

/** The client `createIpcCanopyClient` returns. */
export type IpcCanopyClient = CanopyClient;
