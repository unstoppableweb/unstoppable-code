'use client';

import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { TerminalShellProfileId } from '@canopy/protocol/terminal';
import { Button, ErrorBanner } from '@canopy/ui-shared/components';
import {
  ensureTerminalWorktreeHydrated,
  selectBucket,
  useTerminalStore,
} from '@canopy/app-state/terminal';
import { useTerminalActivityStore } from '@canopy/app-state/terminal';
import { disposeInstance, peekInstance } from './terminal-instances';
import { proposeUsableTerminalSize } from './terminal-resize-guard';
import {
  getTerminalReadOnlyMessage,
  isTerminalRestartableSession,
  isTerminalRestorableSession,
} from '@canopy/app-state/terminal';
import { makeWorktreePanelKey } from '../panels/panel-layout-store';
import {
  consumePendingTerminalSpawn,
  subscribeTerminalSpawnRequests,
  terminalSpawnRequestTargets,
} from './terminal-spawn-requests';
import { usePanelPlacement } from '../panels/panel-contexts';
import { requestTerminalFocus } from './terminal-focus-intent';
import { terminalShellUnavailableMessage } from './terminal-shell-unavailable';
import {
  ensureTerminalExitSubscription,
  registerTerminalClientLifecycle,
  requireTerminalClientLifetime,
  type TerminalClientLifetime,
} from '@canopy/app-state/terminal';
import { TerminalPane, type TerminalPaneProps } from './TerminalPane';
import type { TerminalPanelHost } from './terminal-panel-host';

interface TerminalSize {
  cols: number;
  rows: number;
}
const DEFAULT_SIZE: TerminalSize = { cols: 80, rows: 24 };

const isWholePositive = (value: number | undefined): value is number =>
  value !== undefined && Number.isInteger(value) && value > 0;

/**
 * The size a restarted shell starts at, read while the terminal's xterm is
 * still cached: what its attached pane fits to now, else the size a usable fit
 * last gave the xterm, else 80x24.
 */
function restartSize(terminalId: string): TerminalSize {
  const entry = peekInstance(terminalId);
  if (!entry) return DEFAULT_SIZE;
  const fitted = proposeUsableTerminalSize(
    entry.fit,
    entry.container.parentElement,
  );
  if (fitted) return fitted;
  // Read defensively: the fallback must not assume a live xterm.
  const last: Partial<TerminalSize> | undefined = entry.term;
  const cols = last?.cols;
  const rows = last?.rows;
  return isWholePositive(cols) && isWholePositive(rows)
    ? { cols, rows }
    : DEFAULT_SIZE;
}

/**
 * Who began a start or restart. The host's registered actions reject to the
 * host. The surface's own buttons and queued gestures have no awaiting caller,
 * so their failures are shown or reported instead.
 */
type RecoveryOrigin = 'surface' | 'host';

/**
 * The origin of an attempt in flight. A host start that joins a surface-begun
 * attempt takes it over, so its failure reaches the host once, through the
 * rejection, rather than also through `onRecoveryError`.
 */
interface RecoveryAttemptOrigin {
  current: RecoveryOrigin;
}

function clientChangedError(): Error {
  return new Error('The terminal client changed before the terminal was ready');
}

export interface TerminalPanelSurfaceProps {
  host: TerminalPanelHost;
  appName: string;
  onSendToChat?: TerminalPaneProps['onSendToChat'];
  getPathsForFiles?: TerminalPaneProps['getPathsForFiles'];
  suppressNativeContextMenu?: TerminalPaneProps['suppressNativeContextMenu'];
  onOpenLink?: TerminalPaneProps['onOpenLink'];
  projectId: string;
  worktreeId: string;
  panelId: string;
  terminalId?: string;
  /** Only the active terminal panel consumes worktree shortcut requests. */
  active?: boolean;
}

/**
 * One workspace terminal panel = one terminal session. Session switching,
 * splits, profile selection, and add controls belong to the outer workspace
 * panel system, so this surface renders only terminal content (or the single
 * Start terminal empty-state action).
 *
 * Mount may hydrate worktree state, attach history, list sessions, and restore a
 * shutdown session when the host permits it. Spawning requires Start or a queued
 * user gesture. Cloud hosts set restoreOnReveal false to keep mount read-only;
 * explicit Restart remains available.
 *
 * Start, queued gestures and the host's registered start share one spawn/bind
 * path. A host with `ownsRecoveryUi` renders Start, Restart and their errors
 * itself, so the surface then shows terminal output only.
 */
export const TerminalPanelSurface = memo(function TerminalPanelSurface({
  host,
  appName,
  onSendToChat,
  getPathsForFiles,
  suppressNativeContextMenu,
  onOpenLink,
  projectId,
  worktreeId,
  panelId,
  terminalId,
  active = false,
}: TerminalPanelSurfaceProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const spawnInFlightRef = useRef<{
    attempt: Promise<void>;
    origin: RecoveryAttemptOrigin;
  } | null>(null);
  const restartInFlightRef = useRef<{
    terminalId: string;
    attempt: Promise<void>;
  } | null>(null);
  const restartFocusPendingRef = useRef(false);
  const ownsRecoveryUi = host.ownsRecoveryUi === true;
  const [starting, setStarting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paneRevision, setPaneRevision] = useState(0);
  const [hydrationRetry, setHydrationRetry] = useState(0);
  const worktreeKey = makeWorktreePanelKey(projectId, worktreeId);
  const placement = usePanelPlacement();
  const layoutKey = placement?.layoutKey ?? worktreeKey;
  const bucket = useTerminalStore(
    useShallow((state) => selectBucket(state, projectId, worktreeId)),
  );
  const session = terminalId ? bucket?.sessions[terminalId] : undefined;

  // Automatic restore publishes success through the store, outside Restart.
  useEffect(() => {
    if (session?.live) setError(null);
  }, [session?.live]);

  // A new terminal's pane does not exist yet, so measure the space it will
  // fill: this surface's content area.
  const startSize = useCallback(async (): Promise<TerminalSize> => {
    const area = rootRef.current;
    if (!area) return DEFAULT_SIZE;
    // This helper imports xterm to measure the configured font. Keep that
    // browser-only dependency out of the panel registry's module graph until
    // a terminal is actually started.
    const { measureTerminalDimensions } = await import('./terminal-dimensions');
    return measureTerminalDimensions(area) ?? DEFAULT_SIZE;
  }, []);

  useEffect(
    () =>
      registerTerminalClientLifecycle(({ isCurrent }) => {
        let retryTimer: number | undefined;
        ensureTerminalExitSubscription();
        const preparation = host.prepareWorktree
          ? host.prepareWorktree(projectId, worktreeId, worktreeKey)
          : ensureTerminalWorktreeHydrated(projectId, worktreeId);
        void preparation.catch(() => {
          // Empty panels retry hydration before spawn. A persisted binding has no
          // equivalent user action, so keep its loading state and retry after a
          // short delay instead of leaving it permanently stranded.
          if (isCurrent() && terminalId) {
            retryTimer = window.setTimeout(() => {
              setHydrationRetry((attempt) => attempt + 1);
            }, 1_000);
          }
        });
        return (): void => {
          if (retryTimer !== undefined) window.clearTimeout(retryTimer);
        };
      }),
    [host, hydrationRetry, projectId, terminalId, worktreeId, worktreeKey],
  );

  // Desktop keeps the surface's own message for every failure. A host that
  // owns recovery UI hears only about attempts the surface began itself: its
  // own registered calls already reject with the original error.
  const reportFailure = useCallback(
    (error: unknown, message: string, origin: RecoveryOrigin): void => {
      if (!host.ownsRecoveryUi)
        setError(terminalShellUnavailableMessage(error) ?? message);
      else if (origin === 'surface') host.onRecoveryError?.(error);
    },
    [host],
  );

  // Rejects with the original error. Resolves once a new terminal is bound to
  // this panel, or at once when the panel is already bound.
  const runSpawn = useCallback(
    async (
      terminalProfileId: TerminalShellProfileId | undefined,
      allowBoundTerminal: boolean,
      origin: RecoveryAttemptOrigin,
    ): Promise<void> => {
      setStarting(true);
      host.onStartingChange?.(true);
      setError(null);
      let lifetime: TerminalClientLifetime | undefined;
      try {
        lifetime = requireTerminalClientLifetime();
        await ensureTerminalWorktreeHydrated(projectId, worktreeId).catch(
          () => undefined,
        );
        if (!lifetime.isCurrent()) throw clientChangedError();
        // A persisted terminal panel remains bound even while its session is
        // unresolved. Reveal/empty-state paths must not replace that binding;
        // only an explicit new-tab request may spawn beside it.
        //
        // Read the binding LIVE rather than from the captured `terminalId`
        // prop: the hydration await above is exactly when a restored session
        // binds this placeholder, and a stale read there spawns a duplicate
        // PTY beside the one that just appeared. Reaching that race takes a
        // reveal gesture landing mid-restore, which auto-start now makes
        // routine.
        const bound = host.getBinding(worktreeKey, panelId) ?? terminalId;
        if (bound && !allowBoundTerminal) return;
        const { cols, rows } = await startSize();
        if (!lifetime.isCurrent()) throw clientChangedError();
        const created = await lifetime.client.command('terminal.spawn', {
          projectId,
          worktreeId,
          cols,
          rows,
          ...(terminalProfileId ? { terminalProfileId } : {}),
        });
        if (!lifetime.isCurrent()) {
          // The request may have created a PTY after its host was disposed.
          // Clean up through that original transport, never the replacement.
          await lifetime.client.command('terminal.kill', {
            terminalId: created.id,
          });
          throw clientChangedError();
        }
        useTerminalStore.getState().addGroupWithTerminal(created);
        const panelBound =
          lifetime.isCurrent() &&
          host.bindTerminal(worktreeKey, panelId, created);
        if (!panelBound || !lifetime.isCurrent()) {
          if (lifetime.isCurrent()) {
            useTerminalActivityStore
              .getState()
              .markUserInitiatedClose(created.id);
            useTerminalStore
              .getState()
              .removeTerminal(projectId, worktreeId, created.id);
          }
          await lifetime.client.command('terminal.kill', {
            terminalId: created.id,
          });
          throw new Error('Unable to bind terminal panel');
        }
        // Only a successfully bound terminal in this host may claim the caret.
        // The pane observes intent revisions, including requests made after mount.
        requestTerminalFocus(
          created.id,
          rootRef.current?.ownerDocument ?? document,
        );
      } catch (error: unknown) {
        if (!lifetime || lifetime.isCurrent())
          reportFailure(error, 'Unable to start terminal', origin.current);
        throw error;
      } finally {
        setStarting(false);
        host.onStartingChange?.(false);
      }
    },
    [
      host,
      panelId,
      projectId,
      reportFailure,
      startSize,
      terminalId,
      worktreeId,
      worktreeKey,
    ],
  );

  // The one spawn/bind path for Start, queued gestures and the host's start.
  // A second request while one is in flight joins it rather than spawning
  // again; only the attempt's originator shows or reports its failure. A host
  // start that joins a surface-begun attempt becomes its originator.
  const startTerminal = useCallback(
    (
      terminalProfileId: TerminalShellProfileId | undefined,
      allowBoundTerminal: boolean,
      origin: RecoveryOrigin,
    ): Promise<void> => {
      const inFlight = spawnInFlightRef.current;
      if (inFlight) {
        if (origin === 'host') inFlight.origin.current = 'host';
        return inFlight.attempt;
      }
      const attemptOrigin: RecoveryAttemptOrigin = { current: origin };
      const attempt = runSpawn(
        terminalProfileId,
        allowBoundTerminal,
        attemptOrigin,
      ).finally(() => {
        if (spawnInFlightRef.current?.attempt === attempt)
          spawnInFlightRef.current = null;
      });
      spawnInFlightRef.current = { attempt, origin: attemptOrigin };
      return attempt;
    },
    [runSpawn],
  );

  // Rejects with the original error. Resolves once the terminal is live again.
  const runRestart = useCallback(
    async (target: string, origin: RecoveryOrigin): Promise<void> => {
      setRestarting(true);
      setError(null);
      let lifetime: TerminalClientLifetime | undefined;
      try {
        lifetime = requireTerminalClientLifetime();
        // The shell draws its first prompt at this size, before any resize.
        const { cols, rows } = restartSize(target);
        const restored = await lifetime.client.command('terminal.restore', {
          terminalId: target,
          cols,
          rows,
        });
        if (!lifetime.isCurrent()) {
          await lifetime.client.command('terminal.kill', {
            terminalId: restored.id,
          });
          throw clientChangedError();
        }
        // Recreate xterm so the first attach replays persisted scrollback plus
        // the synthetic restart marker before live output resumes.
        disposeInstance(target);
        useTerminalStore.getState().markTerminalLive(restored);
        // Restart is an explicit user gesture, so the restarted terminal is
        // entitled to the caret (CAN-2309). The request must be recorded AFTER
        // the remount below, not here: the pane is keyed on `paneRevision`, and
        // `restore` reuses the same terminal id, so the outgoing pane's unmount
        // cleanup (`clearTerminalFocusRequest(terminalId)`) would delete a
        // request recorded now before the incoming pane could consume it.
        restartFocusPendingRef.current = true;
        setPaneRevision((value) => value + 1);
      } catch (error: unknown) {
        if (!lifetime || lifetime.isCurrent())
          reportFailure(error, 'Unable to restart terminal', origin);
        throw error;
      } finally {
        setRestarting(false);
      }
    },
    [reportFailure],
  );

  // A restart of the same terminal while one is in flight joins it.
  const restartTerminal = useCallback(
    (origin: RecoveryOrigin): Promise<void> => {
      if (!terminalId)
        return Promise.reject(new Error('No terminal to restart'));
      const inFlight = restartInFlightRef.current;
      if (inFlight) {
        return inFlight.terminalId === terminalId
          ? inFlight.attempt
          : Promise.reject(new Error('Another terminal is restarting'));
      }
      const attempt = runRestart(terminalId, origin).finally(() => {
        if (restartInFlightRef.current?.attempt === attempt)
          restartInFlightRef.current = null;
      });
      restartInFlightRef.current = { terminalId, attempt };
      return attempt;
    },
    [runRestart, terminalId],
  );

  // The surface's own gestures have no awaiting caller. Their attempt already
  // showed or reported its failure, so the rejection stops here instead of
  // escaping as an unhandled rejection.
  const startFromSurface = useCallback((): void => {
    void startTerminal(undefined, false, 'surface').catch(() => undefined);
  }, [startTerminal]);
  const restartFromSurface = useCallback((): void => {
    void restartTerminal('surface').catch(() => undefined);
  }, [restartTerminal]);
  const startFromHost = useCallback(
    (): Promise<void> => startTerminal(undefined, false, 'host'),
    [startTerminal],
  );
  const restartFromHost = useCallback(
    (): Promise<void> => restartTerminal('host'),
    [restartTerminal],
  );

  useEffect(
    () => host.registerStart?.(panelId, startFromHost),
    [host, panelId, startFromHost],
  );
  useEffect(
    () => host.registerRestart?.(panelId, restartFromHost),
    [host, panelId, restartFromHost],
  );

  // Records the restart gesture once the replacement pane has mounted. Child
  // effects run before parent effects, so the new pane's claim effect has
  // already run by the time this fires — it re-evaluates because
  // `requestTerminalFocus` bumps the intent revision the pane subscribes to,
  // which is exactly the after-mount reveal case that counter exists for.
  useEffect(() => {
    if (!restartFocusPendingRef.current) return;
    if (!terminalId) return;
    restartFocusPendingRef.current = false;
    requestTerminalFocus(
      terminalId,
      rootRef.current?.ownerDocument ?? document,
    );
  }, [paneRevision, terminalId]);

  useEffect(() => {
    if (!active) return undefined;
    let running = false;
    const consume = (): void => {
      if (running) return;
      let lifetime: TerminalClientLifetime;
      try {
        lifetime = requireTerminalClientLifetime();
      } catch {
        // A disposed host cannot consume a pending user gesture.
        return;
      }
      const request = consumePendingTerminalSpawn(
        projectId,
        worktreeId,
        layoutKey,
        panelId,
      );
      if (!request) return;
      running = true;
      void (async (): Promise<void> => {
        await ensureTerminalWorktreeHydrated(projectId, worktreeId).catch(
          () => undefined,
        );
        if (!lifetime.isCurrent()) return;
        const current = selectBucket(
          useTerminalStore.getState(),
          projectId,
          worktreeId,
        );
        const count = current ? Object.keys(current.sessions).length : 0;
        // Read the binding LIVE for the same reason `runSpawn` does: the
        // hydration await above is exactly when a restored session binds this
        // placeholder. Branching on the captured `terminalId` there sent a
        // just-bound panel down the spawn path, where the live check inside
        // `runSpawn` correctly declines to create a duplicate PTY — and then
        // nobody requested the caret for the terminal that had just appeared,
        // so the reveal gesture landed without moving it.
        const bound = host.getBinding(worktreeKey, panelId) ?? terminalId;
        if (request.mode === 'ensure' && count > 0 && bound) {
          // An explicit reveal is a user gesture. The pane consumes this
          // once; a gesture left unhonored when the window blurs is
          // discarded by the intent module (CAN-2309).
          //
          // Live-only by design: the pane's claim effect requires `live`, so
          // revealing an EXITED terminal records a request that is dropped on
          // the same commit and the caret stays where it is. That is the
          // fail-closed side to be on — there is nothing to type into — and
          // Restart above is the path that re-arms the claim.
          requestTerminalFocus(
            bound,
            rootRef.current?.ownerDocument ?? document,
          );
        } else {
          // The attempt shows or reports its own failure; nothing awaits it.
          await startTerminal(
            undefined,
            request.mode === 'new-tab',
            'surface',
          ).catch(() => undefined);
        }
      })().finally(() => {
        running = false;
        consume();
      });
    };
    consume();
    return subscribeTerminalSpawnRequests((request) => {
      if (
        terminalSpawnRequestTargets(
          request,
          projectId,
          worktreeId,
          layoutKey,
          panelId,
        )
      ) {
        consume();
      }
    });
  }, [
    active,
    host,
    layoutKey,
    panelId,
    projectId,
    startTerminal,
    terminalId,
    worktreeId,
    worktreeKey,
  ]);

  return (
    <div
      ref={rootRef}
      data-testid="terminal-panel-surface"
      data-panel-id={panelId}
      className="relative flex h-full min-h-0 min-w-0 flex-1"
    >
      {terminalId ? (
        session ? (
          <>
            <TerminalPane
              key={`${terminalId}:${paneRevision}`}
              terminalId={terminalId}
              onSendToChat={onSendToChat}
              getPathsForFiles={getPathsForFiles}
              suppressNativeContextMenu={suppressNativeContextMenu}
              onOpenLink={onOpenLink}
              // Searchable even once exited: the scrollback stays readable.
              findTitle={session.title?.trim() || 'Terminal'}
              live={session.live}
              restoreOnMount={
                (host.restoreOnReveal ?? true) &&
                active &&
                isTerminalRestorableSession(session)
              }
              // A host that owns recovery UI shows the one restart notice, so
              // the pane draws no read-only bar or second Restart button.
              readOnlyMessage={
                ownsRecoveryUi
                  ? null
                  : getTerminalReadOnlyMessage(session, appName)
              }
              onRestart={
                !ownsRecoveryUi && isTerminalRestartableSession(session)
                  ? restartFromSurface
                  : undefined
              }
              onRestoreFailed={(error: unknown): void => {
                // Only a chosen shell that cannot start is worth a message;
                // any other lazy-restore failure keeps the read-only bar.
                const reason = terminalShellUnavailableMessage(error);
                if (reason !== null && !ownsRecoveryUi) setError(reason);
              }}
              restarting={restarting}
              // Eligibility only — the pane claims the caret solely for a
              // recorded user gesture, and releases it when this goes false.
              focused={active}
              onFocus={(): void => undefined}
            />
            {!ownsRecoveryUi && error && (
              <div className="pointer-events-none absolute inset-x-3 top-3 z-10">
                <ErrorBanner
                  errorSource="terminal-panel-error"
                  className=""
                  error={error}
                  blockMessageFromReplay
                  testId="terminal-panel-error"
                />
              </div>
            )}
          </>
        ) : (
          <div
            data-testid="terminal-panel-loading"
            className="flex min-h-0 flex-1 items-center justify-center text-xs fg-secondary"
            aria-live="polite"
          >
            Loading terminal…
          </div>
        )
      ) : ownsRecoveryUi ? null : (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2">
          {error && (
            <div className="w-full max-w-sm px-3">
              <ErrorBanner
                errorSource="terminal-panel-surface"
                className=""
                error={error}
                blockMessageFromReplay
              />
            </div>
          )}
          <Button
            size="compact"
            data-testid="terminal-start-button"
            onClick={startFromSurface}
            disabled={starting}
          >
            Start terminal
          </Button>
        </div>
      )}
    </div>
  );
});
