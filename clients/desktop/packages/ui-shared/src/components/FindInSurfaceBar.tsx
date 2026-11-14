'use client';

import { useEffect, useId, type JSX, type RefObject } from 'react';
import { PaneSheet } from './Sheet';
import {
  ChangeDiagramIcon,
  ChatIcon,
  FileIcon,
  GlobeIcon,
  PlanModeIcon,
  TerminalIcon,
} from '../icons/AppIcons';
import { REPLAY_MASK_CLASS } from '../lib/replay-privacy';
import { HeaderActionButton } from './HeaderActionButton';
import { SearchBar } from './SearchBar';
import { ErrorBanner } from './StatusBlocks';

/** Which focused surface the floating find bar searches. */
export type FindSurfaceMode =
  | 'chat'
  | 'browser'
  | 'file'
  | 'plan'
  | 'diagram'
  | 'terminal';

/** Exact input placeholder per mode (CAN-3048). */
export const FIND_SURFACE_PLACEHOLDERS: Readonly<
  Record<FindSurfaceMode, string>
> = {
  chat: 'Search the chat history.',
  browser: 'Search the browser tab.',
  file: 'Search the file.',
  plan: 'Search the plan.',
  diagram: 'Search the diagram.',
  terminal: 'Search the terminal.',
};

const MODE_LABELS: Readonly<Record<FindSurfaceMode, string>> = {
  chat: 'Search chat',
  browser: 'Search browser tab',
  file: 'Search file',
  plan: 'Search plan',
  diagram: 'Search diagram',
  terminal: 'Search terminal',
};

/** Noun for one surface of a mode, for the numbered toggles' tooltips. */
const SCOPE_LABELS: Readonly<Record<FindSurfaceMode, string>> = {
  chat: 'Chat',
  browser: 'Browser tab',
  file: 'File',
  plan: 'Plan',
  diagram: 'Diagram',
  terminal: 'Terminal',
};

const MODE_ORDER: readonly FindSurfaceMode[] = [
  'chat',
  'browser',
  'file',
  'plan',
  'diagram',
  'terminal',
];

const MODE_GLYPHS: Readonly<Record<FindSurfaceMode, JSX.Element>> = {
  chat: <ChatIcon size="sm" ariaHidden />,
  browser: <GlobeIcon size="sm" ariaHidden />,
  file: <FileIcon size="sm" ariaHidden />,
  plan: <PlanModeIcon size="sm" ariaHidden />,
  diagram: <ChangeDiagramIcon size="sm" ariaHidden />,
  terminal: <TerminalIcon size="sm" ariaHidden />,
};

export interface FindInSurfaceBarError {
  message: string;
  onRetry?: () => void;
}

/** One searchable surface of a mode, for the mode's scope menu. */
export interface FindScopeOption {
  key: string;
  title: string;
}

export interface FindInSurfaceBarProps {
  mode: FindSurfaceMode;
  /**
   * Modes that currently have a searchable surface. The mode row hides when
   * there is one mode with at most one surface.
   */
  availableModes: readonly FindSurfaceMode[];
  /**
   * The surfaces of each mode. A mode with two or more (two browser panels)
   * renders one numbered toggle per surface instead of a single icon.
   */
  scopes?: Partial<Record<FindSurfaceMode, readonly FindScopeOption[]>>;
  /** Key of the surface the bar is searching, for the scope menu's check. */
  activeScopeKey?: string;
  onModeChange: (mode: FindSurfaceMode, scopeKey?: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  currentIndex: number;
  totalCount: number;
  error?: FindInSurfaceBarError | null;
  onNext: () => void;
  onPrevious: () => void;
  onClose: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Bumped by the host to refocus the input on a repeated shortcut. */
  focusNonce: number;
  /** Document body to render into; defaults to `document.body`. */
  portalContainer?: HTMLElement;
}

/**
 * Floating, non-modal find surface for the focused chat, browser tab,
 * previewed file, plan document, diagram, or terminal. It does not trap
 * focus; Escape inside it closes it.
 */
/**
 * One toggle per surface of a mode with several (two Browser panels): the
 * mode's icon with its ordinal, so identical icons read as a numbered set,
 * and a tooltip naming the target ("Browser tab 2: docs page").
 */
function ScopeToggle({
  mode,
  index,
  option,
  active,
  onPick,
}: {
  mode: FindSurfaceMode;
  index: number;
  option: FindScopeOption;
  active: boolean;
  onPick: (scopeKey: string) => void;
}): JSX.Element {
  const labelId = useId();
  // Chat, plan, and terminal titles are user-authored (a plan diagram's
  // title carries its plan's; a terminal can be renamed). Session replay
  // masks text but records attributes, so such a toggle takes its name from
  // a hidden, masked label instead of an `aria-label` (as its tooltip masks
  // the title text).
  const masked =
    mode === 'chat' ||
    mode === 'plan' ||
    mode === 'diagram' ||
    mode === 'terminal';
  const name = `${MODE_LABELS[mode]} ${index}: `;
  return (
    <>
      {masked && (
        <span id={labelId} hidden>
          {name}
          <span className={REPLAY_MASK_CLASS}>{option.title}</span>
        </span>
      )}
      <HeaderActionButton
        tone="neutral"
        stateStyle="toolbar"
        {...(masked
          ? { 'aria-labelledby': labelId }
          : { 'aria-label': `${name}${option.title}` })}
        tooltipLabel={
          <>
            {SCOPE_LABELS[mode]} {index}:{' '}
            <span className={masked ? REPLAY_MASK_CLASS : undefined}>
              {option.title}
            </span>
          </>
        }
        aria-pressed={active}
        data-testid={`surface-find-scope-${mode}-${option.key}`}
        onClick={(): void => onPick(option.key)}
      >
        {MODE_GLYPHS[mode]}
        <span className="text-xs tabular-nums">{index}</span>
      </HeaderActionButton>
    </>
  );
}

export function FindInSurfaceBar({
  mode,
  availableModes,
  scopes,
  activeScopeKey,
  onModeChange,
  query,
  onQueryChange,
  currentIndex,
  totalCount,
  error,
  onNext,
  onPrevious,
  onClose,
  inputRef,
  focusNonce,
  portalContainer,
}: FindInSurfaceBarProps): JSX.Element {
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [mode, focusNonce, inputRef]);

  const modes = MODE_ORDER.filter((entry) => availableModes.includes(entry));
  const scopesFor = (entry: FindSurfaceMode): readonly FindScopeOption[] =>
    scopes?.[entry] ?? [];
  const showModeRow =
    modes.length > 1 || modes.some((entry) => scopesFor(entry).length > 1);
  const placeholder = FIND_SURFACE_PLACEHOLDERS[mode];

  // The shared window sheet: fixed, centred under the window's top edge,
  // portaled, on the menu surface. It never takes focus from the field.
  return (
    <PaneSheet
      placement="window-top"
      padding="toolbar"
      portalContainer={portalContainer}
      role="search"
      aria-label={placeholder}
      data-testid="surface-find-bar"
      data-find-mode={mode}
      // Browser mode searches the live page; never swap it for a still frame.
      data-canopy-browser-native-overlay="false"
      // The input's SearchBar already closes on Escape (and prevents the
      // default); this catches Escape from the mode, step, and close buttons.
      onKeyDown={(event): void => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          onClose();
        }
      }}
    >
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1">
          {showModeRow ? (
            <div className="flex shrink-0 flex-wrap items-center gap-0.5">
              {modes.map((entry) =>
                scopesFor(entry).length > 1 ? (
                  scopesFor(entry).map((option, position) => (
                    <ScopeToggle
                      key={`${entry}:${option.key}`}
                      mode={entry}
                      index={position + 1}
                      option={option}
                      active={entry === mode && option.key === activeScopeKey}
                      onPick={(scopeKey): void => onModeChange(entry, scopeKey)}
                    />
                  ))
                ) : (
                  <HeaderActionButton
                    key={entry}
                    iconOnly
                    tone="neutral"
                    stateStyle="toolbar"
                    aria-label={MODE_LABELS[entry]}
                    aria-pressed={entry === mode}
                    data-testid={`surface-find-mode-${entry}`}
                    onClick={() => onModeChange(entry)}
                  >
                    {MODE_GLYPHS[entry]}
                  </HeaderActionButton>
                ),
              )}
            </div>
          ) : null}
          <SearchBar
            className="min-w-56 flex-1"
            query={query}
            onQueryChange={onQueryChange}
            currentIndex={currentIndex}
            totalCount={totalCount}
            onNext={onNext}
            onPrevious={onPrevious}
            onClose={onClose}
            inputRef={inputRef}
            label={placeholder}
            placeholder={placeholder}
          />
        </div>
        {error ? (
          <ErrorBanner
            errorSource="surface-find-error"
            className="mx-1 mb-1"
            error={error.message}
            onRetry={error.onRetry}
            testId="surface-find-error"
          />
        ) : null}
      </div>
    </PaneSheet>
  );
}
