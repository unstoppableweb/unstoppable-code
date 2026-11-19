import type { ChatAgentSentInfo } from '@canopy/protocol/remote-control/shell';
import {
  firstIssueMessage,
  PROJECT_READ_TYPES as PROJECT_READ_ACTION_TYPES,
  projectReadActionSchema,
  type ProjectReadAction,
} from '@canopy/agent-actions/families/projects/actions';
import type {
  ChatSessionSummary,
  PageResult,
  ProjectChatAddress,
} from './project-discovery';

// The schemas moved to the shared projects action family.
export {
  PROJECT_READ_TYPES as PROJECT_READ_ACTION_TYPES,
  PROJECT_READ_MESSAGE_MAX_CHARS,
  PROJECT_READ_PAGE_SIZE_DEFAULT,
  PROJECT_READ_PAGE_SIZE_MAX,
  projectReadActionSchema,
  projectsGetLastAgentResponseActionSchema,
  projectsGetLastUserMessageActionSchema,
  projectsReadHistoryActionSchema,
  type ProjectReadAction,
  type ProjectsGetLastAgentResponseAction,
  type ProjectsGetLastUserMessageAction,
  type ProjectsReadHistoryAction,
} from '@canopy/agent-actions/families/projects/actions';

export type VisibleMessage = {
  messageId: string;
  turnId?: string;
  role: 'user' | 'assistant';
  timestamp?: string; // ISO timestamp
  text: string;
  truncated: boolean;
  /** Validated display attribution; provider-only context is never included. */
  agentSent?: ChatAgentSentInfo;
};

export type LastMessageResult = {
  address: ProjectChatAddress;
  message: VisibleMessage | null;
  session?: ChatSessionSummary;
  terminalDisposition?: string;
  generatedAt: string;
};

// Recorded deviation from plan README 8.1: bounded scans have nullable totals
// and countsExact. Totals are exact only when the whole history was scanned.
// Discovery PageResult retains its exact, non-null totalMatches contract.
export type HistoryResult = Omit<PageResult<VisibleMessage>, 'totalMatches'> & {
  totalMatches: number | null;
  address: ProjectChatAddress;
  totalMessages: number | null;
  countsExact: boolean;
  query?: string;
  session?: ChatSessionSummary;
};

export function parseProjectReadAction(
  value: unknown,
): { ok: true; action: ProjectReadAction } | { ok: false; message: string } {
  const parsed = projectReadActionSchema.safeParse(value);
  if (parsed.success) return { ok: true, action: parsed.data };
  return {
    ok: false,
    message: firstIssueMessage(parsed.error, 'Invalid project read action'),
  };
}

export function isProjectReadActionType(
  type: string,
): type is ProjectReadAction['type'] {
  return PROJECT_READ_ACTION_TYPES.some((actionType) => actionType === type);
}
