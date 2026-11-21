import { useId, useRef, useState, type JSX } from 'react';
import { FieldError, TextInput } from './Field';
import { Notice, NoticeButton } from './Notice';
import { SegmentedControl } from './SegmentedControl';
import { formatTokenCount } from '../lib/format-usage';

/** `272k`: a window in the composer's lower-case `k`. */
export function formatContextWindowTokens(tokens: number): string {
  return `${String(Math.round(tokens / 1000))}k`;
}

export type CodexContextWindowControlState =
  | {
      kind: 'adjustable';
      /** Distinct preset windows, smallest first. */
      presets: readonly number[];
      /** The configured window the chat asks for. */
      selectedTokens: number;
      /** The chat asks for a value that is not a preset. */
      custom: boolean;
      defaultTokens: number;
      maxTokens: number;
      /** The smallest custom value. */
      floorTokens: number;
      /** Requests with more input are billed at long-context rates. */
      thresholdTokens: number;
      /** The share of the window Codex reports as usable. */
      usablePercent: number;
      /**
       * `api` bills at API rates, `plan` uses ChatGPT plan limits, `unknown`
       * names both.
       */
      billing: 'api' | 'plan' | 'unknown';
      /** The window the chat's thread runs with now; absent before a reply. */
      appliedTokens?: number;
      /** Tokens in the context now, for the reduction check. */
      usedTokens: number;
    }
  | { kind: 'fixed'; tokens: number }
  | { kind: 'unavailable'; reason: string };

export interface CodexContextWindowControlProps {
  state: CodexContextWindowControlState;
  /** A preset or a valid custom window was chosen. */
  onSelect: (tokens: number, source: 'preset' | 'custom') => void;
  disabled?: boolean;
}

/** Codex compacts at this share of the configured window. */
const AUTO_COMPACT_SHARE = 0.9;

type Choice = `${number}` | 'custom';

function presetNote(tokens: number, state: AdjustableState): string | null {
  if (tokens === state.defaultTokens) return "This model's default.";
  if (tokens === state.thresholdTokens) return 'Standard pricing.';
  if (tokens === state.maxTokens) return 'The largest this model allows.';
  return null;
}

type AdjustableState = Extract<
  CodexContextWindowControlState,
  { kind: 'adjustable' }
>;

function AdjustableWindow({
  state,
  onSelect,
  disabled,
}: {
  state: AdjustableState;
  onSelect: CodexContextWindowControlProps['onSelect'];
  disabled: boolean;
}): JSX.Element {
  const errorId = useId();
  const initialChoice = (): Choice =>
    state.custom ? 'custom' : `${state.selectedTokens}`;
  const initialCustomText = (): string =>
    state.custom ? String(Math.round(state.selectedTokens / 1000)) : '';
  const [choice, setChoice] = useState<Choice>(initialChoice);
  const [customText, setCustomText] = useState(initialCustomText);
  const [confirmTokens, setConfirmTokens] = useState<number | null>(null);
  // The error waits for Enter or leaving the field, then follows each edit.
  const [errorShown, setErrorShown] = useState(false);
  const lastCustomCommit = useRef<number | null>(null);
  // A new selection from the host starts the choice over in place, so the
  // focused segment or field stays mounted and keeps focus.
  const selection = `${state.selectedTokens}:${String(state.custom)}`;
  const [seenSelection, setSeenSelection] = useState(selection);
  if (seenSelection !== selection) {
    setSeenSelection(selection);
    setChoice(initialChoice());
    setCustomText(initialCustomText());
    setConfirmTokens(null);
    setErrorShown(false);
  }
  const customTokens = Number(customText.replace(/[^0-9]/g, '')) * 1000;
  const customInvalid =
    choice === 'custom' &&
    customText.trim() !== '' &&
    (customTokens < state.floorTokens || customTokens > state.maxTokens);
  const showError = customInvalid && errorShown;

  const current = state.appliedTokens ?? state.selectedTokens;
  const commitCustom = (): void => {
    if (customText.trim() === '') return;
    if (customInvalid) {
      setErrorShown(true);
      return;
    }
    // Enter then leaving the field would otherwise send the same value twice.
    if (lastCustomCommit.current === customTokens) return;
    lastCustomCommit.current = customTokens;
    commit(customTokens, 'custom');
  };
  const commit = (tokens: number, source: 'preset' | 'custom'): void => {
    // Past Codex's compaction point for the new window, ask first: the next
    // message summarizes earlier ones before it runs.
    if (tokens < current && state.usedTokens >= tokens * AUTO_COMPACT_SHARE) {
      setConfirmTokens(tokens);
      return;
    }
    setConfirmTokens(null);
    onSelect(tokens, source);
  };

  const shownTokens =
    confirmTokens ??
    (choice === 'custom'
      ? customInvalid || customText.trim() === ''
        ? null
        : customTokens
      : Number(choice));
  const threshold = formatContextWindowTokens(state.thresholdTokens);
  const pricingLine =
    state.billing === 'api'
      ? `Above ${threshold}, each request costs 2× for input and 1.5× for output.`
      : state.billing === 'plan'
        ? `Above ${threshold}, each request uses your plan's limits faster.`
        : `Above ${threshold}, each request costs 2× for input and 1.5× for output, or uses a ChatGPT plan's limits faster.`;
  const note =
    shownTokens === null
      ? null
      : [
          choice === 'custom' ? null : presetNote(shownTokens, state),
          `${formatContextWindowTokens(
            Math.floor((shownTokens * state.usablePercent) / 100),
          )} is usable; Codex keeps the rest for its output.`,
          shownTokens > state.thresholdTokens ? pricingLine : null,
          state.appliedTokens !== undefined &&
          Math.abs(state.appliedTokens - state.selectedTokens) >= 1000
            ? 'Applies to your next message.'
            : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' ');

  return (
    <div
      className="flex flex-col gap-2"
      data-testid="codex-context-window-control"
    >
      <span className="text-xs fg-primary">Context window</span>
      <SegmentedControl<Choice>
        value={choice}
        options={[
          ...state.presets.map((tokens) => ({
            value: `${tokens}` as const,
            label: formatContextWindowTokens(tokens),
            dataTestId: `codex-context-window-${tokens}`,
          })),
          {
            value: 'custom' as const,
            label: 'Custom',
            dataTestId: 'codex-context-window-custom',
          },
        ]}
        onChange={(next): void => {
          setChoice(next);
          lastCustomCommit.current = null;
          if (next !== 'custom') commit(Number(next), 'preset');
          else setConfirmTokens(null);
        }}
        label="Context window"
        width="fill"
        disabled={disabled}
        dataTestId="codex-context-window-presets"
      />
      {choice === 'custom' ? (
        <div className="flex flex-col gap-1">
          <TextInput
            density="compact"
            inputMode="numeric"
            aria-label="Custom context window in thousands of tokens"
            aria-invalid={showError}
            {...(showError ? { 'aria-describedby': errorId } : {})}
            value={customText}
            placeholder={`${String(state.floorTokens / 1000)}–${String(state.maxTokens / 1000)}`}
            trailing="k tokens"
            disabled={disabled}
            data-testid="codex-context-window-custom-input"
            onChange={(event): void => {
              setCustomText(event.target.value);
              lastCustomCommit.current = null;
            }}
            onBlur={commitCustom}
            onKeyDown={(event): void => {
              if (event.key === 'Enter') commitCustom();
            }}
          />
          {showError ? (
            <FieldError id={errorId}>
              Use {formatContextWindowTokens(state.floorTokens)} to{' '}
              {formatContextWindowTokens(state.maxTokens)}.
            </FieldError>
          ) : null}
        </div>
      ) : null}
      {confirmTokens !== null ? (
        <Notice
          intent="attention"
          title="Compact this chat first?"
          actionsPlacement="below"
          data-testid="codex-context-window-confirm"
          actions={
            <>
              <NoticeButton
                variant="secondary"
                onClick={(): void => {
                  setConfirmTokens(null);
                  lastCustomCommit.current = null;
                  setChoice(
                    state.custom ? 'custom' : `${state.selectedTokens}`,
                  );
                }}
              >
                Cancel
              </NoticeButton>
              <NoticeButton
                variant="primary"
                onClick={(): void => {
                  const tokens = confirmTokens;
                  setConfirmTokens(null);
                  onSelect(tokens, choice === 'custom' ? 'custom' : 'preset');
                }}
              >
                Reduce window
              </NoticeButton>
            </>
          }
        >
          It uses {formatTokenCount(state.usedTokens)} tokens. To fit{' '}
          {formatContextWindowTokens(confirmTokens)}, earlier messages are
          summarized before your next message.
        </Notice>
      ) : note ? (
        <p
          className="text-xs text-pretty fg-secondary"
          data-testid="codex-context-window-note"
        >
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The Codex context window choice for one chat, as the usage popover shows
 * it. Pure display: the host resolves the model's bounds on the chat's route
 * and stores the choice.
 */
export function CodexContextWindowControl({
  state,
  onSelect,
  disabled = false,
}: CodexContextWindowControlProps): JSX.Element {
  if (state.kind !== 'adjustable') {
    return (
      <div
        className="flex flex-col gap-1"
        data-testid="codex-context-window-control"
      >
        <span className="text-xs fg-primary">Context window</span>
        <p className="text-xs text-pretty fg-secondary">
          {state.kind === 'fixed'
            ? `This model's context window is fixed at ${formatContextWindowTokens(state.tokens)}.`
            : state.reason}
        </p>
      </div>
    );
  }
  // New bounds start the control over; a new selection resets it in place.
  return (
    <AdjustableWindow
      key={state.maxTokens}
      state={state}
      onSelect={onSelect}
      disabled={disabled}
    />
  );
}
