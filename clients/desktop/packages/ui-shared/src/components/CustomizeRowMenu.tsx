import { type JSX, Fragment, useRef, useState } from 'react';
import { Button } from './Button';
import { DropdownMenuDivider, DropdownMenuItem } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';
import { Tooltip } from './Tooltip';
import { isMenuOpenBodyFlagSet } from '../lib/menu-open-body-flag';
import { MoreHorizontalIcon } from '../icons/AppIcons';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import type { MarketplaceEntryShareStates } from '../lib/marketplace-share';

export interface CustomizeRowMenuItem {
  readonly id: string;
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  /** Destructive items render last, after a divider. */
  readonly destructive?: boolean;
}

export function marketplaceListingMenuItems(
  entry: UnifiedPluginEntry,
  itemFor: (listing: UnifiedPluginEntry) => CustomizeRowMenuItem | null,
): CustomizeRowMenuItem[] {
  const actions = (entry.marketplaceListings ?? [entry]).flatMap((listing) => {
    const item = itemFor(listing);
    return item ? [{ listing, item }] : [];
  });
  return actions.map(({ listing, item }) => {
    if (actions.length === 1 || !listing.marketplaceProvider) return item;
    const provider = listing.marketplaceProvider;
    const ambiguous = actions.some(
      (action) =>
        action.listing !== listing &&
        action.listing.marketplaceProvider === provider,
    );
    const source =
      ambiguous && listing.ref.type === 'marketplace-plugin'
        ? `${provider}, ${listing.ref.marketplaceId}`
        : provider;
    return {
      ...item,
      id: `${item.id}-${listing.id}`,
      label: `${item.label.replace(/…$/, '')} (${source})…`,
    };
  });
}

export function marketplaceShareMenuItems(
  entry: UnifiedPluginEntry,
  states: MarketplaceEntryShareStates | undefined,
  onShare: ((entry: UnifiedPluginEntry) => void) | undefined,
): CustomizeRowMenuItem[] {
  if (!states || !onShare) return [];
  return marketplaceListingMenuItems(entry, (listing) => {
    const share = states.get(listing.id);
    if (!share) return null;
    return {
      id: 'share',
      label: 'Share…',
      disabled: share.status === 'blocked',
      disabledReason: share.status === 'blocked' ? share.reason : undefined,
      onSelect: () => onShare(listing),
    };
  });
}

export interface CustomizeRowMenuProps {
  readonly entryName: string;
  /** Section-qualified, so repeated entries keep unique identifiers. */
  readonly idPrefix: string;
  readonly items: readonly CustomizeRowMenuItem[];
  readonly testId?: string;
}

/** A row's secondary actions. Renders nothing when no action exists. */
export function CustomizeRowMenu({
  entryName,
  idPrefix,
  items,
  testId,
}: CustomizeRowMenuProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const groups = [
    items.filter((item) => item.destructive !== true),
    items.filter((item) => item.destructive === true),
  ].filter((group) => group.length > 0);
  if (groups.length === 0) return null;
  const menuId = `${idPrefix}-menu`;
  return (
    <div className="relative shrink-0">
      <Button
        ref={triggerRef}
        variant="ghost-quiet"
        size="compact"
        iconOnly
        id={`${idPrefix}-menu-trigger`}
        data-testid={testId}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`More actions for ${entryName}`}
        onPointerDown={() => {
          if (!open && isMenuOpenBodyFlagSet(document)) setOpen(true);
        }}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontalIcon size="sm" aria-hidden />
      </Button>
      <FloatingMenu
        id={menuId}
        open={open}
        onOpenChange={setOpen}
        anchorRef={triggerRef}
        placement="bottom-right"
        data-testid={testId ? `${testId}-surface` : undefined}
        className="min-w-40"
      >
        {groups.map((group, index) => (
          <Fragment key={index}>
            {index > 0 && <DropdownMenuDivider />}
            {group.map((item) => (
              <Tooltip
                key={item.id}
                label={item.disabledReason}
                clamp={false}
                disabled={!item.disabledReason}
                className="w-full"
              >
                <DropdownMenuItem
                  data-testid={testId ? `${testId}-${item.id}` : undefined}
                  tone={item.destructive ? 'destructive' : 'default'}
                  disabled={item.disabled}
                  aria-disabled={item.disabled || undefined}
                  aria-description={item.disabledReason}
                  aria-label={
                    item.disabledReason
                      ? `${item.label}: ${item.disabledReason}`
                      : item.label
                  }
                  onClick={() => {
                    if (item.disabled) return;
                    setOpen(false);
                    item.onSelect();
                  }}
                >
                  {item.label}
                </DropdownMenuItem>
              </Tooltip>
            ))}
          </Fragment>
        ))}
      </FloatingMenu>
    </div>
  );
}
