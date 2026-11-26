import type { JSX } from 'react';
import { Button } from '../primitives/Button';
import { DialogModal } from '../primitives/DialogModal';
import {
  DATA_SHARING_SCOPE_LABELS,
  DATA_SHARING_SCOPE_ORDER,
  type DataSharingScopeKey,
} from '../lib/data-sharing-features';
import { SettingsLockedLabel } from './SettingsLockedLabel';

const NOTICE_ID = 'org-sharing-notice';

/** Copy for the one-time organization data-sharing requirement notice. */
export const ORG_SHARING_NOTICE_COPY = {
  titleSuffix: 'manages some data sharing',
  personalWork: 'Your Personal work still follows your own choices.',
  dismiss: 'Got it',
  requiredBy: (organizationName: string): string =>
    `Required by ${organizationName}`,
} as const;

export interface OrgSharingRequirementNoticeProps {
  /** The organization's display name, from the member's membership. */
  readonly organizationName: string;
  /** Scopes the organization requires beyond the member's own choice. */
  readonly requiredScopes: readonly DataSharingScopeKey[];
  /** Got it, the close button, Escape and an outside click all land here. */
  readonly onDismiss: () => void;
}

/**
 * An organization name inside running text. A long name truncates at the
 * line's width instead of pushing the dialog wider; the native `title` shows
 * the full name, as for any plain text cut off by `truncate`.
 */
function OrganizationName({ name }: { readonly name: string }): JSX.Element {
  return (
    <span
      className="inline-block max-w-full truncate align-bottom"
      title={name}
    >
      {name}
    </span>
  );
}

/**
 * One-time notice that an organization the member belongs to requires some
 * activity sharing for its own projects beyond the member's own choice. Pure
 * display: the host decides when it shows and records that it was seen. Every
 * way out counts as seen, so it has a single action.
 */
export function OrgSharingRequirementNotice({
  organizationName,
  requiredScopes,
  onDismiss,
}: OrgSharingRequirementNoticeProps): JSX.Element {
  const scopes = DATA_SHARING_SCOPE_ORDER.filter((scope) =>
    requiredScopes.includes(scope),
  );
  return (
    <DialogModal
      title={
        <>
          <OrganizationName name={organizationName} />{' '}
          {ORG_SHARING_NOTICE_COPY.titleSuffix}
        </>
      }
      titleId={`${NOTICE_ID}-title`}
      maxWidth="md"
      onClose={onDismiss}
      dataTestId={NOTICE_ID}
      footer={
        <Button
          variant="primary"
          size="compact"
          onClick={onDismiss}
          data-testid={`${NOTICE_ID}-dismiss`}
        >
          {ORG_SHARING_NOTICE_COPY.dismiss}
        </Button>
      }
    >
      <div className="flex min-w-0 flex-col gap-2 text-s">
        <p className="fg-secondary">
          For work in <OrganizationName name={organizationName} /> projects,{' '}
          <OrganizationName name={organizationName} /> requires
        </p>
        <ul className="flex min-w-0 flex-col gap-2 fg-primary">
          {scopes.map((scope) => (
            <li
              key={scope}
              className="min-w-0"
              data-testid={`${NOTICE_ID}-row-${scope}`}
            >
              <SettingsLockedLabel
                label={DATA_SHARING_SCOPE_LABELS[scope]}
                reason={ORG_SHARING_NOTICE_COPY.requiredBy(organizationName)}
              />
            </li>
          ))}
        </ul>
      </div>
      <p className="text-s fg-secondary">
        {ORG_SHARING_NOTICE_COPY.personalWork}
      </p>
    </DialogModal>
  );
}
