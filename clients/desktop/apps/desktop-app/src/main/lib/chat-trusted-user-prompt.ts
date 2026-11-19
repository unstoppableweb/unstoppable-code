import {
  readAutoResumeMetadata,
  type AutoResumeMetadata,
} from '@canopy/protocol/remote-control/shell';
import { chatAgentSent } from '@canopy/protocol/remote-control/shell/external-agent-sender';
import {
  requireProviderForModel,
  type AgentProviderType,
  type ChatSendMessageRequest,
  type ChatWatcherFiredInfo,
} from '@canopy/desktop-shared/types';

export function buildTrustedUserPromptEvent(request: ChatSendMessageRequest): {
  type: 'canopy_user_prompt';
  original_text: string;
  canopy_turn_user_message_id: string;
  canopy_resumes_interrupted_turn?: true;
  canopy_resumes_user_message_id?: string;
  provider: AgentProviderType;
  canopy_persisted_messages: Array<{
    id: string;
    role: 'user';
    userMessageSource?: 'agent' | 'auto_resume';
    autoResume?: AutoResumeMetadata;
    agentSent?: NonNullable<ChatSendMessageRequest['agentSent']>;
    timestamp: number;
    blocks: Array<
      | {
          type: 'file_references';
          references: NonNullable<ChatSendMessageRequest['fileReferences']>;
        }
      | { type: 'text'; text: string }
    >;
    attachmentPaths?: string[];
    attachmentPromptContexts?: NonNullable<
      ChatSendMessageRequest['attachmentPromptContexts']
    >;
    inputMode?: NonNullable<ChatSendMessageRequest['inputMode']>;
    watcherFired?: ChatWatcherFiredInfo;
  }>;
} {
  const autoResume = readAutoResumeMetadata(request.autoResume);
  const provider =
    request.providerType ??
    (request.model ? requireProviderForModel(request.model) : 'claude');
  return {
    type: 'canopy_user_prompt',
    original_text: request.text,
    canopy_turn_user_message_id: request.userMessageId,
    ...(request.resumesInterruptedTurn
      ? { canopy_resumes_interrupted_turn: true as const }
      : {}),
    ...(autoResume?.resumesUserMessageId
      ? { canopy_resumes_user_message_id: autoResume.resumesUserMessageId }
      : {}),
    provider,
    canopy_persisted_messages: [
      {
        id: request.userMessageId,
        role: 'user',
        // Ingestion replaces the already-persisted message with this id, so it
        // must carry the same agent-sent marking as buildPersistedUserMessage.
        // A message an external MCP agent sent stays the person's own.
        ...(autoResume
          ? { userMessageSource: 'auto_resume' as const, autoResume }
          : chatAgentSent(request.agentSent)
            ? { userMessageSource: 'agent' as const }
            : {}),
        ...(request.agentSent ? { agentSent: request.agentSent } : {}),
        timestamp: Date.now(),
        blocks: [
          ...(request.fileReferences?.length
            ? [
                {
                  type: 'file_references' as const,
                  references: request.fileReferences,
                },
              ]
            : []),
          { type: 'text', text: request.text },
        ],
        ...(request.attachmentPaths?.length
          ? { attachmentPaths: request.attachmentPaths }
          : {}),
        ...(request.attachmentPromptContexts?.length
          ? { attachmentPromptContexts: request.attachmentPromptContexts }
          : {}),
        ...(autoResume && !autoResume.resendsUserMessage
          ? {}
          : { inputMode: request.inputMode ?? 'typed' }),
        ...(request.watcherFired ? { watcherFired: request.watcherFired } : {}),
      },
    ],
  };
}
