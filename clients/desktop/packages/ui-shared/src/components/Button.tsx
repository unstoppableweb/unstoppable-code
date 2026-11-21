export { DROPDOWN_TRIGGER_INTERACTION_CLASS } from './control-button-shared';
import {
  BUTTON_PRESS_CLASS,
  RAIL_VISIBILITY_CLASSES,
  RAIL_INSET_CLASSES,
  nestedIconButtonRadiusClassName,
} from './control-button-shared';
export { nestedIconButtonRadiusClassName } from './control-button-shared';
export { BUTTON_PRESS_CLASS } from './control-button-shared';
import { APP_CONTROL_RECIPES } from './app-control-recipes';
import { DESKTOP_CONTROL_RECIPES } from './desktop-control-recipes';
import { SHARED_CONTROL_RECIPES } from './control-button-shared';
import { WEB_CONTROL_RECIPES } from './control-button-web';
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type JSX,
  type MouseEvent,
} from 'react';
import {
  SECONDARY_SURFACE_CLASS,
  SECONDARY_SURFACE_OPEN_CLASS,
} from '../lib/row-chips';
import { KbdChip } from './KbdChip';

/**
 * The five button looks (design decision, 2026-11-18). `primary` is the one
 * main action, `secondary` every other filled action, `ghost` a quiet action
 * with no fill at rest, and `destructive` / `ghost-destructive` their
 * counterparts for an action that loses something. Nothing else exists: the
 * outline, tinted, warning and the other ghost looks were retired.
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'ghost-destructive'
  | 'destructive';

/**
 * Inline accent text for an action inside a sentence, with no capsule. It is
 * kept out of `ButtonVariant` so a wrapper that forwards a capsule variant
 * with a `size` stays valid; `variant="link"` takes only the link props.
 */
export type ButtonLinkVariant = 'link';

export type ButtonSize = 'sm' | 'md' | 'lg' | 'compact' | 'field';

interface BusyButtonAppearanceProps {
  /**
   * Keep the normal variant paint while busy. Only opt in when the caller
   * renders a visible loader; `aria-busy` alone keeps the disabled feedback.
   */
  busyAppearance?: 'default' | 'preserved';
}

interface CapsuleButtonBaseProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, BusyButtonAppearanceProps {
  /** Visual treatment for the button. */
  variant?: ButtonVariant;
  /**
   * Visible control height, at or below the 36px app maximum. `sm`, `md`
   * and `lg` are the 14px-label pill. `compact` is the 28px capsule with a
   * 13px label: Settings, dialog, section-header and dense-panel actions.
   * `field` is the 28px field rectangle (10px `rounded-row` corners) for a
   * dropdown trigger only
   * (`SettingsSelect`): fields and dropdowns are rectangles, actions are
   * capsules. Never give an action `field`.
   */
  size?: ButtonSize;
  /**
   * Let the enclosing `group/checklist` row act as the button: the row's
   * hover paints the variant's hover look, and an overlay covering the row
   * (its 8px radius) takes the click, so the button is positioned by the row
   * rather than itself and does not press-scale. The checklist action's
   * stretched primary CTA.
   */
  fillRow?: boolean;
  /**
   * Keep the hover look while the enclosing `group/gitaction` is hovered. A
   * running action's cancel ✕ sits inside that group but outside the
   * button, so without this the button would drop its hover the moment the
   * pointer reaches the ✕.
   */
  groupHover?: boolean;
  /**
   * A toggle (`aria-pressed`) shows its hover look while pressed, so the
   * on state reads at rest: the browser address bar's toolbar toggles.
   */
  pressedHover?: boolean;
  /**
   * Disabled, keep the variant's ink at 80% instead of the disabled ink, for
   * a control that stays in place while its own action runs (Refresh).
   */
  quietWhenDisabled?: boolean;
  /**
   * An `aria-disabled` button that shows a value the user cannot change here
   * (a read-only status, CAN-5309): it skips the 60% dim and paints no hover
   * fill. The caller sets the label ink that must read at AA. It still
   * swallows clicks under a not-allowed cursor.
   */
  readOnlyAppearance?: boolean;
  /**
   * How far the hit area reaches on a touch screen. `expanded` (the default)
   * grows it to 44px around the button. `contained` keeps it to the button's
   * own box, for a button packed against other controls or stacked rows
   * (a model row's favorite star), where the grown area would take their taps.
   */
  touchArea?: ButtonTouchArea;
  /** Placement of an action inside a rail's fixed-size slot. */
  railPlacement?: {
    coarsePointerTarget: boolean;
    visibility: keyof typeof RAIL_VISIBILITY_CLASSES;
    inset: keyof typeof RAIL_INSET_CLASSES;
  };
}

export type ButtonTouchArea = 'expanded' | 'contained';

type CapsuleButtonProps = CapsuleButtonBaseProps &
  (
    | {
        /** Render a circular icon-only button. */
        iconOnly: true;
        /** Nest a sidebar control's corners inside its 32px row. */
        iconShape?: 'default' | 'nested';
        /** Accessible name required for icon-only controls. */
        'aria-label': string;
        /** An icon-only control names its shortcut in its tooltip instead. */
        shortcut?: undefined;
        leadingIcon?: undefined;
      }
    | {
        iconOnly?: false;
        /** Sidebar text actions share the nested corners of adjacent icons. */
        iconShape?: 'default' | 'nested';
        /**
         * The keys that perform this action (`formatShortcut(id)`: `⌘P`,
         * `Ctrl P`), drawn inside the button after its label as one filled
         * chip. A labelled button carries its shortcut here rather than in a
         * tooltip.
         */
        shortcut?: string;
        /**
         * The label starts with an icon or status glyph. The glyph's own
         * side bearing already reads as space, so the start padding is
         * smaller: 8px on `compact` (12px at the end, as every label). Other
         * sizes keep their padding for now.
         */
        leadingIcon?: boolean;
      }
  );

/**
 * An action inside a sentence: inline accent text that takes the size of the
 * copy around it. The capsule-only props do not apply, so they are not
 * accepted.
 */
interface LinkButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, BusyButtonAppearanceProps {
  variant: ButtonLinkVariant;
  size?: undefined;
  iconOnly?: false;
  iconShape?: undefined;
  shortcut?: undefined;
  leadingIcon?: undefined;
  fillRow?: undefined;
  groupHover?: undefined;
  pressedHover?: undefined;
  quietWhenDisabled?: undefined;
  readOnlyAppearance?: undefined;
  /**
   * A text link keeps its own box by default. `expanded` grows it to 44px
   * tall on a touch screen, for a link with room above and below it.
   */
  touchArea?: ButtonTouchArea;
  railPlacement?: undefined;
}

type CostRowButtonVariant = 'cost-row-stack' | 'cost-row-inline';

type CostRowButtonProps = Omit<LinkButtonProps, 'variant'> & {
  variant: CostRowButtonVariant;
};

export type ButtonProps =
  | CapsuleButtonProps
  | LinkButtonProps
  | CostRowButtonProps;

/**
 * The press every button and dropdown trigger shares: a 3% scale-down while
 * the pointer is down, eased over 150ms. Pair it with `transition-transform`
 * or a property list that names `scale`: Tailwind's `scale-*` sets
 * the CSS `scale` property, which a plain `transform` entry does not ease.
 */

/**
 * How a dropdown trigger behaves under the pointer: the secondary `Button`'s
 * press, its hover fill, and that hover look held while the menu is open.
 * `Select`, `SettingsSelect`, and the `PickerTrigger` field variant all use
 * it; each keeps its own field shape and edge.
 */

/**
 * An invalid dropdown (`aria-invalid` on its trigger) takes the field
 * tokens: the destructive edge at rest, and the destructive edge and halo
 * while focused or open, in place of its hairline ring and shadow; the
 * stylesheet drops the `focus-ring` outline for an invalid `combobox` trigger
 * or native `select`, so give this class only to one of those. One colour
 * family in every state, like the invalid fields.
 */
export const DROPDOWN_INVALID_CLASS =
  'aria-invalid:ring-0 aria-invalid:shadow-field-invalid aria-invalid:focus-visible:shadow-field-invalid-focus aria-invalid:aria-expanded:shadow-field-invalid-focus';

// An `aria-disabled` button stays in the tab order so it can announce a busy
// state (Connecting…); it keeps its variant surface, reads as unavailable at
// 60% under a not-allowed cursor, and, like `disabled`, neither presses nor
// runs its click.
// A `disabled` button stays the click target, so a click on it is swallowed
// rather than handed to a clickable row behind it (no `pointer-events-none`).
// Its look ignores hover and press instead: Tailwind sorts `disabled:` after
// `hover:` and `active:`, so each disabled class below outranks the hover or
// press class for the same property. Loader-equipped busy buttons can opt
// into retaining their variant paint; disabled semantics still block presses.
const BASE_CLASS_NAME = `focus-ring inline-flex [-webkit-tap-highlight-color:transparent] shrink-0 select-none items-center justify-center gap-1.5 font-medium transition-[opacity,transform,scale] ${BUTTON_PRESS_CLASS} before:absolute before:inset-x-0 before:content-[''] disabled:scale-100 disabled:cursor-not-allowed disabled:not-data-[busy-appearance=preserved]:shadow-none aria-disabled:scale-100 aria-disabled:cursor-not-allowed`;
const ARIA_DISABLED_DIM_CLASS_NAME =
  'aria-disabled:not-data-[busy-appearance=preserved]:opacity-60';
// A read-only value keeps its ink; only the hover fill is withheld.
const READ_ONLY_CLASS_NAME = 'aria-disabled:hover:bg-transparent';

// Disabled, the label takes the disabled ink; `quietWhenDisabled` keeps the
// variant's ink at 80% instead.
const DISABLED_INK_CLASS_NAME =
  'disabled:not-data-[busy-appearance=preserved]:text-[var(--fg-disabled)] disabled:not-data-[busy-appearance=preserved]:opacity-100';
const QUIET_DISABLED_INK_CLASS_NAME =
  'disabled:not-data-[busy-appearance=preserved]:opacity-80';

// Disabled, a filled variant swaps its fill for the disabled fill. The ghost
// variants (transparent at rest) keep no fill: a disabled ghost reads as a
// dimmed icon or label, never a grey disc, and their hover fill is reset.
const DISABLED_FILL_CLASS_NAME =
  'disabled:not-data-[busy-appearance=preserved]:bg-[var(--bg-disabled)]';
const DISABLED_NO_FILL_CLASS_NAME =
  'disabled:bg-transparent aria-busy:data-[busy-appearance=preserved]:bg-transparent';

const VARIANT_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary: `bg-accent fg-emphasis hover:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)] ${DISABLED_FILL_CLASS_NAME} aria-busy:data-[busy-appearance=preserved]:bg-accent`,
  // The house secondary control surface shared with action chips and the
  // header `Open in` split control; only the ink is added here.
  secondary: `${SECONDARY_SURFACE_CLASS} ${SECONDARY_SURFACE_OPEN_CLASS} fg-primary ${DISABLED_FILL_CLASS_NAME} disabled:[background-image:none] aria-busy:data-[busy-appearance=preserved]:[background-image:none]`,
  // No fill at rest. The hover is the translucent overlay, so it shows on
  // any surface (a page, a card, a hovered row) instead of punching an
  // opaque hole in it. Open (a menu, `aria-expanded`) holds the hover look;
  // pressed (a toggle, `aria-pressed`) or on (a switch, `aria-checked`)
  // takes a stronger overlay than hover, so the state shows at rest.
  ghost: `bg-transparent fg-secondary hover:bg-subtle hover:fg-primary not-disabled:aria-expanded:bg-subtle not-disabled:aria-expanded:fg-primary not-disabled:aria-pressed:bg-muted not-disabled:aria-pressed:fg-primary not-disabled:aria-checked:bg-muted not-disabled:aria-checked:fg-primary ${DISABLED_NO_FILL_CLASS_NAME} aria-busy:data-[busy-appearance=preserved]:fg-secondary`,
  // A quiet destructive action beside other actions (Delete next to Edit),
  // where the filled `destructive` would outweigh the primary choice.
  'ghost-destructive': `bg-transparent fg-destructive hover:bg-destructive-subtle hover:fg-destructive ${DISABLED_NO_FILL_CLASS_NAME}`,
  destructive: `bg-destructive fg-emphasis hover:bg-destructive-hover ${DISABLED_FILL_CLASS_NAME} aria-busy:data-[busy-appearance=preserved]:bg-destructive`,
};

// The `link` variant: an action that reads as a text link inside a sentence
// (Retry, Open settings). It takes the size of the copy around it, so no
// height, padding, radius or label size applies, and it does not press-scale.
// Same ink as `ExternalTextLink`, so a link and a link action match.
const LINK_CLASS_NAME =
  'focus-ring rounded font-medium fg-accent hover:underline disabled:cursor-not-allowed disabled:no-underline disabled:not-data-[busy-appearance=preserved]:fg-disabled aria-disabled:cursor-not-allowed aria-disabled:no-underline aria-disabled:not-data-[busy-appearance=preserved]:opacity-60';

// Shape and label size belong to the size, so the pill and the field
// rectangle never carry each other's radius or type.
const SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'h-7 text-s',
  md: 'h-8 text-s',
  lg: 'h-9 text-s',
  compact: 'h-7 text-xs',
  field: `h-7 text-xs ${DROPDOWN_INVALID_CLASS}`,
};

const SIZE_RADIUS_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'rounded-full',
  md: 'rounded-full',
  lg: 'rounded-full',
  compact: 'rounded-full',
  field: 'rounded-row',
};

/**
 * Sidebar row corners nest: the 28px control's 2px inset from a 32px row
 * subtracts 2px from the row radius. A control that fills the row keeps its
 * radius. Shared with the rail's native section/destructive tones.
 */

// On a coarse pointer the `before:` hit area grows to 44px: up and down for
// every button, and sideways too for an icon-only one. `touchArea="contained"`
// leaves both out.
const COARSE_HIT_Y_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'pointer-coarse:before:-inset-y-2',
  md: 'pointer-coarse:before:-inset-y-1.5',
  lg: 'pointer-coarse:before:-inset-y-1',
  compact: 'pointer-coarse:before:-inset-y-2',
  field: 'pointer-coarse:before:-inset-y-2',
};

const COARSE_HIT_X_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'pointer-coarse:before:-inset-x-2',
  md: 'pointer-coarse:before:-inset-x-1.5',
  lg: 'pointer-coarse:before:-inset-x-1',
  compact: 'pointer-coarse:before:-inset-x-2',
  field: 'pointer-coarse:before:-inset-x-2',
};

const COARSE_LINK_HIT_CLASS_NAME =
  "pointer-coarse:before:absolute pointer-coarse:before:inset-x-0 pointer-coarse:before:-inset-y-3.5 pointer-coarse:before:content-['']";

const LABEL_SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'px-2.5',
  md: 'px-3',
  lg: 'px-4',
  compact: 'px-3',
  field: 'px-2.5',
};

// A label that starts with an icon (`leadingIcon`): a smaller start, the
// same end. Only `compact` has its own value so far.
const LEADING_ICON_SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  ...LABEL_SIZE_CLASS_NAMES,
  compact: 'pl-2 pr-3',
};

// With a shortcut chip at the end, the end padding equals the chip's inset
// from the top and bottom ((height - 18px chip) / 2), so the chip's capsule
// stays concentric with the button's end cap.
const SHORTCUT_END_PADDING_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'pr-1.25',
  md: 'pr-1.75',
  lg: 'pr-2.25',
  compact: 'pr-1.25',
  field: 'pr-1.25',
};

const ICON_ONLY_SIZE_CLASS_NAMES: Record<ButtonSize, string> = {
  sm: 'w-7 px-0',
  md: 'w-8 px-0',
  lg: 'w-9 px-0',
  compact: 'w-7 px-0',
  field: 'w-7 px-0',
};

// The overlay replaces the coarse-pointer `before:` hit area; `static` and the
// press scale are inline because Tailwind emits `relative` after `static`.
const FILL_ROW_CLASS_NAME =
  "before:hidden after:absolute after:inset-0 after:rounded-lg after:content-['']";
const FILL_ROW_STYLE: CSSProperties = {
  position: 'static',
  transform: 'none',
  scale: 'none',
};

/** Each variant's hover look, painted by the `group/checklist` row's hover. */
const FILL_ROW_HOVER_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary:
    'group-hover/checklist:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
  // Written out in full: Tailwind generates only the classes it finds in
  // source, so a class built by string replacement never gets a rule.
  secondary:
    'group-hover/checklist:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
  ghost: 'group-hover/checklist:bg-subtle group-hover/checklist:fg-primary',
  'ghost-destructive':
    'group-hover/checklist:bg-destructive-subtle group-hover/checklist:fg-destructive',
  destructive: 'group-hover/checklist:bg-destructive-hover',
};

/**
 * Each variant's hover look, painted by the enclosing `group/gitaction`'s
 * hover (`groupHover`). `enabled:` keeps a disabled button out of it.
 */
const GROUP_HOVER_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary:
    'enabled:group-hover/gitaction:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
  secondary:
    'enabled:group-hover/gitaction:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
  ghost:
    'enabled:group-hover/gitaction:bg-subtle enabled:group-hover/gitaction:fg-primary',
  'ghost-destructive': 'enabled:group-hover/gitaction:bg-destructive-subtle',
  destructive: 'enabled:group-hover/gitaction:bg-destructive-hover',
};

/** Each variant's hover look, held while the toggle is pressed (`pressedHover`). */
const PRESSED_HOVER_CLASS_NAMES: Record<ButtonVariant, string> = {
  primary:
    'enabled:aria-pressed:bg-[color-mix(in_srgb,var(--bg-accent),#000_12%)]',
  secondary:
    'enabled:aria-pressed:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
  ghost: 'enabled:aria-pressed:bg-subtle enabled:aria-pressed:fg-primary',
  'ghost-destructive': 'enabled:aria-pressed:bg-destructive-subtle',
  destructive: 'enabled:aria-pressed:bg-destructive-hover',
};

// The button is the containing block for its `before:` hit area, so it is
// `relative` unless the caller's placement already positions it: Tailwind
// emits `.relative` after `.absolute`, so both on one element would silently
// drop the caller's `absolute`. An absolute, fixed or sticky button contains
// the hit area itself. A pseudo-element's position (`after:absolute`) is not
// the button's.
const CALLER_POSITIONS = new Set(['absolute', 'fixed', 'sticky']);
const PSEUDO_ELEMENT_VARIANTS = new Set(['before', 'after']);

function positionsItself(className: string): boolean {
  return className.split(/\s+/).some((token) => {
    const parts = token.split(':');
    const utility = (parts.pop() ?? '').replace(/^!|!$/g, '');
    return (
      CALLER_POSITIONS.has(utility) &&
      !parts.some((variant) => PSEUDO_ELEMENT_VARIANTS.has(variant))
    );
  });
}

/**
 * Button styling for elements that must NOT be a `<button>`.
 *
 * A primary navigation rendered as a `<button onClick={navigate}>` loses
 * middle-click, cmd/ctrl-click to open in a new tab, right-click to copy the
 * link, and the browser's status-bar URL preview. An `<a href>` carrying this
 * class keeps all of that while staying pixel-identical to {@link Button}, so
 * the two never drift.
 */
export function buttonClassName({
  variant = 'secondary',
  size = 'md',
  multiline = false,
  iconOnly = false,
  iconShape = 'default',
  leadingIcon = false,
  groupHover = false,
  pressedHover = false,
  quietWhenDisabled = false,
  readOnlyAppearance = false,
  touchArea,
  className = '',
}: {
  variant?: ButtonVariant | ButtonLinkVariant | CostRowButtonVariant;
  size?: ButtonSize;
  multiline?: boolean;
  iconOnly?: boolean;
  leadingIcon?: boolean;
  iconShape?: 'default' | 'nested';
  groupHover?: boolean;
  pressedHover?: boolean;
  quietWhenDisabled?: boolean;
  readOnlyAppearance?: boolean;
  touchArea?: ButtonTouchArea;
  className?: string;
} = {}): string {
  if (variant === 'cost-row-stack' || variant === 'cost-row-inline') {
    const layout =
      variant === 'cost-row-stack' ? 'flex-col gap-1.5' : 'items-center gap-3';
    return `flex w-full rounded-md px-2 py-2 text-left text-xs pointer-coarse:min-h-11 ${layout} focus-ring transition-colors hover:bg-subtle ${className}`;
  }
  if (variant === 'link') {
    const touch =
      touchArea === 'expanded'
        ? `${positionsItself(className) ? '' : 'relative '}${COARSE_LINK_HIT_CLASS_NAME} `
        : '';
    return `${touch}${LINK_CLASS_NAME} ${className}`;
  }
  const position = positionsItself(className) ? '' : 'relative ';
  const radiusClassName =
    iconShape === 'nested'
      ? nestedIconButtonRadiusClassName(size)
      : SIZE_RADIUS_CLASS_NAMES[size];
  const contentSizeClassName = iconOnly
    ? ICON_ONLY_SIZE_CLASS_NAMES[size]
    : iconShape === 'nested' && size === 'compact'
      ? 'px-2.5'
      : leadingIcon
        ? LEADING_ICON_SIZE_CLASS_NAMES[size]
        : LABEL_SIZE_CLASS_NAMES[size];
  const states = [
    quietWhenDisabled ? QUIET_DISABLED_INK_CLASS_NAME : DISABLED_INK_CLASS_NAME,
    readOnlyAppearance ? READ_ONLY_CLASS_NAME : ARIA_DISABLED_DIM_CLASS_NAME,
    groupHover ? GROUP_HOVER_CLASS_NAMES[variant] : '',
    pressedHover ? PRESSED_HOVER_CLASS_NAMES[variant] : '',
    touchArea !== 'contained' ? COARSE_HIT_Y_CLASS_NAMES[size] : '',
    touchArea !== 'contained' && iconOnly ? COARSE_HIT_X_CLASS_NAMES[size] : '',
  ]
    .filter(Boolean)
    .join(' ');
  const heightClassName = multiline
    ? 'min-h-11 py-2 text-s'
    : `max-h-9 ${SIZE_CLASS_NAMES[size]}`;
  return `${position}${BASE_CLASS_NAME} ${states} ${VARIANT_CLASS_NAMES[variant]} ${heightClassName} ${radiusClassName} ${contentSizeClassName} ${className}`;
}

const CONTROL_RECIPES = {
  ...APP_CONTROL_RECIPES,
  ...DESKTOP_CONTROL_RECIPES,
  ...SHARED_CONTROL_RECIPES,
  ...WEB_CONTROL_RECIPES,
};

type ControlAppearance = {
  [Name in keyof typeof CONTROL_RECIPES]: (typeof CONTROL_RECIPES)[Name] extends (
    appearance: infer State,
  ) => string
    ? State
    : undefined;
};

const controlRecipes: {
  [Name in keyof ControlAppearance]:
    | string
    | ((appearance: ControlAppearance[Name]) => string);
} = CONTROL_RECIPES;

export type ControlButtonPresentation = keyof ControlAppearance;

export type ControlButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  {
    [Name in ControlButtonPresentation]: {
      readonly presentation: Name;
    } & (ControlAppearance[Name] extends undefined
      ? { readonly appearance?: undefined }
      : { readonly appearance: ControlAppearance[Name] });
  }[ControlButtonPresentation];

function controlButtonClasses<Name extends ControlButtonPresentation>(
  presentation: Name,
  appearance: ControlAppearance[Name] | undefined,
): string {
  const recipe = controlRecipes[presentation];
  if (typeof recipe === 'string') return recipe;
  return appearance === undefined ? '' : recipe(appearance);
}

/** A native control whose paint and geometry belong to a named widget. */
export const ControlButton = forwardRef<HTMLButtonElement, ControlButtonProps>(
  function ControlButton(
    { presentation, appearance, className, type = 'button', ...props },
    ref,
  ): JSX.Element {
    const recipe = controlButtonClasses(presentation, appearance);
    return (
      <button
        {...props}
        ref={ref}
        type={type}
        data-control={presentation}
        className={className ? `${recipe} ${className}` : recipe}
      />
    );
  },
);

/**
 * Canonical action button shared by desktop and web.
 *
 * Navigation rows, tabs, disclosure controls, and switch tracks should keep
 * their purpose-built semantics instead of using this action primitive.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant = 'secondary',
      size = 'md',
      iconOnly = false,
      iconShape = 'default',
      leadingIcon = false,
      fillRow = false,
      groupHover = false,
      pressedHover = false,
      quietWhenDisabled = false,
      readOnlyAppearance = false,
      busyAppearance = 'default',
      touchArea,
      railPlacement,
      type = 'button',
      className = '',
      style,
      children,
      shortcut,
      ...props
    },
    ref,
  ): JSX.Element {
    const withShortcut = !iconOnly && shortcut !== undefined && shortcut !== '';
    const railClasses = railPlacement
      ? [
          railPlacement.coarsePointerTarget
            ? ''
            : 'pointer-coarse:before:hidden',
          RAIL_VISIBILITY_CLASSES[railPlacement.visibility],
          RAIL_INSET_CLASSES[railPlacement.inset],
        ]
          .filter(Boolean)
          .join(' ')
      : '';
    const placementClassName = [
      withShortcut ? SHORTCUT_END_PADDING_CLASS_NAMES[size] : '',
      className,
      railClasses,
    ]
      .filter(Boolean)
      .join(' ');
    const preserveBusyAppearance =
      busyAppearance === 'preserved' &&
      (props['aria-busy'] === true || props['aria-busy'] === 'true');
    return (
      <button
        ref={ref}
        type={type}
        className={buttonClassName({
          variant,
          size,
          iconOnly,
          iconShape,
          leadingIcon,
          groupHover,
          pressedHover,
          quietWhenDisabled,
          readOnlyAppearance,
          touchArea,
          className: fillRow
            ? `${FILL_ROW_CLASS_NAME} ${variant === 'link' || variant === 'cost-row-stack' || variant === 'cost-row-inline' ? '' : FILL_ROW_HOVER_CLASS_NAMES[variant]} ${placementClassName}`
            : placementClassName,
        })}
        style={fillRow ? { ...FILL_ROW_STYLE, ...style } : style}
        {...props}
        data-busy-appearance={preserveBusyAppearance ? 'preserved' : undefined}
        onClick={
          isAriaDisabled(props['aria-disabled'])
            ? swallowUnavailableClick
            : props.onClick
        }
      >
        {children}
        {withShortcut && <KbdChip shortcut={shortcut} />}
      </button>
    );
  },
);

Button.displayName = 'Button';

/** `aria-disabled` as React accepts it: a boolean or its string form. */
export function isAriaDisabled(
  value: ButtonHTMLAttributes<HTMLButtonElement>['aria-disabled'],
): boolean {
  return value === true || value === 'true';
}

/**
 * The click of a button that is unavailable but focusable: it runs nothing,
 * and cancelling it stops a submit button from submitting its form, Enter in
 * a field included.
 */
export function swallowUnavailableClick(event: MouseEvent): void {
  event.preventDefault();
}
