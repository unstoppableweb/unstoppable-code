// ---------------------------------------------------------------------------
// A cloud delegate's child pages over the web core (CAN-6303).
//
// The shared `DelegationChildPages` reads a delegate's rows through
// `CanopyClient.transcripts`; a cloud delegate is a chat of its own, which
// `core.chat.transcript.page` serves for its parent's owner by a delegation
// target. Field bodies and block pages are not read here: a cut row keeps
// its preview, as the capabilities (`delegationBlockReads` off) say. Each
// host passes the invoker that reaches its web core.
// ---------------------------------------------------------------------------

import type {
  DelegationPage,
  TranscriptReadClient,
  TranscriptReadResult,
  TranscriptReadSource,
} from '@canopy/app-core';
import { parseCoreChatChildPage } from '@canopy/protocol/canopy-core';
import type { CoreCoworkInvoker } from './invoker';

/** A source chat on the web core: its project, task and own id. */
export interface WebCoreTranscriptScope {
  readonly workspaceId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

const UNAVAILABLE = { ok: false, kind: 'unavailable' } as const;

function aborted(signal: AbortSignal): Promise<{ readonly aborted: true }> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve({ aborted: true });
    signal.addEventListener('abort', () => resolve({ aborted: true }), {
      once: true,
    });
  });
}

/**
 * The transcript reads of cloud chats. `scopeFor` maps the reader's local
 * source to the chat's web core ids; null (a chat the web core doesn't
 * serve) and a missing invoker read as unavailable.
 */
export function createWebCoreTranscriptReadClient(deps: {
  readonly invoker: () => CoreCoworkInvoker | null;
  readonly scopeFor: (
    source: TranscriptReadSource,
  ) => WebCoreTranscriptScope | null;
}): TranscriptReadClient {
  return {
    delegationPage: async (
      request,
      signal,
    ): Promise<TranscriptReadResult<DelegationPage>> => {
      const invoker = deps.invoker();
      const scope = deps.scopeFor(request);
      if (
        invoker === null ||
        scope === null ||
        request.archivedContainerId !== undefined ||
        request.standaloneHistory !== undefined
      )
        return UNAVAILABLE;
      const reply = await Promise.race([
        invoker
          .request('core.chat.transcript.page', {
            scope,
            target: {
              kind: 'delegation',
              chatId: scope.chatId,
              delegationId: request.target.delegationId,
              runGeneration: request.target.runGeneration,
            },
            ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
          })
          .catch(() => null),
        aborted(signal),
      ]);
      if (reply === null) return { ok: false, kind: 'failed' };
      if ('aborted' in reply) return { ok: false, kind: 'cancelled' };
      if (!reply.ok)
        return {
          ok: false,
          kind:
            reply.error.kind === 'capability_unavailable' ||
            reply.error.kind === 'not_found'
              ? 'unavailable'
              : 'failed',
        };
      const page = parseCoreChatChildPage(reply.value);
      return page === undefined
        ? { ok: false, kind: 'failed' }
        : { ok: true, value: page };
    },
    content: () => Promise.resolve(UNAVAILABLE),
    blocks: () => Promise.resolve(UNAVAILABLE),
  };
}
