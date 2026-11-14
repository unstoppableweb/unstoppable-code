import type { ContentBlock } from '@agentclientprotocol/sdk';
import {
  readAcpAttachments,
  type AcpAttachmentSelection,
} from '../acp/prompt-attachments';

export type OpenCodeAttachmentSelection = AcpAttachmentSelection;

export function readOpenCodeAttachments(
  selection: OpenCodeAttachmentSelection | undefined,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  return readAcpAttachments(selection, signal, { providerLabel: 'OpenCode' });
}
