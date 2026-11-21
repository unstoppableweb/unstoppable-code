'use client';

import type { ComponentPropsWithoutRef, JSX } from 'react';
import type { MarkdownOptions } from '../markdown-render';
import {
  TRANSCRIPT_MARKDOWN_OPTIONS,
  TRANSCRIPT_PROSE_CLASS,
  markdownOptions,
} from '../markdown-render';
import { Markdown } from '../MarkdownClient';
import type { LedgerDensity } from './ledger-entry-slots';

/** Images in entry content stay text; a remote image is never fetched. */
function ImageAltText({ alt }: ComponentPropsWithoutRef<'img'>): JSX.Element {
  return <span className="fg-tertiary">{alt ? alt : 'Image'}</span>;
}

/** Safe options for entry content: raw HTML stays text and images stay local. */
export const LEDGER_ENTRY_MARKDOWN_OPTIONS: MarkdownOptions = markdownOptions(
  { img: ImageAltText },
  TRANSCRIPT_MARKDOWN_OPTIONS,
);

/** Renders an entry's content as safe Markdown at the chosen Ledger density. */
export function LedgerEntryMarkdown({
  content,
  density,
  'data-testid': testId,
}: {
  readonly content: string;
  readonly density: LedgerDensity;
  readonly 'data-testid'?: string;
}): JSX.Element {
  return (
    <div
      data-testid={testId}
      // The transcript's prose maps the typography plugin onto the house
      // tokens; the Ledger only sets its own text size.
      className={`${TRANSCRIPT_PROSE_CLASS} ${density === 'page' ? 'text-s' : 'text-xs'} leading-5`}
    >
      <Markdown options={LEDGER_ENTRY_MARKDOWN_OPTIONS}>{content}</Markdown>
    </div>
  );
}
