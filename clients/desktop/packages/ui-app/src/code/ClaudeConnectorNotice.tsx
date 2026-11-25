'use client';

import { useSyncExternalStore, type JSX } from 'react';
import type { ClaudeConnectorAvailability } from '@canopy/protocol/remote-control/shell';
import { Notice, NoticeButton } from '@canopy/ui-shared/components';

const STORAGE_KEY = 'canopy.claudeConnectorNotice.dismissed.v1';
const MAX_DISMISSALS = 400;
const listeners = new Set<() => void>();
const sessionDismissals = new Map<string, string>();

function readDismissal(chatKey: string): string | undefined {
  if (sessionDismissals.has(chatKey)) return sessionDismissals.get(chatKey);
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const entries: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        if (
          Array.isArray(entry) &&
          entry[0] === chatKey &&
          typeof entry[1] === 'string'
        )
          return entry[1];
      }
    }
  } catch {
    // An unreadable preference leaves the explanation visible.
  }
  return undefined;
}

function dismiss(chatKey: string, launchId: string): void {
  const entries = new Map<string, string>();
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    const stored: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(stored)) {
      for (const entry of stored) {
        if (
          Array.isArray(entry) &&
          typeof entry[0] === 'string' &&
          typeof entry[1] === 'string'
        )
          entries.set(entry[0], entry[1]);
      }
    }
  } catch {
    // Keep a session preference if storage is unavailable.
  }
  sessionDismissals.delete(chatKey);
  sessionDismissals.set(chatKey, launchId);
  for (const [key, value] of sessionDismissals) entries.set(key, value);
  entries.delete(chatKey);
  entries.set(chatKey, launchId);
  while (entries.size > MAX_DISMISSALS) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
    sessionDismissals.delete(oldest);
  }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...entries]));
  } catch {
    // Dismissal never changes the durable launch's availability fact.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    sessionDismissals.clear();
    listener();
  };
  globalThis.addEventListener?.('storage', onStorage);
  return (): void => {
    listeners.delete(listener);
    globalThis.removeEventListener?.('storage', onStorage);
  };
}

export interface ClaudeConnectorNoticeProps {
  /** Stable worker/workspace/worktree/chat identity, independent of navigation. */
  readonly chatKey: string;
  readonly availability?: ClaudeConnectorAvailability;
  readonly appName: string;
  readonly onManageConnections: () => void;
}

/** One explanation shared by desktop and paired web; no discovery on render. */
export function ClaudeConnectorNotice({
  chatKey,
  availability,
  appName,
  onManageConnections,
}: ClaudeConnectorNoticeProps): JSX.Element | null {
  const dismissed = useSyncExternalStore(
    subscribe,
    () =>
      availability !== undefined &&
      readDismissal(chatKey) === availability.launchId,
    () => false,
  );
  const cause =
    availability?.status === 'suppressed'
      ? availability.cause
      : availability?.status === 'unknown'
        ? availability.launchRoute
        : undefined;
  if (!availability || !cause || dismissed) return null;
  const confirmed = availability.status === 'suppressed';
  const route =
    cause === 'account_proxy'
      ? 'the account proxy'
      : cause === 'ai_credits'
        ? 'AI Credits'
        : cause === 'organization_gateway'
          ? 'an organization gateway'
          : 'an API connection';
  // Route names answer why this chat differs from the user's own terminal.
  // The action leads to separate account connections, never imported grants.
  return (
    <Notice
      intent="attention"
      shape="composer"
      title={
        confirmed
          ? 'claude.ai connectors unavailable in this chat'
          : 'claude.ai connectors may be unavailable in this chat'
      }
      data-testid="claude-connector-notice"
      onDismiss={(): void => dismiss(chatKey, availability.launchId)}
      dismissLabel="Dismiss connector notice"
      actions={
        <NoticeButton variant="primary" onClick={onManageConnections}>
          Manage connections
        </NoticeButton>
      }
    >
      {confirmed
        ? `This chat uses ${route}.`
        : `This chat was started with ${route} configured.`}{' '}
      Claude Code turns off claude.ai connectors, such as Slack and Linear, when
      another sign-in is used.{' '}
      {confirmed ? null : 'Claude settings can use a different sign-in. '}
      Connect them through {appName} to use them here.
    </Notice>
  );
}
