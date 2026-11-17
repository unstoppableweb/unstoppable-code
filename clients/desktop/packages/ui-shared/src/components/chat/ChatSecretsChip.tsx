'use client';

import { useRef, useState, type JSX } from 'react';
import { ChevronDownIcon, KeyIcon } from '../../icons/AppIcons';
import { formatRelativeTime } from '../../lib/format-relative-time';
import { Button } from '../Button';
import { Chip } from '../Chip';
import { Notice } from '../Notice';
import { Popover } from '../Popover';

/** One secret a chat's agent holds: metadata only, never a value. */
export interface ChatSecretsChipItem {
  readonly name: string;
  /** Where it is kept; `chat` until project secrets land. */
  readonly scope?: 'chat' | 'project';
  readonly lastUsedAt: string | null;
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
}: ChatSecretsChipProps): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  if (secrets.length === 0 && !open) return null;
  const label = secrets.length === 1 ? '1 secret' : `${secrets.length} secrets`;
  return (
    <>
      <span ref={anchorRef} className="inline-flex">
        <Chip
          icon={KeyIcon}
          selected={open}
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
        placement="bottom-right"
        width="lg"
        aria-label="Secrets"
        data-testid="chat-secrets-popover"
      >
        <div className="flex flex-col gap-2">
          <div className="text-xs fg-tertiary">
            The agent uses these by name in commands. It never sees the values.
          </div>
          {secrets.length === 0 ? (
            <div className="text-s fg-secondary">No secrets.</div>
          ) : (
            <ul className="flex flex-col gap-1">
              {secrets.map((item) => (
                <li
                  key={item.name}
                  className="flex items-center gap-2"
                  data-testid={`chat-secrets-row-${item.name}`}
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-s fg-primary">
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
                    onClick={(): void => onRevoke(item.name)}
                    data-testid={`chat-secrets-revoke-${item.name}`}
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
