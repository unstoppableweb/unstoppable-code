import type { OpenCodeCapabilitySnapshot } from '@canopy/desktop-shared/node/opencode/capability-snapshot';
import { resolveOpenCodeMcpSnapshotTool } from '@canopy/desktop-shared/node/opencode/mcp-tool-identity';
import {
  getBundledBinaryMember,
  getEnhancedEnv,
  resolveBundledBinary,
} from '@canopy/execution-engine/pipelines/config-paths';
import type { McpServer } from '@agentclientprotocol/sdk';
import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import { APP_ADVISOR_TOOL_REGISTRY } from '@canopy/desktop-shared/lib/app-advisor-tools';
import { cursorCanopyMcpServerNames } from '@canopy/desktop-shared/lib/cursor-mcp-tool-call';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function strings(value: unknown): { name: string; value: string }[] {
  if (value === undefined) return [];
  if (
    !record(value) ||
    Object.values(value).some((entry) => typeof entry !== 'string')
  )
    throw new Error('Invalid OpenCode MCP environment or headers.');
  return Object.entries(value).flatMap(([name, value]) =>
    typeof value === 'string' ? [{ name, value }] : [],
  );
}

/** Host launch descriptions retain CWD until the broker replaces stdio entries. */
export type OpenCodeMcpLaunch = McpServer & { cwd?: string };

/** Host-only base for OpenCode-owned MCP children; selected overrides stay with the broker. */
export function getOpenCodeMcpBaseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(
      getEnhancedEnv({ includeCanopySecrets: false, environment: false }),
    ).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

export function buildOpenCodeMcpServers(input: {
  mode?: 'default' | 'app-advisor';
  mainUrl?: string;
  uiUrl?: string;
  authToken?: string;
  definitions: Record<string, unknown>;
  cwd: string;
}): OpenCodeMcpLaunch[] {
  const names = cursorCanopyMcpServerNames(input.mode ?? 'default');
  const reserved = new Set([
    names.main,
    names.ui,
    cursorCanopyMcpServerNames('app-advisor').main,
  ]);
  const servers: OpenCodeMcpLaunch[] = [];
  for (const [name, raw] of Object.entries(input.definitions)) {
    if (reserved.has(name) || !/^[a-zA-Z0-9_-]+$/.test(name))
      throw new Error(`OpenCode cannot use MCP server name ${name}.`);
    if (!record(raw)) throw new Error(`Invalid MCP server ${name}.`);
    if (raw.enabled === false) continue;
    if (
      [
        'allowedTools',
        'disabledTools',
        'enabled_tools',
        'disabled_tools',
        'default_tools_approval_mode',
        'tools',
      ].some((key) => raw[key] !== undefined)
    )
      throw new Error(
        `OpenCode cannot apply the selected tool filters for ${name}.`,
      );
    if (
      (raw.type === 'http' || raw.type === 'sse') &&
      typeof raw.url === 'string'
    ) {
      const url = new URL(raw.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error(`Invalid MCP URL for ${name}.`);
      servers.push({
        type: raw.type,
        name,
        url: raw.url,
        headers: strings(raw.headers),
      });
    } else if (
      (raw.type === undefined || raw.type === 'stdio') &&
      typeof raw.command === 'string' &&
      raw.command &&
      !raw.command.includes('\0')
    ) {
      const args = raw.args ?? [];
      if (
        !Array.isArray(args) ||
        !args.every(
          (arg: unknown): arg is string =>
            typeof arg === 'string' && !arg.includes('\0'),
        )
      )
        throw new Error(`Invalid MCP arguments for ${name}.`);
      const configuredEnv = strings(raw.env);
      // Resolve launches in the host before handing configuration to ACP. The
      // provider may have a deliberately restricted environment of its own.
      const enhanced = getOpenCodeMcpBaseEnv();
      // ACP receives this configuration inside the provider. Forward only the
      // executable search path and the selected server's explicit credentials.
      const launchEnv: Record<string, string | undefined> = {
        PATH: enhanced.PATH,
      };
      for (const entry of configuredEnv) launchEnv[entry.name] = entry.value;
      const env = Object.entries(launchEnv).flatMap(([name, value]) =>
        typeof value === 'string' ? [{ name, value }] : [],
      );
      const bundled = getBundledBinaryMember(raw.command);
      const command = bundled
        ? resolveBundledBinary(bundled).path
        : raw.command;
      if (
        raw.cwd !== undefined &&
        (typeof raw.cwd !== 'string' || !raw.cwd || raw.cwd.includes('\0'))
      )
        throw new Error(`Invalid MCP directory for ${name}.`);
      servers.push({
        name,
        command,
        args,
        env,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : input.cwd,
      });
    } else throw new Error(`OpenCode cannot load MCP server ${name}.`);
  }
  if (input.mainUrl && input.uiUrl && input.authToken) {
    const headers = (): { name: string; value: string }[] => [
      { name: 'Authorization', value: `Bearer ${input.authToken}` },
    ];
    servers.push(
      {
        type: 'http',
        name: names.main,
        url: input.mainUrl,
        headers: headers(),
      },
      { type: 'http', name: names.ui, url: input.uiUrl, headers: headers() },
    );
  }
  return servers;
}

/** Remove host-only launch metadata before serializing an ACP session. */
export function openCodeMcpServersForAcp(
  servers: readonly OpenCodeMcpLaunch[],
): McpServer[] {
  return servers.map((launch) => {
    const server = { ...launch };
    delete server.cwd;
    return server;
  });
}

/** The pinned runtime keeps letters, digits, underscores and hyphens in MCP names. */
export function resolveOpenCodeMcpCall(
  name: string,
  servers: readonly McpServer[],
  mode: 'default' | 'app-advisor',
  managedTools: readonly string[] = [],
  snapshot?: OpenCodeCapabilitySnapshot['mcp'],
): { server: string; tool: string; http: boolean } | undefined {
  const catalog = snapshot
    ? resolveOpenCodeMcpSnapshotTool(snapshot, name)
    : undefined;
  if (snapshot && !catalog) return undefined;
  const names = cursorCanopyMcpServerNames(mode);
  for (const tool of managedTools) {
    const server = servers.find(
      (server) =>
        server.name === names.main && name === `${server.name}_${tool}`,
    );
    if (server) return { server: server.name, tool, http: 'url' in server };
  }
  const registry: Record<string, { displayName: string }> =
    mode === 'app-advisor'
      ? APP_ADVISOR_TOOL_REGISTRY
      : CANOPY_INJECTED_TOOL_REGISTRY;
  for (const exposure of Object.values(registry)) {
    const tool = exposure.displayName;
    for (const server of servers) {
      if (
        (server.name === names.main || server.name === names.ui) &&
        name === `${server.name}_${tool}`
      )
        return { server: server.name, tool, http: 'url' in server };
    }
  }
  const matches = servers.filter(
    (server) =>
      server.name !== names.main &&
      server.name !== names.ui &&
      name.startsWith(`${server.name}_`),
  );
  if (matches.length !== 1) return undefined;
  const [server] = matches;
  const nativeTool = name.slice(server.name.length + 1);
  if (
    !/^[a-zA-Z0-9_-]+$/.test(nativeTool) ||
    (catalog && catalog.server !== server.name)
  )
    return undefined;
  return {
    server: server.name,
    tool: catalog?.tool.name ?? nativeTool,
    http: 'url' in server,
  };
}
