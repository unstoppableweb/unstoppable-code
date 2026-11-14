import { memo, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { Button } from '../Button';
import { LoadingSpinner } from '../LoadingSpinner';
import { Notice, NoticeButton } from '../Notice';
import { TRY_AGAIN_LABEL } from '../useRetry';

interface DeferredTextOutputProps {
  preview: string;
  text?: string;
  loading: boolean;
  error?: string;
  opened: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onOpen: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
  onClose: () => void;
  /** Field-specific copy; tool output keeps the defaults. */
  openLabel?: string;
  loadingLabel?: string;
}

/** Host-owned reads keep this shared viewer independent of disk/network APIs. */
export const DeferredTextOutput = memo(function DeferredTextOutput({
  preview,
  text,
  loading,
  error,
  opened,
  hasPrevious,
  hasNext,
  onOpen,
  onPrevious,
  onNext,
  onRetry,
  onClose,
  openLabel = 'View full output',
  loadingLabel = 'Loading output…',
}: DeferredTextOutputProps): JSX.Element {
  return (
    <div className="text-xs fg-secondary" data-testid="chat-deferred-output">
      {/* A host that already shows the bounded output passes an empty
          preview; only the controls render until the full output opens. */}
      {(opened || preview) && (
        <pre
          className={`max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 ${REPLAY_BLOCK_CLASS}`}
          data-testid="chat-tool-output-text"
        >
          {opened ? text : preview}
        </pre>
      )}
      <div
        className="flex items-center gap-2 px-2.5 py-1.5 ring-1 ring-inset ring-line-base"
        data-testid="chat-deferred-output-controls"
      >
        {!opened ? (
          <Button
            variant="ghost"
            size="compact"
            data-testid="chat-tool-output-open"
            onClick={onOpen}
          >
            {openLabel}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-previous"
              disabled={loading || !hasPrevious}
              onClick={onPrevious}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-next"
              disabled={loading || !hasNext}
              onClick={onNext}
            >
              Next
            </Button>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-close"
              onClick={onClose}
            >
              Show preview
            </Button>
          </>
        )}
        {loading && (
          <span className="inline-flex items-center gap-2" role="status">
            <LoadingSpinner
              decorative
              dataTestId="chat-output-loading-spinner"
            />
            {loadingLabel}
          </span>
        )}
      </div>
      {error && (
        // The output's 10px side inset, as the text and controls use.
        <div className="px-2.5 py-2">
          <Notice
            errorSource="deferred-text-output"
            intent="destructive"
            liveRegionScope="content"
            actions={
              <NoticeButton
                data-testid="chat-tool-output-retry"
                onClick={onRetry}
              >
                {TRY_AGAIN_LABEL}
              </NoticeButton>
            }
          >
            {error}
          </Notice>
        </div>
      )}
    </div>
  );
});
