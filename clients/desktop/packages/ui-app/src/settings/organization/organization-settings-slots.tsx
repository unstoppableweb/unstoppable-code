'use client';

import type { ProjectLocalSetupPort } from '../../capability/project-setup/project-local-setup';
import {
  createContext,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ComponentType,
  type JSX,
  type ReactNode,
} from 'react';
import type { OrgProjectSummary } from '@canopy/protocol/org-projects';
import type { DataSharingOptInFeature } from '@canopy/protocol';

export interface OrganizationPromotionDialogProps {
  readonly accountKey: string;
  readonly personalOrganizationId: string;
  /** Opened to invite someone; the email then leads the form. */
  readonly inviteRequired?: boolean;
  readonly onClose: () => void;
}

/** Where an organization project stands on this device. */
export type OrgProjectLocalState =
  | 'not-set-up'
  | 'setting-up'
  | 'ready'
  | 'failed';

export interface OrgProjectLocalStatus {
  readonly state: OrgProjectLocalState;
  /** User-readable progress or failure message, when the host has one. */
  readonly message?: string;
}

/**
 * The Projects page's view of this device: which organization projects are
 * set up here, and Set up / Open. Only a host that can check projects out
 * locally supplies it; without it the page offers the desktop handoff.
 */
export interface OrgProjectLocalSetupSlot {
  /** Re-notifies when any project's local status for this org changes. */
  readonly subscribe: (
    organizationId: string,
    onChange: () => void,
  ) => () => void;
  /**
   * Statuses by project id; an absent id is `not-set-up`. Returns the same
   * `Map` instance until something changed, as `useSyncExternalStore`
   * requires.
   */
  readonly getLocalStatuses: (
    organizationId: string,
  ) => ReadonlyMap<string, OrgProjectLocalStatus>;
  /**
   * Resolves once setup has started or the setup dialog is opening; rejects
   * with a user-readable message, or an `AbortError` after `signal` aborts.
   */
  readonly setUp: (
    organizationId: string,
    project: OrgProjectSummary,
    signal: AbortSignal,
  ) => Promise<void>;
  /**
   * Resolves once the project is open; rejects with a user-readable message,
   * leaving the user where they are.
   */
  readonly open: (
    organizationId: string,
    project: OrgProjectSummary,
    signal: AbortSignal,
  ) => Promise<void>;
}

export interface OrganizationDataSharingOptInProps {
  readonly feature: DataSharingOptInFeature;
  /** Organization external UUID: the organization that owns the work. */
  readonly organizationId: string;
  readonly className?: string;
}

/**
 * Host-supplied pieces the shared organization pages render inline. Every
 * slot is optional: a missing slot renders the capability-gated state (a web
 * handoff), never a host fork.
 */
export interface OrganizationSettingsSlots {
  /**
   * The host's Personal-to-team promotion controller (the shared Create a
   * team dialog over the host's upgrade port). One controller per host owns
   * promotion; without it the entry hands off to the web.
   */
  readonly PromotionDialog?: ComponentType<OrganizationPromotionDialogProps>;
  /** Local project status and Set up / Open on this device. */
  readonly orgProjectLocalSetup?: OrgProjectLocalSetupSlot;
  /**
   * An organization project's scripts and hooks on this device, for the
   * project editor's Shared setup (CAN-6239). Only a host that can check the
   * project out supplies it; without it the section says to open the desktop
   * app. Call it with the same ids for the same port.
   */
  readonly projectLocalSetup?: (
    organizationId: string,
    projectId: string,
  ) => ProjectLocalSetupPort;
  /**
   * The host's inline data-sharing opt-in, which resolves the viewer's
   * sharing itself and saves in place. Without it the hint hands off to the
   * desktop review.
   */
  readonly DataSharingOptIn?: ComponentType<OrganizationDataSharingOptInProps>;
}

const NO_SLOTS: OrganizationSettingsSlots = {};

const OrganizationSettingsSlotsContext =
  createContext<OrganizationSettingsSlots>(NO_SLOTS);

export interface OrganizationSettingsSlotsProviderProps {
  readonly slots: OrganizationSettingsSlots;
  readonly children: ReactNode;
}

export function OrganizationSettingsSlotsProvider({
  slots,
  children,
}: OrganizationSettingsSlotsProviderProps): JSX.Element {
  return (
    <OrganizationSettingsSlotsContext.Provider value={slots}>
      {children}
    </OrganizationSettingsSlotsContext.Provider>
  );
}

export function useOrganizationSettingsSlots(): OrganizationSettingsSlots {
  return useContext(OrganizationSettingsSlotsContext);
}

// One shared empty snapshot: a fresh Map per read would make
// useSyncExternalStore re-render forever.
const NO_LOCAL_STATUSES: ReadonlyMap<string, OrgProjectLocalStatus> = new Map();

function subscribeToNothing(): () => void {
  return (): void => {};
}

/**
 * Local statuses for an organization's projects, by project id; empty when
 * the host supplies no {@link OrgProjectLocalSetupSlot}.
 */
export function useOrgProjectLocalStatuses(
  organizationId: string,
): ReadonlyMap<string, OrgProjectLocalStatus> {
  const slot = useContext(
    OrganizationSettingsSlotsContext,
  ).orgProjectLocalSetup;
  const subscribe = useCallback(
    (onChange: () => void): (() => void) =>
      slot === undefined
        ? subscribeToNothing()
        : slot.subscribe(organizationId, onChange),
    [slot, organizationId],
  );
  const getSnapshot = useCallback(
    (): ReadonlyMap<string, OrgProjectLocalStatus> =>
      slot === undefined
        ? NO_LOCAL_STATUSES
        : slot.getLocalStatuses(organizationId),
    [slot, organizationId],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
