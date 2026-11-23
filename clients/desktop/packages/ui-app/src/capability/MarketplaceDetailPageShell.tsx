import type { JSX, ReactNode } from 'react';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  Button,
  DetailActionBar,
  DetailActionSlotsProvider,
  DetailHeader,
  DetailHeaderActionsProvider,
  DetailMoreItemsContributionProvider,
  DetailMoreItemsProvider,
  DetailMoreMenu,
  orderDetailMoreItems,
  useDetailActionSlots,
  useDetailHeaderActionsHost,
  useDetailMoreItemContributions,
  type DetailMoreMenuItem,
  Heading,
} from '@canopy/ui-shared/components';
import { ChevronLeftMediumIcon as AppCatalogChevronLeftMediumIcon } from '@canopy/ui-shared/icons/AppIcons';

/** The item header the shell renders in place of its Back row (CAN-4266). */
export interface MarketplaceDetailPageHeader {
  /** One line under the title saying what the item is. */
  description?: ReactNode;
  /** Quiet facts under the description: author, audience. */
  meta?: readonly ReactNode[];
}

export interface MarketplaceDetailPageShellProps {
  title: string;
  privateTitle?: boolean;
  onNavigateBack?: () => void;
  /**
   * Secondary page actions for the standard action bar at the top right of
   * the Back row: `[secondary…] [Share] [Primary]`. Bodies declare their own
   * through `DetailPageActions`, which join the same bar.
   */
  headerActions?: ReactNode;
  /** The Marketplace Share, placed immediately before the primary action. */
  share?: ReactNode;
  breadcrumbs?: ReactNode;
  contentOwnsTitle?: boolean;
  /**
   * `constrained` (default) centers the page in the reading column every
   * existing desktop and portal detail host relies on; `fluid` fills the
   * host's container so a host that owns its own width — the public
   * Marketplace landers (CAN-2989) — can lay out beside an aside.
   */
  width?: 'constrained' | 'fluid';
  /**
   * Renders the item's `DetailHeader` (title, description, meta) with the
   * actions beside the title, `[⋯ More] [secondary…] [Share] [Primary]`,
   * instead of the Back row: the breadcrumb is the way back. Bodies then
   * leave the title to the shell and declare their actions as before.
   */
  header?: MarketplaceDetailPageHeader;
  /**
   * Rarer actions for the page's one ⋯ More menu, in the header or the action
   * bar; rows bodies contribute join it above the page's destructive rows.
   */
  moreItems?: readonly DetailMoreMenuItem[];
  children: ReactNode;
}

/** Browser-safe page chrome shared by marketplace detail surfaces. */
export function MarketplaceDetailPageShell({
  title,
  privateTitle = false,
  onNavigateBack,
  headerActions,
  share,
  breadcrumbs,
  contentOwnsTitle = false,
  width = 'constrained',
  header,
  moreItems = [],
  children,
}: MarketplaceDetailPageShellProps): JSX.Element {
  const slots = useDetailActionSlots();
  // Rows bodies offer to the ⋯ menu join a menu the body declares; with none,
  // the shell draws the menu.
  const contributedMore = useDetailMoreItemContributions();
  const unclaimedMore =
    slots.moreDeclared === 0 ? contributedMore.items : undefined;
  // The page's own rows and the body's join ONE menu; the page's Delete or
  // Unshare stays last.
  // A private title stays out of the menu's aria-labels, which session replay
  // does not mask.
  const menuName = privateTitle ? 'this page' : title;
  const menuRows = orderDetailMoreItems(moreItems, unclaimedMore ?? []);
  const fallbackMore =
    slots.moreDeclared === 0 && menuRows.length > 0 ? (
      <DetailMoreMenu
        name={menuName}
        items={menuRows}
        triggerTestId="plugins-entry-detail-more"
        menuTestId="plugins-entry-detail-menu"
        placement="bottom-right"
      />
    ) : undefined;
  const hasActions = Boolean(
    headerActions || share || fallbackMore || slots.declared > 0,
  );
  const shellBar = (
    <DetailActionBar
      more={fallbackMore}
      secondary={headerActions}
      share={share}
      slots={slots}
    />
  );
  // New Customize: a body's `CapabilityDetailLayout` draws this bar on its
  // title row instead, so the Back row keeps only the breadcrumb.
  const headerActionsHost = useDetailHeaderActionsHost(shellBar);
  const barClaimed = headerActionsHost.claimed && !header;
  // A claiming layout draws the page's one visible h1, so the shell keeps no
  // heading of its own.
  const ownsTitle = contentOwnsTitle || barClaimed;
  const body = (
    <DetailActionSlotsProvider slots={slots}>
      <DetailMoreItemsContributionProvider
        contribute={contributedMore.contribute}
      >
        <DetailMoreItemsProvider items={contributedMore.items}>
          {header ? (
            children
          ) : (
            <DetailHeaderActionsProvider host={headerActionsHost.host}>
              {children}
            </DetailHeaderActionsProvider>
          )}
        </DetailMoreItemsProvider>
      </DetailMoreItemsContributionProvider>
    </DetailActionSlotsProvider>
  );
  const sectionClassName =
    width === 'fluid'
      ? 'flex min-h-0 w-full flex-col pt-8'
      : 'mx-auto flex min-h-0 w-full max-w-3xl flex-col pt-8';
  const titleText = privateTitle ? (
    <span className={REPLAY_MASK_CLASS}>{title}</span>
  ) : (
    title
  );
  if (header) {
    return (
      <section
        className={sectionClassName}
        data-testid="plugins-entry-detail"
        aria-labelledby="plugins-entry-detail-title"
      >
        <div className="flex flex-col gap-4 pb-6">
          {breadcrumbs !== undefined && (
            <div className="flex shrink-0 items-center">{breadcrumbs}</div>
          )}
          <DetailHeader
            dataTestId="plugins-entry-detail-header"
            title={titleText}
            titleId="plugins-entry-detail-title"
            description={header.description}
            meta={header.meta}
            actions={
              <>
                <DetailMoreMenu
                  name={menuName}
                  items={menuRows}
                  triggerTestId="plugins-entry-detail-more"
                  menuTestId="plugins-entry-detail-menu"
                />
                {/* Always mounted: body-declared actions portal into its
                    slots, so the bar must exist before they register. */}
                <DetailActionBar
                  secondary={headerActions}
                  share={share}
                  slots={slots}
                />
              </>
            }
          />
        </div>
        {body}
      </section>
    );
  }
  return (
    <section
      className={sectionClassName}
      data-testid="plugins-entry-detail"
      aria-labelledby={
        ownsTitle ? 'plugin-detail-title' : 'plugins-entry-detail-title'
      }
    >
      {ownsTitle ? (
        <span id="plugins-entry-detail-title" className="sr-only">
          {privateTitle ? (
            <span className={REPLAY_MASK_CLASS}>{title}</span>
          ) : (
            title
          )}
        </span>
      ) : (
        <Heading
          level={1}
          variant="page"
          id="plugins-entry-detail-title"
          className="sr-only"
        >
          {privateTitle ? (
            <span className={REPLAY_MASK_CLASS}>{title}</span>
          ) : (
            title
          )}
        </Heading>
      )}
      {(breadcrumbs !== undefined ||
        onNavigateBack ||
        (hasActions && !barClaimed)) && (
        <div className="flex shrink-0 items-center justify-between gap-2 pb-6">
          {breadcrumbs !== undefined ? (
            breadcrumbs
          ) : onNavigateBack ? (
            <Button
              type="button"
              variant="ghost"
              size="compact"
              onClick={onNavigateBack}
              data-testid="plugins-entry-detail-back"
            >
              <AppCatalogChevronLeftMediumIcon size="sm" aria-hidden />
              Back
            </Button>
          ) : (
            <span />
          )}
          {hasActions && !barClaimed && shellBar}
        </div>
      )}
      {body}
    </section>
  );
}
