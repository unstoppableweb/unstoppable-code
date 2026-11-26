import type { ComponentPropsWithoutRef, JSX } from 'react';

const VARIANTS = {
  'workflow-model':
    'rounded border bg-fg-primary/[0.04] px-1.5 py-0.5 font-mono fg-primary/70',
  'skill-chain': 'rounded-md bg-secondary px-1.5 py-0.5 font-mono fg-secondary',
  reference: 'rounded bg-secondary px-1.5 py-0.5 font-mono fg-primary',
  'advisor-markdown':
    'rounded bg-fg-primary/[0.08] px-1 py-0.5 font-mono text-xs fg-info',
  'skill-name': 'rounded bg-fg-primary/[0.08] px-1 py-0.5 font-mono text-2xs',
} as const;

/** Inline code retains the surrounding line height. */
export function InlineCode({
  children,
  variant = 'reference',
}: Pick<ComponentPropsWithoutRef<'code'>, 'children'> & {
  readonly variant?: keyof typeof VARIANTS;
}): JSX.Element {
  const Tag =
    variant === 'workflow-model' || variant === 'skill-chain' ? 'span' : 'code';
  return <Tag className={VARIANTS[variant]}>{children}</Tag>;
}
