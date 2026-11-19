import type { ComponentProps, JSX } from 'react';
import {
  CustomizeEntryWorksWith,
  PluginWorksWith,
  type CustomizeLiveHarnesses,
} from '@canopy/ui-shared/components';
import { useClaudeAuthStatus } from '@/hooks/useClaudeAuthStatus';
import { useCodexAuthStatus } from '@/hooks/useCodexAuthStatus';
import { useCursorChatAvailable } from '@/hooks/useCursorChatAvailable';

interface PluginHarnessStatusProps {
  installed: boolean;
}

/**
 * The harnesses the app reaches right now: signed-in Claude and Codex, and an
 * enabled Cursor. A Claude or Codex status still loading reads `null`.
 */
function useLiveHarnesses(): {
  claude: boolean | null;
  codex: boolean | null;
  cursor: boolean;
} {
  const claude = useClaudeAuthStatus();
  const codex = useCodexAuthStatus();
  const cursor = useCursorChatAvailable(true);
  return {
    claude: claude === null ? null : claude.authenticated,
    codex: codex === null ? null : codex.authenticated,
    cursor,
  };
}

/** Rows describe availability inside the app; the app itself is not a row. */
export function PluginHarnessStatus({
  installed,
}: PluginHarnessStatusProps): JSX.Element | null {
  const live = useLiveHarnesses();
  const harnesses = [
    ...(live.claude === true ? [{ id: 'claude', name: 'Claude' }] : []),
    ...(live.codex === true ? [{ id: 'codex', name: 'Codex' }] : []),
    ...(live.cursor ? [{ id: 'cursor', name: 'Cursor' }] : []),
  ];
  return (
    <PluginWorksWith
      rows={harnesses.map((harness) => ({
        id: harness.id,
        name: harness.name,
        installation: installed ? 'Installed' : 'Not installed',
      }))}
    />
  );
}

/**
 * New Customize's one Works with table for an MCP server, fed the app's live
 * harnesses: a server without compatibility metadata that the app reaches in
 * Cursor reads as working there, as `PluginHarnessStatus` reported it.
 */
export function PluginLiveWorksWith({
  entry,
}: {
  readonly entry: ComponentProps<typeof CustomizeEntryWorksWith>['entry'];
}): JSX.Element | null {
  const liveHarnesses: CustomizeLiveHarnesses = useLiveHarnesses();
  return (
    <CustomizeEntryWorksWith entry={entry} liveHarnesses={liveHarnesses} />
  );
}
