import { useEffect, useRef, useState, type JSX } from 'react';
import { Button, ConfirmDialog } from '@canopy/ui-shared';
import {
  ChoiceList,
  ChoiceListRow,
  DetailFact,
  DetailFactList,
  DETAIL_FACT_VALUE_OFFSET_CLASS,
  ErrorBanner,
  Notice,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** A tool the server lists. */
export interface CloudReachBackTool {
  readonly name: string;
  readonly description?: string;
}

/** What the person allowed for this server and config. */
export interface CloudReachBackState {
  /** Null allows every tool the server lists. */
  readonly enabledTools: readonly string[] | null;
  readonly allowWithoutAsking: readonly string[];
  /** Why its last cloud chat call couldn't reach it; null once one does. */
  readonly unreachable?: string | null;
}

export type CloudReachBackDecision =
  | 'server_not_allowed'
  | 'tool_not_allowed'
  | 'read_only'
  | 'allowed_without_asking'
  | 'asked_allowed'
  | 'asked_denied'
  | 'approval_timeout'
  | 'no_window';

/** One call a cloud chat made; never its arguments or result. */
export interface CloudReachBackCall {
  readonly at: string;
  readonly chatTitle: string | null;
  /** Null when the call started the server. */
  readonly toolName: string | null;
  readonly decision: CloudReachBackDecision;
}

export interface CloudReachBackSectionProps {
  readonly serverName: string;
  /** Null while cloud chats can't reach this server. */
  readonly state: CloudReachBackState | null;
  readonly loadTools: () => Promise<readonly CloudReachBackTool[]>;
  readonly onAllow: (selection: {
    readonly enabledTools: string[];
    readonly allowWithoutAsking: string[];
  }) => Promise<void>;
  readonly onTurnOff: () => Promise<void>;
  /** Newest first. */
  readonly calls: readonly CloudReachBackCall[];
  readonly busy?: boolean;
  readonly formatTimestamp?: (iso: string) => string;
}

const RECENT_CALLS = 5;

const DECISION_LABELS: Record<CloudReachBackDecision, string> = {
  server_not_allowed: 'Server not allowed',
  tool_not_allowed: 'Tool not allowed',
  read_only: 'Ran, read-only',
  allowed_without_asking: 'Ran without asking',
  asked_allowed: 'You allowed it',
  asked_denied: 'You declined it',
  approval_timeout: 'Nobody answered',
  no_window: 'Couldn’t ask',
};

function stateLabel(state: CloudReachBackState | null): string {
  if (state === null) return 'Off';
  if (state.unreachable) return 'On, unreachable';
  if (state.enabledTools === null) return 'On, every tool';
  const count = state.enabledTools.length;
  return `On, ${String(count)} ${count === 1 ? 'tool' : 'tools'}`;
}

type ToolsState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
      readonly status: 'loaded';
      readonly tools: readonly CloudReachBackTool[];
    };

function AllowDialog({
  serverName,
  state,
  loadTools,
  onAllow,
  onClose,
}: {
  readonly serverName: string;
  readonly state: CloudReachBackState | null;
  readonly loadTools: CloudReachBackSectionProps['loadTools'];
  readonly onAllow: CloudReachBackSectionProps['onAllow'];
  readonly onClose: () => void;
}): JSX.Element {
  const [tools, setTools] = useState<ToolsState>({ status: 'loading' });
  const [used, setUsed] = useState<ReadonlySet<string>>(new Set());
  const [unasked, setUnasked] = useState<ReadonlySet<string>>(
    new Set(state?.allowWithoutAsking ?? []),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Loaded and chosen once, when the dialog opens: a re-render of the page
  // mustn't put back the defaults over the person's choices.
  const opened = useRef({
    loadTools,
    enabledTools: state?.enabledTools ?? null,
  });
  useEffect(() => {
    let current = true;
    const { loadTools: load, enabledTools } = opened.current;
    load()
      .then((listed) => {
        if (!current) return;
        setTools({ status: 'loaded', tools: listed });
        // Every listed tool by default, as a local chat would offer.
        setUsed(new Set(enabledTools ?? listed.map((tool) => tool.name)));
      })
      .catch(() => {
        if (current) setTools({ status: 'failed' });
      });
    return (): void => {
      current = false;
    };
  }, []);

  const toggle = (
    set: ReadonlySet<string>,
    name: string,
    on: boolean,
  ): ReadonlySet<string> => {
    const next = new Set(set);
    if (on) next.add(name);
    else next.delete(name);
    return next;
  };

  const allow = async (): Promise<void> => {
    if (used.size === 0) {
      setError('Choose at least one tool.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onAllow({
        enabledTools: [...used],
        allowWithoutAsking: [...unasked].filter((name) => used.has(name)),
      });
      onClose();
    } catch {
      setError('This server couldn’t be allowed. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <ConfirmDialog
      title={`Allow ${serverName} in cloud chats?`}
      message={
        <div
          className="flex flex-col gap-3"
          data-testid="cloud-reach-back-dialog-body"
        >
          <p>
            Your cloud chats can run the tools you choose on this computer while
            it’s online, and send their results to the cloud chat. You are asked
            before each tool that can change something, unless you let it run
            without asking.
          </p>
          {tools.status === 'loading' && <p>Loading tools…</p>}
          {tools.status === 'failed' && (
            <Notice
              errorSource="cloud-reach-back-load-tools"
              intent="destructive"
            >
              The server’s tools couldn’t be listed. Check that it runs.
            </Notice>
          )}
          {tools.status === 'loaded' && (
            <ChoiceList
              aria-label="Tools cloud chats can use"
              data-testid="cloud-reach-back-tools"
            >
              {tools.tools.map((tool) => (
                <ChoiceListRow
                  key={tool.name}
                  selected={used.has(tool.name)}
                  data-testid={`cloud-reach-back-use-${tool.name}`}
                  onClick={(): void =>
                    setUsed(toggle(used, tool.name, !used.has(tool.name)))
                  }
                >
                  {tool.name}
                </ChoiceListRow>
              ))}
            </ChoiceList>
          )}
          {tools.status === 'loaded' && used.size > 0 && (
            <>
              <p>Run without asking on this computer:</p>
              <ChoiceList
                aria-label="Tools that run without asking"
                data-testid="cloud-reach-back-unasked"
              >
                {tools.tools
                  .filter((tool) => used.has(tool.name))
                  .map((tool) => (
                    <ChoiceListRow
                      key={tool.name}
                      selected={unasked.has(tool.name)}
                      data-testid={`cloud-reach-back-unasked-${tool.name}`}
                      onClick={(): void =>
                        setUnasked(
                          toggle(unasked, tool.name, !unasked.has(tool.name)),
                        )
                      }
                    >
                      {tool.name}
                    </ChoiceListRow>
                  ))}
              </ChoiceList>
            </>
          )}
        </div>
      }
      confirmLabel="Allow"
      busyLabel="Allowing…"
      busy={saving}
      errorMessage={error}
      dataTestId="cloud-reach-back-dialog"
      confirmTestId="cloud-reach-back-allow"
      cancelTestId="cloud-reach-back-cancel"
      onConfirm={(): void => {
        if (tools.status === 'loaded') void allow();
      }}
      onCancel={(): void => {
        if (!saving) onClose();
      }}
    />
  );
}

/**
 * Whether cloud chats can reach this MCP server on this computer (CAN-6176
 * PR 7c): the tools they may use, which run without asking, the off switch,
 * and what reached it lately. Hosts without the `cloudReachBack` capability
 * don't mount it.
 */
export function CloudReachBackSection({
  serverName,
  state,
  loadTools,
  onAllow,
  onTurnOff,
  calls,
  busy = false,
  formatTimestamp = (iso): string => new Date(iso).toLocaleString(),
}: CloudReachBackSectionProps): JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const turnOff = async (): Promise<void> => {
    setTurningOff(true);
    setError(null);
    try {
      await onTurnOff();
    } catch {
      setError('Cloud chats couldn’t be turned off for this server.');
    } finally {
      setTurningOff(false);
    }
  };

  const recent = calls.slice(0, RECENT_CALLS);
  return (
    <section
      data-testid="cloud-reach-back-section"
      aria-label="Cloud chats"
      className="flex flex-col gap-1"
    >
      <DetailFactList>
        <DetailFact label="Cloud chats">
          <span data-testid="cloud-reach-back-state">{stateLabel(state)}</span>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button
              variant="secondary"
              size="compact"
              data-testid="cloud-reach-back-open"
              disabled={busy || turningOff}
              onClick={(): void => setDialogOpen(true)}
            >
              {state === null ? 'Allow…' : 'Edit…'}
            </Button>
            {state !== null && (
              <Button
                variant="secondary"
                size="compact"
                data-testid="cloud-reach-back-turn-off"
                disabled={busy || turningOff}
                onClick={(): void => {
                  void turnOff();
                }}
              >
                {turningOff ? 'Turning off…' : 'Turn off'}
              </Button>
            )}
          </span>
        </DetailFact>
      </DetailFactList>
      <div
        className={`${DETAIL_FACT_VALUE_OFFSET_CLASS} flex flex-col gap-2 empty:hidden`}
      >
        {state?.unreachable ? (
          <p
            role="status"
            className="text-fg-secondary"
            data-testid="cloud-reach-back-unreachable"
          >
            Cloud chats couldn’t reach this server. {state.unreachable}
          </p>
        ) : null}
        <ErrorBanner
          errorSource="cloud-reach-back-configure"
          className=""
          error={error}
          testId="cloud-reach-back-error"
        />
        {recent.length > 0 && (
          <ul
            className="flex flex-col gap-1 text-fg-secondary"
            data-testid="cloud-reach-back-calls"
            aria-label="Recent calls from cloud chats"
          >
            {recent.map((call) => (
              <li
                key={`${call.at}:${call.toolName ?? ''}`}
                className="flex flex-wrap gap-x-2"
              >
                <span>{formatTimestamp(call.at)}</span>
                <span className={REPLAY_MASK_CLASS}>
                  {call.chatTitle ?? 'A cloud chat'}
                </span>
                <span>{call.toolName ?? 'Started the server'}</span>
                <span>{DECISION_LABELS[call.decision]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {dialogOpen && (
        <AllowDialog
          serverName={serverName}
          state={state}
          loadTools={loadTools}
          onAllow={onAllow}
          onClose={(): void => setDialogOpen(false)}
        />
      )}
    </section>
  );
}
