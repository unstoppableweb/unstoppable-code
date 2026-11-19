import {
  CORE_CHAT_EVENTS_INITIATED_REVISION,
  CoreChatInitiatedChangeSchema,
  chatInitiatedIsLive,
  type CoreChatInitiatedChange,
} from '@canopy/protocol/canopy-core/core';
import { isBotProjectId } from '@canopy/protocol/chat-targets';
import { logMainProcessWarn } from '../lib/main-process-logging';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

/** The frames of a `core.chat.events` subscription, pushed in process. */
export interface InitiatedPresentationStream {
  onFrame(
    listener: (
      frame:
        | { kind: 'item'; item: unknown }
        | { kind: 'end'; outcome: string; error: unknown },
    ) => void,
  ): () => void;
  close(): void;
}

export interface InitiatedPresentationOptions {
  /** Opens the dispatcher's own `core.chat.events` at revision 4. */
  openChatEvents: (params: {
    scope: 'all';
    cursor: null;
    revision: typeof CORE_CHAT_EVENTS_INITIATED_REVISION;
  }) => Promise<InitiatedPresentationStream>;
  surfaces: Pick<AppAdvisorToolRuntimeSurfaces, 'ensureAppAdvisorWindow'>;
  /** Injected in tests; the attach time a live change is measured against. */
  now?: () => Date;
}

export interface InitiatedPresentation {
  stop(): void;
}

const KNOWN_PRESENTATIONS: ReadonlySet<unknown> = new Set([
  'focus',
  'open',
  'none',
]);

// The contract's rule for a presentation value this build doesn't know: read
// it as the least invasive one, open, which selects no chat.
function initiatedChange(change: unknown): CoreChatInitiatedChange | null {
  const parsed = CoreChatInitiatedChangeSchema.safeParse(change);
  if (parsed.success) return parsed.data;
  if (typeof change !== 'object' || change === null) return null;
  const presentation: unknown = Reflect.get(change, 'presentation');
  if (
    Reflect.get(change, 'type') !== 'chat.initiated' ||
    typeof presentation !== 'string' ||
    KNOWN_PRESENTATIONS.has(presentation)
  )
    return null;
  const asOpen = CoreChatInitiatedChangeSchema.safeParse({
    ...change,
    presentation: 'open',
  });
  return asOpen.success ? asOpen.data : null;
}

function initiatedChanges(item: unknown): {
  projectId: string;
  changes: CoreChatInitiatedChange[];
} | null {
  if (typeof item !== 'object' || item === null) return null;
  const projectId: unknown = Reflect.get(item, 'projectId');
  const changes: unknown = Reflect.get(item, 'changes');
  if (typeof projectId !== 'string' || !Array.isArray(changes)) return null;
  const initiated: CoreChatInitiatedChange[] = [];
  for (const change of changes) {
    const parsed = initiatedChange(change);
    if (parsed) initiated.push(parsed);
  }
  return initiated.length > 0 ? { projectId, changes: initiated } : null;
}

/**
 * CAN-4174: the desktop's reaction to `chat.initiated`, a host presentation
 * adapter, not core. An automation's own send to an Orchestrator chat that is
 * accepted after this subscribed opens the Orchestrator window: `focus`
 * selects the chat, `open` opens the window without selecting it, and `none`
 * leaves it alone, as the automation's direct calls do on develop. A value
 * this build doesn't know is read as `open`. Project
 * chats and history accepted before it subscribed do nothing. It runs on a
 * later microtask; a failure is logged and never reaches the send or the run.
 *
 * Registered by `registerInitiatedPresentation`, which opens its stream.
 */
export async function startInitiatedPresentation(
  options: InitiatedPresentationOptions,
): Promise<InitiatedPresentation> {
  const attachedAt = (options.now?.() ?? new Date()).toISOString();
  const stream = await options.openChatEvents({
    scope: 'all',
    cursor: null,
    revision: CORE_CHAT_EVENTS_INITIATED_REVISION,
  });
  let stopped = false;
  const present = (change: CoreChatInitiatedChange): void => {
    if (change.presentation === 'none') return;
    const request =
      change.presentation === 'focus' ? { chatId: change.chatId } : undefined;
    void Promise.resolve()
      .then(() => options.surfaces.ensureAppAdvisorWindow(request))
      .catch((error: unknown) => {
        logMainProcessWarn(
          'Opening the Orchestrator window for an automation failed',
          { presentation: change.presentation, chatId: change.chatId, error },
        );
      });
  };
  const unsubscribe = stream.onFrame((frame) => {
    if (stopped) return;
    if (frame.kind === 'end') {
      if (frame.outcome !== 'cancelled')
        logMainProcessWarn('The Orchestrator presentation stream ended', {
          outcome: frame.outcome,
          error: frame.error,
        });
      return;
    }
    const batch = initiatedChanges(frame.item);
    if (!batch || !isBotProjectId(batch.projectId)) return;
    for (const change of batch.changes)
      if (chatInitiatedIsLive(change, attachedAt)) present(change);
  });
  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      stream.close();
    },
  };
}
