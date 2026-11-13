'use client';

import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  AgentSentTitle,
  useAgentSentReceivingContext,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import {
  ChatMessageMedia,
  useChatMessageAttachmentSplit,
} from './ChatMessageAttachments';
import {
  Fragment,
  memo,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  foldedPortalToolOccurrenceIds,
  isFoldedPortalToolResult,
  pairToolResultOccurrences,
  portalToolPartOccurrence,
  readPortalChatPartVisual,
  readPortalToolOutputLocator,
  type PortalChatMessage,
  type PortalChatPart,
  readChatPromptSource,
  readChatWatcherFired,
  type PortalChatMessageAttachment,
} from '@canopy/protocol/portal';
import {
  AutoResumeMarker,
  CanopyProxyErrorSummary,
  DEFAULT_MARKDOWN_OPTIONS,
  Markdown,
  SteeringTitle,
  hostMessagePresentation,
  readMessageAutoResume,
  SharedChatAuthorHeader,
  UserBubble,
  hasSteeringChatPart,
  MARKDOWN_ROOT_PROPS,
  splitSubagentReference,
  SubagentReferenceAttachment,
  useChatMessageContextMenu,
  useCleanChatLook,
  useSmoothStreaming,
  withSoftLineBreaks,
  type MarkdownOptions,
  type PlanCopyState,
  type TurnTerminalStatus,
  TRANSCRIPT_PROSE_CLASS,
} from '@canopy/ui-shared/components';
import { parseCanopyProxyError } from '@canopy/protocol';
import { isAccountProxySettingsFailure } from '@canopy/protocol/auth-recovery';
import { AccountProxyFailureNotice } from '@canopy/ui-shared/components';
import { FailedIcon } from '@canopy/ui-shared/icons';
import {
  stripOpaqueAgentCitationMarkers,
  stripProposedPlanEnvelope,
} from '@canopy/ui-shared/lib';
import { ChatPartView } from './ChatPartView';
import { useTranscriptProseOptions } from './TranscriptFileLinks';
import { useChatMessageAuthor } from './ChatMessageAuthorContext';

/**
 * User bubbles keep the newlines the person typed (CAN-2811); agent prose
 * stays on the default soft-break handling.
 */
const USER_MARKDOWN_OPTIONS: MarkdownOptions = withSoftLineBreaks(
  DEFAULT_MARKDOWN_OPTIONS,
);

const PROSE_CLASSES = TRANSCRIPT_PROSE_CLASS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readToolUseId(part: PortalChatPart): string | null {
  const data = isRecord(part.data) ? part.data : {};
  return (
    readString(data, 'toolUseId') ?? readString(data, 'tool_use_id') ?? null
  );
}

function readToolResultData(
  part: PortalChatPart,
): { output: string; isError: boolean } | null {
  const data = isRecord(part.data) ? part.data : {};
  const output =
    readString(data, 'output') ??
    readString(data, 'content') ??
    readString(data, 'text');
  if (output === undefined) {
    return null;
  }
  return {
    output,
    isError: data['isError'] === true || data['is_error'] === true,
  };
}

export function normalizeChatMessageParts(
  inputParts: readonly PortalChatPart[],
): PortalChatPart[] {
  // A merge can keep a result part beside the call it was already folded into.
  const folded = foldedPortalToolOccurrenceIds(inputParts);
  const parts = inputParts.filter((part) => {
    if (part.kind !== 'text' || !isRecord(part.data)) return true;
    return !(
      isRecord(part.data['composerRefusal']) && part.data['text'] === ''
    );
  });
  const pairs = pairToolResultOccurrences(parts, (part) => {
    if (
      (part.kind !== 'tool_use' && part.kind !== 'tool_result') ||
      isFoldedPortalToolResult(part, folded)
    ) {
      return undefined;
    }
    const data = isRecord(part.data) ? part.data : {};
    if (part.kind === 'tool_use' && data['result'] !== undefined) {
      return undefined;
    }
    if (part.kind === 'tool_result' && !readToolResultData(part)) {
      return undefined;
    }
    const toolUseId = readToolUseId(part);
    if (!toolUseId) {
      return undefined;
    }
    const occurrence = portalToolPartOccurrence(part);
    return {
      kind: part.kind,
      toolUseId,
      ...(occurrence ? { occurrenceId: occurrence.id } : {}),
    };
  });
  const consumedResultIndexes = new Set(pairs.values());

  return parts.flatMap((part, index) => {
    if (
      consumedResultIndexes.has(index) ||
      isFoldedPortalToolResult(part, folded)
    ) {
      // Folding consumes output, not the visual owned by the result row.
      // Drop the locator here too: the call now owns its full-output opener.
      const visual = readPortalChatPartVisual(part);
      if (!visual) return [];
      const toolUseId = readToolUseId(part);
      const data = isRecord(part.data) ? part.data : {};
      const messageId = readString(data, 'messageId');
      return [
        {
          kind: 'tool_result',
          data: {
            ...(toolUseId ? { toolUseId } : {}),
            ...(messageId ? { messageId } : {}),
            visual,
          },
        },
      ];
    }
    const resultIndex = pairs.get(index);
    if (resultIndex === undefined) {
      return [part];
    }
    const resultPart = parts[resultIndex];
    if (!resultPart || resultPart.kind !== 'tool_result') {
      return [part];
    }
    const result = readToolResultData(resultPart);
    if (!result) {
      return [part];
    }
    const data = isRecord(part.data) ? part.data : {};
    const resultOccurrence = portalToolPartOccurrence(resultPart);
    const outputLocator = readPortalToolOutputLocator(resultPart.outputLocator);
    return [
      {
        ...part,
        ...(resultOccurrence ? { occurrence: resultOccurrence } : {}),
        data: {
          ...data,
          result: {
            ...result,
            ...(outputLocator ? { outputLocator } : {}),
          },
        },
      },
    ];
  });
}

/**
 * Renders one neutral {@link PortalChatMessage}: user messages as a
 * {@link UserBubble}, assistant/system messages as left-aligned markdown prose
 * with their {@link ChatPartView} tool/thinking/agent blocks above the text —
 * mirroring the web portal `ChatMessageRenderer` (which the shared store's
 * neutral types come from) and the desktop transcript order.
 */
export interface ChatMessageViewProps {
  readonly receivingContext?: AgentSentReceivingContext;
  readonly message: PortalChatMessage;
  /** Optional branded app icon threaded to tool/agent parts. */
  readonly appIcon?: ReactNode;
  /** Always-visible control beside this message's completion stamp. */
  readonly turnTimerStampAccessory?: ReactNode;
  /** The host column adds the gap between turns; see `TurnTimer`. */
  readonly turnTimerHostTurnGap?: boolean;
  /** Turn actions after this message's elapsed label. */
  readonly turnTimerTrailing?: ReactNode;
  /** The finished reply's text, for the timer row's Copy button. */
  readonly turnTimerCopyText?: string;
  /** The turn's plan, whose Copy plan replaces the reply's Copy (CAN-5354). */
  readonly turnTimerPlanCopy?: PlanCopyState;
  /** Clean chat look: the running turn's live line, in the timer row's slot. */
  readonly turnTimerLiveLine?: ReactNode;
  /** Keeps this message's timer row visible at rest (the newest turn). */
  readonly turnTimerAlwaysVisible?: boolean;
  /**
   * How the owning turn ended, resolved once by its turn group so the timer
   * row agrees with the summary. A failed or cancelled row still wins.
   */
  readonly turnTimerCompletionStatus?: TurnTerminalStatus;
}

const Prose = memo(function Prose({
  text,
  stripAgentCitations = false,
  streaming = false,
  options,
}: {
  text: string;
  stripAgentCitations?: boolean;
  options?: MarkdownOptions;
  streaming?: boolean;
}): JSX.Element {
  const content = useMemo(
    () =>
      stripAgentCitations
        ? stripProposedPlanEnvelope(stripOpaqueAgentCitationMarkers(text))
        : text,
    [text, stripAgentCitations],
  );
  // Agent prose follows the host's transcript link policy when one is
  // provided (CAN-3172); explicit options (user bubbles) always win.
  const transcriptOptions = useTranscriptProseOptions();
  return (
    <Markdown options={options ?? transcriptOptions} streaming={streaming}>
      {content}
    </Markdown>
  );
});

const STREAMING_PROSE_GROUP_SIZE = 32;

const SettledProse = memo(function SettledProse({
  blocks,
  count,
}: {
  blocks: readonly string[];
  count: number;
}): JSX.Element {
  return (
    <>
      {count > 0 && <Prose text={blocks[0]} stripAgentCitations />}
      {Array.from(
        {
          length: Math.ceil(
            Math.max(0, count - 1) / STREAMING_PROSE_GROUP_SIZE,
          ),
        },
        (_, group) => (
          <div key={group}>
            {blocks
              .slice(
                1 + group * STREAMING_PROSE_GROUP_SIZE,
                Math.min(count, 1 + (group + 1) * STREAMING_PROSE_GROUP_SIZE),
              )
              .map((block, index) => (
                <Prose key={index} text={block} stripAgentCitations />
              ))}
          </div>
        ),
      )}
    </>
  );
});

interface StreamingProseCache {
  source: string;
  text: string;
  inCitation: boolean;
  start: number;
  lineStart: number;
  fence: string;
  blocks: readonly string[];
  documentContext: boolean;
  blockCanContinue: boolean;
}

const EMPTY_PROSE: StreamingProseCache = {
  source: '',
  text: '',
  inCitation: false,
  start: 0,
  lineStart: 0,
  fence: '',
  blocks: [],
  documentContext: false,
  blockCanContinue: false,
};

const DOCUMENT_REFERENCE_DEFINITION = /^ {0,3}\[(?:\\.|[^\]\\])+\]:/;

function appendStreamingProse(
  previous: StreamingProseCache,
  source: string,
): StreamingProseCache {
  const base =
    source.length <= previous.source.length ||
    !source.startsWith(previous.source)
      ? EMPTY_PROSE
      : previous;
  const state = { ...base, source };
  let appended = '';
  for (let i = base.source.length; i < source.length; i++) {
    const character = source[i];
    if (character === '\uE200') state.inCitation = true;
    else if (state.inCitation) {
      if (character === '\uE201') state.inCitation = false;
    } else appended += character;
  }
  const text = base.text + appended;
  let newBlocks: string[] | undefined;
  // Streaming frames append; a terminal replacement uses Prose over the whole answer.
  // Scan only new characters, keeping blank lines inside fenced code in the tail.
  for (let i = base.text.length; i < text.length; i++) {
    if (text[i] !== '\n') continue;
    const line = text.slice(state.lineStart, i).replace(/\r$/, '');
    if (/mermaid/i.test(line)) state.documentContext = true;
    if (!state.fence && DOCUMENT_REFERENCE_DEFINITION.test(line))
      state.documentContext = true;
    if (
      !state.fence &&
      /^(?:[ \t]|>|(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$))/.test(line)
    )
      state.blockCanContinue = true;
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (!state.fence) state.fence = fence;
      else if (
        fence[0] === state.fence[0] &&
        fence.length >= state.fence.length &&
        line.trim() === fence
      )
        state.fence = '';
    }
    if (!state.fence && /^\s*$/.test(line)) {
      if (state.blockCanContinue) state.documentContext = true;
      newBlocks ??= state.blocks.slice();
      newBlocks.push(text.slice(state.start, i + 1));
      state.start = i + 1;
    }
    state.lineStart = i + 1;
  }
  if (
    /mermaid/i.test(text.slice(state.lineStart)) ||
    (!state.fence &&
      DOCUMENT_REFERENCE_DEFINITION.test(text.slice(state.lineStart)))
  )
    state.documentContext = true;
  return { ...state, text, blocks: newBlocks ?? state.blocks };
}

const StreamingProse = memo(function StreamingProse({
  text,
}: {
  text: string;
}): JSX.Element {
  const clean = useCleanChatLook();
  const [cached, setCached] = useState(() =>
    appendStreamingProse(EMPTY_PROSE, text),
  );
  const state =
    cached.source === text ? cached : appendStreamingProse(cached, text);
  if (state !== cached) setCached(state);
  if (state.documentContext)
    return <Prose text={state.text} stripAgentCitations streaming />;
  const tail = state.text.slice(state.start);
  return (
    <>
      <SettledProse blocks={state.blocks} count={state.blocks.length} />
      {/* Clean chat look: the tail streams in the paragraph it settles
          into, with its margins, so finishing the reply moves nothing. */}
      {clean && tail !== '' ? (
        <p className="whitespace-pre-wrap">{tail}</p>
      ) : (
        <span className="whitespace-pre-wrap">{tail}</span>
      )}
    </>
  );
});

/**
 * Smooth streaming (Labs): the whole answer goes through `Markdown`, which
 * paces and fades it, in one element from the first delta to the finished
 * answer, so the end of the stream never re-mounts it and cuts the last words
 * short. While streaming it reuses the plain tail's citation scan, so a
 * citation split across deltas stays hidden.
 */
const SmoothStreamingProse = memo(function SmoothStreamingProse({
  text,
  streaming,
}: {
  text: string;
  streaming: boolean;
}): JSX.Element {
  const [cached, setCached] = useState(() =>
    appendStreamingProse(EMPTY_PROSE, text),
  );
  const state =
    !streaming || cached.source === text
      ? cached
      : appendStreamingProse(cached, text);
  if (state !== cached) setCached(state);
  return (
    <Prose
      text={streaming ? state.text : text}
      stripAgentCitations
      streaming={streaming}
    />
  );
});

const EMPTY_PARTS: readonly PortalChatPart[] = [];

/** A stable empty list, so a message without attachments resolves nothing. */
const NO_ATTACHMENTS: readonly PortalChatMessageAttachment[] = [];

function ChatMessageViewImpl({
  message,
  receivingContext: explicitContext,
  appIcon,
  turnTimerStampAccessory,
  turnTimerHostTurnGap,
  turnTimerTrailing,
  turnTimerCopyText,
  turnTimerPlanCopy,
  turnTimerAlwaysVisible,
  turnTimerLiveLine,
  turnTimerCompletionStatus,
}: ChatMessageViewProps): JSX.Element | null {
  const receivingContext = useAgentSentReceivingContext(explicitContext);
  const author = useChatMessageAuthor(message);
  // Clean chat look: prose and step rows sit 8px apart, as on desktop, where
  // they are separate transcript rows; step rows in a run stay together.
  const clean = useCleanChatLook();
  const smoothStreaming = useSmoothStreaming();
  const parts = message.parts ?? EMPTY_PARTS;
  const normalizedParts = useMemo(
    () => normalizeChatMessageParts(parts),
    [parts],
  );
  // A message with a trusted sender shows its marker; an outside agent
  // controls its text, so text-derived presentation never applies to it.
  const textPresentation = message.role === 'user' && !message.agentSent;
  const subagentReference = useMemo(
    () =>
      textPresentation
        ? splitSubagentReference(message.text)
        : { reference: null, body: message.text },
    [textPresentation, message.text],
  );
  // Only the host's marker names a fired watcher; text alone never does.
  const watcherFired = useMemo(
    () =>
      message.role === 'user'
        ? readChatWatcherFired({
            watcherFired: message.watcherFired,
            parts: message.parts,
          })
        : undefined,
    [message.role, message.watcherFired, message.parts],
  );
  const steeringRequest = useMemo(
    () =>
      message.role === 'user'
        ? hostMessagePresentation(
            message.text,
            message.agentSent,
            'block',
            watcherFired,
          )
        : undefined,
    [message.role, message.text, message.agentSent, watcherFired],
  );
  const userBody =
    message.role === 'user'
      ? (steeringRequest?.text ?? subagentReference.body)
      : '';
  // The message menu (CAN-4277) copies a selection inside the row.
  const { targetProps: contextMenuTarget, menu: contextMenu } =
    useChatMessageContextMenu({
      messageId: message.messageId,
      // Rows with no message text (tool-only, timers) get no Tab stop.
      focusable: (message.role === 'user' ? userBody : message.text) !== '',
    });
  const attachmentSplit = useChatMessageAttachmentSplit(
    message.role === 'user'
      ? (message.attachments ?? NO_ATTACHMENTS)
      : NO_ATTACHMENTS,
  );
  if (message.role === 'user') {
    const isSteering = hasSteeringChatPart(message.parts);
    const body = userBody;
    // Only trusted relay provenance marks a resume; `promptSource` alone
    // never does, and the prompt's text is never consulted.
    const autoResume =
      readChatPromptSource(message) === 'human'
        ? undefined
        : readMessageAutoResume(message);
    const autoResumeMarker = autoResume ? (
      <AutoResumeMarker
        autoResume={autoResume}
        providerName={autoResume.providerName}
        timestamp={message.createdAtMs}
        text={body}
        copyText={!autoResume.resendsUserMessage ? body : undefined}
      />
    ) : null;
    if (autoResume && !autoResume.resendsUserMessage) {
      return (
        <div
          {...contextMenuTarget}
          data-testid="chat-message"
          data-role="user"
          data-chat-message-id={message.messageId}
        >
          {autoResumeMarker}
          {contextMenu}
        </div>
      );
    }
    const existingHeader = steeringRequest?.title ? (
      steeringRequest.title
    ) : isSteering ? (
      <SteeringTitle />
    ) : author && !message.agentSent ? (
      <SharedChatAuthorHeader author={author} />
    ) : undefined;
    // Plain messages keep an undefined header so memoized bubbles can skip.
    // An agent-sent message has no text-derived presentation (see
    // `textPresentation`), so its title row carries the steering state itself.
    const header = message.agentSent ? (
      <AgentSentTitle
        agentSent={message.agentSent}
        receivingContext={receivingContext}
        steering={isSteering}
      />
    ) : autoResume ? undefined : (
      (existingHeader ??
      (readChatPromptSource(message) === 'automated' ? (
        <span>Sent automatically</span>
      ) : undefined))
    );
    return (
      <>
        {autoResumeMarker}
        {subagentReference.reference ? (
          <SubagentReferenceAttachment
            title={subagentReference.reference.title}
          />
        ) : null}
        <UserBubble
          copyText={body}
          dataTestId="chat-message"
          dataStatus={message.status}
          contextMenu={contextMenuTarget}
          variant={
            steeringRequest?.variant ?? (autoResume ? 'muted' : 'default')
          }
          {...(header ? { header } : {})}
          {...(attachmentSplit.media.length > 0
            ? {
                media: (
                  <ChatMessageMedia
                    key={message.chatId}
                    media={attachmentSplit.media}
                    onMediaFailed={attachmentSplit.onMediaFailed}
                    alone={body.trim() === ''}
                  />
                ),
              }
            : {})}
        >
          <div className={`${REPLAY_BLOCK_CLASS} ${PROSE_CLASSES}`}>
            <Prose text={body} options={USER_MARKDOWN_OPTIONS} />
          </div>
          {message.status === 'cancelled' && (
            <div className="mt-1 text-xs fg-secondary">
              <span>Cancelled</span>
            </div>
          )}
        </UserBubble>
        {contextMenu}
      </>
    );
  }

  const hasParts = normalizedParts.length > 0;
  const hasOnlyCompletedTimers =
    !message.text &&
    hasParts &&
    normalizedParts.every(
      (part) =>
        part.kind === 'turn_timer' &&
        isRecord(part.data) &&
        typeof part.data.completedAt === 'number',
    );
  const isStreaming = message.status === 'streaming';
  // Agent cards span the message column, as desktop's do; other rows keep the
  // column sized to their content.
  const hasAgentPart = normalizedParts.some((part) => part.kind === 'agent');

  // A streaming assistant row with nothing to show yet is an empty placeholder;
  // suppress it so the transcript does not flicker blank rows (desktop parity).
  if (isStreaming && !message.text && !hasParts) {
    return null;
  }

  return (
    <>
      <div
        // px-3 matches the user bubble's internal text inset
        // (`BUBBLE_SURFACE_CLASS`), so flat assistant/system prose shares the
        // bubble text's left and right edges — the desktop `ChatMessageItem`
        // wraps its flat content the same way.
        className="focus-ring flex min-w-0 max-w-full justify-start px-3"
        data-testid="chat-message"
        data-status={message.status}
        data-role={message.role}
        // Diagram names read headings from this message only.
        {...MARKDOWN_ROOT_PROPS}
        // The row has no existing message-level tab stop.
        {...contextMenuTarget}
      >
        {/* A visual or notice takes the message width, as on desktop's
            ChatMessageItem. Keep a space before the interpolation: Tailwind
            does not extract a class that touches `${`. */}
        <div
          className={`min-w-0 max-w-full flex flex-col gap-1 text-s fg-primary has-[[data-testid=chat-visual-block]]:w-full has-[[data-chat-notice]]:w-full has-[[data-step-row]]:w-full ${
            hasAgentPart ? 'w-full' : ''
          }`}
        >
          {hasParts && (
            // Clean steps sit 4px apart and 12px from text, as on desktop.
            <div
              data-testid="chat-message-parts"
              className={clean ? 'flex flex-col gap-1' : undefined}
            >
              {normalizedParts.map((part, i) => (
                // Stable occurrence keys survive same-message result folding.
                <Fragment
                  key={`${part.kind}-${portalToolPartOccurrence(part)?.id ?? i}`}
                >
                  {clean &&
                    i > 0 &&
                    (part.kind === 'text') !==
                      (normalizedParts[i - 1]?.kind === 'text') && (
                      <div aria-hidden="true" className="h-1" />
                    )}
                  <ChatPartView
                    part={part}
                    messageId={message.messageId}
                    appIcon={appIcon}
                    turnTimerStampAccessory={turnTimerStampAccessory}
                    turnTimerHostTurnGap={turnTimerHostTurnGap}
                    turnTimerTrailing={turnTimerTrailing}
                    turnTimerLiveLine={turnTimerLiveLine}
                    {...(turnTimerCopyText !== undefined
                      ? { turnTimerCopyText }
                      : {})}
                    {...(turnTimerPlanCopy !== undefined
                      ? { turnTimerPlanCopy }
                      : {})}
                    {...(turnTimerAlwaysVisible === true
                      ? { turnTimerAlwaysVisible }
                      : {})}
                    live={isStreaming}
                    settled={i < normalizedParts.length - 1}
                    terminalStatus={
                      message.status === 'failed' ||
                      message.status === 'cancelled'
                        ? message.status
                        : turnTimerCompletionStatus
                    }
                  />
                </Fragment>
              ))}
            </div>
          )}
          {message.text &&
            // A structured AI Credits proxy failure must never render as raw
            // JSON — the marker is a wire signal, not user-visible copy. This is
            // the LIVE Remote Control worktree chat (`PortalSharedChatPanel` ->
            // `ChatPanel` -> `ChatTranscript` -> here), which is exactly where
            // Codex AI Credits turns land, so it needs the same guard the
            // shared-run renderer has.
            //
            // Narrowed to system/failed messages, matching the desktop's
            // `isSystemMessage` gate: an assistant answer that merely QUOTES the
            // marker (entirely plausible when the agent is explaining this
            // subsystem) must not have its whole response replaced by an error
            // notice.
            ((): JSX.Element => {
              if (
                message.role === 'system' &&
                isAccountProxySettingsFailure(message.text)
              ) {
                return (
                  <AccountProxyFailureNotice
                    message={message.text.replace(/^Error:\s*/, '')}
                  />
                );
              }
              const proxyError =
                message.role === 'system' || message.status === 'failed'
                  ? parseCanopyProxyError(message.text)
                  : null;
              if (proxyError) {
                return (
                  // Portal-scoped id on purpose. `chat-canopy-proxy-error` is the
                  // DESKTOP notice's id, and two Electron specs already select
                  // it; reusing it here would become a Playwright strict-mode
                  // collision the moment desktop renders this neutral transcript.
                  <CanopyProxyErrorSummary
                    error={proxyError}
                    dataTestId="portal-chat-canopy-proxy-error"
                  />
                );
              }
              return (
                <div
                  data-testid="chat-message-content"
                  className={`${REPLAY_BLOCK_CLASS} ${PROSE_CLASSES}`}
                >
                  {smoothStreaming ? (
                    <SmoothStreamingProse
                      text={message.text}
                      streaming={isStreaming}
                    />
                  ) : isStreaming ? (
                    <StreamingProse text={message.text} />
                  ) : (
                    <Prose text={message.text} stripAgentCitations />
                  )}
                </div>
              );
            })()}
          {message.status === 'failed' && !hasOnlyCompletedTimers && (
            <div className="flex items-center gap-1.5 py-1 text-xs fg-destructive">
              <FailedIcon />
              <span>Failed</span>
            </div>
          )}
          {message.status === 'cancelled' && !hasOnlyCompletedTimers && (
            <div className="flex items-center gap-1.5 py-1 text-xs fg-secondary">
              <span>Cancelled</span>
            </div>
          )}
        </div>
      </div>
      {contextMenu}
    </>
  );
}

/** Memoized so unchanged messages skip re-render during streaming (CLAUDE.md). */
export const ChatMessageView = memo(ChatMessageViewImpl);
