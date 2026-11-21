import { type JSX } from 'react';

import { Markdown, type MarkdownProps } from './Markdown';
import { EmptyStateText, ErrorBanner } from './StatusBlocks';
import { CenteredLoadingSpinner } from './CenteredLoadingSpinner';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { DocumentProse } from './DocumentProse';
import { Divider } from './Surface';
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
  /** The raw failure text behind `error`, offered through `Copy details`. */
  readonly errorDetails?: string;
  /** Loaded content. `null` while loading or after an error. */
  readonly content: {
    readonly frontmatter: Record<string, FrontmatterValue>;
    readonly body: string;
  } | null;
  /** Text shown when both `frontmatter` is empty and `body.trim()` is empty. */
  readonly emptyText: string;
  /** Offered on the error banner as `Try again`. */
  readonly onRetry?: () => void;
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
  errorDetails,
  content,
  emptyText,
  onRetry,
}: MarkdownFrontmatterContentProps): JSX.Element {
  const frontmatterEntries = content
    ? visibleFrontmatterEntries(content.frontmatter)
    : [];

  return (
    <>
      {loading && (
        // A spinner, not a measured skeleton: the body's markdown shape is unknown until it loads.
        <DelayedLoadingPlaceholder>
          <CenteredLoadingSpinner spacing="section" />
        </DelayedLoadingPlaceholder>
      )}
      <ErrorBanner
        errorSource="markdown-frontmatter"
        error={error}
        {...(errorDetails ? { details: errorDetails } : {})}
        onRetry={onRetry}
      />
      {content && !loading && (
        <div className="flex flex-col gap-4">
          {frontmatterEntries.length > 0 && (
            <FrontmatterBlock frontmatter={content.frontmatter} />
          )}
          {frontmatterEntries.length > 0 && content.body.trim() && <Divider />}
          {content.body.trim() && (
            <DocumentProse variant="archive">
              <Markdown options={markdownOptions}>{content.body}</Markdown>
            </DocumentProse>
          )}
          {!content.body.trim() && frontmatterEntries.length === 0 && (
            <p className="py-8 text-center text-s">
              <EmptyStateText title={emptyText} tone="secondary" />
            </p>
          )}
        </div>
      )}
    </>
  );
}
