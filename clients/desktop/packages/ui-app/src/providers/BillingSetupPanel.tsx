'use client';

import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import type { ProviderChoiceModel } from '@canopy/app-state/provider-choice';
import { ProviderChooser, type ProviderChooserProps } from './ProviderChooser';

/** The billing setup gate's heading, shared by desktop and web. */
export const BILLING_SETUP_GATE_TITLE = 'Choose how your agents run';

/** One sentence under {@link BILLING_SETUP_GATE_TITLE}. */
export const BILLING_SETUP_GATE_INTRO =
  'Connect a provider to start a chat. You can change this anytime in Settings.';

export interface BillingSetupPanelProps<
  TModel extends ProviderChoiceModel,
> extends ProviderChooserProps<TModel> {
  /**
   * Sources set up elsewhere (desktop: Cursor, Copilot, OpenCode,
   * Antigravity), rendered under the rows and above `link`. They have no
   * connect flow in the list, so the host renders each as a Set up link.
   */
  readonly moreProviders?: ReactNode;
  /**
   * Move focus to the panel when it mounts. Hosts set it when focus was in
   * the composer the panel replaced, so keyboard users land on the panel
   * instead of the document body.
   */
  readonly focusOnMount?: boolean;
}

/**
 * The provider list as a page-level step: the billing setup gate that
 * replaces a new-chat composer when the user has no way to run a model, and
 * the first-run provider section. A thin shell over {@link ProviderChooser};
 * hosts supply rows, presentation and actions, and nothing here branches on
 * the host.
 */
export function BillingSetupPanel<TModel extends ProviderChoiceModel>({
  moreProviders,
  focusOnMount = false,
  link,
  dataTestId = 'billing-setup-panel',
  ...chooser
}: BillingSetupPanelProps<TModel>): JSX.Element {
  const regionRef = useRef<HTMLElement | null>(null);
  // Read once, on mount: a later prop change must not steal focus back.
  const focusOnMountRef = useRef(focusOnMount);
  useEffect(() => {
    if (focusOnMountRef.current) {
      regionRef.current?.focus({ preventScroll: true });
    }
  }, []);
  const tail =
    moreProviders !== undefined || link !== undefined ? (
      <>
        {moreProviders}
        {link}
      </>
    ) : undefined;
  return (
    <section
      ref={regionRef}
      tabIndex={-1}
      aria-label={typeof chooser.title === 'string' ? chooser.title : undefined}
      className="flex w-full min-w-0 flex-col outline-none"
      data-testid={dataTestId}
    >
      <ProviderChooser
        {...chooser}
        {...(tail !== undefined ? { link: tail } : {})}
      />
    </section>
  );
}
