import type { PersistedChatMessage, FileReference } from '../types';
import { parseChatAgentSentInfo } from '@canopy/protocol/remote-control/shell';
import { PROJECT_READ_MESSAGE_MAX_CHARS } from './project-reads';
import type { VisibleMessage } from './project-reads';

export type LegacyChatHistoryMessage = {
  id: string;
  role: PersistedChatMessage['role'];
  timestamp: number;
  text: string;
  truncated: boolean;
};

// Compatibility policy: preserve the renderer's legacy output byte-for-byte.
export function legacyChatHistoryMessageText(message: PersistedChatMessage): {
  text: string;
  truncated: boolean;
} {
  const raw = message.blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'file_references':
          return block.references
            .map((reference) => `[file] ${reference.absolutePath}`)
            .join('\n');
        case 'thinking':
          return `[thinking]\n${block.text}`;
        case 'tool_use':
          return `[tool_use ${block.toolName}]\n${block.input}`;
        case 'tool_result':
          return `[tool_result ${block.toolName}${block.isError ? ' error' : ''}]\n${block.output}`;
        case 'hook_info':
          return `[hook ${block.triggerName}]`;
        case 'claude_terminal_sync_warning':
          return `[claude terminal sync warning] ${block.message ?? ''}`.trim();
        case 'turn_timer':
          return '';
        case 'pending_setup_info':
          return '[pending setup]';
        case 'rebase_resolution_info':
          return `[${block.kind}] ${block.repoName} ${block.branchName}`;
        case 'builtin_gh_chat_info':
          return `[${block.kind}] ${block.repoName ?? ''} ${block.branchName ?? ''}`.trim();
        case 'approval_safety_denied_info':
          return `[blocked by safety rule: ${block.reason}] ${block.command}`;
        case 'approval_resolution_info':
          return `[approval released by mode change -> ${block.mode}] ${block.titles.join('; ')}`.trim();
        case 'revert_info':
          return `[revert] ${block.files.length} files, +${block.totalInsertions}/-${block.totalDeletions}`;
        case 'codex_agent_call':
          return `[codex_agent ${block.tool} ${block.status}]\n${block.prompt}`;
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (raw.length <= PROJECT_READ_MESSAGE_MAX_CHARS) {
    return { text: raw, truncated: false };
  }
  const suffix = `\n\n[truncated ${raw.length - PROJECT_READ_MESSAGE_MAX_CHARS} chars]`;
  return {
    text: `${raw.slice(0, Math.max(0, PROJECT_READ_MESSAGE_MAX_CHARS - suffix.length))}${suffix}`,
    truncated: true,
  };
}

export function serializeLegacyChatHistoryMessage(
  message: PersistedChatMessage,
): LegacyChatHistoryMessage {
  const text = legacyChatHistoryMessageText(message);
  return {
    id: message.id,
    role: message.role,
    timestamp: message.timestamp,
    text: text.text,
    truncated: text.truncated,
  };
}

/** Eligibility only; empty projected rows are rejected by the serializer. */
export function isVisibleReadMessage(
  message: PersistedChatMessage,
): message is PersistedChatMessage & { role: 'user' | 'assistant' } {
  return (
    (message.role === 'user' || message.role === 'assistant') &&
    message.hidden !== true &&
    message.parentBlockId === undefined &&
    message.parentToolUseId === undefined
  );
}

function referenceBasename(reference: FileReference): string {
  // Infer the host spelling from the absolute locator, not this process:
  // persisted Windows references are also read in browsers and on POSIX.
  const separator =
    reference.absolutePath.startsWith('/') &&
    !reference.absolutePath.startsWith('//')
      ? /\//
      : /[\\/]/;
  for (const path of [reference.displayPath, reference.absolutePath]) {
    const name = path?.trim().split(separator).pop()?.trim();
    if (name && name !== '.' && name !== '..' && !/^[A-Za-z]:$/.test(name)) {
      return name;
    }
  }
  return '';
}

/** Uncapped visible projection: query matching must precede output truncation. */
export function visibleMessageRawText(message: PersistedChatMessage): string {
  if (!isVisibleReadMessage(message)) return '';
  return message.blocks
    .map((block) => {
      switch (block.type) {
        case 'text':
          return block.text;
        case 'file_references':
          return block.references
            .map((reference) => {
              const name = referenceBasename(reference);
              return name ? `[file] ${name}` : '';
            })
            .filter(Boolean)
            .join('\n');
        default:
          return '';
      }
    })
    .filter(Boolean)
    .join('\n\n')
    .trim();
}

export function visibleMessageText(message: PersistedChatMessage): {
  text: string;
  truncated: boolean;
} {
  const raw = visibleMessageRawText(message);
  if (raw.length <= PROJECT_READ_MESSAGE_MAX_CHARS) {
    return { text: raw, truncated: false };
  }
  const suffix = `\n\n[truncated ${raw.length - PROJECT_READ_MESSAGE_MAX_CHARS} chars]`;
  return {
    text: `${raw.slice(0, Math.max(0, PROJECT_READ_MESSAGE_MAX_CHARS - suffix.length))}${suffix}`,
    truncated: true,
  };
}

/** Explicit DTO allowlist; never expose orchestration, attachments or children. */
export function serializeVisibleReadMessage(
  message: PersistedChatMessage,
  turnId?: string,
): VisibleMessage | null {
  if (!isVisibleReadMessage(message)) return null;
  const projected = visibleMessageText(message);
  if (!projected.text) return null;
  const timestamp = new Date(message.timestamp);
  const agentSent =
    message.role === 'user' && 'agentSent' in message
      ? parseChatAgentSentInfo(message.agentSent)
      : undefined;
  return {
    messageId: message.id,
    ...(turnId !== undefined ? { turnId } : {}),
    role: message.role,
    ...(Number.isFinite(timestamp.getTime())
      ? { timestamp: timestamp.toISOString() }
      : {}),
    text: projected.text,
    truncated: projected.truncated,
    ...(agentSent !== undefined ? { agentSent } : {}),
  };
}
