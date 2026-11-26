'use client';

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import { Button } from '../primitives/Button';
import { ActionMenuRowStyle } from '../primitives/ActionMenuItems';
import {
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuItemIcon,
  DropdownMenuLabel,
} from '../primitives/DropdownMenu';
import { FLOATING_MENU_GAP, FloatingMenu } from '../primitives/FloatingMenu';
import { Tooltip } from '../primitives/Tooltip';

export interface DetailMoreMenuItem {
  readonly id: string;
  readonly label: string;
  /** The row's leading icon, as on every action menu row. */
  readonly icon: ReactNode;
  readonly testId: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  /** Shown beneath a disabled item, so every user sees what to do. */
  readonly reason?: string;
  /** Delete, Remove: last, below a divider, in the destructive tone. */
  readonly destructive?: boolean;
}

/**
 * One menu from a page's own rows and the rows its body contributes. The
 * page's rows keep the order it chose; the body's join just above the page's
 * first destructive row, so its Delete, Unshare or Remove stays last.
 */
export function orderDetailMoreItems(
  own: readonly DetailMoreMenuItem[],
  contributed: readonly DetailMoreMenuItem[],
): readonly DetailMoreMenuItem[] {
  if (contributed.length === 0) return own;
  const firstDestructive = own.findIndex((row) => row.destructive === true);
  if (firstDestructive === -1) return [...own, ...contributed];
  return [
    ...own.slice(0, firstDestructive),
    ...contributed,
    ...own.slice(firstDestructive),
  ];
}

export interface DetailMoreMenuProps {
  /** The item's name, for the trigger's and menu's accessible names. */
  readonly name: string;
  /** Visible items in menu order; a destructive item belongs last. */
  readonly items: readonly DetailMoreMenuItem[];
  readonly triggerTestId: string;
  readonly menuTestId: string;
  /**
   * The trigger's size: `compact`, the 28px circle a page header's actions
   * use. The deprecated `control` square is gone.
   */
  readonly size?: 'compact';
  /**
   * `secondary` (default) for a detail's action bar; `ghost` for a
   * header whose other controls are ghost, such as a Home section's.
   */
  readonly variant?: 'secondary' | 'ghost';
  /** Where the menu opens; a trigger at a right edge opens it leftwards. */
  readonly placement?: 'bottom-left' | 'bottom-right';
}

/**
 * The ⋯ More menu that leads a detail's action bar: rarer actions, with the
 * destructive one last below a divider (the host still confirms it). A
 * disabled item with a reason shows the reason beneath it, so keyboard and
 * pointer users both see what to do. Renders nothing when no item applies,
 * so the bar never shows an empty menu.
 */
export function DetailMoreMenu({
  name,
  items,
  triggerTestId,
  menuTestId,
  size = 'compact',
  variant = 'secondary',
  placement = 'bottom-left',
}: DetailMoreMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const menuId = useId();
  if (items.length === 0) return null;
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <Tooltip label="More actions">
          <Button
            variant={variant}
            size={size}
            iconOnly
            aria-label={`More actions for ${name}`}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-controls={open ? menuId : undefined}
            data-testid={triggerTestId}
            onClick={(): void => setOpen((current) => !current)}
          >
            <MoreHorizontalIcon size="sm" aria-hidden="true" />
          </Button>
        </Tooltip>
      </span>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement={placement}
        gap={FLOATING_MENU_GAP}
        interaction="menu"
        aria-label={`Actions for ${name}`}
        data-testid={menuTestId}
        className="min-w-44 max-w-64"
      >
        <DetailMoreMenuRows
          items={items}
          onClose={(): void => {
            setOpen(false);
            focusMenuTrigger(anchorRef.current);
          }}
        />
      </FloatingMenu>
    </>
  );
}

/**
 * Puts focus on a closing menu's trigger before its row runs, so a dialog the
 * row opens returns focus there rather than to the row that is going away.
 */
export function focusMenuTrigger(anchor: HTMLElement | null): void {
  anchor?.querySelector('button')?.focus({ preventScroll: true });
}

/**
 * The rows of a ⋯ More menu, for a menu that owns its own trigger (such as
 * the installed item's Uninstall menu) and adds host rows above its own.
 */
export function DetailMoreMenuRows({
  items,
  onClose,
}: {
  readonly items: readonly DetailMoreMenuItem[];
  readonly onClose: () => void;
}): JSX.Element {
  const reasonIdBase = useId();
  return (
    <ActionMenuRowStyle>
      {items.map((item, index) => {
        const reasonId = `${reasonIdBase}-${item.id}`;
        const explained = item.disabled === true && item.reason !== undefined;
        return (
          <Fragment key={item.id}>
            {item.destructive && index > 0 ? <DropdownMenuDivider /> : null}
            <DropdownMenuItem
              tone={item.destructive ? 'destructive' : 'default'}
              disabled={item.disabled}
              aria-describedby={explained ? reasonId : undefined}
              data-testid={item.testId}
              onClick={(): void => {
                onClose();
                item.onSelect();
              }}
            >
              <DropdownMenuItemIcon>{item.icon}</DropdownMenuItemIcon>
              {item.label}
            </DropdownMenuItem>
            {explained ? (
              // Only menu items may be children of a menu, so the reason is
              // hidden from the tree and read through `aria-describedby`.
              <DropdownMenuLabel
                id={reasonId}
                aria-hidden="true"
                className="whitespace-normal"
              >
                {item.reason}
              </DropdownMenuLabel>
            ) : null}
          </Fragment>
        );
      })}
    </ActionMenuRowStyle>
  );
}

const NO_ITEMS: readonly DetailMoreMenuItem[] = [];

interface DetailMoreItemsValue {
  readonly items: readonly DetailMoreMenuItem[];
  /** The body menu that lists the rows; the first mounted one. */
  readonly recipient: string | null;
  readonly claim: (menuId: string) => () => void;
}

const DetailMoreItemsContext = createContext<DetailMoreItemsValue | null>(null);

/**
 * Rows a detail host adds to the ⋯ More menu its body declares (a plugin's
 * Update beside the Status row's Uninstall), so the bar keeps one menu and at
 * most three visible actions. A body can declare several menus (one per
 * configuration of an account server); the rows join only one of them.
 */
export function DetailMoreItemsProvider({
  items,
  children,
}: {
  readonly items: readonly DetailMoreMenuItem[];
  readonly children: ReactNode;
}): JSX.Element {
  const [claimants, setClaimants] = useState<readonly string[]>([]);
  const claim = useCallback((menuId: string): (() => void) => {
    setClaimants((current) => [...current, menuId]);
    return (): void =>
      setClaimants((current) => current.filter((id) => id !== menuId));
  }, []);
  const value = useMemo(
    () => ({ items, recipient: claimants[0] ?? null, claim }),
    [claim, claimants, items],
  );
  return (
    <DetailMoreItemsContext.Provider value={value}>
      {children}
    </DetailMoreItemsContext.Provider>
  );
}

/** The host rows a body's own ⋯ More menu lists above its own. */
export function useDetailMoreItems(): readonly DetailMoreMenuItem[] {
  const menuId = useId();
  const host = useContext(DetailMoreItemsContext);
  const claim = host?.claim;
  useLayoutEffect(() => claim?.(menuId), [claim, menuId]);
  return host?.recipient === menuId ? host.items : NO_ITEMS;
}

type ContributeDetailMoreItems = (
  key: string,
  items: readonly DetailMoreMenuItem[] | null,
) => void;

const DetailMoreItemsContributionContext =
  createContext<ContributeDetailMoreItems | null>(null);

/**
 * Host side: collects the ⋯ rows its bodies contribute (a web install
 * panel's Reinstall), so the host lists them with its own rows in one menu.
 */
export function useDetailMoreItemContributions(): {
  readonly items: readonly DetailMoreMenuItem[];
  readonly contribute: ContributeDetailMoreItems;
} {
  const [byKey, setByKey] = useState<
    ReadonlyMap<string, readonly DetailMoreMenuItem[]>
  >(() => new Map());
  const contribute = useCallback<ContributeDetailMoreItems>((key, items) => {
    setByKey((current) => {
      const next = new Map(current);
      if (items === null) next.delete(key);
      else next.set(key, items);
      return next;
    });
  }, []);
  const items = useMemo(() => [...byKey.values()].flat(), [byKey]);
  return { items, contribute };
}

export function DetailMoreItemsContributionProvider({
  contribute,
  children,
}: {
  readonly contribute: ContributeDetailMoreItems;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <DetailMoreItemsContributionContext.Provider value={contribute}>
      {children}
    </DetailMoreItemsContributionContext.Provider>
  );
}

/**
 * Body side: offers rows to the enclosing host's ⋯ More menu. Returns false
 * outside such a host, so the body keeps showing the action itself. Rows are
 * re-sent only when what they show changes; selecting one always runs the
 * latest handler.
 */
export function useContributeDetailMoreItems(
  key: string,
  items: readonly DetailMoreMenuItem[],
): boolean {
  const contribute = useContext(DetailMoreItemsContributionContext);
  const latest = useRef(items);
  latest.current = items;
  // What a row shows, minus its icon: a row whose icon changes on its own
  // (a spinner) must also change its label (Reinstalling…) to be re-sent.
  const signature = items
    .map((item) =>
      [
        item.id,
        item.label,
        item.testId,
        item.disabled === true ? '1' : '0',
        item.reason ?? '',
        item.destructive === true ? '1' : '0',
      ].join('\u0000'),
    )
    .join('\u0001');
  useLayoutEffect(() => {
    if (!contribute) return undefined;
    contribute(
      key,
      latest.current.map((item) => ({
        ...item,
        onSelect: (): void =>
          latest.current
            .find((candidate) => candidate.id === item.id)
            ?.onSelect(),
      })),
    );
    return (): void => contribute(key, null);
  }, [contribute, key, signature]);
  return contribute !== null;
}
