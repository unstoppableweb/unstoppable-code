'use client';

import { useState, type JSX, type ReactNode } from 'react';
import type {
  ExternalAgentActivityItem,
  ExternalAgentConnectionDetail,
  ExternalAgentConnectionSummary,
  ExternalAgentDesktop,
  ExternalAgentNotice,
  ExternalAgentOrganization,
  ExternalAgentServerAddress,
  ExternalAgentWaitingAction,
} from '@canopy/protocol/external-agents';
import { externalAgentDisplayName } from '@canopy/protocol/external-agents';
import {
  Stack,
  Button,
  Checkbox,
  CopyButton,
  DetailActionBar,
  Disclosure,
  McpServerLogo,
  Notice,
  NoticeButton,
  Radio,
  SettingsRowsRow,
  StatusPill,
  ToggleSwitch,
  EmptyStateRow,
  Heading,
  FieldError,
} from '@canopy/ui-shared/components';
import {
  Bot,
  ChevronLeftMediumIcon,
  ChevronRightIcon,
  ClaudeIcon,
  CodexIcon,
  CursorIcon,
} from '@canopy/ui-shared/icons/AppIcons';
// Imported directly, not through AppIcons, so they load only on this page.
import {
  HermesLogo,
  MuseLogo,
  OpenClawLogo,
  OpenCodeLogo,
} from '@canopy/ui-shared/icons';
import { formatRelativeTime } from '@canopy/ui-shared/lib/format-relative-time';
import {
  accessSummaryLine,
  activityTargetsLine,
  connectionStatusLabel,
  claudeCodeAddCommand,
  codexAddCommand,
  cursorMcpSnippet,
  hermesAddCommand,
  openClawAddCommand,
  openCodeAuthCommand,
  openCodeConfigSnippet,
  EXTERNAL_AGENT_SERVER_COPY,
  TEXT_CONTENT_COMPATIBILITY_COPY,
  waitingTimingLine,
} from './display';
import {
  accessHostsMissing,
  desktopAccessRows,
  devicesWriteAccess,
  HOSTS_REQUIRED_MESSAGE,
  MANAGED_HOST_ID,
  MAX_ACCESS_DESKTOPS,
  organizationChoiceUnavailable,
  showsAccessDevices,
  showsAccessHosts,
  showsAccessOrganizations,
  type AccessDeviceChoice,
  type AccessFormState,
  type AccessModelSource,
} from './access-model';
import { externalAgentConfirmationPath, externalAgentPath } from './paths';
import { Surface } from '@canopy/ui-shared/components';

export function SettingsSection({
  title,
  description,
  children,
  testId,
}: {
  readonly title?: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly testId?: string;
}): JSX.Element {
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid={testId}>
      {title || description ? (
        <Stack gap="tight">
          {title ? (
            <Heading level={2} variant="section">
              {title}
            </Heading>
          ) : null}
          {description ? (
            <div className="text-xs text-pretty fg-secondary">
              {description}
            </div>
          ) : null}
        </Stack>
      ) : null}
      {children}
    </section>
  );
}

export function SettingsGroup({
  children,
  disabled = false,
}: {
  readonly children?: ReactNode;
  readonly disabled?: boolean;
}): JSX.Element {
  return (
    <Surface variant="group" className="min-w-0">
      <div
        aria-disabled={disabled || undefined}
        className={`flex min-w-0 flex-col divide-y px-4 *:py-3 ${disabled ? 'pointer-events-none opacity-50' : ''}`}
      >
        {children}
      </div>
    </Surface>
  );
}

export function SettingsRow({
  label,
  description,
  control,
  htmlFor,
  children,
  testId,
  pendingActionId,
}: {
  readonly label: ReactNode;
  readonly description?: ReactNode;
  readonly control?: ReactNode;
  readonly htmlFor?: string;
  readonly children?: ReactNode;
  readonly testId?: string;
  readonly pendingActionId?: string;
}): JSX.Element {
  return (
    <div
      className="min-w-0"
      data-testid={testId}
      data-pending-action-id={pendingActionId}
    >
      <SettingsRowsRow
        label={label}
        description={description}
        control={control}
        htmlFor={htmlFor}
      >
        {children}
      </SettingsRowsRow>
    </div>
  );
}

/** Requests that need the person's confirmation, ordered oldest first. */
export function WaitingRows({
  waiting,
  onOpenPath,
  showAgent,
}: {
  readonly waiting: readonly ExternalAgentWaitingAction[];
  readonly onOpenPath: (path: string) => void;
  readonly showAgent: boolean;
}): JSX.Element {
  const now = Date.now();
  return (
    <SettingsGroup>
      {waiting.map((request) => {
        const timing = waitingTimingLine(
          request.requestedAt,
          request.decisionExpiresAt,
          now,
        );
        const description = showAgent
          ? `${externalAgentDisplayName(request)} · ${EXTERNAL_AGENT_SERVER_COPY[request.server].title}. ${timing}`
          : timing;
        return (
          <SettingsRow
            key={request.pendingActionId}
            label={request.action}
            description={description}
            testId="external-agents-waiting-row"
            pendingActionId={request.pendingActionId}
            control={
              <Button
                variant="secondary"
                size="compact"
                aria-label={`Review: ${request.action}`}
                onClick={(): void =>
                  onOpenPath(
                    externalAgentConfirmationPath(request.pendingActionId),
                  )
                }
              >
                Review
              </Button>
            }
          />
        );
      })}
    </SettingsGroup>
  );
}

export function FactRow({
  label,
  description,
  children,
}: {
  readonly label: string;
  readonly description?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-h-7 min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-24 flex-1 flex flex-col gap-0.5">
        <div className="text-s fg-secondary">{label}</div>
        {description ? (
          <div className="text-xs text-pretty fg-secondary">{description}</div>
        ) : null}
      </div>
      <div className="min-w-0 text-s wrap-anywhere fg-primary sm:max-w-3/5 sm:text-right">
        {children}
      </div>
    </div>
  );
}

export function ChoiceRow({
  id,
  label,
  description,
  checked,
  onChange,
  kind,
  name,
  disabled = false,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly description: string;
  readonly checked: boolean;
  readonly onChange: () => void;
  readonly kind: 'radio' | 'checkbox';
  readonly name?: string;
  readonly disabled?: boolean;
}): JSX.Element {
  const input =
    kind === 'radio' ? (
      <Radio
        id={id}
        name={name}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        data-testid={id}
      />
    ) : (
      <Checkbox
        id={id}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        data-testid={id}
      />
    );

  return (
    <div className="min-w-0 py-2">
      <SettingsRowsRow
        label={label}
        description={description}
        htmlFor={id}
        control={input}
      />
    </div>
  );
}

const DISMISSED_NOTICES_KEY = 'canopy:external-agents:dismissed-notices:v1';

function noticeKey(notice: ExternalAgentNotice): string {
  return `${notice.connectionId}:${notice.kind}:${notice.at}`;
}

// Best effort: unreadable storage shows every notice.
function readDismissedNotices(): ReadonlySet<string> {
  try {
    const stored: unknown = JSON.parse(
      globalThis.localStorage?.getItem(DISMISSED_NOTICES_KEY) ?? '[]',
    );
    return new Set(
      Array.isArray(stored)
        ? stored.filter((key): key is string => typeof key === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export function NoticeList({
  notices,
  onOpenPath,
}: {
  readonly notices: readonly ExternalAgentNotice[];
  readonly onOpenPath: (path: string) => void;
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(readDismissedNotices);
  const visible = notices.filter((notice) => !dismissed.has(noticeKey(notice)));
  if (visible.length === 0) return null;

  const dismiss = (notice: ExternalAgentNotice): void => {
    // Keeps only notices still listed, so expired ones leave storage.
    const next = new Set([
      noticeKey(notice),
      ...notices.map(noticeKey).filter((key) => dismissed.has(key)),
    ]);
    setDismissed(next);
    try {
      globalThis.localStorage?.setItem(
        DISMISSED_NOTICES_KEY,
        JSON.stringify([...next]),
      );
    } catch {
      // A failed write hides the notice only until the page reloads.
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {visible.map((notice) => {
        const serverTitle = EXTERNAL_AGENT_SERVER_COPY[notice.server].title;
        const connected = notice.kind === 'connected';
        const message = connected
          ? `${externalAgentDisplayName(notice)} can now use ${serverTitle}.`
          : `${externalAgentDisplayName(notice)} can now do more with ${serverTitle}.`;
        return (
          <Notice
            key={noticeKey(notice)}
            intent={connected ? 'positive' : 'attention'}
            title={connected ? 'New agent connected.' : 'Access widened.'}
            onDismiss={(): void => dismiss(notice)}
            dismissLabel={`Dismiss: ${message}`}
            dismissTestId="external-agents-notice-dismiss"
            actions={
              <NoticeButton
                variant="secondary"
                onClick={(): void =>
                  onOpenPath(externalAgentPath(notice.connectionId))
                }
              >
                Review
              </NoticeButton>
            }
            data-testid="external-agents-notice"
            data-connection-id={notice.connectionId}
          >
            {message}
          </Notice>
        );
      })}
    </div>
  );
}

export function AgentRow({
  connection,
  onOpen,
}: {
  readonly connection: ExternalAgentConnectionSummary;
  readonly onOpen: () => void;
}): JSX.Element {
  const serverTitle = EXTERNAL_AGENT_SERVER_COPY[connection.server].title;
  const status = connectionStatusLabel(connection.status);
  const lastUsed =
    connection.lastUsedAt === null
      ? 'Not used yet'
      : `Used ${formatRelativeTime(connection.lastUsedAt)}`;

  // The divider draws on this wrapper (it curved on the rounded button); the
  // button's -my-3 py-3 reclaims the group's row padding so the whole row clicks.
  return (
    <div>
      <button
        type="button"
        data-settings-control="row"
        onClick={onOpen}
        className="focus-ring -my-3 flex w-full min-w-0 items-center gap-3 rounded-md py-3 text-left"
        data-testid="external-agent-row"
        data-connection-id={connection.id}
      >
        <McpServerLogo
          name={connection.clientName}
          size={32}
          fallback="monogram"
        />
        <span className="min-w-0 flex-1 flex flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 text-s font-medium fg-primary">
              {externalAgentDisplayName(connection)}
            </span>
            {status ? (
              <StatusPill
                tone="secondary"
                data-testid="external-agent-row-status"
              >
                {status}
              </StatusPill>
            ) : null}
            {!connection.verified ? (
              <StatusPill tone="warning">Unverified</StatusPill>
            ) : null}
          </span>
          <span className="block text-xs text-pretty fg-secondary">
            {`${serverTitle} · ${lastUsed}`}
          </span>
          <span className="block text-xs text-pretty fg-secondary">
            {accessSummaryLine(connection.access)}
          </span>
        </span>
        <ChevronRightIcon
          size={16}
          aria-hidden
          className="shrink-0 fg-tertiary"
        />
      </button>
    </div>
  );
}

export function ConnectSection({
  servers,
  cursorClientId,
  showComputersHint,
}: {
  readonly servers: readonly ExternalAgentServerAddress[];
  readonly cursorClientId: string;
  /** The page lists Computers, so the Tasks address points there. */
  readonly showComputersHint: boolean;
}): JSX.Element {
  return (
    <SettingsSection
      title="Connect an agent"
      description="Choose your agent for its setup steps. Any agent that supports MCP can connect."
      testId="external-agents-connect"
    >
      <SettingsGroup>
        <AgentSetup
          testId="external-agents-claude-code"
          logo={<ClaudeIcon size={16} />}
          name="Claude Code"
          description={
            <>
              Run these in your terminal, then run <InlineCode>/mcp</InlineCode>{' '}
              in Claude Code and choose each server to sign in.
            </>
          }
        >
          <ServerCommands
            agent="claude-code"
            servers={servers}
            command={claudeCodeAddCommand}
          />
        </AgentSetup>
        <AgentSetup
          testId="external-agents-codex"
          logo={<CodexIcon size={16} />}
          name="Codex"
          description={
            <>
              Run these in your terminal. Codex opens the sign-in page for each
              server; if it doesn’t, run{' '}
              <InlineCode>codex mcp login</InlineCode> with the server name.
            </>
          }
        >
          <ServerCommands
            agent="codex"
            servers={servers}
            command={codexAddCommand}
          />
        </AgentSetup>
        <AgentSetup
          testId="external-agents-cursor"
          logo={<CursorIcon size={16} />}
          name="Cursor"
          description="Cursor can’t register itself here. Copy these entries into Cursor’s mcp.json instead."
          control={
            <CopyButton
              value={cursorMcpSnippet(servers, cursorClientId)}
              ariaLabel="Copy entries"
              label="Copy entries"
              copiedLabel="Copied"
              variant="secondary"
              size="compact"
              dataTestId="external-agents-cursor-copy"
            />
          }
        >
          <Surface variant="inset" className="max-w-full overflow-hidden">
            <pre
              data-testid="external-agents-cursor-snippet"
              className="overflow-x-auto whitespace-pre p-3 font-mono text-xs fg-secondary"
            >
              {cursorMcpSnippet(servers, cursorClientId)}
            </pre>
          </Surface>
        </AgentSetup>
        <AgentSetup
          testId="external-agents-opencode"
          logo={<OpenCodeLogo aria-hidden />}
          name="OpenCode"
          description={
            <>
              Add these entries to <InlineCode>opencode.json</InlineCode>, then
              run each sign-in command in your terminal.
            </>
          }
        >
          <CommandBlock
            value={openCodeConfigSnippet(servers)}
            testId="external-agents-opencode-config"
          />
          <ServerCommands
            agent="opencode"
            servers={servers}
            command={openCodeAuthCommand}
          />
        </AgentSetup>
        <AgentSetup
          testId="external-agents-hermes"
          logo={<HermesLogo aria-hidden />}
          name="Hermes"
          description="Run these in your terminal. Each adds the server, then opens its sign-in page."
        >
          <ServerCommands
            agent="hermes"
            servers={servers}
            command={hermesAddCommand}
          />
        </AgentSetup>
        <AgentSetup
          testId="external-agents-openclaw"
          logo={<OpenClawLogo aria-hidden />}
          name="OpenClaw"
          description="OpenClaw can’t sign in here yet: it doesn’t publish the client ID document this site requires. These commands add the servers so sign-in works once it does. Stop the OpenClaw Gateway before running them."
        >
          <ServerCommands
            agent="openclaw"
            servers={servers}
            command={openClawAddCommand}
          />
        </AgentSetup>
        <AgentSetup
          testId="external-agents-muse"
          logo={<MuseLogo aria-hidden />}
          name="Meta Muse"
          description={
            <>
              Ask Muse to set up a custom connector and give it one of the
              addresses under Other MCP agent. When Muse asks for a client ID,
              enter <InlineCode>{MUSE_CLIENT_ID}</InlineCode>.
            </>
          }
          control={
            <CopyButton
              value={MUSE_CLIENT_ID}
              ariaLabel="Copy client ID"
              label="Copy client ID"
              copiedLabel="Copied"
              variant="secondary"
              size="compact"
              dataTestId="external-agents-muse-copy"
            />
          }
        />
        <AgentSetup
          testId="external-agents-other"
          logo={<Bot size={16} />}
          name="Other MCP agent"
          description="Add an MCP server in your agent and paste one of these addresses."
        >
          <div className="flex min-w-0 flex-col gap-3">
            {servers.map((server) => {
              const copy = EXTERNAL_AGENT_SERVER_COPY[server.server];
              return (
                <div
                  key={server.server}
                  data-testid={`external-agents-server-${server.server}`}
                >
                  <SettingsRow
                    label={copy.title}
                    description={
                      <span className="min-w-0 flex flex-col gap-0.5">
                        <span className="block">{copy.line}</span>
                        <span className="block wrap-anywhere font-mono fg-secondary">
                          {server.url}
                        </span>
                        {showComputersHint && server.server === 'tasks' ? (
                          <span
                            className="block"
                            data-testid="external-agents-tasks-computers-hint"
                          >
                            To work on your devices, connect a computer under
                            Computers.
                          </span>
                        ) : null}
                      </span>
                    }
                    control={
                      <CopyButton
                        value={server.url}
                        ariaLabel="Copy"
                        label="Copy"
                        copiedLabel="Copied"
                        variant="secondary"
                        size="compact"
                      />
                    }
                  />
                </div>
              );
            })}
            <ol className="flex list-decimal flex-col gap-1 pl-5 text-s fg-secondary">
              <li>
                In your agent, add an MCP server and paste one of these
                addresses.
              </li>
              <li>
                The agent sends you to this site to sign in and choose what it
                can do.
              </li>
              <li>The agent then appears on this page.</li>
            </ol>
          </div>
        </AgentSetup>
      </SettingsGroup>
    </SettingsSection>
  );
}

// Matches Muse's pre-registered OAuth client in apps/web oauth-server.
const MUSE_CLIENT_ID = 'meta-muse';

/** One agent's setup steps, collapsed to its logo and name. */
function AgentSetup({
  logo,
  name,
  description,
  control,
  children,
  testId,
}: {
  readonly logo: ReactNode;
  readonly name: string;
  readonly description: ReactNode;
  readonly control?: ReactNode;
  readonly children?: ReactNode;
  readonly testId: string;
}): JSX.Element {
  return (
    <Disclosure label={name} leadingIcon={logo} dataTestId={testId}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 sm:gap-6">
        <div className="min-w-0 flex-1 text-xs text-pretty fg-secondary">
          {description}
        </div>
        {control ? (
          <div className="flex shrink-0 items-center gap-2">{control}</div>
        ) : null}
      </div>
      {children}
    </Disclosure>
  );
}

function InlineCode({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return <span className="font-mono fg-primary">{children}</span>;
}

/** A copyable command or config block. */
function CommandBlock({
  value,
  caption,
  testId,
}: {
  readonly value: string;
  readonly caption?: string;
  readonly testId: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={testId}>
      {caption ? <span className="text-xs fg-tertiary">{caption}</span> : null}
      <Surface variant="inset" padding="compact" className="min-w-0">
        <div className="flex items-start gap-2">
          <pre className="min-w-0 flex-1 whitespace-pre-wrap wrap-anywhere font-mono text-xs fg-secondary">
            {value}
          </pre>
          <CopyButton
            value={value}
            ariaLabel={caption ? `Copy ${caption} command` : 'Copy'}
            label="Copy"
            copiedLabel="Copied"
            variant="secondary"
            size="compact"
            dataTestId={`${testId}-copy`}
          />
        </div>
      </Surface>
    </div>
  );
}

/** One copyable command per MCP server, captioned with the server's name. */
function ServerCommands({
  agent,
  servers,
  command,
}: {
  readonly agent: string;
  readonly servers: readonly ExternalAgentServerAddress[];
  readonly command: (server: ExternalAgentServerAddress) => string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {servers.map((server) => (
        <CommandBlock
          key={server.server}
          caption={EXTERNAL_AGENT_SERVER_COPY[server.server].title}
          value={command(server)}
          testId={`external-agents-${agent}-${server.server}`}
        />
      ))}
    </div>
  );
}

export function IdentityBlock({
  detail,
}: {
  readonly detail: ExternalAgentConnectionDetail;
}): JSX.Element {
  const status = connectionStatusLabel(detail.status);
  return (
    <div className="flex min-w-0 items-center gap-4">
      <McpServerLogo
        name={detail.clientName}
        size={48}
        fallback="monogram"
        shape="squircle"
      />
      <div className="min-w-0 flex flex-col gap-0.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Heading level={2} variant="page" className="min-w-0">
            {externalAgentDisplayName(detail)}
          </Heading>
          {status ? <StatusPill tone="secondary">{status}</StatusPill> : null}
        </div>
        <div className="text-s text-pretty fg-secondary">
          {`${EXTERNAL_AGENT_SERVER_COPY[detail.server].title} · ${detail.verified ? 'Verified' : 'Unverified'}`}
        </div>
      </div>
    </div>
  );
}

export function ActivityList({
  items,
}: {
  readonly items: readonly ExternalAgentActivityItem[];
}): JSX.Element {
  return (
    <SettingsGroup>
      {items.length === 0 ? (
        <EmptyStateRow
          testId="external-agent-activity-empty"
          title="Nothing yet."
        />
      ) : (
        items.map((item, index) => {
          const targets = activityTargetsLine(item.targets);
          return (
            <div
              key={`${item.at}-${item.tool}-${index}`}
              data-testid="external-agent-activity-row"
              className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1"
            >
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <div className="text-s text-pretty fg-primary">
                  {item.toolTitle ?? item.tool}
                </div>
                {targets.length > 0 ? (
                  <div className="text-xs text-pretty fg-secondary">
                    {targets}
                  </div>
                ) : null}
              </div>
              {item.outcome === 'error' ? (
                <span
                  className="shrink-0 text-xs fg-secondary"
                  title={item.outcomeCode ?? undefined}
                >
                  Failed
                </span>
              ) : null}
              <div className="shrink-0 text-right text-xs tabular-nums fg-tertiary">
                {formatRelativeTime(item.at)}
              </div>
            </div>
          );
        })
      )}
    </SettingsGroup>
  );
}

export function BackRow({
  onBack,
  actions,
}: {
  readonly onBack: () => void;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-3 sm:gap-6">
      <Button
        variant="secondary"
        size="compact"
        onClick={onBack}
        data-testid="external-agent-back"
      >
        <ChevronLeftMediumIcon size={14} aria-hidden />
        External agents
      </Button>
      <DetailActionBar secondary={actions} />
    </div>
  );
}

/** Where the person's paired devices are, as the device selector shows them. */
export type DesktopListState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly desktops: readonly ExternalAgentDesktop[];
    }
  | { readonly status: 'problem' };

/** A quiet connection hint for one device row. */
export function desktopConnectionHint(desktop: ExternalAgentDesktop): string {
  if (desktop.connection === 'active') return 'Connected';
  if (desktop.connection === 'reconnecting') return 'Reconnecting';
  return desktop.lastSeenAt === null
    ? 'Not connected'
    : `Last seen ${formatRelativeTime(desktop.lastSeenAt)}`;
}

function desktopDescription(desktop: ExternalAgentDesktop): string {
  const hint = desktopConnectionHint(desktop);
  return desktop.hostname === null || desktop.hostname === ''
    ? hint
    : `${desktop.hostname} · ${hint}`;
}

/** A host's name, then its host ID in monospace: "Work laptop · 7k3q9x2m4p". */
function HostLabel({
  name,
  hostId,
  testId,
}: {
  readonly name: string;
  readonly hostId: string;
  readonly testId?: string;
}): JSX.Element {
  return (
    <>
      {name}
      <span aria-hidden className="fg-tertiary">
        {' · '}
      </span>
      <span className="font-mono font-normal fg-secondary" data-testid={testId}>
        {hostId}
      </span>
    </>
  );
}

export const HOST_IDS_NOTE =
  'Host IDs stay the same unless the app is reinstalled.';

/**
 * Which devices a Tasks connection may reach: all of them, the checked ones,
 * or none. Shared by the consent page and the agent page through
 * {@link HostAccessChoices}; each host supplies the list and owns the draft.
 * A checked device that is not paired anymore stays checked (and in the
 * policy) until the person removes it.
 */
export function DeviceAccessChoices({
  idPrefix,
  choice,
  remoteIds,
  desktops,
  disabled = false,
  onChoiceChange,
  onDeviceChange,
  onRetry,
}: {
  /** Prefixes every control id and test id, e.g. `consent` or `external-agent`. */
  readonly idPrefix: string;
  readonly choice: AccessDeviceChoice;
  readonly remoteIds: readonly string[];
  readonly desktops: DesktopListState;
  readonly disabled?: boolean;
  readonly onChoiceChange: (choice: AccessDeviceChoice) => void;
  readonly onDeviceChange: (remoteId: string, selected: boolean) => void;
  /** Loads the list again after a failure; without it the row says to reload. */
  readonly onRetry?: () => void;
}): JSX.Element {
  const rows = desktopAccessRows(
    desktops.status === 'ready' ? desktops.desktops : null,
    remoteIds,
  );
  const selectionFull = new Set(remoteIds).size >= MAX_ACCESS_DESKTOPS;
  const radioName = `${idPrefix}-device-scope`;
  const selected = choice === 'selected';

  return (
    <fieldset
      className="min-w-0"
      disabled={disabled}
      data-testid={`${idPrefix}-device-choices`}
    >
      <legend className="sr-only">Devices this agent can reach</legend>
      <SettingsGroup disabled={disabled}>
        <ChoiceRow
          id={`${idPrefix}-devices-all`}
          label="All devices, including ones you add later"
          description="New devices are included when you pair them."
          checked={choice === 'all'}
          onChange={(): void => onChoiceChange('all')}
          kind="radio"
          name={radioName}
          disabled={disabled}
        />
        <ChoiceRow
          id={`${idPrefix}-devices-selected`}
          label="Selected devices"
          description="Choose which devices this agent can reach."
          checked={selected}
          onChange={(): void => onChoiceChange('selected')}
          kind="radio"
          name={radioName}
          disabled={disabled}
        />
        <ChoiceRow
          id={`${idPrefix}-devices-none`}
          label="No devices"
          description="The agent can’t reach any of your devices."
          checked={choice === 'none'}
          onChange={(): void => onChoiceChange('none')}
          kind="radio"
          name={radioName}
          disabled={disabled}
        />
        {selected && desktops.status === 'loading' ? (
          <div
            role="status"
            data-testid={`${idPrefix}-devices-loading`}
            className="text-xs fg-secondary"
          >
            Loading your devices…
          </div>
        ) : null}
        {selected && desktops.status === 'problem' ? (
          <SettingsRow
            label="Couldn’t load your devices."
            description={
              onRetry === undefined
                ? 'Reload the page to try again. Devices you already chose stay chosen.'
                : 'Devices you already chose stay chosen.'
            }
            testId={`${idPrefix}-devices-error`}
            control={
              onRetry === undefined ? undefined : (
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={disabled}
                  data-testid={`${idPrefix}-devices-retry`}
                  onClick={onRetry}
                >
                  Try again
                </Button>
              )
            }
          />
        ) : null}
        {selected &&
        desktops.status === 'ready' &&
        rows.available.length === 0 &&
        rows.unavailableIds.length === 0 ? (
          <div
            data-testid={`${idPrefix}-devices-empty`}
            className="text-xs text-pretty fg-secondary"
          >
            You haven’t paired a device yet. Pair one from the desktop app, then
            choose it here.
          </div>
        ) : null}
        {selected
          ? rows.available.map(({ desktop, selected: checked }) => (
              <ChoiceRow
                key={desktop.remoteId}
                id={`${idPrefix}-device-${desktop.remoteId}`}
                label={
                  <HostLabel
                    name={desktop.name}
                    hostId={desktop.hostCode}
                    testId={`${idPrefix}-device-host-id-${desktop.remoteId}`}
                  />
                }
                description={desktopDescription(desktop)}
                checked={checked}
                onChange={(): void =>
                  onDeviceChange(desktop.remoteId, !checked)
                }
                kind="checkbox"
                disabled={disabled || (selectionFull && !checked)}
              />
            ))
          : null}
        {selected
          ? rows.unavailableIds.map((remoteId, index) => (
              <SettingsRow
                key={remoteId}
                label="Unavailable device"
                description="This device isn’t paired anymore, so the agent can’t reach it."
                testId={`${idPrefix}-device-unavailable-${remoteId}`}
                control={
                  <Button
                    variant="secondary"
                    size="compact"
                    disabled={disabled}
                    aria-label={
                      rows.unavailableIds.length > 1
                        ? `Remove unavailable device ${String(index + 1)}`
                        : 'Remove unavailable device'
                    }
                    data-testid={`${idPrefix}-device-remove-${remoteId}`}
                    onClick={(): void => onDeviceChange(remoteId, false)}
                  >
                    Remove
                  </Button>
                }
              />
            ))
          : null}
        {selected && rows.available.length > 0 ? (
          <div
            data-testid={`${idPrefix}-host-ids-note`}
            className="text-xs text-pretty fg-secondary"
          >
            {HOST_IDS_NOTE}
          </div>
        ) : null}
      </SettingsGroup>
    </fieldset>
  );
}

/**
 * The Hosts section of a Tasks connection: the Cloud agents switch for the
 * managed host and the device choice. The one implementation for the consent
 * page and the agent page; each wraps it in its own section and owns the
 * draft. Remote Control off keeps devices unavailable.
 */
export function HostAccessChoices({
  idPrefix,
  source,
  draft,
  remoteControlEnabled,
  cloudName,
  desktops,
  disabled = false,
  keepUnusedScope = false,
  onManagedChange,
  onDeviceChoiceChange,
  onDeviceChange,
  onRetryDevices,
}: {
  /** Prefixes every control id and test id, e.g. `consent` or `external-agent`. */
  readonly idPrefix: string;
  readonly source: AccessModelSource;
  readonly draft: AccessFormState;
  readonly remoteControlEnabled: boolean;
  /** The brand's cloud product name from the host's brand helpers. */
  readonly cloudName: string;
  readonly desktops: DesktopListState;
  readonly disabled?: boolean;
  /** Matches the `buildAccess` option the host saves with. */
  readonly keepUnusedScope?: boolean;
  readonly onManagedChange: (managed: boolean) => void;
  readonly onDeviceChoiceChange: (choice: AccessDeviceChoice) => void;
  readonly onDeviceChange: (remoteId: string, selected: boolean) => void;
  readonly onRetryDevices?: () => void;
}): JSX.Element {
  const managedSwitchId = `${idPrefix}-hosts-managed`;
  const managedNoteId = `${idPrefix}-hosts-managed-note`;
  const devicesAvailable = showsAccessDevices(source, remoteControlEnabled);
  const missing = accessHostsMissing(source, draft, { keepUnusedScope });

  return (
    <div
      className="flex min-w-0 flex-col gap-3"
      data-testid={`${idPrefix}-host-choices`}
    >
      {devicesWriteAccess(source, draft, remoteControlEnabled) ? (
        <Notice intent="attention" title="This reaches your computer.">
          With write access, this agent can direct agents on the devices you
          choose. They run commands and edit files under each device’s approval
          settings.
        </Notice>
      ) : null}
      <SettingsGroup disabled={disabled}>
        <SettingsRow
          label={<HostLabel name={cloudName} hostId={MANAGED_HOST_ID} />}
          description={<span id={managedNoteId}>Managed cloud host</span>}
          testId={`${idPrefix}-hosts-managed-row`}
          control={
            <ToggleSwitch
              id={managedSwitchId}
              label={cloudName}
              checked={draft.hosts.managed}
              disabled={disabled}
              describedBy={managedNoteId}
              dataTestId={managedSwitchId}
              onChange={onManagedChange}
            />
          }
        />
      </SettingsGroup>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="text-s font-medium fg-primary">Devices</div>
        {devicesAvailable ? (
          <DeviceAccessChoices
            idPrefix={idPrefix}
            choice={draft.hosts.devices}
            remoteIds={draft.hosts.remoteIds}
            desktops={desktops}
            disabled={disabled}
            onChoiceChange={onDeviceChoiceChange}
            onDeviceChange={onDeviceChange}
            onRetry={onRetryDevices}
          />
        ) : (
          <SettingsGroup disabled>
            <div
              data-testid={`${idPrefix}-devices-unavailable`}
              className="text-xs text-pretty fg-secondary"
            >
              Devices aren’t available yet.
            </div>
          </SettingsGroup>
        )}
      </div>
      {missing ? (
        <FieldError
          id={`${idPrefix}-hosts-required`}
          announce
          data-testid={`${idPrefix}-hosts-required`}
        >
          {HOSTS_REQUIRED_MESSAGE}
        </FieldError>
      ) : null}
    </div>
  );
}

/** The text compatibility switch, shared by consent and an agent's page. */
export function TextContentCompatibilityChoice({
  idPrefix,
  checked,
  disabled = false,
  onChange,
}: {
  /** Prefixes the control id and test ids, e.g. `consent` or `external-agent`. */
  readonly idPrefix: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange: (checked: boolean) => void;
}): JSX.Element {
  const switchId = `${idPrefix}-text-content-compatibility`;
  const noteId = `${switchId}-note`;
  return (
    <SettingsGroup disabled={disabled}>
      <SettingsRow
        label={TEXT_CONTENT_COMPATIBILITY_COPY.label}
        description={
          <span id={noteId}>{TEXT_CONTENT_COMPATIBILITY_COPY.description}</span>
        }
        testId={`${switchId}-row`}
        control={
          <ToggleSwitch
            id={switchId}
            label={TEXT_CONTENT_COMPATIBILITY_COPY.label}
            checked={checked}
            disabled={disabled}
            describedBy={noteId}
            dataTestId={switchId}
            onChange={onChange}
          />
        }
      />
    </SettingsGroup>
  );
}

export function AccessEditorSections({
  source,
  draft,
  organizations,
  initialOrganizationIds,
  remoteControlEnabled,
  cloudName,
  disabled,
  setOrganizationMode,
  setOrganizationEnabled,
  desktops,
  setManagedHost,
  setDeviceChoice,
  setDeviceSelected,
  onRetryDesktops,
  renderEditor,
}: {
  readonly source: AccessModelSource;
  readonly draft: AccessFormState;
  readonly organizations: readonly ExternalAgentOrganization[];
  readonly initialOrganizationIds: readonly string[];
  readonly remoteControlEnabled: boolean;
  /** The brand's cloud product name, which labels the Cloud agents switch. */
  readonly cloudName: string;
  readonly disabled: boolean;
  readonly setOrganizationMode: (mode: 'all' | 'selected') => void;
  readonly setOrganizationEnabled: (id: string, enabled: boolean) => void;
  /** The person's paired devices for the device selector. */
  readonly desktops: DesktopListState;
  readonly setManagedHost: (managed: boolean) => void;
  readonly setDeviceChoice: (choice: AccessDeviceChoice) => void;
  readonly setDeviceSelected: (remoteId: string, selected: boolean) => void;
  readonly onRetryDesktops?: () => void;
  readonly renderEditor: () => ReactNode;
}): JSX.Element {
  return (
    <>
      <SettingsSection
        title="Access"
        description="Write includes read. Changes apply the next time the agent does something."
        testId="external-agent-access"
      >
        {renderEditor()}
      </SettingsSection>
      {showsAccessOrganizations(source, draft) ? (
        <SettingsSection
          title="Organizations"
          description="The agent can reach organization data only in the ones you choose."
          testId="external-agent-organizations"
        >
          <SettingsGroup disabled={disabled}>
            <ChoiceRow
              id="external-agent-organizations-all"
              label="All my organizations"
              description="Includes organizations you join later."
              checked={draft.organizations.mode === 'all'}
              onChange={(): void => setOrganizationMode('all')}
              kind="radio"
              name="external-agent-organization-scope"
              disabled={disabled}
            />
            <ChoiceRow
              id="external-agent-organizations-selected"
              label="Choose organizations"
              description="Choose which organizations this agent can reach."
              checked={draft.organizations.mode === 'selected'}
              onChange={(): void => setOrganizationMode('selected')}
              kind="radio"
              name="external-agent-organization-scope"
              disabled={disabled}
            />
            {draft.organizations.mode === 'selected'
              ? organizations.map((organization) => {
                  const selected = draft.organizations.organizationIds.includes(
                    organization.id,
                  );
                  const unavailable = organizationChoiceUnavailable(
                    organization,
                    {
                      selected,
                      initiallySelected: initialOrganizationIds.includes(
                        organization.id,
                      ),
                    },
                  );

                  return (
                    <ChoiceRow
                      key={organization.id}
                      id={`external-agent-organization-${organization.id}`}
                      label={organization.name}
                      description={
                        organization.unavailableReason ?? organization.roleLine
                      }
                      checked={selected}
                      onChange={(): void =>
                        setOrganizationEnabled(organization.id, !selected)
                      }
                      kind="checkbox"
                      disabled={disabled || unavailable}
                    />
                  );
                })
              : null}
          </SettingsGroup>
        </SettingsSection>
      ) : null}
      {showsAccessHosts(source, draft, { keepUnusedScope: true }) ? (
        <SettingsSection
          title="Hosts"
          description="The agent can reach only the hosts you choose."
          testId="external-agent-hosts"
        >
          <HostAccessChoices
            idPrefix="external-agent"
            source={source}
            draft={draft}
            remoteControlEnabled={remoteControlEnabled}
            cloudName={cloudName}
            desktops={desktops}
            disabled={disabled}
            keepUnusedScope
            onManagedChange={setManagedHost}
            onDeviceChoiceChange={setDeviceChoice}
            onDeviceChange={setDeviceSelected}
            onRetryDevices={onRetryDesktops}
          />
        </SettingsSection>
      ) : null}
    </>
  );
}

/** Shown where the host does not offer the External agents pages. */
export function ExternalAgentsUnavailable(): JSX.Element {
  return (
    <div data-testid="external-agents-unavailable" className="w-full pt-4">
      <Notice intent="neutral" shape="settings">
        External agents aren’t available here.
      </Notice>
    </div>
  );
}
