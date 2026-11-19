import type {
  RemoteControlChatMessageView,
  RemoteControlChatPart,
} from '@canopy/protocol/remote-control/shell';

/**
 * Host-neutral contract for a bound cloud conversation: what the client and
 * presentation layers read from a binding. Engine and wire state stay with
 * the host adapter, which extends these types.
 */
export interface ConversationHostIdentity {
  readonly accountKey: string;
  readonly authGeneration: string;
  readonly localChatId: string;
  readonly externalChatId: string;
  readonly workspaceLocalId: string;
  readonly worktreeLocalId: string;
}

export type ConversationHostStatus =
  | 'closed'
  | 'discovering'
  | 'opening'
  | 'ready'
  | 'error'
  | 'revoked';

export interface ConversationProjectedMessage extends Omit<
  RemoteControlChatMessageView,
  'parts'
> {
  readonly canonicalMessageId: string;
  readonly clientRequestId?: string;
  readonly turnId: string | null;
  readonly parts?: RemoteControlChatPart[];
}

export interface ConversationPresentationRow {
  readonly canonical: { readonly id: string };
  readonly projected: readonly ConversationProjectedMessage[];
}

export interface ConversationPresentationTurn {
  readonly turnId: string;
  /** The canonical id of the user message that opened the turn. */
  readonly userMessageId: string;
  readonly startedAtMs: number | null;
}

export interface ConversationPresentation {
  readonly hostStatus: ConversationHostStatus;
  readonly binding: ConversationHostIdentity | null;
  readonly sessionStatus: string;
  readonly transcript: readonly ConversationPresentationRow[];
  readonly activeExecution: ConversationPresentationTurn | null;
}

/** A binding the presentation layer opens, reads and closes. */
export interface ConversationPresentationSource<
  View extends ConversationPresentation = ConversationPresentation,
> {
  open(): Promise<void>;
  close(): void;
  getSnapshot(): View;
  subscribe(listener: () => void): () => void;
}
