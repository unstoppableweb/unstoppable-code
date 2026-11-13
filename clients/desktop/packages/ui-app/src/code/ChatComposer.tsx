'use client';

import { useSuggestionsClaimApi } from '../suggestions/SuggestionsProvider';

import {
  Button,
  ComposerTipArbiterProvider,
} from '@canopy/ui-shared/components';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { usePlanModeSuggestion } from './composer/usePlanModeSuggestion';
import { usePlanModeHintStore } from './composer/PlanModeHintContext';
import { PlanModeHint } from './composer/PlanModeHint';
import { useComposerHintActivity } from './composer/useComposerHintActivity';
import type { PortalChatThinkingLevel } from '@canopy/protocol/portal';
import {
  normalizeThinkingForUi,
  THINKING_LEVEL_LABELS,
} from '@canopy/protocol/thinking';
import { defaultChatPlaceholder } from '@canopy/ui-shared/lib';
import { resolveComposerThinking } from './composer/composer-helpers';
import {
  ChatComposerToolbar,
  PlanModeIcon,
  type ChatComposerToolbarChipConfig,
  type ChatThinkingProviderHint,
} from '@canopy/ui-shared';
// The `AppIcons` binding: the package barrel's `ThinkingIcon` is the
// legacy two-lobe glyph that transcript thinking blocks still use.
import { ThinkingIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  SlateEditor,
  createChatEditor,
  createEmptyValue,
  serializeEditorValue,
} from '@canopy/ui-rich';

/** The Slate editor value shape (avoids a direct `slate` import). */
type EditorValue = ReturnType<typeof createEmptyValue>;

/**
 * The chat composer: the shared `@canopy/ui-rich` Slate editor plus the
 * send/stop control and the plan-mode / thinking-level chips. Using the shared
 * rich editor (instead of a plain textarea) closes the biggest desktop/web
 * parity gap for the shared ChatPanel: multiline rich input.
 *
 * It owns only its draft value; every action is an injected callback and every
 * setting is a prop, so it is host-agnostic. Send affordances are gated by
 * omission: a read-only host passes no `onSend`, disabling the control. Its
 * hosts supply no command catalog or file search, so it has no `/` or `@`
 * menu; the composers that do (desktop `ChatInput`, the web Portal) open the
 * shared `ComposerMenu`.
 */
export interface ChatComposerProps {
  /** Send the drafted text. Omit to disable sending (read-only host). */
  readonly onSend?: (text: string) => void | Promise<void>;
  /** Stop the in-flight turn. Shown in place of Send while `isStreaming`. */
  readonly onStop?: () => void;
  readonly isStreaming?: boolean;
  readonly planMode?: boolean;
  readonly onTogglePlanMode?: () => void;
  readonly onEnablePlanMode?: () => boolean | Promise<boolean>;
  readonly draftKey?: string;
  readonly planAvailable?: boolean;
  readonly thinkingLevel?: PortalChatThinkingLevel;
  readonly onCycleThinking?: () => void;
  /**
   * Provider type for the thinking-level display clamp: Codex has no `max`
   * level, so a persisted `max` (e.g. after a provider switch) displays as
   * `xhigh` — mirrors the portal composer and the desktop cycler.
   */
  readonly providerType?: ChatThinkingProviderHint;
  readonly placeholder?: string;
  /** Fully disable the composer (e.g. while the thread is loading). */
  readonly disabled?: boolean;
  /** Take typing that starts outside the composer; for a page's main chat. */
  readonly typeToFocus?: boolean;
  /** Host content above the editor (pending attachments). */
  readonly aboveEditor?: ReactNode;
  /** Toolbar controls a host composer adds; see `ChatComposerToolbar`. */
  readonly leadingSlot?: ReactNode;
  readonly modelSlot?: ReactNode;
  readonly pluginsSlot?: ReactNode;
  /** Keeps Send off while the editor stays usable (an upload in flight). */
  readonly sendBlocked?: boolean;
  /**
   * `shell`: a host draws the box (`ChatComposerShell`), so the composer
   * drops its own divider. Defaults to `divider`.
   */
  readonly chrome?: 'divider' | 'shell';
  /**
   * Puts the sent draft back when `onSend` rejects, ahead of anything typed
   * since, so a refused send never loses the person's text.
   */
  readonly restoreDraftOnReject?: boolean;
}

// The editable owns the composer's min/max height, overflow, and padding, so
// the SlateEditor container is kept to click-to-focus only — passing an
// explicit containerClassName suppresses DEFAULT_CONTAINER_CLASS_NAME, whose
// min-h-26 + px-4 would otherwise dominate the height and double the pad.
const CONTAINER_CLASS = 'cursor-text';
const EDITABLE_CLASS =
  'min-h-11 max-h-64 overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words bg-transparent px-1 py-1 text-s pointer-coarse:text-m leading-5 fg-primary outline-none placeholder:fg-secondary';

// Active chip treatments mirror the semantic warning tokens used by the
// portal composer, with the rainbow gradient reserved for `max`. The portal's
// `BrainIcon active` glyph and trailing `ThinkingDots` remain local to
// chat-input.tsx; promote them into ui-shared if this composer gains a host.
// The rainbow runs through the theme's own hue ramps at 35%, so it follows
// the theme and colour mode like every other surface.
const MAX_THINKING_RAINBOW_HUES = [
  'red',
  'orange',
  'green',
  'cyan',
  'blue',
  'purple',
] as const;
const MAX_THINKING_ACTIVE_STYLE: CSSProperties = {
  backgroundImage: `linear-gradient(90deg, ${MAX_THINKING_RAINBOW_HUES.map(
    (hue) =>
      `color-mix(in oklab, var(--primitive-${hue}-500) 35%, transparent)`,
  ).join(', ')})`,
  color: 'var(--fg-warning)',
};

export function ChatComposer(props: ChatComposerProps): JSX.Element {
  return (
    <ComposerTipArbiterProvider>
      <ChatComposerContent {...props} />
    </ComposerTipArbiterProvider>
  );
}

function ChatComposerContent({
  onSend,
  onStop,
  isStreaming = false,
  planMode = false,
  onTogglePlanMode,
  onEnablePlanMode,
  draftKey = 'chat',
  planAvailable = false,
  thinkingLevel,
  onCycleThinking,
  providerType,
  placeholder,
  disabled = false,
  typeToFocus = false,
  aboveEditor,
  leadingSlot,
  modelSlot,
  pluginsSlot,
  sendBlocked = false,
  chrome = 'divider',
  restoreDraftOnReject = false,
}: ChatComposerProps): JSX.Element {
  // Remounting the editor (bumping the key + recreating the instance) is the
  // reliable way to clear an uncontrolled Slate editor after a send.
  const [editorKey, setEditorKey] = useState(0);
  // `editorKey` is an intentional dep: bumping it on send is what recreates the
  // editor instance so the remounted SlateEditor starts from an empty draft.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const editor = useMemo(() => createChatEditor(), [editorKey]);
  const [value, setValue] = useState<EditorValue>(() => createEmptyValue());
  // A ref mirrors the value so `send` reads the freshest draft without taking
  // `value` as a dependency (which would recreate the send/keydown callbacks
  // on every keystroke).
  const valueRef = useRef<EditorValue>(value);

  // One placeholder table for every composer: this used to keep its own copy
  // whose bare fallback read `Send a message…` while both hosts said
  // `Send a message` (web chat parity, slice 3). The table's phone forms stay
  // unreached here on purpose — this composer has no width awareness, and a
  // host that needs them passes `placeholder` itself.
  const resolvedPlaceholder =
    placeholder ?? defaultChatPlaceholder(false, false);

  const handleChange = useCallback((next: EditorValue): void => {
    valueRef.current = next;
    setValue(next);
  }, []);

  const send = useCallback((): void => {
    const trimmed = serializeEditorValue(valueRef.current).text.trim();
    if (
      trimmed.length === 0 ||
      onSend === undefined ||
      disabled ||
      sendBlocked
    ) {
      return;
    }
    const draft = valueRef.current;
    const sent = onSend(trimmed);
    if (sent !== undefined)
      void sent.catch(() => {
        if (!restoreDraftOnReject) return;
        const typed = valueRef.current;
        const restored =
          serializeEditorValue(typed).text.trim().length === 0
            ? draft
            : [...draft, ...typed];
        valueRef.current = restored;
        setValue(restored);
        setEditorKey((key) => key + 1);
      });
    const empty = createEmptyValue();
    valueRef.current = empty;
    setValue(empty);
    setEditorKey((key) => key + 1);
  }, [onSend, disabled, sendBlocked, restoreDraftOnReject]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      // A disabled composer accepts no input at all — the editor is also
      // rendered read-only below, this guards the send/typeahead key paths.
      if (disabled) {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    },
    [disabled, send],
  );

  const draftText = useMemo(
    () => serializeEditorValue(value).text.trim(),
    [value],
  );
  const hintRootRef = useRef<HTMLDivElement>(null);
  const hintActivity = useComposerHintActivity(
    hintRootRef,
    !disabled && onSend !== undefined,
  );
  const hint = usePlanModeSuggestion({
    suggestionsClaimApi: useSuggestionsClaimApi(),
    text: draftText,
    draftKey: `${draftKey}:${editorKey}`,
    activationKey: providerType,
    planMode,
    planAvailable: planAvailable && onEnablePlanMode !== undefined,
    planReadOnly: false,
    pipelineMode: false,
    ...hintActivity,
    store: usePlanModeHintStore(),
    onEnablePlanMode: onEnablePlanMode ?? ((): boolean => false),
    focusComposer: () =>
      hintRootRef.current
        ?.querySelector<HTMLElement>('[contenteditable="true"]')
        ?.focus(),
  });
  const canSend =
    draftText.length > 0 && onSend !== undefined && !disabled && !sendBlocked;

  // `resolveComposerThinking` owns the provider fallback both hosts use (Codex
  // shows a stored `max` as `xhigh`), and the label comes from the shared
  // table. The local versions capitalized the level by hand, which had no
  // entry for `low` and would have rendered it as a tier the UI does not have.
  const displayThinkingLevel =
    thinkingLevel === undefined
      ? undefined
      : resolveComposerThinking({
          current: normalizeThinkingForUi(thinkingLevel),
          executionHarness: providerType,
        }).display;
  const thinkingLabel =
    displayThinkingLevel === undefined || displayThinkingLevel === 'off'
      ? undefined
      : THINKING_LEVEL_LABELS[displayThinkingLevel];

  // Chips stay gated by omission: a host that passes no toggle/cycle handler
  // renders no chip at all (read-only or settings-less hosts).
  const planChip: ChatComposerToolbarChipConfig | undefined = onTogglePlanMode
    ? {
        onClick: onTogglePlanMode,
        disabled,
        active: planMode,
        ariaPressed: planMode,
        activeTone: 'warning',
        title: planMode ? 'Disable plan mode' : 'Enable plan mode',
        ariaLabel: 'Toggle plan mode',
        icon: <PlanModeIcon size="sm" active={planMode} />,
        label: planMode ? 'Plan' : undefined,
        dataTestId: 'chat-composer-plan',
      }
    : undefined;
  const thinkingChip: ChatComposerToolbarChipConfig | undefined =
    displayThinkingLevel !== undefined && onCycleThinking
      ? {
          onClick: onCycleThinking,
          disabled,
          active: displayThinkingLevel !== 'off',
          activeTone: displayThinkingLevel === 'max' ? 'default' : 'warning',
          activeStyle:
            displayThinkingLevel === 'max'
              ? MAX_THINKING_ACTIVE_STYLE
              : undefined,
          title: 'Effort',
          ariaLabel: 'Cycle thinking level',
          icon: <ThinkingIcon />,
          label: thinkingLabel,
          dataTestId: 'chat-composer-thinking',
        }
      : undefined;

  return (
    <div
      ref={hintRootRef}
      className={
        chrome === 'shell'
          ? 'p-2 flex flex-col gap-1'
          : 'border-t p-2 flex flex-col gap-1'
      }
      data-testid="chat-composer"
    >
      {/* The composer's tip, as every host draws it. This plain box has no
          elevated surface for a top drawer to tuck under, so the tip's row
          sits on it directly. */}
      {hint.visible ? (
        <div className="">
          <PlanModeHint hint={hint} />
        </div>
      ) : null}

      {aboveEditor}

      <div className="relative">
        <SlateEditor
          key={editorKey}
          editor={editor}
          value={value}
          placeholder={resolvedPlaceholder}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          readOnly={disabled}
          containerClassName={CONTAINER_CLASS}
          editableClassName={EDITABLE_CLASS}
          dataTestId="chat-composer-input"
          typeToFocus={typeToFocus}
        />
      </div>

      <div className="">
        <ChatComposerToolbar
          leadingSlot={leadingSlot}
          modelSlot={modelSlot}
          pluginsSlot={pluginsSlot}
          planMode={planChip}
          thinking={thinkingChip}
          trailingSlot={
            isStreaming ? (
              <Button
                variant="ghost-destructive"
                size="compact"
                onClick={onStop}
                disabled={onStop === undefined}
                data-testid="chat-composer-stop"
              >
                Stop
              </Button>
            ) : (
              <Button
                variant="primary"
                size="compact"
                onClick={send}
                disabled={!canSend}
                data-testid="chat-composer-send"
              >
                Send
              </Button>
            )
          }
        />
      </div>
    </div>
  );
}
