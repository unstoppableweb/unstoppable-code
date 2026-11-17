import type {
  ContentBlock,
  InitializeResponse,
} from '@agentclientprotocol/sdk';
import { lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  ACP_ATTACHMENT_LIMITS,
  AcpAttachmentTypeError,
  acpAttachmentEncodedBytes,
  isAcpImagePath,
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

/** Why an earlier attachment was not restored. */
export type AntigravityUnrestoredReason =
  /** Missing, changed, unreadable or outside the upload folder. */
  | 'unavailable'
  /** Too large for one attachment, or did not fit in what remained of the per-prompt limits. */
  | 'over-limit'
  /** An image, and the runtime does not accept images. */
  | 'images-unsupported'
  /** A file type Google chats refuse: PDF, or content that is not UTF-8 text. */
  | 'unsupported-type';

export interface AntigravityUnrestoredAttachment {
  path: string;
  reason: AntigravityUnrestoredReason;
}

export interface AntigravityHistoricalAttachments {
  /** Content blocks in transcript order, ready to follow the restored history. */
  blocks: ContentBlock[];
  /** Restored paths, in the same order as `blocks`. */
  restored: string[];
  /** Earlier attachments that were not restored, in transcript order. */
  unrestored: AntigravityUnrestoredAttachment[];
}

const PDF_EXTENSION = /\.pdf$/i;

/** Encoded size a file of `bytes` will take, used to skip it before reading. */
function estimatedEncodedBytes(file: string, bytes: number): number {
  return isAcpImagePath(file) ? Math.ceil((bytes * 4) / 3) : bytes;
}

/** One entry per file, keyed by resolved path, kept at its latest use. */
function latestUse(paths: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const path of paths) {
    const key = resolve(path);
    byKey.delete(key);
    byKey.set(key, path);
  }
  return [...byKey.values()];
}

function containingDirectory(
  directories: readonly string[],
  file: string,
): string | undefined {
  if (!isAbsolute(file)) return undefined;
  return directories.find((directory) => {
    const local = relative(resolve(directory), resolve(file));
    return (
      local.length > 0 &&
      !isAbsolute(local) &&
      local !== '..' &&
      !local.startsWith(`..${sep}`)
    );
  });
}

type EarlierAttachmentOutcome =
  | { block: ContentBlock; size: number }
  | { reason: AntigravityUnrestoredReason };

/** Why a file can't be restored before reading it, if the type or size says so. */
function refusedBeforeRead(
  file: string,
  bytes: number,
  remaining: number,
  images: boolean,
): AntigravityUnrestoredReason | undefined {
  if (PDF_EXTENSION.test(file)) return 'unsupported-type';
  if (!images && isAcpImagePath(file)) return 'images-unsupported';
  // Skip a file that cannot fit before reading it. The estimate is a lower
  // bound on the encoded size; the encoded size after reading is
  // authoritative, and the reader repeats every safety check.
  if (
    remaining <= 0 ||
    bytes > ACP_ATTACHMENT_LIMITS.rawBytes ||
    estimatedEncodedBytes(file, bytes) > remaining
  )
    return 'over-limit';
  return undefined;
}

/** The reader's typed refusal means attaching the same file again can't help. */
function reasonForReadError(error: unknown): AntigravityUnrestoredReason {
  return error instanceof AcpAttachmentTypeError
    ? 'unsupported-type'
    : 'unavailable';
}

/**
 * Reads one earlier attachment, or says why it can't be restored. Cheap checks
 * that explain a file (folder, existence, type) run before the budget, so a
 * missing file is never reported as one that didn't fit.
 */
async function readEarlierAttachment(
  file: string,
  remaining: number,
  context: {
    attachmentDirectories: readonly string[];
    images: boolean;
    signal: AbortSignal;
  },
): Promise<EarlierAttachmentOutcome> {
  const baseDir = containingDirectory(context.attachmentDirectories, file);
  if (!baseDir) return { reason: 'unavailable' };
  let bytes: number;
  try {
    bytes = (await lstat(file)).size;
  } catch {
    context.signal.throwIfAborted();
    return { reason: 'unavailable' };
  }
  const refused = refusedBeforeRead(file, bytes, remaining, context.images);
  if (refused) return { reason: refused };
  let block: ContentBlock | undefined;
  try {
    [block] = await readAntigravityAttachments(
      { baseDir, paths: [file] },
      context.signal,
    );
  } catch (error) {
    if (context.signal.aborted) throw error;
    return { reason: reasonForReadError(error) };
  }
  if (!block) return { reason: 'unavailable' };
  if (block.type === 'image' && !context.images)
    return { reason: 'images-unsupported' };
  const size = acpAttachmentEncodedBytes(block);
  return size > remaining ? { reason: 'over-limit' } : { block, size };
}

/**
 * Re-reads attachments that earlier messages saved in this chat's attachment
 * directory, so replayed history keeps their contents. Each file passes the
 * same checks as a new attachment. The current message's attachments keep
 * priority: history only uses what remains of the per-prompt budget, newest
 * first. A file that cannot be restored is reported, never guessed.
 */
export async function readAntigravityHistoricalAttachments(options: {
  attachmentDirectories: readonly string[];
  paths: readonly string[];
  current: readonly ContentBlock[];
  initialization: InitializeResponse;
  signal: AbortSignal;
}): Promise<AntigravityHistoricalAttachments> {
  const ordered = latestUse(options.paths);
  const images =
    options.initialization.agentCapabilities?.promptCapabilities?.image ===
    true;
  let count = options.current.length;
  let encoded = options.current.reduce(
    (total, block) => total + acpAttachmentEncodedBytes(block),
    0,
  );
  const restored = new Map<string, ContentBlock>();
  const reasons = new Map<string, AntigravityUnrestoredReason>();
  for (const file of [...ordered].reverse()) {
    options.signal.throwIfAborted();
    // A full count leaves no room, but the file is still checked so its reason
    // is accurate.
    const remaining =
      count >= ACP_ATTACHMENT_LIMITS.count
        ? 0
        : ACP_ATTACHMENT_LIMITS.encodedBytes - encoded;
    const outcome = await readEarlierAttachment(file, remaining, {
      attachmentDirectories: options.attachmentDirectories,
      images,
      signal: options.signal,
    });
    if ('reason' in outcome) {
      reasons.set(file, outcome.reason);
      continue;
    }
    encoded += outcome.size;
    count += 1;
    restored.set(file, outcome.block);
  }
  options.signal.throwIfAborted();
  const kept = ordered.filter((file) => restored.has(file));
  return {
    blocks: kept.flatMap((file) => {
      const block = restored.get(file);
      return block ? [block] : [];
    }),
    restored: kept,
    unrestored: ordered.flatMap((file) => {
      const reason = reasons.get(file);
      return reason ? [{ path: file, reason }] : [];
    }),
  };
}

/** Counts by reason, for one diagnostic line per turn without any paths. */
export function antigravityUnrestoredCounts(
  history: AntigravityHistoricalAttachments,
): {
  unavailable: number;
  overLimit: number;
  imagesUnsupported: number;
  unsupportedType: number;
  restored: number;
} {
  const count = (reason: AntigravityUnrestoredReason): number =>
    history.unrestored.filter((entry) => entry.reason === reason).length;
  return {
    unavailable: count('unavailable'),
    overLimit: count('over-limit'),
    imagesUnsupported: count('images-unsupported'),
    unsupportedType: count('unsupported-type'),
    restored: history.restored.length,
  };
}

function unrestoredSentences(
  history: AntigravityHistoricalAttachments,
): string[] {
  const counts = antigravityUnrestoredCounts(history);
  const one = (count: number): boolean => count === 1;
  return [
    ...(counts.unavailable > 0
      ? [
          one(counts.unavailable)
            ? "1 earlier attachment couldn't be restored; attach it again if Google needs it."
            : `${counts.unavailable} earlier attachments couldn't be restored; attach them again if Google needs them.`,
        ]
      : []),
    ...(counts.overLimit > 0
      ? [
          one(counts.overLimit)
            ? "1 earlier attachment didn't fit in this message's attachment limit."
            : `${counts.overLimit} earlier attachments didn't fit in this message's attachment limit.`,
        ]
      : []),
    ...(counts.imagesUnsupported > 0
      ? [
          one(counts.imagesUnsupported)
            ? "1 earlier image wasn't sent because this Google runtime doesn't accept images."
            : `${counts.imagesUnsupported} earlier images weren't sent because this Google runtime doesn't accept images.`,
        ]
      : []),
    ...(counts.unsupportedType > 0
      ? [
          one(counts.unsupportedType)
            ? "1 earlier attachment can't be sent to Google because of its file type."
            : `${counts.unsupportedType} earlier attachments can't be sent to Google because of their file type.`,
        ]
      : []),
  ];
}

const UNRESTORED_REASON_TEXT: Readonly<
  Record<AntigravityUnrestoredReason, string>
> = {
  unavailable: 'missing, changed or unreadable',
  'over-limit': 'over the attachment limit',
  'images-unsupported': 'image not accepted by this runtime',
  'unsupported-type': 'file type not supported',
};

/** The system notice for replayed history, or undefined when nothing needs saying. */
export function antigravityHistoryNotice(
  recovered: boolean,
  history: AntigravityHistoricalAttachments | undefined,
): string | undefined {
  const sentences = history ? unrestoredSentences(history) : [];
  if (!recovered) return sentences.length > 0 ? sentences.join(' ') : undefined;
  const intro =
    "Google's saved conversation is unavailable. Continuing with this chat's saved messages";
  if (sentences.length > 0) return `${intro}. ${sentences.join(' ')}`;
  // Say "and attachments" only when an earlier file was actually restored;
  // files the new message attaches again are sent with it instead.
  return history && history.restored.length > 0
    ? `${intro} and attachments.`
    : `${intro}.`;
}

/**
 * Orders one prompt: replayed history, the earlier attachments restored for
 * it, then the new message and its own attachments. Without restored
 * attachments, history and message share one text block as before.
 */
export function antigravityPromptContent(input: {
  history: string;
  restored: AntigravityHistoricalAttachments | undefined;
  message: string;
  attachments: readonly ContentBlock[];
  guide: (text: string) => string;
}): ContentBlock[] {
  const { restored } = input;
  const notes = restored
    ? [
        ...(restored.restored.length > 0
          ? [
              `Earlier attachments restored after this text, in transcript order: ${JSON.stringify(restored.restored)}.`,
            ]
          : []),
        ...(restored.unrestored.length > 0
          ? [
              `Earlier attachments that could not be restored: ${JSON.stringify(
                restored.unrestored.map((entry) => ({
                  path: entry.path,
                  reason: UNRESTORED_REASON_TEXT[entry.reason],
                })),
              )}.`,
            ]
          : []),
      ]
    : [];
  const context = [input.history, ...notes].filter(Boolean).join('\n\n');
  if (restored && restored.blocks.length > 0)
    return [
      { type: 'text', text: input.guide(context) },
      ...restored.blocks,
      { type: 'text', text: `The new message:\n\n${input.message}` },
      ...input.attachments,
    ];
  return [
    {
      type: 'text',
      text: input.guide(
        context ? `${context}\n\n${input.message}` : input.message,
      ),
    },
    ...input.attachments,
  ];
}
