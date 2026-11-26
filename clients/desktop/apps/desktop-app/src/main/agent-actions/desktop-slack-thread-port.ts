import { nativeImage } from 'electron';
import type { AgentActionResponse, AgentJson } from '@canopy/agent-actions';
import {
  dispatchSlackThreadAction,
  type SlackThreadPort,
} from '@canopy/agent-actions/families/slack-thread/dispatch';
import type { SlackThreadAction } from '@canopy/agent-actions/families/slack-thread/actions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import {
  SLACK_THREAD_FILE_OPENS_PER_REQUEST,
  SLACK_THREAD_UNTRUSTED_NOTICE,
  type SlackThreadFile,
  type SlackThreadFileResponse,
  type SlackThreadMessage,
  type SlackThreadReadResponse,
} from '@canopy/protocol/slack-thread-context';
import {
  createSlackThreadContextClient,
  type SlackThreadContextClient,
  type SlackThreadContextFailure,
} from '../canopy-cloud/slack-thread-context-client';
import { getFeatureFlagService } from '../feature-flags';
import { logMainProcessInfo } from '../lib/main-process-logging';
import { isSlackConversationsChat } from '../remote-control/host/hosted-orchestrator-desktop';
import {
  fitSlackImage,
  type FitImageDecoder,
  type FitImageOutcome,
} from './slack-thread-image-fit';

/** The image budget when the provider adapter sets none (Claude). */
export const SLACK_THREAD_DEFAULT_IMAGE_BUDGET_BYTES = 1024 * 1024;
/** Request keys the file-open counter remembers before dropping the oldest. */
const COUNTER_MAX_KEYS = 200;

/**
 * Every model-visible sentence this port returns (CAN-7749). Defined once
 * here; none ever holds thread content.
 */
export const SLACK_THREAD_PORT_TEXTS = Object.freeze({
  notSlackTab:
    "The Slack thread can only be read from the Slack request's own tab.",
  signedOut:
    "The Slack thread can't be read because this computer isn't connected to its account.",
  notAvailable: "The Slack thread isn't available to read for this request.",
  rateLimited: (seconds: number): string =>
    `The thread can't be read for another ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
  pageLimit: 'No more pages of this thread can be read for this request.',
  fileOpenLimit: `No more files can be opened for this request; the limit is ${SLACK_THREAD_FILE_OPENS_PER_REQUEST}.`,
  expired: 'That cursor or file handle has expired.',
  invalidRequest:
    "That cursor or file handle isn't valid. Use one from the latest slack_thread.read.",
  missingScope:
    "Files can't be opened until the Slack app is reinstalled to this workspace.",
  fileUnavailable: 'That file is no longer available in Slack.',
  fileUnsupported:
    "That file type can't be opened. Only images and text files open.",
  fileTooLarge: 'That file is too large to open.',
  imageNotFitted:
    "That image couldn't be made small enough for this tool result.",
  imageNotShown: "This model can't view images, so the image wasn't opened.",
  unavailable: "Slack couldn't be reached right now.",
  invalidResponse: 'The thread read returned an answer that could not be used.',
  timeout: 'The thread read timed out or was cancelled.',
  requestMissing:
    "The request message wasn't found in the thread, so no messages were returned.",
  startOnly:
    "Only the start of a long thread was read; later messages, including the request and its files, weren't read.",
  filesOmitted:
    "Some messages have files that aren't listed until the Slack app is reinstalled to this workspace.",
});

export interface DesktopSlackThreadDeps {
  flagEnabled(): boolean;
  isSlackChat(worktreeId: string, chatId: string): Promise<boolean>;
  readonly client: SlackThreadContextClient;
  readonly decodeImage: FitImageDecoder;
  /** Logs one outcome code; never content, handles or cursors. */
  logOutcome(action: SlackThreadAction['type'], outcome: string): void;
}

export interface DesktopSlackThreadCall {
  readonly requestId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  /** The provider adapter's image budget; 1 MB when it sets none. */
  readonly imageBudgetBytes?: number;
  readonly signal?: AbortSignal;
}

type Failure = {
  readonly code: string;
  readonly message: string;
  readonly retryable?: true;
  /** The outcome code logged for this failure. */
  readonly outcome: string;
};

function failureFor(failure: SlackThreadContextFailure): Failure {
  const texts = SLACK_THREAD_PORT_TEXTS;
  switch (failure.kind) {
    case 'signed_out':
      return {
        code: 'surface_unavailable',
        message: texts.signedOut,
        outcome: 'signed_out',
      };
    case 'route_missing':
      return {
        code: 'surface_unavailable',
        message: texts.notAvailable,
        outcome: 'route_missing',
      };
    case 'timeout':
      return {
        code: 'timeout',
        message: texts.timeout,
        retryable: true,
        outcome: 'timeout',
      };
    case 'network':
      return {
        code: 'execution_failed',
        message: texts.unavailable,
        retryable: true,
        outcome: 'network',
      };
    case 'invalid_response':
      return {
        code: 'execution_failed',
        message: texts.invalidResponse,
        outcome: 'invalid_response',
      };
    case 'refused':
      break;
  }
  const outcome = failure.code;
  switch (failure.code) {
    case 'unauthorized':
    case 'not_available':
      return {
        code: 'surface_unavailable',
        message: texts.notAvailable,
        outcome,
      };
    case 'rate_limited':
      return {
        code: 'quota_exceeded',
        message: texts.rateLimited(
          Math.max(1, Math.ceil((failure.retryAfterMs ?? 60_000) / 1000)),
        ),
        retryable: true,
        outcome,
      };
    case 'page_limit':
      return { code: 'quota_exceeded', message: texts.pageLimit, outcome };
    case 'expired':
      return { code: 'cursor_expired', message: texts.expired, outcome };
    case 'invalid_request':
      return {
        code: 'invalid_payload',
        message: texts.invalidRequest,
        outcome,
      };
    case 'missing_scope':
      return {
        code: 'missing_capability',
        message: texts.missingScope,
        outcome,
      };
    case 'file_unavailable':
      return { code: 'not_found', message: texts.fileUnavailable, outcome };
    case 'file_unsupported':
      return {
        code: 'validation_failed',
        message: texts.fileUnsupported,
        outcome,
      };
    case 'file_too_large':
      return {
        code: 'validation_failed',
        message: texts.fileTooLarge,
        outcome,
      };
    case 'unavailable':
      return {
        code: 'execution_failed',
        message: texts.unavailable,
        retryable: true,
        outcome,
      };
  }
}

function fileJson(file: SlackThreadFile): AgentJson {
  return {
    handle: file.handle,
    name: file.name,
    type: file.type,
    sizeBytes: file.sizeBytes,
    kind: file.kind,
  };
}

function messageJson(message: SlackThreadMessage): AgentJson {
  return {
    ts: message.ts,
    author: message.author,
    role: message.role,
    isRequest: message.isRequest,
    text: message.text,
    files: message.files.map(fileJson),
    ...(message.filesOmitted ? { filesOmitted: true } : {}),
  };
}

function readResultJson(read: SlackThreadReadResponse): AgentJson {
  const notes: string[] = [];
  if (read.requestMissing) notes.push(SLACK_THREAD_PORT_TEXTS.requestMissing);
  if (read.order === 'oldest_first' && !read.requestIncluded && read.hasMore)
    notes.push(SLACK_THREAD_PORT_TEXTS.startOnly);
  if (read.messages.some((message) => message.filesOmitted === true))
    notes.push(SLACK_THREAD_PORT_TEXTS.filesOmitted);
  return {
    notice: read.notice,
    order: read.order,
    page: read.page,
    hasMore: read.hasMore,
    ...(read.nextCursor !== undefined ? { nextCursor: read.nextCursor } : {}),
    ...(read.replyCount !== undefined ? { replyCount: read.replyCount } : {}),
    requestIncluded: read.requestIncluded,
    requestMissing: read.requestMissing,
    names: read.names,
    omittedMessages: read.omittedMessages,
    ...(notes.length > 0 ? { notes } : {}),
    messages: read.messages.map(messageJson),
  };
}

/**
 * File opens per request message, counted in memory. A slot is reserved
 * before the call, so parallel opens can't pass the cap, and released when
 * the call returns no file content. Bounded, and reset on restart; the
 * hosted checks and Slack's own limits remain.
 */
class FileOpenCounter {
  private readonly counts = new Map<string, number>();
  private readonly lastRequestKey = new Map<string, string>();

  noteRead(chatId: string, requestKey: string): void {
    this.lastRequestKey.delete(chatId);
    this.lastRequestKey.set(chatId, requestKey);
    this.trim(this.lastRequestKey);
  }

  /** The key for an open in this chat: its latest read's request, else the chat. */
  keyFor(chatId: string): string {
    const requestKey = this.lastRequestKey.get(chatId);
    return JSON.stringify([chatId, requestKey ?? null]);
  }

  reserve(key: string): boolean {
    const count = this.counts.get(key) ?? 0;
    if (count >= SLACK_THREAD_FILE_OPENS_PER_REQUEST) return false;
    this.counts.delete(key);
    this.counts.set(key, count + 1);
    this.trim(this.counts);
    return true;
  }

  release(key: string): void {
    const count = this.counts.get(key);
    if (count === undefined) return;
    if (count <= 1) this.counts.delete(key);
    else this.counts.set(key, count - 1);
  }

  private trim<V>(map: Map<string, V>): void {
    while (map.size > COUNTER_MAX_KEYS) {
      const oldest = map.keys().next();
      if (oldest.done === true) return;
      map.delete(oldest.value);
    }
  }
}

function fileResultJson(
  file: SlackThreadFileResponse,
  fitted: FitImageOutcome | null,
): AgentJson {
  if (file.kind === 'text')
    return {
      notice: SLACK_THREAD_UNTRUSTED_NOTICE,
      kind: 'text',
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      ...(file.cut ? { cut: true } : {}),
      text: file.text,
    };
  const image = fitted?.ok === true ? fitted.image : null;
  return {
    notice: SLACK_THREAD_UNTRUSTED_NOTICE,
    kind: 'image',
    name: file.name,
    original: {
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      ...(file.width !== undefined ? { width: file.width } : {}),
      ...(file.height !== undefined ? { height: file.height } : {}),
    },
    ...(image
      ? {
          delivered: {
            mimeType: image.mimeType,
            sizeBytes: image.bytes,
            ...(image.width !== undefined ? { width: image.width } : {}),
            ...(image.height !== undefined ? { height: image.height } : {}),
          },
        }
      : {}),
  };
}

/**
 * The Orchestrator's Slack thread port (CAN-7749). It refuses before any
 * network call unless the desktop Slack flag is on and the calling chat is
 * a Slack tab (fail closed), then calls the hosted routes with the
 * signed-in account's key. The tab always comes from the turn, never the
 * model.
 */
export function createDesktopSlackThread(deps: DesktopSlackThreadDeps): {
  dispatch(
    action: SlackThreadAction,
    call: DesktopSlackThreadCall,
  ): Promise<AgentActionResponse<string>>;
} {
  const counter = new FileOpenCounter();

  const fail = (
    type: SlackThreadAction['type'],
    requestId: string,
    failure: Failure,
  ): AgentActionResponse<string> => {
    deps.logOutcome(type, failure.outcome);
    return {
      requestId,
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.retryable ? { retryable: true } : {}),
      },
    };
  };

  const gate = async (call: DesktopSlackThreadCall): Promise<boolean> => {
    try {
      if (!deps.flagEnabled()) return false;
      return await deps.isSlackChat(call.worktreeId, call.chatId);
    } catch {
      return false;
    }
  };

  const notSlackTab: Failure = {
    code: 'surface_unavailable',
    message: SLACK_THREAD_PORT_TEXTS.notSlackTab,
    outcome: 'not_slack_tab',
  };

  const port: SlackThreadPort<DesktopSlackThreadCall> = {
    async read(input, { host: call }) {
      if (!(await gate(call)))
        return fail('slack_thread.read', call.requestId, notSlackTab);
      const outcome = await deps.client.read(
        {
          chatId: call.chatId,
          ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
        },
        call.signal,
      );
      if (!outcome.ok)
        return fail(
          'slack_thread.read',
          call.requestId,
          failureFor(outcome.failure),
        );
      counter.noteRead(call.chatId, outcome.value.requestKey);
      deps.logOutcome('slack_thread.read', 'ok');
      return {
        requestId: call.requestId,
        ok: true,
        result: readResultJson(outcome.value),
      };
    },

    async openFile(input, { host: call }) {
      if (!(await gate(call)))
        return fail('slack_thread.open_file', call.requestId, notSlackTab);
      const key = counter.keyFor(call.chatId);
      if (!counter.reserve(key))
        return fail('slack_thread.open_file', call.requestId, {
          code: 'quota_exceeded',
          message: SLACK_THREAD_PORT_TEXTS.fileOpenLimit,
          outcome: 'file_open_limit',
        });
      const outcome = await deps.client.openFile(
        { chatId: call.chatId, handle: input.handle },
        call.signal,
      );
      if (!outcome.ok) {
        counter.release(key);
        return fail(
          'slack_thread.open_file',
          call.requestId,
          failureFor(outcome.failure),
        );
      }
      const file = outcome.value;
      if (file.kind === 'text') {
        deps.logOutcome('slack_thread.open_file', 'ok_text');
        return {
          requestId: call.requestId,
          ok: true,
          result: fileResultJson(file, null),
        };
      }
      // A budget of 0 is a provider that takes no image (Cursor, OpenCode
      // without image support), as for preview_visual.
      if (call.imageBudgetBytes === 0) {
        counter.release(key);
        return fail('slack_thread.open_file', call.requestId, {
          code: 'validation_failed',
          message: SLACK_THREAD_PORT_TEXTS.imageNotShown,
          outcome: 'image_not_shown',
        });
      }
      const fitted = fitSlackImage(
        Buffer.from(file.dataBase64, 'base64'),
        file.mimeType,
        call.imageBudgetBytes ?? SLACK_THREAD_DEFAULT_IMAGE_BUDGET_BYTES,
        deps.decodeImage,
      );
      if (!fitted.ok) {
        counter.release(key);
        return fail('slack_thread.open_file', call.requestId, {
          code: 'validation_failed',
          message: SLACK_THREAD_PORT_TEXTS.imageNotFitted,
          outcome: `image_${fitted.reason}`,
        });
      }
      deps.logOutcome('slack_thread.open_file', 'ok_image');
      return {
        requestId: call.requestId,
        ok: true,
        result: fileResultJson(file, fitted),
        // Travels only as the image item, never in the result text.
        toolImageDataUrl: fitted.image.dataUrl,
      };
    },
  };

  return {
    dispatch: (action, call) =>
      dispatchSlackThreadAction(action, port, {
        host: call,
        ...(call.signal ? { signal: call.signal } : {}),
      }),
  };
}

let defaultSlackThread: ReturnType<typeof createDesktopSlackThread> | null =
  null;

function getDefaultSlackThread(): ReturnType<typeof createDesktopSlackThread> {
  defaultSlackThread ??= createDesktopSlackThread({
    flagEnabled: () =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyDesktopSlackOrchestratorRequests.key,
      ),
    isSlackChat: isSlackConversationsChat,
    client: createSlackThreadContextClient(),
    decodeImage: (bytes) => nativeImage.createFromBuffer(bytes),
    logOutcome: (action, outcome) =>
      logMainProcessInfo('Slack thread action', { action, outcome }),
  });
  return defaultSlackThread;
}

/** The Orchestrator's `slack_thread.*` actions, through the default port. */
export function dispatchDesktopSlackThread(
  action: SlackThreadAction,
  call: DesktopSlackThreadCall,
): Promise<AgentActionResponse<string>> {
  return getDefaultSlackThread().dispatch(action, call);
}
