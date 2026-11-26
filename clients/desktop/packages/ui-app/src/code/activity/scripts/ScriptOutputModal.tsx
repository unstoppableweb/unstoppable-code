'use client';

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { Button, Tooltip, useAnsiSearch } from '@canopy/ui-shared/components';
import { FindBar } from '@canopy/ui-shared/components/FindBar';
import { MagnifyingGlassIcon } from '@canopy/ui-shared/icons/AppIcons';
import { formatShortcut } from '@canopy/ui-shared/lib/shortcuts';
import {
  RunOutputModal,
  describeRunOutcome,
  type RunOutcome,
  type RunOutputStatus,
} from './RunOutputModal';
import type { ScriptsSectionRun } from './ScriptsSectionBody';

export interface ScriptOutputModalProps {
  readonly run: Pick<
    ScriptsSectionRun,
    | 'label'
    | 'status'
    | 'outputLines'
    | 'exitCode'
    | 'timedOut'
    | 'durationMs'
    | 'startError'
  >;
  readonly onClose: () => void;
  readonly onStop?: () => void;
  readonly devServerSlot?: ReactNode;
}

/** The same searchable script output on Desktop, Remote Control, and Cloud. */
export function ScriptOutputModal({
  run,
  onClose,
  onStop,
  devServerSlot,
}: ScriptOutputModalProps): JSX.Element {
  const isStopping = run.status === 'stopping';
  const isRunning = run.status === 'running' || isStopping;
  const isSuccess = run.status === 'success';
  const search = useAnsiSearch();
  const [searchOpen, setSearchOpen] = useState(false);
  const searchOpenRef = useRef(searchOpen);
  searchOpenRef.current = searchOpen;
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef<HTMLButtonElement>(null);
  const setQueryRef = useRef(search.setQuery);
  setQueryRef.current = search.setQuery;
  // Returned focus would open the toggle's tooltip, which then takes the
  // next Escape; keep it quiet until focus or the pointer leaves the toggle.
  const [toggleTooltipQuiet, setToggleTooltipQuiet] = useState(false);
  // Closing unmounts the field, so focus returns to the toggle rather than
  // falling out of the dialog.
  const closeSearch = (): void => {
    setQueryRef.current('');
    setSearchOpen(false);
    setToggleTooltipQuiet(true);
    searchToggleRef.current?.focus();
  };
  const closeSearchRef = useRef(closeSearch);
  closeSearchRef.current = closeSearch;

  // Cmd+F opens or refocuses search; Escape closes an open search before the
  // dialog. Capture phase, so the modal wins over the page and the dialog.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        event.stopPropagation();
        if (searchOpenRef.current) searchInputRef.current?.focus();
        else setSearchOpen(true);
      } else if (event.key === 'Escape' && searchOpenRef.current) {
        event.preventDefault();
        event.stopPropagation();
        closeSearchRef.current();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return (): void =>
      document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  const isStopped =
    run.status === 'failed' &&
    run.exitCode === null &&
    !run.timedOut &&
    !run.startError;
  const outcome: RunOutcome = isStopping
    ? { kind: 'stopping' }
    : isRunning
      ? { kind: 'running' }
      : isSuccess
        ? { kind: 'succeeded', durationMs: run.durationMs }
        : run.startError
          ? { kind: 'start-failed' }
          : run.timedOut
            ? { kind: 'timed-out', durationMs: run.durationMs }
            : run.exitCode === null
              ? { kind: 'stopped', durationMs: run.durationMs }
              : { kind: 'failed', durationMs: run.durationMs };
  const status: RunOutputStatus = isRunning
    ? 'active'
    : isSuccess
      ? 'success'
      : isStopped
        ? 'paused'
        : 'failed';

  return (
    <RunOutputModal
      title={run.label}
      titleId="script-output-modal-title"
      summary={describeRunOutcome(outcome)}
      status={status}
      outputLines={run.outputLines}
      isRunning={isRunning}
      onClose={onClose}
      onStop={onStop}
      stopLabel={isStopping ? 'Stopping…' : 'Stop'}
      stopDisabled={isStopping}
      headerActions={
        run.outputLines.length > 0 && (
          <Tooltip
            label="Search output"
            shortcut={formatShortcut('find-in-surface')}
            suppressed={toggleTooltipQuiet}
          >
            <Button
              ref={searchToggleRef}
              iconOnly
              variant="ghost"
              size="sm"
              aria-label="Search output"
              aria-pressed={searchOpen}
              onBlur={(): void => setToggleTooltipQuiet(false)}
              onPointerLeave={(): void => setToggleTooltipQuiet(false)}
              onClick={(): void =>
                searchOpen ? closeSearch() : setSearchOpen(true)
              }
            >
              <MagnifyingGlassIcon />
            </Button>
          </Tooltip>
        )
      }
      searchSlot={
        searchOpen ? (
          <FindBar
            query={search.query}
            onQueryChange={search.setQuery}
            currentIndex={search.currentIndex}
            totalCount={search.totalCount}
            onNext={search.goToNext}
            onPrevious={search.goToPrevious}
            inputRef={searchInputRef}
            autoFocus
          />
        ) : undefined
      }
      devServerSlot={devServerSlot}
      emptyText="No output"
      ansiSearchQuery={search.ansiSearchQuery}
      ansiActiveMatchIndex={search.ansiActiveMatchIndex}
      ansiOnMatchCountChange={search.ansiOnMatchCountChange}
    />
  );
}
