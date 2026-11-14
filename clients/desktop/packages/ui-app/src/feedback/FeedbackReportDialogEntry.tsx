'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import {
  NoticeButton,
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
  Notice,
} from '@canopy/ui-shared/components';
import { FeedbackDialogShell } from './FeedbackDialogShell';
import type {
  DraftState,
  FeedbackReportDialogComponent,
  FeedbackReportDialogProps,
} from './feedback-report-dialog-types';

export type { FeedbackReportDialogProps } from './feedback-report-dialog-types';

type Client = FeedbackReportDialogProps['client'];
type LoadState =
  | { readonly status: 'pending' }
  | { readonly status: 'failed'; readonly client: Client }
  | {
      readonly status: 'ready';
      readonly client: Client;
      readonly Content: FeedbackReportDialogComponent;
      readonly openingDraft: Promise<DraftState>;
    };

let contentPromise: Promise<FeedbackReportDialogComponent> | undefined;

function loadContent(): Promise<FeedbackReportDialogComponent> {
  contentPromise ??= import('./FeedbackReportDialog')
    .then((module) => module.FeedbackReportDialog)
    .catch((error: unknown) => {
      contentPromise = undefined;
      throw error;
    });
  return contentPromise;
}

/** The shared public entry stays light until a host opens the dialog. */
export function FeedbackReportDialog(
  props: FeedbackReportDialogProps,
): JSX.Element {
  const { client } = props;
  const [state, setState] = useState<LoadState>({ status: 'pending' });
  const [attempt, setAttempt] = useState(0);
  const opening = useRef<{
    readonly client: Client;
    readonly draft: Promise<DraftState>;
  } | null>(null);

  useEffect(() => {
    let active = true;
    // Capture context at opening, before the chunk arrives. Retrying a chunk
    // keeps this same draft; changing accounts/clients starts a new opening.
    if (opening.current?.client !== client) {
      opening.current = {
        client,
        draft: Promise.resolve()
          .then(() => client.draft())
          .then(
            (draft): DraftState => ({ status: 'ready', draft }),
            (): DraftState => ({ status: 'unavailable' }),
          ),
      };
    }
    const openingDraft = opening.current.draft;
    void loadContent().then(
      (Content) => {
        if (active)
          setState({ status: 'ready', client, Content, openingDraft });
      },
      () => {
        if (active) setState({ status: 'failed', client });
      },
    );
    return (): void => {
      active = false;
    };
  }, [client, attempt]);

  if (state.status === 'ready' && state.client === client) {
    const { Content, openingDraft } = state;
    return <Content {...props} openingDraft={openingDraft} />;
  }

  const failed = state.status === 'failed' && state.client === client;
  return (
    <FeedbackDialogShell
      appName={props.appName}
      errorMode={props.error !== undefined}
      onClose={props.onClose}
      ownerDocument={props.ownerDocument}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
        {failed ? (
          <Notice
            errorSource="feedback-report-dialog"
            intent="destructive"
            actions={
              <NoticeButton
                type="button"
                onClick={(): void => {
                  setState({ status: 'pending' });
                  setAttempt((value) => value + 1);
                }}
              >
                Try again
              </NoticeButton>
            }
          >
            Could not open the feedback form.
          </Notice>
        ) : (
          // The form component itself has not loaded, so it cannot be measured.
          <DelayedLoadingPlaceholder>
            <CenteredLoadingSpinner />
          </DelayedLoadingPlaceholder>
        )}
      </div>
    </FeedbackDialogShell>
  );
}
