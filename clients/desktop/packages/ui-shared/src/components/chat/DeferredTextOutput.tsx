import { CodeBlock } from '../CodeBlock';
import { memo, useEffect, useRef, type JSX } from 'react';
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
  // Opening, closing and reaching the last page swap or disable the pressed
  // button, which drops keyboard focus to the page. After a press here, put
  // focus back on the controls, unless the user has moved it elsewhere.
  const controlsRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!restoreFocus.current || loading) return;
    restoreFocus.current = false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    controlsRef.current
      ?.querySelector<HTMLButtonElement>('button:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [opened, loading, hasPrevious, hasNext]);
  return (
    <div className="text-xs fg-secondary" data-testid="chat-deferred-output">
      {/* A host that already shows the bounded output passes an empty
          preview; only the controls render until the full output opens. */}
      {(opened || preview) && (
        <CodeBlock
          variant="row"
          size="inherit"
          wrap="all"
          tone="inherit"
          replay="block"
          className="max-h-75"
          data-testid="chat-tool-output-text"
        >
          {opened ? text : preview}
        </CodeBlock>
      )}
      <div
        ref={controlsRef}
        className="flex items-center gap-2 border-t px-2.5 py-1.5"
        data-testid="chat-deferred-output-controls"
        onClickCapture={(): void => {
          restoreFocus.current = true;
        }}
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
              // aria-disabled while a page loads keeps focus on the pressed button.
              disabled={!hasPrevious}
              aria-disabled={loading || undefined}
              onClick={onPrevious}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="compact"
              data-testid="chat-tool-output-next"
              // aria-disabled while a page loads keeps focus on the pressed button.
              disabled={!hasNext}
              aria-disabled={loading || undefined}
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
