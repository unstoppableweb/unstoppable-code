'use client';

import {
  type ComponentPropsWithoutRef,
  type JSX,
  type MouseEvent,
} from 'react';
import { copyTextToClipboard } from './CopyButton';
import { Tooltip } from './Tooltip';
import './markdown-overflow.css';

const copiedTimers = new WeakMap<
  HTMLButtonElement,
  ReturnType<typeof setTimeout>
>();

function setCopied(button: HTMLButtonElement, copied: boolean): void {
  const label = copied ? 'Copied' : 'Copy';
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
    if (!(await copyTextToClipboard(code))) return;
    const activeTimer = copiedTimers.get(button);
    if (activeTimer !== undefined) clearTimeout(activeTimer);
    setCopied(button, true);
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
          <button
            type="button"
            onClick={handleCopy}
            aria-label="Copy"
            className="markdown-code-copy-button focus-ring rounded-md bg-popover/80 p-1.5 fg-secondary transition-colors hover:bg-popover hover:fg-primary"
          />
        </Tooltip>
      </span>
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
