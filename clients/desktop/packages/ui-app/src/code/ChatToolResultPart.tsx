'use client';

import type { JSX } from 'react';
import { CollapsibleBlock } from '@canopy/ui-shared/components';
import { WrenchIcon } from '@canopy/ui-shared/icons';
import { useCapabilities } from '@canopy/app-state';
import { readRemoteControlChatPartVisual } from '@canopy/protocol/remote-control/shell';
import { ChatVisualBlock } from './ChatVisualBlock';
import { useChatVisualHost, type ChatVisualOwner } from './chat-visual-host';

export interface ChatToolResultPartProps {
  readonly content: string;
  readonly visual?: ChatVisualOwner;
}

/**
 * The visual a tool-result part's `data` carries, owned by the part's own
 * `messageId` when the projection supplied one.
 */
export function readChatToolResultVisual(
  data: unknown,
  fallbackMessageId?: string,
): ChatVisualOwner | undefined {
  const reference = readRemoteControlChatPartVisual({
    kind: 'tool_result',
    data,
  });
  if (!reference || typeof data !== 'object' || data === null) return undefined;
  const messageId =
    'messageId' in data && typeof data.messageId === 'string'
      ? data.messageId
      : fallbackMessageId;
  const toolUseId =
    'toolUseId' in data && typeof data.toolUseId === 'string'
      ? data.toolUseId
      : undefined;
  return messageId && toolUseId
    ? { messageId, toolUseId, reference }
    : undefined;
}

function VisualToolResult({
  content,
  visual,
}: {
  content: string;
  visual: ChatVisualOwner;
}): JSX.Element | null {
  const capabilities = useCapabilities();
  if (capabilities.chatVisuals === true) {
    return <ChatVisualBlock owner={visual} variant="inline" />;
  }
  return content ? <ToolResultRow content={content} /> : null;
}

function ToolResultRow({ content }: { content: string }): JSX.Element {
  return (
    <CollapsibleBlock
      label="Tool result"
      content={content}
      icon={<WrenchIcon />}
    />
  );
}

/** The shared, unchanged collapsible transcript row for a tool result. */
export function ChatToolResultPart({
  content,
  visual,
}: ChatToolResultPartProps): JSX.Element | null {
  const host = useChatVisualHost();
  if (!visual) return <ToolResultRow content={content} />;
  if (!host) return content ? <ToolResultRow content={content} /> : null;
  return <VisualToolResult content={content} visual={visual} />;
}
