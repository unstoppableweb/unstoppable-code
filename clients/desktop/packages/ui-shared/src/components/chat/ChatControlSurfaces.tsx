import type { ComponentPropsWithoutRef, JSX, ReactNode } from 'react';
import { Button } from '../Button';

export function TerminalChatControls({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="pointer-events-auto flex items-center gap-1 rounded-lg bg-card p-1 shadow-sm pointer-coarse:gap-4">
      {children}
    </div>
  );
}

/**
 * Floating over terminal output, the track recedes by dimming its contents at
 * rest. Its own fill stays solid, so output never shows through the control.
 */
export function ChatModeControlTrack({
  floating,
  label,
  children,
}: {
  readonly floating: boolean;
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="chat-interface-mode-toggle"
      className={`electron-no-drag relative flex h-8 shrink-0 items-center gap-0 rounded-full p-0.5 ${floating ? 'bg-card shadow-sm *:opacity-60 hover:*:opacity-100 focus-within:*:opacity-100' : 'bg-muted'}`}
    >
      {children}
    </div>
  );
}

export function ChatModeControlThumb({
  index,
}: {
  readonly index: number;
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-testid="chat-interface-mode-toggle-selector"
      className="pointer-events-none absolute left-0.5 top-0.5 h-7 w-7 rounded-full bg-quaternary shadow-sm transition-[transform] duration-200 ease-out motion-reduce:transition-none"
      style={{ transform: `translateX(${index * 28}px)` }}
    />
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
