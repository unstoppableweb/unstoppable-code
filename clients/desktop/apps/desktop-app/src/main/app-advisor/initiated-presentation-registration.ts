import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../canopy-runtime/desktop-runtime-identity';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  startInitiatedPresentation,
  type InitiatedPresentation,
  type InitiatedPresentationStream,
} from './initiated-presentation';
import type { AppAdvisorToolRuntimeSurfaces } from './runtime';

/**
 * The reaction's own caller: the legacy chat push's descriptor
 * (`ipc/chat-state.ts`) under its own client instance, reading chat events
 * and nothing else.
 */
export const INITIATED_PRESENTATION_CALLER: Readonly<CanopyCallerDescriptor> =
  Object.freeze<CanopyCallerDescriptor>({
    principalId: 'local-desktop-user',
    clientInstanceId: 'electron-main-initiated-presentation',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.chat.read'],
  });

/** Reopens in a row, with no item between them, before it gives up. */
export const INITIATED_PRESENTATION_MAX_REOPENS = 3;

let latestReady: Promise<void> = Promise.resolve();

/**
 * The latest registration's `ready`: the automations service starts after
 * it, so a run at startup can't be accepted before the reaction listens.
 */
export function whenInitiatedPresentationReady(): Promise<void> {
  return latestReady;
}

export interface InitiatedPresentationRegistration {
  /** Settles once the first subscription attached, or failed and was logged. */
  ready: Promise<void>;
  stop(): void;
}

/**
 * CAN-4174: subscribes the Orchestrator window reaction to the dispatcher's
 * own `core.chat.events` for the life of the IPC handlers. A stream that ends
 * other than by cancellation is reopened with a fresh attach time, so history
 * is never replayed; after {@link INITIATED_PRESENTATION_MAX_REOPENS} reopens
 * with no item between them it logs once and stays down. Its only effect is
 * the reaction's: opening or focusing the Orchestrator window.
 */
export function registerInitiatedPresentation(options: {
  dispatcher: Pick<DesktopCanopyDispatcher, 'openStream'>;
  surfaces: Pick<AppAdvisorToolRuntimeSurfaces, 'ensureAppAdvisorWindow'>;
  now?: () => Date;
}): InitiatedPresentationRegistration {
  let stopped = false;
  let current: InitiatedPresentation | undefined;
  let reopensWithoutItem = 0;
  let settleReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    settleReady = resolve;
  });
  latestReady = ready;

  const ended = (): void => {
    current?.stop();
    current = undefined;
    if (stopped) return;
    if (reopensWithoutItem >= INITIATED_PRESENTATION_MAX_REOPENS) {
      logMainProcessWarn(
        'The Orchestrator presentation stream stopped reopening',
        { reopens: reopensWithoutItem },
      );
      return;
    }
    reopensWithoutItem += 1;
    void attach();
  };

  const openChatEvents = async (
    params: Parameters<
      Parameters<typeof startInitiatedPresentation>[0]['openChatEvents']
    >[0],
  ): Promise<InitiatedPresentationStream> => {
    const handle = await options.dispatcher.openStream(
      'core.chat.events',
      params,
      { caller: INITIATED_PRESENTATION_CALLER },
    );
    return {
      onFrame: (listener) =>
        handle.onFrame((frame) => {
          if (frame.kind === 'item') reopensWithoutItem = 0;
          listener(frame);
          if (frame.kind === 'end' && frame.outcome !== 'cancelled')
            queueMicrotask(ended);
        }),
      close: () => handle.close(),
    };
  };

  const attach = async (): Promise<void> => {
    try {
      const presentation = await startInitiatedPresentation({
        openChatEvents,
        surfaces: options.surfaces,
        ...(options.now ? { now: options.now } : {}),
      });
      if (stopped) presentation.stop();
      else current = presentation;
    } catch (error: unknown) {
      logMainProcessWarn('The Orchestrator presentation stream did not open', {
        error,
      });
      if (!stopped) queueMicrotask(ended);
    } finally {
      settleReady();
    }
  };

  void attach();
  return {
    ready,
    stop(): void {
      if (stopped) return;
      stopped = true;
      current?.stop();
      current = undefined;
    },
  };
}
