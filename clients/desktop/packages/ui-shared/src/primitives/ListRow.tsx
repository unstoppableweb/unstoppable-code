import {
  createElement,
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ComponentPropsWithRef,
  type ComponentType,
  type HTMLAttributes,
  type JSX,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { RowActionTray } from './RowActions';
import {
  SIDEBAR_ITEM_IDLE_CLASSNAME,
  SIDEBAR_ITEM_SELECTED_CLASSNAME,
  SIDEBAR_NAV_ITEM_CLASSNAME,
} from './sidebar-item-classes';

/** 28px for compact activity rows, 32px by default, 40px for logos and pickers. */
export type ListRowSize = 'sm' | 'md' | 'lg';

/** The slots every row form shares. */
interface ListRowContentProps {
  /** The row's label. */
  readonly children: ReactNode;
  /** One line of secondary text under the label; the row grows to hold it. */
  readonly description?: ReactNode;
  /**
   * A glyph before the label: 14px at `sm`, 16px at `md`, 20px at `lg`. At
   * `lg` the slot grows for a larger logo.
   */
  readonly icon?: ReactNode;
  /** Quiet content at the end of the row: a time, a count, a chevron. */
  readonly trailing?: ReactNode;
  /**
   * The row the user is on; takes the selected fill instead of the hover.
   * Visual only: pass `aria-current` or `aria-selected` for what it means.
   */
  readonly selected?: boolean;
  /** The row's height. A description grows the row at every size. */
  readonly size?: ListRowSize;
  /**
   * Controls beside the row's main press, rendered as its siblings because a
   * control inside a `<button>` is invalid HTML. `trailing` stays quiet text.
   */
  readonly actions?: ReactNode;
  /**
   * Hide `actions` until the row is hovered or holds focus; on touch they
   * always show. `sm` and `md` reveal, `lg` keeps them visible. Pass `false`
   * to keep replacement controls up, like an inline delete confirmation,
   * after the trigger that opened them unmounts.
   */
  readonly actionsReveal?: boolean;
}

/** What a row's wrapper takes: test ids, dnd-kit attributes, hover handlers. */
export type ListRowRootProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'children' | 'className'
> &
  Readonly<Record<`data-${string}`, string | number | boolean | undefined>>;

export interface ListRowProps
  extends
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    ListRowContentProps {
  /**
   * Attributes for the wrapper around the main press. Setting this, like
   * `actions`, gives the row its wrapper. The other props stay on the press.
   */
  readonly rowProps?: ListRowRootProps;
  /** Keep the 44px hit area in a touch layout even with a fine pointer. */
  readonly touchTarget?: boolean;
  /**
   * Draw the focus ring inside the row, for a row in a container that clips
   * (`overflow-hidden`, a scroll viewport), where the outside ring is cut off.
   */
  readonly focusInset?: boolean;
}

/** The anchor a host renders for a `ListRowLink`, such as its router's link. */
export type ListRowLinkRenderProps = AnchorHTMLAttributes<HTMLAnchorElement> & {
  readonly href: string;
  readonly children: ReactNode;
};

export interface ListRowLinkProps
  extends
    Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'children' | 'href'>,
    ListRowContentProps {
  readonly href: string;
  /** A disabled link keeps its look, loses its `href` and swallows clicks. */
  readonly disabled?: boolean;
  /**
   * Handles a plain left click in place, such as navigating inside the app.
   * Cmd, Ctrl, Shift, Alt and middle clicks stay the browser's own.
   */
  readonly onNavigate?: (event: MouseEvent<HTMLAnchorElement>) => void;
  /**
   * Renders the anchor through the host's router; defaults to a plain `<a>`.
   * The row's `ref` reaches a plain `<a>` only.
   */
  readonly renderLink?: (props: ListRowLinkRenderProps) => ReactNode;
  /** Attributes for the wrapper `actions` adds. */
  readonly rowProps?: ListRowRootProps;
}

export interface ListRowStaticProps
  extends
    Omit<HTMLAttributes<HTMLDivElement>, 'children'>,
    ListRowContentProps {
  /** Greys the row's text. Its `actions` keep their own state. */
  readonly disabled?: boolean;
}

// The sidebar row's geometry (`SIDEBAR_LIST_ITEM_CLASSNAME`: row radius, 8px
// inset, 8px gap) for rows in page and panel content, so every list in the app
// shares one row. Touch keeps a 44px floor at every size.
//
// A disabled row greys its label, description, icon and trailing text
// together; the inner parts read `data-disabled` through the row's group, which
// works on all three elements a row can be. A disabled row stays the click
// target (a click is swallowed, not handed to what is behind it) and drops the
// hover fill instead: `data-disabled:` sorts after `hover:`, so it wins.
const ROW_CLASS_NAME =
  'flex gap-2 overflow-hidden rounded-row px-2 text-left font-normal pointer-coarse:min-h-11 data-disabled:cursor-not-allowed data-disabled:fg-disabled';

// With `actions` the row is a wrapper holding the press and its siblings. The
// press's `::before` covers the wrapper, so the whole row presses with no
// click forwarding and modifier keys stay native; the actions sit above it.
const STRETCHED_PRESS_CLASS_NAME =
  'focus-ring focus-ring-stretched before:absolute before:inset-0 before:rounded-row';

const ROOT_CLASS_NAME = 'group group/list-row relative flex rounded-row';

const ACTIONS_CLASS_NAME =
  'relative z-10 flex shrink-0 items-center gap-0.5 self-center pr-1 pointer-coarse:gap-4';

const DISABLED_INK_CLASS_NAME = 'group-data-disabled/list-row:fg-disabled';

const IDLE_FILL_CLASS_NAME = `${SIDEBAR_ITEM_IDLE_CLASSNAME} data-disabled:bg-transparent`;

const SIZE_CLASS_NAMES: Record<
  ListRowSize,
  {
    readonly text: string;
    readonly oneLine: string;
    readonly twoLine: string;
    readonly icon: string;
    readonly description: string;
  }
> = {
  sm: {
    text: 'text-xs',
    oneLine: 'h-7 items-center whitespace-nowrap',
    twoLine: 'min-h-7 items-start py-1',
    icon: 'h-4 w-3.5',
    description: 'text-2xs',
  },
  md: {
    text: 'text-s',
    oneLine: 'h-8 items-center whitespace-nowrap',
    twoLine: 'min-h-8 items-start py-1.5',
    icon: 'h-5 w-4',
    description: 'text-xs',
  },
  lg: {
    text: 'text-s',
    oneLine: 'h-10 items-center whitespace-nowrap',
    twoLine: 'min-h-10 items-start py-1.5',
    icon: 'min-h-5 min-w-5',
    description: 'text-xs',
  },
};

function hasContent(node: ReactNode): boolean {
  return node !== undefined && node !== null && node !== false;
}

function shapeClassName(size: ListRowSize, description: ReactNode): string {
  const { text, oneLine, twoLine } = SIZE_CLASS_NAMES[size];
  return `${text} ${hasContent(description) ? twoLine : oneLine}`;
}

/** A row's fill. A static row has no press, so it never takes the hover. */
function fillClassName(selected: boolean, pressable: boolean): string {
  if (selected) return SIDEBAR_ITEM_SELECTED_CLASSNAME;
  return pressable ? IDLE_FILL_CLASS_NAME : 'fg-primary';
}

function joinClassNames(...classNames: readonly string[]): string {
  return classNames.filter((className) => className !== '').join(' ');
}

/** The classes of the `<button>` or `<a>` a row presses. */
function pressClassName({
  wrapped,
  fill,
  size,
  description,
  className,
  focusInset = false,
}: {
  readonly focusInset?: boolean;
  readonly wrapped: boolean;
  readonly fill: string;
  readonly size: ListRowSize;
  readonly description: ReactNode;
  readonly className: string;
}): string {
  return joinClassNames(
    wrapped
      ? `${STRETCHED_PRESS_CLASS_NAME} min-w-0 flex-1`
      : `focus-ring group/list-row w-full ${fill}`,
    ROW_CLASS_NAME,
    shapeClassName(size, description),
    focusInset ? 'focus-ring-inset' : '',
    wrapped ? '' : className,
  );
}

function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function swallowClick(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

function ListRowContent({
  children,
  description,
  icon,
  trailing,
  size,
}: {
  readonly children: ReactNode;
  readonly description: ReactNode;
  readonly icon: ReactNode;
  readonly trailing: ReactNode;
  readonly size: ListRowSize;
}): JSX.Element {
  const sizeClassNames = SIZE_CLASS_NAMES[size];
  return (
    <>
      {icon !== undefined && (
        // The sidebar's icon slot at `md`, 20px tall to match the label's line,
        // so the glyph centres on the first line in the two-line form too.
        <span
          className={`inline-flex ${sizeClassNames.icon} shrink-0 items-center justify-center fg-secondary ${DISABLED_INK_CLASS_NAME}`}
        >
          {icon}
        </span>
      )}
      {hasContent(description) ? (
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{children}</span>
          <span
            className={`truncate ${sizeClassNames.description} fg-secondary ${DISABLED_INK_CLASS_NAME}`}
          >
            {description}
          </span>
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate">{children}</span>
      )}
      {trailing !== undefined && (
        <span
          className={`ml-auto inline-flex h-5 shrink-0 items-center text-xs tabular-nums fg-quaternary ${DISABLED_INK_CLASS_NAME}`}
        >
          {trailing}
        </span>
      )}
    </>
  );
}

/** The wrapper of a row with actions: holds the fill, the press and the actions. */
function ListRowRoot({
  actions,
  reveal,
  fill,
  className,
  disabled,
  rootProps,
  rootRef,
  children,
}: {
  readonly actions: ReactNode;
  readonly reveal: boolean;
  readonly fill: string;
  readonly className: string;
  readonly disabled: boolean;
  readonly rootProps?: ListRowRootProps;
  readonly rootRef?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      {...rootProps}
      ref={rootRef}
      data-disabled={disabled ? '' : undefined}
      className={joinClassNames(ROOT_CLASS_NAME, fill, className)}
    >
      {children}
      {hasContent(actions) &&
        (reveal ? (
          <RowActionTray inRowOnTouch>{actions}</RowActionTray>
        ) : (
          <div className={ACTIONS_CLASS_NAME}>{actions}</div>
        ))}
    </div>
  );
}

/**
 * A full-width clickable row that opens or selects something: a pipeline step,
 * a connector, a file. Actions beside the row go in `actions` and stay
 * `Button`s; the row itself is this. A row that navigates is `ListRowLink`,
 * and a row with no main press is `ListRowStatic`.
 */
export const ListRow = forwardRef<HTMLButtonElement, ListRowProps>(
  function ListRow(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      size = 'md',
      actions,
      actionsReveal = size !== 'lg',
      rowProps,
      touchTarget = false,
      focusInset = false,
      className = '',
      type = 'button',
      disabled = false,
      onClick,
      ...buttonProps
    },
    ref,
  ): JSX.Element {
    // `aria-disabled` keeps the row focusable, so a keyboard reaches the reason
    // its `aria-describedby` names; the native attribute would drop it.
    const softDisabled =
      buttonProps['aria-disabled'] === true ||
      buttonProps['aria-disabled'] === 'true';
    const inactive = disabled || softDisabled;
    const wrapped = hasContent(actions) || rowProps !== undefined;
    const fill = fillClassName(selected, true);
    const press = (
      <button
        {...buttonProps}
        ref={ref}
        type={type}
        disabled={disabled}
        onClick={softDisabled ? swallowClick : onClick}
        data-disabled={inactive ? '' : undefined}
        className={joinClassNames(
          pressClassName({
            wrapped,
            fill,
            size,
            description,
            className,
            focusInset,
          }),
          touchTarget ? 'min-h-11' : '',
        )}
      >
        <ListRowContent
          description={description}
          icon={icon}
          trailing={trailing}
          size={size}
        >
          {children}
        </ListRowContent>
      </button>
    );
    if (!wrapped) return press;
    return (
      <ListRowRoot
        actions={actions}
        reveal={actionsReveal}
        fill={fill}
        className={`w-full ${className}`.trim()}
        disabled={inactive}
        rootProps={rowProps}
      >
        {press}
      </ListRowRoot>
    );
  },
);

ListRow.displayName = 'ListRow';

/**
 * `ListRow` for a row that goes somewhere: a real link, so Cmd-click and the
 * context menu work. `ui-shared` never imports a router, so a host's link comes
 * in through `renderLink`.
 */
export const ListRowLink = forwardRef<HTMLAnchorElement, ListRowLinkProps>(
  function ListRowLink(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      size = 'md',
      actions,
      actionsReveal = size !== 'lg',
      rowProps,
      href,
      disabled = false,
      onNavigate,
      renderLink,
      onClick,
      className = '',
      ...anchorProps
    },
    ref,
  ): JSX.Element {
    const wrapped = hasContent(actions) || rowProps !== undefined;
    const fill = fillClassName(selected, true);
    const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
      onClick?.(event);
      if (
        onNavigate === undefined ||
        event.defaultPrevented ||
        !isPlainClick(event)
      ) {
        return;
      }
      event.preventDefault();
      onNavigate(event);
    };
    const linkClassName = pressClassName({
      wrapped,
      fill,
      size,
      description,
      className,
    });
    const content = (
      <ListRowContent
        description={description}
        icon={icon}
        trailing={trailing}
        size={size}
      >
        {children}
      </ListRowContent>
    );
    let link: ReactNode;
    if (disabled) {
      link = (
        <a
          {...anchorProps}
          ref={ref}
          aria-disabled="true"
          data-disabled=""
          onClick={swallowClick}
          className={linkClassName}
        >
          {content}
        </a>
      );
    } else if (renderLink !== undefined) {
      link = renderLink({
        ...anchorProps,
        href,
        onClick: handleClick,
        className: linkClassName,
        children: content,
      });
    } else {
      link = (
        <a
          {...anchorProps}
          ref={ref}
          href={href}
          onClick={handleClick}
          className={linkClassName}
        >
          {content}
        </a>
      );
    }
    if (!wrapped) return <>{link}</>;
    return (
      <ListRowRoot
        actions={actions}
        reveal={actionsReveal}
        fill={fill}
        className={`w-full ${className}`.trim()}
        disabled={disabled}
        rootProps={rowProps}
      >
        {link}
      </ListRowRoot>
    );
  },
);

ListRowLink.displayName = 'ListRowLink';

/**
 * A `ListRow` with no main press: it opens and selects nothing, so it takes no
 * hover fill. Its controls go in `actions`, and the row itself is a plain `div`
 * that takes any attribute a wrapper needs (dnd-kit, test ids).
 */
export const ListRowStatic = forwardRef<HTMLDivElement, ListRowStaticProps>(
  function ListRowStatic(
    {
      children,
      description,
      icon,
      trailing,
      selected = false,
      size = 'md',
      actions,
      actionsReveal = size !== 'lg',
      disabled = false,
      className = '',
      ...divProps
    },
    ref,
  ): JSX.Element {
    const fill = fillClassName(selected, false);
    const content = (
      <ListRowContent
        description={description}
        icon={icon}
        trailing={trailing}
        size={size}
      >
        {children}
      </ListRowContent>
    );
    if (!hasContent(actions)) {
      return (
        <div
          {...divProps}
          ref={ref}
          data-disabled={disabled ? '' : undefined}
          className={joinClassNames(
            'group/list-row w-full',
            fill,
            ROW_CLASS_NAME,
            shapeClassName(size, description),
            className,
          )}
        >
          {content}
        </div>
      );
    }
    return (
      <ListRowRoot
        actions={actions}
        reveal={actionsReveal}
        fill={fill}
        className={`w-full ${className}`.trim()}
        disabled={disabled}
        rootProps={divProps}
        rootRef={ref}
      >
        <div
          className={joinClassNames(
            'min-w-0 flex-1',
            ROW_CLASS_NAME,
            shapeClassName(size, description),
          )}
        >
          {content}
        </div>
      </ListRowRoot>
    );
  },
);

ListRowStatic.displayName = 'ListRowStatic';

const LIST_ROW_FRAME_LAYOUT = {
  'archive-menu':
    'flex w-full items-center gap-2 rounded-md pr-2 transition-colors hover:bg-subtle has-[>button:first-child:focus-visible]:bg-subtle',
  'archive-overview':
    'group relative flex w-full items-center rounded-md transition-colors hover:bg-subtle pointer-coarse:min-h-11',
  'customize-installed':
    'group/skill-row relative -ml-4 flex min-w-0 items-center gap-2 rounded-xl pr-4 transition-colors hover:bg-subtle',
  'question-choice':
    'group/option flex w-full rounded-lg text-left hover:bg-subtle has-[:focus-visible]:bg-subtle',
  'queued-message-tray': 'flex h-9 min-w-0 items-center gap-2.5 px-3 text-s',
  'queued-message-drawer':
    'group/drawer-item flex h-9 min-w-0 items-center gap-2.5 rounded-drawer-row pl-2.75 pr-1 text-s hover:bg-subtle data-[dragging]:bg-muted',
  'workspace-header':
    'min-w-0 flex-1 rounded-md px-1.5 py-1.5 fg-primary/80 transition-colors hover:bg-subtle hover:fg-primary',
  'workspace-header-sidebar':
    'min-w-0 flex-1 h-8 rounded-row py-0 pl-1.5 pr-1 fg-primary transition-colors hover:bg-subtle',
  'workspace-header-sidebar-touch':
    'min-w-0 flex-1 min-h-11 rounded-row py-0 pl-1.5 pr-1 fg-primary transition-colors hover:bg-subtle',

  'file-overlap': 'flex flex-col gap-1 px-3 py-2.5 transition-colors',
  'sidebar-workspace':
    'group/header group/sidebar-item relative flex h-8 items-center gap-1.5 rounded-row pl-1.5 pr-1 fg-primary transition-colors',
  'sidebar-customize': `${SIDEBAR_NAV_ITEM_CLASSNAME} cursor-default fg-primary`,
  'harness-board':
    'group relative flex h-8 cursor-grab items-center gap-2 rounded-md px-2 text-s fg-primary/80 transition-colors',
  'priority-preview':
    'flex cursor-default items-center gap-2.5 rounded-md px-3 py-2 text-s font-normal fg-primary',
  'tray-modal': 'group/row group/drawer-item flex flex-col rounded-lg',
  'tray-drawer': 'group/row group/drawer-item flex flex-col rounded-drawer-row',
  'tray-header-modal': 'relative flex h-9 min-w-0 items-center pr-3 text-s',
  'tray-header-legacy':
    'relative flex h-9 min-w-0 items-center gap-3 pr-1 text-s',
  'tray-header-compact':
    'relative flex h-9 min-w-0 items-center gap-2.5 pr-1 text-s',
  'linked-memory': 'group flex items-start gap-1 rounded-lg pr-1.5',
  'project-columns': 'col-span-full grid grid-cols-subgrid items-center py-2',
  'project-inline': 'flex items-center gap-3 py-2',
  'sidebar-account':
    'min-w-0 flex-1 focus-ring flex w-full items-center gap-2 overflow-hidden whitespace-nowrap rounded-row px-2 py-0 text-s font-normal fg-primary pointer-coarse:min-h-11',
  'sidebar-archive': 'group relative flex min-w-0 items-center rounded-row',
  'changed-file': 'group flex items-center gap-2 px-3 py-1',
  // Focusable (the worktree row's frame takes the keyboard): the shared ring
  // on the row's own corners. Inset, because the rail clips its rows at the
  // sides and an outside ring loses its left and right edges there.
  'sidebar-bare': 'focus-ring focus-ring-inset flex w-full min-w-0 rounded-row',
  'sidebar-default':
    'flex w-full min-w-0 group items-center gap-2 rounded-row min-h-8 px-2 py-1.5',
  'sidebar-compact':
    'flex w-full min-w-0 group items-center gap-2 rounded-row min-h-7 px-2 py-1',
  'sidebar-touch':
    'flex w-full min-w-0 group items-center gap-2 rounded-row min-h-11 px-3 py-2',
  'workspace-repository':
    'group flex items-center gap-2 rounded-md px-2 py-1.5 text-s',
} as const;

const LIST_ROW_FRAME_STATE = {
  resting: '',
  'compact-control': 'flex-nowrap',
  'wrapping-control': 'flex-wrap',

  disabled: '',
  pressable: 'cursor-pointer hover:bg-subtle',
  'sidebar-idle': 'hover:bg-subtle',
  'sidebar-dragging': 'opacity-60 hover:bg-subtle',
  'drag-preview': 'bg-card shadow-md',
  'repo-idle': 'hover:bg-secondary',
  'repo-removing': 'opacity-60 hover:bg-secondary',
  'harness-idle': 'focus-within:bg-subtle hover:bg-subtle',
  'harness-dragging': 'focus-within:bg-subtle hover:bg-subtle opacity-40',
  'tray-open': 'bg-subtle',
  'tray-header-closed': 'rounded-lg hover:bg-subtle',
  'project-activatable': 'relative cursor-pointer rounded-sm hover:bg-subtle',
  'account-tall': 'h-10 hover:bg-subtle',
  'account-default': 'h-8 hover:bg-subtle',
  'file-selectable':
    'cursor-pointer rounded-md transition-colors hover:bg-subtle',
  'sidebar-interactive': 'focus-ring cursor-pointer hover:bg-subtle',
  'sidebar-selected': 'bg-muted fg-primary',
  'sidebar-selected-interactive':
    'bg-muted fg-primary focus-ring cursor-pointer',
} as const;

type CompositeListRowPresentation =
  | {
      presentation: 'workflow-card' | 'sidebar-activity' | 'inline-actions';
      appearance?: never;
    }
  | { presentation: 'surface'; className: string; appearance?: never }
  | {
      presentation: 'standalone-chat';
      appearance: {
        height: 'touch' | 'two-lines' | 'single-line';
        state: 'selected' | 'archived' | 'active';
        archiving: boolean;
        /** Its menu is open: the row keeps its hover fill, as other rows do. */
        menuMarked?: boolean;
      };
    }
  | {
      presentation: 'work-entry';
      appearance: {
        touchTarget: boolean;
        draggable: boolean;
        dragging: boolean;
        selected: boolean;
        menuMarked: boolean;
        removing: boolean;
      };
    };

type CompositeListRowProps = Omit<HTMLAttributes<HTMLDivElement>, 'className'> &
  CompositeListRowPresentation;

function compositeListRowClassName(
  props: CompositeListRowPresentation,
): string {
  switch (props.presentation) {
    case 'workflow-card':
      return 'focus-ring cursor-pointer';
    case 'sidebar-activity':
      return 'focus-ring rounded-row outline-none';
    case 'inline-actions':
      return 'focus-ring flex items-center justify-between gap-2 rounded-row px-2 text-s';
    case 'surface':
      return props.className;
    case 'standalone-chat': {
      const { height, state, archiving, menuMarked } = props.appearance;
      const heightClass = {
        touch: 'min-h-11',
        'two-lines': 'min-h-8 py-1',
        'single-line': 'h-8 py-0',
      }[height];
      const stateClass = {
        selected: 'bg-muted fg-primary',
        archived: 'fg-tertiary hover:bg-subtle',
        active: 'fg-secondary hover:bg-subtle',
      }[state];
      return `focus-ring group group/sidebar-item flex w-full min-w-0 cursor-pointer items-center ${heightClass} gap-1.5 rounded-row px-1.5 text-left text-s transition-colors ${stateClass}${menuMarked && state !== 'selected' ? ' bg-subtle' : ''} ${archiving ? 'pointer-events-none opacity-50' : ''}`;
    }
    case 'work-entry': {
      const {
        touchTarget,
        draggable,
        dragging,
        selected,
        menuMarked,
        removing,
      } = props.appearance;
      const stateClass = selected
        ? 'bg-muted fg-primary'
        : `fg-secondary hover:bg-subtle${menuMarked ? ' bg-subtle' : ''}`;
      return `focus-ring group group/sidebar-item relative flex ${touchTarget ? 'min-h-11' : 'h-8'} w-full items-center gap-1.5 rounded-row px-1.5 py-0 text-left text-s transition-opacity ${draggable ? 'pointer-fine:touch-none select-none' : ''} ${stateClass} ${removing ? 'pointer-events-none opacity-50' : ''} ${dragging ? 'opacity-50' : ''}`;
    }
  }
}

/**
 * A keyboard-operable row whose controls must remain independent of the row
 * action. Use ListRow when the action contains no focusable children.
 */
export const CompositeListRow = forwardRef<
  HTMLDivElement,
  CompositeListRowProps
>(function CompositeListRow(props, ref): JSX.Element {
  const { tabIndex = 0, onKeyDown, presentation, ...domProps } = props;
  delete domProps.appearance;
  return (
    <div
      {...domProps}
      className={compositeListRowClassName(props)}
      data-composite-row={presentation}
      ref={ref}
      role="button"
      tabIndex={tabIndex}
      onKeyDown={(event): void => {
        if (onKeyDown) {
          onKeyDown(event);
          return;
        }
        if (
          event.target !== event.currentTarget ||
          (event.key !== 'Enter' && event.key !== ' ')
        ) {
          return;
        }
        event.preventDefault();
        if (
          props['aria-disabled'] !== true &&
          props['aria-disabled'] !== 'true'
        )
          event.currentTarget.click();
      }}
    />
  );
});

export type ListRowFrameProps<Tag extends 'div' | 'li' = 'div'> =
  ComponentPropsWithRef<Tag> & {
    readonly as?: Tag;
    readonly layout: keyof typeof LIST_ROW_FRAME_LAYOUT;
    readonly state?: keyof typeof LIST_ROW_FRAME_STATE;
  };

/** Provides shared styling for rows with custom contents and controls. */
export function ListRowFrame<Tag extends 'div' | 'li' = 'div'>({
  as,
  layout,
  state = 'resting',
  className = '',
  ...props
}: ListRowFrameProps<Tag>): JSX.Element {
  return createElement(as ?? 'div', {
    ...props,
    className: joinClassNames(
      LIST_ROW_FRAME_LAYOUT[layout],
      LIST_ROW_FRAME_STATE[state],
      className,
    ),
  });
}

const LIST_ROW_LINK_FRAME_LAYOUT = {
  'section-card':
    'group flex items-start justify-between gap-4 rounded-xl bg-card p-5 shadow-sm transition-colors hover:bg-secondary',
  'detail-inset':
    'flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-secondary',
  // A sidebar footer link (web's Archived and deleted) is a nav row: the same
  // geometry, hover and current-page fill as every other row in the rail, and
  // the same 44px minimum on touch.
  'sidebar-secondary': `${SIDEBAR_NAV_ITEM_CLASSNAME} ${SIDEBAR_ITEM_IDLE_CLASSNAME} pointer-coarse:min-h-11 aria-[current=page]:bg-muted`,
  'queue-position':
    'focus-ring grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-subtle',
  'queue-position-current':
    'focus-ring grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors bg-warning-subtle hover:bg-warning-subtle/80',
} as const;

interface ListRowLinkFrameProps extends Omit<
  ListRowLinkRenderProps,
  'className'
> {
  readonly layout: keyof typeof LIST_ROW_LINK_FRAME_LAYOUT;
  /** Keep router prefetch and navigation on a host that provides them. */
  readonly as?: ComponentType<ListRowLinkRenderProps>;
}

/** Link row with a structured body such as a card, detail list, or queue grid. */
export function ListRowLinkFrame({
  as: Link,
  layout,
  ...props
}: ListRowLinkFrameProps): JSX.Element {
  const className = LIST_ROW_LINK_FRAME_LAYOUT[layout];
  if (Link) return <Link {...props} className={className} />;
  return <a {...props} className={className} />;
}
