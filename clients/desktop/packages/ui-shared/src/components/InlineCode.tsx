import type { JSX, ReactNode } from 'react';

/** A branch name or path, preserving the surrounding text size and line height. */
export function InlineCode({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <code className="rounded bg-secondary px-1.5 py-0.5 font-mono fg-primary">
      {children}
    </code>
  );
}
