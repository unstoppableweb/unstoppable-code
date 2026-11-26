'use client';

import type { JSX } from 'react';
import type { DataSharingOptInFeature } from '@canopy/protocol';
import {
  DATA_SHARING_SCOPE_ORDER,
  dataSharingOrganizationAccessNote,
  type DataSharingScopeKey,
} from '../lib/data-sharing-features';
import { Notice, NoticeButton } from '../primitives/Notice';
import { Button } from '../primitives/Button';

// Every string below is the approved CAN-3383 copy (docs/ux-writing.md,
// "Data-sharing opt-in hints"). Keep sentences short, keep dynamic names as
// whole placeholders, and avoid the technical setting vocabulary the Privacy
// tab uses (that tab keeps the precise names on purpose).

/** Plain-language names for each kind of work an opt-in shares. */
const SCOPE_PLAIN_LABELS: Record<DataSharingScopeKey, string> = {
  metadata: 'work stats',
  plans: 'plans',
  summaries: 'work recaps',
  transcripts: 'chats',
};

/** The invitation that heads each feature's hint and confirmation. */
const FEATURE_HEADLINES: Record<DataSharingOptInFeature, string> = {
  'feed-activity': 'Share your work in the timeline.',
  statistics: 'Add your work to statistics.',
  'member-profiles': 'Show your work on your profile.',
  leaderboards: 'Join the leaderboards.',
  'implemented-plans': 'Share your implemented plans.',
  'organization-memory': 'Add your chats to organization memory.',
  'shared-projects': 'Share your work here to invite others.',
};

function orderScopes(
  scopes: readonly DataSharingScopeKey[],
): DataSharingScopeKey[] {
  const wanted = new Set(scopes);
  return DATA_SHARING_SCOPE_ORDER.filter((scope) => wanted.has(scope));
}

/** `a`, `a and b`, `a, b, and c`: one placeholder in the sentence it joins. */
export function formatDataSharingScopeList(
  scopes: readonly DataSharingScopeKey[],
): string {
  const labels = orderScopes(scopes).map((scope) => SCOPE_PLAIN_LABELS[scope]);
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}

/** The headline for a feature's hint, confirmation sheet, and gallery entry. */
export function dataSharingOptInHeadline(
  feature: DataSharingOptInFeature,
): string {
  return FEATURE_HEADLINES[feature];
}

/** Primary action label, shared by the inline hint and the sheet. */
export function dataSharingOptInActionLabel(organizationName: string): string {
  return `Share with ${organizationName}`;
}

/** Copy the desktop confirmation sheet needs beyond the scope summary. */
export const DATA_SHARING_OPT_IN_SHEET_COPY = {
  title: 'Review sharing',
  loading: 'Checking your sharing settings…',
  cancel: 'Cancel',
  done: 'Done',
  saving: 'Sharing…',
  alreadyShared: (organizationName: string): string =>
    `You already share this work with ${organizationName}.`,
} as const;

/** State copy, exported for the desktop notice gallery and the sheet. */
export const DATA_SHARING_OPT_IN_STATE_COPY = {
  savedTitle: 'Sharing settings saved.',
  savedDetail:
    "Future sharing follows these settings and each organization's rules.",
  managed: (organizationName: string): string =>
    `${organizationName} manages this sharing.`,
  awaiting: (productName: string): string =>
    `Continue in the ${productName} desktop app.`,
  webReview: (productName: string): string =>
    `You'll review this in the ${productName} desktop app first.`,
  mobile: (productName: string): string =>
    `Turn this on in the ${productName} desktop app.`,
  fallbackLink: 'Open Privacy settings',
} as const;
/**
 * Copy for the personal audience: a personal shared project registers through
 * the viewer's own ("Just me") target, so nothing reaches an organization and
 * the organization, history, and policy lines do not apply.
 */
export const DATA_SHARING_OPT_IN_PERSONAL_COPY = {
  actionLabel: 'Turn on project data sharing',
  saves: (
    scopes: readonly DataSharingScopeKey[],
    productName: string,
  ): string =>
    `Saves your ${formatDataSharingScopeList(scopes)} to ${productName}.`,
  audience: 'Only you can see them.',
} as const;
const SAVED_TITLE = DATA_SHARING_OPT_IN_STATE_COPY.savedTitle;
const SAVED_DETAIL = DATA_SHARING_OPT_IN_STATE_COPY.savedDetail;
const managedText = DATA_SHARING_OPT_IN_STATE_COPY.managed;
const awaitingText = DATA_SHARING_OPT_IN_STATE_COPY.awaiting;
const mobileText = DATA_SHARING_OPT_IN_STATE_COPY.mobile;
const webReviewText = DATA_SHARING_OPT_IN_STATE_COPY.webReview;
const FALLBACK_LINK = DATA_SHARING_OPT_IN_STATE_COPY.fallbackLink;
const RETRY_LABEL = 'Try again';

/** Recoverable failures that stay attached to the offer for a retry. */
export type DataSharingOptInError =
  | 'save-failed'
  | 'application-failed'
  | 'unavailable';

const ERROR_TEXT: Record<DataSharingOptInError, string> = {
  'save-failed': "Couldn't save your sharing settings. Try again.",
  'application-failed':
    "Sharing settings saved, but couldn't apply them yet. Try again.",
  unavailable:
    "Couldn't confirm your organization's settings. Try again later.",
};

/** Recovery text for a failed save, shared by the hint and the sheet. */
export function dataSharingOptInErrorText(
  error: DataSharingOptInError,
): string {
  return ERROR_TEXT[error];
}

export interface DataSharingOptInScopeSummaryProps {
  organizationName: string;
  productName: string;
  /** Kinds of work this action turns on, in any order. */
  allowedScopes: readonly DataSharingScopeKey[];
  /** Requested kinds the organization's policy keeps from being shared. */
  skippedScopes?: readonly DataSharingScopeKey[];
  /**
   * Unchanged kinds that start reaching the organization as a consequence
   * (a recap setting already at organization visibility, waiting on stats).
   */
  additionalScopes?: readonly DataSharingScopeKey[];
  dataTestId?: string;
  className?: string;
}

/**
 * The consent disclosure: what is shared and with whom, that the settings
 * cover every organization, that Personal and past private work stay private,
 * and what policy keeps back. Shown before every inline save and in the
 * desktop confirmation sheet.
 */
export function DataSharingOptInScopeSummary({
  organizationName,
  productName,
  allowedScopes,
  skippedScopes = [],
  additionalScopes = [],
  dataTestId,
  className = '',
}: DataSharingOptInScopeSummaryProps): JSX.Element {
  const lines: Array<{ key: string; text: string }> = [];
  if (allowedScopes.length > 0) {
    lines.push({
      key: 'shares',
      text: `Shares your ${formatDataSharingScopeList(allowedScopes)} with ${organizationName} in ${productName}.`,
    });
  }
  // What the organization's owners can do with it: the same disclosure the
  // Privacy rows carry (`dataSharingOrganizationAccessNote`).
  const ownerVisible = orderScopes([
    ...allowedScopes,
    ...additionalScopes,
  ]).filter((scope) => dataSharingOrganizationAccessNote(scope) !== null);
  if (ownerVisible.length > 0) {
    lines.push({
      key: 'owners',
      text: `${organizationName}'s owners can view and download your shared ${formatDataSharingScopeList(ownerVisible)}.`,
    });
  }
  if (additionalScopes.length > 0) {
    lines.push({
      key: 'additional',
      text: `Your existing settings also start sharing ${formatDataSharingScopeList(additionalScopes)}.`,
    });
  }
  if (skippedScopes.length > 0) {
    lines.push({
      key: 'skipped',
      text: `${organizationName} doesn't allow sharing your ${formatDataSharingScopeList(skippedScopes)} here.`,
    });
  }
  lines.push(
    {
      key: 'global',
      text: 'This also covers your other organizations, now and later.',
    },
    { key: 'personal', text: 'Personal work stays private.' },
    { key: 'history', text: 'Past private work stays private.' },
  );
  return (
    <ul
      data-testid={dataTestId}
      className={`flex flex-col gap-0.5 break-words fg-tertiary ${className}`}
    >
      {lines.map((line) => (
        <li key={line.key} data-line={line.key}>
          {line.text}
        </li>
      ))}
    </ul>
  );
}

type SummaryInput = Omit<
  DataSharingOptInScopeSummaryProps,
  'organizationName' | 'productName' | 'dataTestId'
>;

/** How the offer is acted on; each platform supplies exactly one. */
export type DataSharingOptInOfferAction =
  | {
      kind: 'desktop';
      onEnable: () => void;
      busy: boolean;
      error?: DataSharingOptInError | null;
    }
  | {
      kind: 'web';
      /** Parameterized desktop confirmation link. */
      href: string;
      /** Bare Privacy link kept for desktops that predate the confirmation. */
      fallbackHref: string;
      onActivate: () => void;
    }
  | { kind: 'mobile' };

interface DataSharingOptInBaseProps {
  feature: DataSharingOptInFeature;
  /** Brand helper output, never a literal product name. */
  productName: string;
  /** Defaults to `data-sharing-opt-in-<feature>`. */
  dataTestId?: string;
  className?: string;
}

/** The default audience: the organization that owns the work. */
type DataSharingOptInOrganizationProps = DataSharingOptInBaseProps & {
  organizationName: string;
} & (
    | {
        state: 'offer';
        summary: SummaryInput;
        action: DataSharingOptInOfferAction;
        onDismiss?: () => void;
      }
    | { state: 'awaiting-desktop'; fallbackHref: string }
    | { state: 'enabled' }
    | { state: 'managed' }
  );

/**
 * The personal audience: work with no organization, shared only with the
 * viewer. Only the offer and saved states apply, and only a direct save.
 */
type DataSharingOptInPersonalProps = DataSharingOptInBaseProps & {
  audience: 'personal';
} & (
    | {
        state: 'offer';
        summary: { allowedScopes: readonly DataSharingScopeKey[] };
        action: Extract<DataSharingOptInOfferAction, { kind: 'desktop' }>;
        onDismiss?: () => void;
      }
    | { state: 'enabled' }
  );

export type DataSharingOptInCtaProps =
  | DataSharingOptInOrganizationProps
  | DataSharingOptInPersonalProps;

function FallbackLink({
  href,
  testId,
}: {
  href: string;
  testId: string;
}): JSX.Element {
  return (
    <Button
      target={undefined}
      rel={undefined}
      href={href}
      data-testid={testId}
      variant="secondary"
      size="sm"
      className="max-w-full whitespace-nowrap"
    >
      {FALLBACK_LINK}
    </Button>
  );
}

/**
 * Quiet, display-only hint shown where the viewer's own sharing choices keep
 * an organization feature from receiving their work. It never fetches; each
 * app supplies one adapter that resolves state and wires the action.
 */
export function DataSharingOptInCta(
  props: DataSharingOptInCtaProps,
): JSX.Element {
  // `className` places the hint; the Notice owns everything inside it.
  if (props.className === undefined) return <OptInNotice {...props} />;
  return (
    <div className={props.className}>
      <OptInNotice {...props} />
    </div>
  );
}

function PersonalOptInNotice(
  props: DataSharingOptInPersonalProps,
): JSX.Element {
  const { feature, productName } = props;
  const testId = props.dataTestId ?? `data-sharing-opt-in-${feature}`;

  if (props.state === 'enabled') {
    return (
      <Notice
        icon={null}
        role="status"
        data-testid={testId}
        data-opt-in-state="enabled"
        data-opt-in-audience="personal"
      >
        {SAVED_TITLE}
      </Notice>
    );
  }

  const { action, summary, onDismiss } = props;
  const error = action.error ?? null;
  const lines = [
    {
      key: 'shares',
      text: DATA_SHARING_OPT_IN_PERSONAL_COPY.saves(
        summary.allowedScopes,
        productName,
      ),
    },
    { key: 'audience', text: DATA_SHARING_OPT_IN_PERSONAL_COPY.audience },
  ];
  return (
    <Notice
      icon={null}
      role={error ? 'status' : 'none'}
      data-testid={testId}
      data-opt-in-state="offer"
      data-opt-in-audience="personal"
      actions={
        <NoticeButton
          variant="primary"
          data-testid={`${testId}-enable`}
          className="max-w-full"
          disabled={action.busy}
          aria-busy={action.busy || undefined}
          onClick={action.onEnable}
        >
          <span className="truncate">
            {error
              ? RETRY_LABEL
              : DATA_SHARING_OPT_IN_PERSONAL_COPY.actionLabel}
          </span>
        </NoticeButton>
      }
      actionsPlacement="below"
      onDismiss={onDismiss}
      dismissTestId={`${testId}-dismiss`}
      detail={error ? ERROR_TEXT[error] : undefined}
      // The disclosure is a list, so the headline sits on its own line.
      title={dataSharingOptInHeadline(feature)}
      titleLayout="stacked"
    >
      <ul
        data-testid={`${testId}-summary`}
        className="flex flex-col gap-0.5 break-words"
      >
        {lines.map((line) => (
          <li key={line.key} data-line={line.key}>
            {line.text}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

function isPersonalAudience(
  props: DataSharingOptInCtaProps,
): props is DataSharingOptInPersonalProps {
  return 'audience' in props && props.audience === 'personal';
}

function OptInNotice(props: DataSharingOptInCtaProps): JSX.Element {
  if (isPersonalAudience(props)) return <PersonalOptInNotice {...props} />;
  const { feature, organizationName, productName } = props;
  const testId = props.dataTestId ?? `data-sharing-opt-in-${feature}`;

  if (props.state === 'managed') {
    return (
      <Notice
        icon={null}
        role="none"
        data-testid={testId}
        data-opt-in-state="managed"
      >
        <span className="break-words">{managedText(organizationName)}</span>
      </Notice>
    );
  }

  if (props.state === 'enabled') {
    return (
      <Notice
        icon={null}
        role="status"
        title={SAVED_TITLE}
        data-testid={testId}
        data-opt-in-state="enabled"
      >
        {SAVED_DETAIL}
      </Notice>
    );
  }

  if (props.state === 'awaiting-desktop') {
    return (
      <Notice
        icon={null}
        role="status"
        data-testid={testId}
        data-opt-in-state="awaiting-desktop"
        actions={
          <FallbackLink
            href={props.fallbackHref}
            testId={`${testId}-fallback`}
          />
        }
      >
        <span className="break-words">{awaitingText(productName)}</span>
      </Notice>
    );
  }

  const { action, summary, onDismiss } = props;

  // Web and mobile only hand off to the desktop review, which shows the full
  // disclosure before anything is saved. Here the hint stays one line: the
  // invitation, where it continues, and at most one action.
  if (action.kind === 'web' || action.kind === 'mobile') {
    const webAction = action.kind === 'web' ? action : null;
    return (
      <Notice
        icon={null}
        role="none"
        data-testid={testId}
        data-opt-in-state="offer"
        title={dataSharingOptInHeadline(feature)}
        actions={
          webAction === null ? undefined : (
            <Button
              target={undefined}
              rel={undefined}
              href={webAction.href}
              data-testid={`${testId}-enable`}
              variant="primary"
              size="sm"
              className="max-w-full whitespace-nowrap"
              onClick={(): void => webAction.onActivate()}
            >
              <span className="truncate">
                {dataSharingOptInActionLabel(organizationName)}
              </span>
            </Button>
          )
        }
        onDismiss={onDismiss}
        dismissTestId={`${testId}-dismiss`}
      >
        {webAction === null ? (
          <span className="break-words" data-testid={`${testId}-mobile`}>
            {mobileText(productName)}
          </span>
        ) : (
          <span className="break-words">{webReviewText(productName)}</span>
        )}
      </Notice>
    );
  }

  // The desktop saves from this hint, so the full disclosure stays inline.
  const error = action.error ?? null;
  return (
    <Notice
      icon={null}
      role={error ? 'status' : 'none'}
      data-testid={testId}
      data-opt-in-state="offer"
      actions={
        <NoticeButton
          variant="primary"
          data-testid={`${testId}-enable`}
          className="max-w-full"
          disabled={action.busy}
          aria-busy={action.busy || undefined}
          onClick={action.onEnable}
        >
          <span className="truncate">
            {error
              ? RETRY_LABEL
              : dataSharingOptInActionLabel(organizationName)}
          </span>
        </NoticeButton>
      }
      actionsPlacement="below"
      onDismiss={onDismiss}
      dismissTestId={`${testId}-dismiss`}
      detail={error ? ERROR_TEXT[error] : undefined}
      // The disclosure is a list, so the headline sits on its own line.
      title={dataSharingOptInHeadline(feature)}
      titleLayout="stacked"
    >
      <DataSharingOptInScopeSummary
        organizationName={organizationName}
        productName={productName}
        allowedScopes={summary.allowedScopes}
        skippedScopes={summary.skippedScopes}
        additionalScopes={summary.additionalScopes}
        dataTestId={`${testId}-summary`}
      />
    </Notice>
  );
}
