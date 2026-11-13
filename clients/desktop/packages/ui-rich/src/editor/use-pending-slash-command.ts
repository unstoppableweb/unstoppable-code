import { useCallback, useEffect, useRef, useState } from 'react';
import type { SlashCommandOption, SlashCommandPreparation } from '../types';

/**
 * How a selection that had to be prepared ended: its text was inserted,
 * preparing failed, or nothing was inserted because the surface moved on
 * (`isStale`, an aborted `signal`, the gate unmounted) or `insert` declined.
 */
export type SlashCommandSelectionOutcome = 'inserted' | 'failed' | 'stale';

export interface PendingSlashCommandGate {
  /** The selection whose preparation is in flight; drives busy-row UI. */
  pendingCommand: SlashCommandOption | null;
  /**
   * Run one selection through the gate. Only rows with neither
   * `section: 'available'` nor `requiresResolution` insert synchronously,
   * and return `undefined`, as does a selection the gate ignores. A row that
   * must be prepared returns a promise of how it ended, so the surface can
   * show it busy and report a failure. `insert` returns `false` when it
   * inserted nothing (the place it would insert at changed). An aborted
   * `signal` ends the selection at once: it inserts nothing, and the next
   * selection may run while the abandoned preparation finishes.
   */
  selectCommand: (
    cmd: SlashCommandOption,
    insert: (cmd: SlashCommandOption) => boolean | void,
    isStale?: () => boolean,
    signal?: AbortSignal,
  ) => Promise<SlashCommandSelectionOutcome> | undefined;
}

/**
 * Shared enable-before-insert gate for the two slash selection surfaces (the
 * inline `/` typeahead menu and the Commands popup). An `available` row must
 * be enabled on the host before its invocation text may enter the composer,
 * so selection runs `prepare` first and inserts only on success:
 *
 * - ONE selection may be pending per surface at a time; selections made while
 *   pending are ignored (single re-entrancy guard).
 * - `prepare` returning `false`, rejecting, or throwing synchronously means
 *   no insert; the host owns any error surface.
 * - `prepare` returning `{ insertText }` inserts that host text instead of the
 *   row's own. A `requiresResolution` row inserts only valid host text: a
 *   missing gate, `true`, or a malformed result never inserts its fallback.
 * - `isStale` is sampled after `prepare` resolves; a surface whose context
 *   moved on (e.g. the slash trigger was retargeted or dismissed) reports
 *   stale and the insert is dropped.
 */
function preparedCommand(
  cmd: SlashCommandOption,
  ready: unknown,
): SlashCommandOption | null {
  if (
    typeof ready === 'object' &&
    ready !== null &&
    'insertText' in ready &&
    typeof ready.insertText === 'string' &&
    ready.insertText.trim().length > 0
  ) {
    return { ...cmd, insertText: ready.insertText };
  }
  return ready === true && cmd.requiresResolution !== true ? cmd : null;
}

export function usePendingSlashCommand(
  prepare?: (
    cmd: SlashCommandOption,
  ) => SlashCommandPreparation | Promise<SlashCommandPreparation>,
): PendingSlashCommandGate {
  // Token identity (not a boolean) so a stray late resolution can never clear
  // a newer selection's pending state.
  const pendingRef = useRef<symbol | null>(null);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return (): void => {
      mounted.current = false;
      pendingRef.current = null;
    };
  }, []);
  const [pendingCommand, setPendingCommand] =
    useState<SlashCommandOption | null>(null);

  const selectCommand = useCallback(
    (
      cmd: SlashCommandOption,
      insert: (cmd: SlashCommandOption) => boolean | void,
      isStale?: () => boolean,
      signal?: AbortSignal,
    ): Promise<SlashCommandSelectionOutcome> | undefined => {
      if (!mounted.current || pendingRef.current !== null) return undefined;
      if (signal?.aborted) return undefined;
      if (cmd.section !== 'available' && cmd.requiresResolution !== true) {
        insert(cmd);
        return undefined;
      }
      if (prepare === undefined) return undefined;
      const token = Symbol('pending-slash-command');
      pendingRef.current = token;
      setPendingCommand(cmd);
      const release = (): void => {
        if (mounted.current && pendingRef.current === token) {
          pendingRef.current = null;
          setPendingCommand(null);
        }
      };
      // An abandoned selection frees the gate now: a preparation that hangs
      // must not block the next one.
      signal?.addEventListener('abort', release, { once: true });
      return Promise.resolve()
        .then(() => prepare(cmd))
        .catch(() => false)
        .then((ready): SlashCommandSelectionOutcome => {
          if (!mounted.current || pendingRef.current !== token) return 'stale';
          const prepared = preparedCommand(cmd, ready);
          if (!prepared) return 'failed';
          if (isStale?.() ?? false) return 'stale';
          return insert(prepared) === false ? 'stale' : 'inserted';
        })
        .finally(() => {
          signal?.removeEventListener('abort', release);
          release();
        });
    },
    [prepare],
  );

  return { pendingCommand, selectCommand };
}
