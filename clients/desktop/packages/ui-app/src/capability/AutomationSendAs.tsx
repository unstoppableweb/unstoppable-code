import type { JSX } from 'react';
import { FormField, SettingsSelect } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  isAccountMcpInstanceConfigId,
  type AccountMcpConnection,
  type McpServerRef,
} from '@canopy/protocol/mcp-servers';
import {
  accountMcpAccountName,
  isDefaultAccountMcpConnection,
} from './accountMcpRows';

/** One account a scheduled run could act as. */
export interface AutomationSendAsAccount {
  readonly configId: string;
  /** The account's name (`acme`). */
  readonly name: string;
  readonly isDefault: boolean;
}

/** A connector the automation uses that the person holds several accounts of. */
export interface AutomationSendAsConnector {
  readonly serverKey: string;
  /** The connector's name (`Slack`). */
  readonly connector: string;
  readonly accounts: readonly AutomationSendAsAccount[];
  /** The account the automation acts as; `null` until one is chosen. */
  readonly value: string | null;
}

export interface AutomationSendAsProps {
  readonly connectors: readonly AutomationSendAsConnector[];
  readonly onChange: (serverKey: string, configId: string) => void;
  readonly disabled?: boolean;
  /**
   * What acts as the account: an automation's prompt (the default), or a
   * workflow's send step (CAN-7186), which a person can also run by hand.
   */
  readonly subject?: 'automation' | 'step';
}

/**
 * "Send as" for a scheduled run (CAN-6233) or a workflow's send step
 * (CAN-7186): one select per connector it uses that the person holds several
 * accounts of. A run nobody watches never picks between accounts, so each
 * must name one; the host keeps Save unavailable until it does. Renders
 * nothing when no connector needs a choice. Account names are blocked from
 * session replay.
 */
export function AutomationSendAs({
  connectors,
  onChange,
  disabled = false,
  subject = 'automation',
}: AutomationSendAsProps): JSX.Element | null {
  if (connectors.length === 0) return null;
  return (
    <div className="flex flex-col gap-3" data-testid="automation-send-as">
      {connectors.map((connector) => (
        <FormField
          key={connector.serverKey}
          label="Send as"
          labelMeta={connector.connector}
          description={
            connector.value === null
              ? subject === 'step'
                ? `Choose the ${connector.connector} account this step sends as. A scheduled run never picks one for you.`
                : `Choose the ${connector.connector} account this automation acts as. A run never picks one for you.`
              : `Runs act as this ${connector.connector} account and stop if it's gone`
          }
          dataTestId={`automation-send-as-${connector.serverKey}`}
        >
          {(control) => (
            <SettingsSelect
              {...control}
              width="fit"
              disabled={disabled}
              value={connector.value}
              placeholder="Choose an account"
              onValueChange={(configId): void =>
                onChange(connector.serverKey, configId)
              }
              options={connector.accounts.map((account) => ({
                value: account.configId,
                label: account.isDefault
                  ? `${account.name} · Default`
                  : account.name,
              }))}
              replayPrivacy={{ blockClassName: REPLAY_BLOCK_CLASS }}
            />
          )}
        </FormField>
      ))}
    </div>
  );
}

/** The account rows the "Send as" choice reads. */
export type AutomationSendAsConnection = Pick<
  AccountMcpConnection,
  'serverKey' | 'configId' | 'kind' | 'displayName' | 'label' | 'isDefault'
>;

/**
 * The connectors an automation needs a "Send as" choice for (CAN-6233):
 * those it selects directly or its plugins bring that the person holds
 * several curated accounts of, including those its collections select.
 * Each one's value is the account the automation's refs name, own refs
 * first, then inherited and collection ones; `null` when none names an
 * existing account, or when an added account (`acct-*`) the automation's own
 * refs name is gone, since a run refuses both. A collection's gone account
 * can't be fixed here; the run names it.
 */
export function automationSendAsConnectors(input: {
  readonly ownRefs: readonly McpServerRef[];
  readonly inheritedRefs?: readonly McpServerRef[];
  /** The MCP refs the automation's selected collections bring. */
  readonly collectionRefs?: readonly McpServerRef[];
  readonly pluginCuratedKeys?: readonly string[];
  readonly connections: readonly AutomationSendAsConnection[];
}): AutomationSendAsConnector[] {
  const curated = input.connections.filter((row) => row.kind === 'CURATED');
  const keys = new Set([
    ...input.ownRefs.map((ref) => ref.serverId),
    ...(input.inheritedRefs ?? []).map((ref) => ref.serverId),
    ...(input.collectionRefs ?? []).map((ref) => ref.serverId),
    ...(input.pluginCuratedKeys ?? []),
  ]);
  const single = (configIds: readonly string[]): string | null => {
    const distinct = new Set(configIds);
    return distinct.size === 1
      ? (distinct.values().next().value ?? null)
      : null;
  };
  const connectors: AutomationSendAsConnector[] = [];
  for (const key of keys) {
    const rows = curated.filter((row) => row.serverKey === key);
    if (rows.length < 2) continue;
    const namedIds = (refs: readonly McpServerRef[] | undefined): string[] =>
      rows
        .filter((row) =>
          (refs ?? []).some(
            (ref) => ref.serverId === key && ref.configId === row.configId,
          ),
        )
        .map((row) => row.configId);
    const ownNamed = namedIds(input.ownRefs);
    connectors.push({
      serverKey: key,
      connector: rows[0]?.displayName ?? key,
      accounts: rows.map((row) => ({
        configId: row.configId,
        name: accountMcpAccountName(row),
        isDefault: isDefaultAccountMcpConnection(row),
      })),
      // Own refs that name two accounts settle nothing: the run can't act as
      // one of them, so the person must pick (CAN-7186).
      value:
        ownNamed.length > 1 ||
        // An own pick that no longer names an account (an added account,
        // or the original `default` one, that was removed) reads as unchosen,
        // never as an inherited account, since the run stops on it.
        input.ownRefs.some(
          (ref) =>
            ref.serverId === key &&
            (isAccountMcpInstanceConfigId(ref.configId) ||
              ref.configId === 'default') &&
            !rows.some((row) => row.configId === ref.configId),
        )
          ? null
          : (ownNamed[0] ??
            // Inherited and collection refs settle it only when they name one
            // account between them: two would load side by side, which a run
            // refuses for a plugin's server, so the person must pick.
            single(
              [...(input.inheritedRefs ?? []), ...(input.collectionRefs ?? [])]
                .filter(
                  (ref) =>
                    ref.serverId === key &&
                    rows.some((row) => row.configId === ref.configId),
                )
                .map((ref) => ref.configId),
            )),
    });
  }
  return connectors;
}
