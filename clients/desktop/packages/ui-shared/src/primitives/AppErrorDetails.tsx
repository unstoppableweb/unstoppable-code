'use client';

import { CodeBlock } from './CodeBlock';
import type { JSX } from 'react';
import type { AppErrorPresentation } from '@canopy/protocol/app-errors';
import { CopyButton } from './CopyButton';
import { Disclosure } from './Disclosure';

export interface AppErrorDetailsProps {
  readonly presentation: Pick<
    AppErrorPresentation,
    'referenceId' | 'rawDetail'
  >;
  readonly dataTestId?: string;
  /** Placement only. */
  readonly className?: string;
}

/**
 * The lookup facts of a failure: its reference ID with a copy control, and the
 * raw detail only when the presentation permits it. The surface shows the
 * error's copy itself; a build that hides raw detail omits it from the
 * presentation, so nothing here decides who may see a stack.
 */
export function AppErrorDetails({
  presentation,
  dataTestId = 'app-error-details',
  className,
}: AppErrorDetailsProps): JSX.Element {
  const { referenceId, rawDetail } = presentation;
  return (
    <div
      className={`flex min-w-0 flex-col gap-2${className ? ` ${className}` : ''}`}
      data-testid={dataTestId}
    >
      <div className="flex items-center gap-2 text-xs fg-secondary">
        <span>Reference</span>
        {/* The copy control sits right against the ID: its quiet 12px glyph
            and the capsule's own padding are the only space between them. */}
        <span className="flex items-center">
          <span
            className="font-mono"
            data-selectable
            data-testid={`${dataTestId}-reference`}
          >
            {referenceId}
          </span>
          <CopyButton
            value={referenceId}
            variant="ghost"
            glyphSize="xs"
            ariaLabel="Copy reference"
            title="Copy reference"
            dataTestId={`${dataTestId}-copy`}
          />
        </span>
      </div>
      {rawDetail ? (
        <Disclosure label="Technical details" dataTestId={`${dataTestId}-raw`}>
          <CodeBlock
            variant="bare"
            size="xs"
            wrap="words"
            tone="secondary"
            replay="block"
            className="max-h-64"
            data-selectable
          >
            {[rawDetail.name, rawDetail.message, rawDetail.stack]
              .filter(Boolean)
              .join('\n')}
          </CodeBlock>
        </Disclosure>
      ) : null}
    </div>
  );
}
