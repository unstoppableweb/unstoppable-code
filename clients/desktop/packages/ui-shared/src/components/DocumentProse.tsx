import type { ComponentPropsWithRef, JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';

const PROSE_CLASS =
  'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:before:content-none prose-code:after:content-none';
const PUBLISHED_INK =
  'prose-code:fg-accent prose-headings:fg-primary prose-strong:fg-primary';
const COMPACT_SPACING = 'prose-p:my-0.5 canopy-compact-prose prose-li:my-0.5';
const LINK_INK = 'prose-a:fg-accent';

const VARIANT_CLASS = {
  published: PUBLISHED_INK,
  artifact: `${PUBLISHED_INK} ${LINK_INK}`,
  preview: `${PUBLISHED_INK} ${LINK_INK} ${COMPACT_SPACING}`,
  summary: `canopy-feed-summary-prose ${PUBLISHED_INK} ${LINK_INK} ${COMPACT_SPACING}`,
  report: `${COMPACT_SPACING} ${LINK_INK} prose-code:fg-success prose-headings:fg-primary/80 prose-strong:fg-primary/80`,
  editor:
    'p-5 prose-p:my-0.5 canopy-editor-prose prose-code:fg-success prose-headings:fg-primary/80 prose-a:fg-accent prose-strong:fg-primary/80 prose-li:my-0.5',
};

const DOCUMENT_CLASS = {
  published: `${PROSE_CLASS} ${VARIANT_CLASS.published}`,
  artifact: `${PROSE_CLASS} ${VARIANT_CLASS.artifact}`,
  preview: `${PROSE_CLASS} ${VARIANT_CLASS.preview}`,
  summary: `${PROSE_CLASS} ${VARIANT_CLASS.summary}`,
  report: `${PROSE_CLASS} ${VARIANT_CLASS.report}`,
  editor: `${PROSE_CLASS} ${VARIANT_CLASS.editor}`,
  archive:
    'prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 canopy-compact-prose prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-success prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5',
  'workspace-item':
    'prose prose-sm max-w-none fg-primary prose-headings:fg-primary prose-p:fg-primary/80 prose-a:fg-accent prose-strong:fg-primary prose-code:fg-primary/80 prose-pre:bg-fg-primary/[0.06]',
  article:
    'prose [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-pre:overflow-x-auto prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-accent prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-strong:fg-primary prose-img:rounded-lg',
};

type DocumentProseProps = Omit<ComponentPropsWithRef<'div'>, 'className'> & {
  variant?: keyof typeof DOCUMENT_CLASS;
  replay?: 'block';
  collapsed?: boolean;
};

/** Styles rendered plan and workflow documents, including their code blocks. */
export function DocumentProse({
  variant = 'published',
  replay,
  collapsed,
  ...props
}: DocumentProseProps): JSX.Element {
  return (
    <div
      {...props}
      className={`${DOCUMENT_CLASS[variant]}${collapsed ? ' line-clamp-3' : ''}${replay === 'block' ? ` ${REPLAY_BLOCK_CLASS}` : ''}`}
    />
  );
}
