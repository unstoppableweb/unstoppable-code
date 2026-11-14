'use client';

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  ACCOUNT_MCP_TOOLS_REAUTH_REQUIRED,
  type AccountMcpUpstreamTool,
} from '@canopy/protocol/mcp-servers';
import {
  Button,
  ChoiceField,
  LoadingSpinner,
  Notice,
  SearchField,
  SettingsRowsRow,
  ToggleSwitch,
} from '@canopy/ui-shared/components';
import { Surface } from '@canopy/ui-shared/components';

/** Show the filter once a list no longer fits at a glance. */
const SEARCH_THRESHOLD = 8;

export interface McpToolSelectionProps {
  /** The saved policy; null allows every tool the server offers. */
  readonly enabledTools: readonly string[] | null;
  /** Every tool the server offers, before the saved policy applies. */
  readonly loadTools: () => Promise<readonly AccountMcpUpstreamTool[]>;
  readonly saveTools: (enabledTools: string[] | null) => Promise<void>;
  readonly onSaved?: () => void | Promise<void>;
  /** Called when listing fails because the connection needs reconnecting. */
  readonly onReauthRequired?: () => void | Promise<void>;
  readonly dataTestId?: string;
}

type ToolsState =
  | { readonly status: 'idle' | 'loading' | 'failed' | 'reauth_required' }
  | {
      readonly status: 'loaded';
      readonly tools: readonly AccountMcpUpstreamTool[];
    };

interface ToolRow {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  /** Saved as enabled, but the server no longer offers it. */
  readonly missing: boolean;
}

function sameSelection(
  selected: ReadonlySet<string>,
  saved: readonly string[],
): boolean {
  const savedSet = new Set(saved);
  return (
    savedSet.size === selected.size &&
    [...selected].every((name): boolean => savedSet.has(name))
  );
}

function matches(row: ToolRow, query: string): boolean {
  if (!query) return true;
  return [row.name, row.title, row.description].some(
    (text): boolean => text?.toLowerCase().includes(query) ?? false,
  );
}

/**
 * Chooses which of an account MCP connection's tools agents may call. The
 * list comes from the server itself, so nobody types tool names; allowing
 * every tool stays the default and also covers tools the server adds later.
 */
export function McpToolSelection({
  enabledTools,
  loadTools,
  saveTools,
  onSaved,
  onReauthRequired,
  dataTestId = 'mcp-tool-selection',
}: McpToolSelectionProps): JSX.Element {
  const [allTools, setAllTools] = useState(enabledTools === null);
  // Null until the first choice exists: restricting an unrestricted
  // connection starts from every tool on, so turning one off is one click.
  const [selected, setSelected] = useState<ReadonlySet<string> | null>(
    enabledTools === null ? null : new Set(enabledTools),
  );
  const [tools, setTools] = useState<ToolsState>({ status: 'idle' });
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [saved, setSaved] = useState(enabledTools);
  const loadGeneration = useRef(0);
  const switchId = useId();

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setTools({ status: 'loading' });
    try {
      const loaded = await loadTools();
      if (generation !== loadGeneration.current) return;
      setTools({ status: 'loaded', tools: loaded });
      setSelected(
        (current) =>
          current ?? new Set(loaded.map((tool): string => tool.name)),
      );
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      if (
        error instanceof Error &&
        error.message.includes(ACCOUNT_MCP_TOOLS_REAUTH_REQUIRED)
      ) {
        setTools({ status: 'reauth_required' });
        void Promise.resolve(onReauthRequired?.()).catch(() => undefined);
        return;
      }
      setTools({ status: 'failed' });
    }
  }, [loadTools, onReauthRequired]);

  useEffect(() => {
    if (!allTools && tools.status === 'idle') void load();
  }, [allTools, load, tools.status]);

  const rows = useMemo((): ToolRow[] => {
    if (tools.status !== 'loaded') return [];
    const offered = new Set(tools.tools.map((tool): string => tool.name));
    return [
      ...tools.tools.map((tool): ToolRow => ({ ...tool, missing: false })),
      ...[...(selected ?? [])]
        .filter((name): boolean => !offered.has(name))
        .sort()
        .map((name): ToolRow => ({ name, missing: true })),
    ];
  }, [selected, tools]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = rows.filter((row): boolean =>
    matches(row, normalizedQuery),
  );
  const selection = selected ?? new Set<string>();
  const enabledCount = rows.filter((row): boolean =>
    selection.has(row.name),
  ).length;

  const dirty = allTools
    ? saved !== null
    : selected !== null && (saved === null || !sameSelection(selected, saved));
  const canSave = !saving && dirty && (allTools || tools.status === 'loaded');

  const setMany = (names: readonly string[], on: boolean): void => {
    setStatus(null);
    setSelected((current) => {
      const next = new Set(current ?? []);
      for (const name of names) {
        if (on) next.add(name);
        else next.delete(name);
      }
      return next;
    });
  };

  const save = async (): Promise<void> => {
    const next = allTools
      ? null
      : rows.map((row) => row.name).filter((name) => selection.has(name));
    setSaving(true);
    setStatus(null);
    try {
      await saveTools(next);
      setSaved(next);
    } catch {
      setStatus('Couldn’t save tools. Try again.');
      return;
    } finally {
      setSaving(false);
    }
    setStatus('Tools saved. Applies to the next capability update.');
    try {
      await onSaved?.();
    } catch {
      // The save is authoritative even if the host cannot refresh.
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid={dataTestId}>
      {/* A click on the label or its explanation flips the switch. */}
      <SettingsRowsRow
        label="Allow all tools"
        htmlFor={switchId}
        description={
          allTools
            ? 'Includes tools the server adds later.'
            : 'Only the tools you choose below.'
        }
        control={
          <ToggleSwitch
            id={switchId}
            checked={allTools}
            label="Allow all tools"
            disabled={saving}
            onChange={(next) => {
              setStatus(null);
              setAllTools(next);
              // Restricting a policy saved as unrestricted starts from every
              // tool on again, not from whatever was chosen before that save.
              if (!next && saved === null)
                setSelected(
                  tools.status === 'loaded'
                    ? new Set(tools.tools.map((tool): string => tool.name))
                    : null,
                );
            }}
            dataTestId={`${dataTestId}-all`}
          />
        }
      />
      {!allTools && tools.status !== 'loaded' && (
        <Surface
          variant="outline"
          size="small"
          padding="compact"
          data-testid={`${dataTestId}-status`}
        >
          <div className="flex min-h-16 items-center justify-center gap-2 text-s fg-secondary">
            {tools.status === 'reauth_required' ? (
              <Notice intent="attention">
                Reconnect this server to choose its tools.
              </Notice>
            ) : tools.status === 'failed' ? (
              <div className="flex w-full flex-col items-start gap-2">
                <Notice errorSource="mcp-tool-selection" intent="destructive">
                  Couldn’t load this server’s tools.
                </Notice>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void load()}
                  data-testid={`${dataTestId}-retry`}
                >
                  Try again
                </Button>
              </div>
            ) : (
              <>
                <LoadingSpinner decorative />
                Loading tools…
              </>
            )}
          </div>
        </Surface>
      )}
      {!allTools && tools.status === 'loaded' && (
        <div className="flex flex-col gap-2">
          {rows.length === 0 ? (
            <p
              className="text-s fg-secondary"
              data-testid={`${dataTestId}-empty`}
            >
              This server doesn’t offer any tools.
            </p>
          ) : (
            <>
              {rows.length > SEARCH_THRESHOLD && (
                <SearchField
                  aria-label="Filter tools"
                  placeholder="Filter tools"
                  value={query}
                  onValueChange={setQuery}
                  data-testid={`${dataTestId}-filter`}
                />
              )}
              <div className="flex items-center justify-between gap-2 text-xs fg-secondary">
                <span data-testid={`${dataTestId}-count`}>
                  {enabledCount} of {rows.length} on
                </span>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() =>
                      setMany(
                        visibleRows.map((row) => row.name),
                        true,
                      )
                    }
                    data-testid={`${dataTestId}-select-all`}
                  >
                    Select all
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() =>
                      setMany(
                        visibleRows.map((row) => row.name),
                        false,
                      )
                    }
                    data-testid={`${dataTestId}-clear`}
                  >
                    Clear
                  </Button>
                </div>
              </div>
              <Surface
                variant="outline"
                size="small"
                className="overflow-hidden"
              >
                <ul
                  className="flex max-h-72 flex-col overflow-y-auto p-1"
                  data-testid={`${dataTestId}-list`}
                >
                  {visibleRows.map((row) => (
                    <li key={row.name}>
                      <div
                        className="px-2 py-1.5"
                        data-testid={`${dataTestId}-tool`}
                        data-tool-name={row.name}
                      >
                        {/* The whole row is the label: a click on its text toggles the tool. */}
                        <ChoiceField
                          checked={selection.has(row.name)}
                          disabled={saving}
                          onChange={(event) =>
                            setMany([row.name], event.target.checked)
                          }
                          label={
                            <span className="flex min-w-0 flex-col gap-0.5">
                              <span className="truncate">
                                {row.title ?? row.name}
                              </span>
                              {row.title && (
                                <span className="truncate font-mono text-xs fg-tertiary">
                                  {row.name}
                                </span>
                              )}
                            </span>
                          }
                          description={
                            row.missing ? (
                              <span className="fg-warning">
                                No longer offered by this server
                              </span>
                            ) : row.description ? (
                              <span className="block truncate">
                                {row.description}
                              </span>
                            ) : undefined
                          }
                        />
                      </div>
                    </li>
                  ))}
                  {visibleRows.length === 0 && (
                    <li className="px-2 py-1.5 text-s fg-secondary">
                      No tools match.
                    </li>
                  )}
                </ul>
              </Surface>
              {enabledCount === 0 && (
                <p className="text-xs fg-warning">
                  With no tools on, agents can’t use this server.
                </p>
              )}
            </>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="primary"
          disabled={!canSave}
          onClick={() => void save()}
          data-testid={`${dataTestId}-save`}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
        {status && (
          <p role="status" className="text-xs fg-secondary">
            {status}
          </p>
        )}
      </div>
    </div>
  );
}
