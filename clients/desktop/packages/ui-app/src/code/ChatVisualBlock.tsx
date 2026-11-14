'use client';

import { memo, useCallback, useEffect, useState, type JSX } from 'react';
import { useCapabilities } from '@canopy/app-state';
import {
  AgentVisualFrame,
  ErrorBanner,
  useAgentVisualHostTheme,
} from '@canopy/ui-shared/components';
import { pickAgentVisualHeightHint } from '@canopy/ui-shared/lib';
import {
  CHAT_VISUAL_TEST_IDS,
  useChatVisualHost,
  type ChatVisualHost,
  type ChatVisualOwner,
} from './chat-visual-host';
import {
  chatVisualDocumentCache,
  chatVisualOwnerKey,
} from './chat-visual-reader';
import { saveChatVisualAsHtml } from './chat-visual-save';
import { ChatVisualDialog } from './ChatVisualDialog';

export interface ChatVisualBlockProps {
  owner: ChatVisualOwner;
  /**
   * `inline` and `visual-only` are the transcript's two placements; `panel`
   * is an entry in the Chat visuals panel, which has nothing to expand to.
   */
  variant: 'inline' | 'visual-only' | 'panel';
}

export function useChatVisualDocument(
  owner: ChatVisualOwner,
  host: ChatVisualHost | null,
  enabled: boolean,
): { document: string | undefined; error: boolean; loading: boolean } {
  const [document, setDocument] = useState<string>();
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(enabled);
  const { messageId, toolUseId, reference } = owner;
  useEffect(() => {
    if (!enabled || host === null) return;
    const controller = new AbortController();
    const requestOwner: ChatVisualOwner = { messageId, toolUseId, reference };
    setDocument(undefined);
    setError(false);
    setLoading(true);
    void chatVisualDocumentCache
      .load(
        host,
        requestOwner,
        (currentOwner, signal) => host.read(currentOwner, signal),
        async (currentOwner, signal): Promise<void> => {
          await host.read(currentOwner, signal);
        },
        controller.signal,
      )
      .then((loaded): void => {
        if (!controller.signal.aborted) setDocument(loaded);
      })
      .catch((): void => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally((): void => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return (): void => controller.abort();
  }, [enabled, host, messageId, toolUseId, reference]);
  return { document, error, loading };
}

/**
 * The first owner seen for its content. Hosts that parse the reference from a
 * part on every render pass an equal owner as a new object, which must not
 * restart the read or close an open dialog.
 */
function useStableOwner(owner: ChatVisualOwner): ChatVisualOwner {
  const key = chatVisualOwnerKey(owner);
  const [stable, setStable] = useState({ key, owner });
  if (stable.key !== key) {
    setStable({ key, owner });
    return owner;
  }
  return stable.owner;
}

/** How far outside the viewport a visual starts loading. */
const VISUAL_LOAD_MARGIN = '1200px';

/** True once the element has come within the load margin of the viewport. */
function useNearViewport(element: HTMLElement | null): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (near || !element) return;
    const view = element.ownerDocument.defaultView;
    if (!view || typeof view.IntersectionObserver !== 'function') {
      setNear(true);
      return;
    }
    const observer = new view.IntersectionObserver(
      (entries): void => {
        if (entries.some((entry) => entry.isIntersecting)) setNear(true);
      },
      { rootMargin: VISUAL_LOAD_MARGIN },
    );
    observer.observe(element);
    return (): void => observer.disconnect();
  }, [element, near]);
  return near;
}

function ChatVisualBlockContent({
  owner: ownerProp,
  variant,
}: ChatVisualBlockProps): JSX.Element | null {
  const owner = useStableOwner(ownerProp);
  const capabilities = useCapabilities();
  const host = useChatVisualHost();
  const enabled = capabilities.chatVisuals === true && host !== null;
  const [block, setBlock] = useState<HTMLDivElement | null>(null);
  // Collapsed turns keep their visuals mounted, so a long chat would otherwise
  // read every artifact on open.
  const near = useNearViewport(block);
  const { document, error, loading } = useChatVisualDocument(
    owner,
    host,
    enabled && near,
  );
  const theme = useAgentVisualHostTheme();
  const [expanded, setExpanded] = useState(false);
  const onOpenLink = useCallback(
    (url: string): void => host?.openLink(url),
    [host],
  );
  // The host's panel when it has one for this chat; otherwise the dialog,
  // including when a panel the host meant to place could not be placed.
  const onExpand = useCallback((): void => {
    const opened = host?.expand?.(owner);
    if (opened === true) return;
    if (opened === undefined || opened === false) {
      setExpanded(true);
      return;
    }
    void opened.then(
      (placed): void => {
        if (!placed) setExpanded(true);
      },
      (): void => setExpanded(true),
    );
  }, [host, owner]);
  const onClose = useCallback((): void => setExpanded(false), []);
  const title = owner.reference.title;
  const ownerDocument = block?.ownerDocument;
  const onSave = useCallback((): void => {
    if (document === undefined) return;
    saveChatVisualAsHtml({ document, theme, title, ownerDocument });
  }, [document, theme, title, ownerDocument]);
  if (!enabled) return null;
  return (
    <div
      ref={setBlock}
      data-testid={CHAT_VISUAL_TEST_IDS.block}
      data-variant={variant}
    >
      {document === undefined && !error ? (
        // Holds the frame's initial height so the transcript does not jump.
        <div
          className="flex items-center justify-center"
          style={{
            height: pickAgentVisualHeightHint(
              owner.reference.heights,
              block?.clientWidth,
              owner.reference.maxHeight,
            ),
          }}
        >
          {loading ? (
            <p role="status" className="text-xs fg-secondary">
              Loading visual…
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <ErrorBanner
          errorSource="chat-visual-block"
          className=""
          testId={CHAT_VISUAL_TEST_IDS.errorState}
          error="Couldn't load this visual. Try again later."
        />
      ) : null}
      {document !== undefined && document.length === 0 ? (
        <p
          data-testid={CHAT_VISUAL_TEST_IDS.unavailableState}
          className="text-xs fg-secondary"
        >
          This visual is empty.
        </p>
      ) : null}
      {document ? (
        <AgentVisualFrame
          document={document}
          title={owner.reference.title}
          maxHeight={owner.reference.maxHeight}
          heights={owner.reference.heights}
          theme={theme}
          onOpenLink={onOpenLink}
          onExpand={variant === 'panel' ? undefined : onExpand}
          onSave={onSave}
          variant="inline"
          // The user opened the panel to look at these visuals, so they take a
          // live frame before visuals in the transcript.
          prioritized={variant === 'panel'}
          frameUrl={host.frameUrl}
          testIds={CHAT_VISUAL_TEST_IDS}
        />
      ) : null}
      {expanded && document !== undefined ? (
        <ChatVisualDialog
          owner={owner}
          document={document}
          host={host}
          theme={theme}
          initialTab="visual"
          ownerDocument={block?.ownerDocument}
          onClose={onClose}
        />
      ) : null}
    </div>
  );
}

export const ChatVisualBlock = memo(ChatVisualBlockContent);
