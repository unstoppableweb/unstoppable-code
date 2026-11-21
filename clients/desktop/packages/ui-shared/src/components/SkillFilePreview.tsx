import { CodeBlock } from './CodeBlock';
import { Stack } from './Stack';
import type { JSX } from 'react';
import { EmptyStateText, ErrorBanner } from './StatusBlocks';
import { CenteredLoadingSpinner } from './CenteredLoadingSpinner';
import { DelayedLoadingPlaceholder } from './DelayedLoadingPlaceholder';
import { SkillMarkdownBody } from './SkillFileExplorer';

export interface SkillFilePreviewContent {
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface SkillFileViewState {
  loading: boolean;
  error: string;
  data: SkillFilePreviewContent | null;
}

export interface SkillFilePreviewProps {
  filePath: string;
  state: SkillFileViewState;
}

export function SkillFilePreview({
  filePath,
  state,
}: SkillFilePreviewProps): JSX.Element {
  // A spinner, not a measured skeleton: the file's kind and length are unknown until it loads.
  if (state.loading)
    return (
      <DelayedLoadingPlaceholder>
        <CenteredLoadingSpinner spacing="section" />
      </DelayedLoadingPlaceholder>
    );
  if (state.error)
    return <ErrorBanner errorSource="skill-file-preview" error={state.error} />;
  if (!state.data) return <></>;
  if (state.data.binary) {
    return (
      <p className="py-8 text-center text-s">
        <EmptyStateText
          title="This file is binary and cannot be previewed."
          tone="secondary"
        />
      </p>
    );
  }
  const markdown = /\.(md|mdx|markdown)$/i.test(filePath);
  return (
    <Stack gap="inline" data-testid="skill-file-preview" data-path={filePath}>
      {markdown ? (
        <SkillMarkdownBody markdown={state.data.content} />
      ) : (
        <CodeBlock
          variant="output-preview"
          size="xs"
          wrap="words"
          tone="muted-primary"
          replay="inherit"
          overflow="horizontal"
          proseLeading
        >
          {state.data.content}
        </CodeBlock>
      )}
      {state.data.truncated && (
        <p className="text-xs fg-secondary italic">
          This file is large; only the beginning is shown.
        </p>
      )}
    </Stack>
  );
}
