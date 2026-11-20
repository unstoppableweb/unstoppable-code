import type { JSX, ReactNode } from 'react';
import { ItemStateMark } from '@canopy/ui-shared';
import type { MarketplaceTypeTabId } from '@canopy/ui-shared/lib';
import { customizeTabHasInstalledStatuses } from './customizeSections';

function StatusTerm({
  tone,
  children,
}: {
  readonly tone: 'active' | 'available';
  readonly children: string;
}): JSX.Element {
  return (
    <span className="inline-flex items-baseline gap-1 align-baseline">
      <span className="self-center">
        <ItemStateMark tone={tone} size={12} />
      </span>
      <span className="fg-primary">{children}</span>
    </span>
  );
}

/**
 * New Customize's line under the page title: how an item's status works, on
 * the tabs whose rows carry one. The status icons sit beside the words so
 * the rows' marks are learned here; "disabled" needs no explainer. Workflows
 * and Agents have no status, so no line.
 */
export function customizeDiscoveryDescription(
  tab: MarketplaceTypeTabId,
): ReactNode | undefined {
  if (!customizeTabHasInstalledStatuses(tab)) return undefined;
  return (
    <>
      <StatusTerm tone="active">Active</StatusTerm> items are added to every new
      chat. <StatusTerm tone="available">Available</StatusTerm> ones load when
      you or an agent needs them.
    </>
  );
}
