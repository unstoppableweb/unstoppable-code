'use client';

import {
  TerminalReadOnlyNotice,
  TerminalViewport,
} from '@canopy/ui-shared/components';
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type JSX,
  type KeyboardEvent as ReactKeyboardEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import {
  registerTerminalClientLifecycle,
  useTerminalStore,
} from '@canopy/app-state/terminal';
import type { TerminalOutputEvent } from '@canopy/protocol/terminal';
import { copyTextToClipboard } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';
import { useTerminalFind } from '../../find/useTerminalFind';
import {
  dataTransferHasFiles,
  formatFilePathsForTerminalPaste,
  resolveDroppedFilePaths,
} from './terminal-file-drop';
import {
  getOrCreateInstance,
  peekInstance,
  TERMINAL_BG_COLOR,
  TERMINAL_FIND_DECORATIONS,
  type TerminalInstanceEntry,
} from './terminal-instances';
import { proposeUsableTerminalSize } from './terminal-resize-guard';
import { isTerminalTarget } from './terminal-dom';
import {
  clearTerminalFocusRequest,
  consumeTerminalFocusRequest,
  getTerminalFocusRequestRevision,
  subscribeTerminalFocusRequests,
} from './terminal-focus-intent';
import { TerminalSelectionMenu } from './TerminalSelectionMenu';
import { installTerminalLinks } from './terminal-links';
import { notifyTerminalInput } from './terminal-input';

export interface TerminalPaneProps {
  terminalId: string;
  live: boolean;
  restoreOnMount: boolean;
  /**
   * Whether to report the fitted xterm dimensions back to the PTY. Defaults to
   * {@link live}. A read-only viewer of a *live* PTY (e.g. a Claude Worker card)
   * must set this true even though `live` is false, otherwise the PTY keeps its
   * spawn size and the agent renders for the wrong width, garbling the output.
   * Leave false for historical/exited terminals where resizing a dead PTY is
   * pointless.
   */
  reportResize?: boolean;
  readOnlyMessage: string | null;
  /** Restarts a read-only shell while retaining its persisted scrollback. */
  onRestart?: () => void;
  /**
   * Hears why the automatic restore on mount failed. The pane itself stays a
   * read-only historical terminal; a host may show the reason.
   */
  onRestoreFailed?: (error: unknown) => void;
  restarting?: boolean;
  /** Enables the terminal selection affordance that inserts text into chat. */
  addToChatSelectionHelper?: boolean;
  /** Enables the terminal selection affordance that copies text to clipboard. */
  copySelectionHelper?: boolean;
  /** Enables file drag/drop by pasting dropped file paths into the PTY. */
  pasteDroppedFiles?: boolean;
  /** Receives selected terminal text for the host's current chat composer. */
  onSendToChat?: (text: string) => void;
  /**
   * Resolves dropped browser Files to paths the backend can open; the host
   * may upload them first.
   */
  getPathsForFiles?: (files: ReadonlyArray<File>) => Promise<string[]>;
  /**
   * Cancels the native right-click menu. The desktop host sets this: its
   * text-field menu would act on xterm's hidden helper textarea, not the
   * terminal. Web hosts leave it unset to keep the browser's own menu.
   */
  suppressNativeContextMenu?: boolean;
  /** Host browser action for links printed by the terminal. */
  onOpenLink?: (url: string) => void;
  /**
   * Opts the pane into the Cmd/Ctrl+F find bar's terminal mode; the title
   * names it in the bar's scope menu. Unset, the pane is not searchable and
   * the find chord opens nothing from it.
   */
  findTitle?: string;
  /**
   * True when this pane is the one the user selected within its group, i.e.
   * it is ELIGIBLE to hold the caret. It is not, on its own, permission to
   * take the caret: claiming requires a recorded user gesture
   * (`terminal-focus-intent`) plus a focused app window (CAN-2309).
   * Going false releases the caret and restores it to whatever held it
   * before this pane took it.
   */
  focused: boolean;
  /** Called when the pane is clicked (for focusing). */
  onFocus: () => void;
}

const TERMINAL_ESCAPE = '\u001b';
const TERMINAL_BELL = '\u0007';

function isReplayGeneratedTerminalResponse(data: string): boolean {
  const isOscResponse =
    [
      `${TERMINAL_ESCAPE}]4;`,
      `${TERMINAL_ESCAPE}]10;`,
      `${TERMINAL_ESCAPE}]11;`,
      `${TERMINAL_ESCAPE}]12;`,
    ].some((prefix) => data.startsWith(prefix)) &&
    (data.endsWith(TERMINAL_BELL) || data.endsWith(`${TERMINAL_ESCAPE}\\`));
  if (isOscResponse) return true;

  if (!data.startsWith(`${TERMINAL_ESCAPE}[`)) return false;
  const final = data[data.length - 1];
  if (final !== 'c' && final !== 'R' && final !== 'n' && final !== 't') {
    return false;
  }
  return Array.from(data.slice(2, -1)).every(
    (character) =>
      (character >= '0' && character <= '9') ||
      character === ';' ||
      character === ':' ||
      character === '?' ||
      character === '>' ||
      character === '=',
  );
}

// Debounced resize IPC — coalesces events during an active drag.
const RESIZE_DEBOUNCE_MS = 50;
const RESTORE_FALLBACK_COLS = 80;
const RESTORE_FALLBACK_ROWS = 24;
const POST_MOUNT_REFIT_DELAYS_MS = [100, 300];

function TerminalPaneImpl({
  terminalId,
  live,
  restoreOnMount,
  reportResize,
  readOnlyMessage,
  onRestart,
  onRestoreFailed,
  restarting = false,
  addToChatSelectionHelper = true,
  copySelectionHelper = true,
  pasteDroppedFiles = false,
  onSendToChat,
  getPathsForFiles,
  suppressNativeContextMenu = false,
  onOpenLink,
  findTitle,
  focused,
  onFocus,
}: TerminalPaneProps): JSX.Element {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Stash the instance handle so cleanup knows which container to detach.
  const entryRef = useRef<TerminalInstanceEntry | null>(null);
  const liveRef = useRef(live);
  const onRestoreFailedRef = useRef(onRestoreFailed);
  onRestoreFailedRef.current = onRestoreFailed;
  // Changes whenever this pane stops showing a terminal (it shows another,
  // or unmounts), so work that finishes later can tell it is stale.
  const paneGenerationRef = useRef(0);
  // Resize reporting is decoupled from input: a read-only viewer of a live PTY
  // still needs to drive the PTY size. Defaults to `live` when unspecified.
  const reportResizeRef = useRef(reportResize ?? live);
  const requestFitRef = useRef<(forceReport?: boolean) => void>(() => {});
  const fileDragDepthRef = useRef(0);
  const [isFileDropActive, setIsFileDropActive] = useState(false);
  const [selectionPill, setSelectionPill] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // Stacked Alt-click block selections, in click order. Each entry is a range
  // of absolute buffer rows. We render our own subtle overlays for these
  // (xterm's native selection only supports a single contiguous range), and
  // the "Add to chat" pill aggregates their text.
  interface BlockRange {
    startRow: number;
    endRow: number;
  }
  const [blockSelections, setBlockSelections] = useState<BlockRange[]>([]);
  const blockSelectionsRef = useRef<BlockRange[]>([]);
  const [blockOverlays, setBlockOverlays] = useState<
    { top: number; height: number }[]
  >([]);
  // Recompute closure registered by the pill effect so the alt-click effect
  // and the blockSelections-change effect can request a refresh without
  // re-subscribing xterm disposables.
  const recomputeRef = useRef<() => void>(() => {});

  useEffect(() => {
    paneGenerationRef.current += 1;
    return (): void => {
      paneGenerationRef.current += 1;
    };
  }, [terminalId]);

  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  useEffect(() => {
    reportResizeRef.current = reportResize ?? live;
  }, [reportResize, live]);

  useEffect(() => {
    blockSelectionsRef.current = blockSelections;
  }, [blockSelections]);

  // Wipe stacked blocks when the pane swaps to a different terminal — block
  // ranges are buffer-row indices that don't carry meaning across instances.
  useEffect(() => {
    setBlockSelections([]);
  }, [terminalId]);

  const addToChatAvailable =
    addToChatSelectionHelper && onSendToChat !== undefined;
  const selectionMenuEnabled = addToChatAvailable || copySelectionHelper;

  const getSelectedText = useCallback((): string => {
    const entry = entryRef.current ?? peekInstance(terminalId);
    if (!entry) return '';
    const blocks = blockSelectionsRef.current;
    if (blocks.length > 0) {
      const buffer = entry.term.buffer.active;
      // Send blocks in their natural top-to-bottom order in the terminal,
      // not the order the user clicked them, so the resulting context reads
      // like a contiguous slice of the console.
      const orderedBlocks = [...blocks].sort((a, b) => a.startRow - b.startRow);
      return orderedBlocks
        .map((block) => {
          const lines: string[] = [];
          for (let r = block.startRow; r <= block.endRow; r += 1) {
            const line = buffer.getLine(r);
            lines.push(line ? line.translateToString(true) : '');
          }
          return lines.join('\n');
        })
        .join('\n\n');
    }
    return entry.term.getSelection();
  }, [terminalId]);

  const dispatchSelectionToChat = useCallback((): void => {
    if (!addToChatSelectionHelper || onSendToChat === undefined) return;
    const text = getSelectedText();
    if (!text) return;
    onSendToChat(text);
  }, [addToChatSelectionHelper, getSelectedText, onSendToChat]);

  const copySelectionToClipboard = useCallback(async (): Promise<boolean> => {
    if (!copySelectionHelper) return false;
    const text = getSelectedText();
    if (!text) return false;
    return copyTextToClipboard(text);
  }, [copySelectionHelper, getSelectedText]);

  // Mount: attach cached xterm container + wire attach/output pipeline.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return undefined;
    }
    const hostElement = host;

    const entry = getOrCreateInstance(terminalId);
    entryRef.current = entry;

    // Re-parent the detached container into this pane. Do NOT call
    // `term.open()` a second time if we've already opened before — xterm
    // caches its viewport the first time and re-openening detaches DOM
    // listeners.
    hostElement.appendChild(entry.container);
    // xterm requires `open()` to bind to its container. Check if it has
    // already been opened (re-mount) — xterm sets `.element` once opened.
    const opened =
      entry.container.firstChild !== null && entry.term.element !== undefined;
    if (!opened) {
      entry.term.open(entry.container);
    }

    // The cached terminal has one transport owner even while old and new
    // panes overlap during navigation. Retiring the old registration also
    // prevents it from reacquiring output on a later host rebind.
    entry.outputDisposable?.dispose();
    const unregisterOutput = registerTerminalClientLifecycle(
      ({ client, isCurrent }) => {
        let aborted = false;
        const isActive = (): boolean => !aborted && isCurrent();
        let lastReportedResize: { cols: number; rows: number } | null = null;

        function fitAndReportResize(options?: { forceReport?: boolean }): void {
          if (!isActive()) return;
          const dimensions = proposeUsableTerminalSize(entry.fit, hostElement);
          if (dimensions === null) {
            return;
          }

          if (
            entry.term.cols !== dimensions.cols ||
            entry.term.rows !== dimensions.rows
          ) {
            entry.term.resize(dimensions.cols, dimensions.rows);
          }
          // The fitted xterm size, readable from the DOM without a global
          // terminal handle (browser tests compare it with the PTY's size).
          paneRef.current?.setAttribute(
            'data-terminal-cols',
            String(dimensions.cols),
          );
          paneRef.current?.setAttribute(
            'data-terminal-rows',
            String(dimensions.rows),
          );

          if (!reportResizeRef.current) {
            return;
          }
          if (
            options?.forceReport !== true &&
            lastReportedResize?.cols === dimensions.cols &&
            lastReportedResize.rows === dimensions.rows
          ) {
            return;
          }
          lastReportedResize = dimensions;
          void client
            .command('terminal.resize', {
              terminalId,
              cols: dimensions.cols,
              rows: dimensions.rows,
            })
            .catch(() => {
              // The backend can disappear during route transitions or app
              // shutdown; the next successful mount/resize will resync size.
            });
        }

        // Every acquisition fills any gap before accepting live output.
        let readyForLiveOutput = false;
        const queuedOutput: TerminalOutputEvent[] = [];

        function flushQueuedOutput(): void {
          if (!isActive()) return;
          if (queuedOutput.length === 0) {
            return;
          }

          for (const event of queuedOutput.splice(0, queuedOutput.length)) {
            handleOutput(event);
          }
        }

        const handleOutput = (event: TerminalOutputEvent): void => {
          if (!isActive() || event.terminalId !== terminalId) {
            return;
          }
          if (!readyForLiveOutput) {
            queuedOutput.push(event);
            return;
          }
          if (event.seq <= entry.lastReplayedSeq) {
            return;
          }
          // A live chunk can straddle the final byte returned by attach.
          const overlap = Math.max(
            0,
            event.data.length - (event.seq - entry.lastReplayedSeq),
          );
          entry.term.write(
            overlap > 0 ? event.data.subarray(overlap) : event.data,
          );
          entry.lastReplayedSeq = event.seq;
        };
        const unsubOutput = client.subscribe('terminal.output', handleOutput);

        // Attach + replay only bytes this cached instance has not consumed.
        async function maybeRestoreTerminal(): Promise<void> {
          if (!restoreOnMount) {
            return;
          }

          fitAndReportResize({ forceReport: true });

          try {
            const session = await client.command('terminal.restore', {
              terminalId,
              cols:
                entry.term.cols > 0 ? entry.term.cols : RESTORE_FALLBACK_COLS,
              rows:
                entry.term.rows > 0 ? entry.term.rows : RESTORE_FALLBACK_ROWS,
            });
            if (!isActive()) {
              return;
            }
            useTerminalStore.getState().markTerminalLive(session);
          } catch (error: unknown) {
            // Leave the historical terminal read-only if lazy restore fails,
            // and tell the host why so it can show an actionable reason.
            if (isActive()) onRestoreFailedRef.current?.(error);
          }
        }

        async function attachOnce(
          current: TerminalInstanceEntry,
        ): Promise<void> {
          try {
            await maybeRestoreTerminal();
            if (!isActive()) return;
            const response = await client.command('terminal.attach', {
              terminalId,
            });
            if (!isActive()) {
              return;
            }
            const delta = response.seq - current.lastReplayedSeq;
            if (delta > 0) {
              const replayStart = Math.max(0, response.replay.length - delta);
              current.pendingReplayWrites += 1;
              // Account for bytes as soon as they are queued in xterm. A newer
              // owner must not replay them while this write callback is pending.
              current.lastReplayedSeq = response.seq;
              try {
                await new Promise<void>((resolve) => {
                  current.term.write(
                    response.replay.subarray(replayStart),
                    resolve,
                  );
                });
              } finally {
                current.pendingReplayWrites -= 1;
              }
              if (!isActive()) {
                return;
              }
            }
            current.lastReplayedSeq = Math.max(
              current.lastReplayedSeq,
              response.seq,
            );
            current.attached = true;
            readyForLiveOutput = true;
            flushQueuedOutput();
          } catch {
            if (!isActive()) return;
            // Backend may be missing during early development — leave attached
            // false so a retry on next mount is possible, but still allow live
            // frames through for this mount.
            readyForLiveOutput = true;
            flushQueuedOutput();
          }
        }
        void attachOnce(entry);

        // ResizeObserver → fit + IPC resize, debounced. Guard proposed sizes so
        // route transitions / hidden panels cannot shrink the PTY to a transient
        // handful of columns and hard-wrap Claude Code output.
        let resizeTimer: ReturnType<typeof setTimeout> | null = null;
        const postMountTimers: ReturnType<typeof setTimeout>[] = [];
        const postMountFrames: number[] = [];

        function scheduleResizeReport(forceReport = false): void {
          if (resizeTimer !== null) {
            clearTimeout(resizeTimer);
          }
          resizeTimer = setTimeout(() => {
            resizeTimer = null;
            fitAndReportResize({ forceReport });
          }, RESIZE_DEBOUNCE_MS);
        }
        requestFitRef.current = scheduleResizeReport;

        function schedulePostMountRefits(): void {
          fitAndReportResize({ forceReport: true });

          const firstFrame = window.requestAnimationFrame(() => {
            fitAndReportResize({ forceReport: true });
            const secondFrame = window.requestAnimationFrame(() => {
              fitAndReportResize({ forceReport: true });
            });
            postMountFrames.push(secondFrame);
          });
          postMountFrames.push(firstFrame);

          for (const delay of POST_MOUNT_REFIT_DELAYS_MS) {
            postMountTimers.push(
              setTimeout(() => {
                fitAndReportResize({ forceReport: true });
              }, delay),
            );
          }
        }

        const observer = new ResizeObserver(() => {
          scheduleResizeReport();
        });
        observer.observe(hostElement);
        schedulePostMountRefits();

        const handleWindowResize = (): void => {
          scheduleResizeReport(true);
        };
        const handleVisibilityChange = (): void => {
          if (document.visibilityState === 'visible') {
            scheduleResizeReport(true);
          }
        };
        window.addEventListener('resize', handleWindowResize);
        document.addEventListener('visibilitychange', handleVisibilityChange);

        return (): void => {
          aborted = true;
          unsubOutput();
          observer.disconnect();
          window.removeEventListener('resize', handleWindowResize);
          document.removeEventListener(
            'visibilitychange',
            handleVisibilityChange,
          );
          if (resizeTimer !== null) {
            clearTimeout(resizeTimer);
          }
          requestFitRef.current = (): void => {};
          for (const timer of postMountTimers) {
            clearTimeout(timer);
          }
          for (const frame of postMountFrames) {
            window.cancelAnimationFrame(frame);
          }
        };
      },
    );
    const ownedOutput = {
      dispose: (): void => {
        unregisterOutput();
        if (entry.outputDisposable === ownedOutput)
          entry.outputDisposable = null;
      },
    };
    entry.outputDisposable = ownedOutput;

    return (): void => {
      ownedOutput.dispose();
      // Detach container but do NOT dispose the xterm — the cache survives
      // unmount so scrollback/attach state is preserved.
      if (entry.container.parentElement === hostElement) {
        hostElement.removeChild(entry.container);
      }
    };
  }, [restoreOnMount, terminalId]);

  // Must stay below the mount effect: effects run in declaration order, and
  // the find controller registers only once that effect has set `entryRef`.
  const terminalFind = useTerminalFind({
    enabled: findTitle !== undefined,
    scopeKey: terminalId,
    title: findTitle ?? '',
    rootRef: paneRef,
    entryRef,
    decorations: TERMINAL_FIND_DECORATIONS,
  });
  const findActiveRef = terminalFind.activeRef;

  useEffect(() => {
    const term = entryRef.current?.term;
    if (!term) return;
    return installTerminalLinks(term, onOpenLink);
  }, [onOpenLink, terminalId]);

  useEffect(() => {
    const entry = entryRef.current ?? peekInstance(terminalId);
    if (!entry) {
      return;
    }

    entry.term.options.disableStdin = !live;
    entry.term.options.cursorBlink = live;
    entry.term.options.cursorInactiveStyle = live ? 'outline' : 'none';

    if (!live) {
      entry.inputDisposable?.dispose();
      entry.inputDisposable = null;
      try {
        entry.term.blur();
      } catch {
        // ignore — xterm can be mid-mount during lifecycle transitions
      }
      return;
    }

    const unregisterInput = registerTerminalClientLifecycle(
      ({ client, isCurrent }) => {
        // The cache survives panes, but its input handler belongs to the current
        // pane and host binding. A newer pane takes ownership immediately.
        entry.inputDisposable?.dispose();
        let active = true;
        const notifyUserInput = (): void => {
          if (active && isCurrent() && !entry.term.options.disableStdin)
            notifyTerminalInput(terminalId);
        };
        const keySubscription = entry.term.onKey(notifyUserInput);
        const textarea = entry.term.textarea;
        const inputContainer = entry.container;
        const notifyTextInput = (event: Event): void => {
          if (event.target === textarea) notifyUserInput();
        };
        // Xterm already captures input on its textarea. Observe the ancestor
        // first so paste/IME intent owns the line before xterm sends its data.
        inputContainer.addEventListener('input', notifyTextInput, true);
        inputContainer.addEventListener('paste', notifyTextInput, true);
        const subscription = entry.term.onData((data: string): void => {
          if (!active || !isCurrent()) return;
          // Historical replay can contain terminal capability/color queries.
          // Suppress only xterm's control-sequence answers during the replay
          // write. Real user input remains writable while attach is pending or
          // after attach fails.
          if (
            entry.pendingReplayWrites > 0 &&
            isReplayGeneratedTerminalResponse(data)
          ) {
            return;
          }
          void client.command('terminal.write', { terminalId, data });
        });
        const ownedInput = {
          dispose: (): void => {
            if (!active) return;
            active = false;
            if (entry.inputDisposable === ownedInput) {
              entry.inputDisposable = null;
            }
            subscription.dispose();
            keySubscription.dispose();
            inputContainer.removeEventListener('input', notifyTextInput, true);
            inputContainer.removeEventListener('paste', notifyTextInput, true);
          },
        };
        entry.inputDisposable = ownedInput;
        return ownedInput.dispose;
      },
    );
    requestFitRef.current(true);
    return unregisterInput;
  }, [live, terminalId]);

  // Track text selection in the xterm instance and position a small action
  // menu near the end of the selection. xterm's `getSelectionPosition()`
  // returns absolute buffer-row coordinates, so we offset by the active
  // viewport to get viewport-relative cell coordinates and convert to pixels
  // via the rendered cell dimensions inferred from the host bounding rect.
  useEffect(() => {
    if (!selectionMenuEnabled) {
      setSelectionPill(null);
      setBlockOverlays([]);
      return;
    }
    const entry = entryRef.current ?? peekInstance(terminalId);
    if (!entry) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const updatePill = (): void => {
      // Each find step selects its match; that is not a selection to act on.
      if (findActiveRef.current) {
        setSelectionPill(null);
        setBlockOverlays([]);
        return;
      }
      const cols = entry.term.cols;
      const rows = entry.term.rows;
      if (cols <= 0 || rows <= 0) {
        setSelectionPill(null);
        setBlockOverlays([]);
        return;
      }
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width <= 0 || hostRect.height <= 0) {
        setSelectionPill(null);
        setBlockOverlays([]);
        return;
      }
      const cellWidth = hostRect.width / cols;
      const cellHeight = hostRect.height / rows;
      const viewportY = entry.term.buffer.active.viewportY;

      const blocks = blockSelectionsRef.current;
      let startRowOffset: number;
      let endRowOffset: number;
      let endX: number;

      if (blocks.length > 0) {
        // Block mode: render a soft overlay per stacked range, and anchor the
        // pill to the most recently added block.
        const overlays: { top: number; height: number }[] = [];
        for (const block of blocks) {
          const blockStart = block.startRow - viewportY;
          const blockEnd = block.endRow - viewportY;
          if (blockEnd < 0 || blockStart >= rows) {
            continue;
          }
          const clippedStart = Math.max(0, blockStart);
          const clippedEnd = Math.min(rows - 1, blockEnd);
          overlays.push({
            top: clippedStart * cellHeight,
            height: (clippedEnd - clippedStart + 1) * cellHeight,
          });
        }
        setBlockOverlays(overlays);

        const last = blocks[blocks.length - 1];
        startRowOffset = last.startRow - viewportY;
        endRowOffset = last.endRow - viewportY;
        // No per-character end column for whole-line blocks — anchor near the
        // right edge of the host so the pill trails the latest block.
        endX = hostRect.width - 4;
      } else {
        setBlockOverlays([]);
        const text = entry.term.getSelection();
        if (!text) {
          setSelectionPill(null);
          return;
        }
        const range = entry.term.getSelectionPosition();
        if (!range) {
          setSelectionPill(null);
          return;
        }
        startRowOffset = range.start.y - viewportY;
        endRowOffset = range.end.y - viewportY;
        // End column is inclusive in xterm — bump by 1 so the pill anchors to
        // the right edge of the last selected cell.
        endX = (range.end.x + 1) * cellWidth;
      }

      // Top edge of the first row and bottom edge of the last row, in
      // viewport-relative pixels. Negative / out-of-range values are possible
      // if part of the selection is scrolled out of view.
      const startTopY = startRowOffset * cellHeight;
      const endBottomY = (endRowOffset + 1) * cellHeight;
      const pillHeight = 28;
      const pillEstimatedWidth = addToChatAvailable ? 200 : 76;
      const margin = 6;

      // Prefer placing the pill ABOVE the start of the selection so it doesn't
      // visually cover the selected text or the lines immediately below it. If
      // there's no room above (selection starts near the top of the viewport),
      // fall back to placing it below the end of the selection. If neither
      // fits inside the host, pin it to the top of the viewport so it stays
      // in the field of view.
      const aboveTop = startTopY - pillHeight - margin;
      const belowTop = endBottomY + margin;
      let top: number;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else if (belowTop + pillHeight <= hostRect.height - margin) {
        top = belowTop;
      } else {
        top = margin;
      }
      // Final clamp guards against partial-visibility edge cases (e.g. a
      // selection that starts above and ends below the visible viewport).
      top = Math.max(
        margin,
        Math.min(top, hostRect.height - pillHeight - margin),
      );

      // Horizontally, anchor near the right end of the last selected line so
      // the pill follows where the user just released the mouse, but clamp
      // inside the host with a margin so it always stays in view.
      let left = endX - pillEstimatedWidth;
      if (left < margin) {
        left = Math.min(
          endX + margin,
          hostRect.width - pillEstimatedWidth - margin,
        );
      }
      left = Math.max(
        margin,
        Math.min(left, hostRect.width - pillEstimatedWidth - margin),
      );
      setSelectionPill({ top, left });
    };

    recomputeRef.current = updatePill;

    const selectionDisposable = entry.term.onSelectionChange(() => {
      updatePill();
    });
    // Recompute on scroll so the pill tracks the selection as it moves through
    // the viewport. Dispose alongside the selection subscription.
    const scrollDisposable = entry.term.onScroll(() => {
      updatePill();
    });
    const resizeObserver = new ResizeObserver(() => {
      updatePill();
    });
    resizeObserver.observe(host);

    return (): void => {
      recomputeRef.current = (): void => {};
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      resizeObserver.disconnect();
      setSelectionPill(null);
      setBlockOverlays([]);
    };
  }, [addToChatAvailable, findActiveRef, selectionMenuEnabled, terminalId]);

  // Recompute pill + overlays whenever the stacked-block list changes.
  useEffect(() => {
    recomputeRef.current();
  }, [blockSelections]);

  // Alt-click smart "block select": click anywhere in the terminal while
  // holding Alt/Option to add the surrounding paragraph (run of non-blank
  // lines) to the stacked block selection. Alt-click again on an existing
  // block to remove it. A plain (non-Alt) left mousedown clears all stacked
  // blocks so a fresh drag-select starts from scratch. Listens in the capture
  // phase on the host so we run before xterm's own mousedown handler.
  useEffect(() => {
    const entry = entryRef.current ?? peekInstance(terminalId);
    if (!selectionMenuEnabled) {
      if (blockSelectionsRef.current.length > 0) {
        setBlockSelections([]);
      }
      return;
    }
    if (!entry) {
      return;
    }
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const handleMouseDown = (event: MouseEvent): void => {
      if (event.button !== 0) {
        return;
      }
      if (!event.altKey) {
        // Plain left-click → drop stacked blocks so xterm's normal selection
        // takes over without competing highlights. Don't preventDefault: we
        // want xterm to handle drag-select, focus, etc. as usual.
        if (blockSelectionsRef.current.length > 0) {
          setBlockSelections([]);
        }
        return;
      }

      const cols = entry.term.cols;
      const rows = entry.term.rows;
      if (cols <= 0 || rows <= 0) {
        return;
      }
      const hostRect = host.getBoundingClientRect();
      if (hostRect.width <= 0 || hostRect.height <= 0) {
        return;
      }
      const cellHeight = hostRect.height / rows;
      const relativeY = event.clientY - hostRect.top;
      const viewportRow = Math.floor(relativeY / cellHeight);
      if (viewportRow < 0 || viewportRow >= rows) {
        return;
      }
      const buffer = entry.term.buffer.active;
      const clickedRow = buffer.viewportY + viewportRow;
      const totalLines = buffer.length;
      if (clickedRow < 0 || clickedRow >= totalLines) {
        return;
      }

      // Suppress xterm's own drag-select for this click — we manage the
      // selection ourselves via custom overlays.
      event.preventDefault();
      event.stopPropagation();

      // Toggle: if the click lands inside an existing stacked block, remove
      // it. Otherwise expand to the surrounding paragraph and append it.
      const existingIndex = blockSelectionsRef.current.findIndex(
        (b) => clickedRow >= b.startRow && clickedRow <= b.endRow,
      );
      if (existingIndex >= 0) {
        setBlockSelections((prev) =>
          prev.filter((_, i) => i !== existingIndex),
        );
        onFocus();
        return;
      }

      // A "boundary" line ends a paragraph block. Two cases:
      //   1. Truly blank line (only whitespace).
      //   2. Idle shell prompt — line whose last non-whitespace character is
      //      a prompt sigil (`%`, `$`, `#`, `>`) with nothing after it. This
      //      catches both lonely `% ` lines and full prompts like
      //      `user@host repo (branch) %` where no command was typed.
      // Without #2, terminal scrollback (which normally has no blank lines)
      // would be one giant paragraph and Alt-click would grab everything.
      const PROMPT_SIGIL = /[%$#>]$/;
      const isBoundary = (rowIndex: number): boolean => {
        const line = buffer.getLine(rowIndex);
        if (!line) return true;
        const trimmed = line.translateToString(true).trimEnd();
        if (trimmed === '') return true;
        return PROMPT_SIGIL.test(trimmed);
      };

      // Clicking on a boundary line (blank or idle prompt) has no paragraph
      // to expand to.
      if (isBoundary(clickedRow)) {
        return;
      }

      // Hard cap as a safety net — even if the heuristic above misclassifies
      // and there's a long run of non-boundary lines, the selection won't
      // explode to the entire scrollback.
      const MAX_BLOCK_LINES = 200;

      let startRow = clickedRow;
      while (
        startRow > 0 &&
        clickedRow - startRow < MAX_BLOCK_LINES &&
        !isBoundary(startRow - 1)
      ) {
        startRow -= 1;
      }
      let endRow = clickedRow;
      while (
        endRow < totalLines - 1 &&
        endRow - clickedRow < MAX_BLOCK_LINES &&
        !isBoundary(endRow + 1)
      ) {
        endRow += 1;
      }

      // Drop xterm's own selection so the stacked overlays are the single
      // source of truth for "what will be added to chat".
      try {
        entry.term.clearSelection();
      } catch {
        // ignore — clearSelection is a no-op when there's nothing selected
      }

      setBlockSelections((prev) => [...prev, { startRow, endRow }]);
      onFocus();
    };

    host.addEventListener('mousedown', handleMouseDown, true);
    return (): void => {
      host.removeEventListener('mousedown', handleMouseDown, true);
    };
  }, [selectionMenuEnabled, terminalId, onFocus]);

  // CAN-2309 — caret ownership.
  //
  // `caretOwnerRef` is non-null exactly while this pane believes it holds the
  // caret, and remembers the element that held it beforehand so the caret can
  // be handed back on release. Ownership is tracked explicitly rather than
  // derived from `document.activeElement` because xterm owns a textarea
  // inside its own container and a detached/cached pane can transition while
  // the app is in the background.
  const caretOwnerRef = useRef<{
    previous: HTMLElement | null;
    ownerDocument: Document;
    // Captured at claim time rather than re-resolved from the instance
    // registry at release time. Closing a terminal tab disposes the entry
    // first, and a missing entry made the "caret already moved on" check below
    // read `false` for this pane's OWN (now detached) textarea — so the
    // predecessor was never restored and the caret was left nowhere.
    container: HTMLElement | null;
  } | null>(null);
  const caretWindowBlurCleanupRef = useRef<(() => void) | null>(null);

  const releaseCaret = useCallback((): void => {
    const owner = caretOwnerRef.current;
    if (owner === null) return;
    caretOwnerRef.current = null;
    caretWindowBlurCleanupRef.current?.();
    caretWindowBlurCleanupRef.current = null;
    const entry = peekInstance(terminalId);
    const container = entry?.container ?? owner.container;
    const active = owner.ownerDocument.activeElement;
    const HTMLElementCtor = owner.ownerDocument.defaultView?.HTMLElement;
    const activeElement =
      HTMLElementCtor !== undefined && active instanceof HTMLElementCtor
        ? active
        : null;
    // Something else already took the caret — most often a sibling pane the
    // user just clicked, whose xterm focuses on mousedown BEFORE this pane
    // re-renders as deselected. Yanking it back to our predecessor would
    // undo the click the user just made.
    const caretAlreadyMovedOn =
      activeElement !== null &&
      activeElement !== owner.ownerDocument.body &&
      !(container?.contains(activeElement) ?? false);
    if (caretAlreadyMovedOn) return;
    try {
      entry?.term.blur();
    } catch {
      // ignore — xterm can be mid-mount during lifecycle transitions
    }
    const previous = owner.previous;
    if (previous !== null && previous.isConnected) {
      try {
        previous.focus();
      } catch {
        // ignore — the predecessor may have become unfocusable
      }
    }
  }, [terminalId]);

  const rememberCaretPredecessor = useCallback((): void => {
    const entry = peekInstance(terminalId);
    const ownerDocument =
      entry?.container.ownerDocument ??
      hostRef.current?.ownerDocument ??
      document;
    const active = ownerDocument.activeElement;
    if (caretOwnerRef.current !== null) {
      if (active !== null && (entry?.container.contains(active) ?? false)) {
        return;
      }
      // Focus already moved elsewhere while this pane stayed selected. The
      // next click begins a new ownership interval and must remember that
      // latest predecessor, not the element from the prior visit.
      caretOwnerRef.current = null;
      caretWindowBlurCleanupRef.current?.();
      caretWindowBlurCleanupRef.current = null;
    }
    const HTMLElementCtor = ownerDocument.defaultView?.HTMLElement;
    const activeElement =
      HTMLElementCtor !== undefined && active instanceof HTMLElementCtor
        ? active
        : null;
    const previous =
      activeElement !== null &&
      activeElement !== ownerDocument.body &&
      !(entry?.container.contains(activeElement) ?? false) &&
      !isTerminalTarget(activeElement)
        ? activeElement
        : null;
    caretOwnerRef.current = {
      previous,
      ownerDocument,
      container: entry?.container ?? null,
    };
    const ownerWindow = ownerDocument.defaultView;
    if (ownerWindow !== null) {
      const handleWindowBlur = (): void => {
        releaseCaret();
      };
      ownerWindow.addEventListener('blur', handleWindowBlur);
      caretWindowBlurCleanupRef.current = (): void => {
        ownerWindow.removeEventListener('blur', handleWindowBlur);
      };
    }
  }, [releaseCaret, terminalId]);

  // Re-evaluate the claim when a reveal/spawn request lands after mount.
  const focusRequestRevision = useSyncExternalStore(
    subscribeTerminalFocusRequests,
    getTerminalFocusRequestRevision,
    getTerminalFocusRequestRevision,
  );

  // Claim the caret ONLY for a recorded user gesture. Becoming the active or
  // visible panel is deliberately not enough — that is the leak this
  // replaced. Gestures are invalidated on window blur by the intent module,
  // so a backgrounded app can never produce a claim.
  useEffect(() => {
    if (!focused || !live) return;
    // Resolve the xterm instance BEFORE consuming: consuming first would
    // discard the gesture for good on the (currently unreachable) path where
    // the cached entry is missing, instead of leaving it pending for the
    // next evaluation.
    const entry = entryRef.current ?? peekInstance(terminalId);
    if (!entry) return;
    if (
      !consumeTerminalFocusRequest(terminalId, entry.container.ownerDocument)
    ) {
      return;
    }
    rememberCaretPredecessor();
    try {
      entry.term.focus();
    } catch {
      // ignore — can happen briefly during mount
    }
  }, [
    focused,
    live,
    terminalId,
    focusRequestRevision,
    rememberCaretPredecessor,
  ]);

  // Release when this pane stops being the pane the user SELECTED (workspace
  // or task switch, panel group collapse, sibling pane selected) and on
  // unmount.
  //
  // `live` is deliberately NOT a trigger here. A PTY exiting is not the user
  // choosing a different surface: the pane stays mounted, still selected, and
  // still the thing the user is looking at. Releasing on that edge moved the
  // caret into the predecessor — typically the chat composer, which sends on
  // Enter — just because a shell exited, which is the same "input landed
  // somewhere I did not choose" failure this change exists to remove. A dead
  // pane holding the caret is inert (it accepts no input), and the caret
  // still leaves normally on deselect, window blur, or unmount.
  useEffect(() => {
    if (focused) {
      return (): void => {
        releaseCaret();
      };
    }
    releaseCaret();
    return undefined;
  }, [focused, releaseCaret]);

  // A pane that is not eligible to claim must not leave a pending gesture
  // behind for a later evaluation to redeem. Separate from the release above
  // so that `live` changes drop the claim without moving the caret.
  useEffect(() => {
    if (focused && live) return;
    clearTerminalFocusRequest(terminalId);
  }, [focused, live, terminalId]);

  // Unmount belt-and-braces. The effect above only returns a cleanup on its
  // `focused && live` branch, so a pane that took a mousedown while NOT
  // focused (a split-pane sibling — `TerminalPanelSurface` passes a no-op
  // `onFocus`) would otherwise unmount still holding ownership, leaking the
  // window `blur` listener with a stale `caretOwnerRef`. `releaseCaret` is
  // idempotent, so running it twice on the focused path is a no-op.
  useEffect(
    () => (): void => {
      clearTerminalFocusRequest(terminalId);
      releaseCaret();
    },
    [releaseCaret, terminalId],
  );

  // Capture phase so the predecessor is recorded before xterm's own mousedown
  // handler moves the caret into its textarea.
  //
  // Read-only panes (`!live`) participate too. xterm keeps focusing its helper
  // textarea on mousedown even with `disableStdin`, so an exited terminal that
  // stayed outside this lifecycle would hold the caret across deselect, window
  // blur, and unmount with nothing to hand it back to. When xterm does NOT
  // take focus, `releaseCaret`'s "caret already moved on" guard makes the
  // recorded ownership a harmless no-op.
  const handleMouseDownCapture = (): void => {
    rememberCaretPredecessor();
  };

  const handleMouseDown = (): void => {
    onFocus();
  };

  // Cmd/Ctrl+L while this pane is focused and has a non-empty selection (or
  // any stacked blocks) pushes the selected text into the chat composer.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!addToChatSelectionHelper) return;
    const modifier = e.metaKey || e.ctrlKey;
    if (modifier && (e.key === 'l' || e.key === 'L')) {
      const entry = entryRef.current ?? peekInstance(terminalId);
      const hasBlocks = blockSelectionsRef.current.length > 0;
      if (entry && (hasBlocks || entry.term.getSelection())) {
        e.preventDefault();
        e.stopPropagation();
        dispatchSelectionToChat();
      }
    }
  };

  const handleFileDragEnter = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (
      !pasteDroppedFiles ||
      getPathsForFiles === undefined ||
      !dataTransferHasFiles(event.dataTransfer)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current += 1;
    setIsFileDropActive(true);
  };

  const handleFileDragLeave = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (
      !pasteDroppedFiles ||
      getPathsForFiles === undefined ||
      fileDragDepthRef.current === 0
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) {
      setIsFileDropActive(false);
    }
  };

  const handleFileDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (
      !pasteDroppedFiles ||
      getPathsForFiles === undefined ||
      !dataTransferHasFiles(event.dataTransfer)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = liveRef.current ? 'copy' : 'none';
  };

  const handleFileDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (
      !pasteDroppedFiles ||
      getPathsForFiles === undefined ||
      !dataTransferHasFiles(event.dataTransfer)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setIsFileDropActive(false);

    if (!liveRef.current) {
      return;
    }

    const dataTransfer = event.dataTransfer;
    // Bound to the terminal the files were dropped on.
    const generation = paneGenerationRef.current;
    const entry = entryRef.current ?? peekInstance(terminalId);
    if (!entry) {
      return;
    }
    void resolveDroppedFilePaths(dataTransfer, getPathsForFiles)
      .then((paths) => {
        const pasteText = formatFilePathsForTerminalPaste(paths);
        // While files uploaded, the terminal may have exited, or this pane
        // may show another one or have unmounted.
        if (
          !pasteText ||
          !liveRef.current ||
          entry.term.options.disableStdin ||
          generation !== paneGenerationRef.current
        ) {
          return;
        }

        onFocus();
        rememberCaretPredecessor();
        entry.term.focus();
        notifyTerminalInput(terminalId);
        entry.term.paste(pasteText);
      })
      .catch(() => {
        // Files that could not be read or sent are not pasted.
      });
  };

  return (
    <TerminalViewport
      ref={paneRef}
      {...terminalFind.surfaceProps}
      data-testid="terminal-pane"
      emphasis={isFileDropActive ? 'drop' : focused ? 'focus' : 'none'}
      style={{ backgroundColor: TERMINAL_BG_COLOR }}
      onMouseDownCapture={handleMouseDownCapture}
      onMouseDown={handleMouseDown}
      onKeyDownCapture={handleKeyDown}
      onDragEnterCapture={handleFileDragEnter}
      onDragLeaveCapture={handleFileDragLeave}
      onDragOverCapture={handleFileDragOver}
      onDropCapture={handleFileDrop}
      onContextMenu={
        suppressNativeContextMenu
          ? (event): void => event.preventDefault()
          : undefined
      }
    >
      <div ref={hostRef} className="absolute inset-0" />
      {selectionMenuEnabled &&
        blockOverlays.map((overlay, index) => (
          <div
            key={index}
            className="pointer-events-none absolute left-0 right-0 z-10"
            style={{
              top: overlay.top,
              height: overlay.height,
              backgroundColor: 'rgba(120, 168, 120, 0.22)',
            }}
          />
        ))}
      {selectionMenuEnabled && selectionPill !== null && (
        <TerminalSelectionMenu
          top={selectionPill.top}
          left={selectionPill.left}
          onCopy={copySelectionToClipboard}
          onAddToChat={addToChatAvailable ? dispatchSelectionToChat : undefined}
        />
      )}
      {readOnlyMessage !== null && (
        <div className="pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center">
          <TerminalReadOnlyNotice>
            <span>{readOnlyMessage}</span>
            {onRestart && (
              <Button
                size="compact"
                data-testid="terminal-restart-button"
                onClick={onRestart}
                disabled={restarting}
              >
                Restart terminal
              </Button>
            )}
          </TerminalReadOnlyNotice>
        </div>
      )}
    </TerminalViewport>
  );
}

export const TerminalPane = memo(TerminalPaneImpl);
