import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  THINKING_LEVEL_LABELS,
  isThinkingLevel,
  normalizeThinkingForUi,
  thinkingDotCount,
  type ThinkingLevel,
} from '@canopy/protocol/thinking';
import { CheckIcon, FastModeIcon, FastModeOnIcon } from '../icons/AppIcons';
import { ThinkingLevelIcon } from '../icons/ThinkingLevelIcon';
import {
  thinkingLevelLabel,
  thinkingControlLevels,
  advanceThinkingControlLevel,
} from '../lib/chat-thinking';
import { CAPSULE_TOUCH_FLOOR_CLASS } from './ChatComposerToolbar';
import { DropdownMenuItem } from './DropdownMenu';
import { COMPOSER_ROW_MENU_GAP, FloatingMenu } from './FloatingMenu';
import { FoldReveal } from './FoldReveal';
import { PickerTrigger, PickerTriggerChevron } from './PickerMenu';
import { IconToggleButton } from './IconToggleButton';
import { Slider } from './Slider';
import { Tooltip } from './Tooltip';
import { SettingsSelect, type SettingsSelectOption } from './SettingsSelect';

export interface ThinkingLevelControlProps {
  value: ThinkingLevel | undefined;
  supportedLevels: readonly ThinkingLevel[];
  onChange: (next: ThinkingLevel | undefined) => void;
  /**
   * `select` variant only: fill the parent's width, so the thinking dropdown
   * lines up with the ones in neighboring rows.
   */
  selectFill?: boolean;
  variant?: 'cycle' | 'capsule' | 'select';
  /**
   * Hide the effort label while keeping the icon, dots, and capsule geometry.
   * Space-constrained composer rails pass this as they narrow.
   */
  compact?: boolean;
  disabled?: boolean;
  allowWorkspaceDefault?: boolean;
  testId?: string;
  /** Override the cycle/capsule button's default accessible label. */
  ariaLabel?: string;
  /** Preserve canonical `low` for editor surfaces that historically exposed it. */
  includeLow?: boolean;
}

interface ThinkingLevelProviderHintProps {
  providerHint: string | undefined;
  children: ReactNode;
}

const ThinkingLevelProviderHintContext = createContext<string | undefined>(
  undefined,
);

/**
 * Supplies the host's provider discriminator without widening the shared
 * control's model-only props contract. The legacy/default branch uses the
 * Claude dot table; Codex hosts pass `providerHint="codex"`.
 */
export function ThinkingLevelProviderHint({
  providerHint,
  children,
}: ThinkingLevelProviderHintProps): JSX.Element {
  return (
    <ThinkingLevelProviderHintContext.Provider value={providerHint}>
      {children}
    </ThinkingLevelProviderHintContext.Provider>
  );
}

const WORKSPACE_DEFAULT_LABEL = 'Default';
const TOOLTIP_LABEL = 'Effort';
const FAST_MODE_DESCRIPTION = 'Faster replies, 2x usage';
const ULTRA_FAST_DESCRIPTION = 'Fastest replies, more usage';

function ThinkingDots({
  level,
  supportedLevels,
  providerHint,
  includeLow,
}: {
  level: ThinkingLevel;
  supportedLevels: readonly ThinkingLevel[];
  providerHint: string | undefined;
  includeLow: boolean;
}): JSX.Element {
  const active =
    includeLow && level === 'low'
      ? 0
      : thinkingDotCount(level, supportedLevels, providerHint);

  return (
    <span
      className="flex shrink-0 flex-col items-center gap-0.5 fg-secondary"
      aria-hidden="true"
    >
      {[3, 2, 1].map((dot) => (
        <span
          key={dot}
          className={`block h-0.5 w-0.5 rounded-full ${
            dot <= active ? 'bg-current' : 'bg-current opacity-20'
          }`}
        />
      ))}
    </span>
  );
}

export function ThinkingLevelControl(
  props: ThinkingLevelControlProps,
): JSX.Element {
  const {
    value,
    supportedLevels,
    variant = 'cycle',
    selectFill = false,
    compact = false,
    disabled = false,
    allowWorkspaceDefault = false,
    includeLow = false,
    testId,
    ariaLabel,
    onChange,
  } = props;
  const providerHint = useContext(ThinkingLevelProviderHintContext);
  const supportedUiLevels = thinkingControlLevels(supportedLevels, includeLow);
  const normalizedValue =
    value === undefined || (value === 'low' && includeLow)
      ? value
      : normalizeThinkingForUi(value);
  const labelText = thinkingLevelLabel(value, includeLow);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const handleAdvance = useCallback((): void => {
    if (disabled) return;
    const firstLevel = supportedUiLevels[0];
    const current = valueRef.current;
    if (current === undefined) {
      valueRef.current = firstLevel;
      onChange(firstLevel);
      return;
    }

    const next = advanceThinkingControlLevel(
      current,
      supportedUiLevels,
      includeLow,
    );
    if (
      allowWorkspaceDefault &&
      firstLevel !== undefined &&
      next === firstLevel
    ) {
      valueRef.current = undefined;
      onChange(undefined);
      return;
    }
    valueRef.current = next;
    onChange(next);
  }, [
    allowWorkspaceDefault,
    disabled,
    includeLow,
    onChange,
    supportedUiLevels,
  ]);

  if (variant === 'select') {
    // The shared Settings dropdown, so the effort menu matches the model
    // menu beside it.
    const workspaceDefaultOption: readonly SettingsSelectOption[] =
      allowWorkspaceDefault
        ? [{ value: '', label: WORKSPACE_DEFAULT_LABEL }]
        : [];
    return (
      <SettingsSelect
        width={selectFill ? 'fill' : 'fit'}
        value={normalizedValue ?? ''}
        disabled={disabled}
        onValueChange={(next): void => {
          if (allowWorkspaceDefault && next === '') {
            onChange(undefined);
          } else if (isThinkingLevel(next)) {
            onChange(next);
          }
        }}
        aria-label="Thinking level"
        data-testid={testId}
        options={[
          ...workspaceDefaultOption,
          ...supportedUiLevels.map((level) => ({
            value: level,
            label: level === 'low' ? 'Low' : THINKING_LEVEL_LABELS[level],
          })),
        ]}
      />
    );
  }

  const isWorkspaceDefault = value === undefined;
  const isActive = normalizedValue !== undefined && normalizedValue !== 'off';
  // Off shows only the resting glyph; compact mode hides the effort label but
  // preserves the same horizontal padding and target geometry as the other
  // capsule controls. Whenever the label is hidden the tooltip names the
  // current effort so the state stays legible.
  const labelVisible = !compact && (isActive || isWorkspaceDefault);
  const capsule = variant === 'capsule';

  return (
    <Tooltip
      label={labelVisible ? TOOLTIP_LABEL : `${TOOLTIP_LABEL}: ${labelText}`}
      delay="long"
    >
      <button
        type="button"
        onClick={handleAdvance}
        disabled={disabled}
        className={`flex shrink-0 items-center transition-colors hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${
          capsule
            ? `h-8 gap-1.5 rounded-full px-2.5 text-xs ${CAPSULE_TOUCH_FLOOR_CLASS}`
            : 'gap-1 rounded-md px-1.5 py-0.5 text-2xs'
        } ${isActive ? 'fg-primary' : 'fg-secondary hover:fg-primary'}`}
        aria-label={ariaLabel ?? `Thinking: ${labelText}; click to cycle`}
        data-testid={testId}
        data-thinking-level={normalizedValue ?? 'default'}
      >
        <ThinkingLevelIcon value={value} />
        {isActive && normalizedValue !== undefined && (
          <ThinkingDots
            level={normalizedValue}
            supportedLevels={supportedLevels}
            providerHint={providerHint}
            includeLow={includeLow}
          />
        )}
        {/* Folds with the row's compact switch and the off level; the
            negative margin takes back the button's gap while folded. */}
        <FoldReveal
          open={labelVisible}
          className={capsule ? '-ml-1.5' : '-ml-1'}
        >
          <span className={capsule ? 'pl-1.5' : 'pl-1'}>{labelText}</span>
        </FoldReveal>
      </button>
    </Tooltip>
  );
}

export interface ThinkingLevelPickerProps {
  value: ThinkingLevel | undefined;
  supportedLevels: readonly ThinkingLevel[];
  onChange: (next: ThinkingLevel | undefined) => void;
  disabled?: boolean;
  allowWorkspaceDefault?: boolean;
  /** Preserve canonical `low` for surfaces that historically exposed it. */
  includeLow?: boolean;
  /**
   * Lines the menu's right edge up with this element (the composer box), as
   * the permission and model menus do, while it still opens above the trigger.
   */
  menuAlignRef?: RefObject<HTMLElement | null>;
  testId?: string;
}

/**
 * Effort as a dropdown: the level's name and a chevron on the trigger, and
 * the model's levels in a menu with a check on the current one. The
 * alternative to the cycling capsule, for rows that read as a set of pickers.
 */
export function ThinkingLevelPicker({
  value,
  supportedLevels,
  onChange,
  disabled = false,
  allowWorkspaceDefault = false,
  includeLow = false,
  menuAlignRef,
  testId,
}: ThinkingLevelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const levels = thinkingControlLevels(supportedLevels, includeLow);
  const current =
    value === undefined || (value === 'low' && includeLow)
      ? value
      : normalizeThinkingForUi(value);
  const options: Array<ThinkingLevel | undefined> = allowWorkspaceDefault
    ? [undefined, ...levels]
    : [...levels];

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <div className="relative shrink-0">
      <Tooltip label={TOOLTIP_LABEL} delay="long" suppressed={open}>
        <PickerTrigger
          ref={triggerRef}
          data-testid={testId}
          textLead
          disabled={disabled}
          onClick={(): void => setOpen((previous) => !previous)}
          className="shrink-0"
          aria-label={`Effort, current level ${thinkingLevelLabel(value, includeLow)}`}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          data-thinking-level={current ?? 'default'}
        >
          <span className="fg-primary">
            {thinkingLevelLabel(value, includeLow)}
          </span>
          <PickerTriggerChevron open={open} />
        </PickerTrigger>
      </Tooltip>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        {...(menuAlignRef
          ? { alignRef: menuAlignRef, gap: COMPOSER_ROW_MENU_GAP }
          : {})}
        placement="top-right"
        aria-label="Effort options"
        data-testid={testId ? `${testId}-menu` : undefined}
        className="w-44"
      >
        {options.map((option) => {
          const selected = option === current;
          return (
            <DropdownMenuItem
              key={option ?? 'default'}
              role="menuitemradio"
              aria-checked={selected}
              data-testid={
                testId ? `${testId}-option-${option ?? 'default'}` : undefined
              }
              onMouseDown={(event): void => {
                event.preventDefault();
              }}
              onClick={(): void => {
                onChange(option);
                setOpen(false);
              }}
            >
              <span className="min-w-0 flex-1 truncate">
                {thinkingLevelLabel(option, includeLow)}
              </span>
              {selected && (
                <span
                  aria-hidden="true"
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

export interface ThinkingLevelPanelPickerProps {
  value: ThinkingLevel | undefined;
  supportedLevels: readonly ThinkingLevel[];
  onChange: (next: ThinkingLevel | undefined) => void;
  disabled?: boolean;
  /** Hosts that can clear a sticky override opt in; desktop keeps its existing panel. */
  allowWorkspaceDefault?: boolean;
  /** Inheritance is separate from the resolved level displayed by the host. */
  workspaceDefaultSelected?: boolean;
  /** Invalidates previews when the host switches model or draft scope. */
  selectionKey?: string;
  /** A model may offer speed without exposing any effort levels. */
  speedOnly?: boolean;
  /** Preserve canonical `low` for surfaces that historically exposed it. */
  includeLow?: boolean;
  /**
   * The chat's fast mode, when its model offers it: the panel carries its
   * switch, and the trigger leads with the bolt while it is on. `ultra` marks
   * the on state as Ultra fast, which turns the bolt the special purple; the
   * host owns the cycle, so `onToggle` selects whichever speed comes next.
   */
  fastMode?: {
    on: boolean;
    ultra?: boolean;
    disabled?: boolean;
    onToggle: () => void;
  };
  /** Lines the panel's right edge up with this element (the composer box). */
  menuAlignRef?: RefObject<HTMLElement | null>;
  /**
   * Which edge the panel lines up with, of `menuAlignRef` or else of the
   * trigger itself; `right` by default.
   */
  menuAlignEdge?: 'left' | 'right';
  /** Horizontal shift of the panel, in pixels (negative is left). */
  menuAlignOffset?: number;
  /**
   * Where the scale starts: `off` (thinking off, the composer's usual
   * floor) or `low` (thinking always on; Low replaces Off).
   */
  lowestLevel?: 'off' | 'low';
  /**
   * Lets the trigger shrink with its row, truncating the level's name,
   * instead of holding its full width.
   */
  allowTriggerShrink?: boolean;
  /** Leaves the trigger's chevron off: the level's name alone. */
  hideTriggerChevron?: boolean;
  testId?: string;
}

/**
 * Effort as a panel: the trigger names the level, and opens a panel headed by
 * the level, with fast mode as a toggle in its top-right corner, over a slider
 * across the model's levels.
 */
export function ThinkingLevelPanelPicker({
  value,
  supportedLevels,
  onChange,
  disabled = false,
  allowWorkspaceDefault = false,
  workspaceDefaultSelected = value === undefined,
  selectionKey,
  speedOnly = false,
  includeLow = false,
  fastMode,
  menuAlignRef,
  lowestLevel = 'off',
  menuAlignEdge = 'right',
  menuAlignOffset,
  allowTriggerShrink = false,
  hideTriggerChevron = false,
  testId,
}: ThinkingLevelPanelPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  // Starting at Low keeps the model's Low and drops Off.
  const lowFloor = lowestLevel === 'low';
  const keepsLow = includeLow || lowFloor;
  const levels = lowFloor
    ? supportedLevels.filter((level) => level !== 'off')
    : thinkingControlLevels(supportedLevels, includeLow);
  const current =
    value === undefined || (value === 'low' && keepsLow)
      ? value
      : normalizeThinkingForUi(value);
  // A drag previews its level in the panel; the chat's setting, and the
  // trigger under the composer, change only when it lands.
  const [draft, setDraft] = useState<ThinkingLevel | null>(null);
  const shown = draft ?? current;
  const index = shown === undefined ? -1 : levels.indexOf(shown);
  const nameOf = (level: ThinkingLevel | undefined): string =>
    thinkingLevelLabel(level, keepsLow);
  const speedLabel = fastMode?.ultra
    ? 'Ultra fast'
    : fastMode?.on
      ? 'Fast'
      : 'Regular';
  const committedLabel = speedOnly ? speedLabel : nameOf(value);
  const label = draft === null ? committedLabel : nameOf(draft);

  const levelsKey = levels.join(',');
  useEffect(() => {
    setDraft(null);
  }, [value, workspaceDefaultSelected, levelsKey, selectionKey, disabled]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (selectionKey !== undefined) setOpen(false);
  }, [selectionKey]);

  const slider = (
    <Slider
      key={`${selectionKey ?? ''}:${levelsKey}`}
      value={index}
      stops={levels.length}
      label="Effort"
      valueText={label}
      disabled={disabled}
      onPreview={(next): void => {
        const level = levels[next];
        if (disabled || level === undefined) return;
        setDraft(level);
      }}
      onChange={(next): void => {
        const level = levels[next];
        if (disabled || level === undefined) return;
        setDraft(null);
        if (workspaceDefaultSelected || level !== current) onChange(level);
      }}
      {...(testId ? { dataTestId: `${testId}-slider` } : {})}
    />
  );
  // Ultra fast is fast mode at its top speed, set apart by the special hue.
  const ultraFast = fastMode?.on === true && fastMode.ultra === true;
  const fastModeName = ultraFast ? 'Ultra fast mode' : 'Fast mode';
  return (
    <div className={`relative ${allowTriggerShrink ? 'min-w-0' : 'shrink-0'}`}>
      <Tooltip
        label={speedOnly ? 'Speed' : TOOLTIP_LABEL}
        delay="long"
        suppressed={open}
        allowShrink={allowTriggerShrink}
        className={allowTriggerShrink ? 'max-w-full' : undefined}
      >
        <PickerTrigger
          ref={triggerRef}
          data-testid={testId}
          textLead
          textTrail={hideTriggerChevron}
          disabled={disabled}
          onClick={(): void => setOpen((previous) => !previous)}
          className={allowTriggerShrink ? 'max-w-full' : 'shrink-0'}
          aria-label={`${speedOnly ? 'Speed, current speed' : 'Effort, current level'} ${committedLabel}${
            fastMode?.on ? `, ${fastModeName.toLowerCase()} on` : ''
          }`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          data-thinking-level={current ?? 'default'}
        >
          {fastMode ? (
            // The bolt's slot opens and closes with fast mode, so the trigger
            // (and the model picker beside it) resizes smoothly, while the
            // bolt itself fades and scales from its centre rather than being
            // clipped by the moving edge. The trigger keeps its 12px
            // label-first inset; open, the slot takes 2px back so the glyph
            // sits at a glyph trigger's 10px. Its -mr-1 takes back the
            // trigger's 4px gap while closed; open, the 22px slot (16px glyph,
            // 6px after) plus that gap less the margin leaves 6px to the label.
            <span
              aria-hidden="true"
              className={`relative -mr-1 inline-flex h-4 shrink-0 transition-[width,margin] duration-200 ease-out motion-reduce:transition-none ${
                fastMode.on ? '-ml-0.5 w-5.5' : 'ml-0 w-0'
              }`}
            >
              {/* The model picker's glyph ink and ink height: the filled bolt
                  spans nearly its whole grid, so it draws at 14px in the 16px
                  slot, its stroke scaled to the composer's weight. */}
              <span
                data-testid={testId ? `${testId}-speed-bolt` : undefined}
                className={`absolute left-0 top-0 inline-flex h-4 w-4 items-center justify-center transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none ${
                  ultraFast ? 'fg-special' : 'fg-secondary'
                } ${
                  fastMode.on ? 'scale-100 opacity-100' : 'scale-50 opacity-0'
                }`}
              >
                <FastModeOnIcon size={14} />
              </span>
            </span>
          ) : null}
          <span
            className={
              allowTriggerShrink ? 'min-w-0 truncate fg-primary' : 'fg-primary'
            }
          >
            {committedLabel}
          </span>
          {hideTriggerChevron ? null : <PickerTriggerChevron open={open} />}
        </PickerTrigger>
      </Tooltip>
      <FloatingMenu
        id={panelId}
        role="dialog"
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        // 4px over the row, whether it spans to the composer's edge or opens
        // over its own trigger.
        {...(menuAlignRef ? { alignRef: menuAlignRef } : {})}
        gap={COMPOSER_ROW_MENU_GAP}
        {...(menuAlignOffset !== undefined
          ? { alignOffset: menuAlignOffset }
          : {})}
        placement={menuAlignEdge === 'left' ? 'top-left' : 'top-right'}
        interaction="manual"
        trapFocus
        padding="readout"
        aria-label={speedOnly ? 'Speed' : 'Effort'}
        data-testid={testId ? `${testId}-panel` : undefined}
        // No text selection: a slider drag must not select the heading.
        className="w-55 select-none"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-baseline gap-2 text-xs">
              <span className="fg-secondary">
                {speedOnly ? 'Speed' : 'Effort'}
              </span>
              <span
                data-testid={testId ? `${testId}-level` : undefined}
                className="truncate fg-primary"
              >
                {label}
              </span>
            </div>
            {fastMode ? (
              // The corner toggle follows the selected speed tier.
              <IconToggleButton
                pressed={fastMode.on}
                label={fastModeName}
                tooltip={`${fastModeName}: ${(ultraFast
                  ? ULTRA_FAST_DESCRIPTION
                  : FAST_MODE_DESCRIPTION
                ).toLowerCase()}`}
                disabled={fastMode.disabled === true}
                onClick={(): void => fastMode.onToggle()}
                placement="panel-corner"
                activeTone={ultraFast ? 'special' : 'accent'}
                dataSpeed={
                  ultraFast ? 'ultrafast' : fastMode.on ? 'fast' : 'standard'
                }
                icon={
                  fastMode.on ? (
                    <FastModeOnIcon size={16} />
                  ) : (
                    <FastModeIcon size={16} />
                  )
                }
                {...(testId ? { testId: `${testId}-fast-mode` } : {})}
              />
            ) : null}
          </div>
          {/* The heading names the level; the slider needs no scale. It
                sits 4px low so the track (not the taller thumb) keeps the
                panel's 12px inset at the bottom, as at the sides. */}
          {speedOnly ? null : <div className="-mb-1">{slider}</div>}
          {allowWorkspaceDefault && !speedOnly ? (
            <DropdownMenuItem
              data-testid={testId ? `${testId}-default` : undefined}
              disabled={disabled}
              aria-pressed={workspaceDefaultSelected}
              onClick={(): void => {
                setDraft(null);
                onChange(undefined);
              }}
            >
              Default
              {workspaceDefaultSelected ? <CheckIcon size={16} /> : null}
            </DropdownMenuItem>
          ) : null}
        </div>
      </FloatingMenu>
    </div>
  );
}
