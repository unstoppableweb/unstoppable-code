'use client';

import { useEffect, useId, useRef, useState, type JSX } from 'react';
import { AGENT_SECRET_NAME_PATTERN } from '@canopy/protocol/agent-secrets';
import type { SecretSpan } from '@canopy/protocol/secret-redaction';
import { CloseLargeIcon, KeyIcon } from '../../icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../../primitives/Button';
import { FormField } from '../../primitives/FormField';
import { TextInput } from '../../primitives/Field';
import { Notice } from '../../primitives/Notice';
import { ComposerIconButton } from './ComposerIconButton';

/*
 * The composer's paste guard (agent secret requests, mockups §3): pasted
 * text that looks like a secret is held here, never in the draft, until the
 * person chooses. "Send anyway" puts it in the message as typed text; "Send
 * as secret" keeps the value as a chat secret and puts a mention of its name
 * in the message instead.
 */

/** What a pasted secret becomes once it is kept as a chat secret. */
export interface PastedSecretSplit {
  /** The value to keep as a secret. */
  readonly value: string;
  /** What the message gets in the paste's place: a mention of the name. */
  readonly message: string;
}

/** How a message mentions a secret it no longer holds: the redactor's mark. */
export function secretMention(name: string): string {
  return `[secret:${name}]`;
}

/** One `KEY=value` line, as a `.env` file or a shell export writes it. */
const SINGLE_ASSIGNMENT =
  /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s"'][^\r\n]*))$/;

/**
 * Splits a pasted secret into the value to keep and the text the message
 * gets. The message gets only a mention of `name`, never any of the paste:
 * detection finds where a secret is, not always all of it, so no part of
 * the paste is left behind. The value is the whole paste, or, when the
 * paste is one `KEY=value` line, the value alone.
 */
export function splitPastedSecret(
  text: string,
  name: string,
): PastedSecretSplit {
  const trimmed = text.trim();
  const assignment = SINGLE_ASSIGNMENT.exec(trimmed);
  const value = assignment
    ? (assignment[2] ?? assignment[3] ?? assignment[4] ?? '')
    : trimmed;
  return {
    value: value.trim().length > 0 ? value : trimmed,
    message: secretMention(name),
  };
}

/** The paste masked but for its first few characters. */
export function maskPastedSecret(text: string): string {
  const trimmed = text.trim();
  const keep = Math.min(6, Math.floor(trimmed.length / 4));
  return `${trimmed.slice(0, keep)}••••••••`;
}

/** A guess at a secret's name from a `KEY=value` or `KEY: value` paste. */
export function suggestedSecretName(
  text: string,
  spans: readonly SecretSpan[],
): string {
  const assignment = SINGLE_ASSIGNMENT.exec(text.trim())?.[1];
  const first = spans[0];
  const key =
    assignment ??
    (first === undefined
      ? undefined
      : /([A-Za-z_][A-Za-z0-9_]*)["']?\s*[:=]\s*["']?$/.exec(
          text.slice(0, first.start),
        )?.[1]);
  const upper = key?.toUpperCase() ?? '';
  return AGENT_SECRET_NAME_PATTERN.test(upper) ? upper : '';
}

export interface PastedSecretNoticeProps {
  readonly text: string;
  readonly spans: readonly SecretSpan[];
  /** Keeping the value is in flight. */
  readonly busy?: boolean;
  /** Why keeping it failed, safe to show. */
  readonly errorMessage?: string;
  /** Puts the paste into the message as it is. */
  readonly onSendAnyway: () => void;
  /** Keeps the value as a chat secret named `name`. */
  readonly onSendAsSecret: (name: string) => void;
  /** Drops the paste. */
  readonly onDismiss: () => void;
}

export function PastedSecretNotice({
  text,
  spans,
  busy = false,
  errorMessage,
  onSendAnyway,
  onSendAsSecret,
  onDismiss,
}: PastedSecretNoticeProps): JSX.Element {
  const titleId = useId();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState(() => suggestedSecretName(text, spans));
  const [attempted, setAttempted] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const valid = AGENT_SECRET_NAME_PATTERN.test(name);

  useEffect(() => {
    if (naming) nameRef.current?.focus();
  }, [naming]);

  const submit = (): void => {
    setAttempted(true);
    if (!valid || busy) return;
    onSendAsSecret(name);
  };

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="flex flex-col gap-2 px-3 pt-2"
      data-testid="chat-pasted-secret-notice"
      onKeyDown={(event): void => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        onDismiss();
      }}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden className="shrink-0 pt-0.5 fg-attention">
          <KeyIcon size={16} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div
            className={`${REPLAY_BLOCK_CLASS} truncate font-mono text-s fg-secondary`}
            data-testid="chat-pasted-secret-preview"
          >
            {maskPastedSecret(text)}
          </div>
          <div id={titleId} className="text-s fg-primary text-pretty">
            This looks like a secret. If you send it as a message, the agent and
            its provider will see it.
          </div>
        </div>
        <ComposerIconButton
          capsule
          tone="strong"
          aria-label="Discard pasted text"
          onClick={onDismiss}
          data-testid="chat-pasted-secret-dismiss"
        >
          <CloseLargeIcon size={16} />
        </ComposerIconButton>
      </div>
      {naming ? (
        <form
          className="flex flex-col gap-2"
          autoComplete="off"
          noValidate
          onSubmit={(event): void => {
            event.preventDefault();
            submit();
          }}
        >
          <FormField
            label="Secret name"
            description="The agent gets this name, never the value, and uses it in commands."
            {...(attempted && !valid
              ? {
                  error:
                    'Use capital letters, digits and underscores, starting with a letter or underscore.',
                }
              : {})}
          >
            {(control) => (
              <TextInput
                {...control}
                mono
                ref={(element): void => {
                  nameRef.current = element;
                }}
                value={name}
                disabled={busy}
                placeholder="STRIPE_SECRET_KEY"
                autoComplete="off"
                spellCheck={false}
                onChange={(event): void =>
                  setName(event.target.value.toUpperCase())
                }
                data-testid="chat-pasted-secret-name"
              />
            )}
          </FormField>
          {errorMessage !== undefined && (
            <Notice
              errorSource="chat-pasted-secret"
              intent="destructive"
              data-testid="chat-pasted-secret-error"
            >
              {errorMessage}
            </Notice>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="compact"
              disabled={busy}
              onClick={(): void => setNaming(false)}
              data-testid="chat-pasted-secret-cancel"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="compact"
              variant="primary"
              disabled={busy || (attempted && !valid)}
              data-testid="chat-pasted-secret-save"
            >
              Send as secret
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="compact"
            onClick={onSendAnyway}
            data-testid="chat-pasted-secret-send-anyway"
          >
            Send anyway
          </Button>
          <Button
            type="button"
            size="compact"
            variant="primary"
            onClick={(): void => setNaming(true)}
            data-testid="chat-pasted-secret-send-as-secret"
          >
            Send as secret
          </Button>
        </div>
      )}
    </div>
  );
}
