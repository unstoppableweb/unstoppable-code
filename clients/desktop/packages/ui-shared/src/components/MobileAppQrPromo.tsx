'use client';

import { Stack } from './Stack';
import { type JSX, useState } from 'react';
import {
  StoreBadgeLink,
  type MobileAppStore,
  type MobileAppStoreLink,
  type StoreBadgeActivation,
} from './StoreBadgeLink';
import { SegmentedControl } from './SegmentedControl';
import { Surface } from './Surface';
import {
  DEFAULT_MOBILE_APP_PROMO_DESCRIPTION,
  defaultMobileAppPromoHeading,
} from './MobileAppPromo';

/** A store listing plus, when generation succeeded, its QR code image. */
export interface MobileAppQrLink extends MobileAppStoreLink {
  /** Data URI encoding {@link MobileAppStoreLink.url}. Absent on failure. */
  qrSrc?: string;
}

/** Human-readable store names used by the toggle and the QR alt text. */
const STORE_DISPLAY_NAME: Record<MobileAppStore, string> = {
  'apple-app-store': 'App Store',
  'google-play': 'Google Play',
};

/** Short slug used in test ids so specs do not depend on the full store key. */
const STORE_TAB_SLUG: Record<MobileAppStore, string> = {
  'apple-app-store': 'app-store',
  'google-play': 'play',
};

export interface MobileAppQrPromoProps {
  brandDisplayName: string;
  links: readonly MobileAppQrLink[];
  activation: StoreBadgeActivation;
  heading?: string;
  description?: string;
  'data-testid'?: string;
}

/**
 * Rich popover body promoting the brand's mobile apps: copy, a store toggle,
 * one scannable QR code, and the selected store's official badge.
 *
 * **The toggle selects the whole surface, not just the code.** Exactly one QR
 * and exactly one badge are mounted at a time, both for the selected store.
 * Two codes side by side leave the user guessing which one to point a phone
 * at, and a camera can lock onto whichever it finds first; a badge for the
 * store the user did not choose reads as a competing call to action next to
 * the code for the one they did. The segmented toggle makes the choice
 * explicit; with a single-store brand it is not rendered at all, so there is
 * no dead affordance.
 *
 * QR generation deliberately lives outside this component — it is host-specific
 * (the desktop renderer's `useStoreQrCodes`) and would drag a Node/browser
 * encoder into what is otherwise a pure display package. Callers pass finished
 * data URIs; a missing one just hides the tile.
 */
export function MobileAppQrPromo({
  brandDisplayName,
  links,
  activation,
  heading,
  description,
  'data-testid': dataTestId,
}: MobileAppQrPromoProps): JSX.Element | null {
  // Seeded to the brand's first declared link so single-store brands need no
  // toggle. Hooks run before the empty-links bail-out below.
  const [selectedStore, setSelectedStore] = useState<MobileAppStore | null>(
    links[0]?.store ?? null,
  );
  if (links.length === 0) {
    return null;
  }

  const selected =
    links.find((link) => link.store === selectedStore) ?? links[0];
  const resolvedHeading =
    heading ?? defaultMobileAppPromoHeading(brandDisplayName);

  return (
    <div
      data-testid={dataTestId ?? 'mobile-app-qr-promo'}
      className="flex w-64 flex-col items-center gap-3 p-4 text-center"
    >
      <Stack gap="tight">
        <p className="text-s font-semibold fg-primary">{resolvedHeading}</p>
        <p className="text-xs fg-secondary">
          {description ?? DEFAULT_MOBILE_APP_PROMO_DESCRIPTION}
        </p>
      </Stack>

      {/* The shared SegmentedControl in its default toggle semantics (a
          labelled group of `aria-pressed` buttons), deliberately NOT
          `semantics="tabs"`. Tabs would owe a `role="tabpanel"` and roving
          `tabIndex` plus arrow-key navigation, and their `aria-controls`
          would dangle whenever generation failed and the tile below is not
          rendered. */}
      {links.length > 1 && (
        <SegmentedControl
          label="Choose a store"
          width="content"
          value={selected.store}
          options={links.map((link) => ({
            value: link.store,
            label: STORE_DISPLAY_NAME[link.store],
            dataTestId: `mobile-app-qr-tab-${STORE_TAB_SLUG[link.store]}`,
          }))}
          onChange={setSelectedStore}
        />
      )}

      {/* White tile regardless of color mode: a QR inverted by a dark surface
          is unreliable for phone cameras. Skipped entirely when generation
          failed for this store — the badges below still work. */}
      {selected.qrSrc && (
        <Surface variant="pairing-code">
          <img
            data-testid="mobile-app-qr"
            data-store={selected.store}
            src={selected.qrSrc}
            alt={`QR code linking to ${brandDisplayName} on the ${
              STORE_DISPLAY_NAME[selected.store]
            }`}
            className="h-36 w-36"
            draggable={false}
          />
        </Surface>
      )}

      {/* One badge, matching the toggle. The popover has already asked the
          user to pick a store; showing the other one's badge underneath the
          chosen store's QR code re-opens that question and reads as a second,
          competing call to action. The badge is the click path to the same
          listing the code above points at — switching the toggle switches
          both. It survives a failed QR encode, where it becomes the only way
          through for that store. */}
      <StoreBadgeLink link={selected} activation={activation} />
    </div>
  );
}
