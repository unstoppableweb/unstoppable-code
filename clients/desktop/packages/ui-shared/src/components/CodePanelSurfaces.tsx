import type { ComponentPropsWithRef, JSX, ReactNode } from 'react';

export function TranscriptViewport(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="flex h-full min-h-0 flex-col overflow-y-auto overscroll-contain p-3 [&_[data-chat-call-focus]]:rounded-lg [&_[data-chat-call-focus]]:ring-2 [&_[data-chat-call-focus]]:ring-line-accent"
    />
  );
}

export function ComposerPanel({
  shell,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly shell: boolean;
}): JSX.Element {
  return (
    <div
      {...props}
      className={
        shell ? 'p-2 flex flex-col gap-1' : 'border-t p-2 flex flex-col gap-1'
      }
    />
  );
}

export function AgentActivityPanel({
  active,
  ...props
}: Omit<ComponentPropsWithRef<'section'>, 'className'> & {
  readonly active: boolean;
}): JSX.Element {
  return (
    <section
      {...props}
      className={
        active
          ? 'mx-auto w-full max-w-[var(--chat-composer-shell-width)] chat-width-transition shrink-0 border-t bg-base px-4 py-2'
          : 'flex flex-col px-3'
      }
    />
  );
}

export function WorktreeTopBarSurface(
  props: Omit<ComponentPropsWithRef<'div'>, 'className'>,
): JSX.Element {
  return (
    <div
      {...props}
      className="@container/topbar relative flex shrink-0 cursor-default items-stretch bg-secondary after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-[var(--default-border-width)] after:bg-line-base after:content-['']"
    />
  );
}

export function TerminalReadOnlyNotice({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="pointer-events-auto flex max-w-xl items-center gap-2 rounded bg-card px-3 py-1.5 text-2xs fg-secondary shadow-sm">
      {children}
    </div>
  );
}

export function TerminalViewport({
  emphasis,
  ...props
}: Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  readonly emphasis: 'drop' | 'focus' | 'none';
}): JSX.Element {
  const border =
    emphasis === 'drop'
      ? 'ring-1 ring-line-accent/70'
      : emphasis === 'focus'
        ? 'ring-1 ring-line-accent/40'
        : '';
  return (
    <div
      {...props}
      className={`relative min-h-0 min-w-0 flex-1 overflow-hidden ${border}`}
    />
  );
}
