import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';
import { Button } from '../Button';

export function TerminalChatControls({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-full bg-card p-1 shadow-sm pointer-coarse:gap-4">
      {children}
    </div>
  );
}

export function ScheduledSendCapsule({
  failed,
  children,
}: {
  readonly failed: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <span
      data-testid="chat-input-scheduled-send-chip"
      data-scheduled-send-state={failed ? 'failed' : 'scheduled'}
      className={`flex h-8 shrink-0 items-center rounded-full text-xs ${failed ? 'bg-destructive-subtle fg-destructive' : 'bg-info-subtle fg-info'}`}
    >
      {children}
    </span>
  );
}

/** A clickable position marker in the editor's comment overview. */
export function FileCommentPositionMarker(
  props: Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'type'>,
): JSX.Element {
  return (
    <Button {...props} variant="link" className="absolute inset-0 block">
      <span
        aria-hidden="true"
        className="block h-full w-full min-h-1 rounded-full bg-accent shadow-sm hover:opacity-80"
      />
    </Button>
  );
}
