import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
} from 'react';
import type { BrowserJavaScriptDialog } from '@canopy/execution-engine/types/browser';
import { Button } from '@/components/shared/Button';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import {
  DialogModal,
  ErrorBanner,
  TextInput,
} from '@canopy/ui-shared/components';

interface BrowserJavaScriptDialogModalProps {
  browserId: string;
  dialog: BrowserJavaScriptDialog;
}

function dialogOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? parsed.href : parsed.origin;
  } catch {
    return url;
  }
}

function primaryLabel(dialog: BrowserJavaScriptDialog): string {
  if (dialog.type === 'beforeunload') {
    return 'Leave';
  }
  return 'OK';
}

/**
 * App-owned JavaScript-dialog UI for the embedded browser.
 *
 * The main process deliberately leaves Chromium's synchronous dialog callback
 * unresolved while this asynchronous React surface is open. The overlay
 * marker also activates BrowserPane's screenshot-then-hide path so Electron's
 * native WebContentsView cannot paint over the modal.
 */
export function BrowserJavaScriptDialogModal({
  browserId,
  dialog,
}: BrowserJavaScriptDialogModalProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null);
  const [promptText, setPromptText] = useState(dialog.defaultPrompt ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPromptText(dialog.defaultPrompt ?? '');
    setSubmitting(false);
    setError(null);
    const frameId = requestAnimationFrame(() => {
      if (dialog.type === 'prompt') {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        primaryButtonRef.current?.focus();
      }
    });
    return (): void => cancelAnimationFrame(frameId);
  }, [dialog]);

  const respond = useCallback(
    async (accept: boolean): Promise<void> => {
      if (submitting) {
        return;
      }
      setSubmitting(true);
      setError(null);
      try {
        await window.api.browser.handleDialog({
          browserId,
          dialogId: dialog.id,
          accept,
          ...(dialog.type === 'prompt' && accept ? { promptText } : {}),
        });
      } catch (responseError) {
        setError(
          responseError instanceof Error
            ? responseError.message
            : 'Unable to respond to the page dialog.',
        );
        setSubmitting(false);
      }
    },
    [browserId, dialog.id, dialog.type, promptText, submitting],
  );

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void respond(true);
  };

  const cancelLabel = dialog.type === 'beforeunload' ? 'Stay' : 'Cancel';
  const showCancel = dialog.type !== 'alert';
  const message =
    dialog.message ||
    (dialog.type === 'beforeunload'
      ? 'Changes you made may not be saved.'
      : '');

  const formId = `browser-dialog-form-${dialog.id}`;
  // The shared dialog over the browser pane only: Escape answers it as
  // Cancel (OK for an alert), the scrim does not, and focus stays inside.
  return (
    <DialogModal
      containment="parent"
      title={<span title={dialog.url}>{dialogOrigin(dialog.url)}</span>}
      titleId={`browser-dialog-title-${dialog.id}`}
      onClose={(): void => void respond(dialog.type === 'alert')}
      closeOnBackdrop={false}
      closeOnEscape={!submitting}
      showCloseButton={false}
      maxWidth="md"
      trapFocus
      initialFocusRef={dialog.type === 'prompt' ? inputRef : primaryButtonRef}
      dataTestId="browser-javascript-dialog"
      ariaDescribedBy={`browser-dialog-message-${dialog.id}`}
      overlayDataTestId="browser-javascript-dialog-backdrop"
      footer={
        <>
          {showCancel && (
            <Button
              type="button"
              variant="secondary"
              disabled={submitting}
              onClick={(): void => void respond(false)}
            >
              {cancelLabel}
            </Button>
          )}
          <Button
            ref={primaryButtonRef}
            type="submit"
            form={formId}
            variant="primary"
            disabled={submitting}
          >
            {primaryLabel(dialog)}
          </Button>
        </>
      }
    >
      <form id={formId} className="flex flex-col gap-4" onSubmit={handleSubmit}>
        {/* The page writes this message, so it is blocked like the page. */}
        <p
          id={`browser-dialog-message-${dialog.id}`}
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap break-words text-s fg-primary`}
        >
          {message}
        </p>
        {dialog.type === 'prompt' && (
          <TextInput
            ref={inputRef}
            type="text"
            value={promptText}
            disabled={submitting}
            aria-label="Response"
            onChange={(event): void => setPromptText(event.target.value)}
          />
        )}
        <ErrorBanner
          errorSource="browser-java-script-dialog-modal"
          error={error}
          className=""
        />
      </form>
    </DialogModal>
  );
}
