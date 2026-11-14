import type {
  ContentBlock,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import {
  readAcpAttachments,
  type AcpAttachmentSelection,
} from '../acp/prompt-attachments';

/** 1.5.1 advertises embedded context but drops resource.text in live prompts. */
export async function readAntigravityAttachments(
  selection: AcpAttachmentSelection | undefined,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const blocks = await readAcpAttachments(selection, signal, {
    providerLabel: 'Antigravity',
    pdf: false,
  });
  return blocks.map((block): ContentBlock => {
    if (block.type === 'resource' && 'text' in block.resource) {
      return {
        type: 'text',
        text: `Attached file ${JSON.stringify(block.resource.uri)}:\n${block.resource.text}`,
      };
    }
    return block;
  });
}

export function assertAntigravityAttachmentCapabilities(
  blocks: readonly ContentBlock[],
  initialization: InitializeResponse,
): void {
  if (
    blocks.some((block) => block.type === 'image') &&
    initialization.agentCapabilities?.promptCapabilities?.image !== true
  )
    throw new Error(
      "Couldn't send images to Antigravity. Remove them or choose another model.",
    );
}
