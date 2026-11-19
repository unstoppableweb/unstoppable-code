'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { RemoteControlChatMessage } from '@canopy/protocol';
import type { ChatVisualHost, ChatVisualOwner } from './chat-visual-host';
import { chatVisualOwnerKey } from './chat-visual-reader';
import { readChatToolResultVisual } from './ChatToolResultPart';

/**
 * What the Chat visuals panel shows for one chat.
 *
 * The chat that renders a transcript already holds its messages and the host
 * that reads its visuals, so it publishes both here. The panel, mounted
 * elsewhere in the same window, reads them by the chat's key and needs no
 * transcript of its own. Hosts choose the key; it only has to be the same on
 * both sides.
 */
export type ChatVisualsSource = {
  owners: readonly ChatVisualOwner[];
  host: ChatVisualHost;
};

/** A request to scroll one visual into view. A repeat is a new request. */
export type ChatVisualReveal = { toolUseId: string; request: number };

type Entry = {
  source: ChatVisualsSource | null;
  reveal: ChatVisualReveal | null;
  listeners: Set<() => void>;
};

/** Sources outlive their chat's panel, so a closed chat's visuals stay readable. */
const MAX_UNWATCHED_ENTRIES = 64;

const entries = new Map<string, Entry>();
let nextRevealRequest = 1;

function entryFor(key: string): Entry {
  let entry = entries.get(key);
  if (!entry) {
    entry = { source: null, reveal: null, listeners: new Set() };
    entries.set(key, entry);
  } else {
    // Most recently used last, so the oldest unwatched entry is dropped first.
    entries.delete(key);
    entries.set(key, entry);
  }
  if (entries.size > MAX_UNWATCHED_ENTRIES) {
    for (const [candidateKey, candidate] of entries) {
      if (entries.size <= MAX_UNWATCHED_ENTRIES) break;
      if (candidate !== entry && candidate.listeners.size === 0)
        entries.delete(candidateKey);
    }
  }
  return entry;
}

function notify(entry: Entry): void {
  for (const listener of [...entry.listeners]) listener();
}

function sameSource(
  left: ChatVisualsSource | null,
  right: ChatVisualsSource,
): boolean {
  return (
    left !== null &&
    left.host === right.host &&
    left.owners.length === right.owners.length &&
    left.owners.every((owner, index) => {
      const other = right.owners[index];
      return (
        owner === other ||
        chatVisualOwnerKey(owner) === chatVisualOwnerKey(other)
      );
    })
  );
}

/** Publish a chat's visuals. An equal list keeps the earlier snapshot. */
export function publishChatVisuals(
  key: string,
  source: ChatVisualsSource,
): void {
  const entry = entryFor(key);
  if (sameSource(entry.source, source)) return;
  entry.source = source;
  notify(entry);
}

/** Ask the panel showing `key` to scroll one visual into view. */
export function requestChatVisualReveal(key: string, toolUseId: string): void {
  const entry = entryFor(key);
  entry.reveal = { toolUseId, request: nextRevealRequest };
  nextRevealRequest += 1;
  notify(entry);
}

function subscribe(key: string, listener: () => void): () => void {
  const entry = entryFor(key);
  entry.listeners.add(listener);
  return (): void => {
    entry.listeners.delete(listener);
  };
}

export function useChatVisualsSource(key: string): ChatVisualsSource | null {
  const subscribeToKey = useCallback(
    (listener: () => void) => subscribe(key, listener),
    [key],
  );
  const snapshot = useCallback(() => entries.get(key)?.source ?? null, [key]);
  return useSyncExternalStore(subscribeToKey, snapshot, snapshot);
}

export function useChatVisualReveal(key: string): ChatVisualReveal | null {
  const subscribeToKey = useCallback(
    (listener: () => void) => subscribe(key, listener),
    [key],
  );
  const snapshot = useCallback(() => entries.get(key)?.reveal ?? null, [key]);
  return useSyncExternalStore(subscribeToKey, snapshot, snapshot);
}

/** Publishes a chat's visuals while it is mounted with a host and a key. */
export function useChatVisualsPublisher(
  key: string | null,
  owners: readonly ChatVisualOwner[],
  host: ChatVisualHost | null,
): void {
  useEffect(() => {
    if (key !== null && host !== null)
      publishChatVisuals(key, { owners, host });
  }, [key, owners, host]);
}

/** Every visual the messages carry, in transcript order, once each. */
export function collectChatVisualOwners(
  messages: readonly RemoteControlChatMessage[],
): ChatVisualOwner[] {
  const owners: ChatVisualOwner[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.kind !== 'tool_result') continue;
      const owner = readChatToolResultVisual(part.data, message.messageId);
      if (!owner || seen.has(owner.toolUseId)) continue;
      seen.add(owner.toolUseId);
      owners.push(owner);
    }
  }
  return owners;
}
