import type { JSX } from 'react';
import { CodeBlock } from '@canopy/ui-shared/components';

interface InlinePipelineYamlPreviewProps {
  rawPipeline: string;
  testId: string;
  /** The taller cap, for a modal whose main content is the YAML. */
  tall?: boolean;
}

/** Shared read-only YAML treatment for automation install and review flows. */
export function InlinePipelineYamlPreview({
  rawPipeline,
  testId,
  tall = false,
}: InlinePipelineYamlPreviewProps): JSX.Element {
  return (
    <CodeBlock
      data-testid={testId}
      variant="tint"
      wrap="none"
      tone="primary"
      className={tall ? 'max-h-80' : 'max-h-56'}
    >
      {rawPipeline}
    </CodeBlock>
  );
}
