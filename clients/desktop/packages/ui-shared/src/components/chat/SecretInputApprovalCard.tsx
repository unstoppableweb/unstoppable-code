'use client';

import {
  memo,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type JSX,
  type Ref,
} from 'react';
import type {
  ApprovalPromptDecision,
  ApprovalPromptRequest,
  SecretInputApprovalPrompt,
} from '@canopy/protocol/approvals';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { surfaceClassName } from '../Surface';
import { Button } from '../Button';
import { FormField } from '../FormField';
import { TextInput } from '../Field';
import type { ToolApprovalCardHandle } from './ToolApprovalCard';

export interface SecretInputApprovalCardProps {
  pending: ApprovalPromptRequest & { secretInput: SecretInputApprovalPrompt };
  /** Deny goes through the ordinary decision. */
  onRespond: (
    requestId: string,
    decision: ApprovalPromptDecision,
  ) => Promise<void>;
  /**
   * Allow, with the secret, through the host's dedicated secret channel.
   * Without it the card can only deny: a secret never travels as an
   * ordinary decision.
   */
  onRespondSecretInput?: (
    requestId: string,
    bindingId: string,
    secret: string,
  ) => Promise<void>;
  focusHandleRef?: Ref<ToolApprovalCardHandle>;
}

/**
 * An approval that needs a secret, such as an AI gateway API key. The field
 * is masked and blocked from session replay, and the value lives only in
 * this card: it is cleared as it is sent, and dropped with the card. Leaving
 * it empty reuses the key already saved for the same endpoint.
 */
export const SecretInputApprovalCard = memo(function SecretInputApprovalCard({
  pending,
  onRespond,
  onRespondSecretInput,
  focusHandleRef,
}: SecretInputApprovalCardProps): JSX.Element {
  const [secret, setSecret] = useState('');
  const respondingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useImperativeHandle(
    focusHandleRef,
    (): ToolApprovalCardHandle => ({
      focusPrimaryAction: (): void => inputRef.current?.focus(),
    }),
    [],
  );

  const respond = async (send: () => Promise<void>): Promise<void> => {
    if (respondingRef.current) return;
    respondingRef.current = true;
    try {
      await send();
    } finally {
      respondingRef.current = false;
    }
  };

  const allow = (): void => {
    if (!onRespondSecretInput) return;
    const value = secret;
    setSecret('');
    void respond(() =>
      onRespondSecretInput(
        pending.requestId,
        pending.secretInput.bindingId,
        value,
      ),
    );
  };

  const deny = (): void => {
    setSecret('');
    void respond(() =>
      onRespond(pending.requestId, { behavior: 'deny', scope: 'once' }),
    );
  };

  return (
    <div
      data-testid="tool-approval-card"
      data-approval-kind="secret-input"
      role="group"
      aria-labelledby={titleId}
      aria-describedby={pending.description ? descriptionId : undefined}
      tabIndex={-1}
      // A pending-input form: the neutral group box (docs/design/surfaces.md).
      className={surfaceClassName({
        variant: 'group',
        className: 'flex flex-col gap-3 px-4 py-3',
      })}
    >
      <div>
        <div id={titleId} className="text-s font-medium fg-primary">
          {pending.title}
        </div>
        {pending.description ? (
          <div
            id={descriptionId}
            className={`${REPLAY_BLOCK_CLASS} mt-0.5 text-xs fg-secondary`}
          >
            {pending.description}
          </div>
        ) : null}
      </div>
      <form
        className="flex flex-col gap-3"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          allow();
        }}
      >
        <FormField label={pending.secretInput.label}>
          {(control) => (
            <div className={REPLAY_BLOCK_CLASS}>
              <TextInput
                {...control}
                ref={inputRef}
                type="password"
                mono
                autoComplete="off"
                spellCheck={false}
                value={secret}
                data-testid="tool-approval-secret-input"
                onChange={(event) => setSecret(event.target.value)}
              />
            </div>
          )}
        </FormField>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            variant="primary"
            size="compact"
            disabled={!onRespondSecretInput}
            data-testid="tool-approval-allow"
          >
            Allow
          </Button>
          <Button
            type="button"
            size="compact"
            onClick={deny}
            data-testid="tool-approval-deny"
          >
            Deny
          </Button>
        </div>
      </form>
    </div>
  );
});
