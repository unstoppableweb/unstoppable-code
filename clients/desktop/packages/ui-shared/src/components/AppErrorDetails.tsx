'use client';

import type { JSX } from 'react';
import type { AppErrorPresentation } from '@canopy/protocol/app-errors';
import { REPLAY_BLOCK_CLASS } from '../lib/replay-privacy';
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
        <span
          className="font-mono"
          data-selectable
          data-testid={`${dataTestId}-reference`}
        >
          {referenceId}
        </span>
        <CopyButton
          value={referenceId}
          ariaLabel="Copy reference"
          title="Copy reference"
          dataTestId={`${dataTestId}-copy`}
        />
      </div>
      {rawDetail ? (
        <Disclosure label="Technical details" dataTestId={`${dataTestId}-raw`}>
          <pre
            className={`max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs fg-secondary ${REPLAY_BLOCK_CLASS}`}
            data-selectable
          >
            {[rawDetail.name, rawDetail.message, rawDetail.stack]
              .filter(Boolean)
              .join('\n')}
          </pre>
        </Disclosure>
      ) : null}
    </div>
  );
}
