'use client';

import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { OrganizationDetail } from '@canopy/protocol/settings/organization';

/**
 * Host-supplied behavior for the organization Settings pages that only a
 * browser page owning its own URL and tab can provide. Every slot is
 * optional: a missing slot falls back to the shared settings host ports,
 * never to a host fork, and shared code never asks which host it runs in.
 */
export interface OrganizationSettingsSubtabSlots {
  /**
   * Follow the organization GitHub App install URL in this tab; the install
   * callback returns to Settings with a `?github=` status. Without it the
   * install opens in the browser and the card offers "Check again".
   */
  readonly followGitHubInstallUrl?: (url: string) => void;
  /**
   * The External agents policy card in Settings → Policies. Only a host
   * that serves the hosted MCP servers supplies it; without it neither the
   * card nor its lapsed-owner access to Policies appears.
   */
  readonly renderExternalAgentsPolicy?: (
    detail: OrganizationDetail,
  ) => ReactNode;
}

const NO_SLOTS: OrganizationSettingsSubtabSlots = {};

const OrganizationSettingsSubtabSlotsContext =
  createContext<OrganizationSettingsSubtabSlots>(NO_SLOTS);

export interface OrganizationSettingsSubtabSlotsProviderProps {
  readonly slots: OrganizationSettingsSubtabSlots;
  readonly children: ReactNode;
}

export function OrganizationSettingsSubtabSlotsProvider({
  slots,
  children,
}: OrganizationSettingsSubtabSlotsProviderProps): JSX.Element {
  return (
    <OrganizationSettingsSubtabSlotsContext.Provider value={slots}>
      {children}
    </OrganizationSettingsSubtabSlotsContext.Provider>
  );
}

export function useOrganizationSettingsSubtabSlots(): OrganizationSettingsSubtabSlots {
  return useContext(OrganizationSettingsSubtabSlotsContext);
}
