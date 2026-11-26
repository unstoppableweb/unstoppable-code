'use client';

import type { JSX } from 'react';
import { customizeHarnessLabel } from '../lib/customize-discovery';
import {
  harnessListLabel,
  type HarnessCatchUpOffer,
  type HarnessCatchUpResult,
} from '../lib/harness-catch-up';
import { Notice, NoticeButton } from '../primitives/Notice';

/** Where adding existing installs to newly set-up harnesses stands. */
export type HarnessCatchUpNoticeState =
  | { readonly kind: 'offer'; readonly offer: HarnessCatchUpOffer }
  | { readonly kind: 'adding'; readonly offer: HarnessCatchUpOffer }
  | {
      readonly kind: 'done';
      readonly offer: HarnessCatchUpOffer;
      readonly result: HarnessCatchUpResult;
    }
  | {
      readonly kind: 'failed';
      readonly offer: HarnessCatchUpOffer;
      readonly message: string;
    };

export interface HarnessCatchUpNoticeProps {
  readonly state: HarnessCatchUpNoticeState;
  /** The one confirmation: add the installs to the new harnesses. */
  readonly onAdd: () => void;
  /** Not now, or closing the result. */
  readonly onDismiss: () => void;
}

function itemCount(count: number): string {
  return count === 1 ? '1 item' : `${String(count)} items`;
}

/**
 * New Customize (CAN-6817): offers to add the user's existing installs to
 * harnesses set up after they were added, with one confirmation, then says
 * what was added and what was not, with why. Built on the shared `Notice`
 * (proposed UI, pending design sign-off). Pure display: the host computes
 * the offer and makes the calls.
 */
export function HarnessCatchUpNotice({
  state,
  onAdd,
  onDismiss,
}: HarnessCatchUpNoticeProps): JSX.Element {
  const harnesses = harnessListLabel(state.offer.harnesses);
  const testId = 'customize-harness-catch-up';
  if (state.kind === 'done') {
    const { added, notAdded } = state.result;
    return (
      <Notice
        intent={notAdded.length > 0 ? 'attention' : 'positive'}
        data-testid={testId}
        detail={
          notAdded.length > 0 ? (
            <ul
              data-testid={`${testId}-not-added`}
              className="flex list-none flex-col gap-0.5 p-0"
            >
              {notAdded.map((note) => (
                <li key={`${note.name}-${note.harness}`}>
                  {`${note.name} (${customizeHarnessLabel(note.harness)}): ${note.reason}`}
                </li>
              ))}
            </ul>
          ) : undefined
        }
        onDismiss={onDismiss}
        dismissTestId={`${testId}-dismiss`}
      >
        {added > 0
          ? `Added ${itemCount(added)} to ${harnesses}.`
          : `Nothing was added to ${harnesses}.`}
        {notAdded.length > 0 ? " These couldn't be added:" : ''}
      </Notice>
    );
  }
  const count = itemCount(state.offer.targets.length);
  return (
    <Notice
      {...(state.kind === 'failed'
        ? {
            intent: 'destructive' as const,
            errorSource: 'customize-harness-catch-up',
          }
        : { intent: 'neutral' as const })}
      data-testid={testId}
      title={
        state.kind === 'failed'
          ? `Couldn't add your installs to ${harnesses}`
          : `Add your installs to ${harnesses}?`
      }
      detail={state.kind === 'failed' ? state.message : undefined}
      announceDetail={state.kind === 'failed'}
      actions={
        <>
          <NoticeButton
            onClick={onDismiss}
            disabled={state.kind === 'adding'}
            data-testid={`${testId}-not-now`}
          >
            Not now
          </NoticeButton>
          <NoticeButton
            variant="primary"
            onClick={onAdd}
            busy={state.kind === 'adding'}
            busyLabel="Adding…"
            data-testid={`${testId}-add`}
          >
            {state.kind === 'failed' ? 'Try again' : `Add to ${harnesses}`}
          </NoticeButton>
        </>
      }
    >
      {`${count} you added before setting up ${harnesses} ${state.offer.targets.length === 1 ? "isn't" : "aren't"} installed for ${state.offer.harnesses.length === 1 ? 'it' : 'them'} yet.`}
    </Notice>
  );
}
