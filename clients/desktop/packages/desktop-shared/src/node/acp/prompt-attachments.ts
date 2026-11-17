import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import {
  dirname,
  extname,
  isAbsolute,
  relative,
  sep,
  join,
  resolve,
} from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ContentBlock } from '@agentclientprotocol/sdk';

/** Supplied by the host from an explicit attachment selection, never parsed from text. */
export interface AcpAttachmentSelection {
  baseDir: string;
  paths: readonly string[];
}

const MAX_ATTACHMENT_BYTES = 4 * 1024 * 1024;
const MAX_ENCODED_BYTES = 6 * 1024 * 1024;
const MAX_ATTACHMENTS = 32;
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Per-prompt bounds shared by every attachment a single ACP prompt carries. */
export const ACP_ATTACHMENT_LIMITS = {
  count: MAX_ATTACHMENTS,
  encodedBytes: MAX_ENCODED_BYTES,
  /** Raw bytes one read may carry, so also the most one file can be. */
  rawBytes: MAX_ATTACHMENT_BYTES,
} as const;

/**
 * The reader refuses this file's type (a refused PDF, or bytes that are not
 * UTF-8 text). Attaching the same file again cannot help; the message is the
 * same one the current message shows.
 */
export class AcpAttachmentTypeError extends Error {}

/** Whether the reader sends this file as an image block. */
export function isAcpImagePath(path: string): boolean {
  return extname(path).toLowerCase() in IMAGE_TYPES;
}

/** The encoded size counted against `ACP_ATTACHMENT_LIMITS.encodedBytes`. */
export function acpAttachmentEncodedBytes(block: ContentBlock): number {
  return Buffer.byteLength(JSON.stringify(block));
}

/** Imported attachments are regular files under a host-owned directory. */
export async function readAcpAttachments(
  selection: AcpAttachmentSelection | undefined,
  signal: AbortSignal,
  options: { providerLabel: string; pdf?: boolean },
): Promise<ContentBlock[]> {
  const label = options.providerLabel;
  if (!selection?.paths.length) return [];
  signal.throwIfAborted();
  if (selection.paths.length > MAX_ATTACHMENTS)
    throw new Error(
      `${label} accepts at most ${MAX_ATTACHMENTS} attachments per message.`,
    );
  const root = resolve(selection.baseDir);
  if (!(await lstat(root)).isDirectory())
    throw new Error(`${label} could not read the attachment directory.`);
  const canonicalRoot = await realpath(root);
  const blocks: ContentBlock[] = [];
  let remaining = MAX_ATTACHMENT_BYTES;
  let encodedBytes = 0;
  for (const selected of selection.paths) {
    signal.throwIfAborted();
    const selectedPath = resolve(selected);
    const localPath = relative(root, selectedPath);
    if (
      !isAbsolute(selected) ||
      !localPath ||
      isAbsolute(localPath) ||
      localPath === '..' ||
      localPath.startsWith(`..${sep}`)
    )
      throw new Error(
        `${label} attachments must be files in this chat's attachment directory.`,
      );
    const file = join(canonicalRoot, localPath);
    // Portal imports use a per-request subdirectory. Permit it while rejecting
    // links at every directory component, including links back inside the root.
    let parent = canonicalRoot;
    for (const part of relative(canonicalRoot, dirname(file))
      .split(sep)
      .filter(Boolean)) {
      parent = join(parent, part);
      if (!(await lstat(parent)).isDirectory())
        throw new Error(
          `${label} attachment directories must not contain links.`,
        );
    }
    if ((await realpath(file)) !== file)
      throw new Error(
        `${label} attachments must stay inside their attachment directory.`,
      );
    const info = await lstat(file);
    if (!info.isFile() || info.nlink !== 1)
      throw new Error(
        `${label} attachments must be regular files, without links.`,
      );
    if (info.size > remaining)
      throw new Error(`${label} attachments must total 4 MB or less.`);
    // Nonblocking prevents a raced FIFO from hanging the turn. NOFOLLOW prevents
    // replacing the selected file with a symlink between lstat and open.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let bytes: Buffer;
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.ino !== info.ino ||
        opened.dev !== info.dev ||
        opened.size !== info.size
      )
        throw new Error(
          `An ${label} attachment changed while it was being read. Attach it again.`,
        );
      const current = await lstat(file);
      if (
        (await realpath(file)) !== file ||
        current.ino !== opened.ino ||
        current.dev !== opened.dev
      )
        throw new Error(
          `An ${label} attachment changed while it was being read. Attach it again.`,
        );
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        signal.throwIfAborted();
        const read = await handle.read(
          buffer,
          length,
          buffer.length - length,
          length,
        );
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      signal.throwIfAborted();
      const after = await handle.stat();
      if (
        length !== info.size ||
        after.size !== info.size ||
        after.mtimeMs !== info.mtimeMs
      )
        throw new Error(
          `An ${label} attachment changed while it was being read. Attach it again.`,
        );
      bytes = buffer.subarray(0, length);
      remaining -= length;
    } finally {
      await handle.close();
    }
    const uri = pathToFileURL(file).href;
    const imageType = IMAGE_TYPES[extname(file).toLowerCase()];
    if (extname(file).toLowerCase() === '.pdf' && options.pdf === false)
      throw new AcpAttachmentTypeError(
        `Couldn't send this PDF to ${label}. Attach images of its pages or a text version.`,
      );
    let block: ContentBlock;
    if (imageType) {
      block = {
        type: 'image',
        data: bytes.toString('base64'),
        mimeType: imageType,
        uri,
      };
    } else if (
      extname(file).toLowerCase() === '.pdf' &&
      bytes.subarray(0, 5).toString() === '%PDF-'
    ) {
      block = {
        type: 'resource',
        resource: {
          uri,
          mimeType: 'application/pdf',
          blob: bytes.toString('base64'),
        },
      };
    } else {
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (text.includes('\0')) throw new Error('Binary attachment');
      } catch {
        const formats =
          options.pdf === false
            ? 'image or UTF-8 text'
            : 'image, PDF or UTF-8 text';
        throw new AcpAttachmentTypeError(
          `Couldn't send this file to ${label}. Convert it to ${formats} and attach it again.`,
        );
      }
      block = {
        type: 'resource',
        resource: { uri, mimeType: 'text/plain', text },
      };
    }
    encodedBytes += acpAttachmentEncodedBytes(block);
    if (encodedBytes > MAX_ENCODED_BYTES)
      throw new Error(
        `${label} attachments are too large after encoding. Send fewer or smaller files.`,
      );
    blocks.push(block);
  }
  signal.throwIfAborted();
  return blocks;
}
