import { requestBrowserSessionDestruction } from '@/lib/panels/browser-panel-sync';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useEffect, useRef, useState, type JSX } from 'react';
import { MCP_OAUTH_BROWSER_SCOPE } from '@canopy/execution-engine/types/browser';
import { Button, Notice } from '@canopy/ui-shared';
import {
  CenteredLoadingSpinner,
  DelayedLoadingPlaceholder,
} from '@canopy/ui-shared/components';
import { BrowserPane } from '@/components/browser/BrowserPane';
import { ensureBrowserEventSubscription } from '@/stores/browserEventSubscription';
import { useBrowserStore } from '@/stores/browserStore';
import { useTryItSetupPaneStore } from '@/stores/tryItSetupPaneStore';
import { Heading } from '@canopy/ui-shared/components';

/**
 * Transient native browser beside the marketplace, with external fallback.
 * A Try it chat reuses it beside the chat (CAN-4451) with its own title, and
 * without URL-based external opening: its page is single-use.
 */
interface McpOAuthBrowserProps {
  url: string;
  owner?: object;
  onClose: () => void;
  title?: string;
  /** Defaults to true; false hides the native view without destroying it. */
  visible?: boolean;
  /** Offers Open in browser for this URL. Defaults to true. */
  allowExternalOpen?: boolean;
  /** Runs once when the native browser can't be created. */
  onError?: () => void;
  /** Moves focus into the pane on open and closes it on Escape. */
  focusOnOpen?: boolean;
  testId?: string;
  className?: string;
}

export function McpOAuthBrowser({
  url,
  owner: reservedOwner,
  onClose,
  title = 'Sign in to connect',
  visible = true,
  allowExternalOpen = true,
  onError,
  focusOnOpen = false,
  testId = 'plugin-oauth-browser',
  className = 'flex min-h-120 min-w-0 flex-col border-l pl-5',
}: McpOAuthBrowserProps): JSX.Element {
  const [browserId, setBrowserId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!focusOnOpen) return;
    const previous = document.activeElement;
    closeRef.current?.focus();
    return (): void => {
      requestAnimationFrame(() => {
        if (previous instanceof HTMLElement && previous.isConnected)
          previous.focus();
        else
          document
            .querySelector<HTMLButtonElement>(
              '[data-testid="try-it-sign-in-notice-retry"], [data-testid="try-it-sign-in-notice-authorize"]',
            )
            ?.focus();
      });
    };
  }, [focusOnOpen]);
  useEffect(() => {
    const owner = reservedOwner ?? {};
    if (!useTryItSetupPaneStore.getState().reserve(owner)) {
      setError(
        'Another connection is using the sign-in panel. Finish or close it, then retry.',
      );
      onErrorRef.current?.();
      return;
    }
    let disposed = false;
    let createdId: string | undefined;
    const { projectId, worktreeId } = MCP_OAUTH_BROWSER_SCOPE;
    const destroy = (id: string): void => {
      requestBrowserSessionDestruction(projectId, worktreeId, id);
    };
    ensureBrowserEventSubscription();
    void useBrowserStore
      .getState()
      .createBrowser(projectId, worktreeId, { url })
      .then((snapshot) => {
        createdId = snapshot.id;
        if (disposed) destroy(snapshot.id);
        else setBrowserId(snapshot.id);
      })
      .catch(() => {
        if (disposed) return;
        setError(
          allowExternalOpen
            ? 'Unable to open the sign-in panel. Open it in your browser to continue.'
            : 'Unable to open the sign-in panel.',
        );
        onErrorRef.current?.();
      });
    return (): void => {
      disposed = true;
      if (!reservedOwner) useTryItSetupPaneStore.getState().release(owner);
      if (createdId) destroy(createdId);
    };
  }, [url, allowExternalOpen, reservedOwner]);
  useCurrentUiStateReporter('plugins.oauthPanel', {
    open: true,
    loading: !browserId && !error,
    errorVisible: Boolean(error),
  });
  return (
    <aside
      data-testid={testId}
      aria-label={allowExternalOpen ? 'Connect account' : title}
      className={`flex flex-col gap-3 ${className ?? ''}`}
      onKeyDown={
        focusOnOpen
          ? (event): void => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                onClose();
              }
            }
          : undefined
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading level={3} variant="title">
          {title}
        </Heading>
        <div className="flex items-center gap-2">
          {allowExternalOpen && (
            <Button
              variant="secondary"
              onClick={() => void window.api.browser.openExternal({ url })}
            >
              Open in browser
            </Button>
          )}
          <Button
            ref={closeRef}
            variant="secondary"
            onClick={onClose}
            data-testid={`${testId}-close`}
          >
            Close
          </Button>
        </div>
      </div>
      {allowExternalOpen && (
        <p className="text-xs fg-secondary">
          If this service requires your usual browser, choose Open in browser.
        </p>
      )}
      {error ? (
        <Notice errorSource="mcp-o-auth-browser" intent="destructive">
          {error}
        </Notice>
      ) : browserId ? (
        <div className="flex min-h-100 flex-1 flex-col">
          <BrowserPane
            {...MCP_OAUTH_BROWSER_SCOPE}
            browserId={browserId}
            visible={visible}
          />
        </div>
      ) : (
        <div className="py-8">
          <DelayedLoadingPlaceholder slowNote="Still opening sign-in…">
            {/* The native sign-in browser has no DOM content to measure here. */}
            <CenteredLoadingSpinner />
          </DelayedLoadingPlaceholder>
        </div>
      )}
    </aside>
  );
}
