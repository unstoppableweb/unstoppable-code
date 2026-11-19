import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

export interface DetailActionBarProps {
  /**
   * The ⋯ More menu, which leads the secondaries. It holds rarer actions and
   * the destructive one, last below a divider.
   */
  more?: ReactNode;
  /**
   * Quieter page actions (Update, Reinstall, Edit, Configure, and leftmost a
   * confirmed Delete, Remove or Disconnect), in reading order.
   */
  secondary?: ReactNode;
  /** The Marketplace Share, always immediately before the primary action. */
  share?: ReactNode;
  /** The one accent action (Add, Install, Connect, Open), always last. */
  primary?: ReactNode;
  /**
   * Slots a page shell opens for actions its body declares through
   * `DetailPageActions`. Body secondaries follow the shell's own; a body
   * primary takes the last place.
   */
  slots?: DetailActionSlots;
  dataTestId?: string;
}

/** DOM targets a shell's bar exposes to the body's `DetailPageActions`. */
export interface DetailActionSlots {
  more: HTMLElement | null;
  secondary: HTMLElement | null;
  share: HTMLElement | null;
  primary: HTMLElement | null;
  setMore: (node: HTMLElement | null) => void;
  setSecondary: (node: HTMLElement | null) => void;
  setShare: (node: HTMLElement | null) => void;
  setPrimary: (node: HTMLElement | null) => void;
  /** Body declarations currently mounted, so the shell can show its row. */
  declared: number;
  register: () => () => void;
  /**
   * Body ⋯ More menus currently mounted, so a shell with rows of its own adds
   * them to that menu instead of drawing a second one.
   */
  moreDeclared: number;
  registerMore: () => () => void;
}

/**
 * The one action layout every detail uses: `[secondary…] [Share] [Primary]`
 * at the top right of the Back row, or of a dialog's title bar before its
 * close control. Without a primary action Share is rightmost. Progress,
 * errors and form submits stay in the body; only page-level actions belong
 * here. Hosts pass slots, never reorder them.
 */
export function DetailActionBar({
  more,
  secondary,
  share,
  primary,
  slots,
  dataTestId = 'detail-action-bar',
}: DetailActionBarProps): JSX.Element | null {
  const intoShell = useContext(DetailActionBarIntoShellContext);
  const shellSlots = useContext(DetailActionSlotsContext);
  if (!slots && !more && !secondary && !share && !primary) return null;
  // On a title row that shows the shell's bar, the page's actions take the
  // shell's slots, so the row keeps one `[⋯] [secondary] [Share] [primary]`.
  if (!slots && intoShell && shellSlots)
    return (
      <DetailPageActions
        more={more}
        secondary={secondary}
        share={share}
        primary={primary}
      />
    );
  return (
    <div
      className="flex min-w-0 flex-wrap items-center justify-end gap-2"
      data-testid={dataTestId}
    >
      {more}
      {slots && <span ref={slots.setMore} className="contents" />}
      {secondary}
      {slots && <span ref={slots.setSecondary} className="contents" />}
      {share}
      {slots && <span ref={slots.setShare} className="contents" />}
      {primary}
      {slots && <span ref={slots.setPrimary} className="contents" />}
    </div>
  );
}

/** Shell side: the slot targets its `DetailActionBar` and body share. */
export function useDetailActionSlots(): DetailActionSlots {
  const [more, setMore] = useState<HTMLElement | null>(null);
  const [secondary, setSecondary] = useState<HTMLElement | null>(null);
  const [share, setShare] = useState<HTMLElement | null>(null);
  const [primary, setPrimary] = useState<HTMLElement | null>(null);
  const [declared, setDeclared] = useState(0);
  const register = useCallback((): (() => void) => {
    setDeclared((count) => count + 1);
    return () => setDeclared((count) => count - 1);
  }, []);
  const [moreDeclared, setMoreDeclared] = useState(0);
  const registerMore = useCallback((): (() => void) => {
    setMoreDeclared((count) => count + 1);
    return () => setMoreDeclared((count) => count - 1);
  }, []);
  return useMemo(
    () => ({
      more,
      secondary,
      share,
      primary,
      setMore,
      setSecondary,
      setShare,
      setPrimary,
      declared,
      register,
      moreDeclared,
      registerMore,
    }),
    [
      more,
      secondary,
      share,
      primary,
      declared,
      register,
      moreDeclared,
      registerMore,
    ],
  );
}

const DetailActionSlotsContext = createContext<DetailActionSlots | null>(null);

/**
 * Set by a layout whose title row shows the shell's bar: a page
 * `DetailActionBar` inside it renders into the shell's slots.
 */
const DetailActionBarIntoShellContext = createContext(false);

export function DetailActionBarIntoShell({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <DetailActionBarIntoShellContext.Provider value={true}>
      {children}
    </DetailActionBarIntoShellContext.Provider>
  );
}

export function DetailActionSlotsProvider({
  slots,
  children,
}: {
  slots: DetailActionSlots;
  children: ReactNode;
}): JSX.Element {
  return (
    <DetailActionSlotsContext.Provider value={slots}>
      {children}
    </DetailActionSlotsContext.Provider>
  );
}

export interface DetailPageActionsProps {
  /** A ⋯ More menu; it leads the bar's secondaries. */
  more?: ReactNode;
  secondary?: ReactNode;
  /** A Share the body owns, for a shell that renders none of its own. */
  share?: ReactNode;
  primary?: ReactNode;
}

/**
 * Body side: declares a detail's own page actions, which render in the
 * enclosing shell's action bar beside its Share while their state stays in
 * the body. Outside a shell they render as a standalone bar in place.
 */
export function DetailPageActions({
  more,
  secondary,
  share,
  primary,
}: DetailPageActionsProps): JSX.Element | null {
  const slots = useContext(DetailActionSlotsContext);
  const register = slots?.register;
  const registerMore = slots?.registerMore;
  const hasActions = Boolean(more || secondary || share || primary);
  const hasMore = Boolean(more);
  useLayoutEffect(
    () => (hasActions ? register?.() : undefined),
    [register, hasActions],
  );
  useLayoutEffect(
    () => (hasMore ? registerMore?.() : undefined),
    [registerMore, hasMore],
  );
  if (!slots) {
    return (
      <DetailActionBar
        more={more}
        secondary={secondary}
        share={share}
        primary={primary}
      />
    );
  }
  return (
    <>
      {more && slots.more && createPortal(more, slots.more)}
      {secondary && slots.secondary && createPortal(secondary, slots.secondary)}
      {share && slots.share && createPortal(share, slots.share)}
      {primary && slots.primary && createPortal(primary, slots.primary)}
    </>
  );
}

/**
 * A page shell's own actions (its Share, ⋯ rows and body-declared slots),
 * which a body's `CapabilityDetailLayout` claims for its title row (New
 * Customize). While claimed, the shell leaves its Back-row bar out.
 */
interface DetailHeaderActionsHost {
  readonly actions: ReactNode;
  readonly claimed: boolean;
  readonly claim: () => () => void;
}

const DetailHeaderActionsContext =
  createContext<DetailHeaderActionsHost | null>(null);

/** Shell side: offers its bar to a layout and says whether one claimed it. */
export function useDetailHeaderActionsHost(actions: ReactNode): {
  readonly host: DetailHeaderActionsHost;
  readonly claimed: boolean;
} {
  const [claims, setClaims] = useState(0);
  const claim = useCallback((): (() => void) => {
    setClaims((count) => count + 1);
    return () => setClaims((count) => count - 1);
  }, []);
  const claimed = claims > 0;
  const host = useMemo(
    () => ({ actions, claimed, claim }),
    [actions, claimed, claim],
  );
  return { host, claimed };
}

export function DetailHeaderActionsProvider({
  host,
  children,
}: {
  host: DetailHeaderActionsHost;
  children: ReactNode;
}): JSX.Element {
  return (
    <DetailHeaderActionsContext.Provider value={host}>
      {children}
    </DetailHeaderActionsContext.Provider>
  );
}

/**
 * Layout side: claims the enclosing shell's actions and returns them once the
 * shell has let go of its own row, so the bar (and its portal slots) mounts
 * in one place at a time.
 */
export function useDetailHeaderActionsClaim(): ReactNode {
  const host = useContext(DetailHeaderActionsContext);
  const claim = host?.claim;
  useLayoutEffect(() => claim?.(), [claim]);
  return host?.claimed ? host.actions : null;
}
