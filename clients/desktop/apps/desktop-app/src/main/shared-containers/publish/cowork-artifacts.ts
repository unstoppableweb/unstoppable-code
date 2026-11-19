import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { isVisiblePersistedChatMessage } from '@canopy/agent-transcript';
import { persistedMessageToRemoteControlMessage } from '@canopy/agent-transcript/remote-control/persisted-chat-projection';
import {
  MAX_SHARED_CONTAINER_TITLE_LENGTH,
  sharedContainerPublishedLayoutHasWebPage,
  type SharedContainerRevisionLayout,
} from '@canopy/protocol/shared-containers';
import {
  appendPublishedAttachmentPaths,
  createArtifactInterner,
  createOutputPathDomain,
  finalizeRevisionArtifacts,
  rewritePublishedChatData,
  type RevisionArtifact,
} from './artifacts';
import type {
  CoworkPublishBinaryItem,
  CoworkPublishInventory,
} from './inventory';

export type CoworkRevisionArtifact = RevisionArtifact;

const BUDGET_ARTIFACT_ID = '00000000-0000-0000-0000-000000000000';
const BUDGET_ARTIFACT_ID_SEED = 'cowork-revision-byte-budget';
const BUDGET_TITLE = '\0'.repeat(MAX_SHARED_CONTAINER_TITLE_LENGTH);

export function getCoworkPublishContentSize(
  content: Pick<CoworkPublishBinaryItem, 'bytes' | 'source'>,
): number {
  if (content.source) return content.source.sizeBytes;
  if (content.bytes) return content.bytes.byteLength;
  throw new Error('Cowork publish content is missing');
}

function validateCoworkRecipientOutputPaths(
  inventory: CoworkPublishInventory,
): void {
  const domain = createOutputPathDomain();
  for (const chat of inventory.chats) domain.reserve(`chats/${chat.id}.json`);
  for (const note of inventory.notes)
    domain.reserve(`notes/${note.meta.id}.md`);
  for (const prompt of inventory.prompts) {
    domain.reserve(`prompts/${prompt.meta.id}.md`);
  }
  for (const attachment of inventory.attachments) {
    domain.reserve(`attachments/${attachment.displayName}`);
  }
  for (const file of inventory.files) domain.reserve(file.path);
}

export function buildCoworkRevisionArtifacts(
  inventory: CoworkPublishInventory,
  artifactIdSeed?: string,
  title = 'Work Entry',
): RevisionArtifact[] {
  validateCoworkRecipientOutputPaths(inventory);
  const artifacts: RevisionArtifact[] = [];
  const intern = createArtifactInterner(artifacts, artifactIdSeed);
  const attachmentArtifacts = inventory.attachments.map((attachment) => {
    const content = attachment.source ?? attachment.bytes;
    if (!content) throw new Error('Cowork attachment content is missing');
    const hash = Buffer.isBuffer(content)
      ? createHash('sha256').update(content).digest('hex')
      : content.hash.slice('sha256:'.length);
    return {
      attachment,
      artifact: intern(`attachments/${hash}`, content),
    };
  });
  const attachmentReplacements = new Map<string, string>();
  for (const { attachment, artifact } of attachmentArtifacts) {
    attachmentReplacements.set(attachment.displayName, artifact.path);
    if (attachment.sourcePath) {
      attachmentReplacements.set(attachment.sourcePath, artifact.path);
    }
    for (const sourcePath of attachment.sourcePaths ?? []) {
      attachmentReplacements.set(sourcePath, artifact.path);
    }
  }
  for (const chat of inventory.chats) {
    for (const message of chat.messages) {
      for (const originalPath of message.attachmentPaths ?? []) {
        const match = attachmentArtifacts.find(
          ({ attachment }) => attachment.displayName === basename(originalPath),
        );
        if (match)
          attachmentReplacements.set(originalPath, match.artifact.path);
      }
    }
  }
  const attachmentPaths: SharedContainerRevisionLayout['attachmentPaths'] = {};
  for (const { attachment, artifact } of attachmentArtifacts) {
    const remapKey = attachmentPaths[artifact.path]
      ? `${artifact.path}#${createHash('sha256')
          .update(attachment.displayName)
          .digest('hex')}`
      : artifact.path;
    attachmentPaths[remapKey] = {
      artifactId: artifact.artifactId,
      displayName: attachment.displayName,
    };
  }
  for (const chat of inventory.chats) {
    const envelope = rewritePublishedChatData(
      {
        schemaVersion: 1 as const,
        chatId: chat.id,
        title: chat.title,
        createdAt: chat.createdAt,
        ...(chat.description ? { description: chat.description } : {}),
        messages: chat.messages
          .filter(isVisiblePersistedChatMessage)
          .map((message) =>
            appendPublishedAttachmentPaths(
              persistedMessageToRemoteControlMessage(
                { scope: 'standalone', chatId: chat.id, message },
                {
                  textMaxChars: Infinity,
                  partTextMaxChars: Infinity,
                  objectMaxDepth: Infinity,
                  objectMaxKeys: Infinity,
                  arrayMaxItems: Infinity,
                  // Tool occurrences and output locators name this host's
                  // transcript rows; a published envelope carries neither.
                  outputLocators: false,
                },
              ),
              message.attachmentPaths,
              attachmentReplacements,
            ),
          ),
      },
      attachmentReplacements,
    );
    intern(`chats/${chat.id}.json`, Buffer.from(JSON.stringify(envelope)));
  }
  const notes = inventory.notes.map((note) => {
    const content =
      note.source ??
      (note.content !== undefined ? Buffer.from(note.content) : undefined);
    if (!content) throw new Error('Cowork note content is missing');
    intern(`notes/${note.meta.id}.md`, content);
    return {
      itemId: note.meta.id,
      title: note.meta.title,
      ...(note.meta.createdAt ? { createdAt: note.meta.createdAt } : {}),
      ...(note.meta.updatedAt ? { updatedAt: note.meta.updatedAt } : {}),
    };
  });
  const prompts = inventory.prompts.map((prompt) => {
    const content =
      prompt.source ??
      (prompt.content !== undefined ? Buffer.from(prompt.content) : undefined);
    if (!content) throw new Error('Cowork prompt content is missing');
    intern(`prompts/${prompt.meta.id}.md`, content);
    return {
      itemId: prompt.meta.id,
      title: prompt.meta.title,
      ...(prompt.meta.createdAt ? { createdAt: prompt.meta.createdAt } : {}),
      ...(prompt.meta.updatedAt ? { updatedAt: prompt.meta.updatedAt } : {}),
    };
  });
  const files = inventory.files.map((file) => {
    const content = file.source ?? file.bytes;
    if (!content) throw new Error('Cowork file content is missing');
    const hash = Buffer.isBuffer(content)
      ? createHash('sha256').update(content).digest('hex')
      : content.hash.slice('sha256:'.length);
    const artifact = intern(`files/${hash}`, content);
    return {
      path: file.path,
      status: 'added' as const,
      artifactId: artifact.artifactId,
      sizeBytes: String(getCoworkPublishContentSize(file)),
    };
  });
  return finalizeRevisionArtifacts(
    artifacts,
    {
      schemaVersion: sharedContainerPublishedLayoutHasWebPage(inventory.layout)
        ? 5
        : inventory.startPage
          ? 4
          : inventory.layout
            ? 3
            : 1,
      containerType: 'COWORK_WORK_ENTRY',
      title,
      repositories: [],
      files,
      notes,
      prompts,
      attachmentPaths,
      ...(inventory.layout ? { layout: inventory.layout } : {}),
      ...(inventory.startPage ? { startPage: inventory.startPage } : {}),
      ...(inventory.withheldFileCount && inventory.withheldFileCount > 0
        ? { withheldFileCount: inventory.withheldFileCount }
        : {}),
    },
    artifactIdSeed,
  );
}

type CoworkNonFileInventory = Pick<
  CoworkPublishInventory,
  'chats' | 'attachments' | 'notes' | 'prompts'
>;

/** Bytes already committed before default workspace files are selected. */
export function getCoworkRevisionBaseByteSize(
  inventory: CoworkNonFileInventory,
): number {
  return buildCoworkRevisionArtifacts(
    { ...inventory, files: [] },
    BUDGET_ARTIFACT_ID_SEED,
    BUDGET_TITLE,
  ).reduce((total, artifact) => total + artifact.sizeBytes, 0);
}

/**
 * Conservative revision-byte cost for one workspace file: its content plus
 * the exact JSON entry shape added to `container.json`. The comma is charged
 * to every entry so the first file is overestimated by one byte, never under.
 */
export function getCoworkFileRevisionByteCost(
  path: string,
  sizeBytes: number,
): number {
  const layoutEntry: SharedContainerRevisionLayout['files'][number] = {
    path,
    status: 'added',
    artifactId: BUDGET_ARTIFACT_ID,
    sizeBytes: String(sizeBytes),
  };
  return sizeBytes + Buffer.byteLength(JSON.stringify(layoutEntry)) + 1;
}

/** Exact `container.json` overhead for the aggregate withholding disclosure. */
export function getCoworkWithheldFileCountRevisionByteCost(
  withheldFileCount: number,
): number {
  if (withheldFileCount <= 0) return 0;
  return Buffer.byteLength(`,"withheldFileCount":${withheldFileCount}`);
}

export function getCoworkCandidateRevisionByteCosts(
  paths: readonly string[],
  sizeBytesByPath: Readonly<Record<string, number>> = {},
): Record<string, number> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      getCoworkFileRevisionByteCost(path, sizeBytesByPath[path] ?? 0),
    ]),
  );
}
