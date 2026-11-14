import { memo, useEffect, useState, type JSX } from 'react';
import { ErrorBanner, Surface } from '@canopy/ui-shared/components';
import {
  CheckCircle2,
  MessageSquare,
  Sparkles,
  ThumbsDown,
  ThumbsUp,
} from 'lucide-react';
import {
  MEMORY_FEEDBACK_COMMENT_MAX_CHARS,
  type MemoryFeedbackRating,
} from '@canopy/protocol/memory';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { AppliedOrgMemoryTurn } from '@/stores/chat/types';
import { DialogModal } from '@/components/shared/DialogModal';
import { LoadingSpinner } from '@/components/shared/loading';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import { findOrganizationName } from '@/lib/organizationName';
import { openAccountOrganizationPage } from '@/lib/navigation/settings-destinations';
import { isSettingsRouteId } from '@canopy/protocol/settings';
import { TextArea, Tooltip } from '@canopy/ui-shared';
import { Button } from '@canopy/ui-shared/components';

interface MemoryUsedDialogProps {
  memory: AppliedOrgMemoryTurn;
  onClose: () => void;
}

interface MemoryUsedButtonProps {
  memory: AppliedOrgMemoryTurn;
}

function MemoryUsedButtonImpl({ memory }: MemoryUsedButtonProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const count = memory.facts.length;
  return (
    <>
      <Tooltip
        className="self-start"
        label="Show organization memories used for this message"
      >
        <Button
          size="compact"
          aria-label="Show organization memories used for this message"
          data-testid="memory-used-button"
          onClick={(): void => setOpen(true)}
        >
          <Sparkles aria-hidden="true" className="size-3" />
          {count} {count === 1 ? 'memory' : 'memories'} used
        </Button>
      </Tooltip>
      {open && (
        <MemoryUsedDialog
          memory={memory}
          onClose={(): void => setOpen(false)}
        />
      )}
    </>
  );
}

export const MemoryUsedButton = memo(MemoryUsedButtonImpl);

interface FactFeedbackControlsProps {
  organizationExternalId: string;
  searchId: string;
  factId: string;
}

function FactFeedbackControls({
  organizationExternalId,
  searchId,
  factId,
}: FactFeedbackControlsProps): JSX.Element {
  const [status, setStatus] = useState<
    'loading' | 'idle' | 'submitting' | 'submitted' | 'unavailable' | 'error'
  >('loading');
  const [pendingRating, setPendingRating] =
    useState<MemoryFeedbackRating | null>(null);
  const [commentOpen, setCommentOpen] = useState(false);
  const [comment, setComment] = useState('');

  useEffect(() => {
    let cancelled = false;
    void window.api
      .getOrgMemoryFeedback({ organizationExternalId, searchId, factId })
      .then((result) => {
        if (!cancelled) {
          setStatus(
            result.feedback !== null
              ? 'submitted'
              : result.canSubmit
                ? 'idle'
                : 'unavailable',
          );
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('unavailable');
      });
    return (): void => {
      cancelled = true;
    };
  }, [factId, organizationExternalId, searchId]);

  const submit = async (feedback: {
    rating?: MemoryFeedbackRating;
    comment?: string;
  }): Promise<void> => {
    if (status !== 'idle' && status !== 'error') return;
    setStatus('submitting');
    try {
      const result = await window.api.submitOrgMemoryFeedback({
        organizationExternalId,
        searchId,
        factId,
        ...feedback,
      });
      if (result.recorded || result.feedback) {
        setCommentOpen(false);
        setStatus('submitted');
      } else {
        setPendingRating(null);
        setStatus('error');
      }
    } catch {
      setPendingRating(null);
      setStatus('error');
    }
  };

  const sendRating = (next: MemoryFeedbackRating): void => {
    const trimmed = comment.trim();
    setPendingRating(next);
    void submit({
      rating: next,
      ...(trimmed.length === 0 ? {} : { comment: trimmed }),
    });
  };
  const sendComment = (): void => {
    const trimmed = comment.trim();
    if (trimmed.length === 0) return;
    void submit({ comment: trimmed });
  };

  if (status === 'loading') {
    return (
      <div className="flex items-center gap-1.5 text-2xs fg-secondary">
        <LoadingSpinner sizePx={12} />
        Checking feedback…
      </div>
    );
  }

  if (status === 'submitted') {
    return (
      <div
        className="flex items-center gap-1.5 text-2xs fg-success animate-fade-in"
        role="status"
        data-testid="memory-feedback-submitted"
      >
        <CheckCircle2 aria-hidden="true" className="size-3.5" />
        Feedback submitted
      </div>
    );
  }

  if (status === 'unavailable') return <></>;

  const submitting = status === 'submitting';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-2xs">
        <Tooltip label="This memory was helpful">
          <Button
            variant={pendingRating === 'like' ? 'secondary' : 'ghost-quiet'}
            size="compact"
            iconOnly
            aria-label="This memory was helpful"
            aria-pressed={pendingRating === 'like'}
            data-testid="memory-feedback-like"
            disabled={submitting}
            onClick={(): void => sendRating('like')}
          >
            <ThumbsUp aria-hidden="true" className="size-3" />
          </Button>
        </Tooltip>
        <Tooltip label="This memory was wrong or unhelpful">
          <Button
            variant={pendingRating === 'dislike' ? 'secondary' : 'ghost-quiet'}
            size="compact"
            iconOnly
            aria-label="This memory was wrong or unhelpful"
            aria-pressed={pendingRating === 'dislike'}
            data-testid="memory-feedback-dislike"
            disabled={submitting}
            onClick={(): void => sendRating('dislike')}
          >
            <ThumbsDown aria-hidden="true" className="size-3" />
          </Button>
        </Tooltip>
        <Tooltip label="Comment on this memory">
          <Button
            variant="ghost-quiet"
            size="compact"
            aria-expanded={commentOpen}
            aria-label="Comment on this memory"
            data-testid="memory-feedback-comment-toggle"
            disabled={submitting}
            onClick={(): void => setCommentOpen((value) => !value)}
          >
            <MessageSquare aria-hidden="true" className="size-3" />
            Comment
          </Button>
        </Tooltip>
        {submitting ? (
          <span className="inline-flex items-center gap-1 fg-secondary">
            <LoadingSpinner sizePx={12} />
            Submitting…
          </span>
        ) : null}
      </div>
      {status === 'error' ? (
        <ErrorBanner
          errorSource="fact-feedback-controls"
          error="Couldn’t submit. Try again."
          className=""
        />
      ) : null}
      {commentOpen ? (
        <div className="flex items-end gap-2">
          <TextArea
            className="flex-1"
            placeholder="What's wrong (or right) about this memory?"
            aria-label="Feedback comment for this memory"
            data-testid="memory-feedback-comment-input"
            maxLength={MEMORY_FEEDBACK_COMMENT_MAX_CHARS}
            value={comment}
            onChange={(event): void => setComment(event.target.value)}
          />
          <Button
            size="compact"
            data-testid="memory-feedback-comment-send"
            disabled={submitting || comment.trim().length === 0}
            onClick={sendComment}
          >
            Send
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Display name of the organization a turn's memories were searched in
 * (CAN-3457), or `null` when the turn predates the recorded org or the org is
 * not among the account's memberships. The workspace-context mirror answers
 * synchronously when it lists the org; it lists none while shared org
 * projects are off, so the cloud account's memberships are read once as the
 * fallback.
 */
function useOrganizationName(
  organizationExternalId: string | undefined,
): string | null {
  const contextName = useWorkspaceContextStore((store) =>
    organizationExternalId === undefined
      ? null
      : findOrganizationName(store.state.organizations, organizationExternalId),
  );
  const [accountName, setAccountName] = useState<string | null>(null);
  const needsAccount =
    organizationExternalId !== undefined && contextName === null;
  useEffect(() => {
    if (!needsAccount || organizationExternalId === undefined) return;
    let cancelled = false;
    void window.api
      .loadCanopyCloudAccount()
      .then((account) => {
        if (!cancelled) {
          setAccountName(
            findOrganizationName(account.organizations, organizationExternalId),
          );
        }
      })
      .catch(() => {
        // Keep the generic "Organization" label when the account is unreadable.
      });
    return (): void => {
      cancelled = true;
    };
  }, [needsAccount, organizationExternalId]);
  return contextName ?? (needsAccount ? accountName : null);
}

/**
 * The searched organization's ID as the viewer's membership spells it, when
 * the viewer is its OWNER or ADMIN, who can open its Memory page; `null` for
 * everyone else, who gets a 404 there. Read from the workspace-context
 * memberships, whose IDs are the ones the settings routes take.
 */
function useManagedMemoryOrganizationId(
  organizationExternalId: string | undefined,
): string | null {
  return useWorkspaceContextStore((store) => {
    if (organizationExternalId === undefined) return null;
    const id = organizationExternalId.toLowerCase();
    const membership = store.state.organizations.find(
      (organization) => organization.id.toLowerCase() === id,
    );
    return membership?.role === 'OWNER' || membership?.role === 'ADMIN'
      ? membership.id
      : null;
  });
}

function MemoryUsedDialogImpl({
  memory,
  onClose,
}: MemoryUsedDialogProps): JSX.Element {
  useCurrentUiStateReporter('chat.memoryUsedDialog', {
    open: true,
    factCount: memory.facts.length,
  });
  const organizationName = useOrganizationName(memory.organizationExternalId);
  const memoryOrganizationId = useManagedMemoryOrganizationId(
    memory.organizationExternalId,
  );
  const { organizationExternalId, searchId } = memory;

  return (
    <DialogModal
      onClose={onClose}
      title="Memories used"
      maxWidth="lg"
      dataTestId="memory-used-dialog"
    >
      <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto">
        <p className="text-s fg-secondary" data-testid="memory-used-intro">
          {organizationName === null ? (
            'Suggestions from past organization sessions'
          ) : (
            <>
              Suggestions from{' '}
              <span
                className="font-medium fg-primary"
                data-testid="memory-used-organization-name"
              >
                {organizationName}
              </span>
              &apos;s past sessions
            </>
          )}
          , not sources of truth. Verify them before acting. Rating them helps
          tune what gets recalled.
        </p>
        {memory.facts.map((fact, index) => (
          <Surface
            key={`${fact.factId ?? fact.sourceTurnIds.join(':')}:${index}`}
            as="section"
            gap="inline"
            variant="group"
            padding="compact"
          >
            <p
              className={`${POSTHOG_REPLAY_BLOCK_CLASS} whitespace-pre-wrap text-s fg-primary`}
            >
              {fact.factText}
            </p>
            <div className="flex flex-wrap gap-2 text-2xs fg-secondary">
              {fact.validAt ? <span>As of {fact.validAt}</span> : null}
              <span data-testid="memory-used-fact-organization">
                {organizationName ?? 'Organization'}
              </span>
              {memoryOrganizationId !== null &&
              isSettingsRouteId(memoryOrganizationId) &&
              fact.factId &&
              isSettingsRouteId(fact.factId) ? (
                <ViewInOrganizationMemoryButton
                  organizationId={memoryOrganizationId}
                  factId={fact.factId}
                  onOpened={onClose}
                />
              ) : null}
            </div>
            {/* Feedback goes to the org that was searched. Turns persisted
                before that org was recorded stay read-only (CAN-3457). */}
            {organizationExternalId && searchId && fact.factId ? (
              <FactFeedbackControls
                organizationExternalId={organizationExternalId}
                searchId={searchId}
                factId={fact.factId}
              />
            ) : null}
          </Surface>
        ))}
      </div>
    </DialogModal>
  );
}

/** Opens the fact on the organization's Memory page. */
function ViewInOrganizationMemoryButton({
  organizationId,
  factId,
  onOpened,
}: {
  organizationId: string;
  factId: string;
  onOpened: () => void;
}): JSX.Element {
  return (
    <Button
      variant="link"
      data-testid="memory-used-fact-view-in-memory"
      onClick={(): void => {
        const opened = openAccountOrganizationPage({
          scope: 'organization',
          organizationId,
          page: 'memory',
          factId,
        });
        if (opened === 'settings') onOpened();
      }}
    >
      View in organization memory
    </Button>
  );
}

export const MemoryUsedDialog = memo(MemoryUsedDialogImpl);
