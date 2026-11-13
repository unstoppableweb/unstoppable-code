'use client';

import { marketplacePublicLinkPinnedAt } from '@canopy/protocol/marketplace';
import type { SharedLinkKind } from './marketplaceShareLink';
import { formatMonthDay } from '@canopy/ui-shared/lib/billing-format';

import { useResourceContext } from '../capability/ResourceContext';

import {
  type JSX,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type {
  ShareAudience,
  ShareOrganizationAccess,
} from '@canopy/protocol/sharing';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import type { PersonalOrganizationUpgradePort } from '@canopy/app-state/personal-organization-upgrade';
import { orgsWithoutActivePlanClause } from '@canopy/ui-shared/lib/org-lapse-sentence';
import {
  Stack,
  Button,
  ConfirmDialog,
  ErrorBanner,
  Notice,
  NoticeButton,
  OrgTeamPicker,
  ShareAudienceSelector,
  Tooltip,
  type ShareTarget,
  type TooltipLink,
} from '@canopy/ui-shared/components';
import { TrashIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  CapabilityPackageDependencies,
  type CapabilityPackagePipelineAdd,
} from './capability-package/CapabilityPackageDependencies';
import {
  buildCapabilityPackageRepairPrompt,
  buildCapabilityPackageRepairRequest,
  type CapabilityPackageRepairBinding,
} from './capability-package/capability-package-repair';
import {
  shareAudienceHelper,
  type ShareLanding,
} from './capability-package/share-copy';
import {
  type CapabilityPackageSelection,
  type CapabilityPackageSharePort,
  useCapabilityPackageShare,
} from './capability-package/useCapabilityPackageShare';
import { RemovePublicLinkConfirmDialog } from './RemovePublicLinkConfirmDialog';
import {
  PUBLIC_LINK_REMOVED_TOAST,
  ShareDialogFrame,
  type ShareDialogLink,
  type ShareNotify,
  sharePartialMessage,
  shareSuccessNotice,
} from './ShareDialogFrame';
import {
  existingShareOwnerAudience,
  publicAudienceLocked,
} from './deriveExistingShare';
import { resourceContextRefusalMessage } from './share-refusal-copy';
import {
  classifyShareFailure,
  shareFailureCopy,
  shareFailureRecovery,
  type ShareFailureRecovery,
} from './share-errors';
import {
  resolveSelectedDestinationAccess,
  type ShareDestinationAccess,
} from './share-destination-access';
import { useShareAudience } from './useShareAudience';
import { useShareTargetSearch } from './useShareTargetSearch';
import {
  ContextChangedNotice,
  contextLabel,
  defaultOrganizationForContext,
  useContextRebind,
} from './defaultOrganizationForContext';

// Create a team opens from inside this dialog, never on first paint: keep the
// shared upgrade dialog and its store out of every route that can share.
const InviteToOrganizationDialog = lazy(() =>
  import('./InviteToOrganizationDialog').then((module) => ({
    default: module.InviteToOrganizationDialog,
  })),
);

/**
 * The one share dialog. Desktop Agents, Automations, Collections, Pipelines,
 * Plans, Plugins, Runs and Skills, and the web portal's skill, pipeline and
 * collection shares all render it.
 *
 * It owns everything that is identical across resources: the parameterized
 * Team/Organization/Public selector, the team/organization pickers, account
 * gating (including the guest connect gate and the organization setup
 * statement for an account with no organization), the capability-package
 * dependency review, Remove public link, and the share lifecycle. It renders
 * through {@link ShareDialogFrame}: progress lives in the Share button, a
 * completed share closes the dialog and raises a toast through `notify`, and
 * errors stay inline above the footer. There is no Private audience: `private` is only the storage
 * value behind a public share and the owner's Personal lane. Callers
 * inject copy, the offered audiences, `share()` and genuinely
 * resource-specific sections. Nothing here touches `window.*`, so it is safe
 * in both hosts; the desktop binds its ports once in
 * `DesktopShareResourceDialog`.
 */
export type ShareResourceScope = ShareAudience;

/** A team or organization the resource can be shared with. */
export type ShareTargetSummary = ShareTarget;

/** Cloud account state the dialog gates on. */
export interface ShareResourceAccount {
  /** Policy and exception identity of the account that performs the share. */
  readonly organizationOwnershipPolicy?: {
    readonly enabled: boolean;
    readonly personalOrganizationId: string | null;
  };
  readonly personalOrganizationId?: string;
  readonly connected: boolean;
  readonly capabilities: readonly string[];
  /**
   * Stable account identity. When it changes, the dialog clears its team or
   * organization selection, reloads the pickers and drops stale checks.
   * Required only for hosts that can switch accounts while the dialog is open.
   */
  readonly id?: string;
  /** A device-scoped guest: the dialog renders the connect gate instead. */
  readonly kind?: 'guest';
  /**
   * `false` when the account belongs to no organization: Team and
   * Organization render disabled and the dialog offers organization setup.
   * `undefined` (a host that does not report membership) means available.
   */
  readonly hasOrganization?: boolean;
  /**
   * `false` when the account belongs to no team: only Team renders disabled.
   * A team always belongs to an organization, but an organization can have no
   * teams. `undefined` means available.
   */
  readonly hasTeam?: boolean;
  /**
   * Advisory sharing access per organization. An organization known to lack
   * its plan shows a notice before any upload; an absent list or entry is
   * unknown and never blocks. The server decides every share.
   */
  readonly organizationAccess?: readonly ShareOrganizationAccess[];
  /** Server-reported free access. Overrides the `freeAccess` prop when set. */
  readonly freeAccess?: boolean;
}

/** What a completed share produced. */
export interface ShareResourceOutcome {
  /** Absolute (or server-relative) share link, when the audience mints one. */
  readonly shareUrl?: string;
  /** Overrides the default success sentence — e.g. a partial failure. */
  readonly message?: string;
  /**
   * The cloud copy landed but its public link did not. The dialog shows the
   * degraded result and, with `retryPublicLink`, a retry.
   */
  readonly publicLinkFailed?: boolean;
  /**
   * `pending` when the host accepted the share but can't confirm it landed.
   * The dialog closes with a warning toast, skips `onCompleted` and shows no
   * link. Absent means confirmed.
   */
  readonly delivery?: 'confirmed' | 'pending';
}

/** Everything `share()` needs to perform the share the author chose. */
export interface ShareResourceShareInput {
  readonly scope: ShareResourceScope;
  readonly teamId?: string;
  readonly organizationId?: string;
  /** Display name for the selected team or organization, when applicable. */
  readonly targetName?: string;
  /**
   * Present only when the dialog has a capability-package port. The reviewed
   * selection to commit, or `null` when there is nothing to package.
   */
  readonly packageSelection?: CapabilityPackageSelection | null;
  /** Recheck the current policy immediately before a host mutates after awaiting preparation. */
  readonly assertAllowed?: () => void;
  /** Keep a locked owner's legacy link until the author explicitly removes it. */
  readonly preservePublicLink?: boolean;
}

/**
 * Thrown by a host's `share()` when an update lost a conditional write: the
 * cloud copy changed since the author last shared it. The dialog shows the
 * standard conflict copy instead of the raw reason.
 */
export class ShareConflictError extends Error {
  constructor(message = 'The shared copy changed since it was last shared.') {
    super(message);
    this.name = 'ShareConflictError';
  }
}

/**
 * Thrown by a host completion hook after it successfully compensates for a
 * local persistence failure by revoking the remote share. The dialog must
 * offer the real Share action again because no committed share remains.
 */
export class ShareCompletionRolledBackError extends Error {
  readonly shareCompletionRolledBack = true;

  constructor(message: string) {
    super(message);
    this.name = 'ShareCompletionRolledBackError';
  }
}

function isShareCompletionRolledBackError(
  error: unknown,
): error is { readonly shareCompletionRolledBack: true } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'shareCompletionRolledBack' in error &&
    error.shareCompletionRolledBack === true
  );
}

/** The resource's current share, when re-sharing updates it in place. */
export interface ShareResourceExistingShare {
  readonly audience: ShareAudience;
  readonly target?: ShareTarget;
  /**
   * Which audience `target` belongs to. Defaults to `audience`; set it when
   * they differ, i.e. a team or organization share that also has a public
   * link reads as Public while its team or organization stays the target.
   */
  readonly targetAudience?: 'team' | 'organization';
  /** The public link no longer reflects the local copy. */
  readonly publicLinkStale?: boolean;
  /** Last snapshot update time from authoritative share facts. */
  readonly publicLinkPinnedAt?: string;
  /**
   * The share's current link, shown as Copy link in the footer from the
   * moment the dialog opens. Hosts prefer the public link over a scoped one.
   */
  readonly link?: ShareDialogLink;
}

/** Compact host-observable state for integrations outside the shared UI. */
export interface ShareResourceDialogState {
  /** `null` until the author picks an audience (or none is usable). */
  readonly audience: ShareResourceScope | null;
  readonly teamId?: string;
  readonly organizationId?: string;
  readonly available: boolean;
  readonly busy: boolean;
  readonly status: 'idle' | 'sharing' | 'success' | 'error';
  readonly copied: boolean;
}

export type ShareResourcePreflightResult =
  | { readonly status: 'ready' }
  | {
      readonly status: 'blocked';
      readonly body: ReactNode;
      readonly action?:
        | {
            readonly label: string;
            readonly onClick: () => void;
            readonly retry?: never;
          }
        | {
            readonly label: string;
            readonly retry: true;
            readonly onClick?: never;
          };
    };

/** Standard fail-closed result when an existing share cannot be inspected. */
export function existingShareLoadFailure(
  resourceNoun: string,
  error?: unknown,
): ShareResourcePreflightResult {
  const refusal = resourceContextRefusalMessage(error);
  return {
    status: 'blocked',
    body: (
      <ErrorBanner
        className=""
        error={
          refusal === null
            ? `The existing ${resourceNoun} share could not be loaded.`
            : shareFailureMessage(resourceNoun, refusal)
        }
      />
    ),
    action: { label: 'Try again', retry: true },
  };
}

/**
 * The resource-dependent copy — every sentence that names the thing being
 * shared. `shareResourceCopy` derives the standard set from the noun; hosts
 * override only where their resource genuinely differs. Control labels
 * (Share, Update, Done, Copy link) stay fixed so the dialog reads the
 * same everywhere, and so does the failure prefix. Success is the dialog's
 * own notice, whose copy comes from {@link shareSuccessNotice}.
 */
export interface ShareResourceCopy {
  readonly accountLoading: string;
  readonly emptyState: string;
  readonly emptyAction: string;
  readonly guestState: string;
  readonly guestAction: string;
  readonly missingCapability: string;
  readonly upgradeHint: string;
  readonly scopeLegend: string;
  readonly publicDescription: string;
  readonly sharing: string;
  readonly updating: string;
  readonly conflict: string;
  readonly publicLinkStale: string;
  readonly packageUnavailable: string;
  readonly preflightLoading: string;
  readonly teamValidationError: string;
  readonly organizationValidationError: string;
  readonly teamSearchPlaceholder: string;
  readonly teamLoading: string;
  readonly teamEmpty: string;
  readonly organizationSearchPlaceholder: string;
  readonly organizationLoading: string;
  readonly organizationEmpty: string;
  /** Replaces the selector when an account with no organization can't share. */
  readonly organizationRequired: string;
  /** Under the selector when Team and Organization need an organization. */
  readonly organizationHint: string;
  /** Under the selector when an organization member belongs to no team. */
  readonly teamHint: string;
  /** Why Team and Organization are disabled in the Personal context. */
  readonly personalContextHint: string;
  readonly organizationSetupAction: string;
  readonly organizationSetupFailed: string;
  readonly removePublicLink: string;
  readonly removePublicLinkFailed: string;
  /** Under the selector when the share's owner rules out Public. */
  readonly publicLockedHint: string;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** Host state that changes the default copy without naming the host. */
export interface ShareResourceCopyOptions {
  /** See {@link ShareResourceDialogProps.freeAccess}. */
  readonly freeAccess?: boolean;
}

/** Default copy for a resource, derived from its noun. */
export function shareResourceCopy(
  noun: string,
  options: ShareResourceCopyOptions = {},
): ShareResourceCopy {
  const Noun = capitalize(noun);
  return {
    accountLoading: 'Loading account…',
    emptyState: `Connect a cloud account to share this ${noun}.`,
    emptyAction: 'Open account settings',
    guestState: `Create a free account to share this ${noun}.`,
    // With free access there is no trial to start: signing in is the whole
    // step, so the action says that.
    guestAction: options.freeAccess === true ? 'Sign in' : 'Start free trial',
    missingCapability: `This account does not support shared ${noun}s.`,
    upgradeHint:
      'This account must be upgraded before team or organization sharing is available.',
    scopeLegend: 'Sharing scope',
    publicDescription: shareAudienceHelper(noun, 'public', {
      includesDependencies: false,
    }),
    sharing: 'Sharing…',
    updating: 'Updating…',
    conflict: `This ${noun} changed in the cloud since you last shared it. Close and reopen to review the latest version.`,
    publicLinkStale: `The public link shows an older version of this ${noun}. Update to refresh it.`,
    packageUnavailable: `Dependencies are not included when sharing from here. Recipients get the ${noun} definition only.`,
    preflightLoading: `Checking whether this ${noun} can be shared…`,
    teamValidationError: `Select a team to share this ${noun}.`,
    organizationValidationError: `Select an organization to share this ${noun}.`,
    teamSearchPlaceholder: 'Search teams…',
    teamLoading: 'Loading teams…',
    teamEmpty: 'No teams found.',
    organizationSearchPlaceholder: 'Search organizations…',
    organizationLoading: 'Loading organizations…',
    organizationEmpty: 'No organizations found.',
    organizationRequired: `${Noun}s are shared with a team or organization. Set one up to start sharing.`,
    organizationHint:
      'Team and organization sharing start with an organization.',
    teamHint: 'Team sharing starts with a team in your organization.',
    personalContextHint:
      'Switch to an organization to share with a team or organization.',
    organizationSetupAction: 'Set up an organization',
    organizationSetupFailed: 'Could not open that page. Try again.',
    removePublicLink: 'Remove public link',
    removePublicLinkFailed: 'Could not remove the public link.',
    publicLockedHint: "Organization shares can't be made public yet.",
  };
}

/** Standard failure sentence: `Failed to share <noun>.` plus the reason. */
export function shareFailureMessage(noun: string, reason: string): string {
  return `Failed to share ${noun}. ${reason}`.trim();
}

const TEAMS_CAPABILITY = 'teams-v1';
const ORGANIZATIONS_CAPABILITY = 'organizations-v1';
const PACKAGE_RECHECK_MESSAGE =
  'Review the updated dependencies, then share again.';
const ACCESS_CHECK_FAILED_MESSAGE =
  "Couldn't check access. Check your connection and try again.";
/** A refresh this recent stands in for the pre-publication check. */
const ACCESS_REFRESH_FRESH_MS = 30_000;
/** The pre-publication check never holds a share longer than this. */
const ACCESS_REFRESH_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out'));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function sharePendingMessage(noun: string): string {
  return `Your ${noun} is still being shared. Check its sharing status in a moment.`;
}

/** Organization ids the server refused for a missing plan, as access facts. */
function withRefusedOrganizations(
  access: readonly ShareOrganizationAccess[] | undefined,
  refused: readonly string[],
): readonly ShareOrganizationAccess[] | undefined {
  if (refused.length === 0) return access;
  const known = access ?? [];
  return [
    ...known.map((entry) =>
      refused.includes(entry.organizationId)
        ? { ...entry, teamsEntitled: false }
        : entry,
    ),
    ...refused
      .filter((id) => !known.some((entry) => entry.organizationId === id))
      .map((organizationId) => ({ organizationId, teamsEntitled: false })),
  ];
}

/** The dependency review, when the host can analyze locally. */
export interface ShareResourceCapabilityPackage {
  /** Reference reviews disclose setup only; they never copy package files. */
  readonly mode?: 'package' | 'reference';
  /** Null while the host cannot analyze yet (e.g. the source is loading). */
  readonly port: CapabilityPackageSharePort | null;
  /** Formats a binding location; pipelines use `job.step`, others omit. */
  readonly bindingLabelFor?: (binding: {
    jobId: string;
    stepId: string;
  }) => string | null;
  /**
   * Offers Fix it with AI beside blocking problems. Absent when the host
   * cannot repair this item (read-only, bundled, or no repair chat).
   */
  readonly repair?: CapabilityPackageRepairBinding;
  /**
   * `host` hands the review to `extraOptions` as `packageReview`, so a host
   * can tuck it under its own Advanced disclosure. The dialog keeps it inline
   * while the analysis failed, found blockers, or holds dismissed tokens, so
   * collapsing never hides why Share is unavailable or an undo the author
   * just earned. A placed review that finds nothing to copy, no setup
   * requirements and nothing left out is omitted entirely. Defaults to
   * `inline`.
   */
  readonly placement?: 'inline' | 'host';
  /** Offers an "Add pipeline" control in the review's Pipelines group. */
  readonly pipelineAdd?: CapabilityPackagePipelineAdd;
}

/** What a render-function `extraOptions` receives. */
export interface ShareResourceExtraOptionsContext {
  /** `null` until the author picks an audience. */
  readonly scope: ShareResourceScope | null;
  readonly targetName?: string;
  readonly busy: boolean;
  /**
   * The dependency review, when `capabilityPackage.placement` is `host`,
   * nothing in it blocks Share, and it has files, setup requirements or
   * left-out selections to show. `null` otherwise.
   */
  readonly packageReview: ReactNode;
}

export interface ShareResourceDialogProps {
  readonly personalOrganizationUpgradePort?: PersonalOrganizationUpgradePort;
  /** Lower-case noun ("skill", "pipeline"). Drives the title and copy. */
  readonly resourceNoun: string;
  /** Test-id prefix, e.g. `share-skill` for `share-skill-modal`. */
  readonly testIdPrefix: string;
  /** Document that owns the modal portal/focus trap. */
  readonly ownerDocument?: Document;
  /** Cloud capability the resource's own CRUD requires, e.g. `skills-crud-v1`. */
  readonly requiredCapability: string;
  /** Overrides over {@link shareResourceCopy}'s noun-derived defaults. */
  readonly copy?: Partial<ShareResourceCopy>;
  /**
   * The host's last known server-reported free app access: every capability
   * is granted without a subscription. Guest prompts then ask the guest to
   * sign in instead of offering a trial. Omitted or false keeps the trial copy.
   */
  readonly freeAccess?: boolean;
  /** Audiences this resource offers. A single audience hides the selector. */
  readonly scopes: readonly ShareResourceScope[];
  /** Navigation context supplies defaults and filtering, never authorization. */
  readonly context?: WorkspaceContext;
  /** Account organizations used to resolve the context default and notice. */
  readonly contextOrganizations?: readonly ShareTargetSummary[];
  /** Resource name shown under the title. */
  readonly subtitle?: string;
  /** Resource-specific notes rendered above the scope selector. */
  readonly notes?: ReactNode;
  /**
   * Host-owned availability beyond the account's team/organization
   * capabilities and memberships, e.g. a resource whose Public audience is
   * unavailable in this host.
   */
  readonly audienceAvailability?: Partial<Record<ShareAudience, boolean>>;
  /**
   * Where a team or organization share shows up for the people it is shared
   * with. `marketplace` adds the standard "can find this <noun> in the
   * Marketplace" helper under Team and Organization. Omit it for a resource
   * with no shared list of its own (plans, sessions).
   */
  readonly landing?: ShareLanding;
  /**
   * Helper sentence per audience, over the defaults: Public always has the
   * standard helper, Team and Organization have one when `landing` is set.
   */
  readonly audienceDescriptions?: Partial<Record<ShareAudience, string>>;
  /** Blocks Share while a host precondition is unmet. */
  readonly shareDisabled?: boolean;
  /** Resource-specific controls rendered below the dependency review. */
  readonly extraOptions?:
    | ReactNode
    | ((context: ShareResourceExtraOptionsContext) => ReactNode);
  /** Overrides the automatic width (`md`, or `lg` with a package port). */
  readonly maxWidth?: 'md' | 'lg' | '2xl';
  /** The dependency review. Absent on hosts that cannot analyze locally. */
  readonly capabilityPackage?: ShareResourceCapabilityPackage;
  /** Without a package port, render the "dependencies not included" note. */
  readonly packageUnavailableNote?: boolean;
  /** Re-sharing updates this share in place. */
  readonly existingShare?: ShareResourceExistingShare;
  /**
   * The existing share's audience can't change here: every other audience
   * renders disabled with `hint` as its reason and under the selector, the
   * team and organization pickers are read-only, and the reopened share
   * offers no Update. Ignored without `existingShare`.
   */
  readonly audienceLocked?: { readonly hint: string };
  /**
   * The notice a reopened share opens on, over the automatic one. With it
   * the dialog opens on the reopened view while `existingShare.link` is
   * still resolving, with Copy link disabled until the link arrives, so the
   * form never flashes Update.
   */
  readonly reopenedNotice?: ShareReopenedNotice;
  /**
   * Stop sharing on a reopened share: a destructive footer action that asks
   * first, then runs `onStop`. A failure stays in the confirmation for a
   * retry; success posts `toast` through `notify` and closes the dialog.
   */
  readonly stopSharing?: ShareStopSharing;
  /**
   * A reopened share whose last update failed: the footer's primary runs
   * `onRetry` instead of Done. A failure stays in the dialog with the retry
   * still offered; on success the host re-renders with the synced share.
   */
  readonly retry?: {
    readonly label: string;
    readonly onRetry: () => Promise<void>;
  };
  /**
   * The host's share operation keeps a team or organization share inside its
   * organization while workspace context policy applies, so it can't move to
   * the personal owner Public needs. Public then renders disabled with
   * `publicLockedHint` for such a share. The account's Personal organization
   * is exempt.
   */
  readonly keepsOrganizationOwnership?: boolean;
  /** Explicit binding keeps Marketplace policy and copy out of other share dialogs. */
  readonly marketplace?: {
    readonly kind: SharedLinkKind;
    /** Stable local source identity, independent of publication results. */
    readonly resourceKey?: string;
  };
  /** Resource eligibility checked before the scope controls render. */
  readonly preflight?: (
    assertCurrent?: () => void,
  ) => Promise<ShareResourcePreflightResult>;
  readonly loadAccount: () => Promise<ShareResourceAccount | null>;
  /**
   * Re-reads the account's access facts before a share and on Try again.
   * Defaults to `loadAccount`.
   */
  readonly refreshAccount?: () => Promise<ShareResourceAccount | null>;
  /**
   * Opens plan selection for an organization without an active plan. Shown
   * only to an account that can choose one.
   */
  readonly onChooseOrganizationPlan?: (organizationId: string) => void;
  /** Optional account-change subscription; returns its unsubscribe. */
  readonly subscribeAccountChanged?: (listener: () => void) => () => void;
  readonly listTeams: (query: string) => Promise<readonly ShareTargetSummary[]>;
  readonly listOrganizations: (
    query: string,
  ) => Promise<readonly ShareTargetSummary[]>;
  readonly share: (
    input: ShareResourceShareInput,
  ) => Promise<ShareResourceOutcome>;
  /** Retries the public link after a `publicLinkFailed` outcome. */
  readonly retryPublicLink?: (
    assertCurrent?: () => void,
  ) => Promise<ShareResourceOutcome>;
  /**
   * Unpublishes an existing public share. With it, a resource whose
   * `existingShare` is Public offers Remove public link (behind a confirm).
   */
  readonly revokePublicLink?: (assertCurrent?: () => void) => Promise<void>;
  /**
   * Opens organization setup for an account with no organization. Resolves
   * `false` (or rejects) when the page could not be opened, which keeps the
   * button and shows an inline retry sentence.
   */
  readonly onSetUpOrganization?: () => Promise<boolean>;
  readonly copyText: (text: string) => Promise<boolean>;
  /**
   * Posts a toast for an outcome that closes the dialog: a removed public
   * link or an unconfirmed delivery. A landed share never toasts; the dialog
   * stays open on its success notice. Share toasts are feedback to a click:
   * hosts show them even with in-app notifications off.
   */
  readonly notify: ShareNotify;
  /** Maps a thrown value to a user-facing sentence. */
  readonly resolveErrorMessage?: (error: unknown) => string;
  readonly onClose: () => void;
  /** Opens account settings from the not-connected empty state. */
  readonly onOpenAccountSettings?: () => void;
  /** Opens the connect gate for a guest account. */
  readonly onConnect?: () => void;
  /**
   * Informational: fires the moment a share succeeds, before `onCompleted`
   * runs. Hosts must not unmount the dialog from here.
   */
  readonly onShareSucceeded?: (result: {
    scope: ShareResourceScope;
    outcome: ShareResourceOutcome;
  }) => void;
  /**
   * Runs after a successful share, before the dialog shows its success
   * notice. If it throws, the dialog shows the error notice instead. Either
   * way the dialog stays open until the author dismisses it through
   * `onClose`, so hosts must not unmount it from here.
   */
  readonly onCompleted?: () => void | Promise<void>;
  /** Fires whenever the audience or its target changes. */
  readonly onAudienceChange?: () => void;
  /** Reports sanitized state for host integrations such as App Advisor. */
  readonly onStateChange?: (state: ShareResourceDialogState) => void;
}

/** The host's notice for a reopened share. */
export interface ShareReopenedNotice {
  /** `attention` for a share whose last update didn't land. */
  readonly tone: 'positive' | 'attention';
  readonly title: string;
  /** Lines under the title, e.g. what the audience can do. */
  readonly details?: readonly string[];
}

/** Host copy and operation for Stop sharing. */
export interface ShareStopSharing {
  /** The footer action and the confirmation's action. */
  readonly label: string;
  readonly confirm: {
    readonly title: string;
    /** Who loses access and what is deleted. */
    readonly body: string;
    readonly busyLabel: string;
  };
  readonly onStop: () => Promise<void>;
  /** Success toast; the dialog closes. */
  readonly toast: string;
}

type DialogState =
  | { status: 'idle' }
  | { status: 'sharing' }
  // The share landed but its public link did not: the dialog stays open with
  // the partial notice and Retry public link.
  | {
      status: 'partial';
      outcome: ShareResourceOutcome;
      retryError?: string;
    }
  // The share landed: the dialog stays open on the success notice, with the
  // link and Copy link, until Done.
  | { status: 'success'; completion: ShareCompletion }
  | {
      status: 'error';
      message: string;
      /** What the error notice offers, for a classified failure. */
      recovery?: ShareFailureRecovery;
      /** The remote share landed; only host completion remains retryable. */
      completion?: ShareCompletion;
    };

interface ShareCompletion {
  readonly completedScope: ShareResourceScope | null;
  readonly outcome: ShareResourceOutcome;
  readonly wasUpdate: boolean;
  /**
   * Stay open on the success notice. A dismissal that completes the share
   * (Done on a partial share or a failed completion) closes instead.
   */
  readonly showSuccess: boolean;
}

type PreflightState =
  | { status: 'checking' }
  | Exclude<ShareResourcePreflightResult, { status: 'ready' }>
  | { status: 'ready' };

function defaultErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : 'Something went wrong.';
}

/**
 * Stable default for a host that reports no context organizations. A fresh
 * array per render would re-run the selection effect after every render and
 * clear the organization the author just picked.
 */
const NO_CONTEXT_ORGANIZATIONS: readonly ShareTargetSummary[] = [];

export function ShareResourceDialog({
  resourceNoun,
  testIdPrefix,
  ownerDocument,
  requiredCapability,
  copy: copyOverrides,
  freeAccess = false,
  scopes,
  context,
  contextOrganizations = NO_CONTEXT_ORGANIZATIONS,
  subtitle,
  notes,
  audienceAvailability,
  landing,
  audienceDescriptions,
  extraOptions,
  maxWidth,
  shareDisabled = false,
  capabilityPackage,
  packageUnavailableNote = false,
  existingShare: rawExistingShare,
  audienceLocked,
  reopenedNotice,
  stopSharing,
  retry,
  marketplace,
  keepsOrganizationOwnership = false,
  preflight,
  loadAccount,
  refreshAccount,
  onChooseOrganizationPlan,
  subscribeAccountChanged,
  listTeams,
  listOrganizations,
  share,
  retryPublicLink,
  revokePublicLink,
  onSetUpOrganization,
  personalOrganizationUpgradePort,
  copyText,
  resolveErrorMessage = defaultErrorMessage,
  onClose,
  onOpenAccountSettings,
  onConnect,
  notify,
  onShareSucceeded,
  onCompleted,
  onAudienceChange,
  onStateChange,
}: ShareResourceDialogProps): JSX.Element {
  const [account, setAccount] = useState<ShareResourceAccount | null>(null);
  const {
    context: policyContext,
    personalOrganizationId: contextPersonalOrganizationId,
    ready: policyReady,
  } = useResourceContext();
  // Context policy applies once the host reports a context. Until the host
  // knows whether it applies, keep an organization share off Public rather
  // than offer a change the desktop may refuse.
  const accountPolicy = account?.organizationOwnershipPolicy;
  const personalOrganizationId = accountPolicy
    ? accountPolicy.personalOrganizationId
    : contextPersonalOrganizationId;
  const policyMayApply = accountPolicy
    ? accountPolicy.enabled
    : policyContext !== undefined || policyReady === false;
  // Ownership reads the raw share: the Personal renaming below is display only.
  const publicOwnerLocked =
    (keepsOrganizationOwnership || marketplace !== undefined) &&
    policyMayApply &&
    publicAudienceLocked(rawExistingShare, personalOrganizationId);
  const publicOwnerLockedRef = useRef(publicOwnerLocked);
  publicOwnerLockedRef.current = publicOwnerLocked;
  const publicLockedHintId = useId();
  const audienceLockedHintId = useId();
  const existingPersonalOrganization =
    personalOrganizationId !== null &&
    (rawExistingShare?.targetAudience ?? rawExistingShare?.audience) ===
      'organization' &&
    rawExistingShare?.target?.id === personalOrganizationId;
  const existingShare =
    existingPersonalOrganization && rawExistingShare?.target
      ? {
          ...rawExistingShare,
          target: { ...rawExistingShare.target, name: 'Personal' },
        }
      : rawExistingShare;
  const effectiveFreeAccess = account?.freeAccess ?? freeAccess;
  const copy: ShareResourceCopy = {
    ...shareResourceCopy(resourceNoun, { freeAccess: effectiveFreeAccess }),
    ...(marketplace
      ? {
          scopeLegend: 'General access',
          publicDescription:
            'Anyone can open the link, and it can appear in public discovery.',
          publicLockedHint:
            "Organization shares can't be made public. Unshare it, then share it again as Public.",
        }
      : {}),
    ...copyOverrides,
  };
  const describeError = useCallback(
    (error: unknown): string =>
      resourceContextRefusalMessage(error) ?? resolveErrorMessage(error),
    [resolveErrorMessage],
  );
  const p = testIdPrefix;
  const [accountLoading, setAccountLoading] = useState(true);
  const [state, setState] = useState<DialogState>({ status: 'idle' });
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const [retryingSync, setRetryingSync] = useState(false);
  const [retrySyncError, setRetrySyncError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [retryingPublic, setRetryingPublic] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmingRemovePublic, setConfirmingRemovePublic] = useState(false);
  const [removingPublic, setRemovingPublic] = useState(false);
  const [removePublicError, setRemovePublicError] = useState<string | null>(
    null,
  );
  const [organizationSetupFailed, setOrganizationSetupFailed] = useState(false);
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [setupPersonalId, setSetupPersonalId] = useState<string | null>(null);
  const [setupAccountKey, setSetupAccountKey] = useState<string | null>(null);
  const [promotedTarget, setPromotedTarget] =
    useState<ShareTargetSummary | null>(null);
  const [contextChangedLabel, setContextChangedLabel] = useState<string | null>(
    null,
  );
  const [openingOrganizationSetup, setOpeningOrganizationSetup] =
    useState(false);
  const [preflightState, setPreflightState] = useState<PreflightState>(
    preflight ? { status: 'checking' } : { status: 'ready' },
  );
  const [preflightAttempt, setPreflightAttempt] = useState(0);
  // Organizations the server refused for a missing plan since the last
  // account refresh; they read as known-lapsed until facts say otherwise.
  const [refusedOrganizationIds, setRefusedOrganizationIds] = useState<
    readonly string[]
  >([]);
  // The binding whose access check failed, and the binding whose publication
  // ended uncertain. Each applies only while that binding stays selected.
  const [accessCheckFailedBinding, setAccessCheckFailedBinding] = useState<
    string | null
  >(null);
  const [uncertainBinding, setUncertainBinding] = useState<string | null>(null);
  const mutationLifecycle = useRef({ active: true, generation: 0 });
  const loadedAccountIdentity = useRef<string | null>(null);
  const accountReload = useRef<Promise<void>>(Promise.resolve());
  const accountReadPending = useRef(false);
  const accountReadSucceeded = useRef(false);
  const mutationPending = useRef(false);
  const lastAccountRefreshRef = useRef(0);

  const existingTarget = existingShare?.target ?? null;
  // The audience the existing target belongs to. A team or organization share
  // with a public link reads as Public, but its target is still that team or
  // organization, so switching back to it keeps the selection.
  const existingTargetAudience: 'team' | 'organization' | undefined =
    existingShareOwnerAudience(existingShare);
  const existingShareOwnerFixed =
    existingTarget !== null ||
    existingShare?.audience === 'team' ||
    existingShare?.audience === 'organization';
  const [selectedTeam, setSelectedTeam] = useState<ShareTargetSummary | null>(
    existingTargetAudience === 'team' ? existingTarget : null,
  );
  const [selectedOrg, setSelectedOrg] = useState<ShareTargetSummary | null>(
    existingTargetAudience === 'organization'
      ? existingTarget
      : ((): ShareTargetSummary | null => {
          const id = defaultOrganizationForContext(
            context,
            contextOrganizations,
          );
          return id === null
            ? null
            : (contextOrganizations.find(
                (organization) => organization.id === id,
              ) ?? null);
        })(),
  );

  useEffect(() => {
    let cancelled = false;
    // Reads can overlap (an ambient re-probe right after the dialog's own
    // refresh); only the latest one issued applies.
    let latest = 0;
    const reload = (invalidateMutation = false): void => {
      const interrupted = invalidateMutation && mutationPending.current;
      if (invalidateMutation) mutationLifecycle.current.generation += 1;
      const read = ++latest;
      const superseded = (): boolean => cancelled || read !== latest;
      setAccountLoading(true);
      accountReadPending.current = true;
      accountReadSucceeded.current = false;
      accountReload.current = loadAccount()
        .then((next) => {
          if (superseded()) return;
          accountReadSucceeded.current = true;
          // Fence continuations immediately, even when React batches this
          // account update with the response from the old account.
          const identity = JSON.stringify([
            next?.id,
            next?.connected,
            next?.capabilities,
            next?.organizationOwnershipPolicy,
          ]);
          if (identity !== loadedAccountIdentity.current) {
            mutationLifecycle.current.generation += 1;
            loadedAccountIdentity.current = identity;
          } else if (interrupted) {
            // A signal can also follow a write whose response was discarded.
            setPreflightAttempt((attempt) => attempt + 1);
          }
          setAccount(next);
          lastAccountRefreshRef.current = Date.now();
          setRefusedOrganizationIds([]);
        })
        // A failed read leaves the account as it was: a first read stays
        // unavailable, and a failed re-read keeps the form the author is
        // using instead of collapsing it. A sign-out resolves, so it clears.
        .catch(() => undefined)
        .finally(() => {
          if (superseded()) return;
          accountReadPending.current = false;
          setAccountLoading(false);
          if (interrupted) {
            mutationPending.current = false;
            setState({ status: 'idle' });
            setRetryingPublic(false);
            setRemovingPublic(false);
            setFinishing(false);
            setConfirmingRemovePublic(false);
          }
        });
    };
    reload();
    const unsubscribe = subscribeAccountChanged?.((): void => reload(true));
    return (): void => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [loadAccount, subscribeAccountChanged]);

  const isGuest = account?.kind === 'guest';
  const hasResourceCapability =
    account?.capabilities.includes(requiredCapability) === true;
  const hasTeamsCapability =
    account?.capabilities.includes(TEAMS_CAPABILITY) === true;
  const hasOrganizationsCapability =
    account?.capabilities.includes(ORGANIZATIONS_CAPABILITY) === true;
  const accountReady =
    account?.connected === true && hasResourceCapability && !isGuest;
  const hasNoOrganization =
    account?.hasOrganization === false && promotedTarget === null;
  const hasNoTeam = hasNoOrganization || account?.hasTeam === false;
  const accountKey = account?.id ?? null;
  useEffect(() => {
    setPromotedTarget(null);
    setCreatingTeam(false);
    setSetupAccountKey(null);
    setSetupPersonalId(null);
  }, [accountKey]);
  const accountIdentityRef = useRef(accountKey);
  accountIdentityRef.current = accountKey;
  // A completed write belongs only to the context that initiated it. Keep
  // publication facts out of this key: adopting a result must not cancel it.
  const mutationContext = JSON.stringify([
    marketplace?.kind,
    marketplace?.resourceKey,
    accountKey,
    account?.connected,
    account?.capabilities,
    account?.organizationOwnershipPolicy,
    ...(marketplace
      ? [
          policyReady,
          policyMayApply,
          personalOrganizationId,
          audienceAvailability,
        ]
      : []),
  ]);
  const mutationContextRef = useRef(mutationContext);
  mutationContextRef.current = mutationContext;
  useLayoutEffect(() => {
    const lifecycle = mutationLifecycle.current;
    lifecycle.active = true;
    lifecycle.generation += 1;
    mutationPending.current = false;
    setState({ status: 'idle' });
    setRetryingPublic(false);
    setRemovingPublic(false);
    setFinishing(false);
    setConfirmingRemovePublic(false);
    setRemovePublicError(null);
    setCopied(false);
    return (): void => {
      lifecycle.active = false;
      lifecycle.generation += 1;
    };
  }, [mutationContext]);
  const captureMutation = useCallback((): (() => boolean) => {
    const generation = mutationLifecycle.current.generation;
    return (): boolean =>
      mutationLifecycle.current.active &&
      mutationLifecycle.current.generation === generation;
  }, []);
  const reconcileObsoleteMutation = useCallback((): void => {
    if (mutationLifecycle.current.active && !mutationPending.current) {
      setPreflightAttempt((attempt) => attempt + 1);
    }
  }, []);
  const upgradePersonalId =
    account?.personalOrganizationId ?? personalOrganizationId;
  const canCreateTeam =
    personalOrganizationUpgradePort?.canPromote === true &&
    upgradePersonalId !== null &&
    accountKey !== null &&
    !isGuest;
  const accountUnavailableLabel =
    account?.connected === true && !hasResourceCapability
      ? copy.missingCapability
      : copy.emptyState;

  useEffect(() => {
    if (!preflight || !accountReady) return undefined;
    let cancelled = false;
    setPreflightState({ status: 'checking' });
    const isCurrent = captureMutation();
    preflight((): void => {
      if (!isCurrent())
        throw new Error('The sharing context changed. Try again.');
    })
      .then((result) => {
        if (!cancelled) {
          setPreflightState(result);
          if (result.status === 'ready') setUncertainBinding(null);
          if (result.status === 'blocked') setState({ status: 'idle' });
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPreflightState({
          status: 'blocked',
          body: (
            <ErrorBanner
              className=""
              error={shareFailureMessage(resourceNoun, describeError(error))}
            />
          ),
        });
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    accountKey,
    accountReady,
    captureMutation,
    mutationContext,
    describeError,
    preflight,
    preflightAttempt,
    resourceNoun,
  ]);
  const preflightReady = preflightState.status === 'ready';

  // A Personal organization can't share with a team or organization until it
  // becomes a team. Those scopes stay offered, disabled, so the author still
  // sees every audience and which one Share will use.
  const personalScopesLocked =
    context?.kind === 'personal' && promotedTarget === null;
  const personalLocks = (candidate: 'team' | 'organization'): boolean =>
    personalScopesLocked &&
    existingTargetAudience !== candidate &&
    !(candidate === 'organization' && existingPersonalOrganization);
  const offeredScopes = scopes;
  const lockedAudience =
    audienceLocked !== undefined ? existingShare?.audience : undefined;
  const unlockedAvailability: Partial<Record<ShareAudience, boolean>> = {
    ...audienceAvailability,
    ...(publicOwnerLocked ? { public: false } : {}),
    team:
      !personalLocks('team') &&
      hasTeamsCapability &&
      !hasNoTeam &&
      audienceAvailability?.team !== false,
    organization:
      !personalLocks('organization') &&
      (existingPersonalOrganization ||
        (hasOrganizationsCapability && !hasNoOrganization)) &&
      audienceAvailability?.organization !== false,
  };
  // A locked share keeps only its own audience, usable even if the account
  // lost it since: the view is read-only.
  const availability: Partial<Record<ShareAudience, boolean>> =
    lockedAudience === undefined
      ? unlockedAvailability
      : Object.fromEntries(
          offeredScopes.map((audience) => [
            audience,
            audience === lockedAudience,
          ]),
        );
  // A legacy public link on a locked owner opens on its owner's audience,
  // never on the Public it can no longer keep.
  const initialAudience =
    existingShare?.audience === 'public' &&
    publicOwnerLocked &&
    existingTargetAudience !== undefined
      ? existingTargetAudience
      : existingShare?.audience;
  const { audience: scope, setAudience } = useShareAudience({
    offered: offeredScopes,
    availability,
    ...(initialAudience !== undefined ? { initial: initialAudience } : {}),
    ready: accountReady,
  });
  // Explain the lock only where Public would otherwise be offered and usable.
  const showPublicLockedHint =
    publicOwnerLocked &&
    offeredScopes.includes('public') &&
    audienceAvailability?.public !== false;
  const offersScopedAudience =
    offeredScopes.includes('team') || offeredScopes.includes('organization');
  // No organization: Team and Organization wait on organization setup, not
  // on an upgrade, so the setup CTA replaces the upgrade hint.
  const needsOrganization =
    !personalScopesLocked &&
    hasNoOrganization &&
    offersScopedAudience &&
    !existingPersonalOrganization;
  const hasUsableAudience = offeredScopes.some(
    (audience) => audience !== 'private' && availability[audience] !== false,
  );
  // Nothing to share with until an organization exists: the setup statement
  // replaces the selector.
  const needsSetupGate = needsOrganization && !hasUsableAudience;
  // An organization member with no team: Team is disabled for a reason the
  // upgrade and organization hints don't cover, so say why.
  const needsTeam =
    !personalScopesLocked &&
    !needsOrganization &&
    account?.hasTeam === false &&
    offeredScopes.includes('team') &&
    hasTeamsCapability;
  const teamNeedsUpgrade =
    !personalScopesLocked &&
    !needsOrganization &&
    (!hasTeamsCapability || audienceAvailability?.team === false);
  const organizationNeedsUpgrade =
    !personalScopesLocked &&
    !needsOrganization &&
    !existingPersonalOrganization &&
    (!hasOrganizationsCapability ||
      audienceAvailability?.organization === false);
  // A public share that just landed offers removal at once, like a reopened
  // one: the host's existing share may still describe the audience the share
  // replaced. Other finished states keep it hidden until the share settles.
  const canRemovePublicLink =
    revokePublicLink !== undefined &&
    (state.status === 'success'
      ? state.completion.completedScope === 'public' &&
        state.completion.outcome.shareUrl !== undefined
      : state.status !== 'partial' &&
        !(state.status === 'error' && state.completion !== undefined) &&
        existingShare?.audience === 'public');

  const pkg = useCapabilityPackageShare({
    port: capabilityPackage?.port ?? null,
    enabled: accountReady && preflightReady,
  });

  // Problems get fixed outside this dialog (installing a skill, editing a
  // file), so a blocked review checks again on its own when the window
  // regains focus, and when its analysis expires. There is no Recheck button.
  const blockedPackageAnalysis =
    pkg.active && pkg.analysis !== null && pkg.analysis.blockers.length > 0
      ? pkg.analysis
      : null;
  const retryPackageAnalysis = pkg.retry;
  const packageAnalyzingRef = useRef(pkg.analyzing);
  packageAnalyzingRef.current = pkg.analyzing;
  const packageBlocked = blockedPackageAnalysis !== null;
  useEffect(() => {
    if (!packageBlocked) return undefined;
    const view = (ownerDocument ?? document).defaultView;
    if (!view) return undefined;
    const recheck = (): void => {
      if (!packageAnalyzingRef.current) retryPackageAnalysis();
    };
    view.addEventListener('focus', recheck);
    return (): void => view.removeEventListener('focus', recheck);
  }, [ownerDocument, packageBlocked, retryPackageAnalysis]);
  const blockedPackageId = blockedPackageAnalysis?.analysisId;
  const blockedPackageExpiresAt = blockedPackageAnalysis?.expiresAt;
  useEffect(() => {
    if (blockedPackageExpiresAt === undefined) return undefined;
    const remaining = Date.parse(blockedPackageExpiresAt) - Date.now();
    // Only a future expiry schedules, so an analysis that arrives unreadable
    // or already expired cannot start a re-analysis loop.
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
    const timer = setTimeout(
      (): void => {
        if (!packageAnalyzingRef.current) retryPackageAnalysis();
      },
      Math.min(remaining, 2_147_483_647),
    );
    return (): void => clearTimeout(timer);
  }, [blockedPackageExpiresAt, blockedPackageId, retryPackageAnalysis]);

  // The re-check prompt only makes sense while the fresh analysis can still
  // land; a failed one shows its own Retry copy instead.
  const packageAnalysisFailed = pkg.failed;
  useEffect(() => {
    if (!packageAnalysisFailed) return;
    setValidationError((current) =>
      current === PACKAGE_RECHECK_MESSAGE ? null : current,
    );
  }, [packageAnalysisFailed]);

  const onAudienceChangeRef = useRef(onAudienceChange);
  onAudienceChangeRef.current = onAudienceChange;
  const notifyAudienceChange = useCallback((): void => {
    onAudienceChangeRef.current?.();
  }, []);

  const contextDefaultOrganizationId = defaultOrganizationForContext(
    context,
    contextOrganizations,
  );
  const contextDefaultOrganization =
    publicOwnerLocked || contextDefaultOrganizationId === null
      ? null
      : (contextOrganizations.find(
          (organization) => organization.id === contextDefaultOrganizationId,
        ) ?? null);

  useEffect(() => {
    if (existingTargetAudience === 'organization') return;
    setSelectedOrg((current) => {
      if (current !== null) {
        const refreshed = contextOrganizations.find(
          (organization) => organization.id === current.id,
        );
        if (refreshed) return refreshed;
      }
      return contextDefaultOrganization;
    });
  }, [
    accountKey,
    contextDefaultOrganization,
    contextOrganizations,
    existingTargetAudience,
  ]);

  useContextRebind(
    context,
    (next) => {
      const nextOrganizationId = defaultOrganizationForContext(
        next,
        contextOrganizations,
      );
      setSelectedOrg(
        nextOrganizationId === null
          ? null
          : (contextOrganizations.find(
              (organization) => organization.id === nextOrganizationId,
            ) ?? null),
      );
      setSelectedTeam((current) =>
        next.kind === 'organization' &&
        current?.organizationId !== undefined &&
        current.organizationId === next.organizationId
          ? current
          : null,
      );
      setValidationError(null);
      setContextChangedLabel(contextLabel(next, contextOrganizations));
      notifyAudienceChange();
    },
    existingShareOwnerFixed || state.status === 'sharing',
  );

  // A scope change drops the target, unless it lands back on the existing
  // share's audience, whose target stays preselected.
  const previousScope = useRef(scope);
  const existingAudience = existingTargetAudience;
  const existingTargetId = existingTarget?.id;
  const existingTargetName = existingTarget?.name;
  const existingTargetOrganizationId = existingTarget?.organizationId;
  const existingTargetSecondaryLabel = existingTarget?.secondaryLabel;
  useEffect(() => {
    const target =
      existingTargetId && existingTargetName
        ? {
            id: existingTargetId,
            name: existingTargetName,
            ...(existingTargetOrganizationId
              ? { organizationId: existingTargetOrganizationId }
              : {}),
            ...(existingTargetSecondaryLabel
              ? { secondaryLabel: existingTargetSecondaryLabel }
              : {}),
          }
        : null;
    setSelectedTeam(existingAudience === 'team' ? target : null);
    setSelectedOrg(existingAudience === 'organization' ? target : null);
  }, [
    existingAudience,
    existingTargetId,
    existingTargetName,
    existingTargetOrganizationId,
    existingTargetSecondaryLabel,
  ]);
  useEffect(() => {
    if (previousScope.current === scope) return;
    previousScope.current = scope;
    setSelectedTeam(
      existingAudience === 'team' && scope === 'team' ? existingTarget : null,
    );
    setSelectedOrg(
      existingAudience === 'organization' && scope === 'organization'
        ? existingTarget
        : scope === 'organization'
          ? contextDefaultOrganization
          : null,
    );
    setValidationError(null);
    notifyAudienceChange();
  }, [
    contextDefaultOrganization,
    existingAudience,
    existingTarget,
    notifyAudienceChange,
    scope,
  ]);

  // A switch to another account is an audience change too: checks made for
  // the previous account no longer apply. The first identity is not a switch.
  const previousAccountKey = useRef(accountKey);
  useEffect(() => {
    const previous = previousAccountKey.current;
    previousAccountKey.current = accountKey;
    if (previous !== null && previous !== accountKey) {
      setSelectedTeam(null);
      setSelectedOrg(contextDefaultOrganization);
      notifyAudienceChange();
    }
  }, [accountKey, contextDefaultOrganization, notifyAudienceChange]);

  // The dialog's ports take the query as a string; the shared search hook
  // passes `undefined` for an empty one.
  const loadTeams = useCallback(
    async (query?: string) => {
      const rows = await listTeams(query ?? '');
      if (context?.kind !== 'organization') return rows;
      return rows.filter(
        (row) =>
          row.organizationId === undefined ||
          row.organizationId === context.organizationId,
      );
    },
    [context, listTeams],
  );
  const loadOrganizations = useCallback(
    (query?: string) => listOrganizations(query ?? ''),
    [listOrganizations],
  );
  const teams = useShareTargetSearch({
    resetKey: accountKey,
    enabled:
      scope === 'team' &&
      availability.team !== false &&
      accountReady &&
      hasTeamsCapability,
    load: loadTeams,
    formatError: resolveErrorMessage,
  });
  const orgs = useShareTargetSearch({
    resetKey: accountKey,
    enabled:
      scope === 'organization' &&
      availability.organization !== false &&
      accountReady &&
      hasOrganizationsCapability &&
      !existingPersonalOrganization,
    load: loadOrganizations,
    formatError: resolveErrorMessage,
  });

  // A scoped owner is not proof of current membership. Only an unfiltered,
  // successful load can invalidate a selection; a search omitting it cannot.
  useEffect(() => {
    if (!publicOwnerLocked) return;
    if (
      !teams.loading &&
      teams.error === null &&
      teams.search.trim() === '' &&
      teams.resultQuery === '' &&
      teams.items !== null
    ) {
      setSelectedTeam((current) =>
        current !== null &&
        !teams.items?.some((target) => target.id === current.id)
          ? null
          : current,
      );
    }
    if (
      !orgs.loading &&
      orgs.error === null &&
      orgs.search.trim() === '' &&
      orgs.resultQuery === '' &&
      orgs.items !== null
    ) {
      setSelectedOrg((current) =>
        current !== null &&
        !orgs.items?.some((target) => target.id === current.id)
          ? null
          : current,
      );
    }
  }, [
    publicOwnerLocked,
    teams.loading,
    teams.error,
    teams.search,
    teams.resultQuery,
    teams.items,
    orgs.loading,
    orgs.error,
    orgs.search,
    orgs.resultQuery,
    orgs.items,
  ]);

  const isBusy =
    state.status === 'sharing' ||
    retryingPublic ||
    removingPublic ||
    finishing ||
    stopping ||
    retryingSync;
  // Hosts commonly cache the newly-created detail for public-link retry. Do
  // not let that post-submit metadata turn a create result into "Updated".
  // Async metadata loaded while the form is still idle can still establish
  // update mode before submission.
  const updateModeRef = useRef(existingShare !== undefined);
  if (state.status === 'idle') {
    updateModeRef.current = existingShare !== undefined;
  }
  const isUpdate = updateModeRef.current;
  const packageActive = pkg.active;
  const targetName =
    scope === 'team'
      ? selectedTeam?.name
      : scope === 'organization'
        ? selectedOrg?.name
        : undefined;
  const selectedTeamId = selectedTeam?.id;
  const selectedOrganizationId = selectedOrg?.id;
  // Everything a share attempt is bound to. A check or uncertain result for
  // one binding never applies to another.
  const bindingKey = JSON.stringify([
    accountKey,
    scope,
    scope === 'team'
      ? (selectedTeamId ?? null)
      : scope === 'organization'
        ? (selectedOrganizationId ?? null)
        : null,
  ]);
  const bindingRef = useRef(bindingKey);
  bindingRef.current = bindingKey;

  // Fix it with AI: one launch at a time, snapshotted at click time. A launch
  // that finishes after the subject or audience moved on leaves the dialog
  // open, so it can never close or overwrite a newer review.
  const repair = capabilityPackage?.repair;
  const [repairPending, setRepairPending] = useState(false);
  const [repairFailed, setRepairFailed] = useState(false);
  const repairPendingRef = useRef(false);
  const repairMountedRef = useRef(true);
  useEffect(() => {
    repairMountedRef.current = true;
    return (): void => {
      repairMountedRef.current = false;
    };
  }, []);
  const repairAnalysis = pkg.analysis;
  useEffect(() => {
    setRepairFailed(false);
  }, [repairAnalysis]);
  const repairSubjectKey = repair ? JSON.stringify(repair.subject) : null;
  const repairKey = JSON.stringify([
    repairSubjectKey,
    bindingKey,
    repairAnalysis?.analysisId ?? null,
  ]);
  useEffect(() => {
    setRepairFailed(false);
  }, [repairKey]);
  const repairKeyRef = useRef(repairKey);
  repairKeyRef.current = repairKey;
  // Offered beside a blocking analysis; a stale or running one keeps the
  // button visible but disabled until the automatic recheck lands.
  const repairOffered =
    repair !== undefined &&
    pkg.active &&
    repairAnalysis !== null &&
    repairAnalysis.blockers.length > 0;
  const [repairExpired, setRepairExpired] = useState(false);
  useEffect(() => {
    const expiresAt = Date.parse(repairAnalysis?.expiresAt ?? '');
    const remaining = expiresAt - Date.now();
    setRepairExpired(!Number.isFinite(remaining) || remaining <= 0);
    if (!Number.isFinite(remaining) || remaining <= 0) return undefined;
    const timer = setTimeout(
      () => setRepairExpired(true),
      Math.min(remaining, 2_147_483_647),
    );
    return (): void => clearTimeout(timer);
  }, [repairAnalysis]);
  const canRepair =
    repairOffered && !pkg.analyzing && !pkg.failed && !repairExpired;
  const startRepair = useCallback((): void => {
    if (
      !repair ||
      !canRepair ||
      !repairAnalysis ||
      Date.parse(repairAnalysis.expiresAt) <= Date.now()
    )
      return;
    if (repairPendingRef.current) return;
    const launchKey = repairKeyRef.current;
    let launch: Parameters<CapabilityPackageRepairBinding['open']>[0];
    try {
      const request = buildCapabilityPackageRepairRequest({
        binding: repair,
        audience: {
          scope,
          selected:
            scope === 'team' && selectedTeam
              ? { id: selectedTeam.id, name: selectedTeam.name }
              : scope === 'organization' && selectedOrg
                ? { id: selectedOrg.id, name: selectedOrg.name }
                : null,
        },
        analysis: repairAnalysis,
        dismissedInvocations: repairAnalysis.dismissedInvocations ?? [],
      });
      launch = { request, prompt: buildCapabilityPackageRepairPrompt(request) };
    } catch {
      setRepairFailed(true);
      return;
    }
    repairPendingRef.current = true;
    setRepairPending(true);
    setRepairFailed(false);
    void Promise.resolve()
      .then(() => repair.open(launch))
      .then(
        () => {
          repairPendingRef.current = false;
          if (!repairMountedRef.current) return;
          setRepairPending(false);
          if (repairKeyRef.current === launchKey) onClose();
        },
        () => {
          repairPendingRef.current = false;
          if (!repairMountedRef.current) return;
          setRepairPending(false);
          if (repairKeyRef.current === launchKey) setRepairFailed(true);
        },
      );
  }, [
    canRepair,
    onClose,
    repair,
    repairAnalysis,
    scope,
    selectedOrg,
    selectedTeam,
  ]);
  const resolveAccess = useCallback(
    (
      facts: ShareResourceAccount | null,
      refused: readonly string[],
    ): ShareDestinationAccess => {
      const organizationAccess = withRefusedOrganizations(
        facts?.organizationAccess,
        refused,
      );
      return resolveSelectedDestinationAccess(
        {
          ...(organizationAccess !== undefined ? { organizationAccess } : {}),
          freeAccess: facts?.freeAccess ?? freeAccess,
        },
        scope,
        selectedTeam,
        selectedOrg,
      );
    },
    [freeAccess, scope, selectedOrg, selectedTeam],
  );
  const destinationAccess = resolveAccess(account, refusedOrganizationIds);
  const reportsAccessFacts = account?.organizationAccess !== undefined;
  const refreshAccountRef = useRef(refreshAccount ?? loadAccount);
  refreshAccountRef.current = refreshAccount ?? loadAccount;

  /**
   * Re-reads the account's access facts for the current binding. Resolves the
   * fresh account, or `null` when the check failed, timed out, or the author
   * moved on to another binding meanwhile. A failure never blocks a share.
   */
  const refreshDestinationAccess = useCallback(
    async (
      reason: 'target' | 'retry' | 'publish',
    ): Promise<ShareResourceAccount | null> => {
      const binding = bindingRef.current;
      const initiatingAccount = accountIdentityRef.current;
      let next: ShareResourceAccount | null;
      try {
        const request = refreshAccountRef.current();
        next = await (reason === 'publish'
          ? withTimeout(request, ACCESS_REFRESH_TIMEOUT_MS)
          : request);
      } catch {
        if (reason !== 'publish' && bindingRef.current === binding) {
          setAccessCheckFailedBinding(binding);
        }
        return null;
      }
      if (
        bindingRef.current !== binding ||
        next === null ||
        (next.id ?? null) !== initiatingAccount
      ) {
        return null;
      }
      lastAccountRefreshRef.current = Date.now();
      setAccount(next);
      setRefusedOrganizationIds([]);
      setAccessCheckFailedBinding(null);
      return next;
    },
    [],
  );

  // A newly selected destination whose access the facts don't cover gets one
  // fresh read. Hosts that report no facts at all have nothing to refresh.
  const destinationUnknownOrganizationId =
    destinationAccess.status === 'unknown'
      ? destinationAccess.organizationId
      : undefined;
  useEffect(() => {
    if (
      !accountReady ||
      !reportsAccessFacts ||
      destinationUnknownOrganizationId === undefined
    ) {
      return;
    }
    void refreshDestinationAccess('target');
  }, [
    accountReady,
    bindingKey,
    destinationUnknownOrganizationId,
    refreshDestinationAccess,
    reportsAccessFacts,
  ]);

  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;
  useEffect(() => {
    onStateChangeRef.current?.({
      audience: scope,
      ...(scope === 'team' && selectedTeamId ? { teamId: selectedTeamId } : {}),
      ...(scope === 'organization' && selectedOrganizationId
        ? { organizationId: selectedOrganizationId }
        : {}),
      available: accountReady,
      busy: isBusy,
      status:
        state.status === 'partial'
          ? 'success'
          : finishing
            ? 'sharing'
            : state.status,
      copied,
    });
  }, [
    accountReady,
    copied,
    finishing,
    isBusy,
    scope,
    selectedOrganizationId,
    selectedTeamId,
    state.status,
  ]);

  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  /**
   * A share landed: run the host's completion hook, then show the success
   * notice (or close, for a dismissal). If the hook throws, show the error
   * notice instead.
   */
  const complete = useCallback(
    async (completion: ShareCompletion): Promise<void> => {
      const isCurrent = captureMutation();
      mutationPending.current = true;
      setFinishing(true);
      try {
        await onCompleted?.();
      } catch (error: unknown) {
        if (!isCurrent()) {
          reconcileObsoleteMutation();
          return;
        }
        const rolledBack = isShareCompletionRolledBackError(error);
        if (rolledBack) updateModeRef.current = false;
        setState({
          status: 'error',
          message: shareFailureMessage(resourceNoun, describeError(error)),
          // A compensated completion failure left no remote share to finish.
          // Return to the real Share action instead of persisting a revoked id.
          ...(rolledBack ? {} : { completion }),
        });
        return;
      } finally {
        if (isCurrent()) {
          mutationPending.current = false;
          setFinishing(false);
        }
      }
      if (!isCurrent()) {
        reconcileObsoleteMutation();
        return;
      }
      if (completion.showSuccess) {
        setState({ status: 'success', completion });
      } else {
        onClose();
      }
    },
    [
      captureMutation,
      reconcileObsoleteMutation,
      describeError,
      onClose,
      onCompleted,
      resourceNoun,
    ],
  );

  const handleShare = useCallback(async (): Promise<void> => {
    if (!accountReady || scope === null || accountReadPending.current) return;
    let isCurrent = captureMutation();
    const initiatingContext = mutationContextRef.current;
    const initiatingAccount = loadedAccountIdentity.current;
    const initiatingBinding = bindingRef.current;
    if (scope === 'public' && publicOwnerLockedRef.current) {
      setValidationError(copy.publicLockedHint);
      return;
    }
    if (scope === 'team' && !selectedTeam) {
      setValidationError(copy.teamValidationError);
      return;
    }
    if (scope === 'organization' && !selectedOrg) {
      setValidationError(copy.organizationValidationError);
      return;
    }
    // Every share with a dependency review includes its package, so the
    // dialog itself recovers when the reviewed analysis can no longer commit.
    // A ready analysis can expire while this dialog remains open.
    if (
      packageActive &&
      pkg.analysis &&
      Date.parse(pkg.analysis.expiresAt) <= Date.now()
    ) {
      setValidationError(PACKAGE_RECHECK_MESSAGE);
      pkg.retry();
      return;
    }
    setValidationError(null);
    setRemovePublicError(null);
    setCopied(false);
    pkg.resetProgress();
    const wasUpdate = updateModeRef.current;
    setState({ status: 'sharing' });
    // Re-read the destination's access unless a recent read covers it. A
    // known missing plan stops here, before any upload; a failed or slow
    // check proceeds and the server decides.
    if (
      (scope === 'team' || scope === 'organization') &&
      reportsAccessFacts &&
      Date.now() - lastAccountRefreshRef.current > ACCESS_REFRESH_FRESH_MS
    ) {
      const refreshed = await refreshDestinationAccess('publish');
      await accountReload.current;
      if (!isCurrent()) {
        if (
          !mutationLifecycle.current.active ||
          !accountReadSucceeded.current ||
          initiatingAccount !== loadedAccountIdentity.current ||
          initiatingContext !== mutationContextRef.current ||
          initiatingBinding !== bindingRef.current
        ) {
          if (
            mutationLifecycle.current.active &&
            initiatingContext === mutationContextRef.current &&
            initiatingBinding === bindingRef.current &&
            !mutationPending.current
          )
            setState({ status: 'idle' });
          return;
        }
        isCurrent = captureMutation();
        setState({ status: 'sharing' });
      }
      if (
        refreshed !== null &&
        resolveAccess(refreshed, []).status === 'lapsed'
      ) {
        mutationPending.current = false;
        setState({ status: 'idle' });
        return;
      }
    }
    mutationPending.current = true;
    let outcome: ShareResourceOutcome;
    try {
      outcome = await share({
        scope,
        ...(publicOwnerLocked && rawExistingShare?.audience === 'public'
          ? { preservePublicLink: true }
          : {}),
        ...(marketplace || (keepsOrganizationOwnership && scope === 'public')
          ? {
              assertAllowed: (): void => {
                if (!isCurrent())
                  throw new Error('The sharing context changed. Try again.');
                if (scope === 'public' && publicOwnerLockedRef.current)
                  throw new Error(copy.publicLockedHint);
              },
            }
          : {}),
        ...(scope === 'team' && selectedTeam
          ? { teamId: selectedTeam.id }
          : {}),
        ...(scope === 'organization' && selectedOrg
          ? { organizationId: selectedOrg.id }
          : {}),
        ...(targetName ? { targetName } : {}),
        ...(packageActive ? { packageSelection: pkg.selection() } : {}),
      });
    } catch (error: unknown) {
      if (!isCurrent()) {
        reconcileObsoleteMutation();
        return;
      }
      mutationPending.current = false;
      const failure =
        error instanceof ShareConflictError
          ? null
          : classifyShareFailure(error);
      // The destination notice explains a missing plan only for the selected
      // destination's own organization; any other refusal stays an error.
      const governingOrganizationId =
        scope === 'organization'
          ? selectedOrg?.id
          : scope === 'team'
            ? selectedTeam?.organizationId
            : undefined;
      const refusedOrganizationId =
        failure?.kind === 'organization-plan' &&
        governingOrganizationId !== undefined &&
        // Free access never renders the notice, so the error must say it.
        !effectiveFreeAccess &&
        (failure.organizationId === undefined ||
          failure.organizationId === governingOrganizationId)
          ? governingOrganizationId
          : undefined;
      if (refusedOrganizationId !== undefined) {
        // The destination notice explains a missing plan and offers the
        // recovery; repeating it as an error would say it twice.
        setRefusedOrganizationIds((current) =>
          current.includes(refusedOrganizationId)
            ? current
            : [...current, refusedOrganizationId],
        );
        setState({ status: 'idle' });
        return;
      }
      if (
        failure?.commitState === 'unknown' ||
        failure?.commitState === 'committed'
      ) {
        // Repeating an uncertain or landed share could create a duplicate.
        setUncertainBinding(bindingRef.current);
      }
      setState({
        status: 'error',
        message:
          error instanceof ShareConflictError
            ? copy.conflict
            : failure !== null
              ? (resourceContextRefusalMessage(error) ??
                shareFailureCopy(resourceNoun, failure))
              : shareFailureMessage(resourceNoun, describeError(error)),
        ...(failure !== null
          ? { recovery: shareFailureRecovery(failure) }
          : {}),
      });
      // A connection, sign-in, plan or permission failure leaves the reviewed
      // files valid, so the selection stays. Anything that may mean main no
      // longer holds the analysis (changed files, eviction, an unclassified
      // error) re-reviews, since a still-`ready` review offers no Retry.
      const keepsReview =
        failure !== null &&
        failure.kind !== 'dependency-review' &&
        failure.kind !== 'unknown';
      if (
        packageActive &&
        !(error instanceof ShareConflictError) &&
        !keepsReview
      ) {
        pkg.retry();
      }
      return;
    }
    if (!isCurrent()) {
      reconcileObsoleteMutation();
      return;
    }
    mutationPending.current = false;
    if (outcome.delivery === 'pending') {
      // Accepted but unconfirmed: close without completion, success copy or a
      // link, and never resubmit. The host's close path refreshes its lists.
      setState({ status: 'idle' });
      onClose();
      notifyRef.current({
        tone: 'warning',
        message: outcome.message ?? sharePendingMessage(resourceNoun),
      });
      return;
    }
    onShareSucceeded?.({ scope, outcome });
    if (outcome.publicLinkFailed === true) {
      setState({ status: 'partial', outcome });
      return;
    }
    setState({ status: 'idle' });
    await complete({
      completedScope: scope,
      outcome,
      wasUpdate,
      showSuccess: true,
    });
  }, [
    accountReady,
    captureMutation,
    reconcileObsoleteMutation,
    complete,
    copy.conflict,
    copy.organizationValidationError,
    copy.publicLockedHint,
    copy.teamValidationError,
    describeError,
    effectiveFreeAccess,
    keepsOrganizationOwnership,
    marketplace,
    onClose,
    onShareSucceeded,
    packageActive,
    pkg,
    publicOwnerLocked,
    rawExistingShare?.audience,
    refreshDestinationAccess,
    reportsAccessFacts,
    resolveAccess,
    resourceNoun,
    scope,
    selectedOrg,
    selectedTeam,
    share,
    targetName,
  ]);

  const handleRetryPublic = useCallback((): void => {
    if (!retryPublicLink || accountReadPending.current) return;
    if (publicOwnerLockedRef.current) {
      setState((current) =>
        current.status === 'partial'
          ? { ...current, retryError: copy.publicLockedHint }
          : current,
      );
      return;
    }
    const isCurrent = captureMutation();
    mutationPending.current = true;
    setRetryingPublic(true);
    retryPublicLink((): void => {
      if (!isCurrent())
        throw new Error('The sharing context changed. Try again.');
      if (publicOwnerLockedRef.current) throw new Error(copy.publicLockedHint);
    })
      .then(async (outcome) => {
        if (!isCurrent()) {
          reconcileObsoleteMutation();
          return;
        }
        mutationPending.current = false;
        setRetryingPublic(false);
        if (outcome.publicLinkFailed === true) {
          setState({ status: 'partial', outcome });
          return;
        }
        // A retry is specifically completing public-link creation, so its
        // success notice says "is now public" even though the scoped share
        // now exists underneath it.
        await complete({
          completedScope: 'public',
          outcome,
          wasUpdate: false,
          showSuccess: true,
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          reconcileObsoleteMutation();
          return;
        }
        mutationPending.current = false;
        // Keep the partial notice and Retry affordance, but explain why this
        // attempt failed instead of silently returning to the same state.
        setRetryingPublic(false);
        setState((current) =>
          current.status === 'partial'
            ? {
                ...current,
                retryError: describeError(error),
              }
            : current,
        );
      });
  }, [
    captureMutation,
    reconcileObsoleteMutation,
    complete,
    copy.publicLockedHint,
    describeError,
    retryPublicLink,
  ]);

  const handleRemovePublicLink = useCallback((): void => {
    if (!revokePublicLink || accountReadPending.current) return;
    const isCurrent = captureMutation();
    mutationPending.current = true;
    setRemovePublicError(null);
    setRemovingPublic(true);
    setCopied(false);
    revokePublicLink((): void => {
      if (!isCurrent())
        throw new Error('The sharing context changed. Try again.');
    })
      .then(() => {
        if (!isCurrent()) {
          reconcileObsoleteMutation();
          return;
        }
        mutationPending.current = false;
        // The host clears its public share, so the dialog stays open and
        // falls back to the unshared state, including right after a share
        // whose completion has already run.
        setConfirmingRemovePublic(false);
        setRemovingPublic(false);
        setState({ status: 'idle' });
        notifyRef.current({
          tone: 'success',
          message: PUBLIC_LINK_REMOVED_TOAST,
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          reconcileObsoleteMutation();
          return;
        }
        mutationPending.current = false;
        // The link is still there, so the dialog keeps its published state
        // and the trash icon to try again.
        setConfirmingRemovePublic(false);
        setRemovingPublic(false);
        setRemovePublicError(
          `${copy.removePublicLinkFailed} ${describeError(error)}`.trim(),
        );
      });
  }, [
    captureMutation,
    reconcileObsoleteMutation,
    copy.removePublicLinkFailed,
    describeError,
    revokePublicLink,
  ]);

  const handleSetUpOrganization = useCallback((): void => {
    if (canCreateTeam && upgradePersonalId) {
      setSetupPersonalId(upgradePersonalId);
      setSetupAccountKey(accountKey);
      setCreatingTeam(true);
      return;
    }
    if (!onSetUpOrganization || openingOrganizationSetup) return;
    setOrganizationSetupFailed(false);
    setOpeningOrganizationSetup(true);
    onSetUpOrganization()
      .then((opened) => setOrganizationSetupFailed(!opened))
      .catch(() => setOrganizationSetupFailed(true))
      .finally(() => setOpeningOrganizationSetup(false));
  }, [
    canCreateTeam,
    upgradePersonalId,
    accountKey,
    onSetUpOrganization,
    openingOrganizationSetup,
  ]);

  // Once a share lands, Done may only retry host completion. It never exposes
  // the submit path again, so a transient local refresh failure cannot repeat
  // the remote mutation.
  const finishCommitted = useCallback(async (): Promise<void> => {
    if (finishing) return;
    if (state.status === 'success') {
      onClose();
      return;
    }
    if (state.status === 'error' && state.completion !== undefined) {
      await complete({ ...state.completion, showSuccess: false });
      return;
    }
    if (state.status === 'partial') {
      await complete({
        completedScope: scope,
        outcome: state.outcome,
        wasUpdate: updateModeRef.current,
        showSuccess: false,
      });
    }
  }, [complete, finishing, onClose, scope, state]);

  const packageGate = pkg.active && !pkg.ready;
  const destinationLapsed = destinationAccess.status === 'lapsed';
  const publicationUncertain = uncertainBinding === bindingKey;
  const submitDisabled =
    isBusy ||
    scope === null ||
    shareDisabled ||
    packageGate ||
    destinationLapsed ||
    publicationUncertain ||
    !accountReady ||
    !preflightReady ||
    accountLoading ||
    (scope === 'public' && publicOwnerLocked) ||
    (scope === 'team' && (teams.loading || !selectedTeam)) ||
    (scope === 'organization' && (orgs.loading || !selectedOrg));

  const descriptions: Partial<Record<ShareAudience, string>> = {
    ...(landing !== undefined
      ? {
          team: shareAudienceHelper(resourceNoun, 'team', {
            landing,
            ...(selectedTeam ? { targetName: selectedTeam.name } : {}),
          }),
          organization: shareAudienceHelper(resourceNoun, 'organization', {
            landing,
            ...(selectedOrg ? { targetName: selectedOrg.name } : {}),
          }),
        }
      : {}),
    public:
      copyOverrides?.publicDescription ??
      shareAudienceHelper(resourceNoun, 'public', {
        // Mention dependency files only when the package carries some.
        includesDependencies:
          capabilityPackage?.mode !== 'reference' &&
          pkg.hasContent &&
          (pkg.analysis?.manifest?.resources.length ?? 0) > 0,
      }),
    ...audienceDescriptions,
    ...(marketplace
      ? {
          public:
            'Anyone can open the link, and it can appear in public discovery.',
        }
      : {}),
  };

  const organizationSetupLabel = canCreateTeam
    ? 'Create a team'
    : copy.organizationSetupAction;
  const organizationSetupError = (
    <ErrorBanner
      className=""
      error={copy.organizationSetupFailed}
      testId={`${p}-set-up-organization-error`}
    />
  );
  const organizationSetup = (
    <Stack
      gap="inline"
      className="mt-2"
      data-testid={`${p}-organization-setup`}
    >
      {(onSetUpOrganization || canCreateTeam) && (
        <Button
          className="self-start"
          type="button"
          variant="secondary"
          size="compact"
          data-testid={`${p}-set-up-organization`}
          onClick={handleSetUpOrganization}
          disabled={openingOrganizationSetup}
        >
          {organizationSetupLabel}
        </Button>
      )}
      {organizationSetupFailed && organizationSetupError}
    </Stack>
  );
  // The setup step offered under a disabled Team or Organization pill.
  const organizationSetupAction =
    onSetUpOrganization || canCreateTeam
      ? {
          text: organizationSetupLabel,
          onClick: handleSetUpOrganization,
          testId: `${p}-set-up-organization`,
        }
      : undefined;
  const withSetupAction = (
    label: string,
  ): { label: string; action?: TooltipLink } =>
    organizationSetupAction !== undefined
      ? { label, action: organizationSetupAction }
      : { label };
  const scopedReason = personalScopesLocked
    ? canCreateTeam
      ? withSetupAction(
          `Create a team to share this ${resourceNoun} with teammates.`,
        )
      : { label: copy.personalContextHint }
    : needsOrganization
      ? withSetupAction(copy.organizationHint)
      : undefined;
  const upgradeReason = { label: copy.upgradeHint };
  const teamReason =
    scopedReason ??
    (teamNeedsUpgrade
      ? upgradeReason
      : needsTeam
        ? { label: copy.teamHint }
        : undefined);
  const organizationReason =
    scopedReason ?? (organizationNeedsUpgrade ? upgradeReason : undefined);
  const unavailableReasons: Partial<
    Record<ShareAudience, { label: string; action?: TooltipLink }>
  > =
    audienceLocked !== undefined && lockedAudience !== undefined
      ? Object.fromEntries(
          offeredScopes
            .filter((audience) => audience !== lockedAudience)
            .map((audience) => [audience, { label: audienceLocked.hint }]),
        )
      : {
          ...(teamReason !== undefined ? { team: teamReason } : {}),
          ...(organizationReason !== undefined
            ? { organization: organizationReason }
            : {}),
        };

  const gate = ((): ReactNode => {
    // Only the first read replaces the form. Re-reading an account the dialog
    // already has (an ambient re-probe, or its own access check) keeps the
    // form mounted so nothing the author opened collapses; Share waits for it.
    if (accountLoading && account === null) {
      return <p className="text-s fg-secondary">{copy.accountLoading}</p>;
    }
    if (isGuest) {
      return (
        <Stack gap="item" data-testid={`${p}-guest-cta`}>
          <p className="text-s fg-secondary">{copy.guestState}</p>
          {onConnect && (
            <Button
              className="self-start"
              type="button"
              variant="secondary"
              size="compact"
              data-testid={`${p}-guest-cta-button`}
              onClick={onConnect}
            >
              {copy.guestAction}
            </Button>
          )}
        </Stack>
      );
    }
    if (!accountReady) {
      return (
        <Stack gap="item" data-testid={`${p}-account-unavailable`}>
          <p className="text-s fg-secondary">{accountUnavailableLabel}</p>
          {onOpenAccountSettings && (
            <Button
              className="self-start"
              type="button"
              variant="secondary"
              size="compact"
              data-testid={`${p}-open-account-settings`}
              onClick={onOpenAccountSettings}
            >
              {copy.emptyAction}
            </Button>
          )}
        </Stack>
      );
    }
    if (preflightState.status === 'checking') {
      return (
        <p className="text-s fg-secondary" data-testid={`${p}-preflight`}>
          {copy.preflightLoading}
        </p>
      );
    }
    if (preflightState.status === 'blocked') {
      return (
        <Stack gap="item">
          {preflightState.body}
          {preflightState.action && (
            <Button
              className="self-start"
              type="button"
              variant="secondary"
              size="compact"
              data-testid={`${p}-unavailable-action`}
              onClick={() => {
                if (preflightState.action?.retry === true) {
                  setPreflightAttempt((attempt) => attempt + 1);
                  return;
                }
                preflightState.action?.onClick?.();
              }}
            >
              {preflightState.action.label}
            </Button>
          )}
        </Stack>
      );
    }
    if (needsSetupGate) {
      return (
        <Stack gap="tight" data-testid={`${p}-organization-required`}>
          <p className="text-s fg-secondary">{copy.organizationRequired}</p>
          {organizationSetup}
        </Stack>
      );
    }
    return null;
  })();

  const committed =
    state.status === 'partial' ||
    state.status === 'success' ||
    (state.status === 'error' && state.completion !== undefined);
  // Reopening Share on a resource that is already shared opens on the notice
  // a share ends on: its link, Copy link and Done. Update stays offered, and
  // a public link is removed from the trash icon on the link line; choosing
  // another audience leaves the notice. A locked owner opens on its team or
  // organization rather than Public, but its link is still the public one.
  const reopenedAudience =
    publicOwnerLocked && existingShare?.audience === 'public'
      ? existingShare.targetAudience
      : existingShare?.audience;
  // A public share whose host has no link to show still opens here, so its
  // link can be removed.
  const reopenedShare =
    state.status === 'idle' &&
    gate === null &&
    accountReady &&
    preflightReady &&
    existingShare !== undefined &&
    scope === reopenedAudience &&
    (existingShare.link !== undefined ||
      canRemovePublicLink ||
      reopenedNotice !== undefined)
      ? existingShare
      : undefined;
  const audienceIsLocked = lockedAudience !== undefined;
  const pickerDisabled = isBusy || committed || audienceIsLocked;

  const handleStopSharing = async (): Promise<void> => {
    if (stopSharing === undefined || stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await stopSharing.onStop();
    } catch (error) {
      setStopError(describeError(error));
      setStopping(false);
      return;
    }
    setStopping(false);
    setConfirmingStop(false);
    notifyRef.current({ tone: 'success', message: stopSharing.toast });
    onClose();
  };

  const handleRetrySync = async (): Promise<void> => {
    if (retry === undefined || retryingSync) return;
    setRetryingSync(true);
    setRetrySyncError(null);
    try {
      await retry.onRetry();
    } catch (error) {
      setRetrySyncError(describeError(error));
    } finally {
      setRetryingSync(false);
    }
  };
  const scopeSection = (
    <>
      <ShareAudienceSelector
        offered={offeredScopes}
        availability={availability}
        value={scope}
        onChange={(next): void => {
          setRemovePublicError(null);
          setAudience(next);
        }}
        legend={copy.scopeLegend}
        labelForAudience={
          marketplace
            ? (audience): string =>
                audience === 'team'
                  ? 'Team'
                  : audience === 'organization'
                    ? 'Organization'
                    : audience === 'public'
                      ? 'Public'
                      : 'Private'
            : undefined
        }
        descriptions={descriptions}
        {...(showPublicLockedHint ||
        organizationSetupFailed ||
        audienceLocked !== undefined
          ? {
              hint: (
                <>
                  {audienceLocked !== undefined && audienceIsLocked && (
                    <p
                      id={audienceLockedHintId}
                      className="text-xs fg-secondary"
                      data-testid={`${p}-audience-locked-hint`}
                    >
                      {audienceLocked.hint}
                    </p>
                  )}
                  {showPublicLockedHint && (
                    <p
                      id={publicLockedHintId}
                      className="mt-2 text-xs fg-secondary"
                      data-testid={`${p}-public-locked-hint`}
                    >
                      {copy.publicLockedHint}
                    </p>
                  )}
                  {organizationSetupFailed && organizationSetupError}
                </>
              ),
            }
          : {})}
        // Every offered scope stays visible; one the account can't use yet
        // is disabled, with its reason in the pill's tooltip.
        keepDisabledVisible
        // A locked audience's hint is margin-free: the selector spaces it,
        // and the selected pill carries the lock.
        {...(audienceIsLocked ? { contentGap: 'inline', locked: true } : {})}
        unavailableReasons={unavailableReasons}
        {...(showPublicLockedHint || lockedAudience !== undefined
          ? {
              optionDescribedBy: {
                ...(showPublicLockedHint ? { public: publicLockedHintId } : {}),
                // The locked pill names why it can't change.
                ...(lockedAudience !== undefined
                  ? { [lockedAudience]: audienceLockedHintId }
                  : {}),
              },
            }
          : {})}
        disabled={isBusy || committed}
        dataTestId={`${p}-scope`}
      />

      {marketplace && existingShare?.audience === 'public' && (
        <div
          className="flex items-center gap-3 text-xs fg-secondary"
          data-testid={`${p}-public-link-version`}
        >
          <span>
            {marketplacePublicLinkPinnedAt(existingShare.publicLinkPinnedAt)
              ? `Public link shows the version from ${formatMonthDay(existingShare.publicLinkPinnedAt ?? '')}`
              : 'Public link shows a pinned version.'}
          </span>
          {scope === 'public' &&
            existingShare.publicLinkStale &&
            !publicOwnerLocked && (
              <Button
                size="compact"
                variant="ghost"
                data-testid={`${p}-public-link-update`}
                disabled={submitDisabled || committed}
                onClick={() => void handleShare()}
              >
                Update
              </Button>
            )}
        </div>
      )}
      {marketplace &&
        scope === 'public' &&
        !publicOwnerLocked &&
        !existingPersonalOrganization &&
        (existingShare?.audience === 'team' ||
          existingShare?.audience === 'organization') && (
          <p
            className="text-xs fg-secondary"
            data-testid={`${p}-public-update-notice`}
          >
            People with the link see this version. Press Update to share later
            edits.
          </p>
        )}

      {scope === 'team' && (
        <OrgTeamPicker
          kind="team"
          dataTestId={`${p}-team-picker`}
          copy={{
            placeholder: copy.teamSearchPlaceholder,
            loading: copy.teamLoading,
            empty: copy.teamEmpty,
          }}
          searchValue={teams.search}
          onSearchChange={teams.setSearch}
          loading={teams.loading}
          error={teams.error}
          disabled={pickerDisabled}
          items={mergeTarget(teams.items ?? [], selectedTeam, teams.search)}
          selectedId={selectedTeam?.id ?? null}
          onSelect={(item): void => {
            if (selectedTeam?.id !== item.id) notifyAudienceChange();
            setSelectedTeam(item);
            setValidationError(null);
          }}
        />
      )}

      {scope === 'organization' && (
        <OrgTeamPicker
          kind="organization"
          dataTestId={`${p}-organization-picker`}
          copy={{
            placeholder: copy.organizationSearchPlaceholder,
            loading: copy.organizationLoading,
            empty: copy.organizationEmpty,
          }}
          searchValue={orgs.search}
          onSearchChange={orgs.setSearch}
          loading={orgs.loading}
          error={orgs.error}
          disabled={pickerDisabled}
          items={mergeTarget(orgs.items ?? [], selectedOrg, orgs.search)}
          selectedId={selectedOrg?.id ?? null}
          onSelect={(item): void => {
            if (selectedOrg?.id !== item.id) notifyAudienceChange();
            setSelectedOrg(item);
            setValidationError(null);
          }}
        />
      )}
      {destinationAccess.status === 'lapsed' && (
        <DestinationPlanNotice
          access={destinationAccess}
          testIdPrefix={p}
          {...(onChooseOrganizationPlan !== undefined
            ? { onChoosePlan: onChooseOrganizationPlan }
            : {})}
          onCheckAgain={(): void => {
            void refreshDestinationAccess('retry');
          }}
        />
      )}
      {accessCheckFailedBinding === bindingKey &&
        destinationAccess.status !== 'lapsed' && (
          <Notice
            data-testid={`${p}-destination-access-error`}
            actions={
              <NoticeButton
                data-testid={`${p}-destination-access-retry`}
                onClick={(): void => {
                  setAccessCheckFailedBinding(null);
                  void refreshDestinationAccess('retry');
                }}
              >
                Try again
              </NoticeButton>
            }
          >
            {ACCESS_CHECK_FAILED_MESSAGE}
          </Notice>
        )}
      {validationError && state.status !== 'error' && (
        <ErrorBanner
          className=""
          error={validationError}
          testId={`${p}-validation-error`}
        />
      )}
    </>
  );

  const packageReview = pkg.relevant ? (
    <CapabilityPackageDependencies
      analysis={pkg.analysis}
      loading={pkg.analyzing}
      errored={pkg.failed}
      errorReason={pkg.failureReason}
      selectedOptionalResourceIds={pkg.selectedOptionalResourceIds}
      onToggleOptionalResource={(resourceId): void =>
        pkg.toggleOptionalResource(resourceId)
      }
      onRetry={(): void => pkg.retry()}
      dismissedInvocations={pkg.dismissedInvocations}
      onDismissInvocation={(dismissal): void =>
        pkg.dismissInvocation(dismissal)
      }
      onRestoreInvocation={(dismissal): void =>
        pkg.restoreInvocation(dismissal)
      }
      dismissedReferences={pkg.dismissedReferences}
      onDismissReference={(dismissal): void => pkg.dismissReference(dismissal)}
      onRestoreReference={(dismissal): void => pkg.restoreReference(dismissal)}
      selectedPipelineKeys={pkg.selectedPipelineKeys}
      onTogglePipeline={(key): void => pkg.togglePipeline(key)}
      {...(capabilityPackage?.pipelineAdd
        ? { pipelineAdd: capabilityPackage.pipelineAdd }
        : {})}
      {...(capabilityPackage?.bindingLabelFor
        ? { bindingLabelFor: capabilityPackage.bindingLabelFor }
        : {})}
      subjectLabel={resourceNoun}
      mode={capabilityPackage?.mode ?? 'package'}
      testIdPrefix={p}
      disabled={isBusy || committed}
      {...(repairOffered ? { onFixWithAI: startRepair } : {})}
      fixWithAIDisabled={!canRepair}
      fixWithAIPending={repairPending}
      fixWithAIFailed={repairFailed}
    />
  ) : null;
  // A review that blocks Share, or holds the author's dismissals and their
  // undo, stays inline even when the host places it.
  const packageNeedsAttention =
    pkg.failed ||
    (pkg.analysis?.blockers.length ?? 0) > 0 ||
    pkg.dismissedInvocations.length > 0 ||
    pkg.dismissedReferences.length > 0;
  const hostPlacesPackageReview =
    capabilityPackage?.placement === 'host' && !packageNeedsAttention;
  // A host-placed review that finished with nothing to copy, nothing for
  // recipients to set up, nothing left out and no pipeline to add has nothing
  // to say, so the host gets no section. A blocked analysis can report a null manifest.
  const packageManifest = pkg.analysis?.manifest;
  const packageReviewEmpty =
    !pkg.analyzing &&
    packageManifest?.resources.length === 0 &&
    (pkg.analysis?.packagedPipelines?.length ?? 0) === 0 &&
    (pkg.analysis?.withheldFiles?.length ?? 0) === 0 &&
    (capabilityPackage?.pipelineAdd?.options.length ?? 0) === 0 &&
    packageManifest.environmentRequirements.length === 0 &&
    (pkg.analysis?.unpackageableSelectionLabels?.length ?? 0) === 0;

  const contentSection = (
    <>
      {!hostPlacesPackageReview && packageReview}
      {!capabilityPackage && packageUnavailableNote && (
        <p
          className="text-xs fg-secondary"
          data-testid={`${p}-dependencies-unavailable`}
        >
          {copy.packageUnavailable}
        </p>
      )}

      {typeof extraOptions === 'function'
        ? extraOptions({
            scope,
            ...(targetName !== undefined ? { targetName } : {}),
            busy: isBusy,
            packageReview:
              hostPlacesPackageReview && !packageReviewEmpty
                ? packageReview
                : null,
          })
        : extraOptions}
    </>
  );

  // A locked owner can't refresh its public link through Public, so the
  // stale notice would ask for an update that cannot succeed.
  const showPublicLinkStale =
    existingShare?.publicLinkStale === true &&
    !publicOwnerLocked &&
    !marketplace;
  const notesSection =
    notes !== undefined ||
    showPublicLinkStale ||
    contextChangedLabel !== null ? (
      <>
        {contextChangedLabel !== null && (
          <ContextChangedNotice
            label={contextChangedLabel}
            data-testid={`${p}-context-changed`}
          />
        )}
        {notes}
        {showPublicLinkStale && (
          <Notice intent="attention" data-testid={`${p}-public-link-stale`}>
            {copy.publicLinkStale}
          </Notice>
        )}
      </>
    ) : undefined;

  const sharingInProgress = state.status === 'sharing' || finishing;
  const completion =
    state.status === 'success' || state.status === 'error'
      ? state.completion
      : undefined;
  const completedLink: ShareDialogLink | undefined = completion?.outcome
    .shareUrl
    ? {
        url: completion.outcome.shareUrl,
        kind: marketplace
          ? 'item'
          : completion.completedScope === 'public'
            ? 'public'
            : 'scoped',
      }
    : undefined;
  // After a share, only the link it produced is offered: an earlier link of
  // the resource may belong to the audience the share just replaced.
  const displayedLink =
    state.status === 'success'
      ? completedLink
      : (completedLink ?? existingShare?.link);
  // The reopened view's own actions: the retry primary replaces Done, and
  // Update is never offered on a locked audience.
  const offeredRetry = reopenedShare !== undefined ? retry : undefined;
  const offeredStop = reopenedShare !== undefined ? stopSharing : undefined;
  const linkPending =
    reopenedShare !== undefined &&
    reopenedNotice !== undefined &&
    displayedLink === undefined;
  const actionError =
    removePublicError !== null &&
    canRemovePublicLink &&
    (state.status === 'success' || reopenedShare !== undefined)
      ? removePublicError
      : offeredRetry !== undefined && retrySyncError !== null
        ? retrySyncError
        : null;

  useEffect(() => {
    if (!creatingTeam && promotedTarget && accountReady) {
      previousScope.current = 'organization';
      setAudience('organization');
      setSelectedOrg(promotedTarget);
      setSelectedTeam(null);
    }
  }, [creatingTeam, promotedTarget, accountReady, setAudience]);

  if (
    creatingTeam &&
    setupAccountKey === accountKey &&
    canCreateTeam &&
    personalOrganizationUpgradePort &&
    setupPersonalId &&
    accountKey
  ) {
    return (
      <Suspense fallback={null}>
        <InviteToOrganizationDialog
          key={`${accountKey}:${setupPersonalId}`}
          target={{ kind: 'personal', personalOrganizationId: setupPersonalId }}
          accountKey={accountKey}
          contextOrganizationId={
            context?.kind === 'organization'
              ? context.organizationId
              : undefined
          }
          port={personalOrganizationUpgradePort}
          ownerDocument={ownerDocument}
          onPromoted={async (outcome) => {
            const initiatingAccount = accountKey;
            const refreshed = await loadAccount();
            if (
              accountIdentityRef.current !== initiatingAccount ||
              refreshed?.id !== initiatingAccount
            )
              return;
            setAccount(refreshed);
            setPromotedTarget({
              id: outcome.promotion.organizationId,
              name: outcome.promotion.name,
            });
          }}
          onClose={() => setCreatingTeam(false)}
        />
      </Suspense>
    );
  }

  // Remove public link is the trash icon at the end of the published
  // notice's link line, on a reopened public share or one that just landed.
  const removePublicLinkAction =
    canRemovePublicLink &&
    (state.status === 'success' || reopenedShare !== undefined) ? (
      <Tooltip label={copy.removePublicLink}>
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={copy.removePublicLink}
          data-testid={`${p}-remove-public-link`}
          onClick={(): void => setConfirmingRemovePublic(true)}
          disabled={isBusy}
        >
          <TrashIcon aria-hidden />
        </Button>
      </Tooltip>
    ) : null;

  return (
    <ShareDialogFrame
      title={`Share ${resourceNoun}`}
      {...(subtitle !== undefined ? { subtitle } : {})}
      maxWidth={maxWidth ?? (capabilityPackage ? 'lg' : 'md')}
      testIdPrefix={p}
      ownerDocument={ownerDocument}
      onDismiss={
        committed
          ? (): void => {
              void finishCommitted();
            }
          : onClose
      }
      lifecycle={{
        status: sharingInProgress
          ? 'sharing'
          : reopenedShare !== undefined
            ? 'success'
            : state.status === 'partial' ||
                state.status === 'error' ||
                state.status === 'success'
              ? state.status
              : 'idle',
        committed:
          committed ||
          (reopenedShare !== undefined && offeredRetry === undefined),
      }}
      busy={removingPublic || stopping}
      {...(gate !== null ? { gate } : {})}
      {...(notesSection !== undefined ? { notes: notesSection } : {})}
      scope={scopeSection}
      content={contentSection}
      {...(state.status === 'error' ? { errorMessage: state.message } : {})}
      {...(actionError !== null ? { actionErrorMessage: actionError } : {})}
      {...(state.status === 'error' &&
      state.recovery === 'sign-in' &&
      onOpenAccountSettings !== undefined
        ? {
            errorAction: (
              <NoticeButton
                data-testid={`${p}-sign-in`}
                onClick={onOpenAccountSettings}
              >
                Sign in
              </NoticeButton>
            ),
          }
        : {})}
      {...(state.status === 'partial'
        ? {
            partialMessage: `${state.outcome.message ?? sharePartialMessage(resourceNoun, targetName)}${state.retryError ? ` ${state.retryError}` : ''}`,
          }
        : {})}
      {...(state.status === 'success'
        ? {
            success: shareSuccessNotice({
              noun: resourceNoun,
              scope: state.completion.completedScope,
              ...(targetName !== undefined ? { targetName } : {}),
              // Captured before the request started. `onCompleted` commonly
              // writes the new remote id into the host, which re-renders this
              // dialog as an existing share.
              isUpdate: state.completion.wasUpdate,
              ...(state.completion.outcome.message !== undefined
                ? { message: state.completion.outcome.message }
                : {}),
              ...(state.completion.outcome.shareUrl !== undefined
                ? { shareUrl: state.completion.outcome.shareUrl }
                : {}),
            }),
          }
        : reopenedShare !== undefined && reopenedNotice !== undefined
          ? {
              success: {
                tone:
                  reopenedNotice.tone === 'positive' ? 'success' : 'warning',
                message: reopenedNotice.title,
                ...(reopenedNotice.details !== undefined
                  ? { details: reopenedNotice.details }
                  : {}),
                ...(reopenedShare.link !== undefined
                  ? { link: reopenedShare.link.url }
                  : {}),
              },
            }
          : reopenedShare !== undefined
            ? {
                success: shareSuccessNotice({
                  noun: resourceNoun,
                  scope: reopenedShare.audience === 'public' ? 'public' : scope,
                  ...(targetName !== undefined ? { targetName } : {}),
                  isUpdate: false,
                  reopened: true,
                  ...(reopenedShare.link !== undefined
                    ? { shareUrl: reopenedShare.link.url }
                    : {}),
                }),
              }
            : {})}
      {...(removePublicLinkAction !== null
        ? { successLinkAction: removePublicLinkAction }
        : {})}
      {...(retryPublicLink ? { onRetryPublic: handleRetryPublic } : {})}
      retryingPublic={retryingPublic}
      showSubmit={
        offeredRetry !== undefined ||
        (!committed &&
          accountReady &&
          preflightReady &&
          !needsSetupGate &&
          !(audienceIsLocked && reopenedShare !== undefined))
      }
      submitLabel={
        offeredRetry !== undefined
          ? offeredRetry.label
          : isUpdate
            ? 'Update'
            : 'Share'
      }
      sharingLabel={
        offeredRetry !== undefined
          ? offeredRetry.label
          : isUpdate
            ? copy.updating
            : copy.sharing
      }
      submitDisabled={offeredRetry !== undefined ? isBusy : submitDisabled}
      submitBusy={retryingSync}
      submitTestId={
        offeredRetry !== undefined ? `${p}-retry-sync` : `${p}-submit`
      }
      onSubmit={(): void => {
        void (offeredRetry !== undefined ? handleRetrySync() : handleShare());
      }}
      {...(offeredStop !== undefined
        ? {
            destructiveAction: {
              label: offeredStop.label,
              onClick: (): void => {
                setStopError(null);
                setConfirmingStop(true);
              },
              disabled: isBusy,
              busy: stopping,
              testId: `${p}-stop-sharing`,
            },
          }
        : {})}
      stage={pkg.progress}
      {...(displayedLink ? { link: displayedLink } : {})}
      linkPending={linkPending}
      copyText={copyText}
      onLinkCopied={(): void => setCopied(true)}
    >
      {confirmingRemovePublic && (
        <RemovePublicLinkConfirmDialog
          busy={removingPublic}
          testIdPrefix={p}
          ownerDocument={ownerDocument}
          // A public share with a team or organization owner keeps that
          // audience; only a USER-owned one becomes private-only and hidden.
          {...(existingShare?.target
            ? {
                remainingAudience: {
                  name: existingShare.target.name,
                  ...(existingPersonalOrganization ? { personal: true } : {}),
                },
              }
            : {})}
          onCancel={(): void => setConfirmingRemovePublic(false)}
          onConfirm={handleRemovePublicLink}
        />
      )}
      {confirmingStop && stopSharing !== undefined && (
        <ConfirmDialog
          title={stopSharing.confirm.title}
          message={stopSharing.confirm.body}
          confirmLabel={stopSharing.label}
          busyLabel={stopSharing.confirm.busyLabel}
          busy={stopping}
          errorMessage={stopError}
          destructive
          onConfirm={(): void => {
            void handleStopSharing();
          }}
          onCancel={(): void => {
            setConfirmingStop(false);
            setStopError(null);
          }}
          dataTestId={`${p}-stop-sharing-confirm`}
          confirmTestId={`${p}-stop-sharing-confirm-action`}
          cancelTestId={`${p}-stop-sharing-cancel`}
          ownerDocument={ownerDocument}
        />
      )}
    </ShareDialogFrame>
  );
}

/**
 * The selected organization has no active plan. An account that can choose
 * one gets the action; anyone else is pointed at an owner. The other
 * audiences stay usable.
 */
function DestinationPlanNotice({
  access,
  testIdPrefix,
  onChoosePlan,
  onCheckAgain,
}: {
  access: Extract<ShareDestinationAccess, { status: 'lapsed' }>;
  testIdPrefix: string;
  onChoosePlan?: (organizationId: string) => void;
  /** Re-reads access, so a plan chosen elsewhere unlocks Share. */
  onCheckAgain: () => void;
}): JSX.Element {
  const name = access.organizationName;
  const helper =
    access.canChoosePlan === true
      ? `Choose a plan to share with ${name ?? 'this organization'}.`
      : access.canChoosePlan === false
        ? `Ask an owner of ${name ?? 'this organization'} to choose a plan.`
        : `An owner of ${name ?? 'this organization'} needs to choose a plan before you can share with it.`;
  return (
    <Notice
      intent="attention"
      data-testid={`${testIdPrefix}-destination-access`}
      title={orgsWithoutActivePlanClause([name ?? 'This organization'])}
      actions={
        <>
          {access.canChoosePlan === true && onChoosePlan !== undefined && (
            <NoticeButton
              variant="primary"
              data-testid={`${testIdPrefix}-choose-plan`}
              onClick={(): void => onChoosePlan(access.organizationId)}
            >
              Choose a plan
            </NoticeButton>
          )}
          <NoticeButton
            data-testid={`${testIdPrefix}-destination-access-check`}
            onClick={onCheckAgain}
          >
            Try again
          </NoticeButton>
        </>
      }
    >
      {helper}
    </Notice>
  );
}

/**
 * Keeps a preselected target (an existing share's team) visible even before
 * a search returns it, so the picker never shows a selection it cannot draw.
 */
function mergeTarget(
  items: readonly ShareTargetSummary[],
  selected: ShareTargetSummary | null,
  search: string,
): readonly ShareTargetSummary[] {
  if (!selected || search.trim() !== '') return items;
  if (items.some((item) => item.id === selected.id)) return items;
  return [selected, ...items];
}
