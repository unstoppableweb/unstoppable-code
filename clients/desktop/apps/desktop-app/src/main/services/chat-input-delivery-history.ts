import type { PersistedChatTab } from '@canopy/desktop-shared/types';
import { chatClaudeConfigDir } from '../lib/chat-claude-config-dir';
import { readClaudeDeliveryHistory } from '../agents/claude-delivery-history';
import { readCodexDeliveryHistory } from '../codex/delivery-history';
import type { SteeringTarget } from '../agents/types';

/** A false `not-found` resends a message, so doubtful evidence is `unreadable`. */
export type DeliveryHistoryVerdict = 'found' | 'not-found' | 'unreadable';

export interface DeliveryHistoryQuery {
  provider: 'claude' | 'codex';
  target: SteeringTarget;
  attemptId: string;
  rowId: string;
  /** Attempts on the row; a row-id match is ambiguous when there are several. */
  rowAttemptCount: number;
  cwd: string;
  projectId: string;
  worktreeId: string;
  tab: PersistedChatTab;
  /** The attempt was created before the current app process started. */
  previousRun: boolean;
}

/** Reads the provider's own history for one steering attempt. */
export async function readDeliveryHistory(
  query: DeliveryHistoryQuery,
): Promise<DeliveryHistoryVerdict> {
  return query.provider === 'codex'
    ? readCodexDeliveryHistory({
        threadId: query.target.sessionId,
        turnId: query.target.turnId,
        attemptId: query.attemptId,
        previousRun: query.previousRun,
      })
    : readClaudeDeliveryHistory({
        configDir: await chatClaudeConfigDir(query),
        sessionId: query.target.sessionId,
        cwd: query.cwd,
        attemptId: query.attemptId,
        rowId: query.rowId,
        rowAttemptCount: query.rowAttemptCount,
        previousRun: query.previousRun,
      });
}
