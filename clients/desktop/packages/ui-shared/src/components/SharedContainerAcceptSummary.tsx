import type { JSX } from 'react';
import { Notice } from './Notice';

export const SHARED_CONTAINER_READ_ONLY_NOTICE =
  'Browse the chats, files and changes, or make your own copy to customize.';
export const SHARED_CONTAINER_ACCEPT_CONSENT =
  'Opening downloads a copy of the files to this computer. For code, it uses your own GitHub sign-in.';

export interface SharedContainerAcceptSummaryProps {
  /** Prefix for the consent (`-consent`) and error (`-error`) test ids. */
  testIdPrefix: string;
  /** Why the last accept failed; absent renders no notice. */
  error?: string | null;
}

/**
 * What accepting a share means, shown wherever a recipient is asked: what a
 * read-only share allows, the consent line for the download it starts, and
 * the failure of the last attempt. Pure display; the caller's container
 * spaces the three.
 */
export function SharedContainerAcceptSummary({
  testIdPrefix,
  error,
}: SharedContainerAcceptSummaryProps): JSX.Element {
  return (
    <>
      <p className="text-s fg-secondary">{SHARED_CONTAINER_READ_ONLY_NOTICE}</p>
      <p
        className="text-xs fg-secondary"
        data-testid={`${testIdPrefix}-consent`}
      >
        {SHARED_CONTAINER_ACCEPT_CONSENT}
      </p>
      {error && (
        <Notice
          errorSource="shared-container-accept-summary"
          intent="destructive"
          data-testid={`${testIdPrefix}-error`}
        >
          {error}
        </Notice>
      )}
    </>
  );
}
