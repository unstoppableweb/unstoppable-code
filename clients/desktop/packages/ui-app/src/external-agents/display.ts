import { ORCHESTRATOR_LABEL } from '@canopy/protocol';
import {
  EXTERNAL_AGENT_TOOL_GROUPS,
  type ExternalAgentAccessSummary,
  type ExternalAgentActivityTarget,
  type ExternalAgentConfirmationClass,
  type ExternalAgentConnectionStatus,
  type ExternalAgentConnectionSummary,
  type ExternalAgentServer,
  type ExternalAgentServerAddress,
  type ExternalAgentToolGroup,
} from '@canopy/protocol/external-agents';
import { MANAGED_HOST_ID } from './access-model';

export const EXTERNAL_AGENT_SERVER_COPY: Record<
  ExternalAgentServer,
  { title: string; line: string }
> = {
  account: {
    title: 'Account and organizations',
    line: 'Your profile, digests, usage, organizations, library, work records and memory.',
  },
  tasks: {
    title: 'Tasks',
    line: 'Projects and tasks in the cloud and on your devices.',
  },
};

/**
 * The brand's cloud product name, which labels the Cloud agents switch.
 * `brandDisplayName` comes from the host's brand helpers, never a literal.
 */
export function cloudProductName(brandDisplayName: string): string {
  return `${brandDisplayName} Cloud`;
}

/** Labels the Cloud agents switch outside a branded host. */
export const CLOUD_AGENTS_FALLBACK_LABEL = 'Cloud agents';

/** The text compatibility switch, on consent and on an agent's page. */
export const TEXT_CONTENT_COMPATIBILITY_COPY = {
  title: 'Compatibility',
  label: 'Text content compatibility',
  description:
    'Turn this on only if the agent sees a brief text summary instead of the full tool result. It repeats each result’s data in its text, which can increase the token cost of every tool result. Use it only for agents that need it.',
} as const;

const GROUP_NOUNS: Record<ExternalAgentToolGroup, string> = {
  account: 'account',
  digests: 'digests',
  usage: 'usage',
  billing: 'billing',
  org: 'organizations',
  library: 'the library',
  work: 'work records',
  memory: 'memory',
  tasks: 'tasks',
};

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function deviceCount(desktops: ExternalAgentAccessSummary['desktops']): string {
  if (desktops === null || desktops === 0) return '';
  if (desktops === 'all') return 'all devices';
  return desktops === 1 ? '1 device' : `${desktops} devices`;
}

/** "linux-managed and 2 devices": the hosts a Tasks connection reaches, without host codes. */
function hostsPhrase(summary: ExternalAgentAccessSummary): string {
  const hosts: string[] = [];
  if (summary.managed === true) hosts.push(MANAGED_HOST_ID);
  const devices = deviceCount(summary.desktops);
  if (devices !== '') hosts.push(devices);
  return list(hosts);
}

function groupNouns(
  groups: readonly ExternalAgentToolGroup[],
  hosts: string,
): string[] {
  const selected = new Set(groups);
  return EXTERNAL_AGENT_TOOL_GROUPS.flatMap((group) => {
    if (!selected.has(group)) return [];
    if (group === 'tasks' && hosts !== '') return [`tasks on ${hosts}`];
    return [GROUP_NOUNS[group]];
  });
}

function organizationLine(
  organizations: ExternalAgentAccessSummary['organizations'],
): string | null {
  if (organizations === null) return null;
  if (organizations === 'all') return 'All organizations.';
  if (organizations === 0) return 'No organizations.';
  if (organizations === 1) return '1 organization.';
  return `${organizations} organizations.`;
}

/**
 * One list row's access, e.g. "Reads account. Writes tasks on linux-managed
 * and 2 devices." A Tasks row names the managed host and counts devices; it
 * never lists host codes.
 */
function accessSummaryLine(summary: ExternalAgentAccessSummary): string {
  const lines: string[] = [];
  const hosts = hostsPhrase(summary);
  const reads = list(groupNouns(summary.read, hosts));
  const writes = list(groupNouns(summary.write, hosts));
  const destructive = new Set(summary.destructive);

  if (reads !== '') lines.push(`Reads ${reads}.`);
  if (writes !== '') lines.push(`Writes ${writes}.`);
  const removesMembers = destructive.has('org');
  const deletesLibraryItems = destructive.has('library');
  if (removesMembers && deletesLibraryItems) {
    lines.push('Can remove members and teams, and delete library items.');
  } else if (removesMembers) {
    lines.push('Can remove members and teams.');
  } else if (deletesLibraryItems) {
    lines.push('Can delete library items.');
  }
  const organizations = organizationLine(summary.organizations);
  if (organizations !== null) lines.push(organizations);
  const tasksGranted =
    summary.read.includes('tasks') || summary.write.includes('tasks');
  if (tasksGranted && hosts === '') lines.push('No hosts.');

  return lines.length === 0 ? 'No access.' : lines.join(' ');
}

/**
 * A list row's access line. Slack's connection (CAN-7606) holds a placeholder
 * policy that grants nothing over MCP: its messages reach the Orchestrator on
 * the computer chosen in Connect Slack, so the row says that instead.
 */
export function connectionAccessLine(
  connection: Pick<
    ExternalAgentConnectionSummary,
    'access' | 'firstPartyClient'
  >,
): string {
  if (connection.firstPartyClient !== 'slack') {
    return accessSummaryLine(connection.access);
  }
  const devices = deviceCount(connection.access.desktops);
  // Connect Slack always stores exactly one computer; this is a fail-safe.
  if (devices === '') return `Chats with ${ORCHESTRATOR_LABEL}.`;
  return `Chats with ${ORCHESTRATOR_LABEL} on ${devices}.`;
}

export function connectionStatusLabel(
  status: ExternalAgentConnectionStatus,
): string | null {
  if (status === 'paused') return 'Paused';
  if (status === 'expired') return 'Expired';
  return null;
}

export function cursorMcpSnippet(
  servers: readonly ExternalAgentServerAddress[],
  cursorClientId: string,
): string {
  const mcpServers: Partial<
    Record<ExternalAgentServer, { url: string; auth: { CLIENT_ID: string } }>
  > = {};

  for (const server of servers) {
    mcpServers[server.server] = {
      url: server.url,
      auth: { CLIENT_ID: cursorClientId },
    };
  }

  return JSON.stringify({ mcpServers }, null, 2);
}

/*
 * Per-agent setup commands. Each names the server by its key, as the Cursor
 * snippet does. None pass a client ID: these agents sign in with their own
 * Client ID Metadata Document, which the authorization server accepts.
 */

export function claudeCodeAddCommand(
  server: ExternalAgentServerAddress,
): string {
  return `claude mcp add --transport http --scope user ${server.server} ${server.url}`;
}

export function codexAddCommand(server: ExternalAgentServerAddress): string {
  return `codex mcp add ${server.server} --url ${server.url}`;
}

export function openCodeConfigSnippet(
  servers: readonly ExternalAgentServerAddress[],
): string {
  const mcp: Partial<
    Record<ExternalAgentServer, { type: 'remote'; url: string; enabled: true }>
  > = {};
  for (const server of servers) {
    mcp[server.server] = { type: 'remote', url: server.url, enabled: true };
  }
  return JSON.stringify(
    { $schema: 'https://opencode.ai/config.json', mcp },
    null,
    2,
  );
}

export function openCodeAuthCommand(
  server: ExternalAgentServerAddress,
): string {
  return `opencode mcp auth ${server.server}`;
}

export function hermesAddCommand(server: ExternalAgentServerAddress): string {
  return `hermes mcp add ${server.server} --url ${server.url} --auth oauth\nhermes mcp login ${server.server}`;
}

export function openClawAddCommand(server: ExternalAgentServerAddress): string {
  return `openclaw mcp add ${server.server} --url ${server.url} --transport streamable-http --auth oauth\nopenclaw mcp login ${server.server}`;
}

function activityTargetFallback(
  kind: ExternalAgentActivityTarget['kind'],
): string {
  if (kind === 'organization') return 'an organization';
  if (kind === 'project') return 'a project';
  if (kind === 'remote') return 'a device';
  return 'a task';
}

export function activityTargetsLine(
  targets: readonly ExternalAgentActivityTarget[],
): string {
  return targets
    .map((target) => target.label ?? activityTargetFallback(target.kind))
    .join(', ');
}

/** The write classes a person can set to Act or Ask first on an agent's page. */
export const EXTERNAL_AGENT_CONFIRMATION_CLASS_LABELS: Record<
  ExternalAgentConfirmationClass,
  string
> = {
  profile: 'Profile changes',
  settings: 'Settings changes',
  membership: 'Membership changes',
  sharing: 'Sharing changes',
  content: 'Content changes',
  task: 'Tasks',
  pipeline: 'Pipelines',
};

const RELATIVE_UNITS: readonly {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly ms: number;
}[] = [
  { unit: 'day', ms: 86_400_000 },
  { unit: 'hour', ms: 3_600_000 },
  { unit: 'minute', ms: 60_000 },
];

/**
 * A time relative to `now`, past or future: "2 minutes ago", "in 8 minutes".
 * Under a minute reads "just now" in the past and "in under a minute" ahead.
 */
export function relativeTimeLabel(value: string, now: number): string {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return 'just now';
  const diff = then - now;
  const magnitude = Math.abs(diff);
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'always' });
  for (const { unit, ms } of RELATIVE_UNITS) {
    if (magnitude >= ms) {
      const amount = Math.floor(magnitude / ms);
      return format.format(diff < 0 ? -amount : amount, unit);
    }
  }
  return diff < 0 ? 'just now' : 'in under a minute';
}

/** "Asked 2 minutes ago. Expires in 8 minutes." for a waiting request. */
export function waitingTimingLine(
  requestedAt: string,
  decisionExpiresAt: string,
  now: number,
): string {
  const asked = `Asked ${relativeTimeLabel(requestedAt, now)}.`;
  const expiresAt = new Date(decisionExpiresAt).getTime();
  if (Number.isFinite(expiresAt) && expiresAt <= now) {
    return `${asked} Expired.`;
  }
  return `${asked} Expires ${relativeTimeLabel(decisionExpiresAt, now)}.`;
}
