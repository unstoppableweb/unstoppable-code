import type { ComponentPropsWithRef, JSX } from 'react';

const PROSE_CLASS =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:before:content-none prose-code:after:content-none';
const VARIANT_CLASS = {
  published:
    'prose-code:fg-accent prose-headings:fg-primary prose-strong:fg-primary',
  editor:
    'p-5 prose-p:my-0.5 canopy-editor-prose prose-code:fg-success prose-headings:fg-primary/80 prose-a:fg-accent prose-strong:fg-primary/80 prose-li:my-0.5',
};

type DocumentProseProps = Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  variant?: keyof typeof VARIANT_CLASS;
};

/** Styles rendered plan and workflow documents, including their code blocks. */
export function DocumentProse({
  variant = 'published',
  ...props
}: DocumentProseProps): JSX.Element {
  return (
    <div {...props} className={`${PROSE_CLASS} ${VARIANT_CLASS[variant]}`} />
  );
}
