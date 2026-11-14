import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  CLOUD_REACH_BACK_APPROVAL_PROJECT_ID,
  type ApprovalPromptDecision,
  type ApprovalRequestEvent,
} from '@canopy/desktop-shared/types';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import { ReachBackApprovalDialog } from '@canopy/ui-app/capability';

const isReachBack = (event: ApprovalRequestEvent): boolean =>
  event.surface === 'non-chat' &&
  event.projectId === CLOUD_REACH_BACK_APPROVAL_PROJECT_ID;

/**
 * Shows main's reach-back prompts in this window (CAN-6176 Q3), oldest
 * first. Only once or deny: the card offers no rule. A prompt main takes
 * down (an answer from another window, a withdrawal, the 120 s timeout)
 * leaves at once; one whose answer was refused as stale stays.
 */
export function CloudReachBackApprovalHost(): JSX.Element | null {
  const [pending, setPending] = useState<readonly ApprovalRequestEvent[]>([]);

  useEffect(() => {
    let mounted = true;
    // Withdrawn before the first snapshot answered: that snapshot, taken
    // earlier, must not bring them back.
    const withdrawn = new Set<string>();
    const add = (event: ApprovalRequestEvent): void =>
      setPending((current) =>
        current.some((item) => item.requestId === event.requestId)
          ? current.map((item) =>
              item.requestId === event.requestId ? event : item,
            )
          : [...current, event],
      );
    const offRequest = window.api.approvals.onRequest((event) => {
      if (isReachBack(event)) add(event);
    });
    const offCancelled = window.api.approvals.onCancelled((event) => {
      withdrawn.add(event.requestId);
      setPending((current) =>
        current.filter((item) => item.requestId !== event.requestId),
      );
    });
    void window.api.approvals
      .pendingRequests()
      .then((events) => {
        if (!mounted) return;
        // Only what isn't queued already: a live event is newer than this.
        setPending((current) => [
          ...current,
          ...events.filter(
            (event) =>
              isReachBack(event) &&
              !withdrawn.has(event.requestId) &&
              !current.some((item) => item.requestId === event.requestId),
          ),
        ]);
      })
      .catch((caught: unknown) => reportClientAppError(caught));
    return (): void => {
      mounted = false;
      offRequest();
      offCancelled();
    };
  }, []);

  const current = pending[0];
  const respond = useCallback(
    async (
      requestId: string,
      decision: ApprovalPromptDecision,
    ): Promise<void> => {
      if (current?.requestId !== requestId) return;
      // Never a rule: whatever the card sends, this answers once.
      const once: ApprovalPromptDecision = {
        behavior: decision.behavior,
        scope: 'once',
      };
      let accepted = false;
      try {
        accepted = await window.api.approvals.respond({
          requestId,
          projectId: current.projectId,
          worktreeId: current.worktreeId,
          chatId: current.chatId,
          decision: once,
          ...(current.policyRevision !== undefined
            ? { policyRevision: current.policyRevision }
            : {}),
        });
      } catch (caught) {
        reportClientAppError(caught);
      }
      // A refused answer may only be stale (the policy moved on): keep the
      // prompt, at main's current revision, while main still holds it.
      let live: ApprovalRequestEvent | undefined;
      if (!accepted) {
        try {
          live = (await window.api.approvals.pendingRequests()).find(
            (event) => event.requestId === requestId && isReachBack(event),
          );
        } catch (caught) {
          reportClientAppError(caught);
        }
      }
      setPending((items) =>
        live === undefined
          ? items.filter((item) => item.requestId !== requestId)
          : items.map((item) => (item.requestId === requestId ? live : item)),
      );
    },
    [current],
  );

  if (current === undefined) return null;
  return (
    <ReachBackApprovalDialog
      key={`${current.requestId}:${String(current.policyRevision ?? 0)}`}
      pending={current}
      onRespond={respond}
    />
  );
}
