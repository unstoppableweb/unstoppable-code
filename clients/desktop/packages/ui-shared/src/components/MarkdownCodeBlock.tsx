'use client';

import { ControlButton } from '../primitives/Button';
import {
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent,
} from 'react';
import { copyTextToClipboard } from '../primitives/CopyButton';
import { Tooltip } from '../primitives/Tooltip';
import './markdown-overflow.css';

const copiedTimers = new WeakMap<
  HTMLButtonElement,
  ReturnType<typeof setTimeout>
>();

function announce(button: HTMLButtonElement, message: string): void {
  const status = button
    .closest('.markdown-code-copy-host')
    ?.querySelector('[data-copy-status]');
  if (status) status.textContent = message;
}

function setCopied(button: HTMLButtonElement, copied: boolean): void {
  const label = copied ? 'Copied' : 'Copy';
  announce(button, copied ? 'Copied' : '');
  // Accessible name only: hover help comes from the rich Tooltip wrapper, so
  // no native `title` is written here either.
  button.setAttribute('aria-label', label);
  if (copied) {
    button.dataset.copied = 'true';
  } else {
    delete button.dataset.copied;
  }
}

function handleCopy(event: MouseEvent<HTMLButtonElement>): void {
  event.stopPropagation();
  event.preventDefault();
  const button = event.currentTarget;
  const code =
    button.closest('.markdown-code-copy-host')?.querySelector('pre')
      ?.textContent ?? '';
  void (async (): Promise<void> => {
    const copied = await copyTextToClipboard(code);
    const activeTimer = copiedTimers.get(button);
    if (activeTimer !== undefined) clearTimeout(activeTimer);
    if (copied) setCopied(button, true);
    else announce(button, "Couldn't copy the code");
    copiedTimers.set(
      button,
      setTimeout((): void => {
        setCopied(button, false);
        copiedTimers.delete(button);
      }, 1500),
    );
  })();
}

/**
 * Shared fenced/indented code-block chrome for markdown surfaces that do not
 * supply a specialized transcript renderer. Inline code never renders through
 * `pre`, so it does not receive a copy affordance.
 */
export function MarkdownCodeBlock({
  children,
  ...props
}: ComponentPropsWithoutRef<'pre'>): JSX.Element {
  return (
    <div className="markdown-code-copy-host relative overflow-visible">
      {/* The hover-reveal + corner positioning live on this span (the
          `.markdown-code-copy-host > .markdown-code-copy-control` rule needs
          a direct child), so the rich tooltip wrapper inside it can stay
          `relative` and the button keeps its geometry. */}
      <span className="markdown-code-copy-control pointer-events-none absolute -right-2 -top-2 z-30 opacity-0 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100">
        <Tooltip label="Copy">
          <ControlButton
            type="button"
            onClick={handleCopy}
            aria-label="Copy"
            presentation="markdown-copy"
          />
        </Tooltip>
      </span>
      <span className="sr-only" aria-live="polite" data-copy-status />
      <pre
        {...props}
        tabIndex={props.tabIndex ?? 0}
        role={props.role ?? 'group'}
        aria-label={props['aria-label'] ?? 'Code'}
      >
        {children}
      </pre>
    </div>
  );
}
