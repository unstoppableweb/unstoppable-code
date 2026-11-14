import { Stack } from './Stack';
import type { JSX } from 'react';
import { ErrorBanner } from './StatusBlocks';
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
  if (state.loading)
    return (
      <DelayedLoadingPlaceholder>
        <CenteredLoadingSpinner className="my-12" />
      </DelayedLoadingPlaceholder>
    );
  if (state.error)
    return <ErrorBanner errorSource="skill-file-preview" error={state.error} />;
  if (!state.data) return <></>;
  if (state.data.binary) {
    return (
      <p className="py-8 text-center text-s fg-secondary">
        This file is binary and cannot be previewed.
      </p>
    );
  }
  const markdown = /\.(md|mdx|markdown)$/i.test(filePath);
  return (
    <Stack gap="inline" data-testid="skill-file-preview" data-path={filePath}>
      {markdown ? (
        <SkillMarkdownBody markdown={state.data.content} />
      ) : (
        <pre className="overflow-x-auto rounded-lg bg-fg-primary/[0.06] px-3 py-2 text-xs leading-relaxed fg-primary/90 whitespace-pre-wrap break-words">
          {state.data.content}
        </pre>
      )}
      {state.data.truncated && (
        <p className="text-xs fg-secondary italic">
          This file is large; only the beginning is shown.
        </p>
      )}
    </Stack>
  );
}
