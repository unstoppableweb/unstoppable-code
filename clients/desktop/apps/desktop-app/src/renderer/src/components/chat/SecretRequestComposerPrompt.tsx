import { useCallback, useState, type JSX } from 'react';
import type {
  McpSecretRequest,
  SecretRequestSettleResponse,
} from '@canopy/desktop-shared/types';
import {
  SecretRequestPrompt,
  type SecretRequestPromptSubmission,
} from '@canopy/ui-shared/components/chat/SecretRequestPrompt';
import { useChatSurfaceScope } from '@/stores/chat/surface-store';
import { chatBackendFor } from '@/stores/chat/backend';
import { toAppError } from '@canopy/protocol/app-errors';

export interface SecretRequestComposerPromptProps {
  readonly requestId: string;
  readonly request: McpSecretRequest;
  /** The pending request's chat and project: a cloud chat answers over the web core. */
  readonly chatId: string;
  readonly projectId: string;
  /** Keeps the request mounted while its submission is in flight. */
  readonly onDeliveryChange: (requestId: string, retained: boolean) => void;
  readonly onClose: () => void;
  /** Shows the request read-only when this window cannot answer it. */
  readonly readOnlyHint?: string;
}

/**
 * The composer's secret request form. A local chat's values go only to main
 * over `secretRequest.submit`; a cloud chat's only to the web core's
 * `core.chat.secretRequest.submit` (agent secret requests). Never through
 * the chat store, a draft or the question answer path.
 */
export function SecretRequestComposerPrompt({
  requestId,
  request,
  chatId,
  projectId,
  onDeliveryChange,
  onClose,
  readOnlyHint,
}: SecretRequestComposerPromptProps): JSX.Element {
  const disconnected = useChatSurfaceScope()?.disconnected === true;
  const [busy, setBusy] = useState<'submit' | 'decline' | null>(null);
  const [errorKind, setErrorKind] = useState<'submit' | 'decline' | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | undefined>();
  const [settled, setSettled] = useState<'ended' | 'answered' | undefined>();

  const settle = useCallback(
    (
      kind: 'submit' | 'decline',
      send: () => Promise<SecretRequestSettleResponse>,
    ): void => {
      if (readOnlyHint !== undefined) return;
      setBusy(kind);
      setErrorKind(null);
      setErrorMessage(undefined);
      onDeliveryChange(requestId, true);
      void send()
        .then((response) => {
          if (!response.accepted) {
            setErrorKind(kind);
            setErrorMessage(response.error);
            setSettled(response.reason);
          }
        })
        .catch((error: unknown) => {
          // Classified for its kind only: a delivery failure never carries a
          // value, and nothing here logs or shows its text.
          const failure = toAppError(error);
          setErrorKind(kind);
          if (failure?.kind === 'external')
            setErrorMessage("Couldn't reach this chat.");
        })
        .finally(() => {
          onDeliveryChange(requestId, false);
          setBusy(null);
        });
    },
    [onDeliveryChange, readOnlyHint, requestId],
  );

  const submit = useCallback(
    (submission: SecretRequestPromptSubmission): void =>
      settle('submit', () =>
        chatBackendFor({ projectId }).secretRequests.submit({
          chatId,
          requestId,
          values: submission.values,
          useHeld: submission.useHeld,
        }),
      ),
    [chatId, projectId, requestId, settle],
  );

  const decline = useCallback(
    (): void =>
      settle('decline', () =>
        chatBackendFor({ projectId }).secretRequests.decline({
          chatId,
          requestId,
        }),
      ),
    [chatId, projectId, requestId, settle],
  );

  return (
    <SecretRequestPrompt
      key={requestId}
      agentName={request.agentName}
      reason={request.reason}
      items={request.secrets}
      accessMode={request.accessMode}
      storage={request.storage}
      busy={busy}
      errorKind={errorKind}
      {...(errorMessage !== undefined ? { errorMessage } : {})}
      {...(settled !== undefined ? { settled } : {})}
      {...(readOnlyHint !== undefined ? { readOnlyHint } : {})}
      disconnected={disconnected}
      onSubmit={submit}
      onDecline={decline}
      onClose={onClose}
    />
  );
}
