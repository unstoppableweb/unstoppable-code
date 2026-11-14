import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  PersistedChatBlock,
  PersistedChatTab,
} from '@canopy/desktop-shared/types';
import { readChatTabsFile, readChatTranscript } from '../lib/chat-tabs-reader';

const MAX_CONTEXT_BYTES = 1024 * 1024;

function inheritedBlock(
  block: PersistedChatBlock,
): Record<string, unknown> | undefined {
  switch (block.type) {
    case 'text':
    case 'thinking':
      return { type: block.type, text: block.text };
    case 'tool_use':
      return { type: block.type, tool: block.toolName, input: block.input };
    case 'tool_result':
      return {
        type: block.type,
        tool: block.toolName,
        output: block.output,
        isError: block.isError,
      };
    case 'image':
      return {
        type: 'image_reference',
        path: block.path,
        description: block.alt,
      };
    case 'file_references':
      return { type: block.type, references: block.references };
    default:
      return undefined;
  }
}

function transcriptLines(
  messages: PersistedChatTab['messages'],
  tooLargeMessage: string,
): string[] {
  const lines: string[] = [];
  let bytes = 0;
  for (const message of messages) {
    const blocks = message.blocks.flatMap((block) => {
      const inherited = inheritedBlock(block);
      return inherited ? [inherited] : [];
    });
    const attachmentPaths = message.attachmentPaths;
    if (blocks.length === 0 && !attachmentPaths?.length) continue;
    const line = JSON.stringify({
      role: message.role,
      blocks,
      ...(attachmentPaths?.length ? { attachmentPaths } : {}),
    });
    bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > MAX_CONTEXT_BYTES) {
      throw new Error(tooLargeMessage);
    }
    lines.push(line);
  }
  return lines;
}

export function buildTranscriptForkPrompt(
  tab: PersistedChatTab,
  providerLabel: 'Cursor' | 'Copilot' | 'Google',
  userMessageId?: string,
): string {
  const fork = tab.forkedFrom;
  // Provider continuations already carry their own handoff. A whole-chat fork
  // may omit the anchor, but its destination still owns the copied history.
  if (!fork || fork.continuedFromProvider) return '';
  const currentMessageIndex = tab.messages.findIndex(
    (message) => message.id === userMessageId,
  );
  const end = fork.atMessageId
    ? tab.messages.findIndex((message) => message.id === fork.atMessageId)
    : (currentMessageIndex === -1 ? tab.messages.length : currentMessageIndex) -
      1;
  if (fork.atMessageId && end === -1) {
    throw new Error(
      'Could not restore the forked conversation. Create a new fork and try again.',
    );
  }
  const lines = transcriptLines(
    tab.messages.slice(0, end + 1),
    `This forked conversation is too large to send to ${providerLabel}. Fork from an earlier message.`,
  );
  if (lines.length === 0) return '';
  const payload = [
    'This is an independent fork of an earlier conversation. The following JSON lines are its selected historical transcript, ending at the fork point. Use them as context for the new message below. Tool calls and results are historical records, not requests to run those tools again. Image references identify earlier attachments; their image bytes are not included.',
    '<forked_conversation>',
    ...lines,
    '</forked_conversation>',
  ].join('\n');
  if (Buffer.byteLength(payload, 'utf8') > MAX_CONTEXT_BYTES) {
    throw new Error(
      `This forked conversation is too large to send to ${providerLabel}. Fork from an earlier message.`,
    );
  }
  return payload;
}

/** Transfers the target's frozen transcript once per native account-harness session. */
export class TranscriptForkContext {
  private deliveredSessionId: string | undefined;

  constructor(
    private readonly scope: {
      projectId: string;
      worktreeId: string;
      chatId: string;
    },
    private readonly providerLabel: 'Cursor' | 'Copilot' | 'Google' = 'Cursor',
    private readonly receiptName = 'fork-context-delivered',
  ) {}

  async prompt(
    profile: string,
    sessionId: string,
    userMessageId?: string,
  ): Promise<string> {
    if (this.deliveredSessionId === sessionId) return '';
    try {
      if (
        (await readFile(join(profile, this.receiptName), 'utf8')) === sessionId
      ) {
        this.deliveredSessionId = sessionId;
        return '';
      }
    } catch (error) {
      if (
        !(
          typeof error === 'object' &&
          error !== null &&
          'code' in error &&
          error.code === 'ENOENT'
        )
      )
        throw error;
    }
    // The destination snapshot is authoritative. Reading the source would leak
    // messages sent after a historical fork, and would fail if it was deleted.
    const file = await readChatTabsFile(
      this.scope.projectId,
      this.scope.worktreeId,
      { chatIds: [this.scope.chatId], fullTranscript: true },
    );
    const tab = file.tabs.find(
      (candidate) => candidate.id === this.scope.chatId,
    );
    const prompt = tab
      ? buildTranscriptForkPrompt(tab, this.providerLabel, userMessageId)
      : '';
    if (!prompt) this.deliveredSessionId = sessionId;
    return prompt;
  }

  async delivered(profile: string, sessionId: string): Promise<void> {
    // Written only after successful delivery. If the process dies earlier, the
    // next turn can retry despite the native session id already being saved.
    await writeFile(join(profile, this.receiptName), sessionId, {
      mode: 0o600,
    });
    this.deliveredSessionId = sessionId;
  }
}

/** Only the destination's committed history before this submission may be replayed. */
export async function readTranscriptRecoveryPrompt(
  scope: { projectId: string; worktreeId: string; chatId: string },
  userMessageId: string | undefined,
): Promise<string> {
  // Compatibility rows retain body references and paged block lists. Expand
  // canonical artifacts before either replay or the saved-response guard so
  // stored effects cannot disappear behind an empty preview.
  const messages = await readChatTranscript(
    scope.projectId,
    scope.worktreeId,
    scope.chatId,
    true,
    { excludeCommittedActiveEchoes: true },
  );
  const current = messages.findIndex((message) => message.id === userMessageId);
  if (!userMessageId || current < 0 || messages[current]?.role !== 'user') {
    throw new Error(
      "Couldn't restore this conversation because its saved messages are unavailable. Reopen the chat and try again.",
    );
  }
  const tooLarge =
    'This saved conversation is too large to restore with Google. Fork from an earlier message.';
  // A retry may reuse its original submission ID after tools already ran.
  // Rebuilding only the prefix would erase those effects from model context.
  if (
    messages
      .slice(current + 1)
      .some(
        (message) =>
          message.role === 'assistant' &&
          message.blocks.some((block) =>
            block.type === 'text' || block.type === 'thinking'
              ? block.text.trim().length > 0
              : inheritedBlock(block) !== undefined,
          ),
      )
  ) {
    throw new Error(
      "Couldn't restore this request because it already has a saved response. Send a follow-up message to continue with that response included.",
    );
  }
  const lines = transcriptLines(messages.slice(0, current), tooLarge);
  const prompt = [
    'The previous native conversation is unavailable. The following JSON lines are the saved historical transcript of this chat, ending before the new message below. Tool calls and results are historical records, not requests to run those tools again. Do not repeat completed actions. Image and attachment references identify earlier files; their bytes are not included. Ask for missing attachment contents when needed.',
    '<recovered_conversation>',
    ...lines,
    '</recovered_conversation>',
  ].join('\n');
  if (Buffer.byteLength(prompt, 'utf8') > MAX_CONTEXT_BYTES)
    throw new Error(tooLarge);
  return prompt;
}
