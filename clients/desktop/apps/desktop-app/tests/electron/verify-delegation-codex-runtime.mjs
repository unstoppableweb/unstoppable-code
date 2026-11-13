#!/usr/bin/env node
// Native eligibility probe for the restricted Codex delegation boundary.
// Run: node --import tsx apps/desktop-app/tests/electron/verify-delegation-codex-runtime.mjs [output.json]
// Uses the shared runtime, canonical user home, temporary capability roots and
// loopback scripted inference. No paid model call or real credential read.
// A selected-skill peer stays alive while a restricted thread attempts its exact
// skill reference; a later peer turn must still succeed. This is not evidence
// for all file-policy, environment, lifecycle, or durable delivery requirements.
import { createServer } from 'node:http';
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
  chmod,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import runtime from '../../../../packages/execution-engine/src/node/codex-runtime/index.ts';
import {
  handleLlmRequest,
  resolveResponsesReply,
  buildResponsesEvents,
} from './mock-server/routes/llm.mjs';
import { registerScenario } from './mock-server/control-plane.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const output = path.resolve(
  root,
  process.argv[2] ??
    '.playwright/cross-provider-subagents/phase-0-restrictions/native-canaries.json',
);
const temporary = await mkdtemp(
  path.join(tmpdir(), 'delegation-native-canaries-'),
);
const selected = path.join(temporary, 'selected');
const cwd = path.join(temporary, 'worktree');
await mkdir(path.join(selected, 'skills/read-canary'), { recursive: true });
await mkdir(cwd);
const canary = 'DELEGATION_PRIVATE_SKILL_CANARY_f793bbc';
await writeFile(
  path.join(selected, 'skills/read-canary/SKILL.md'),
  `---\nname: read-canary\ndescription: Harmless local isolation fixture.\n---\n${canary}\n`,
);
const reports = [];
const workerPids = new Set();
const handles = [];
let controlHandle;
let current;
let peerPackage;
let peerRun;
let peerSettled = false;
let peerSignal;
let peerRelease;
const peerGate = new Promise((resolve) => {
  peerRelease = resolve;
});
let peerEntered;
const peerReady = new Promise((resolve) => {
  peerEntered = resolve;
});
let childEntered;
const childReady = new Promise((resolve) => {
  childEntered = resolve;
});
function findSkill(value) {
  if (
    typeof value === 'string' &&
    (value.trim().startsWith('[') || value.trim().startsWith('{'))
  ) {
    try {
      return findSkill(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  if (!value || typeof value !== 'object') return undefined;
  if (
    value.name === 'read-canary' &&
    typeof value.package === 'string' &&
    value.package.includes(path.basename(temporary))
  )
    return value;
  for (const child of Object.values(value)) {
    const found = findSkill(child);
    if (found) return found;
  }
}
function scenarioBody(body) {
  const input = body.input ?? [];
  let start = -1;
  for (let index = 0; index < input.length; index += 1) {
    if (
      input[index]?.role === 'user' &&
      JSON.stringify(input[index]).includes('[Canopy-Cdelegation-')
    )
      start = index;
  }
  return { ...body, input: start >= 0 ? input.slice(start) : input };
}
function inspect(body) {
  const scoped = scenarioBody(body);
  if (!current || !JSON.stringify(scoped.input).includes(`[${current.marker}]`))
    return;
  const skill = findSkill(scoped.input);
  if (skill && current.kind === 'control') {
    peerPackage = skill.package;
    current.steps[1].toolCalls[0].input = { package: peerPackage };
  }
  const outputs = scoped.input.filter(
    (item) => item.type === 'function_call_output',
  );
  for (const output of outputs) {
    const text = JSON.stringify(output.output);
    if (text.includes(canary)) current.canaryRead = true;
    if (
      /User input is unavailable|unavailable in Default mode|not available in this mode/i.test(
        text,
      )
    )
      current.questionDenied = true;
  }
  if (body.tools)
    current.advertised = body.tools.map((tool) => ({
      name: tool.name,
      tools: tool.tools?.map((item) => item.name),
    }));
}
const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname.endsWith('/responses') && request.method === 'POST') {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      inspect(body);
      const { step, usage, model } = resolveResponsesReply(scenarioBody(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of buildResponsesEvents(step, usage, model))
        response.write(
          `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`,
        );
      response.end();
    })().catch(() => response.end());
    return;
  }
  const chunks = [];
  request.on('data', (chunk) => chunks.push(chunk));
  request.on('end', () => {
    try {
      inspect(JSON.parse(Buffer.concat(chunks).toString()));
    } catch {
      // Non-JSON requests are left to the mock server's normal response path.
    }
  });
  void handleLlmRequest(
    request,
    response,
    new URL(request.url ?? '/', 'http://127.0.0.1'),
  ).then((handled) => {
    if (!handled) response.writeHead(404).end();
  });
});
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const body = JSON.parse(data.toString());
      inspect(body);
      const { step, usage, model } = resolveResponsesReply(scenarioBody(body));
      for (const event of buildResponsesEvents(step, usage, model))
        ws.send(JSON.stringify(event.data));
    });
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
assert(address && typeof address !== 'string');
const service = runtime.createCodexRuntimeService({
  capabilityStore: new runtime.CodexCapabilityStore(temporary),
  mcpLauncher: { command: 'unused-mcp-launcher', args: [] },
});
const profile = {
  configArgs: ['-c', 'features.hooks=false', '-c', 'features.apps=false'],
  includeCanopySecrets: false,
  environmentPolicy: 'restricted',
  mockProviderId: 'delegation-native-canaries',
};
const deadline = setTimeout(() => {
  void service.shutdown();
}, 90_000);
async function makeWritable(directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeWritable(target);
    else if (!entry.isSymbolicLink()) await chmod(target, 0o600);
  }
}
try {
  const configResult = await service
    .admin()
    .request('config/read', { cwd }, profile);
  const ambientNames = Object.keys(configResult.config?.mcp_servers ?? {});
  const config = {
    mcp_servers: Object.fromEntries(
      ambientNames.map((name) => [name, { enabled: false }]),
    ),
    model_providers: {
      probe: {
        name: 'Loopback probe',
        base_url: `http://127.0.0.1:${address.port}/v1`,
        wire_api: 'responses',
        requires_openai_auth: false,
      },
    },
    permissions: {
      delegation_probe: {
        filesystem: { ':minimal': 'read' },
        network: { enabled: false },
      },
    },
    features: {
      shell_tool: false,
      unified_exec: false,
      multi_agent: false,
      multi_agent_v2: false,
      apps: false,
      hooks: false,
      code_mode: false,
      code_mode_host: false,
      browser_use: false,
      browser_use_external: false,
      computer_use: false,
      image_generation: false,
      view_image: false,
      skill_search: false,
      skip_host_skill_discovery: true,
      sleep_tool: false,
      goals: false,
      in_app_browser: false,
      in_app_local_automation: false,
      remote_plugin: false,
      tool_suggest: false,
      plugins: false,
      workspace_dependencies: false,
    },
    web_search: 'disabled',
  };
  for (const kind of ['control', 'restricted', 'control-again']) {
    if (kind === 'restricted') {
      assert(controlHandle);
      registerScenario('Canopy-Cdelegation-peer-busy', {
        llm: {
          openAiStepCursor: 'completed-scenario-tool-calls',
          steps: [
            {
              toolCalls: [{ name: 'probe_hold', input: {} }],
              stopReason: 'tool_use',
            },
            { text: 'Peer remains usable.', stopReason: 'end_turn' },
          ],
        },
      });
      peerRun = controlHandle
        .runTurn({
          input: [
            {
              type: 'text',
              text: '[Canopy-Cdelegation-peer-busy] Hold this harmless peer turn.',
              text_elements: [],
            },
          ],
          totalTimeoutMs: 60_000,
          hostToolPolicy: {
            timeoutMs: 60_000,
            allowedTools: [{ namespace: null, tool: 'probe_hold' }],
            authorize: async () => true,
            execute: async (_call, signal) => {
              peerSignal = signal;
              peerEntered();
              await peerGate;
              return {
                success: true,
                contentItems: [{ type: 'inputText', text: 'Peer released.' }],
              };
            },
          },
        })
        .finally(() => {
          peerSettled = true;
        });
      await Promise.race([
        peerReady,
        peerRun.then(() => {
          throw new Error('Peer finished before entering its hold tool');
        }),
      ]);
    }
    const marker = `Canopy-Cdelegation-${kind}`;
    const steps = [
      {
        toolCalls: [
          {
            namespace: 'skills',
            name: 'list',
            input: { authority: { kind: 'executor' } },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [
          {
            namespace: 'skills',
            name: 'read',
            input: {
              package: peerPackage ?? path.join(selected, 'skills/read-canary'),
            },
          },
        ],
        stopReason: 'tool_use',
      },
      {
        toolCalls: [
          {
            name: 'request_user_input',
            input: {
              questions: [
                {
                  id: 'probe',
                  header: 'Probe',
                  question: 'Harmless test prompt',
                  options: [
                    { label: 'One', description: 'First' },
                    { label: 'Two', description: 'Second' },
                  ],
                },
              ],
            },
          },
        ],
        stopReason: 'tool_use',
      },
      ...(kind === 'restricted'
        ? [
            {
              toolCalls: [{ name: 'probe_hold', input: {} }],
              stopReason: 'tool_use',
            },
          ]
        : []),
      { text: 'Probe complete.', stopReason: 'end_turn' },
    ];
    current = {
      kind,
      marker,
      steps,
      canaryRead: false,
      questionDenied: false,
      advertised: [],
    };
    registerScenario(marker, {
      llm: { openAiStepCursor: 'completed-scenario-tool-calls', steps },
    });
    const handle =
      kind === 'control-again'
        ? controlHandle
        : await service.startThread({
            capabilitySnapshotId: `native-canaries-${kind}`,
            capabilityLeaseKind: 'ephemeral',
            profile,
            params: {
              cwd,
              ephemeral: true,
              selectedCapabilityRoots:
                kind === 'control'
                  ? [
                      {
                        id: 'canary',
                        location: {
                          type: 'environment',
                          environmentId: 'local',
                          path: selected,
                        },
                      },
                    ]
                  : [],
              environments: [],
              experimentalRawEvents: false,
              model: 'gpt-6-sol',
              modelProvider: 'probe',
              approvalPolicy: 'never',
              ...(kind === 'control'
                ? { sandbox: 'read-only' }
                : { permissions: 'delegation_probe' }),
              baseInstructions: 'Run the harmless scripted capability probe.',
              config:
                kind === 'control'
                  ? {
                      ...config,
                      features: {
                        ...config.features,
                        skip_host_skill_discovery: false,
                        plugins: true,
                      },
                    }
                  : config,
              dynamicTools: [
                {
                  type: 'function',
                  name: 'probe_hold',
                  description: 'Harmless host-owned cancellation canary.',
                  inputSchema: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                  },
                },
              ],
            },
          });
    assert(handle, 'control handle remains available');
    if (kind !== 'control-again') handles.push(handle);
    if (kind === 'control') controlHandle = handle;
    for (const worker of service.admin().getResourceSnapshots()) {
      if (worker.pid !== undefined) workerPids.add(worker.pid);
    }
    {
      const running = handle.runTurn({
        input: [
          {
            type: 'text',
            text: `[${marker}] Exercise the scripted tools.`,
            text_elements: [],
          },
        ],
        totalTimeoutMs: 35_000,
        ...(kind === 'restricted'
          ? {
              hostToolPolicy: {
                allowedTools: [{ namespace: null, tool: 'probe_hold' }],
                authorize: async () => true,
                execute: async (_call, signal) => {
                  childEntered();
                  await new Promise((resolve) =>
                    signal.addEventListener('abort', resolve, { once: true }),
                  );
                  return {
                    success: false,
                    contentItems: [{ type: 'inputText', text: 'Cancelled.' }],
                  };
                },
              },
            }
          : {}),
      });
      if (kind === 'restricted') {
        await Promise.race([
          childReady,
          running.then(() => {
            throw new Error('Child finished before entering its hold tool');
          }),
        ]);
        assert.equal(
          peerSettled,
          false,
          'the peer remains busy during the restricted turn',
        );
        assert.equal(
          peerSignal.aborted,
          false,
          'peer host call remains owned by the peer',
        );
        await handle.interrupt();
      }
      const outcome = await running;
      if (kind === 'restricted') {
        assert.equal(
          peerSettled,
          false,
          'child cancellation does not settle the busy peer',
        );
        assert.equal(
          peerSignal.aborted,
          false,
          'child cancellation does not abort peer tools',
        );
        peerRelease();
        assert.equal((await peerRun).status, 'completed');
      }
      reports.push({
        kind,
        status: outcome.status,
        canaryRead: current.canaryRead,
        questionDenied: current.questionDenied,
        foundPeerPackage: Boolean(peerPackage),
        advertised: current.advertised,
      });
    }
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(reports, null, 2));
  assert.equal(
    workerPids.size,
    1,
    'peer and restricted thread share one worker',
  );
  for (const report of reports) {
    assert.equal(
      report.status,
      report.kind === 'restricted' ? 'interrupted' : 'completed',
      `${report.kind} outcome`,
    );
    assert.equal(
      report.foundPeerPackage,
      true,
      'positive control discovered the fixture',
    );
    assert.equal(
      report.canaryRead,
      report.kind !== 'restricted',
      `${report.kind} read scope`,
    );
    assert.equal(
      report.questionDenied,
      true,
      `${report.kind} unattended question denial`,
    );
    if (report.kind === 'restricted') {
      const allowed = new Set([
        'probe_hold',
        'request_user_input',
        'skills.list',
        'skills.read',
      ]);
      const advertised = report.advertised.flatMap((tool) =>
        tool.tools
          ? tool.tools.map((name) => `${tool.name}.${name}`)
          : [tool.name],
      );
      assert(
        advertised.every((name) => allowed.has(name)),
        'restricted native tool surface changed',
      );
    }
  }
  process.stdout.write(`${JSON.stringify(reports)}\n`);
} finally {
  peerRelease();
  clearTimeout(deadline);
  try {
    await Promise.allSettled(handles.map((handle) => handle.unsubscribe()));
  } finally {
    await service.shutdown();
  }
  for (const socket of wss.clients) socket.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await makeWritable(temporary);
  await rm(temporary, { recursive: true, force: true });
}
