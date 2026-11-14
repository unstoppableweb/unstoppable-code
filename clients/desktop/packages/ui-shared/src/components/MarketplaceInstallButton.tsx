import { type JSX, useId, useRef, useState } from 'react';
import { ChevronDownIcon } from '../icons/AppIcons';
import type { UnifiedPluginEntry } from '../lib/unified-plugin-entry';
import { Button } from './Button';
import { DropdownMenuItem } from './DropdownMenu';
import { FloatingMenu } from './FloatingMenu';

interface MarketplaceInstallButtonProps {
  readonly entry: UnifiedPluginEntry;
  readonly onAdd: (entry: UnifiedPluginEntry) => void;
}

/** Browse and Customize start the same install flow for the selected listing. */
export function MarketplaceInstallButton({
  entry,
  onAdd,
}: MarketplaceInstallButtonProps): JSX.Element | null {
  if (entry.marketplaceListings?.length)
    return <GroupedMarketplaceInstall entry={entry} onAdd={onAdd} />;
  if (entry.browseInstallAvailable === false) return null;
  const label = entry.kind === 'collection' ? 'Add' : 'Install';
  return (
    <Button
      size="compact"
      type="button"
      data-testid={`plugins-entry-add-${entry.id}`}
      aria-label={`${label} ${entry.name}`}
      onClick={() => onAdd(entry)}
    >
      {label}
    </Button>
  );
}

function GroupedMarketplaceInstall({
  entry,
  onAdd,
}: MarketplaceInstallButtonProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const testId = `plugins-entry-add-${entry.id}`;
  const choices = entry.marketplaceProviders?.flatMap((provider) => {
    const listing = entry.marketplaceListings?.find(
      (item) =>
        item.marketplaceProvider === provider &&
        item.state === 'available' &&
        item.browseInstallAvailable !== false,
    );
    return listing ? [{ provider, listing }] : [];
  });
  if (!choices?.length) return null;
  return (
    <>
      <Button
        ref={triggerRef}
        size="compact"
        type="button"
        data-testid={testId}
        aria-label={`Install ${entry.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        Install <ChevronDownIcon size="sm" aria-hidden />
      </Button>
      <FloatingMenu
        id={menuId}
        anchorRef={triggerRef}
        open={open}
        onOpenChange={setOpen}
        aria-label={`Choose a provider for ${entry.name}`}
        placement="bottom-right"
      >
        {choices.map(({ provider, listing }) => (
          <DropdownMenuItem
            key={provider}
            data-testid={`${testId}-${provider.toLowerCase()}`}
            onClick={() => {
              setOpen(false);
              onAdd(listing);
            }}
          >
            {provider}
          </DropdownMenuItem>
        ))}
      </FloatingMenu>
    </>
  );
}
