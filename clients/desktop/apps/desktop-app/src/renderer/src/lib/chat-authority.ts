import { webCoreLocalId, webCoreScopeId } from '../../../shared/web-core-scope';

/**
 * Renderer identity for chats served by the web core (CAN-4185 D6, CAN-6175
 * D1). Every cloud id carries its authority, and no local id starts with its
 * prefix, so a cloud chat, task or file can never be mistaken for, or sent
 * as, a local one. The prefix is read only in `shared/web-core-scope`.
 */
export { webCoreLocalId, webCoreScopeId };

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
