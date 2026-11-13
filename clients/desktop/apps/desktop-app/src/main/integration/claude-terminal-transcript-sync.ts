import { z } from 'zod';
import {
  projectChatWatcherAddressSchema,
  botChatWatcherAddressSchema,
} from '@canopy/desktop-shared/lib/chat-watcher-contracts';
import { writeFileAtomically } from '@canopy/execution-engine/node/lib/atomic-file';
import {
  sanitizeImportedUserText,
  ATTACHMENT_MEDIA_TYPE_EXTENSIONS,
} from '../agent-messaging/terminal-user-text';
import {
  correlateTerminalAgentMessage,
  settleTerminalAgentImports,
} from '../agent-messaging/terminal-input';
import { stripTerminalPresentationMarker } from '@canopy/desktop-shared/lib/terminal-presentation';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import {
  blockFingerprint,
  LAYOUT_BLOCK_TYPES,
  stripMemoryCitationTags,
} from '@canopy/agent-transcript';
import { BRAND } from '@canopy/brand/current';
import {
  STANDALONE_CHAT_PROJECT_ID,
  findClaudeModelByLabel,
  type ChatModel,
  type ClaudeTerminalSettingsSync,
  type CompactionInfoBlock,
  type PersistedChatBlock,
  type PersistedChatMessage,
  type TurnDiffData,
  type TranscriptSyncResult,
} from '@canopy/desktop-shared/types';
import type { ClaudeTerminalHookEventName } from '@canopy/desktop-shared/lib/desktop-integration-transport';
import { isClaudeChainUuid } from '@canopy/desktop-shared/lib/claude-fork-resume-point';
import { readChatTabsFile } from '../lib/chat-tabs-reader';
import { writeChatTabsFile } from '../lib/chat-tabs';
import { enqueueChatTabMutation } from '../lib/chat-tab-mutation-queue';
import { CLAUDE_SYNTHETIC_MODEL_SENTINEL } from '../lib/claude-synthetic';
import { getClaudeCodeProjectsDir } from '../lib/claude-project-paths';
import {
  getClaudeTerminalRuntimeDir,
  getCoworkWorkspaceRootDir,
  getWorktreeAttachmentsDir,
} from '../lib/paths';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';

// Main-only acceptance/terminal evidence survives a missing or failed transcript
// import. Never reconstruct owner or timestamps when replaying an observation.
const terminalObservationSchema = z.object({
  id: z.string(),
  address: z.union([
    projectChatWatcherAddressSchema,
    botChatWatcherAddressSchema,
  ]),
  evidence: z.object({
    sourceOwner: z
      .union([
        z.object({ kind: z.literal('personal') }),
        z.object({
          kind: z.literal('organization'),
          organizationId: z.string(),
        }),
      ])
      .nullable(),
    resourceIncarnation: z.string().optional(),
  }),
  acceptedAt: z.string(),
  // Legacy sidecars retain the exclusion set until their pending turn settles.
  previousRootIds: z.array(z.string()).optional(),
  previousRootId: z.string().optional(),
  runtimeGeneration: z.string().optional(),
  sourceInputId: z.string().optional(),
  sourceInputAcceptedAt: z.string().optional(),
  startsChat: z.boolean(),
  startedDelivered: z.boolean().optional(),
  terminalAt: z.string().optional(),
  waitForDuration: z.boolean().optional(),
  disposition: z
    .enum(['completed', 'interrupted', 'error', 'no_output'])
    .optional(),
  terminalDelivered: z.boolean().optional(),
  transcriptPath: z.string().optional(),
});
export type TerminalObservation = z.infer<typeof terminalObservationSchema>;

/** A sibling of the disposable runtime, never part of a tab/renderer DTO. */
export function terminalWatcherObservationsPath(runtimeDir: string): string {
  return `${runtimeDir}.watcher-observations.json`;
}

export async function readTerminalWatcherObservations(
  runtimeDir: string,
): Promise<TerminalObservation[]> {
  let raw: string;
  try {
    raw = await readFile(terminalWatcherObservationsPath(runtimeDir), 'utf8');
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') return [];
    throw error;
  }
  const value: unknown = JSON.parse(raw);
  return z
    .object({
      version: z.literal(1),
      observations: z.array(terminalObservationSchema),
    })
    .parse(value).observations;
}

export async function writeTerminalWatcherObservations(
  runtimeDir: string,
  observations: TerminalObservation[],
): Promise<void> {
  const destination = terminalWatcherObservationsPath(runtimeDir);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFileAtomically(
    destination,
    JSON.stringify({
      version: 1,
      observations: observations.map((observation) =>
        terminalObservationSchema.parse(observation),
      ),
    }),
    { encoding: 'utf8', mode: 0o600, durable: true },
  );
}

export interface TranscriptSyncRequest {
  projectId: string;
  worktreeId: string;
  chatId: string;
  sessionKey: string;
  sdkSessionId: string;
  transcriptPath?: string;
  hookEventName: ClaudeTerminalHookEventName;
  hookPayload: unknown;
  suppressDeferredToolsReloadContinuation?: boolean;
  turnDiff?: TurnDiffData;
  persistChatState?: boolean;
  runtimeDir?: string;
  fallbackTurnTimer?: {
    id: string;
    startedAt?: number;
    completedAt: number;
  };
}

export interface TranscriptSyncResultWithMessages extends TranscriptSyncResult {
  /** Main-only durable turn context, including previously imported roots. */
  lifecycleMessages?: PersistedChatMessage[];
  transcriptReadComplete?: boolean;
  importedMessages: PersistedChatMessage[];
  /**
   * Raw transcript events (parsed JSONL lines) newly imported by this sync,
   * sanitized of inline base64 attachment payloads. Consumed by the
   * observability service to mirror terminal turns into audit transcripts.
   */
  importedEvents: unknown[];
}

interface CursorFile {
  version: 1;
  transcriptPath?: string;
  transcriptIdentity?: TranscriptFileIdentity;
  offset: number;
  importedEventIds: string[];
  updatedAt: number;
}

interface TranscriptFileIdentity {
  dev?: number;
  ino?: number;
  mtimeMs: number;
  size: number;
}

const IGNORED_CLAUDE_TRANSCRIPT_EVENT_TYPES = new Set([
  'ai-title',
  // Request records repeat conversation messages as API request blobs.
  'api-request',
  'api-request-blob',
  'api-request-shape',
  'attachment',
  'file-history-snapshot',
  'last-prompt',
  'mode',
  'permission-mode',
  'queue-operation',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, field: string): string | undefined {
  return isRecord(value) && typeof value[field] === 'string'
    ? value[field]
    : undefined;
}

function readBooleanField(value: unknown, field: string): boolean | undefined {
  return isRecord(value) && typeof value[field] === 'boolean'
    ? value[field]
    : undefined;
}

function compactionTrigger(value: unknown): 'auto' | 'manual' | 'unknown' {
  const trigger = (
    readStringField(value, 'trigger') ?? readStringField(value, 'reason')
  )?.toLowerCase();
  return trigger === 'auto' || trigger === 'manual' ? trigger : 'unknown';
}

function compactionPreTokens(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.preTokens ?? value.pre_tokens;
  return typeof candidate === 'number' &&
    Number.isFinite(candidate) &&
    candidate >= 0
    ? candidate
    : undefined;
}

function readNumberField(value: unknown, field: string): number | undefined {
  return isRecord(value) && typeof value[field] === 'number'
    ? value[field]
    : undefined;
}

function readClaudeSourceToolUseId(
  event: Record<string, unknown>,
): string | undefined {
  return (
    readStringField(event, 'sourceToolUseID') ??
    readStringField(event, 'sourceToolUseId') ??
    readStringField(event, 'source_tool_use_id')
  );
}

function claudeChainUuid(event: Record<string, unknown>): string | undefined {
  if (typeof event.parent_tool_use_id === 'string') return undefined;
  return isClaudeChainUuid(event.uuid) ? event.uuid : undefined;
}

/**
 * Build a completed turn-timer block from a turn-end transcript event. The
 * JSONL only records the completion timestamp plus a duration, so derive
 * `startedAt` from the duration — without it the renderer shows a plain
 * "Completed" with no elapsed time.
 */
function turnTimerBlock(
  completedAt: number,
  durationMs: number | undefined,
): PersistedChatBlock {
  return {
    type: 'turn_timer',
    completedAt,
    ...(typeof durationMs === 'number' && durationMs > 0
      ? { startedAt: completedAt - durationMs }
      : {}),
  };
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      typeof value === 'bigint'
    ) {
      return String(value);
    }
    return '[unserializable value]';
  }
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return stringifyValue(content);
  return content
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (isRecord(entry)) {
        return (
          readStringField(entry, 'text') ??
          readStringField(entry, 'content') ??
          stringifyValue(entry)
        );
      }
      return stringifyValue(entry);
    })
    .filter(Boolean)
    .join('\n');
}

function isClaudeLocalCommandText(text: string): boolean {
  return /<\/?(?:local-command-caveat|command-name|command-message|command-args|local-command-stdout|local-command-stderr)\b/i.test(
    text,
  );
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Internal harness notifications (background task completions and the like)
 * arrive as `user` events whose content is a `<task-notification>` /
 * `<task_notification>` block, with `origin.kind: 'task-notification'` on
 * newer Claude versions. They are not user-authored, so the import surfaces
 * them as system messages instead of user bubbles.
 */
function isClaudeTaskNotificationEvent(
  event: Record<string, unknown>,
  text: string,
): boolean {
  const origin = event.origin;
  if (isRecord(origin) && readStringField(origin, 'kind') !== undefined) {
    const kind = readStringField(origin, 'kind');
    if (kind === 'task-notification' || kind === 'task_notification') {
      return true;
    }
  }
  const trimmed = text.trimStart();
  return (
    trimmed.startsWith('<task-notification>') ||
    trimmed.startsWith('<task_notification>')
  );
}

function isClaudeUserInterruptionEvent(
  event: Record<string, unknown>,
  text: string,
): boolean {
  if (readStringField(event, 'interruptedMessageId') !== undefined) {
    return true;
  }
  const normalized = text.trim().replace(/\s+/g, ' ').toLowerCase();
  return (
    normalized === '[request interrupted by user]' ||
    normalized === '[request interrupted by user for tool use]'
  );
}

function isDeferredToolsReloadContinuationText(text: string): boolean {
  const normalized = stripTerminalPresentationMarker(text)
    .trim()
    .replace(/\s+/g, ' ');
  return (
    normalized ===
    '<system_instruction>Requested items now enabled, continue the interrupted request.</system_instruction>'
  );
}

/**
 * `/model` runs inside the TUI surface as a local command whose stdout is
 * `Set model to <model>`. Local-command chatter is normally dropped, but a
 * model change is conversation-relevant state — surface it as a system note.
 */
function extractClaudeModelChangeText(text: string): string | undefined {
  const match =
    /<local-command-stdout>\s*(Set model to[^<\n]*)/i.exec(text) ??
    /^Set model to\s+(.+)$/im.exec(text);
  if (!match?.[1]) {
    return undefined;
  }
  const stdout = stripAnsi(match[1]).trim();
  return stdout.length > 0 ? stdout : undefined;
}

/**
 * Resolve the configured model id behind a `/model` stdout line so the
 * Canopy model picker can follow terminal-initiated switches. The stdout
 * carries a display label (“Set model to Sonnet 5 and saved as your
 * default for new sessions”) or occasionally a raw id.
 */
function resolveClaudeModelFromChangeText(text: string): ChatModel | undefined {
  const match = /^Set model to\s+(.+)$/i.exec(text.trim());
  if (!match?.[1]) return undefined;
  const raw = match[1]
    .replace(/\s+and saved\b.*$/i, '')
    .replace(/\.\s*$/, '')
    .trim();
  return findClaudeModelByLabel(raw);
}

interface ExtractedEventAttachments {
  /** Event copy with inline base64 payloads removed. */
  event: Record<string, unknown>;
  /** Absolute paths of attachment files written to the attachments dir. */
  attachmentPaths: string[];
}

function isInlineBase64AttachmentItem(item: unknown): item is {
  type: 'image' | 'document';
  source: { type: 'base64'; media_type?: string; data: string };
} {
  if (!isRecord(item)) return false;
  const type = readStringField(item, 'type');
  if (type !== 'image' && type !== 'document') return false;
  const source = item.source;
  return (
    isRecord(source) &&
    readStringField(source, 'type') === 'base64' &&
    typeof source.data === 'string' &&
    source.data.length > 0
  );
}

/**
 * Persist inline base64 image/document attachments from a user event into
 * the chat's attachments directory and strip the payloads from the event so
 * neither the chat transcript nor the audit sidecar embeds megabytes of
 * base64. Returns the original event untouched when nothing applies.
 */
async function extractInlineAttachments(
  event: Record<string, unknown>,
  attachmentsDir: string,
  errors: string[],
): Promise<ExtractedEventAttachments> {
  const message = isRecord(event.message) ? event.message : undefined;
  const content = message?.content;
  if (!Array.isArray(content) || !content.some(isInlineBase64AttachmentItem)) {
    return { event, attachmentPaths: [] };
  }
  const attachmentPaths: string[] = [];
  const sanitizedContent: unknown[] = [];
  for (const item of content) {
    if (!isInlineBase64AttachmentItem(item)) {
      sanitizedContent.push(item);
      continue;
    }
    const mediaType = readStringField(item.source, 'media_type') ?? '';
    const extension = ATTACHMENT_MEDIA_TYPE_EXTENSIONS[mediaType] ?? 'bin';
    // Hash the decoded bytes (not the base64 text) so the filename is
    // canonical for the binary payload regardless of base64 padding or
    // line-wrapping differences between transcript writes.
    const payload = Buffer.from(item.source.data, 'base64');
    const digest = createHash('sha256')
      .update(payload)
      .digest('hex')
      .slice(0, 16);
    const filePath = path.join(
      attachmentsDir,
      `claude-terminal-${digest}.${extension}`,
    );
    try {
      await mkdir(attachmentsDir, { recursive: true });
      // 'wx' keeps replayed syncs idempotent — identical payloads hash to
      // the same name and the existing file wins.
      await writeFile(filePath, payload, { flag: 'wx' });
      attachmentPaths.push(filePath);
    } catch (error) {
      if (isRecord(error) && readStringField(error, 'code') === 'EEXIST') {
        attachmentPaths.push(filePath);
      } else {
        errors.push(
          `Failed to persist Claude transcript attachment: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
  return {
    event: {
      ...event,
      message: { ...message, content: sanitizedContent },
    },
    attachmentPaths,
  };
}

function isClaudeSyntheticNoResponseMessage(
  message: Record<string, unknown> | undefined,
  blocks: PersistedChatBlock[],
): boolean {
  if (readStringField(message, 'model') !== CLAUDE_SYNTHETIC_MODEL_SENTINEL) {
    return false;
  }
  if (blocks.length !== 1) return false;
  const block = blocks[0];
  return (
    block?.type === 'text' && block.text.trim() === 'No response requested.'
  );
}

function eventTimestamp(event: Record<string, unknown>): number {
  const timestamp = event.timestamp;
  if (typeof timestamp === 'number') return timestamp;
  if (typeof timestamp === 'string') {
    const parsed = Date.parse(timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function projectAssistantContent(content: unknown): PersistedChatBlock[] {
  const items = Array.isArray(content)
    ? content
    : [{ type: 'text', text: content }];
  const blocks: PersistedChatBlock[] = [];
  for (const item of items) {
    if (!isRecord(item)) {
      const text = stripMemoryCitationTags(stringifyValue(item));
      if (text) blocks.push({ type: 'text', text });
      continue;
    }
    switch (readStringField(item, 'type')) {
      case 'text': {
        const text = stripMemoryCitationTags(
          readStringField(item, 'text') ?? '',
        );
        if (text) blocks.push({ type: 'text', text });
        break;
      }
      case 'thinking': {
        const text = stripMemoryCitationTags(
          readStringField(item, 'thinking') ??
            readStringField(item, 'text') ??
            '',
        );
        if (text) blocks.push({ type: 'thinking', text });
        break;
      }
      case 'tool_use':
        blocks.push({
          type: 'tool_use',
          toolUseId: readStringField(item, 'id') ?? stableId(item),
          toolName: readStringField(item, 'name') ?? 'unknown',
          input: stringifyValue(item.input ?? {}),
        });
        break;
    }
  }
  return blocks;
}

function projectToolResults(content: unknown): PersistedChatBlock[] {
  const items = Array.isArray(content) ? content : [content];
  const blocks: PersistedChatBlock[] = [];
  for (const item of items) {
    if (!isRecord(item) || readStringField(item, 'type') !== 'tool_result') {
      continue;
    }
    blocks.push({
      type: 'tool_result',
      toolUseId: readStringField(item, 'tool_use_id') ?? stableId(item),
      toolName:
        readStringField(item, 'tool_name') ??
        readStringField(item, 'name') ??
        '',
      output: contentText(item.content),
      isError: readBooleanField(item, 'is_error') ?? false,
    });
  }
  return blocks;
}

function buildResultMetadata(event: Record<string, unknown>): string {
  const lines = ['Claude Code result metadata'];
  const subtype = readStringField(event, 'subtype');
  const result = readStringField(event, 'result');
  const error = readStringField(event, 'error');
  if (subtype) lines.push(`Status: ${subtype}`);
  if (result) lines.push(`Result: ${result}`);
  if (error) lines.push(`Error: ${error}`);
  if (isRecord(event.usage)) {
    const usageParts = Object.entries(event.usage)
      .filter(([, value]) => typeof value === 'number')
      .map(([key, value]) => `${key}: ${String(value)}`);
    if (usageParts.length > 0) {
      lines.push(`Usage: ${usageParts.join(', ')}`);
    }
  }
  return lines.join('\n');
}

function stableId(event: unknown): string {
  if (isRecord(event)) {
    const direct =
      readStringField(event, 'uuid') ??
      readStringField(event, 'id') ??
      readStringField(event, 'message_id');
    if (direct) return direct;
  }
  return createHash('sha256')
    .update(JSON.stringify(event))
    .digest('hex')
    .slice(0, 32);
}

function readTranscriptIdentity(
  value: unknown,
): TranscriptFileIdentity | undefined {
  if (!isRecord(value)) return undefined;
  const mtimeMs = value.mtimeMs;
  const size = value.size;
  if (typeof mtimeMs !== 'number' || typeof size !== 'number') {
    return undefined;
  }
  return {
    ...(typeof value.dev === 'number' ? { dev: value.dev } : {}),
    ...(typeof value.ino === 'number' ? { ino: value.ino } : {}),
    mtimeMs,
    size,
  };
}

function hasStableInode(identity: TranscriptFileIdentity): boolean {
  return (
    typeof identity.dev === 'number' &&
    typeof identity.ino === 'number' &&
    identity.ino > 0
  );
}

function transcriptIdentityChanged(
  previous: TranscriptFileIdentity | undefined,
  next: TranscriptFileIdentity,
): boolean {
  if (!previous) return false;
  if (hasStableInode(previous) && hasStableInode(next)) {
    return previous.dev !== next.dev || previous.ino !== next.ino;
  }
  return previous.mtimeMs !== next.mtimeMs || previous.size !== next.size;
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

export function isAllowedClaudeTerminalTranscriptPath(
  transcriptPath: string,
  runtimeDir: string,
): boolean {
  if (!path.isAbsolute(transcriptPath)) {
    return false;
  }
  const allowedRoots = [
    getClaudeCodeProjectsDir(),
    path.join(homedir(), '.claude', 'projects'),
    runtimeDir,
  ];
  return allowedRoots.some((root) => isPathInside(root, transcriptPath));
}

function transcriptIdentityFromStat(fileStat: {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
}): TranscriptFileIdentity {
  return {
    dev: fileStat.dev,
    ino: fileStat.ino,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
  };
}

const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;

async function readTranscriptSlice(
  transcriptPath: string,
  requestedOffset: number,
  previousIdentity: TranscriptFileIdentity | undefined,
): Promise<{
  slice: string;
  offset: number;
  identity: TranscriptFileIdentity;
}> {
  // Stat and read through the same handle so a path replacement cannot pair
  // one file's identity with another file's bytes.
  const file = await open(transcriptPath, 'r');
  try {
    let fileStat = await file.stat();
    let identity = transcriptIdentityFromStat(fileStat);
    let offset = transcriptIdentityChanged(previousIdentity, identity)
      ? 0
      : requestedOffset;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const upperBound = fileStat.size;
      if (offset > upperBound) offset = 0;
      const readBuffer = Buffer.allocUnsafe(
        Math.min(TRANSCRIPT_READ_CHUNK_BYTES, upperBound - offset),
      );
      let position = offset;
      const decoder = new StringDecoder('utf8');
      const decodedParts: string[] = [];
      while (position < upperBound) {
        const length = Math.min(readBuffer.byteLength, upperBound - position);
        const { bytesRead } = await file.read(readBuffer, 0, length, position);
        if (bytesRead === 0) break;
        decodedParts.push(decoder.write(readBuffer.subarray(0, bytesRead)));
        position += bytesRead;
      }

      if (position < upperBound && attempt === 0) {
        // A file can shrink after fstat and before the positioned read. Retry
        // once from zero on that same handle so the replacement is visible in
        // this sync, while leaving further racing writes to the next hook.
        const refreshedStat = await file.stat();
        if (
          refreshedStat.size !== upperBound ||
          refreshedStat.mtimeMs !== fileStat.mtimeMs
        ) {
          fileStat = refreshedStat;
          identity = transcriptIdentityFromStat(fileStat);
          offset = 0;
          continue;
        }
      }

      const finalPart = decoder.end();
      if (finalPart) decodedParts.push(finalPart);
      return {
        slice: decodedParts.join(''),
        offset,
        identity,
      };
    }
    throw new Error('Unable to read Claude transcript after truncation');
  } finally {
    await file.close();
  }
}

async function readCursor(cursorPath: string): Promise<CursorFile> {
  try {
    const parsed: unknown = JSON.parse(await readFile(cursorPath, 'utf8'));
    if (isRecord(parsed) && parsed.version === 1) {
      return {
        version: 1,
        transcriptPath: readStringField(parsed, 'transcriptPath'),
        transcriptIdentity: readTranscriptIdentity(parsed.transcriptIdentity),
        offset:
          typeof parsed.offset === 'number' && parsed.offset >= 0
            ? parsed.offset
            : 0,
        importedEventIds: Array.isArray(parsed.importedEventIds)
          ? parsed.importedEventIds.filter(
              (value): value is string => typeof value === 'string',
            )
          : [],
        updatedAt:
          typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
      };
    }
  } catch {
    // Missing or malformed cursor starts from the beginning.
  }
  return { version: 1, offset: 0, importedEventIds: [], updatedAt: Date.now() };
}

function projectEventToMessage(
  event: unknown,
  options?: {
    hasExtractedAttachments?: boolean;
    suppressDeferredToolsReloadContinuation?: boolean;
  },
): PersistedChatMessage | null {
  if (!isRecord(event)) return null;
  const type = readStringField(event, 'type');
  const role = readStringField(event, 'role');
  const message = isRecord(event.message) ? event.message : undefined;
  const messageRole = readStringField(message, 'role');
  const messageContent = message?.content;
  const timestamp = eventTimestamp(event);

  if (type && IGNORED_CLAUDE_TRANSCRIPT_EVENT_TYPES.has(type)) {
    return null;
  }

  if (type === 'assistant' || messageRole === 'assistant') {
    const blocks = projectAssistantContent(messageContent ?? event.content);
    if (blocks.length === 0) return null;
    if (isClaudeSyntheticNoResponseMessage(message, blocks)) return null;
    const chainUuid = claudeChainUuid(event);
    return {
      id: stableId(event),
      role: 'assistant',
      timestamp,
      blocks,
      ...(chainUuid ? { claudeUuid: chainUuid } : {}),
      ...(readStringField(event, 'parent_tool_use_id')
        ? { parentToolUseId: readStringField(event, 'parent_tool_use_id') }
        : {}),
    };
  }

  if (type === 'user' || role === 'user' || messageRole === 'user') {
    const toolResultBlocks = projectToolResults(
      messageContent ?? event.content,
    );
    if (toolResultBlocks.length > 0) {
      const chainUuid = claudeChainUuid(event);
      return {
        id: stableId(event),
        role: 'system',
        timestamp,
        blocks: toolResultBlocks,
        ...(chainUuid ? { claudeUuid: chainUuid } : {}),
        ...(readStringField(event, 'parent_tool_use_id')
          ? { parentToolUseId: readStringField(event, 'parent_tool_use_id') }
          : {}),
      };
    }
    const text = contentText(messageContent ?? event.content);
    const sourceToolUseId = readClaudeSourceToolUseId(event);
    if (readBooleanField(event, 'isMeta') === true && sourceToolUseId) {
      const output = text.trim();
      if (!output) return null;
      return {
        id: stableId(event),
        role: 'system',
        timestamp,
        blocks: [
          {
            type: 'tool_result',
            toolUseId: sourceToolUseId,
            toolName: '',
            output,
            isError: false,
          },
        ],
        ...(readStringField(event, 'parent_tool_use_id')
          ? { parentToolUseId: readStringField(event, 'parent_tool_use_id') }
          : {}),
      };
    }
    if (isClaudeTaskNotificationEvent(event, text)) {
      // Parity with the Canopy-native renderer: harness task notifications
      // are internal continuation prompts, not conversation content. The
      // Canopy-native chat never shows them in the transcript (they only
      // feed agent-usage/background-task state), so keep them out of the
      // imported chat too. The raw event still reaches the audit-trail
      // transcript via `importedEvents`.
      return null;
    }
    if (isClaudeUserInterruptionEvent(event, text)) {
      // Claude Code writes cancellation as a synthetic user transcript entry.
      // Native Canopy cancellation ends the turn without adding a bubble, so
      // keep this marker out of imported chat messages.
      return null;
    }
    if (
      options?.suppressDeferredToolsReloadContinuation === true &&
      isDeferredToolsReloadContinuationText(text)
    ) {
      // Deferred-tools reload continuations are injected system instructions
      // used only to resume the interrupted provider turn. Keep the raw JSONL
      // and audit record, but never import it as a visible terminal user row.
      return null;
    }
    if (isClaudeLocalCommandText(text)) {
      const modelChangeText = extractClaudeModelChangeText(text);
      if (modelChangeText) {
        return {
          id: stableId(event),
          role: 'system',
          timestamp,
          blocks: [{ type: 'text', text: modelChangeText }],
        };
      }
      return null;
    }
    const sanitizedText = sanitizeImportedUserText(text);
    if (sanitizedText || options?.hasExtractedAttachments === true) {
      return {
        id: stableId(event),
        role: 'user',
        timestamp,
        blocks: [{ type: 'text', text: sanitizedText }],
      };
    }
    if (text) {
      // The text reduced to pure attachment artifacts (e.g. a standalone
      // `[Image: source: …]` reference line) — nothing user-authored to show.
      return null;
    }
  }

  if (type === 'tool_use') {
    return {
      id: stableId(event),
      role: 'assistant',
      timestamp,
      blocks: [
        {
          type: 'tool_use',
          toolUseId: readStringField(event, 'id') ?? stableId(event),
          toolName: readStringField(event, 'name') ?? 'unknown',
          input: stringifyValue(event.input ?? {}),
        },
      ],
    };
  }

  if (type === 'tool_result') {
    return {
      id: stableId(event),
      role: 'system',
      timestamp,
      blocks: [
        {
          type: 'tool_result',
          toolUseId: readStringField(event, 'tool_use_id') ?? stableId(event),
          toolName:
            readStringField(event, 'tool_name') ??
            readStringField(event, 'name') ??
            '',
          output: contentText(event.content ?? event.output),
          isError: readBooleanField(event, 'is_error') ?? false,
        },
      ],
    };
  }

  if (type === 'result' || type === 'error') {
    return {
      id: stableId(event),
      role: 'system',
      timestamp,
      blocks: [
        turnTimerBlock(timestamp, readNumberField(event, 'duration_ms')),
      ],
      ...(readStringField(event, 'parent_tool_use_id')
        ? { parentToolUseId: readStringField(event, 'parent_tool_use_id') }
        : {}),
    };
  }

  if (
    type === 'system' &&
    readStringField(event, 'subtype') === 'turn_duration'
  ) {
    return {
      id: stableId(event),
      role: 'system',
      timestamp,
      blocks: [turnTimerBlock(timestamp, readNumberField(event, 'durationMs'))],
      ...(readStringField(event, 'parent_tool_use_id')
        ? { parentToolUseId: readStringField(event, 'parent_tool_use_id') }
        : {}),
    };
  }

  if (
    readStringField(event, 'subtype') === 'task_progress' ||
    readStringField(event, 'subtype') === 'task_notification'
  ) {
    return {
      id: stableId(event),
      role: 'system',
      timestamp,
      blocks: [{ type: 'text', text: buildResultMetadata(event) }],
      ...(readStringField(event, 'parent_tool_use_id')
        ? { parentToolUseId: readStringField(event, 'parent_tool_use_id') }
        : {}),
    };
  }

  const text =
    readStringField(event, 'text') ??
    readStringField(event, 'content') ??
    readStringField(event, 'message');
  if (!text) return null;
  if (role === 'user' || type === 'user') {
    return {
      id: stableId(event),
      role: 'user',
      timestamp,
      blocks: [{ type: 'text', text }],
    };
  }
  const visibleText = stripMemoryCitationTags(text);
  if (!visibleText) return null;
  return {
    id: stableId(event),
    role: 'assistant',
    timestamp,
    blocks: [
      {
        type: type === 'thinking' ? 'thinking' : 'text',
        text: visibleText,
      },
    ],
  };
}

/**
 * Pure projection of one Claude Code transcript record into a persisted chat
 * message, shared with the bulk project import (CAN-2439) so imported
 * histories render exactly like terminal-mode chats. Returns `null` for
 * records that carry no conversation content.
 */
export function projectClaudeTranscriptEventToMessage(
  event: unknown,
  options?: { hasExtractedAttachments?: boolean },
): PersistedChatMessage | null {
  return projectEventToMessage(event, options);
}

/**
 * Bulk-import counterpart of the sync path's attachment step (CAN-2439):
 * writes inline base64 image/document payloads into `attachmentsDir` and
 * returns the event with those payloads removed, so imported transcripts
 * never embed megabytes of base64 as text.
 */
export function extractClaudeTranscriptEventAttachments(
  event: Record<string, unknown>,
  attachmentsDir: string,
  errors: string[],
): Promise<{ event: Record<string, unknown>; attachmentPaths: string[] }> {
  return extractInlineAttachments(event, attachmentsDir, errors);
}

/**
 * Drops inline base64 payloads without persisting them, for projections
 * that have no attachment directory. Reports whether anything was removed
 * so a text-free image turn still projects as a user message.
 */
export function stripClaudeTranscriptInlineAttachments(
  event: Record<string, unknown>,
): { event: Record<string, unknown>; stripped: boolean } {
  const message = isRecord(event.message) ? event.message : undefined;
  const content = message?.content;
  if (!Array.isArray(content) || !content.some(isInlineBase64AttachmentItem)) {
    return { event, stripped: false };
  }
  return {
    event: {
      ...event,
      message: {
        ...message,
        content: content.filter((item) => !isInlineBase64AttachmentItem(item)),
      },
    },
    stripped: true,
  };
}

/**
 * Layout-only messages are excluded from transcript comparison. Backed by the
 * shared `LAYOUT_BLOCK_TYPES` set so main and the renderer cannot drift again
 * — this copy used to be missing `claude_terminal_sync_warning`, so the two
 * dedupers disagreed about that one variant (CAN-3083).
 */
function isTranscriptLayoutMessage(message: PersistedChatMessage): boolean {
  return message.blocks.every((block) => LAYOUT_BLOCK_TYPES.has(block.type));
}

function messageHasTurnTimer(message: PersistedChatMessage): boolean {
  return message.blocks.some((block) => block.type === 'turn_timer');
}

function messagesHaveTurnTimer(messages: PersistedChatMessage[]): boolean {
  return messages.some(messageHasTurnTimer);
}

function messageFingerprint(message: PersistedChatMessage): string {
  return `${message.role}:${message.blocks.map(blockFingerprint).join('|')}`;
}

function comparableMessages(
  messages: PersistedChatMessage[],
): Array<{ index: number; fingerprint: string }> {
  const result: Array<{ index: number; fingerprint: string }> = [];
  messages.forEach((message, index) => {
    if (!isTranscriptLayoutMessage(message)) {
      result.push({ index, fingerprint: messageFingerprint(message) });
    }
  });
  return result;
}

function dropReplayedExistingPrefix(
  existing: PersistedChatMessage[],
  incoming: PersistedChatMessage[],
): PersistedChatMessage[] {
  const existingComparable = comparableMessages(existing);
  const incomingComparable = comparableMessages(incoming);
  const max = Math.min(existingComparable.length, incomingComparable.length);
  for (let count = max; count > 0; count -= 1) {
    let matches = true;
    for (let i = 0; i < count; i += 1) {
      const existingIndex = existingComparable.length - count + i;
      if (
        existingComparable[existingIndex]?.fingerprint !==
        incomingComparable[i]?.fingerprint
      ) {
        matches = false;
        break;
      }
    }
    if (matches) {
      let start = (incomingComparable[count - 1]?.index ?? -1) + 1;
      while (
        start < incoming.length &&
        isTranscriptLayoutMessage(incoming[start])
      ) {
        start += 1;
      }
      return incoming.slice(start);
    }
  }
  return incoming;
}

function appendUnique<T extends { id: string }>(items: T[], item: T): T[] {
  return items.some((candidate) => candidate.id === item.id)
    ? items
    : [...items, item];
}

function latestUserMessageWithoutTurnDiff(
  messages: PersistedChatMessage[],
  turnDiffs: Record<string, TurnDiffData> | undefined,
): PersistedChatMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user' && !turnDiffs?.[message.id]) {
      return message;
    }
  }
  return undefined;
}

function resolveTurnDiffUserMessageId(
  existingMessages: PersistedChatMessage[],
  importedMessages: PersistedChatMessage[],
  existingTurnDiffs: Record<string, TurnDiffData> | undefined,
): string | undefined {
  const importedUserMessage = importedMessages.find(
    (message) => message.role === 'user',
  );
  if (importedUserMessage) {
    return importedUserMessage.id;
  }
  return latestUserMessageWithoutTurnDiff(existingMessages, existingTurnDiffs)
    ?.id;
}

export function syncClaudeTerminalTranscript(
  input: TranscriptSyncRequest,
): Promise<TranscriptSyncResultWithMessages> {
  if (input.persistChatState === false) {
    return syncClaudeTerminalTranscriptUnlocked(input);
  }
  return enqueueChatTabMutation(input.projectId, input.worktreeId, () =>
    syncClaudeTerminalTranscriptUnlocked(input),
  );
}

async function syncClaudeTerminalTranscriptUnlocked(
  input: TranscriptSyncRequest,
): Promise<TranscriptSyncResultWithMessages> {
  const runtimeDir =
    input.runtimeDir ??
    getClaudeTerminalRuntimeDir(
      input.projectId,
      input.worktreeId,
      input.chatId,
    );
  const cursorPath = path.join(runtimeDir, 'transcript-cursor.json');
  const cursor = await readCursor(cursorPath);
  const candidateTranscriptPath = input.transcriptPath ?? cursor.transcriptPath;
  const transcriptPath =
    candidateTranscriptPath &&
    isAllowedClaudeTerminalTranscriptPath(candidateTranscriptPath, runtimeDir)
      ? path.resolve(candidateTranscriptPath)
      : undefined;
  const errors: string[] = [];
  if (candidateTranscriptPath && !transcriptPath) {
    errors.push(
      'Rejected Claude terminal transcript path outside allowed roots.',
    );
  }
  let transcriptReadComplete = false;
  let importedEventCount = 0;
  let offset = cursor.offset;
  let transcriptIdentity: TranscriptFileIdentity | undefined =
    cursor.transcriptIdentity;
  const messages: PersistedChatMessage[] = [];
  const importedEvents: unknown[] = [];
  let detectedModel: ChatModel | undefined;
  let detectedPlanMode: boolean | undefined;
  const persistChatState = input.persistChatState !== false;
  const attachmentsDir =
    input.projectId === STANDALONE_CHAT_PROJECT_ID
      ? getCoworkManagedSubdir(
          getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(input.worktreeId)),
          'attachments',
        )
      : getWorktreeAttachmentsDir(input.projectId, input.worktreeId);
  let replayedFromStart = false;
  const tabsFile = persistChatState
    ? await readChatTabsFile(input.projectId, input.worktreeId, {
        chatIds: [input.chatId],
        fullTranscript: true,
      })
    : await readChatTabsFile(input.projectId, input.worktreeId, {
        chatIds: [input.chatId],
        fullTranscript: true,
      });
  const targetTab = tabsFile?.tabs.find((tab) => tab.id === input.chatId);
  const reconcileFromStart =
    persistChatState &&
    Boolean(transcriptPath) &&
    cursor.offset > 0 &&
    (targetTab === undefined || targetTab.messages.length === 0);
  const imported = new Set(
    reconcileFromStart
      ? (targetTab?.messages.map((message) => message.id) ?? [])
      : cursor.importedEventIds,
  );
  const suppressDeferredToolsReloadContinuation =
    input.suppressDeferredToolsReloadContinuation === true;

  if (transcriptPath) {
    if (transcriptPath !== cursor.transcriptPath || reconcileFromStart) {
      offset = 0;
    }
    try {
      const read = await readTranscriptSlice(
        transcriptPath,
        offset,
        transcriptPath === cursor.transcriptPath
          ? cursor.transcriptIdentity
          : undefined,
      );
      offset = read.offset;
      replayedFromStart = offset === 0;
      const slice = read.slice;
      const completeLinePattern = /([^\r\n]*)(\r?\n)/g;
      let consumedBytes = 0;
      let lastCompleteLineEnd = 0;
      const linesToImport: string[] = [];
      let match: RegExpExecArray | null;
      while ((match = completeLinePattern.exec(slice)) !== null) {
        const line = match[1] ?? '';
        consumedBytes += Buffer.byteLength(match[0] ?? '', 'utf8');
        lastCompleteLineEnd = match.index + (match[0]?.length ?? 0);
        linesToImport.push(line);
      }
      const trailingLine = slice.slice(lastCompleteLineEnd);
      if (trailingLine.trim()) {
        try {
          JSON.parse(trailingLine);
          consumedBytes += Buffer.byteLength(trailingLine, 'utf8');
          linesToImport.push(trailingLine);
        } catch {
          // Leave an incomplete trailing write unread for the next sync.
        }
      } else {
        consumedBytes += Buffer.byteLength(trailingLine, 'utf8');
      }
      for (const line of linesToImport) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          const id = stableId(parsed);
          if (imported.has(id)) continue;
          imported.add(id);
          // Terminal-initiated settings changes: `/model` stdout lines and
          // permission-mode entries reflect TUI-side switches the Canopy
          // pickers must follow. Later entries win within a sync.
          if (isRecord(parsed)) {
            if (readStringField(parsed, 'type') === 'permission-mode') {
              const permissionMode = readStringField(parsed, 'permissionMode');
              if (permissionMode) {
                detectedPlanMode = permissionMode === 'plan';
              }
            } else {
              const eventMessage = isRecord(parsed.message)
                ? parsed.message
                : undefined;
              const rawText = contentText(
                eventMessage?.content ?? parsed.content,
              );
              if (isClaudeLocalCommandText(rawText)) {
                const changeText = extractClaudeModelChangeText(rawText);
                const changedModel = changeText
                  ? resolveClaudeModelFromChangeText(changeText)
                  : undefined;
                if (changedModel) {
                  detectedModel = changedModel;
                }
              }
            }
          }
          // Persist inline base64 attachments to disk and work with the
          // sanitized event from here on so neither the chat transcript nor
          // the audit sidecar carries the raw payloads.
          let event: unknown = parsed;
          let attachmentPaths: string[] = [];
          if (isRecord(parsed)) {
            const extracted = await extractInlineAttachments(
              parsed,
              attachmentsDir,
              errors,
            );
            event = extracted.event;
            attachmentPaths = extracted.attachmentPaths;
          }
          const projectedMessage = projectEventToMessage(event, {
            hasExtractedAttachments: attachmentPaths.length > 0,
            suppressDeferredToolsReloadContinuation,
          });
          const message =
            projectedMessage && targetTab
              ? correlateTerminalAgentMessage(targetTab, projectedMessage)
              : projectedMessage;
          if (message) {
            if (attachmentPaths.length > 0 && message.role === 'user') {
              message.attachmentPaths = Array.from(
                new Set([
                  ...(message.attachmentPaths ?? []),
                  ...attachmentPaths,
                ]),
              );
            }
            messages.push(message);
            importedEventCount += 1;
          }
          importedEvents.push(event);
        } catch {
          errors.push('Skipped malformed Claude transcript event.');
        }
      }
      transcriptReadComplete =
        consumedBytes === Buffer.byteLength(slice, 'utf8');
      offset += consumedBytes;
      transcriptIdentity = read.identity;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  } else {
    transcriptIdentity = undefined;
  }

  let compactionAppended = false;
  if (input.hookEventName === 'PostCompact') {
    const sourceEventId =
      readStringField(input.hookPayload, 'uuid') ??
      readStringField(input.hookPayload, 'id') ??
      `postcompact:${input.sdkSessionId}:${String(offset)}:${stableId(input.hookPayload)}`;
    if (!imported.has(sourceEventId)) {
      imported.add(sourceEventId);
      const at = new Date().toISOString();
      const preTokens = compactionPreTokens(input.hookPayload);
      const compactionBlock: CompactionInfoBlock = {
        type: 'compaction_info',
        timestamp: Date.parse(at),
        provider: 'claude',
        interfaceMode: 'claude-code',
        sessionId: input.sdkSessionId,
        reason:
          readStringField(input.hookPayload, 'trigger') ??
          readStringField(input.hookPayload, 'reason'),
        summary:
          readStringField(input.hookPayload, 'compact_summary') ??
          readStringField(input.hookPayload, 'summary'),
        transcriptPath,
        sourceEventId,
      };
      messages.push({
        id: sourceEventId,
        role: 'assistant',
        timestamp: Date.now(),
        blocks: [compactionBlock],
      });
      importedEvents.push({
        type: 'canopy_compaction',
        id: sourceEventId,
        at,
        trigger: compactionTrigger(input.hookPayload),
        ...(preTokens === undefined ? {} : { preTokens }),
      });
      compactionAppended = true;
      importedEventCount += 1;
    }
  }

  let shouldAdvanceCursor = true;
  let importedMessages = messages;
  if (messages.length > 0 && replayedFromStart && targetTab) {
    importedMessages = dropReplayedExistingPrefix(targetTab.messages, messages);
    importedEventCount = importedMessages.length;
  }
  if (
    input.fallbackTurnTimer &&
    !messagesHaveTurnTimer(importedMessages) &&
    !targetTab?.messages.some(
      (message) => message.id === input.fallbackTurnTimer?.id,
    )
  ) {
    const timerBlock: PersistedChatBlock = {
      type: 'turn_timer',
      ...(typeof input.fallbackTurnTimer.startedAt === 'number'
        ? { startedAt: input.fallbackTurnTimer.startedAt }
        : {}),
      completedAt: input.fallbackTurnTimer.completedAt,
    };
    importedMessages = [
      ...importedMessages,
      {
        id: input.fallbackTurnTimer.id,
        role: 'system',
        timestamp: input.fallbackTurnTimer.completedAt,
        blocks: [timerBlock],
      },
    ];
    importedEventCount += 1;
  }

  // Settings the TUI changed out from under the Canopy tab. Only report a
  // delta against the persisted tab so replayed session-start entries (which
  // always restate the launch configuration) stay no-ops.
  const settingsSync: ClaudeTerminalSettingsSync = {
    ...(detectedModel !== undefined && detectedModel !== targetTab?.model
      ? { model: detectedModel }
      : {}),
    ...(detectedPlanMode !== undefined &&
    detectedPlanMode !== (targetTab?.planMode ?? false)
      ? { planMode: detectedPlanMode }
      : {}),
  };
  const hasSettingsSync = Object.keys(settingsSync).length > 0;
  const turnDiffUserMessageId =
    input.turnDiff && targetTab
      ? resolveTurnDiffUserMessageId(
          targetTab.messages,
          importedMessages,
          targetTab.turnDiffs,
        )
      : undefined;
  const turnDiffs =
    input.turnDiff && turnDiffUserMessageId
      ? { [turnDiffUserMessageId]: input.turnDiff }
      : undefined;
  const hasTurnDiffs = turnDiffs !== undefined;
  if (input.turnDiff && !turnDiffUserMessageId) {
    errors.push(
      'Captured Claude Code terminal turn diff but could not match it to a user message.',
    );
  }

  if (
    persistChatState &&
    tabsFile &&
    (importedMessages.length > 0 ||
      (hasSettingsSync && targetTab) ||
      hasTurnDiffs)
  ) {
    let matchedTargetTab = false;
    const updatedTabs = tabsFile.tabs.map((tab) => {
      if (tab.id !== input.chatId) {
        return tab;
      }
      matchedTargetTab = true;
      return {
        ...settleTerminalAgentImports(tab, importedMessages, Date.now()),
        messages: importedMessages.reduce(appendUnique, tab.messages),
        ...(settingsSync.model !== undefined
          ? { model: settingsSync.model }
          : {}),
        ...(settingsSync.planMode !== undefined
          ? { planMode: settingsSync.planMode }
          : {}),
        ...(turnDiffs
          ? {
              turnDiffs: {
                ...tab.turnDiffs,
                ...turnDiffs,
              },
            }
          : {}),
      };
    });
    if (matchedTargetTab) {
      await writeChatTabsFile(input.projectId, input.worktreeId, {
        ...tabsFile,
        tabs: updatedTabs,
      });
    } else {
      errors.push(
        `${BRAND.displayName} chat tab was not present in persisted tabs during Claude Code transcript sync.`,
      );
      shouldAdvanceCursor = false;
    }
  }

  if (shouldAdvanceCursor) {
    await mkdir(path.dirname(cursorPath), { recursive: true });
    await writeFile(
      cursorPath,
      JSON.stringify(
        {
          version: 1,
          transcriptPath,
          transcriptIdentity,
          offset,
          importedEventIds: Array.from(imported).slice(-500),
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf8',
    );
  }

  return {
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    chatId: input.chatId,
    importedEventCount,
    importedMessages,
    lifecycleMessages: importedMessages.reduce(
      appendUnique,
      targetTab?.messages ?? [],
    ),
    transcriptReadComplete: transcriptReadComplete && errors.length === 0,
    importedEvents,
    transcriptPath,
    replayedFromStart,
    compactionAppended,
    ...(hasSettingsSync ? { settingsSync } : {}),
    ...(turnDiffs ? { turnDiffs } : {}),
    ...(errors.length > 0 ? { errors } : {}),
  };
}
