import { stripCliAccountCredentials } from './cli-account';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import type { CliOpenCodeAccount } from './cli-account';
import { expandCliOpenCodeCollections } from './cli-collections';
import { CliOpenCodeAccountMcp } from './cli-account-mcp';
import { openCodeCapabilityDigest } from './capability-snapshot';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { McpServer } from '@agentclientprotocol/sdk';
import {
  getBundledBinaryMember,
  resolveBundledBinary,
} from '@canopy/execution-engine/pipelines/config-paths';
import { parseFrontmatterAndBody } from '@canopy/plugin-interop';
import type { PluginManifest } from '@canopy/execution-engine/types/plugins';
import type { OpenCodePromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import type {
  CodexRuntimeService,
  CodexHttpMcpProxyService,
} from '@canopy/execution-engine/node/codex-runtime';
import { resolvePlugins } from '@canopy/execution-engine/node/plugins/plugin-resolver';
import {
  discoverPluginSkills,
  discoverPluginCommandSources,
} from '@canopy/execution-engine/node/plugins/plugin-members';
import {
  assignCursorInvocationIds,
  cursorInvocationKey,
  expandLeadingCursorCommand,
  renderCursorCommandMarkdown,
  type CursorCapabilityProjection,
  type CursorInvocationSource,
} from '../../lib/cursor-capabilities';
import { materializeSelectedCapabilityRoot } from '../cursor/capability-root';
import type { OpenCodePipelineCapabilities } from '../pipelines/opencode-prompt-runner';
import {
  buildOpenCodeMcpServers,
  getOpenCodeMcpBaseEnv,
  openCodeMcpServersForAcp,
} from './mcp-servers';
import {
  readOpenCodeMcpSnapshot,
  openCodeMcpCallMatchesSnapshot,
} from './mcp-snapshot';
import { resolveOpenCodeMcpSnapshotTool } from './mcp-tool-identity';
import { prepareOpenCodeCommandHooks } from './command-hooks';
import { createCliOpenCodeSchemaValidator } from './cli-schema-validation';
import { assertCliInstalledItemsEnabled } from './cli-installed-policy';
import type { OpenCodeApprovalPort } from './tool-approval';
import type { OpenCodeCapabilitySnapshot } from './capability-snapshot';

export interface CliOpenCodeCapabilityServices {
  account?: CliOpenCodeAccount;
  owner?: WorkOwner;
  assertCurrent?(): Promise<void>;
  setCapabilityValidator?(validate: () => Promise<void>): void;
  getMcpBroker(): CodexRuntimeService;
  getHttpProxy(): CodexHttpMcpProxyService;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function memberManifest(root: string): Promise<PluginManifest | null> {
  for (const directory of ['.claude-plugin', '.codex-plugin']) {
    const raw = await readFile(
      join(root, directory, 'plugin.json'),
      'utf8',
    ).catch(() => undefined);
    if (raw === undefined) continue;
    const value: unknown = JSON.parse(raw);
    if (!record(value)) throw new Error('Invalid selected plugin manifest.');
    const manifest: PluginManifest = {};
    for (const key of ['skills', 'commands'] as const) {
      const field = value[key];
      if (
        typeof field === 'string' ||
        (Array.isArray(field) &&
          field.every(
            (entry: unknown): entry is string => typeof entry === 'string',
          ))
      )
        manifest[key] = field;
      else if (field !== undefined)
        throw new Error(`Invalid plugin ${key} paths.`);
    }
    return manifest;
  }
  return null;
}

/** Where a profile's selected skills and commands are staged for the model. */
export function selectedCapabilityRoot(profile: string): string {
  return join(profile, 'selected-capabilities');
}

/** Portable selections and brokered tools for a desktop-closed workflow. */
export async function prepareCliOpenCodeCapabilities(
  request: OpenCodePromptRunnerRequest,
  profile: string,
  signal: AbortSignal,
  approval: OpenCodeApprovalPort,
  services?: CliOpenCodeCapabilityServices,
): Promise<OpenCodePipelineCapabilities> {
  signal.throwIfAborted();
  const originalSelections = request.pluginSelections ?? {
    collectionIds: [],
    skillRefs: [],
    pluginRefs: [],
  };
  if (originalSelections.unresolvedCapabilities?.length)
    throw new Error(
      'Install the selected capabilities before running this workflow.',
    );
  await services?.assertCurrent?.();
  const owner = services?.owner ?? { kind: 'personal' };
  const selections = await expandCliOpenCodeCollections(
    originalSelections,
    owner,
    services?.account,
    signal,
  );
  const selectedRequest = { ...request, pluginSelections: selections };
  await assertCliInstalledItemsEnabled(selectedRequest);
  const selectedFingerprint = openCodeCapabilityDigest(selections);
  const validateSelections = async (): Promise<void> => {
    await assertCliInstalledItemsEnabled(selectedRequest);
    const current = await expandCliOpenCodeCollections(
      originalSelections,
      owner,
      services?.account,
      signal,
    );
    if (openCodeCapabilityDigest(current) !== selectedFingerprint)
      throw new Error('Selected capabilities changed during this workflow.');
  };
  services?.setCapabilityValidator?.(validateSelections);
  const accountMcp = new CliOpenCodeAccountMcp(services?.account, signal);
  const localSelections = await accountMcp.select(selections);
  signal.throwIfAborted();
  const resolved = resolvePlugins(
    localSelections,
    request.projectId ?? 'pipeline',
    request.executionId,
    request.stepId,
    {
      purpose: 'opencode-session',
      runtimeDirs: {
        rootDir: profile,
        claudePluginDir: join(profile, 'plugin-runtime'),
      },
      packageOverlay: request.packageOverlay,
    },
  );
  // A partial selection can silently omit a policy hook. Do not start that turn.
  if (resolved.warnings.length) throw new Error(resolved.warnings.join('\n'));
  await accountMcp.plugins(selections, resolved);
  for (const [name, definition] of Object.entries(accountMcp.definitions())) {
    if (Object.prototype.hasOwnProperty.call(resolved.mcpServers, name))
      throw new Error('Selected MCP server identities collide.');
    resolved.mcpServers[name] = definition;
  }
  const projection: CursorCapabilityProjection = { skills: [], commands: [] };
  const skillInputs: {
    source: CursorInvocationSource;
    sourceDir: string;
    description: string;
    label: string;
    userInvocable?: boolean;
  }[] = [];
  const commandInputs: {
    source: CursorInvocationSource;
    description: string;
    body: string;
    label: string;
  }[] = [];
  for (const skill of resolved.opencodeSkills ?? []) {
    skillInputs.push({
      source: { kind: 'skill', sourceId: 'selected', skillName: skill.name },
      sourceDir: await realpath(skill.sourceDir),
      description: '',
      label: skill.name,
    });
  }
  const warnings: string[] = [];
  for (const plugin of resolved.opencodePlugins ?? []) {
    const manifest = await memberManifest(plugin.pluginPath);
    for (const skill of discoverPluginSkills(
      plugin.pluginPath,
      manifest,
      warnings,
    )) {
      if (skill.metadata['disable-model-invocation']) continue;
      skillInputs.push({
        source: {
          kind: 'plugin_skill',
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          memberName: skill.name,
        },
        sourceDir: await realpath(skill.sourceDir),
        description: skill.description,
        label: `${plugin.pluginName}/${skill.name}`,
        userInvocable: skill.metadata['user-invocable'],
      });
    }
    for (const command of discoverPluginCommandSources(
      plugin.pluginPath,
      manifest,
      warnings,
    )) {
      commandInputs.push({
        source: {
          kind: 'plugin_command',
          marketplaceId: plugin.marketplaceId,
          pluginName: plugin.pluginName,
          memberName: command.name,
        },
        description: command.description,
        body: parseFrontmatterAndBody(command.content).body,
        label: `${plugin.pluginName}/${command.name}`,
      });
    }
  }
  const ids = assignCursorInvocationIds(
    [...skillInputs, ...commandInputs].map(({ source }) => source),
  );
  for (const skill of skillInputs) {
    const id = ids.get(cursorInvocationKey(skill.source));
    if (id) projection.skills.push({ ...skill, id });
  }
  for (const command of commandInputs) {
    const id = ids.get(cursorInvocationKey(command.source));
    if (id)
      projection.commands.push({
        ...command,
        id,
        markdown: renderCursorCommandMarkdown({ ...command, id }),
      });
  }
  const capabilityRoot = selectedCapabilityRoot(profile);
  const prepared = await materializeSelectedCapabilityRoot(
    capabilityRoot,
    projection,
    { verifyContent: true, signal },
  );
  if (
    warnings.length ||
    prepared.warnings.length ||
    prepared.skillIds.length !== projection.skills.length ||
    prepared.commandIds.length !== projection.commands.length
  )
    throw new Error(
      [
        'Selected capabilities could not be loaded completely.',
        ...warnings,
        ...prepared.warnings,
      ].join('\n'),
    );
  const hooks = await prepareOpenCodeCommandHooks(
    (resolved.opencodePlugins ?? [])
      .filter((plugin) => plugin.provider === 'claude')
      .map((plugin) => plugin.pluginPath),
    join(profile, 'selected-hook-plugins'),
    signal,
  );
  const ownerId = `opencode-cli:${randomUUID()}`;
  let disposed = false;
  let broker: CodexRuntimeService | undefined;
  let proxy: CodexHttpMcpProxyService | undefined;
  let snapshot: OpenCodeCapabilitySnapshot['mcp'] = [];
  const validate = createCliOpenCodeSchemaValidator();
  const check = async (
    server: string,
    tool: string,
    args: unknown,
    callSignal: AbortSignal,
  ): Promise<boolean> => {
    const combined = AbortSignal.any([signal, callSignal]);
    if (
      disposed ||
      combined.aborted ||
      request.permissionPreset !== 'dangerous_all'
    )
      return false;
    try {
      await services?.assertCurrent?.();
      if (!services?.assertCurrent) await validateSelections();
      await accountMcp.assertCurrent(server);
    } catch {
      return false;
    }
    if (
      !(await openCodeMcpCallMatchesSnapshot(snapshot, server, tool, args, {
        validate,
        signal: combined,
      }))
    )
      return false;
    const target = { kind: 'mcp', server, tool } as const;
    const outcome = await approval.check(target, {
      title: `OpenCode wants to use ${tool}`,
      details: target,
      suggestedTarget: target,
      toolUseId: randomUUID(),
    });
    return (
      !disposed &&
      !combined.aborted &&
      !outcome.stopTurn &&
      outcome.decision === 'allow'
    );
  };
  const dispose = async (): Promise<void> => {
    disposed = true;
    signal.removeEventListener('abort', onAbort);
    proxy?.revokeOwner(ownerId);
    await broker?.revokeStdioMcpRoutes(ownerId);
  };
  const onAbort = (): void => {
    void dispose().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const definitions: Record<string, unknown> = {};
    const identities: Record<string, unknown> = {};
    // Validate the original definitions before hiding credentials behind routes.
    const servers = buildOpenCodeMcpServers({
      definitions: resolved.mcpServers,
      cwd: request.cwd,
    });
    for (const server of servers) {
      signal.throwIfAborted();
      if (!services)
        throw new Error('The standalone MCP broker is unavailable.');
      const gate = (call: {
        toolName: string;
        arguments: unknown;
        signal: AbortSignal;
      }): Promise<boolean> =>
        check(server.name, call.toolName, call.arguments, call.signal);
      // Snapshots are persisted. Retain identity changes without writing
      // cloud keys, static headers or local MCP environment credentials.
      identities[server.name] = {
        definitionDigest: openCodeCapabilityDigest(
          resolved.mcpServers[server.name],
        ),
      };
      if ('url' in server) {
        if (server.type !== 'http')
          throw new Error(
            'Standalone OpenCode requires HTTP streaming for remote MCP servers.',
          );
        proxy ??= services.getHttpProxy();
        const lease = await proxy.registerRoute({
          ownerId,
          upstreamUrl: server.url,
          headers: Object.fromEntries(
            server.headers.map((entry) => [entry.name, entry.value]),
          ),
          toolCallGate: gate,
        });
        definitions[server.name] = { type: 'http', url: lease.url };
      } else {
        broker ??= services.getMcpBroker();
        const raw = resolved.mcpServers[server.name];
        if (!record(raw) || typeof raw.command !== 'string')
          throw new Error('Invalid selected MCP launch.');
        const bundled = getBundledBinaryMember(raw.command);
        const route = await broker.registerStdioMcpRoute(
          {
            ownerId,
            routeKey: server.name,
            command: bundled ? resolveBundledBinary(bundled).path : raw.command,
            args: Array.isArray(raw.args)
              ? raw.args.filter(
                  (arg: unknown): arg is string => typeof arg === 'string',
                )
              : [],
            cwd: typeof raw.cwd === 'string' ? raw.cwd : request.cwd,
            baseEnv: stripCliAccountCredentials(getOpenCodeMcpBaseEnv()),
            env: stripCliAccountCredentials(
              record(raw.env)
                ? Object.fromEntries(
                    Object.entries(raw.env).filter(
                      (entry): entry is [string, string] =>
                        typeof entry[1] === 'string',
                    ),
                  )
                : {},
            ),
          },
          { signal, toolCallGate: gate },
        );
        definitions[server.name] = {
          type: 'stdio',
          command: route.command,
          args: route.args,
          env: { TMPDIR: tmpdir(), TMP: tmpdir(), TEMP: tmpdir() },
        };
      }
      if (disposed || signal.aborted)
        throw new Error('OpenCode capability setup stopped.');
    }
    const mcpServers: McpServer[] = openCodeMcpServersForAcp(
      buildOpenCodeMcpServers({
        definitions,
        cwd: request.cwd,
      }),
    );
    snapshot = await readOpenCodeMcpSnapshot(
      mcpServers,
      identities,
      signal,
      (server) => Promise.resolve(server),
    );
    signal.throwIfAborted();
    return {
      capabilityRoots: [capabilityRoot, ...hooks.capabilityRoots],
      capabilityContext: { selections, commandHooks: hooks.hooks },
      commandHooks: hooks.hooks,
      hookApproval: {
        check: (target, display) =>
          !disposed &&
          !signal.aborted &&
          request.permissionPreset === 'dangerous_all'
            ? approval.check(target, display)
            : Promise.resolve({ decision: 'deny' }),
      },
      mcpServers,
      mcpSnapshot: snapshot,
      instructions: projection.skills
        .map(
          (skill) =>
            `Selected skill ${skill.label}: ${skill.description}\nRead ${JSON.stringify(join(capabilityRoot, 'skills', skill.id, 'SKILL.md'))} for its instructions.`,
        )
        .join('\n'),
      expandPrompt: (prompt) =>
        expandLeadingCursorCommand(prompt, projection.commands),
      warnings: [
        ...hooks.warnings,
        ...(request.ledgerAttemptKey
          ? ['Feed tools are unavailable in standalone OpenCode workflows.']
          : []),
      ],
      authorizeMcpTool: async (input) => {
        const tool = resolveOpenCodeMcpSnapshotTool(snapshot, input.toolName);
        return {
          decision:
            tool &&
            (await check(tool.server, tool.tool.name, input.toolArgs, signal))
              ? 'allow'
              : 'deny',
        };
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
