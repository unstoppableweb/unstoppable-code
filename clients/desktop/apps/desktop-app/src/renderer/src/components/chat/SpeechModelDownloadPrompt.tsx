import type { JSX } from 'react';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

export interface SpeechModelDownloadPromptProps {
  /** The download's size, such as "269 MB"; null when it couldn't be read. */
  readonly size: string | null;
  readonly onDownload: () => void;
  readonly onNotNow: () => void;
  /** Home's notice row is pointer-transparent; its notices opt back in. */
  readonly className?: string;
}

/**
 * The composer's offer of the Linux speech model download (CAN-7341), shown
 * when the mic finds no model. It only offers: either choice closes it, and
 * Settings → Dictation shows the download's progress.
 */
export function SpeechModelDownloadPrompt({
  size,
  onDownload,
  onNotNow,
  className,
}: SpeechModelDownloadPromptProps): JSX.Element {
  return (
    <Notice
      data-testid="speech-model-prompt"
      {...(className === undefined ? {} : { className })}
      actions={
        <>
          <NoticeButton
            variant="secondary"
            onClick={onNotNow}
            data-testid="speech-model-prompt-not-now"
          >
            Not now
          </NoticeButton>
          <NoticeButton
            variant="primary"
            onClick={onDownload}
            data-testid="speech-model-prompt-download"
          >
            Download
          </NoticeButton>
        </>
      }
    >
      {/* "269 MB" keeps the space by the ticket owner's decision
          (CAN-7341, 2026-11-19), for consistency with Settings → Dictation:
          an exception to the units rule in docs/ux-writing/numbers-and-time.md. */}
      {size === null
        ? 'Dictation needs a one-time speech model download.'
        : `Dictation needs a one-time ${size} speech model download.`}
    </Notice>
  );
}
