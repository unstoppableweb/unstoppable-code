'use client';

import { useEffect, type JSX } from 'react';
import type { OrganizationConnection } from '@canopy/protocol/canopy-core';
import { Button, type BadgeTone } from '@canopy/ui-shared/components';
import { SETTINGS_CARD_ROW_CLASS } from '@canopy/ui-shared/components/settings/SettingsCard';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

type SharedConnectionStatus = OrganizationConnection['status'];

/**
 * A shared connection's sign-in state, in the same words on the Connectors
 * page and in project setup. A connected one shows nothing.
 */
const STATUS: Partial<
  Record<SharedConnectionStatus, { label: string; tone: BadgeTone }>
> = {
  needsSignIn: { label: 'Needs sign-in', tone: 'warning' },
  pending: { label: 'Not signed in', tone: 'warning' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

export function sharedConnectionStatus(
  status: SharedConnectionStatus,
): { readonly label: string; readonly tone: BadgeTone } | undefined {
  return STATUS[status];
}

/** Names joined for a sentence ("A, B and C"), masked in session replay. */
export function MaskedNameList({
  names,
}: {
  names: readonly { readonly id: string; readonly name: string }[];
}): JSX.Element {
  return (
    <>
      {names.map((entry, index) => (
        <span key={entry.id}>
          {index === 0 ? '' : index === names.length - 1 ? ' and ' : ', '}
          <span className={REPLAY_MASK_CLASS}>{entry.name}</span>
        </span>
      ))}
    </>
  );
}

/**
 * Reads again each time the person comes back from a sign-in in the
 * browser. A desktop window beside the browser is never hidden, so its
 * return is a window focus, not a visibility change.
 */
export function useReadAgainOnReturn(
  active: boolean,
  readAgain: (() => void) | undefined,
): void {
  useEffect(() => {
    if (!active || readAgain === undefined) return;
    const onReturn = (): void => {
      if (document.visibilityState === 'visible') readAgain();
    };
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    return (): void => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
    };
  }, [active, readAgain]);
}

/**
 * A sign-in waiting in the browser, offered again: on web it opens after the
 * start request, outside the click, so the browser may have blocked it.
 */
export function SignInPendingRow({
  connectionName,
  onOpen,
  testId,
  openTestId,
}: {
  /** The connection being signed in to, when the row isn't already about it. */
  connectionName?: string;
  onOpen: () => void;
  testId: string;
  openTestId: string;
}): JSX.Element {
  return (
    <div className={SETTINGS_CARD_ROW_CLASS} data-testid={testId}>
      <p className="text-xs text-pretty fg-secondary">
        {connectionName === undefined ? (
          'Finish signing in with your browser, then come back here.'
        ) : (
          <>
            Finish signing in to{' '}
            <span className={REPLAY_MASK_CLASS}>{connectionName}</span> with
            your browser, then come back here.
          </>
        )}
      </p>
      <Button
        size="compact"
        variant="secondary"
        onClick={onOpen}
        data-testid={openTestId}
      >
        Open sign-in
      </Button>
    </div>
  );
}
