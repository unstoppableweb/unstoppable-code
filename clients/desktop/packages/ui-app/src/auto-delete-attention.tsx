'use client';

import { useEffect, useRef, useState, type JSX } from 'react';
import type { CanopyClient } from '@canopy/app-core';
import {
  archiveRefusalOutcome,
  offerWorktreeDiscard,
  offerLifecycleJournalQuarantine,
} from '@canopy/app-state';
import type { AutoDeleteAttention } from '@canopy/protocol/portal/auto-delete-attention';
import { formatWorktreeRecoveryReason } from '@canopy/protocol/portal/worktree-recovery';
import {
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
} from '@canopy/protocol/portal/lifecycle-journal-refusal';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

export interface AutoDeleteAttentionNotification {
  id: string;
  message: string;
  review: () => Promise<void>;
}

function openJournalReview(
  client: CanopyClient,
  review: 'unreadable-entry' | 'directory-unreadable',
  notifyReason: (reason: string) => void,
): void {
  if (client.capabilities.lifecycleJournalQuarantine !== true) {
    notifyReason("Couldn't check the previous removal.");
    return;
  }
  offerLifecycleJournalQuarantine(
    review === 'unreadable-entry'
      ? LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL
      : LIFECYCLE_JOURNAL_DIRECTORY_UNREADABLE_REFUSAL,
  );
}

/** Stable ids survive restart; callbacks and evidence are rebuilt at activation. */
export async function openAutoDeleteAttention(
  client: CanopyClient,
  attention: AutoDeleteAttention,
  notifyReason: (reason: string) => void,
): Promise<void> {
  if (attention.kind === 'journal-review') {
    openJournalReview(client, attention.review, notifyReason);
    return;
  }
  const request = {
    workspaceId: attention.workspaceId,
    worktreeId: attention.worktreeId,
    recovery: {
      intent: attention.reason.intent,
      expectedCreatedAt: attention.createdAt,
    },
  };
  try {
    const fresh = await client.command('worktree.discard.describe', request);
    // A withdrawn teardown journal loses its step, not its history. Current
    // retained facts and action admission still come entirely from main.
    const description =
      fresh.recovery?.stoppingPoint.phase === 'unknown' &&
      attention.reason.stoppingPoint.phase !== 'unknown'
        ? {
            ...fresh,
            recovery: {
              ...fresh.recovery,
              stoppingPoint: attention.reason.stoppingPoint,
            },
          }
        : fresh;
    if (description.recovery?.destination.kind === 'journal-review') {
      openJournalReview(
        client,
        description.recovery.destination.reason,
        notifyReason,
      );
      return;
    }
    // Never use an old incident to offer deletion of a replacement worktree.
    if (
      description.createdAt &&
      description.createdAt !== attention.createdAt
    ) {
      notifyReason(formatWorktreeRecoveryReason(attention.reason));
      return;
    }
    offerWorktreeDiscard({
      workspaceId: attention.workspaceId,
      worktreeId: attention.worktreeId,
      worktreeName: attention.worktreeName,
      description,
      ...(client.capabilities.worktreeRecovery === true && description.recovery
        ? { recovery: description.recovery }
        : {}),
      message: formatWorktreeRecoveryReason(
        description.recovery ?? attention.reason,
      ),
      retry: () => {
        void client
          .command('worktree.archive', {
            workspaceId: attention.workspaceId,
            worktreeId: attention.worktreeId,
            expectedCreatedAt: attention.createdAt,
            mode: attention.reason.intent,
            typedRefusal: true,
          })
          .then(
            (result) => {
              // Older clients acknowledge Archive with void. Never turn a
              // successful acknowledgement back into the incident's old error.
              if (archiveRefusalOutcome(result))
                return openAutoDeleteAttention(client, attention, notifyReason);
            },
            () => notifyReason(formatWorktreeRecoveryReason(attention.reason)),
          );
      },
    });
  } catch {
    notifyReason(formatWorktreeRecoveryReason(attention.reason));
  }
}

function notificationMessage(attention: AutoDeleteAttention): string {
  return attention.kind === 'worktree'
    ? `Couldn't automatically delete "${attention.worktreeName}".`
    : "Couldn't check the previous removal.";
}

/** The footer is the durable reopening path, independent of the toast's lifetime. */
export function AutoDeleteAttentionPanel({
  client,
  attention,
  announce = true,
  notify,
  notifyReason,
}: {
  client: CanopyClient;
  attention: readonly AutoDeleteAttention[];
  announce?: boolean;
  notify: (notification: AutoDeleteAttentionNotification) => void;
  notifyReason: (reason: string) => void;
}): JSX.Element | null {
  const delivered = useRef(new Set<string>());
  const [reviewErrors, setReviewErrors] = useState<
    Record<string, string | undefined>
  >({});
  const notifyRef = useRef(notify);
  const reasonRef = useRef(notifyReason);
  useEffect(() => {
    notifyRef.current = notify;
    reasonRef.current = notifyReason;
  });
  const review = (incident: AutoDeleteAttention): Promise<void> => {
    setReviewErrors((errors) => ({ ...errors, [incident.id]: undefined }));
    return openAutoDeleteAttention(client, incident, (reason) =>
      setReviewErrors((errors) => ({ ...errors, [incident.id]: reason })),
    );
  };
  useEffect(() => {
    // Advisor exposes the standing review, but must not acknowledge a popup
    // that only the main window can actually insert.
    if (!announce) return;
    for (const incident of attention) {
      if (delivered.current.has(incident.id)) continue;
      if (client.autoDeleteAttentionReceipts?.hasShown(incident.id)) {
        delivered.current.add(incident.id);
        continue;
      }
      notifyRef.current({
        id: incident.id,
        message: notificationMessage(incident),
        review: () =>
          openAutoDeleteAttention(client, incident, (reason) =>
            reasonRef.current(reason),
          ),
      });
      // Acknowledgement follows synchronous insertion into the host's toast store.
      delivered.current.add(incident.id);
      client.autoDeleteAttentionReceipts?.markShown(incident.id);
    }
  }, [announce, attention, client]);
  if (!attention.length) return null;
  return (
    <div
      className="flex max-h-48 flex-col gap-2 overflow-y-auto"
      data-testid="auto-delete-attention"
    >
      {attention.map((incident) => (
        <Notice
          key={incident.id}
          intent="attention"
          role="none"
          detail={reviewErrors[incident.id]}
          announceDetail
          actions={
            <NoticeButton
              data-testid={`auto-delete-attention-open-${incident.id}`}
              onClick={() => {
                void review(incident);
              }}
            >
              Review worktree recovery
            </NoticeButton>
          }
        >
          <span className={REPLAY_MASK_CLASS}>
            {notificationMessage(incident)}
          </span>
        </Notice>
      ))}
    </div>
  );
}
