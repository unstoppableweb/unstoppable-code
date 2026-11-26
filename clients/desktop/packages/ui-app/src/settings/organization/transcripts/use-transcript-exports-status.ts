'use client';

import { useEffect, useState } from 'react';
import { useSettingsClient } from '../../host';

export type TranscriptExportsStatus =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'ready';
      /** An export is preparing: Export stays off until it finishes. */
      readonly activeExport: boolean;
      readonly storageAvailable: boolean;
    };

/**
 * Whether Export can start: the organization has no preparing export and
 * the server can store one. Read from `exports.list`, as the Exports tab is.
 * A failed read keeps Export off; the server refuses a second export anyway.
 */
export function useTranscriptExportsStatus(
  organizationId: string,
): TranscriptExportsStatus {
  const client = useSettingsClient();
  const [state, setState] = useState<TranscriptExportsStatus>({
    status: 'loading',
  });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    client
      .read('organization.transcripts.exports', { organizationId, limit: 1 })
      .then(
        (result) => {
          if (cancelled) return;
          setState({
            status: 'ready',
            activeExport: result.activeExport !== null,
            storageAvailable: result.storageAvailable,
          });
        },
        () => {
          if (!cancelled) setState({ status: 'error' });
        },
      );
    return (): void => {
      cancelled = true;
    };
  }, [client, organizationId]);
  return state;
}
