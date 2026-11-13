import type { CanopyCoreRelayAuthority } from '../../../shared/canopy-core-relay';

/**
 * Renderer identity for chats served by the web core (CAN-4185 D6, CAN-6175
 * D1). Every cloud id carries its authority, and no local id starts with this
 * prefix, so a cloud chat, task or file can never be mistaken for, or sent
 * as, a local one. This module is the only reader of the prefix.
 */
const AUTHORITY: CanopyCoreRelayAuthority = 'web-core';
const PREFIX = `${AUTHORITY}:`;

/** The renderer scope for a web core chat id. */
export function webCoreScopeId(localId: string): string {
  return `${PREFIX}${localId}`;
}

/** The web core chat id a scope names, or null for any other scope. */
export function webCoreLocalId(scopeId: string): string | null {
  if (!scopeId.startsWith(PREFIX)) return null;
  const localId = scopeId.slice(PREFIX.length);
  return localId.length > 0 && !/[:/]/.test(localId) ? localId : null;
}

export function isWebCoreScope(scopeId: string): boolean {
  return webCoreLocalId(scopeId) !== null;
}

export interface WebCoreFileLocation {
  readonly chatId: string;
  readonly fileRootId: string;
  readonly relativePath: string;
}

/**
 * A cloud file's stand-in for a host `absolutePath`. It is absolute on no
 * platform, so main's path validators refuse it if one ever reaches them.
 */
export function webCoreFilePath(location: WebCoreFileLocation): string {
  return `${webCoreScopeId(location.chatId)}/${encodeURIComponent(
    location.fileRootId,
  )}/${location.relativePath}`;
}

export function parseWebCoreFilePath(path: string): WebCoreFileLocation | null {
  const chatEnd = path.indexOf('/');
  const rootEnd = chatEnd < 0 ? -1 : path.indexOf('/', chatEnd + 1);
  if (rootEnd < 0) return null;
  const chatId = webCoreLocalId(path.slice(0, chatEnd));
  const fileRootId = decodeSegment(path.slice(chatEnd + 1, rootEnd));
  if (chatId === null || !fileRootId) return null;
  return { chatId, fileRootId, relativePath: path.slice(rootEnd + 1) };
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}
