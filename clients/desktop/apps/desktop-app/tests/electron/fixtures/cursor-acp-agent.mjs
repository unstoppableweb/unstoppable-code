#!/usr/bin/env node
// Deterministic ACP peer. Intentionally permits a late hook allow after cancel,
// matching the observed Cursor race, so the host must revoke its own decisions.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

// The fixture keeps its sign-in markers where the pinned CLI keeps its
// credential file: `%APPDATA%\Cursor` when APPDATA is set (the Windows shape)
// and `$XDG_CONFIG_HOME/cursor` otherwise (the Linux shape; the real macOS CLI
// uses the Keychain, which every managed launch reaches the same way). Both
// live at the shared managed profile, so Connect, account reads, chats, and
// model discovery all see one sign-in, while the managed config directory
// (`CURSOR_CONFIG_DIR`) carries no credentials, exactly like the real CLI.
// CANOPY_E2E_CURSOR_ACCOUNT_DIR overrides the location for tests that keep
// account markers somewhere of their own; the config directory is the last
// resort for spawns that set none of these.
const accountDir =
  process.env.CANOPY_E2E_CURSOR_ACCOUNT_DIR ??
  (process.env.APPDATA
    ? path.join(process.env.APPDATA, 'Cursor')
    : process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, 'cursor')
      : process.env.CURSOR_CONFIG_DIR);
if (accountDir) await mkdir(accountDir, { recursive: true });
const accountFile = (name) =>
  accountDir ? path.join(accountDir, name) : undefined;
const readAccountFile = async (name) => {
  const file = accountFile(name);
  return file
    ? await readFile(file, 'utf8').then(
        (content) => content,
        () => null,
      )
    : null;
};

if (process.argv.includes('--version')) {
  const probeFile = process.env.CANOPY_E2E_CURSOR_VERSION_PROBE_FILE;
  const probe = probeFile
    ? await readFile(probeFile, 'utf8').then(JSON.parse, () => null)
    : null;
  if (probe) {
    const attempt = (probe.attempts ?? 0) + 1;
    await writeFile(probeFile, JSON.stringify({ ...probe, attempts: attempt }));
    if (probe.mode === 'exit') process.exit(7);
    if (
      probe.mode === 'timeout' ||
      (probe.mode === 'timeout-once' && attempt === 1)
    ) {
      await new Promise(() => setInterval(() => {}, 1000));
    }
  }
  process.stdout.write('2026.09.08-6caf4ff\n');
  process.exit(0);
}
if (process.argv.includes('status')) {
  const barrier = process.env.CANOPY_E2E_CURSOR_DISCOVERY_BARRIER;
  if (barrier) {
    await writeFile(`${barrier}.started`, 'started');
    while (
      !(await readFile(barrier).then(
        () => true,
        () => false,
      ))
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  await writeFile(
    path.join(process.env.CURSOR_CONFIG_DIR, 'fixture-git-environment.json'),
    JSON.stringify(
      Object.fromEntries(
        Object.entries(process.env).filter(([key]) =>
          key.startsWith('GIT_CONFIG_'),
        ),
      ),
    ),
  );

  // A read can fail without the CLI rejecting: the real binary resolves with a
  // non-zero exit, which must not be reported as a sign-out.
  if ((await readAccountFile('fixture-status-fail')) !== null) {
    process.stderr.write('cursor-agent: could not reach the account service\n');
    process.exit(1);
  }

  // Like the real CLI, a session exists once sign-in has completed: the
  // simulated login writes fixture-login-complete when the browser returns.
  // Its content names the signed-in account ("yes" keeps the default).
  const loginMarker = await readAccountFile('fixture-login-complete').then(
    (content) => (content === null ? null : content.trim()),
  );
  const isAuthenticated =
    process.env.CANOPY_E2E_CURSOR_LOGIN !== '1' || loginMarker !== null;
  const email =
    loginMarker && loginMarker !== 'yes' ? loginMarker : 'fixture@example.test';
  process.stdout.write(
    JSON.stringify({
      isAuthenticated,
      ...(isAuthenticated ? { userInfo: { email } } : {}),
    }) + '\n',
  );
  process.exit(0);
}
if (process.argv.includes('logout')) {
  // Held open on request so a test can observe the `signing-out` phase, which
  // is otherwise too brief to catch.
  while ((await readAccountFile('fixture-logout-hold')) !== null) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // The real CLI clears the shared credential store; the fixture forgets the
  // completed sign-in so a later status reports signed out until login.
  await rm(accountFile('fixture-login-complete'), {
    force: true,
  });
  await writeFile(accountFile('fixture-logout'), 'yes');
  process.stdout.write('Signed out\n');
  process.exit(0);
}
if (process.argv.includes('login')) {
  await writeFile(accountFile('fixture-login-pid'), String(process.pid));
  process.stdout.write(
    'https://cursor.com/canopy-login-fixture?state=complete\n',
  );
  setInterval(async () => {
    try {
      await readFile(accountFile('fixture-login-complete'));
      process.exit(0);
    } catch {
      /* Wait for the test browser callback. */
    }
  }, 50);
} else {
  let cwd;
  let promptId;
  let cancelled = false;
  let loaded = false;
  let mcpServers = [];
  // The effective variant string, like the real CLI's stored model id. In the
  // parameterized picker mode it is recomposed from the base id and the
  // parameter values the client set.
  let selectedModel = 'default[]';
  // Negotiated on `initialize`, fixed for the connection, like the real CLI.
  let parameterized = false;
  // The real CLI remembers a model's parameters between selections, so a
  // client that only selects the base id inherits whatever it set last.
  const rememberedParameters = new Map();
  const PARAMETER_DEFINITIONS = {
    reasoning: {
      category: 'thought_level',
      values: ['none', 'low', 'medium', 'high', 'xhigh'],
    },
    effort: {
      category: 'thought_level',
      values: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    thinking: { category: 'thought_level', values: ['false', 'true'] },
    fast: { category: 'model_config', values: ['false', 'true'] },
    // `context` is single-valued for every fixture model and, like the real
    // CLI, single-valued parameters are not advertised as options.
  };
  const parseVariant = (raw) => {
    const match = /^(.+)\[([^[\]]*)\]$/.exec(raw);
    if (!match) return { base: raw, parameters: [], bracketed: false };
    return {
      base: match[1],
      parameters: match[2]
        ? match[2].split(',').map((entry) => {
            const [id, value] = entry.split('=');
            return { id, value };
          })
        : [],
      bracketed: true,
    };
  };
  const composeVariant = ({ base, parameters, bracketed }) =>
    bracketed
      ? `${base}[${parameters.map((p) => `${p.id}=${p.value}`).join(',')}]`
      : base;
  const parameterOptions = (raw) =>
    parseVariant(raw).parameters.flatMap(({ id, value }) => {
      const definition = PARAMETER_DEFINITIONS[id];
      return definition
        ? [
            {
              id,
              name: id[0].toUpperCase() + id.slice(1),
              category: definition.category,
              type: 'select',
              currentValue: value,
              options: definition.values.map((entry) => ({
                value: entry,
                name: entry,
              })),
            },
          ]
        : [];
    });
  // A Cursor account decides which models it may use, so the fixture's catalog
  // follows whoever the sign-in marker names. Setup and an account change both
  // re-run discovery against a fresh process, so reading it once here is
  // enough.
  // The approval-check spawn deliberately passes a minimal allowlisted env with
  // neither directory set, which `readAccountFile` reports as absent rather
  // than throwing and killing the ACP handshake before it starts.
  const signedInAccount = (
    (await readAccountFile('fixture-login-complete')) ?? ''
  ).trim();
  const rawModelLabels = process.env.CANOPY_E2E_CURSOR_RAW_MODEL_LABELS === '1';
  const availableModels = [
    ...(signedInAccount.startsWith('second@')
      ? [{ modelId: 'second-only[]', name: 'Second Account Model' }]
      : []),
    ...(process.env.CANOPY_E2E_CURSOR_GATEWAY_MODEL === '1'
      ? [{ modelId: 'kimi-k3[]', name: 'kimi-k3' }]
      : []),
    ...(process.env.CANOPY_E2E_CURSOR_SHARED_MODEL === '1'
      ? [{ modelId: 'gpt-6-astra[reasoning=medium]', name: 'Cursor GPT Astra' }]
      : []),
    ...(process.env.CANOPY_E2E_CURSOR_SHARED_CLAUDE_MODEL === '1'
      ? [{ modelId: 'claude-sonnet-5-5[]', name: 'Sonnet 5.5' }]
      : []),
    ...(rawModelLabels
      ? [
          {
            modelId: 'claude-opus-4-5[thinking=true]',
            name: 'Claude Opus 4.5 Thinking',
            catalogName: 'Claude Opus 4.5',
          },
        ]
      : []),
    { modelId: 'default[]', name: 'Auto' },
    { modelId: 'gpt-5.6-luna[reasoning=medium]', name: 'GPT-5.6 Luna' },
    {
      modelId: 'claude-sonnet-4-5[thinking=true,context=200k]',
      name: 'Claude Sonnet 4.5 Thinking',
      catalogName: 'Claude Sonnet 4.5',
    },
    process.env.CANOPY_E2E_CURSOR_OPAQUE_MODEL === '1'
      ? { modelId: 'vendor:模型~variant', name: 'Opaque vendor model' }
      : { modelId: 'gemini-3.1-pro[]', name: 'Gemini 3.1 Pro' },
  ];
  const modelLabel = (model) =>
    rawModelLabels ? parseVariant(model.modelId).base : model.name;
  const modelState = () =>
    parameterized
      ? {
          currentModelId: parseVariant(selectedModel).base,
          availableModels: availableModels.map((model) => ({
            modelId: parseVariant(model.modelId).base,
            name: model.name,
          })),
        }
      : { currentModelId: selectedModel, availableModels };
  const configOptions = () =>
    parameterized
      ? [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: parseVariant(selectedModel).base,
            options: availableModels.map((model) => ({
              value: parseVariant(model.modelId).base,
              name: modelLabel(model),
            })),
          },
          ...parameterOptions(selectedModel),
        ]
      : [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: selectedModel,
            options: availableModels.map((model) => ({
              value: model.modelId,
              name: modelLabel(model),
            })),
          },
        ];
  // The vendor extension request that lists every model with its options.
  const listAvailableModels = () => ({
    models: availableModels.map((model) => ({
      value: parseVariant(model.modelId).base,
      name: model.catalogName ?? model.name,
      configOptions: parameterOptions(model.modelId),
    })),
  });

  const permissions = new Map();
  const recordMcpServers = async (servers) => {
    mcpServers = Array.isArray(servers) ? servers : [];
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-mcp-servers.json'),
      JSON.stringify(mcpServers),
    );
  };
  // Like the real CLI, skills and commands are discovered under the private
  // HOME the host hands this process, and invocable entries are advertised right
  // after the session is created — before the host has selected a model.
  const advertiseCapabilities = async () => {
    const home = process.env.HOME ?? '';
    const cursorDir = path.join(home, '.cursor');
    const skills = existsSync(path.join(cursorDir, 'skills'))
      ? (await readdir(path.join(cursorDir, 'skills'), { withFileTypes: true }))
          .filter(
            (entry) =>
              entry.isDirectory() &&
              existsSync(
                path.join(cursorDir, 'skills', entry.name, 'SKILL.md'),
              ),
          )
          .map((entry) => entry.name)
          .sort()
      : [];
    const invocableSkills = [];
    for (const name of skills) {
      const content = await readFile(
        path.join(cursorDir, 'skills', name, 'SKILL.md'),
        'utf8',
      );
      const frontmatter =
        content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1] ?? '';
      if (!/^user-invocable:\s*false\s*$/m.test(frontmatter))
        invocableSkills.push(name);
    }
    const commands = existsSync(path.join(cursorDir, 'commands'))
      ? (await readdir(path.join(cursorDir, 'commands')))
          .filter((name) => name.endsWith('.md'))
          .map((name) => name.slice(0, -3))
          .sort()
      : [];
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-capabilities.json'),
      JSON.stringify({ home, skills, commands, invocableSkills }),
    );
    update({
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'copy-request-id', description: 'Copy the last request ID' },
        ...commands.map((name) => ({ name, description: `${name} command` })),
        ...invocableSkills.map((name) => ({
          name,
          description: `${name} skill`,
        })),
      ],
    });
  };
  // Minimal Streamable HTTP MCP client, the same POST-only JSON-RPC the real
  // CLI used against the app's server in the live transport probe.
  let mcpSequence = 0;
  async function mcpRequest(server, method, params) {
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    for (const header of server.headers ?? [])
      headers[header.name] = header.value;
    const response = await fetch(server.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: `mcp-${++mcpSequence}`,
        method,
        params,
      }),
    });
    return response.json();
  }
  async function callMcpTool(server, toolName, args) {
    if (server.unsupplied) {
      // A server the runtime loaded on its own rather than one supplied over
      // ACP: its effect lands outside the worktree, where no checkout
      // integrity check can see it.
      await writeFile(
        path.join(
          process.env.CURSOR_DATA_DIR,
          'fixture-unsupplied-mcp-ran.json',
        ),
        JSON.stringify({ toolName, args }),
      );
      return { isError: false, text: 'UNSUPPLIED_MCP_RAN' };
    }
    await mcpRequest(server, 'initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cursor-test-fixture', version: '1' },
    });
    const result = await mcpRequest(server, 'tools/call', {
      name: toolName,
      arguments: args,
    });
    if (result.error) return { isError: true, text: result.error.message };
    return {
      isError: result.result?.isError === true,
      text: (result.result?.content ?? [])
        .map((part) => (part.type === 'text' ? part.text : ''))
        .join(''),
    };
  }
  // The pinned CLI titles MCP calls "<server>: <tool>" with kind "other",
  // sends {providerIdentifier, toolName, args} as rawInput, and asks
  // permission with allow-once / allow-always / reject-once options.
  async function mcpToolCall(
    id,
    server,
    toolName,
    args,
    { requestPermission, beforeExecute },
  ) {
    const title = `${server.name}: ${toolName}`;
    update({
      sessionUpdate: 'tool_call',
      toolCallId: id,
      title,
      kind: 'other',
      status: 'pending',
      rawInput: { providerIdentifier: server.name, toolName, args },
    });
    // Like the pinned CLI's MCP executor: preToolUse runs first with the tool
    // as `MCP:<tool>`, the arguments as the input, and a hook-only id. A deny
    // fails the call as permission denied without any ACP permission request.
    const hookDecision = await hook(`MCP:${toolName}`, args, {
      toolUseId: `mcp-hook-${id}`,
    });
    if (hookDecision.permission !== 'allow') {
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'failed',
        rawOutput: { permissionDenied: true },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'MCP tool blocked by preToolUse hook.' },
      });
      return;
    }
    let allowed = true;
    if (requestPermission) {
      allowed = await new Promise((resolve) => {
        permissions.set(`${id}-permission`, resolve);
        send({
          id: `${id}-permission`,
          method: 'session/request_permission',
          params: {
            sessionId: 'cursor-fixture-session',
            toolCall: {
              toolCallId: id,
              title,
              kind: 'other',
              status: 'pending',
              content: [
                {
                  type: 'content',
                  content: {
                    type: 'text',
                    text: `\`\`\`json\n${JSON.stringify(args, null, 2)}\n\`\`\``,
                  },
                },
              ],
            },
            options: [
              {
                optionId: 'allow-once',
                name: 'Allow once',
                kind: 'allow_once',
              },
              {
                optionId: 'allow-always',
                name: 'Always allow',
                kind: 'allow_always',
              },
              { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
            ],
          },
        });
      });
    }
    if (!allowed) {
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: id,
        status: 'failed',
        rawOutput: { permissionDenied: true },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'MCP tool denied.' },
      });
      return;
    }
    await beforeExecute?.();
    const result = await callMcpTool(server, toolName, args);
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-mcp-result.json'),
      JSON.stringify({ toolName, ...result }),
    );
    update({
      sessionUpdate: 'tool_call_update',
      toolCallId: id,
      status: result.isError ? 'failed' : 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: result.text } },
      ],
      rawOutput: result.isError ? { error: result.text } : { success: true },
    });
    update({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `MCP_RESULT: ${result.text}` },
    });
    return result;
  }
  const update = (value) =>
    send({
      method: 'session/update',
      params: { sessionId: 'cursor-fixture-session', update: value },
    });
  const send = (data) =>
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...data }) + '\n');
  const reply = (id, result) => send({ id, result });

  async function hook(toolName, input, options = {}) {
    const encoded = cwd
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '');
    const projectDir = path.join(
      process.env.CURSOR_DATA_DIR,
      'projects',
      encoded,
    );
    const config = JSON.parse(
      await readFile(path.join(projectDir, '.cursor', 'hooks.json'), 'utf8'),
    );
    const definition = config.hooks[options.event ?? 'preToolUse']?.[0];
    if (!definition) return {};
    return new Promise((resolve) => {
      // The pinned CLI starts the hook shell in project storage, not the chat
      // workspace. On Windows CreateProcess applies its cwd limit here.
      const spawnOptions = {
        cwd: projectDir,
        stdio: ['pipe', 'pipe', 'ignore'],
      };
      const child =
        process.platform === 'win32'
          ? spawn(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '& ' + definition.command,
              ],
              spawnOptions,
            )
          : spawn(definition.command, {
              ...spawnOptions,
              shell: true,
            });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
      });
      child.on('error', () => resolve({ permission: 'deny' }));
      child.on('close', (code) => {
        try {
          const parsed = JSON.parse(output);
          // Like the pinned CLI's hook executor: an allow may carry a plain
          // object updated_input that replaces the tool input before it runs.
          const updatedInput =
            parsed.updated_input &&
            typeof parsed.updated_input === 'object' &&
            !Array.isArray(parsed.updated_input)
              ? parsed.updated_input
              : undefined;
          resolve(
            code === 0 && parsed.permission === 'allow'
              ? { permission: 'allow', updatedInput }
              : { permission: 'deny' },
          );
        } catch {
          resolve({ permission: 'deny' });
        }
      });
      const bytes = Buffer.from(
        JSON.stringify(
          options.payload ?? {
            hook_event_name: 'preToolUse',
            tool_name: toolName,
            tool_input: input,
            tool_use_id: options.toolUseId ?? 'fixture-edit',
          },
        ),
      );
      const split = bytes.indexOf(Buffer.from('é')) + 1;
      if (split > 0) {
        child.stdin.write(bytes.subarray(0, split));
        // Force the native hook to consume a partial UTF-8 sequence before EOF.
        setTimeout(() => child.stdin.end(bytes.subarray(split)), 500);
      } else child.stdin.end(bytes);
    });
  }

  async function prompt(id, params) {
    promptId = id;
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-args.json'),
      JSON.stringify(process.argv.slice(2)),
    );
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-pid.txt'),
      String(process.pid),
    );
    const text = params.prompt.map((part) => part.text ?? '').join('\n');
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-prompt.txt'),
      text,
    );
    if (text.includes('CURSOR_DELEGATION_')) {
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: true }),
      );
    }
    if (text.includes('CURSOR_DELEGATION_PARENT')) {
      const server = mcpServers.find((entry) => !entry.name.endsWith('_ui'));
      const listed = server && (await mcpRequest(server, 'tools/list', {}));
      const names = listed?.result?.tools?.map((tool) => tool.name) ?? [];
      if (names.includes('WatchDelegates'))
        throw new Error('Fresh tool list includes WatchDelegates');
      if (!names.includes('DelegateTask')) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Managed delegation is unavailable.' },
        });
      } else {
        const result = await mcpToolCall(
          'delegate-spawn',
          server,
          'DelegateTask',
          {
            model:
              text.match(
                /CURSOR_CHILD_MODEL=(sonnet|gpt-6\.1-sol|agent_model_cursor_reviewer)/,
              )?.[1] ?? 'cursor-default',
            description: 'Read delegated evidence',
            prompt:
              text.match(/\[Canopy-CDELEGATIONCHILD-[a-z0-9-]+\]/)?.[0] ??
              (text.includes('CURSOR_CHILD_MCP')
                ? 'CURSOR_DELEGATION_CHILD_MCP'
                : 'CURSOR_DELEGATION_CHILD_READ'),
          },
          { requestPermission: text.includes('CURSOR_DELEGATION_ACP') },
        );
        const spawned = result && JSON.parse(result.text);
        if (spawned?.ok) {
          await writeFile(
            path.join(process.env.CURSOR_DATA_DIR, 'fixture-delegate-id'),
            spawned.value.delegationId,
          );
        }
      }
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_DELEGATION_CHILD_MCP')) {
      const server = mcpServers.find((entry) =>
        /e2e-mcp-fixture/i.test(entry.name),
      );
      if (!server) throw new Error('Selected child MCP server missing');
      await mcpToolCall(
        'child-mcp',
        server,
        'echo',
        { message: 'delegated' },
        {
          requestPermission: true,
          beforeExecute: async () => {
            await writeFile(
              path.join(process.env.CURSOR_DATA_DIR, 'mcp-admitted'),
              'ready',
            );
            const deadline = Date.now() + 60000;
            while (
              !existsSync(path.join(process.env.CURSOR_DATA_DIR, 'mcp-execute'))
            ) {
              if (cancelled || Date.now() > deadline)
                throw new Error('Child MCP barrier cancelled or timed out');
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          },
        },
      );
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_DELEGATION_CHILD_WAIT')) {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'Cursor child is waiting. CURSOR_CHILD_WAITING\n',
        },
      });
      await new Promise(() => {});
      return;
    }
    if (text.includes('CURSOR_DELEGATION_CHILD_READ')) {
      const input = { file_path: path.join(cwd, 'delegation-evidence.txt') };
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'delegate-read',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        rawInput: input,
      });
      const decision = await hook('Read', input, {
        toolUseId: 'delegate-read',
      });
      let content =
        decision.permission === 'allow'
          ? await readFile(input.file_path, 'utf8')
          : 'DELEGATED_READ_DENIED';
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'delegate-read',
        status: 'completed',
        rawOutput: { content },
      });
      const searchDecisions = {};
      for (const [tool, toolInput, rawInput, title] of [
        [
          'Grep',
          { pattern: 'EVIDENCE', file_path: input.file_path },
          { pattern: 'EVIDENCE', path: input.file_path },
          'grep EVIDENCE',
        ],
        [
          'Glob',
          { glob_pattern: 'delegation-*.txt', target_directory: cwd },
          { pattern: 'delegation-*.txt', path: cwd },
          'Find delegation-*.txt',
        ],
        ['List', { file_path: cwd }, { path: cwd }, 'List files'],
        ['ReadLints', { file_path: cwd }, { path: cwd }, 'Read diagnostics'],
      ]) {
        const toolCallId = `delegate-${tool}`;
        update({
          sessionUpdate: 'tool_call',
          toolCallId,
          title,
          kind: 'search',
          status: 'pending',
          rawInput,
        });
        const searchDecision = await hook(tool, toolInput, {
          toolUseId: toolCallId,
        });
        searchDecisions[tool] = searchDecision.permission;
        const output =
          searchDecision.permission === 'allow'
            ? tool === 'Grep'
              ? await readFile(input.file_path, 'utf8')
              : (await readdir(cwd))
                  .filter((name) => /^delegation-.*\.txt$/.test(name))
                  .join('\n')
            : 'DELEGATED_SEARCH_DENIED';
        // A child must preserve its permitted Read result when traversal is
        // denied. An unexpected allow makes the integration assertion fail.
        if (searchDecision.permission === 'allow')
          content = 'DELEGATED_SEARCH_UNEXPECTEDLY_ALLOWED';
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status:
            searchDecision.permission === 'allow' ? 'completed' : 'failed',
          rawOutput: { content: output },
        });
      }
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-search-decisions.json'),
        JSON.stringify(searchDecisions),
      );
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: content },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    const delegateId = await readFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-delegate-id'),
      'utf8',
    ).catch(() => undefined);
    if (delegateId) {
      const server = mcpServers.find((entry) => !entry.name.endsWith('_ui'));
      if (
        text.includes('CURSOR_DELEGATION_FOLLOW_UP') ||
        text.includes('CURSOR_DELEGATION_STOP')
      ) {
        await mcpToolCall(
          'delegate-follow-up',
          server,
          'MessageDelegate',
          {
            delegationId: delegateId,
            operation: 'follow_up',
            message: text.includes('CURSOR_DELEGATION_STOP')
              ? 'CURSOR_DELEGATION_CHILD_WAIT'
              : 'CURSOR_DELEGATION_CHILD_READ',
          },
          { requestPermission: false },
        );

        if (text.includes('CURSOR_DELEGATION_STOP'))
          await new Promise(() => {});
        if (!cancelled) reply(id, { stopReason: 'end_turn' });
        return;
      }
      const result = await mcpToolCall(
        'delegate-output',
        server,
        'GetDelegateOutput',
        { delegationId: delegateId },
        { requestPermission: false },
      );
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `Integrated delegated evidence: ${result?.text ?? 'missing'}`,
        },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.endsWith('CURSOR_CHAT_E2E_ORDERED_BURST')) {
      // Obtain evidence before the burst so its updates still arrive together.
      await hook(
        'Read',
        { file_path: path.join(cwd, 'ordered-read.txt') },
        { toolUseId: 'ordered-read' },
      );
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Before the ordered read.' },
      });
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'ordered-read',
        title: 'Read',
        kind: 'read',
        status: 'pending',
        rawInput: { path: path.join(cwd, 'ordered-read.txt') },
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'ordered-read',
        status: 'completed',
        rawOutput: 'Ordered file content.',
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'After the ordered read.' },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.endsWith('CURSOR_CHAT_E2E_OUTPUT_BURST')) {
      for (let i = 0; i < 120; i += 1) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `word-${i} `,
          },
        });
      }
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: 'CURSOR_STREAM_DONE',
        },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    // A reply that ends with the local-memory citation control tag, split
    // across ACP deltas the way a streaming model emits it. The tag is a
    // rendering instruction for the app, never text the user should see. The
    // pause between chunks outlasts the event buffer's 25 ms text flush, so
    // each chunk reaches the reducer as its own patch and the spec exercises
    // the cross-patch fold rather than one coalesced block.
    if (text.endsWith('CURSOR_CHAT_E2E_CITATION')) {
      for (const chunk of [
        'Cited answer.',
        '\n<memory_citation files="topics/',
        'testing.md"/>',
      ]) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: chunk },
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    // Persist independent provider-side context for the real fork/restart flow.
    // The current request is last; copied history can contain old fixture markers.
    if (/CURSOR_CHAT_E2E_USAGE(?:_ACTIVE)?$/.test(text)) {
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: true }),
      );
      await hook(undefined, undefined, {
        event: 'afterAgentResponse',
        payload: {
          hook_event_name: 'afterAgentResponse',
          conversation_id: 'cursor-fixture-session',
          input_tokens: 12000,
          output_tokens: 800,
          cache_read_tokens: 9000,
          cache_write_tokens: 500,
          text: 'Private response content must not be sent to the usage callback.',
        },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Usage response complete.' },
      });
      // Keep the latest response active so the preceding completed turn's
      // historical fork control remains available in the real transcript UI.
      if (!text.endsWith('CURSOR_CHAT_E2E_USAGE_ACTIVE')) {
        reply(id, { stopReason: 'end_turn' });
      }
      return;
    }
    // A turn that never finishes on its own, so a test can exercise the real
    // cancellation path. `session/cancel` still replies `cancelled` below.
    if (text.endsWith('CURSOR_CHAT_E2E_HANG')) {
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Working on it…' },
      });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_SPLIT_SECRET')) {
      // A synthetic configured value streamed the way a model streams it: in
      // token-sized pieces, across message and thought blocks, interleaved,
      // and once more cut off at the very end of the turn.
      const chunks = [
        ['agent_thought_chunk', 'Reading sk-li'],
        ['agent_thought_chunk', 've-FAKE-0123456789'],
        ['agent_thought_chunk', 'abcdef from the env.'],
        ['agent_message_chunk', 'The key is sk-live-'],
        ['agent_message_chunk', 'FAKE-0123'],
        ['agent_message_chunk', '456789abcdef'],
        ['agent_message_chunk', '. Unrelated tail.'],
        ['agent_thought_chunk', 'Again: sk-live-FAKE-01'],
        ['agent_thought_chunk', '23456789abcdef.'],
        ['agent_message_chunk', 'Whole sk-live-FAKE-0123456789abcdef here, '],
        ['agent_message_chunk', 'then a trailing sk-live-FAKE-0123456789abc'],
        ['agent_message_chunk', 'def and a cut-off sk-li'],
      ];
      for (const [sessionUpdate, chunk] of chunks)
        update({ sessionUpdate, content: { type: 'text', text: chunk } });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (
      text.includes('CURSOR_E2E_STRUCTURED_RETRY') ||
      text.includes('failed JSON Schema validation')
    ) {
      // A structured step whose first answer does not parse. The retry says
      // whether it could still see the original task: a retry sent into a
      // brand-new conversation without it cannot.
      // A conversation happened, so a later turn can restore it.
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: true }),
      );
      const retrying = text.includes('failed JSON Schema validation');
      const answer = retrying
        ? JSON.stringify({
            summary: text.includes('ORIGINAL-TASK-7731')
              ? 'had-task'
              : 'no-task',
          })
        : 'not a JSON answer';
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: answer },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_CONTAINED_SECRET')) {
      // Two synthetic configured values, one inside the other: a database URL
      // and its password. The URL is echoed whole in one thought delta, then
      // split around a tool call in the response.
      const url = 'postgres://admin:S3cretPass@db.internal:5432/app';
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: `Connecting with ${url} now.` },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'DB is postgres://admin:S3cretPass' },
      });
      const containedInput = { path: path.join(cwd, 'config.txt') };
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'contained-read',
        title: 'Read config',
        kind: 'read',
        status: 'pending',
        rawInput: containedInput,
      });
      // The pinned runtime routes a native Read through preToolUse, so this
      // branch does too: a headless step requires evidence that its policy saw
      // the call, and a masking scenario is not the place to model a runtime
      // that skips the gate.
      await hook('Read', containedInput, { toolUseId: 'contained-read' });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'contained-read',
        status: 'completed',
        rawOutput: { content: 'ordinary' },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '@db.internal:5432/app is up.' },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_NESTED_SECRET')) {
      // A synthetic configured value (`sk-live  "Q\\Z"  0123456`, doubled
      // spaces, a quote and a backslash) reaching a step three ways record
      // masking alone misses: echoed with its spacing reflowed across thought
      // deltas, split around a tool call, and nested inside the tool's
      // input and output, where JSON escapes the quote and backslash.
      const secret = 'sk-live  "Q\\Z"  0123456';
      for (const [sessionUpdate, chunk] of [
        ['agent_thought_chunk', 'Looking for sk-live "Q\\Z" '],
        ['agent_thought_chunk', '0123456 now.'],
        ['agent_message_chunk', 'Found sk-live "Q\\'],
      ])
        update({ sessionUpdate, content: { type: 'text', text: chunk } });
      const nestedInput = {
        path: path.join(cwd, 'notes.txt'),
        pattern: secret,
      };
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'nested-read',
        title: 'Read notes.txt',
        kind: 'read',
        status: 'pending',
        rawInput: nestedInput,
      });
      // As above: the read reaches the gate, exactly as the pinned runtime's
      // does. The configured value in this input is the point of the scenario
      // and is still masked in everything projected and persisted.
      await hook('Read', nestedInput, { toolUseId: 'nested-read' });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'nested-read',
        status: 'completed',
        rawOutput: { content: `token=${secret}` },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Z" 0123456 in the file.' },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_OUTPUT_FLOOD')) {
      // More than the 8 MiB of notification JSON one turn may project.
      const piece = 'z'.repeat(64 * 1024);
      for (
        let sent = 0;
        sent < 9 * 1024 * 1024 && !cancelled;
        sent += piece.length
      )
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: piece },
        });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    // Integrity anchor: a tool that CHANGES the worktree but never reached the
    // approval hook. The pinned CLI cannot do this, but a compromised or
    // mismatched runtime could, and that is exactly what the anchor exists to
    // catch — so the fixture has to be able to produce it.
    // Integrity anchor, reuse variants. A noncompliant runtime can reuse one
    // tool id: the hook sees the first invocation, the second only reports a
    // completion. The anchor must consume an observation once, so the second
    // call stops the session, while a genuinely re-approved call and a
    // duplicated completion report of the same call still pass.
    if (text.endsWith('CURSOR_CHAT_E2E_REUSED_NATIVE_ID')) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const input = {
          file_path: path.join(cwd, `reused-${attempt}.txt`),
          content: `reused-${attempt}`,
        };
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'reused-native-id',
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
          rawInput: input,
        });
        if (attempt === 1)
          await hook('Write', input, { toolUseId: 'reused-native-id' });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'reused-native-id',
          status: 'completed',
          rawOutput: { ok: true },
        });
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.endsWith('CURSOR_CHAT_E2E_REAPPROVED_NATIVE_ID')) {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const input = {
          file_path: path.join(cwd, `reapproved-${attempt}.txt`),
          content: `reapproved-${attempt}`,
        };
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'reapproved-native-id',
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
          rawInput: input,
        });
        await hook('Write', input, { toolUseId: 'reapproved-native-id' });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'reapproved-native-id',
          status: 'completed',
          rawOutput: { ok: true },
        });
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    // Same id AND same input, so the second completion is byte-identical to
    // the first. A settled completion must not exempt a NEW invocation: the
    // second `tool_call` notification starts one, and only the first reaches
    // the hook.
    if (text.endsWith('CURSOR_CHAT_E2E_REUSED_NATIVE_SAME_INPUT')) {
      const input = {
        file_path: path.join(cwd, 'reused-same.txt'),
        content: 'reused-same',
      };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'reused-same-input',
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
          rawInput: input,
        });
        if (attempt === 1)
          await hook('Write', input, { toolUseId: 'reused-same-input' });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'reused-same-input',
          status: 'completed',
          rawOutput: { ok: true },
        });
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.endsWith('CURSOR_CHAT_E2E_REAPPROVED_SAME_INPUT')) {
      const input = {
        file_path: path.join(cwd, 'reapproved-same.txt'),
        content: 'reapproved-same',
      };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'reapproved-same-input',
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
          rawInput: input,
        });
        await hook('Write', input, { toolUseId: 'reapproved-same-input' });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'reapproved-same-input',
          status: 'completed',
          rawOutput: { ok: true },
        });
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.endsWith('CURSOR_CHAT_E2E_DUPLICATE_COMPLETION')) {
      const input = {
        file_path: path.join(cwd, 'duplicate.txt'),
        content: 'duplicate',
      };
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'duplicate-completion',
        title: 'Edit file',
        kind: 'edit',
        status: 'pending',
        rawInput: input,
      });
      await hook('Write', input, { toolUseId: 'duplicate-completion' });
      for (let report = 0; report < 2; report += 1)
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'duplicate-completion',
          status: 'completed',
          rawOutput: { ok: true },
        });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    // The MCP branch of the same anchor. An MCP tool call never reaches the
    // native hook, so its only gate is the ACP permission request; the
    // recorded decision must authorize exactly the invocation it was made
    // for. A permission request is sent only where each mode needs one, and
    // `duplicate` repeats the terminal notification without a second start.
    if (
      text.endsWith('CURSOR_CHAT_E2E_REUSED_ACP_DECISION') ||
      text.endsWith('CURSOR_CHAT_E2E_REAPPROVED_ACP_DECISION') ||
      text.endsWith('CURSOR_CHAT_E2E_DUPLICATE_ACP_COMPLETION')
    ) {
      const reapproved = text.endsWith(
        'CURSOR_CHAT_E2E_REAPPROVED_ACP_DECISION',
      );
      const duplicate = text.endsWith(
        'CURSOR_CHAT_E2E_DUPLICATE_ACP_COMPLETION',
      );
      const input = {
        providerIdentifier: 'fixture-mcp',
        toolName: 'check',
        args: { value: 'same' },
      };
      const call = {
        toolCallId: 'reused-acp-decision',
        title: 'fixture-mcp: check',
        kind: 'other',
        status: 'pending',
        rawInput: input,
      };
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        if (attempt === 1 || !duplicate)
          update({ sessionUpdate: 'tool_call', ...call });
        if (attempt === 1 || reapproved)
          await new Promise((resolve) => {
            const requestId = `reused-acp-permission-${attempt}`;
            permissions.set(requestId, resolve);
            send({
              id: requestId,
              method: 'session/request_permission',
              params: {
                sessionId: 'cursor-fixture-session',
                toolCall: call,
                options: [
                  {
                    optionId: 'allow-once',
                    name: 'Allow once',
                    kind: 'allow_once',
                  },
                  {
                    optionId: 'reject-once',
                    name: 'Reject',
                    kind: 'reject_once',
                  },
                ],
              },
            });
          });
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: call.toolCallId,
          status: 'completed',
          rawOutput: { ok: true },
        });
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    // Completion-backstop cases, parameterised as
    // `CURSOR_CHAT_E2E_COMPLETION:<kind>:<hook>` with `hook` one of
    // `none` (never calls the hook), `allow`, or `deny`. A denied native call
    // is still reported as completed-with-failure by the pinned CLI, so the
    // `deny` variant models a legitimate refusal rather than a skipped gate.
    const completionCase = text.match(
      /CURSOR_CHAT_E2E_COMPLETION:(read|search|fetch|edit|think):(none|allow|deny)(:initial)?$/,
    );
    if (completionCase) {
      // Keep this session resumable even when the integrity check aborts the
      // prompt, so the UI regression can exercise a subsequent healthy turn.
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: true }),
      );
      const [, kind, hookMode, initial] = completionCase;
      const tool =
        kind === 'edit'
          ? 'Write'
          : kind === 'read'
            ? 'Read'
            : kind === 'search'
              ? 'Grep'
              : kind === 'fetch'
                ? 'WebFetch'
                : 'Think';
      const input = {
        file_path: path.join(cwd, 'synthetic-completion.txt'),
        content: 'synthetic',
        pattern: 'synthetic',
        url: 'https://example.invalid/',
      };
      const call = {
        toolCallId: 'completion-backstop',
        title: tool,
        kind,
        rawInput: input,
      };
      if (!initial)
        update({ sessionUpdate: 'tool_call', status: 'pending', ...call });
      let denied = false;
      if (hookMode !== 'none') {
        const decision = await hook(tool, input, {
          toolUseId: 'completion-backstop',
        });
        denied = decision?.permission !== 'allow';
      }
      update({
        sessionUpdate: initial ? 'tool_call' : 'tool_call_update',
        ...call,
        status: denied ? 'failed' : 'completed',
        rawOutput: { synthetic: true },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.endsWith('CURSOR_CHAT_E2E_UNHOOKED_TOOL')) {
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'unhooked-1',
        title: 'Edit file',
        kind: 'edit',
        status: 'pending',
        rawInput: { path: 'notes.txt', content: 'written without approval' },
      });
      // Deliberately NO `hook(...)` call before completing it.
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'unhooked-1',
        status: 'completed',
        rawOutput: { ok: true },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Edited the file.' },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    const contextRequest = text.match(
      /CURSOR_CHAT_E2E_CONTEXT_(SET|CHECK)(?:: ([A-Z]+-\d+))?(?: (?:max_tokens|max_turn_requests))?$/,
    );
    if (contextRequest) {
      const contextPath = path.join(
        process.env.CURSOR_DATA_DIR,
        'fixture-fork-context.txt',
      );
      let code;
      try {
        code = await readFile(contextPath, 'utf8');
      } catch {
        /* new conversation */
      }
      if (contextRequest[1] === 'SET') code = contextRequest[2];
      // A fresh session learns only what the host actually sends it.
      if (!code && text.includes('ORCHID-62')) code = 'ORCHID-62';
      if (code) await writeFile(contextPath, code);
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-prompt.txt'),
        text,
      );
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: true }),
      );
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: code
            ? `Context code: ${code}.`
            : 'ERROR: no earlier context received.',
        },
      });
      reply(id, {
        stopReason: text.endsWith(' max_tokens')
          ? 'max_tokens'
          : text.endsWith(' max_turn_requests')
            ? 'max_turn_requests'
            : 'end_turn',
      });
      return;
    }
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-prompt.txt'),
      text,
    );
    await writeFile(
      path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
      JSON.stringify({ remembered: true }),
    );
    if (text.includes('CURSOR_CHAT_E2E_TRANSCRIPT')) {
      // Pinned 2026.09.08 ACP shapes: display titles are not tool names;
      // Read sends path (not file_path), and failures still say completed.
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Checking the project files.' },
      });
      update({
        sessionUpdate: 'agent_thought_chunk',
        content: {
          type: 'text',
          text: 'Inspect the package and project documentation.',
        },
      });
      for (const tool of [
        {
          toolCallId: 'display-read',
          title: 'Read package.json',
          kind: 'read',
          rawInput: { path: path.join(cwd, 'package.json') },
          rawOutput: { content: '{"name":"demo-project"}' },
        },
        {
          toolCallId: 'display-glob',
          title: 'Find `README*`',
          kind: 'search',
          rawInput: { pattern: 'README*' },
          rawOutput: { error: 'Glob blocked by preToolUse hook' },
        },
        {
          toolCallId: 'display-grep',
          title: 'grep "scripts"',
          kind: 'search',
          rawInput: { pattern: 'scripts', path: cwd },
          rawOutput: { totalMatches: 1, truncated: false },
        },
      ]) {
        const { rawOutput, ...call } = tool;
        update({ sessionUpdate: 'tool_call', status: 'pending', ...call });
        // Transcript shapes still represent calls observed by native policy.
        const nativeName =
          call.kind === 'read'
            ? 'Read'
            : call.toolCallId === 'display-glob'
              ? 'Glob'
              : 'Grep';
        // ACP's Read display uses `path`; the native hook requires `file_path`.
        const nativeInput =
          nativeName === 'Read'
            ? { file_path: call.rawInput.path }
            : call.rawInput;
        const decision = await hook(nativeName, nativeInput, {
          toolUseId: call.toolCallId,
        });
        const denied = decision.permission !== 'allow';
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: call.toolCallId,
          status: 'completed',
          rawOutput: denied
            ? { error: `${nativeName} blocked by preToolUse hook` }
            : rawOutput,
        });
        if (nativeName === 'Read' && denied) {
          reply(id, { stopReason: 'end_turn' });
          return;
        }
      }
      if (text.includes('TRANSCRIPT_REUSED')) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Updating the package.' },
        });
        update({
          sessionUpdate: 'tool_call',
          toolCallId: 'display-read',
          title: 'Edit package.json',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: path.join(cwd, 'package.json') },
        });
        // The native write hook can correlate by raw ID; the display must not
        // replace the Read that already completed under that ID.
        await hook(
          'Write',
          { file_path: path.join(cwd, 'package.json'), content: '{}' },
          { toolUseId: 'display-read' },
        );
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'display-read',
          status: 'completed',
          rawOutput: { diff: 'package changed' },
        });
      }
      const command = 'git status --short';
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'display-shell',
        title: '`git status --short`',
        kind: 'execute',
        status: 'pending',
        rawInput: { command },
      });
      const decision = await hook(
        'Shell',
        { command, cwd },
        { toolUseId: 'display-shell' },
      );
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'display-shell',
        status: 'completed',
        rawOutput: {
          exitCode: decision.permission === 'allow' ? 0 : 1,
          stdout: '',
          stderr: '',
        },
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'This is a TypeScript project.' },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_MCP_')) {
      const app = mcpServers.find(
        (server) => server.type === 'http' && !server.name.endsWith('_ui'),
      );
      const plugin = mcpServers.find((server) =>
        /e2e-mcp-fixture/i.test(server.name),
      );
      if (text.includes('CURSOR_CHAT_E2E_MCP_UNSUPPLIED')) {
        // An MCP server Canopy never supplied (for example one the runtime
        // could read from project config) with no ACP permission request, so
        // the preToolUse hook is the only gate the call passes through.
        await mcpToolCall(
          'fixture-mcp-unsupplied',
          { name: 'project-mcp', unsupplied: true },
          'send_message',
          { to: 'someone', body: 'hello' },
          { requestPermission: false },
        );
      } else if (text.includes('CURSOR_CHAT_E2E_MCP_WATCH') && app) {
        // WatchCommand on the app server: gated (plan mode denies at the
        // permission request) or UNGATED (no permission request, so the
        // app's own execution seam must refuse the probe).
        await mcpToolCall(
          'fixture-mcp-watch',
          app,
          'WatchCommand',
          {
            command: 'printf CURSOR_WATCH_RAN > cursor-watch-result.txt',
            intervalSeconds: 5,
            maxAttempts: 1,
          },
          { requestPermission: !text.includes('UNGATED') },
        );
      } else if (text.includes('CURSOR_CHAT_E2E_MCP_ADVISOR') && app) {
        // App Advisor tools on the app server: a read followed by a mutation,
        // each behind the ACP permission request the host answers through
        // its approval card.
        await mcpToolCall(
          'fixture-mcp-advisor-state',
          app,
          'GetCurrentUiState',
          {},
          { requestPermission: true },
        );
        await mcpToolCall(
          'fixture-mcp-advisor-dispatch',
          app,
          'DispatchAction',
          {
            action: {
              type: 'navigation.open_settings',
              section: 'experiments',
            },
          },
          { requestPermission: true },
        );
      } else if (text.includes('CURSOR_CHAT_E2E_MCP_APP') && app) {
        await mcpToolCall(
          'fixture-mcp-app',
          app,
          'GetGitPreferences',
          { type: 'branch-name' },
          {
            requestPermission: true,
          },
        );
      } else if (text.includes('CURSOR_CHAT_E2E_MCP_PLUGIN') && plugin) {
        await mcpToolCall(
          'fixture-mcp-plugin',
          plugin,
          'echo',
          { message: 'hello' },
          {
            requestPermission: !text.includes('UNGATED'),
          },
        );
      } else {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: `MCP_UNAVAILABLE: ${mcpServers.map((server) => server.name).join(',') || 'none'}`,
          },
        });
      }
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_PROVIDER_ERROR')) {
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: false }),
      );
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Starting the request.' },
      });
      // Exact observed pinned CLI error notification, followed by a normal
      // prompt result: this must still end the Canopy turn as failed.
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '\n\nError: RetriableError: [resource_exhausted] Error',
        },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_SETTINGS_REQUIRED')) {
      // The pinned CLI's notice for a backend ActionRequiredError(config),
      // for example a model whose data retention policy the account has not
      // accepted: exactly one chunk, the backend's own title and detail
      // dropped, then a normal end_turn.
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '\n\nCheck your settings to continue' },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_PROPOSED_PLAN')) {
      // A completed plan-mode turn whose answer carries the proposal block
      // Canopy extracts into a tracked plan.
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: '<proposed_plan>\n# Cursor retry plan\n\n- Cap the retry at three.\n</proposed_plan>',
        },
      });
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (
      text.includes('CURSOR_CHAT_E2E_MODEL') ||
      text.includes('CURSOR_CHAT_E2E_TEXT') ||
      text.includes('CURSOR_CHAT_E2E_RESUME')
    ) {
      const result = text.includes('CURSOR_CHAT_E2E_MODEL')
        ? `Cursor model: ${selectedModel}; restored: ${loaded}`
        : text.includes('CURSOR_CHAT_E2E_RESUME')
          ? loaded
            ? 'CANOPY_CURSOR_REMEMBERED'
            : 'ERROR: conversation was not loaded.'
          : 'Cursor chat works.';
      await writeFile(
        path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
        JSON.stringify({ remembered: true }),
      );
      for (const word of result.split(' ')) {
        update({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: word + ' ' },
        });
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_INVALID_GREP')) {
      // Pinned 2026.09.08-6caf4ff rejects Grep {} before invoking preToolUse.
      // It reports that validation error as completed, without in_progress.
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'invalid-grep',
        title: 'grep',
        kind: 'search',
        status: 'pending',
        rawInput: {},
      });
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'invalid-grep',
        status: 'completed',
        rawOutput: { error: 'Invalid arguments:\npattern: Required' },
      });
      // Continue into the real hook-backed Grep branch below. Recovery must
      // not authorize the corrected call or suppress its approval card.
    }
    if (text.includes('CURSOR_CHAT_E2E_NATIVE_')) {
      const tool = text.match(/CURSOR_CHAT_E2E_NATIVE_(\w+)/)?.[1];
      const definitions = {
        Grep: {
          input: {
            pattern: 'needle',
            file_path: cwd,
            glob: '*.txt',
            output_mode: 'content',
          },
          rawInput: { pattern: 'needle', path: cwd },
          title: 'grep needle',
          kind: 'search',
        },
        Glob: {
          input: { glob_pattern: 'cursor-native-*.txt', target_directory: cwd },
          rawInput: { pattern: 'cursor-native-*.txt', path: cwd },
          title: 'Find cursor-native-*.txt',
          kind: 'search',
        },
        List: {
          input: { file_path: cwd, ignore: [] },
          rawInput: { path: cwd },
          title: 'List directory',
          kind: 'read',
        },
        ReadLints: {
          input: { file_path: path.join(cwd, 'cursor-native-source.txt') },
          rawInput: { path: path.join(cwd, 'cursor-native-source.txt') },
          title: 'Read diagnostics',
          kind: 'read',
        },
        Delete: {
          input: { file_path: path.join(cwd, 'cursor-native-delete.txt') },
          rawInput: { path: path.join(cwd, 'cursor-native-delete.txt') },
          title: 'Delete file',
          kind: 'delete',
        },
        Fetch: {
          input: { url: 'https://example.com/docs' },
          rawInput: { url: 'https://example.com/docs' },
          title: 'Fetch documentation',
          kind: 'fetch',
        },
        WebSearch: {
          input: { search_term: 'fixture documentation' },
          rawInput: { searchTerm: 'fixture documentation' },
          title: 'Search web',
          kind: 'search',
        },
      };
      const definition = definitions[tool];
      if (!definition) throw new Error(`Unknown fixture tool: ${tool}`);
      const toolCallId = `native-${tool}`;
      update({
        sessionUpdate: 'tool_call',
        toolCallId,
        title: definition.title,
        kind: definition.kind,
        status: 'pending',
        rawInput: definition.rawInput,
      });
      const decision = await hook(tool, definition.input, {
        toolUseId: toolCallId,
      });
      let rawOutput;
      if (decision.permission === 'allow') {
        if (tool === 'Grep')
          rawOutput = {
            content: await readFile(
              path.join(cwd, 'cursor-native-source.txt'),
              'utf8',
            ),
          };
        else if (tool === 'Glob' || tool === 'List')
          rawOutput = {
            files: (await readdir(cwd)).filter(
              (name) => tool === 'List' || /^cursor-native-.*\.txt$/.test(name),
            ),
          };
        else if (tool === 'Delete') {
          await rm(definition.input.file_path);
          rawOutput = { deleted: true };
        } else
          rawOutput = {
            content:
              tool === 'Fetch' ? 'Fixture documentation' : 'No diagnostics',
          };
        await writeFile(
          path.join(cwd, `cursor-native-executed-${tool}`),
          JSON.stringify(rawOutput),
        );
      } else
        rawOutput = {
          error: decision.user_message ?? `${tool} blocked by preToolUse hook`,
        };
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId,
        status: 'completed',
        rawOutput,
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: `${tool} ${decision.permission === 'allow' ? 'completed' : 'denied'}.`,
        },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (text.includes('CURSOR_CHAT_E2E_LARGE_DIFFS')) {
      // The pinned ACP peer sends only the path as edit input and both full
      // file snapshots in its completed diff, separately from the Write hook.
      for (const filename of ['large-a.txt', 'large-b.txt']) {
        const filePath = path.join(cwd, filename);
        const before = await readFile(filePath, 'utf8');
        const after = before + 'CURSOR_CHAT_OK';
        const toolCallId = `edit-${filename}`;
        update({
          sessionUpdate: 'tool_call',
          toolCallId,
          title: 'Edit file',
          kind: 'edit',
          status: 'pending',
          rawInput: { path: filePath },
        });
        const decision = await hook(
          'Write',
          { file_path: filePath, content: after },
          { toolUseId: toolCallId },
        );
        if (decision.permission !== 'allow') {
          reply(id, { stopReason: 'end_turn' });
          return;
        }
        await writeFile(filePath, after);
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'completed',
          content: [
            { type: 'diff', path: filePath, oldText: before, newText: after },
          ],
        });
      }
      update({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Both large edits completed.' },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    if (
      text.includes('CURSOR_CHAT_E2E_WRITE') ||
      text.includes('CURSOR_CHAT_E2E_SHELL')
    ) {
      const filePath = path.join(
        cwd,
        text.includes('UNICODE')
          ? 'é-日本-result.txt'
          : 'cursor-chat-result.txt',
      );
      const isShell = text.includes('CURSOR_CHAT_E2E_SHELL');
      const command = 'printf CURSOR_CHAT_OK > cursor-chat-result.txt';
      const content = text.includes('CURSOR_CHAT_E2E_WRITE_LARGE')
        ? (await readFile(filePath, 'utf8')) + 'CURSOR_CHAT_OK'
        : 'CURSOR_CHAT_OK';
      const toolInput = isShell
        ? { command, cwd }
        : { file_path: filePath, content };
      update({
        sessionUpdate: 'tool_call',
        toolCallId: 'fixture-edit',
        title: isShell ? command : 'Edit file',
        kind: isShell ? 'execute' : 'edit',
        status: 'pending',
        // Pinned CLI ACP extractToolCallInput exposes only command. Native
        // Shell hooks also carry cwd/timeout and use a separate random ID.
        rawInput: isShell ? { command } : toolInput,
      });
      if (!isShell) await hook('Read', { file_path: filePath });
      let acpAllowed = true;
      if (isShell) {
        acpAllowed = await new Promise((resolve) => {
          permissions.set('shell-permission', resolve);
          send({
            id: 'shell-permission',
            method: 'session/request_permission',
            params: {
              sessionId: 'cursor-fixture-session',
              toolCall: {
                toolCallId: 'fixture-edit',
                title: command,
                kind: 'execute',
              },
              options: [
                { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
              ],
            },
          });
        });
      }
      const decision = acpAllowed
        ? await hook(
            isShell ? 'Shell' : 'Write',
            isShell ? { ...toolInput, timeout: 30000 } : toolInput,
            isShell ? { toolUseId: 'native-shell-hook-id' } : {},
          )
        : { permission: 'deny' };
      const allowed = decision.permission === 'allow';
      const effectiveInput =
        allowed && decision.updatedInput ? decision.updatedInput : toolInput;
      // Record the Shell command that actually ran so the spec can prove the
      // host's RTK rewrite reached execution (or stayed out of it).
      if (allowed && isShell)
        await writeFile(
          path.join(process.env.CURSOR_DATA_DIR, 'fixture-shell-command.txt'),
          effectiveInput.command,
        );
      if (allowed)
        await writeFile(filePath, isShell ? 'CURSOR_CHAT_OK' : content);
      update({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'fixture-edit',
        // Native Shell rejections also use completed in the pinned ACP peer.
        status: isShell || allowed ? 'completed' : 'failed',
        // The completion reports the input that ran, as the CLI would after
        // applying updated_input; the host's hook anchor must accept it.
        ...(allowed && isShell
          ? { rawInput: { command: effectiveInput.command } }
          : {}),
        rawOutput: isShell
          ? allowed
            ? { exitCode: 0, stdout: '', stderr: '' }
            : undefined
          : decision.permission,
      });
      update({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text: text.includes('CURSOR_CHAT_E2E_WRITE_MODEL_SWITCH')
            ? `Cursor write model: ${selectedModel}`
            : allowed
              ? 'File created.'
              : 'File not created.',
        },
      });
      if (!cancelled) reply(id, { stopReason: 'end_turn' });
      return;
    }
    const filePath = path.join(cwd, 'result.txt');
    await hook('Read', { file_path: filePath });
    const decision = await hook('Write', {
      file_path: filePath,
      content: 'CURSOR_APPROVAL_OK\n',
    });
    if (decision.permission === 'allow')
      await writeFile(filePath, 'CURSOR_APPROVAL_OK\n');
    if (!cancelled) reply(id, { stopReason: 'end_turn' });
  }

  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (permissions.has(message.id)) {
      permissions.get(message.id)(
        message.result?.outcome?.outcome === 'selected' &&
          ['allow', 'allow-once', 'allow-always'].includes(
            message.result.outcome.optionId,
          ),
      );
      permissions.delete(message.id);
      continue;
    }
    switch (message.method) {
      case 'initialize':
        parameterized =
          message.params?.clientCapabilities?._meta
            ?.parameterizedModelPicker === true;
        reply(message.id, {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: true,
            mcpCapabilities: {
              http: !process.env.CANOPY_E2E_CURSOR_NO_HTTP,
              sse: true,
            },
          },
          authMethods: [{ id: 'cursor_login', name: 'Cursor' }],
          agentInfo: {
            name: 'cursor-test-fixture',
            version: '2026.09.08-6caf4ff',
          },
        });
        break;
      case 'authenticate':
        {
          const hold = await readFile(
            path.join(process.env.CURSOR_DATA_DIR, 'fixture-hold-auth'),
          ).then(
            () => true,
            () => false,
          );
          if (hold) {
            await writeFile(
              path.join(process.env.CURSOR_DATA_DIR, 'fixture-auth-pid'),
              String(process.pid),
            );
          } else reply(message.id, {});
        }
        break;
      case 'session/new': {
        const discoveryResult = process.env
          .CANOPY_E2E_CURSOR_DISCOVERY_RESULT_FILE
          ? await readFile(
              process.env.CANOPY_E2E_CURSOR_DISCOVERY_RESULT_FILE,
              'utf8',
            ).catch(() => 'normal')
          : 'normal';
        if (discoveryResult === 'rejected') {
          send({
            id: message.id,
            error: { code: -32603, message: 'Fixture discovery unavailable' },
          });
          break;
        }
        if (discoveryResult === 'unmatched') {
          const otherModels = availableModels.filter(
            (model) => model.modelId !== 'kimi-k3[]',
          );
          reply(message.id, {
            sessionId: 'cursor-fixture-session',
            models: {
              currentModelId: 'default[]',
              availableModels: otherModels,
            },
            configOptions: configOptions().map((option) => ({
              ...option,
              options: option.options.filter(
                (model) => model.value !== 'kimi-k3[]',
              ),
            })),
          });
          break;
        }
        cwd = message.params.cwd;
        await recordMcpServers(message.params.mcpServers);
        reply(message.id, {
          sessionId: 'cursor-fixture-session',
          models: modelState(),
          configOptions: configOptions(),
        });
        await advertiseCapabilities();
        break;
      }
      case 'session/load':
        if (
          message.params.sessionId === 'missing-fixture-session' ||
          // Every saved conversation is gone, as after a data-dir change.
          existsSync(
            path.join(process.env.CURSOR_DATA_DIR, 'fixture-forget-sessions'),
          )
        ) {
          send({
            id: message.id,
            error: { code: -32602, message: 'Unknown session' },
          });
          break;
        }
        cwd = message.params.cwd;
        await recordMcpServers(message.params.mcpServers);
        await writeFile(
          path.join(process.env.CURSOR_DATA_DIR, 'fixture-loaded.txt'),
          message.params.sessionId,
        );
        loaded =
          JSON.parse(
            await readFile(
              path.join(process.env.CURSOR_DATA_DIR, 'fixture-history.json'),
              'utf8',
            ),
          ).remembered === true;
        reply(message.id, {
          models: modelState(),
          configOptions: configOptions(),
        });
        await advertiseCapabilities();
        break;
      case 'cursor/list_available_models':
        reply(message.id, listAvailableModels());
        break;
      case 'session/set_config_option': {
        const { id, params } = message;
        if (parameterized) {
          const invalid = (text) =>
            send({
              id,
              error: {
                code: -32602,
                message: 'Invalid params',
                data: { message: text },
              },
            });
          if (params.configId === 'model') {
            const model = availableModels.find(
              (m) => parseVariant(m.modelId).base === params.value,
            );
            if (!model) {
              invalid(`Invalid model value: ${params.value}`);
              break;
            }
            const parsed = parseVariant(model.modelId);
            selectedModel = composeVariant({
              ...parsed,
              parameters:
                rememberedParameters.get(parsed.base) ?? parsed.parameters,
            });
          } else {
            const parsed = parseVariant(selectedModel);
            const definition = PARAMETER_DEFINITIONS[params.configId];
            if (
              !definition ||
              !parsed.parameters.some((p) => p.id === params.configId)
            ) {
              invalid(`Unknown model config option: ${params.configId}`);
              break;
            }
            if (!definition.values.includes(params.value)) {
              invalid(`Invalid value for ${params.configId}: ${params.value}`);
              break;
            }
            const parameters = parsed.parameters.map((p) =>
              p.id === params.configId ? { ...p, value: params.value } : p,
            );
            rememberedParameters.set(parsed.base, parameters);
            selectedModel = composeVariant({ ...parsed, parameters });
          }
          reply(id, { configOptions: configOptions() });
          break;
        }
        if (
          params.configId !== 'model' ||
          !availableModels.some((m) => m.modelId === params.value)
        ) {
          send({ id, error: { code: -32602, message: 'Unavailable model' } });
          break;
        }
        selectedModel = params.value;
        reply(id, { configOptions: configOptions() });
        break;
      }
      case 'session/prompt':
        await writeFile(
          path.join(process.env.CURSOR_DATA_DIR, 'fixture-selected-model.txt'),
          selectedModel,
        );

        void prompt(message.id, message.params).catch(() =>
          reply(message.id, { stopReason: 'refusal' }),
        );
        break;
      case 'session/cancel':
        cancelled = true;
        if (promptId !== undefined)
          reply(promptId, { stopReason: 'cancelled' });
        break;
    }
  }
}
