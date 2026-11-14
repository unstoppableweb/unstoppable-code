import {
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type FocusEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { useFlipBox } from '../lib/flip-box';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../lib/row-chips';
import { getWindow } from '../panels/window-registry';
import { Tooltip, type TooltipLink } from './Tooltip';

export interface SegmentedControlOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly dataTestId?: string;
  /**
   * Shown in place of the label, for an icon-only segment. The label stays
   * the segment's accessible name; pair it with a `tooltip` that says it.
   */
  readonly icon?: ReactNode;
  /** Shown before the label, such as a lock on a value an organization pins. */
  readonly leading?: ReactNode;
  /** Shown after the label, such as a count. */
  readonly trailing?: ReactNode;
  /** Explains the option on hover and keyboard focus. */
  readonly tooltip?: ReactNode;
  /** A link under the tooltip's text, such as an unavailable option's next step. */
  readonly tooltipLink?: TooltipLink;
  /** Id of the sentence that explains this option. */
  readonly describedBy?: string;
  /** Shown and focusable, so its tooltip can say why, but not selectable. */
  readonly unavailable?: boolean;
  /**
   * Runs when an unavailable option is pressed, for an in-app next step a
   * tooltip cannot offer on touch or inside a focus trap.
   */
  readonly onUnavailablePress?: () => void;
  /** Not selectable and out of the Tab order, with no reason to show. */
  readonly disabled?: boolean;
  /** With `semantics="tabs"`, the tab's id. */
  readonly id?: string;
  /** With `semantics="tabs"`, the id of the panel the tab shows. */
  readonly controls?: string;
}

export interface SegmentedControlProps<T extends string> {
  /** The chosen option, or `null` while the current value is loading. */
  readonly value: T | null;
  readonly options: readonly SegmentedControlOption<T>[];
  readonly onChange: (next: T) => void;
  /** Accessible name for the group. */
  readonly label: string;
  /**
   * `toggle` switches a setting in place: a group of pressed buttons. `radio`
   * is one choice of a form: a radiogroup with one Tab stop and arrow keys
   * that move and choose. `tabs` switches the view below it: a tablist whose
   * tabs name their panels.
   */
  readonly semantics?: 'toggle' | 'radio' | 'tabs';
  /** Id of an element that describes the whole group. */
  readonly describedBy?: string;
  /**
   * `control`: at least the settings control column (208px), so a stack of
   * settings rows lines its pickers up edge to edge; a picker whose labels do
   * not fit grows past it. `fill`: the full width of its row. `content`: only
   * as wide as its labels, for a picker whose segments size to their labels
   * (each under a tooltip) and would otherwise leave an empty run of track.
   */
  readonly width?: 'control' | 'fill' | 'content';
  /**
   * `rounded` (default): the 8px corner of the settings control rectangle.
   * `capsule`: the 28px capsule of the compact settings buttons.
   */
  readonly shape?: SegmentedControlShape;
  readonly disabled?: boolean;
  /**
   * Give every segment a 44px touch target on coarse pointers, for a picker
   * in a mobile drawer. The track grows around its inset; fine pointers keep
   * the 28px track.
   */
  readonly touchTarget?: boolean;
  /** The track's test id; the sliding surface takes it with `-indicator`. */
  readonly dataTestId?: string;
}

/** The track's corner: the control rectangle or the compact capsule. */
export type SegmentedControlShape = 'rounded' | 'capsule';

/**
 * The 28px height of the settings buttons, sunk into the `bg-depth` well so
 * the raised segment stands above it, with the segments inset 2px.
 */
const TRACK_CLASS_NAME =
  'relative inline-flex h-7 shrink-0 items-stretch gap-0.5 bg-depth p-0.5';

/** The 8px corner of the control rectangle, or the compact capsule. */
const TRACK_CORNER_CLASS_NAME: Record<SegmentedControlShape, string> = {
  rounded: 'rounded-md',
  capsule: 'rounded-full',
};

const TRACK_WIDTH_CLASS_NAME = {
  control: 'min-w-52',
  fill: 'w-full',
  content: 'w-fit max-w-full',
} as const;

/**
 * The segment's corner nests inside the track's: 8px less the 2px inset, or
 * a capsule inside the capsule track, so the corners nest at any width.
 */
const SEGMENT_CORNER_CLASS_NAME: Record<SegmentedControlShape, string> = {
  rounded: 'rounded-[calc(var(--radius-md)-2px)]',
  capsule: 'rounded-full',
};

/** The capsule segment takes the compact button's 12px sides. */
const SEGMENT_PADDING_CLASS_NAME: Record<SegmentedControlShape, string> = {
  rounded: 'px-2',
  capsule: 'px-3',
};

/** An icon-only segment: a square inside the 28px track. */
const ICON_SEGMENT_PADDING_CLASS_NAME = 'w-6 px-0';

function segmentClassName(
  selected: boolean,
  unavailable: boolean,
  shape: SegmentedControlShape,
  iconOnly: boolean,
): string {
  return `focus-ring relative inline-flex flex-1 basis-0 items-center justify-center gap-1 whitespace-nowrap ${iconOnly ? ICON_SEGMENT_PADDING_CLASS_NAME : SEGMENT_PADDING_CLASS_NAME[shape]} text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${SEGMENT_CORNER_CLASS_NAME[shape]} ${
    selected ? 'fg-primary' : 'fg-secondary hover:fg-primary'
  }${unavailable ? ' cursor-not-allowed opacity-60' : ''}`;
}

/** Realm-neutral, for a picker rendered into an auxiliary window. */
function isHtmlElement(node: Element): node is HTMLElement {
  return 'offsetLeft' in node && 'offsetParent' in node;
}

/**
 * The element's left edge within the track, from layout offsets rather than
 * client rects, so a popover's scale-in does not skew the measurement. A
 * tooltip wraps its segment in a positioned span, so the offsets are summed
 * up to the track.
 */
function offsetLeftWithin(element: HTMLElement, track: HTMLElement): number {
  let left = 0;
  let node: Element | null = element;
  while (node && node !== track && isHtmlElement(node)) {
    left += node.offsetLeft;
    node = node.offsetParent;
  }
  return left;
}

interface SurfacePlacement {
  readonly left: number;
  readonly width: number;
  /** Slide to this place: a new choice. A resize lands without motion. */
  readonly slide: boolean;
}

/**
 * Places the surface under the selected segment, keeping the current
 * placement when the segment has not moved so an unchanged measure does not
 * render again.
 */
function placeSurface(
  track: HTMLElement,
  slide: boolean,
  setSurface: Dispatch<SetStateAction<SurfacePlacement | null>>,
): void {
  const selected = track.querySelector('[data-segment-selected="true"]');
  const next =
    selected && isHtmlElement(selected)
      ? {
          left: offsetLeftWithin(selected, track),
          width: selected.offsetWidth,
          slide,
        }
      : null;
  setSurface((previous) =>
    previous &&
    next &&
    previous.left === next.left &&
    previous.width === next.width
      ? previous
      : next,
  );
}

/**
 * What the segments are laid out from, so a caller's fresh but equal options
 * array on every render does not measure the track again. A segment's own
 * content (an icon, a count) resizes it, which the observer sees.
 */
function optionsLayoutKey(
  options: readonly SegmentedControlOption<string>[],
): string {
  return options
    .map((option) =>
      [option.value, option.label, option.tooltip ? 'tooltip' : ''].join(
        '\u0001',
      ),
    )
    .join('\u0000');
}

/**
 * The surface's slide: a compositor translate and stretch, not `left`/`width`,
 * on the 200ms Tailwind `ease-out` curve it has always used.
 */
const SURFACE_SLIDE = {
  durationMs: 200,
  easing: 'cubic-bezier(0, 0, 0.2, 1)',
} as const;

/**
 * Two to four short, mutually exclusive choices. The chosen segment is raised
 * on the secondary button's resting surface, which slides to the picked
 * segment rather than jumping, so the picker reads as one control moving
 * between places. Settings rows and the usage popover share it.
 */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
  semantics = 'toggle',
  describedBy,
  width = 'control',
  shape = 'rounded',
  disabled,
  touchTarget = false,
  dataTestId,
}: SegmentedControlProps<T>): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const [focusedValue, setFocusedValue] = useState<T | null>(null);
  const [surface, setSurface] = useState<SurfacePlacement | null>(null);
  useFlipBox(surfaceRef, { ...SURFACE_SLIDE, snap: surface?.slide !== true });
  const layoutKey = optionsLayoutKey(options);
  const measuredValueRef = useRef(value);

  // Measured rather than computed from the option count: segments under a
  // tooltip size to their labels, so they are not equal. The surface is
  // first drawn already in place, so it never slides in on mount; after that
  // a new choice slides, and new options only re-place it.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    placeSurface(track, measuredValueRef.current !== value, setSurface);
    measuredValueRef.current = value;
  }, [value, layoutKey]);

  // The track resizing with its panel, or a segment with its content, moves
  // the surface with it at once rather than trailing behind in a slide.
  useLayoutEffect(() => {
    const track = trackRef.current;
    if (!track) return undefined;
    const view = getWindow(track);
    if (typeof view.ResizeObserver !== 'function') return undefined;
    const observer = new view.ResizeObserver(() =>
      placeSurface(track, false, setSurface),
    );
    observer.observe(track);
    for (const segment of track.querySelectorAll('[data-segment-index]')) {
      observer.observe(segment);
    }
    return (): void => observer.disconnect();
  }, [layoutKey]);

  const tabs = semantics === 'tabs';
  const radio = semantics === 'radio';
  const roving = tabs || radio;
  // Enter at the selected segment, or the first enabled segment while loading.
  // Inside the group the Tab stop follows focus so Tab can leave even when an
  // unavailable segment has focus and another segment is selected.
  const enabledOptions = options.filter((option) => option.disabled !== true);
  const entryValue = enabledOptions.some((option) => option.value === value)
    ? value
    : enabledOptions[0]?.value;
  const tabbableValue = enabledOptions.some(
    (option) => option.value === focusedValue,
  )
    ? focusedValue
    : entryValue;
  const onTrackBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget)) {
      setFocusedValue(null);
    }
  };
  const onRovingKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    segmentValue: T,
  ): void => {
    const count = enabledOptions.length;
    const index = enabledOptions.findIndex(
      (option) => option.value === segmentValue,
    );
    let next: number;
    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % count;
        break;
      case 'ArrowLeft':
        next = (index - 1 + count) % count;
        break;
      case 'ArrowDown':
        if (!radio) return;
        next = (index + 1) % count;
        break;
      case 'ArrowUp':
        if (!radio) return;
        next = (index - 1 + count) % count;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = count - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const option = enabledOptions[next];
    if (option === undefined) return;
    const segments = trackRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-segment-index]',
    );
    segments?.[options.indexOf(option)]?.focus();
    if (option.unavailable !== true && option.value !== value) {
      onChange(option.value);
    }
  };
  return (
    <div
      ref={trackRef}
      role={tabs ? 'tablist' : radio ? 'radiogroup' : 'group'}
      aria-label={label}
      aria-describedby={describedBy}
      onBlur={roving ? onTrackBlur : undefined}
      data-testid={dataTestId}
      className={`${TRACK_CLASS_NAME} ${TRACK_CORNER_CLASS_NAME[shape]} ${TRACK_WIDTH_CLASS_NAME[width]}${touchTarget ? ' pointer-coarse:h-auto' : ''}`.trim()}
    >
      {surface && (
        <span
          ref={surfaceRef}
          aria-hidden="true"
          data-testid={dataTestId ? `${dataTestId}-indicator` : undefined}
          className={`absolute inset-y-0.5 origin-top-left ${SEGMENT_CORNER_CLASS_NAME[shape]} ${SECONDARY_SURFACE_SHELL_CLASS}`}
          style={{ left: surface.left, width: surface.width }}
        />
      )}
      {options.map((option, index) => {
        const selected = option.value === value;
        const unavailable = option.unavailable === true;
        const iconOnly = option.icon !== undefined;
        const semanticProps = tabs
          ? {
              role: 'tab',
              'aria-selected': selected,
              id: option.id,
              'aria-controls': option.controls,
            }
          : radio
            ? { role: 'radio', 'aria-checked': selected }
            : { 'aria-pressed': selected };
        const segment = (
          <button
            key={option.value}
            type="button"
            {...semanticProps}
            // An unavailable option stays focusable so its tooltip can be
            // reached; only `disabled` takes a segment out of the tab order.
            aria-label={iconOnly ? option.label : undefined}
            aria-describedby={option.describedBy}
            aria-disabled={unavailable || undefined}
            disabled={disabled || option.disabled}
            data-segment-selected={selected}
            data-segment-index={index}
            {...(roving
              ? {
                  tabIndex: option.value === tabbableValue ? 0 : -1,
                  onFocus: (): void => setFocusedValue(option.value),
                  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>): void =>
                    onRovingKeyDown(event, option.value),
                }
              : {})}
            data-testid={option.dataTestId}
            onClick={(): void => {
              if (unavailable) option.onUnavailablePress?.();
              else onChange(option.value);
            }}
            className={`${segmentClassName(selected, unavailable, shape, iconOnly)}${touchTarget ? ' pointer-coarse:min-h-11 pointer-coarse:min-w-11' : ''}`}
          >
            {iconOnly ? (
              option.icon
            ) : (
              <>
                {option.leading}
                {option.label}
                {option.trailing}
              </>
            )}
          </button>
        );
        return option.tooltip ? (
          <Tooltip
            key={option.value}
            label={option.tooltip}
            link={option.tooltipLink}
          >
            {segment}
          </Tooltip>
        ) : (
          segment
        );
      })}
    </div>
  );
}
