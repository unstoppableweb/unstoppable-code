import type { JSX } from 'react';
import type { SharedConnectionTool } from '@canopy/protocol/canopy-core';
import {
  ChoiceList,
  ChoiceListRow,
  ErrorBanner,
  FORM_FIELD_DESCRIPTION_CLASS,
  FORM_FIELD_LABEL_CLASS,
  Fieldset,
  Notice,
  Skeleton,
} from '@canopy/ui-shared/components';
import { REPLAY_MASK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

/** One shared connection's tools, as the host read them. */
export type AutomationSharedWritesTools =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | {
      readonly kind: 'loaded';
      readonly tools: readonly SharedConnectionTool[];
    };

/** A shared connection in force for the automation's project. */
export interface AutomationSharedWritesConnection {
  /** The connection's external id: the key of the write list. */
  readonly id: string;
  /** The connection's name (`Linear`). */
  readonly name: string;
  /**
   * The project's tool limit on it, or `null` for the connection's own
   * policy. A run can't call a tool outside it, so it is never offered.
   */
  readonly limit: readonly string[] | null;
  readonly tools: AutomationSharedWritesTools;
}

/** An automation's allowed writes: tool names by shared connection id. */
export type AutomationSharedWritesValue = Readonly<
  Record<string, readonly string[]>
>;

export interface AutomationSharedWritesProps {
  readonly connections: readonly AutomationSharedWritesConnection[];
  readonly value: AutomationSharedWritesValue | undefined;
  /** The connection's new write list, in the order the list shows it. */
  readonly onChange: (connectionId: string, tools: string[]) => void;
  /** Reads the connection's tools again after a failed read. */
  readonly onRetry: (connectionId: string) => void;
  /** The write list is past what a scheduled run can carry. */
  readonly tooMany?: boolean;
  readonly disabled?: boolean;
}

/** Sample tools for a connection while its tools load: of the loaded shape. */
const SAMPLE_TOOLS: readonly SharedConnectionTool[] = [
  { name: 'sample_tool_1', title: 'Sample tool' },
  { name: 'sample_tool_2', title: 'Sample tool' },
];

/**
 * The tools a scheduled run may be allowed to call as writes on one shared
 * connection (CAN-6252): every tool the server doesn't mark read-only,
 * including those it doesn't classify, within the project's limit. Reads
 * are always allowed, so they are never listed. Names the automation already
 * allows that the server no longer offers follow, so each can be unticked.
 */
export function automationSharedWriteOptions(
  tools: readonly SharedConnectionTool[],
  limit: readonly string[] | null,
  allowed: readonly string[],
): SharedConnectionTool[] {
  const inLimit = limit === null ? null : new Set(limit);
  const writes = tools.filter(
    (tool) =>
      tool.readOnly !== true && (inLimit === null || inLimit.has(tool.name)),
  );
  const listed = new Set(writes.map((tool) => tool.name));
  const kept: SharedConnectionTool[] = [];
  for (const name of allowed) {
    if (listed.has(name)) continue;
    listed.add(name);
    kept.push({ name });
  }
  return [...writes, ...kept];
}

/**
 * The write list with one connection's tools replaced: a connection with no
 * tools drops out, and an empty list is `undefined`, so the action leaves
 * the key out and allows no writes.
 */
export function withAutomationSharedWrites(
  value: AutomationSharedWritesValue | undefined,
  connectionId: string,
  tools: readonly string[],
): Record<string, string[]> | undefined {
  const next: Record<string, string[]> = {};
  for (const [id, names] of Object.entries(value ?? {})) {
    if (id !== connectionId && names.length > 0) next[id] = [...names];
  }
  if (tools.length > 0) next[connectionId] = [...tools];
  return Object.keys(next).length > 0 ? next : undefined;
}

/**
 * "Allowed write actions" for a scheduled run on its project's shared
 * connections (CAN-6252). A run nobody watches may read from every shared
 * connection in force for its project; it may change something only through
 * the tools ticked here, and anything else is refused. Each connection loads
 * its own tools: one that fails says so with a retry and holds up nothing
 * else. Renders nothing when the project has no shared connection.
 * Connection names are masked in session replay.
 */
export function AutomationSharedWrites({
  connections,
  value,
  onChange,
  onRetry,
  tooMany = false,
  disabled = false,
}: AutomationSharedWritesProps): JSX.Element | null {
  if (connections.length === 0) return null;
  const unclassified = connections.some(
    (connection) =>
      connection.tools.kind === 'loaded' &&
      automationSharedWriteOptions(
        connection.tools.tools,
        connection.limit,
        [],
      ).some((tool) => tool.readOnly === undefined),
  );
  return (
    <Fieldset
      gap="item"
      legend={
        <span className="flex flex-col gap-1">
          <span className={FORM_FIELD_LABEL_CLASS}>Allowed write actions</span>
          <span className={FORM_FIELD_DESCRIPTION_CLASS}>
            Scheduled runs can read from these shared connections. Choose what
            they may change. Anything else is refused, and your organization’s
            admins are told.
          </span>
        </span>
      }
      data-testid="automation-shared-writes"
    >
      {tooMany && (
        <Notice data-testid="automation-shared-writes-too-many">
          That’s more write actions than a scheduled run can carry. Allow fewer.
        </Notice>
      )}
      {connections.map((connection) => (
        <SharedConnectionWrites
          key={connection.id}
          connection={connection}
          allowed={value?.[connection.id] ?? []}
          disabled={disabled}
          onChange={(tools): void => onChange(connection.id, tools)}
          onRetry={(): void => onRetry(connection.id)}
        />
      ))}
      {unclassified && (
        <p className={FORM_FIELD_DESCRIPTION_CLASS}>
          Tools whose server doesn’t say whether they’re read-only are listed as
          write actions.
        </p>
      )}
    </Fieldset>
  );
}

function SharedConnectionWrites({
  connection,
  allowed,
  disabled,
  onChange,
  onRetry,
}: {
  connection: AutomationSharedWritesConnection;
  allowed: readonly string[];
  disabled: boolean;
  onChange: (tools: string[]) => void;
  onRetry: () => void;
}): JSX.Element {
  const testId = `automation-shared-writes-${connection.id}`;
  const options =
    connection.tools.kind === 'loaded'
      ? automationSharedWriteOptions(
          connection.tools.tools,
          connection.limit,
          allowed,
        )
      : [];
  const chosen = new Set(allowed);
  const toggle = (name: string): void => {
    const next = new Set(chosen);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange(options.map((tool) => tool.name).filter((tool) => next.has(tool)));
  };
  return (
    <Fieldset
      gap="control"
      legend={
        // Smaller than the section's label, so each connection reads as
        // part of the section.
        <span
          className={`text-xs font-medium fg-secondary ${REPLAY_MASK_CLASS}`}
        >
          {connection.name}
        </span>
      }
      data-testid={testId}
    >
      {connection.tools.kind === 'failed' ? (
        <ErrorBanner
          errorSource="automation-shared-writes-tools"
          testId={`${testId}-error`}
          className=""
          error="Couldn’t load its tools"
          onRetry={onRetry}
        />
      ) : connection.tools.kind === 'loading' ? (
        <Skeleton
          loading
          label="Loading this connection’s tools"
          testId={`${testId}-loading`}
          className="w-full"
        >
          <WriteChoices
            options={SAMPLE_TOOLS}
            chosen={new Set()}
            disabled
            onToggle={noop}
          />
        </Skeleton>
      ) : options.length === 0 ? (
        <p className={FORM_FIELD_DESCRIPTION_CLASS}>
          No write actions to choose
        </p>
      ) : (
        <WriteChoices
          options={options}
          chosen={chosen}
          disabled={disabled}
          testId={`${testId}-list`}
          onToggle={toggle}
        />
      )}
    </Fieldset>
  );
}

function noop(): void {}

function WriteChoices({
  options,
  chosen,
  disabled,
  testId,
  onToggle,
}: {
  options: readonly SharedConnectionTool[];
  chosen: ReadonlySet<string>;
  disabled: boolean;
  testId?: string;
  onToggle: (name: string) => void;
}): JSX.Element {
  // The list scrolls inside a bounded parent; ChoiceList owns its own box.
  return (
    <div className="flex max-h-72 min-h-0 flex-col">
      <ChoiceList aria-label="Write actions" data-testid={testId}>
        {options.map((tool) => (
          <ChoiceListRow
            key={tool.name}
            selected={chosen.has(tool.name)}
            disabled={disabled}
            data-testid={
              testId === undefined ? undefined : `${testId}-${tool.name}`
            }
            onClick={(): void => onToggle(tool.name)}
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{tool.title ?? tool.name}</span>
              {tool.description !== undefined && (
                <span className="line-clamp-2 text-xs text-pretty fg-secondary">
                  {tool.description}
                </span>
              )}
            </span>
          </ChoiceListRow>
        ))}
      </ChoiceList>
    </div>
  );
}
