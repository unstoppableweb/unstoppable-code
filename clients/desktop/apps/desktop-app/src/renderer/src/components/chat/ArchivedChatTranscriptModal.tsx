import {
  Surface,
  Button,
  TranscriptPagingControls,
} from '@canopy/ui-shared/components';
import {
  installTranscriptPage,
  TRANSCRIPT_PAGE_LOAD_ERROR,
} from '@/stores/chat/transcript-pages';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import type {
  ArchivedChatSummary,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { useTeamOrgShareEntryVisible } from '@/lib/share-targets';
import { DialogModal } from '@canopy/ui-shared/components';
import { ModelProviderIcon } from '@canopy/ui-shared/components';
import { getArchivedChatDisplayLabel } from '@/components/standalone-chat/chat-label';
import { SummaryIcon, UnarchiveIcon } from '@canopy/ui-shared/icons/AppIcons';
import { useTranscriptSearch } from '@/hooks/useTranscriptSearch';
import { SearchBar } from '../shared/search/SearchBar';
import { ChatMessageList } from './ChatMessageList';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { ShareIcon } from '@canopy/ui-shared/icons';
import { useActivityStore } from '@/stores/activityStore';
import {
  ShareRunModal,
  type ShareRunShareRequest,
} from '@/components/shared/ShareRunModal';
import type {
  ShareRunEligibilityResponse,
  ShareRunResponse,
} from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_MASK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

export interface ArchivedChatTranscriptModalProps {
  projectId: string;
  worktreeId: string;
  /** The archived chat being viewed (drives the header + action eligibility). */
  summary: ArchivedChatSummary;
  /** Restore the archived chat into the live tabs. */
  onRestore: () => void;
  /** Summarize the archived chat into a fresh tab draft. */
  onSummarize: () => void;
  /** True while this chat's Restore request is in flight. */
  restoring: boolean;
  /** True while this chat's Summarize request is in flight. */
  summarizing: boolean;
  /** Close the viewer (the parent decides whether to return to the list modal). */
  onClose: () => void;
  /**
   * Skip the open animation when the viewer mounts on top of an already-visible
   * backdrop (i.e. it was opened from the archive list modal), avoiding a flash.
   */
  noEnterAnimation?: boolean;
}

const transcriptLoadRetryDelaysMs = [0, 150, 400, 900];

/**
 * Read-only transcript viewer for a single archived chat. Loads the full tab
 * snapshot via `readArchive`, renders its transcript with the same
 * {@link ChatMessageList} used by live chats (all interactive handlers omitted,
 * branch actions hidden), and offers the same Restore / Summarize actions plus
 * a Cmd+F search box that mirrors the in-chat search behaviour.
 */
export function ArchivedChatTranscriptModal({
  projectId,
  worktreeId,
  summary,
  onRestore,
  onSummarize,
  restoring,
  summarizing,
  onClose,
  noEnterAnimation = false,
}: ArchivedChatTranscriptModalProps): JSX.Element {
  const [tab, setTab] = useState<PersistedChatTab | null>(null);
  const tabRef = useRef<PersistedChatTab | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [shareRunOpen, setShareRunOpen] = useState(false);
  const shareEntryVisible = useTeamOrgShareEntryVisible(
    tab?.sharedRun !== undefined && tab.sharedRun.shareScope !== 'private',
  );

  const shareRun = useActivityStore((s) => s.shareRun);
  const checkShareEligibility = useActivityStore(
    (s) => s.checkShareEligibility,
  );
  const handleShareRunSubmit = useCallback(
    async (request: ShareRunShareRequest): Promise<ShareRunResponse> => {
      return shareRun(projectId, worktreeId, summary.chatId, {
        shareScope: request.shareScope,
        ...(request.teamId ? { teamId: request.teamId } : {}),
        ...(request.organizationId
          ? { organizationId: request.organizationId }
          : {}),
      });
    },
    [shareRun, projectId, worktreeId, summary.chatId],
  );

  const handleShareRunEligibility =
    useCallback((): Promise<ShareRunEligibilityResponse> => {
      return checkShareEligibility(projectId, worktreeId, summary.chatId);
    }, [checkShareEligibility, projectId, worktreeId, summary.chatId]);

  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load the recent archived transcript page on open. `readArchive` is
  // non-destructive, so viewing never removes the archive entry.
  useEffect(() => {
    let cancelled = false;
    tabRef.current = null;
    setTab(null);
    setLoadFailed(false);

    const sleep = (delayMs: number): Promise<void> =>
      new Promise((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    void (async (): Promise<void> => {
      let lastError: unknown = null;
      for (const delayMs of transcriptLoadRetryDelaysMs) {
        if (delayMs > 0) {
          await sleep(delayMs);
        }
        if (cancelled) return;
        try {
          const response = await window.api.chat.readArchive({
            projectId,
            worktreeId,
            chatId: summary.chatId,
          });
          if (cancelled) return;
          tabRef.current = response.tab;
          setTab(response.tab);
          return;
        } catch (error: unknown) {
          lastError = error;
        }
      }

      if (!cancelled) {
        // eslint-disable-next-line no-console
        console.error('Failed to load archived chat transcript', lastError);
        setLoadFailed(true);
      }
    })();

    return (): void => {
      cancelled = true;
    };
  }, [projectId, worktreeId, summary.chatId]);

  const [pageLoading, setPageLoading] = useState(false);
  const pageInFlight = useRef(false);
  const [turnPageId, setTurnPageId] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const pageRequest = useRef(0);
  useEffect(() => {
    pageRequest.current += 1;
    pageInFlight.current = false;
    setTurnPageId(null);
    setPageLoading(false);
    setPageError(null);
    return (): void => {
      pageRequest.current += 1;
    };
  }, [projectId, worktreeId, summary.chatId]);
  // Memoized so the transcript rows (memoized on their `onLoadHistory` prop)
  // keep a stable callback across unrelated modal re-renders.
  const loadPage = useCallback(
    async (older: boolean, turnId?: string): Promise<void> => {
      const initial = tabRef.current;
      if (!initial) return;
      // A turn outside the loaded window walks the global history cursor.
      const knownTurn = turnId
        ? initial.transcriptWindow?.turns?.find((turn) => turn.id === turnId)
        : undefined;
      const before = knownTurn
        ? knownTurn.before
        : initial.transcriptWindow?.before;
      if (older && before === undefined) return;
      if (pageInFlight.current) return;
      pageInFlight.current = true;
      const token = ++pageRequest.current;
      const previous = initial;
      setTurnPageId(turnId ?? null);
      setPageLoading(true);
      setPageError(null);
      try {
        const page = await window.api.chat.getTranscriptPage({
          view: 'turns',
          ...(knownTurn ? { turnId } : {}),
          projectId,
          worktreeId,
          chatId: summary.chatId,
          ...(older
            ? {
                before,
                transcriptRevision:
                  initial.transcriptWindow?.transcriptRevision,
              }
            : {}),
        });
        if (pageRequest.current === token && tabRef.current === previous) {
          const next = installTranscriptPage(previous, page, older);
          tabRef.current = next;
          setTab(next);
        }
      } catch {
        if (pageRequest.current === token)
          setPageError(TRANSCRIPT_PAGE_LOAD_ERROR);
      } finally {
        if (pageRequest.current === token) {
          pageInFlight.current = false;
          setPageLoading(false);
        }
      }
    },
    [projectId, worktreeId, summary.chatId],
  );
  const loadTurn = useCallback(
    (id: string): Promise<void> => loadPage(true, id),
    [loadPage],
  );
  const searchPageSource = useMemo(
    () => ({
      currentTab: (): PersistedChatTab | null => tabRef.current,
      loadPage,
    }),
    [loadPage],
  );
  const search = useTranscriptSearch(
    tab ? { projectId, worktreeId, chatId: summary.chatId } : null,
    tab?.transcript?.transcriptRevision ??
      tab?.transcriptWindow?.transcriptRevision,
    transcriptContainerRef,
    searchPageSource,
  );

  // The search bar is always present; Cmd+F just focuses it. Registered in the
  // capture phase with `stopPropagation` so the underlying ChatPanel's
  // document-level Cmd+F handler does not also fire while this modal is open
  // (mirrors the modal-search convention noted in ChatPanel).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, { capture: true });
    return (): void => {
      document.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);

  const busy = restoring || summarizing;
  const turnLabel = `${summary.turnCount} ${
    summary.turnCount === 1 ? 'turn' : 'turns'
  }`;
  // Same precedence as the list rows: the generated title wins and the raw
  // `title` is dropped, so the header matches the row the user just clicked.
  const label = getArchivedChatDisplayLabel(summary);

  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      noEnterAnimation={noEnterAnimation}
      maxWidth="3xl"
      maxHeight="85vh"
      // ChatMessageList fills its parent via `position: absolute` and
      // contributes no intrinsic height, so the dialog card needs a *definite*
      // height (not just max-height) for the flex-1 transcript area to size.
      // Without this the body collapses to 0 and only the header renders.
      height="85vh"
      dataTestId="archived-chat-transcript-modal"
      title={
        <span className="flex min-w-0 items-center gap-2">
          {summary.providerType && (
            <ModelProviderIcon
              provider={summary.providerType}
              size="md"
              className="shrink-0 fg-secondary"
            />
          )}
          <span
            className={`${POSTHOG_REPLAY_MASK_CLASS} truncate`}
            title={label}
          >
            {label}
          </span>
        </span>
      }
      subtitle={turnLabel}
      headerActions={
        <>
          {summary.restorable && (
            <Button
              variant="primary"
              size="compact"
              onClick={onRestore}
              disabled={busy}
              data-testid="archived-chat-transcript-restore"
            >
              {restoring ? <LoadingSpinner /> : <UnarchiveIcon size="md" />}
              <span>Restore</span>
            </Button>
          )}
          <Button
            size="compact"
            onClick={onSummarize}
            disabled={busy}
            data-testid="archived-chat-transcript-summarize"
          >
            {summarizing ? <LoadingSpinner /> : <SummaryIcon size="md" />}
            <span>Summarize</span>
          </Button>
          {shareEntryVisible ? (
            <Button
              size="compact"
              onClick={(): void => setShareRunOpen(true)}
              disabled={busy}
              data-testid="archived-chat-transcript-share-run"
            >
              <ShareIcon size="sm" />
              <span>Share session</span>
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <Surface
          variant="section"
          boundary="bottom"
          padding="section-default"
          className="shrink-0"
        >
          <SearchBar
            query={search.query}
            onQueryChange={search.setQuery}
            currentIndex={search.currentIndex}
            totalCount={search.totalCount}
            onNext={search.goToNext}
            onPrevious={search.goToPrevious}
            inputRef={searchInputRef}
          />
          {search.error && (
            <p className="text-xs">
              <Button variant="link" onClick={search.refresh}>
                {search.error}
              </Button>
            </p>
          )}
        </Surface>

        {tab ? (
          <ChatMessageList
            canonicalSearch
            searchSelection={search.selection}
            pagingControls={
              <TranscriptPagingControls
                needsLoad={Boolean(
                  tab?.transcript && tab.transcriptWindow?.view !== 'turns',
                )}
                loading={pageLoading && turnPageId === null}
                suspended={pageLoading}
                error={turnPageId === null ? pageError : null}
                hasEarlier={tab?.transcriptWindow?.before !== undefined}
                onReload={() => {
                  void loadPage(false);
                }}
                onLoadEarlier={() => {
                  void loadPage(true);
                }}
              />
            }
            transcriptTurns={tab?.transcriptWindow?.turns}
            onLoadTurn={loadTurn}
            turnPageId={turnPageId}
            turnLoading={pageLoading}
            turnError={pageError}
            messages={tab.messages}
            queuedMessages={[]}
            chatId={tab.id}
            agentUsage={tab.agentUsage}
            turnDiffs={tab.turnDiffs}
            onClearQueuedMessage={(): void => undefined}
            targetOverride={{ projectId, worktreeId, chatId: tab.id }}
            hideBranchActions
            containerRef={transcriptContainerRef}
            suppressAutoScroll={search.query.length > 0}
          />
        ) : loadFailed ? (
          <p className="flex flex-1 items-center justify-center p-6 text-center text-s fg-secondary">
            Could not load this archived chat.
          </p>
        ) : (
          <div className="flex flex-1 items-center justify-center gap-2 p-6 text-s fg-secondary">
            <LoadingSpinner />
            <span>Loading transcript…</span>
          </div>
        )}
      </div>
      {shareRunOpen && (
        <ShareRunModal
          chatId={summary.chatId}
          runTitle={summary.title}
          existingShare={tab?.sharedRun}
          onClose={(): void => setShareRunOpen(false)}
          onShare={handleShareRunSubmit}
          checkEligibility={handleShareRunEligibility}
        />
      )}
    </DialogModal>
  );
}
