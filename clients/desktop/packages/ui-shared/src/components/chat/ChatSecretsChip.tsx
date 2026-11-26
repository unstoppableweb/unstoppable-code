'use client';

import { useId, useRef, useState, type JSX } from 'react';
import { ChevronDownIcon, KeyIcon } from '../../icons/AppIcons';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../../primitives/Button';
import { Chip } from '../../primitives/Chip';
import { Notice, NoticeButton } from '../../primitives/Notice';
import { Popover } from '../../primitives/Popover';

/** One secret a chat's agent holds: metadata only, never a value. */
export interface ChatSecretsChipItem {
  readonly name: string;
  /** Where it is kept; `chat` until project secrets land. */
  readonly scope?: 'chat' | 'project';
  readonly lastUsedAt: string | null;
}

/**
 * What the chat's own shell commands get, on a host whose agent can hold
 * secrets in its environment (desktop Full access):
 * - `live`: held secrets are set in them too.
 * - `restart`: Codex started before some of them; Restart to apply.
 * - `restart-pending`: a restart happens once the chat is idle.
 * - `off`: only commands run with secrets get them.
 * - `none` (or omitted): nothing to say, as in cloud chats.
 */
export type ChatSecretsAmbient =
  | 'live'
  | 'restart'
  | 'restart-pending'
  | 'off'
  | 'none';

/** The popover's line about the agent's own commands, by ambient state. */
export function chatSecretsAmbientLine(
  ambient: ChatSecretsAmbient,
  agentName: string,
): string {
  switch (ambient) {
    case 'live':
      return "In Full access, the agent's commands can print these.";
    case 'restart':
      return `${agentName} started before some of these. Restart to apply them to its own commands.`;
    case 'restart-pending':
      return `${agentName} restarts when it's idle, or at your next message.`;
    case 'off':
    case 'none':
      return 'Hidden from the agent and command output.';
  }
}

export interface ChatSecretsChipProps {
  readonly secrets: readonly ChatSecretsChipItem[];
  /** Names whose revoke is in flight. */
  readonly revoking?: ReadonlySet<string>;
  /** Why the last revoke failed, safe to show. */
  readonly errorMessage?: string;
  readonly onRevoke: (name: string) => void;
  /** Called when the list opens, so the host can read it again. */
  readonly onOpen?: () => void;
  /** The clock for "used 2m ago"; defaults to now. */
  readonly now?: number;
  /** What the agent's own commands get; omitted where that can't apply. */
  readonly ambient?: ChatSecretsAmbient;
  /** The agent's name for the restart line, such as Codex. */
  readonly agentName?: string;
  /** Codex's Restart to apply, offered while `ambient` is `restart`. */
  readonly onRestart?: () => void;
  /** Where the list opens: below a header (default) or above a composer row. */
  readonly placement?: 'bottom-right' | 'top-right';
}

function usage(item: ChatSecretsChipItem, now: number | undefined): string {
  const scope = item.scope === 'project' ? 'Project' : 'Chat';
  return item.lastUsedAt === null
    ? `${scope} · not used yet`
    : `${scope} · used ${formatRelativeTime(item.lastUsedAt, now)}`;
}

/**
 * The chat header's Secrets chip: how many secrets the chat's agent holds,
 * and a list of them by name with when each was last used and Revoke. It
 * shows nothing while the chat holds none. Names only: no value, prefix or
 * length ever reaches it.
 */
export function ChatSecretsChip({
  secrets,
  revoking,
  errorMessage,
  onRevoke,
  onOpen,
  now,
  ambient = 'none',
  agentName = 'The agent',
  onRestart,
  placement = 'bottom-right',
}: ChatSecretsChipProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const rowId = useId();
  if (secrets.length === 0 && !open) return null;
  const label = secrets.length === 1 ? '1 secret' : `${secrets.length} secrets`;
  return (
    <>
      <span
        ref={anchorRef}
        className="inline-flex"
        data-testid="chat-secrets"
        data-ambient={ambient}
      >
        <Chip
          icon={KeyIcon}
          selected={open}
          aria-expanded={open}
          aria-haspopup="dialog"
          onClick={(): void => {
            if (!open) onOpen?.();
            setOpen(!open);
          }}
          actionTestId="chat-secrets-chip"
        >
          <span className="inline-flex items-center gap-1">
            {label}
            <ChevronDownIcon size={12} />
          </span>
        </Chip>
      </span>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={anchorRef}
        placement={placement}
        width="lg"
        aria-label="Secrets"
        data-testid="chat-secrets-popover"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-start gap-2">
            <div
              className="min-w-0 flex-1 text-xs text-pretty fg-tertiary"
              data-testid="chat-secrets-ambient"
            >
              {chatSecretsAmbientLine(ambient, agentName)}
            </div>
            {ambient === 'restart' && onRestart ? (
              <Button
                type="button"
                size="compact"
                variant="secondary"
                onClick={onRestart}
                data-testid="chat-secrets-restart"
              >
                Restart to apply
              </Button>
            ) : null}
          </div>
          {secrets.length === 0 ? (
            <div className="text-s fg-secondary">No secrets.</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {secrets.map((item, index) => (
                // Static test IDs: session replay keeps attributes, and a
                // secret's name is shown only in the replay-blocked span.
                <li
                  key={item.name}
                  className="flex items-center gap-2"
                  data-testid="chat-secrets-row"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span
                      id={`${rowId}-name-${index}`}
                      className={`${REPLAY_BLOCK_CLASS} truncate font-mono text-s fg-primary`}
                    >
                      {item.name}
                    </span>
                    <span className="text-xs fg-tertiary">
                      {usage(item, now)}
                    </span>
                  </div>
                  <Button
                    type="button"
                    size="compact"
                    variant="ghost"
                    disabled={revoking?.has(item.name) === true}
                    // Named by reference, so replay masking of the name
                    // span also covers the button's name.
                    id={`${rowId}-revoke-${index}`}
                    aria-labelledby={`${rowId}-revoke-${index} ${rowId}-name-${index}`}
                    onClick={(): void => onRevoke(item.name)}
                    data-testid="chat-secrets-revoke"
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {errorMessage !== undefined && (
            <Notice
              errorSource="chat-secrets-revoke"
              intent="destructive"
              data-testid="chat-secrets-error"
            >
              {errorMessage}
            </Notice>
          )}
        </div>
      </Popover>
    </>
  );
}

/**
 * Codex's **Restart to apply** above the composer: shown while the chat holds
 * secrets its running process started without. Restarting keeps the thread.
 */
export function ChatSecretsRestartNotice({
  agentName,
  pending,
  onRestart,
}: {
  readonly agentName: string;
  /** A restart was asked for and happens once the chat is idle. */
  readonly pending: boolean;
  readonly onRestart: () => void;
}): JSX.Element {
  return (
    <Notice
      intent="attention"
      icon={<KeyIcon size="sm" />}
      shape="composer"
      data-testid="chat-secrets-restart-notice"
      title={pending ? `${agentName} will restart` : 'New secrets'}
      actions={
        pending ? null : (
          <NoticeButton
            variant="primary"
            data-testid="chat-secrets-restart-notice-button"
            onClick={onRestart}
          >
            Restart to apply
          </NoticeButton>
        )
      }
    >
      {pending
        ? "When it's idle or at your next message, so its commands get the new secrets."
        : `${agentName}'s own commands get them after a restart. The conversation is kept.`}
    </Notice>
  );
}
