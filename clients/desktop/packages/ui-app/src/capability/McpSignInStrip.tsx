'use client';

import { Stack, type SpaceRole } from '@canopy/ui-shared/components/Stack';
import type { McpServersSectionBodyProps } from '../code/activity/McpServersSectionBody';

import { useId, useState, type JSX, type ReactNode } from 'react';
import {
  ComposerDrawer,
  ComposerDrawerSection,
  Notice,
  NoticeButton,
} from '@canopy/ui-shared/components';
import {
  mcpAuthConnectLabel,
  mcpSignInSummary,
  mcpSignInStatusLabel,
  mcpServerNameList,
} from '@canopy/ui-shared/lib';
export {
  mcpServerNameList,
  mcpSignInSummary,
  mcpSignInStatusLabel,
} from '@canopy/ui-shared/lib';
import {
  McpServersSectionBody,
  type McpServersSectionItem,
} from '../code/activity/McpServersSectionBody';

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** Selected servers still waiting on Sign in or Reconnect. */
export function mcpServersNeedingSignIn<T extends McpServersSectionItem>(
  servers: readonly T[],
): T[] {
  return servers.filter(
    (server) =>
      mcpAuthConnectLabel(server.authStatus, server.canRefresh) !== undefined,
  );
}

function sameKeys(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export interface McpSignInStripRows<T extends McpServersSectionItem> {
  /** The strip's rows, in the host's order. */
  readonly rows: T[];
  /** Rows still waiting on sign-in; the strip hides when this is empty. */
  readonly pending: T[];
}

/**
 * A row joins the strip while it needs sign-in and stays, reading Signed in,
 * once it connects, so the user sees each sign-in land. Rows leave with the
 * selection, and the whole set clears once nothing is left to sign in.
 */
export function useMcpSignInStripRows<T extends McpServersSectionItem>(
  servers: readonly T[],
): McpSignInStripRows<T> {
  const pending = mcpServersNeedingSignIn(servers);
  const [shown, setShown] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  let next: ReadonlySet<string> = EMPTY_KEYS;
  if (pending.length > 0) {
    const selected = new Set(servers.map((server) => server.key));
    const keys = new Set<string>();
    for (const key of shown) if (selected.has(key)) keys.add(key);
    for (const server of pending) keys.add(server.key);
    next = keys;
  }
  if (!sameKeys(next, shown)) setShown(next);
  return {
    rows: servers.filter((server) => next.has(server.key)),
    pending,
  };
}

function selectedSummary(pending: readonly McpServersSectionItem[]): string {
  const signIn = pending.filter(
    (server) =>
      server.connectActionLabel !== 'Enable' &&
      server.connectActionLabel !== 'Turn on',
  );
  if (signIn.length > 0)
    return mcpSignInSummary(signIn.map((server) => server.displayName));
  return `${mcpServerNameList(pending.map((server) => server.displayName))} ${pending.length === 1 ? 'isn’t' : 'aren’t'} enabled`;
}

function stripRow(server: McpServersSectionItem): McpServersSectionItem {
  const signedIn = server.authStatus === 'connected';
  return {
    ...server,
    authStatusLabel: mcpSignInStatusLabel(server),
    ...(server.connectActionLabel === undefined &&
    (server.authStatus === 'not_connected' || server.authStatus === 'expired')
      ? { connectActionLabel: 'Sign in' }
      : {}),
    canConnect: !signedIn && server.canConnect,
    canDisconnect: false,
    canToggleCanopyProxy: false,
  };
}

export interface McpSignInStripProps {
  /**
   * The selected servers that sign in, in display order, whatever their
   * state. The strip shows while any of them needs sign-in.
   */
  readonly servers: readonly McpServersSectionItem[];
  readonly connectingKey?: string | null;
  readonly onConnect: (server: McpServersSectionItem) => void;
  /** Stops waiting on a row's pending sign-in. */
  readonly onCancelSignIn?: (server: McpServersSectionItem) => void;
  /** Host-owned content under a row: token or OAuth app prompts, errors. */
  readonly renderRowExtra?: (server: McpServersSectionItem) => ReactNode;
  readonly rowExtraLayout?: McpServersSectionBodyProps['rowExtraLayout'];
  /** A failure with no row to sit on, shown under the summary. */
  readonly notice?: ReactNode;
  /** Opt-in gap after and between margin-free notices; the summary keeps its existing boundary. */
  readonly noticeGap?: SpaceRole;
  /**
   * The summary line for the rows still waiting, in display order. Defaults
   * to {@link mcpSignInSummary} of their names.
   */
  readonly summary?: (pending: readonly McpServersSectionItem[]) => string;
  readonly getRowNavigation?: McpServersSectionBodyProps['getRowNavigation'];
  readonly getRowSettings?: McpServersSectionBodyProps['getRowSettings'];
  readonly loading?: boolean;
  readonly selectionKey?: string;
  readonly onRetryInventory?: () => void;
  readonly dataTestId?: string;
}

/**
 * Hangs from a new task's composer, the way the desktop project selector sits
 * on top of it: the attached MCP servers that still need sign-in, each with
 * the MCP Servers card's row and its Sign in or Reconnect. The 16px inset
 * meets the composer's flat bottom edge, past its corner radius. It only
 * prompts. Send stays available, and a server left signed out behaves as it
 * does in a chat.
 */
export function McpSignInStrip({
  servers,
  connectingKey = null,
  onConnect,
  onCancelSignIn,
  renderRowExtra,
  rowExtraLayout,
  notice,
  noticeGap,
  summary,
  getRowNavigation,
  getRowSettings,
  loading = false,
  selectionKey,
  onRetryInventory,
  dataTestId = 'mcp-sign-in-strip',
}: McpSignInStripProps): JSX.Element | null {
  const summaryId = useId();
  const { rows, pending } = useMcpSignInStripRows(servers);
  const [observed, setObserved] = useState<{
    selection: string | undefined;
    keys: ReadonlySet<string>;
    gap: boolean;
  }>({ selection: selectionKey, keys: EMPTY_KEYS, gap: false });
  let gap = observed.gap;
  let keys = observed.keys;
  if (observed.selection !== selectionKey) {
    gap = false;
    keys = loading ? EMPTY_KEYS : new Set(pending.map((server) => server.key));
  } else if (selectionKey !== undefined && !loading && notice === undefined) {
    gap = Array.from(observed.keys).some(
      (key) => !servers.some((server) => server.key === key),
    );
    keys = gap ? observed.keys : new Set(pending.map((server) => server.key));
  }
  if (
    observed.selection !== selectionKey ||
    observed.gap !== gap ||
    !sameKeys(observed.keys, keys)
  )
    setObserved({ selection: selectionKey, keys, gap });
  if (pending.length === 0 && !notice && !loading && !gap) return null;
  const summaryContent = (
    <p
      id={summaryId}
      aria-live="polite"
      data-testid={`${dataTestId}-summary`}
      className="px-2 py-1.5 text-xs fg-secondary"
    >
      {pending.length === 0
        ? 'Checking MCP sign-in details…'
        : summary === undefined
          ? selectedSummary(pending)
          : summary(pending)}
    </p>
  );
  const rowsContent = (
    <>
      {gap && notice === undefined && (
        <Notice
          errorSource="mcp-server-sign-in-stale"
          displayErrorCode="external.state_changed"
          intent="destructive"
          role="status"
          actions={
            onRetryInventory ? (
              <NoticeButton onClick={onRetryInventory}>Try again</NoticeButton>
            ) : undefined
          }
        >
          This MCP server is no longer available
        </Notice>
      )}
      <McpServersSectionBody
        servers={rows.map(stripRow)}
        warnings={[]}
        loading={loading}
        error={null}
        connectingKey={connectingKey}
        showProxyToggle={false}
        brandAppName=""
        proxyLogo={null}
        getRowNavigation={getRowNavigation}
        getRowSettings={getRowSettings}
        onConnect={onConnect}
        onCancelSignIn={onCancelSignIn}
        renderRowExtra={renderRowExtra}
        rowExtraLayout={rowExtraLayout}
      />
    </>
  );
  return (
    <ComposerDrawer
      edge="bottom"
      as="section"
      aria-labelledby={summaryId}
      data-testid={dataTestId}
    >
      <ComposerDrawerSection>
        {summaryContent}
        {noticeGap === undefined ? (
          <>
            {notice}
            {rowsContent}
          </>
        ) : (
          <Stack gap={noticeGap}>
            <Stack gap={noticeGap} className="empty:hidden">
              {notice}
            </Stack>
            <div>{rowsContent}</div>
          </Stack>
        )}
      </ComposerDrawerSection>
    </ComposerDrawer>
  );
}
