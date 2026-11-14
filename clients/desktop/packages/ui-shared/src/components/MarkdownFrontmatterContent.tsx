import { type JSX } from 'react';

import { Markdown, type MarkdownProps } from './Markdown';
import { ErrorBanner } from './StatusBlocks';
import { CenteredLoadingSpinner } from './CenteredLoadingSpinner';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import {
  FrontmatterBlock,
  visibleFrontmatterEntries,
} from './FrontmatterBlock';

export type FrontmatterValue = unknown;

export interface MarkdownFrontmatterContentProps {
  readonly markdownOptions?: MarkdownProps['options'];
  /** Whether the underlying content fetch is in flight. */
  readonly loading: boolean;
  /** Error message string ('' = no error). */
  readonly error: string;
  /** Loaded content. `null` while loading or after an error. */
  readonly content: {
    readonly frontmatter: Record<string, FrontmatterValue>;
    readonly body: string;
  } | null;
  /** Text shown when both `frontmatter` is empty and `body.trim()` is empty. */
  readonly emptyText: string;
}

/**
 * Repeated loading + error + frontmatter `<dl>` + markdown body + empty-state
 * block used by the desktop skills/plugins detail views. Class names and copy
 * match the previous desktop inline implementations exactly so tests/selectors
 * and visual diffs are unchanged.
 */
export function MarkdownFrontmatterContent({
  markdownOptions,
  loading,
  error,
  content,
  emptyText,
}: MarkdownFrontmatterContentProps): JSX.Element {
  const frontmatterEntries = content
    ? visibleFrontmatterEntries(content.frontmatter)
    : [];

  return (
    <>
      {loading && (
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner className="my-12" />
        </DelayedLoadingPlaceholder>
      )}
      <ErrorBanner errorSource="markdown-frontmatter" error={error} />
      {content && !loading && (
        <>
          <FrontmatterBlock
            frontmatter={content.frontmatter}
            className="mb-4"
          />
          {frontmatterEntries.length > 0 && content.body.trim() && (
            <hr className="mb-4" />
          )}
          {content.body.trim() && (
            <div className="prose prose-sm [--tw-prose-body:var(--fg-primary)] dark:prose-invert max-w-none break-words prose-p:my-0.5 prose-pre:my-1.5 prose-pre:bg-fg-primary/[0.06] prose-pre:fg-primary/80 prose-code:fg-success prose-code:before:content-none prose-code:after:content-none prose-headings:fg-primary prose-a:fg-accent prose-strong:fg-primary prose-li:my-0.5">
              <Markdown options={markdownOptions}>{content.body}</Markdown>
            </div>
          )}
          {!content.body.trim() && frontmatterEntries.length === 0 && (
            <p className="text-s fg-secondary text-center py-8">{emptyText}</p>
          )}
        </>
      )}
    </>
  );
}
