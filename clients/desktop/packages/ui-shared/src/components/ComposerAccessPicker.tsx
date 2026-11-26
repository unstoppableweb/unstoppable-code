'use client';
import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import {
  DropdownMenuItem,
  DropdownMenuItemIcon,
  type DropdownMenuItemIconTone,
} from '../primitives/DropdownMenu';
import {
  FloatingMenu,
  COMPOSER_ROW_MENU_GAP,
} from '../primitives/FloatingMenu';
import { FoldReveal } from './FoldReveal';
import { PickerTrigger, PickerTriggerChevron } from '../primitives/PickerMenu';
import { Inline } from '../primitives/Stack';
import { Tooltip } from '../primitives/Tooltip';
import { CheckIcon, type AppIcon } from '../icons/AppIcons';

export interface ComposerAccessOption<Value extends string> {
  value: Value;
  label: string;
  description: string;
  icon: AppIcon;
  tone: DropdownMenuItemIconTone;
  className?: string;
}

export interface ComposerAccessPickerProps<Value extends string> {
  options: readonly ComposerAccessOption<Value>[];
  mode: Value;
  onChange: (mode: Value) => void;
  /**
   * Renders no trigger and anchors the menu elsewhere. Used when the toolbar
   * has compressed this control away and the "+" menu drives it instead, so
   * approvals stay reachable at the narrowest widths.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Increment to open the menu imperatively while triggerless. */
  openSignal?: number;
  /**
   * Where focus goes when the menu closes. Required alongside
   * {@link anchorRef}: that anchor is an `aria-hidden` span with no tabindex,
   * so the default `anchorRef.current?.focus()` is a no-op and focus would
   * fall to `<body>` — Tab restarts at the top of the document. The other
   * surfaces on that same anchor all pass the "+" trigger here.
   */
  returnFocusRef?: RefObject<HTMLElement | null>;
  disabled?: boolean;
  /** Hides the label text, showing only the trigger icon (mirrors the other compact rail controls). */
  compact?: boolean;
  /**
   * What a compact trigger keeps. `icon` (the Home rail) shows the glyph
   * alone; `label` (the chat composer's settings row) keeps the mode's name
   * and chevron and drops the glyph.
   */
  compactStyle?: 'icon' | 'label';
  /**
   * Leaves the mode's glyph off the trigger at every width: the label and
   * chevron alone. The menu rows keep their glyphs.
   */
  hideTriggerIcon?: boolean;
  /**
   * Lines the menu's left edge up with this element (the composer box)
   * while it still opens above the trigger.
   */
  menuAlignRef?: RefObject<HTMLElement | null>;
  /** Which edge of `menuAlignRef` the menu lines up with; `left` by default. */
  menuAlignEdge?: 'left' | 'right';
  /** Leaves the trigger's chevron off: the mode's name alone. */
  hideTriggerChevron?: boolean;
}

const TOOLTIP_LABEL = 'Change permissions';
const COMPACT_TOOLTIP_PREFIX = 'Permissions';
const MENU_ID = 'approval-mode-picker-menu';

export function ComposerAccessPicker<Value extends string>({
  options,
  mode,
  onChange,
  disabled = false,
  compact = false,
  compactStyle = 'icon',
  hideTriggerIcon = false,
  anchorRef,
  menuAlignRef,
  menuAlignEdge = 'left',
  hideTriggerChevron = false,
  openSignal,
  returnFocusRef,
}: ComposerAccessPickerProps<Value>): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const triggerless = anchorRef !== undefined;

  // Imperative open for the triggerless case. The mount-time value is
  // ignored so the menu never springs open on first render.
  const lastOpenSignalRef = useRef(openSignal);
  useEffect(() => {
    if (openSignal === undefined || openSignal === lastOpenSignalRef.current) {
      return;
    }
    lastOpenSignalRef.current = openSignal;
    setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  const selectedOption =
    options.find((option) => option.value === mode) ?? options[0];
  if (!selectedOption) return <></>;
  const label = selectedOption.label;
  const SelectedIcon = selectedOption.icon;

  return (
    <div className="relative shrink-0">
      {/* Suppressed while the menu is open: the tooltip explains the closed
          control, and leaving it mounted over an open menu only occludes it. */}
      {triggerless ? null : (
        <Tooltip
          label={
            compact && compactStyle === 'icon'
              ? `${COMPACT_TOOLTIP_PREFIX}: ${label}`
              : TOOLTIP_LABEL
          }
          delay="long"
          suppressed={open}
        >
          <PickerTrigger
            ref={triggerRef}
            data-testid="approval-mode-picker"
            // No glyph on the left (hidden, or folded away in a tight row):
            // the label takes 2px more leading room.
            textLead={hideTriggerIcon || (compact && compactStyle === 'label')}
            textTrail={
              hideTriggerChevron && (!compact || compactStyle === 'label')
            }
            disabled={disabled}
            onClick={(): void => setOpen((prev) => !prev)}
            className="shrink-0"
            aria-label={`Tool approval mode, current mode ${label}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? MENU_ID : undefined}
          >
            {compact && compactStyle === 'icon' ? (
              <span
                data-testid="approval-mode-icon"
                data-approval-mode={mode}
                className={`inline-flex shrink-0 -translate-y-[var(--border-hairline)] ${selectedOption.className ?? 'fg-secondary'}`}
              >
                <SelectedIcon size="sm" />
              </span>
            ) : (
              // The glyph folds away in a label-style compact row. `pr-1.5`
              // plus the capsule's 4px gap, less the `-mr-1`, leaves 6px
              // between glyph and label (the model picker's icon inset);
              // folded, the margin takes the gap back. The node stays for
              // automation that reads the mode.
              <FoldReveal open={!compact && !hideTriggerIcon} className="-mr-1">
                <span
                  data-testid="approval-mode-icon"
                  data-approval-mode={mode}
                  // Up one device pixel (0.5px on a Retina screen): the hand
                  // and shields read low when box-centered beside the other
                  // status-row glyphs.
                  className={`inline-flex shrink-0 -translate-y-[var(--border-hairline)] pr-1.5 ${selectedOption.className ?? 'fg-secondary'}`}
                >
                  <SelectedIcon size="sm" />
                </span>
              </FoldReveal>
            )}
            {(!compact || compactStyle === 'label') && (
              <>
                {/* Primary ink like the model picker's label; the shared
                    capsule recipe would otherwise paint it secondary. */}
                <span className="fg-primary">{label}</span>
                {hideTriggerChevron ? null : (
                  <PickerTriggerChevron open={open} />
                )}
              </>
            )}
          </PickerTrigger>
        </Tooltip>
      )}

      <FloatingMenu
        id={MENU_ID}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef ?? triggerRef}
        // Aligned to the composer, the menu also clears the trigger by the
        // row's 8px gap, so its bottom edge meets the composer's.
        {...(menuAlignRef
          ? { alignRef: menuAlignRef, gap: COMPOSER_ROW_MENU_GAP }
          : {})}
        returnFocusRef={returnFocusRef}
        placement={menuAlignEdge === 'right' ? 'top-right' : 'top-left'}
        aria-label="Approval mode options"
        data-canopy-browser-native-overlay="true"
        data-testid="approval-mode-menu"
        // A fixed width that fits each one-line subtitle; a longer one wraps (never clipped, at any UI
        // scale) beside the icon and trailing check columns.
        className="w-70"
      >
        {options.map((entry) => {
          const option = entry.value;
          const OptionIcon = entry.icon;
          const selected = option === mode;
          return (
            <DropdownMenuItem
              key={option}
              role="menuitemradio"
              data-testid={`approval-mode-option-${option}`}
              aria-checked={selected}
              onMouseDown={(event): void => {
                event.preventDefault();
              }}
              onClick={(): void => {
                onChange(option);
                setOpen(false);
              }}
              // Two-line row: the label carries its subtitle beneath it, and
              // the coloured shields read as a column beside the copy.
              multiline
            >
              {/* The glyph and its copy keep 12px apart, wider than the
                  row's 8px gap, so the copy reads as a column of its own.
                  The label keeps its text size's own 20px line (a 16px line
                  clipped its descenders against the subtitle). */}
              <Inline gap="item" as="span" className="min-w-0 flex-1">
                <DropdownMenuItemIcon tone={entry.tone}>
                  <OptionIcon
                    data-testid={`approval-mode-option-icon-${option}`}
                    size="sm"
                  />
                </DropdownMenuItemIcon>
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate">{entry.label}</span>
                  <span
                    data-testid={`approval-mode-option-description-${option}`}
                    className="text-pretty whitespace-normal text-xs fg-secondary"
                  >
                    {entry.description}
                  </span>
                </span>
              </Inline>
              {selected && (
                <span
                  aria-hidden="true"
                  data-testid={`approval-mode-option-check-${option}`}
                  className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
                >
                  <CheckIcon size="sm" />
                </span>
              )}
            </DropdownMenuItem>
          );
        })}
      </FloatingMenu>
    </div>
  );
}
