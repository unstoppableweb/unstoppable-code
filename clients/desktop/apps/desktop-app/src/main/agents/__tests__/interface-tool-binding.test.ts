import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { InterfaceToolRegistry } from '@canopy/core-runtime/node/client';
import { interfaceToolDescriptor } from '@canopy/protocol/canopy-core';
import type { AgentSession, AgentSessionOptions } from '../types';
import {
  buildSessionKey,
  destroyAllSessions,
  getOrCreateSession,
  getSessionChangedOptions,
  registerSession,
} from '../session-manager';
import { runInAgentWorker } from '../../agent-runs/agent-worker-context';
import {
  resolveSessionInterfaceTools,
  setSessionInterfaceToolRegistry,
} from '../interface-tool-binding';
import { windowAgentInterfacePort } from '../agent-interface-port';
import { sendToWindow } from '../../lib/window-send';
import {
  INGESTION_LAG_EVENT_TYPE,
  IPC_CHANNELS,
  PROMPT_SUGGESTION_EVENT_TYPE,
  type ChatIngestionLagEventData,
  type PlanExitRequestEvent,
  type PromptSuggestionEventData,
} from '@canopy/desktop-shared/types';

jest.mock('../../lib/window-send', () => ({
  ...jest.requireActual<Record<string, unknown>>('../../lib/window-send'),
  sendToWindow: jest.fn(),
}));

jest.mock('../claude-session', () => ({
  ClaudeCodeProvider: class {
    createSession = (opts: AgentSessionOptions): Partial<AgentSession> => {
      const session: Partial<AgentSession> = {
        isDisposed: (): boolean => false,
        destroy: (): Promise<void> => Promise.resolve(),
        setApprovalMode: (): Promise<void> => Promise.resolve(),
      };
      registerSession(
        buildSessionKey(opts.projectId, opts.worktreeId, opts.chatId),
        session as AgentSession,
        new AbortController(),
        'claude',
        opts.model,
        opts.assistantMode,
      );
      return session;
    };
  },
}));

const options: AgentSessionOptions = {
  cwd: '/tmp/canopy-interface-tools',
  projectId: 'ws',
  worktreeId: 'wt',
  chatId: 'chat',
  planMode: false,
  providerType: 'claude',
  executionHarness: 'claude',
};

function mainWindowLease(): InterfaceToolRegistry {
  const registry = new InterfaceToolRegistry();
  registry.openLease(
    { leaseId: 'main-1', surface: 'main', interfaceKind: 'desktop' },
    { deliver: () => true, cancel: () => undefined },
  );
  registry.register('main-1', {
    tools: [interfaceToolDescriptor('ui.show_files')],
    _meta: { idempotencyKey: 'main-tools' },
  });
  setSessionInterfaceToolRegistry(registry);
  return registry;
}

afterEach(async () => {
  setSessionInterfaceToolRegistry(null);
  await destroyAllSessions();
});

describe('session interface tool binding (CAN-4131)', () => {
  it('resolveSessionInterfaceTools follows the registry', () => {
    expect(resolveSessionInterfaceTools({})).toEqual([]);
    const registry = mainWindowLease();
    expect(resolveSessionInterfaceTools({})).toEqual(['ui.show_files']);
    expect(
      resolveSessionInterfaceTools({ assistantMode: 'pipeline-editor' }),
    ).toEqual([]);
    expect(
      resolveSessionInterfaceTools({ assistantMode: 'app-advisor' }),
    ).toEqual(['ui.show_files']);
    registry.endLease('main-1');
    expect(resolveSessionInterfaceTools({})).toEqual([]);
  });

  it('a session bound with ShowFiles is replaced at the next turn after the lease ends', async () => {
    const registry = mainWindowLease();
    await runInAgentWorker({ kind: 'turn', runId: 'r' }, () =>
      getOrCreateSession(
        options,
        () => undefined,
        windowAgentInterfacePort(() => null),
      ),
    );
    await expect(getSessionChangedOptions(options)).resolves.not.toContain(
      'interfaceTools',
    );
    registry.endLease('main-1');
    await expect(getSessionChangedOptions(options)).resolves.toContain(
      'interfaceTools',
    );
  });
});

describe('agent interface port over the main window (CAN-6995)', () => {
  it('sends transient events on chat:event and the plan exit on plan:exit-request', () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const port = windowAgentInterfacePort(() => null);
    const target = { projectId: 'ws', worktreeId: 'wt', chatId: 'chat' };
    const suggestion: PromptSuggestionEventData = {
      type: PROMPT_SUGGESTION_EVENT_TYPE,
      text: 'Run the tests',
      turnUserMessageId: 'user-1',
    };
    const lag: ChatIngestionLagEventData = {
      type: INGESTION_LAG_EVENT_TYPE,
      lag: null,
    };
    const planExit: PlanExitRequestEvent = {
      requestId: 'plan-1',
      ...target,
      toolInput: {},
    };
    port.publishPromptSuggestion(target, suggestion);
    port.publishIngestionLag(target, lag);
    port.presentPlanExit(planExit);
    expect(send.mock.calls).toEqual([
      [null, IPC_CHANNELS.chatEvent, { ...target, data: suggestion }],
      [null, IPC_CHANNELS.chatEvent, { ...target, data: lag }],
      [null, IPC_CHANNELS.planExitRequest, planExit],
    ]);
  });

  it('sends a delegate live frame on chat:event with the payload the delegation service sent itself', () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const port = windowAgentInterfacePort(() => null);
    // A delegation root's target can carry more than the chat address; only
    // the address goes out, in the order the service wrote it.
    const target = {
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      surface: 'worktree-chat',
    };
    const live = {
      type: 'canopy_delegation',
      delegation: { delegationId: 'd-1', runGeneration: 1, sequence: 3 },
      canopy_turn_user_message_id: 'user-1',
      delivery: 'live',
      liveClass: 'essential' as const,
    };
    port.publishDelegationLive(target, live);
    const expected = (data: Record<string, unknown>): string =>
      JSON.stringify({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        data,
      });
    expect(
      send.mock.calls.map(([window, channel]) => [window, channel]),
    ).toEqual([[null, IPC_CHANNELS.chatEvent]]);
    expect(
      send.mock.calls.map(([, , payload]) => JSON.stringify(payload)),
    ).toEqual([expected(live)]);
    expect(send.mock.calls[0]?.[2]).toEqual({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      data: live,
    });
  });

  async function proposeOpenCodePlan(applied: boolean): Promise<{
    committed: PlanExitRequestEvent[];
    presented: PlanExitRequestEvent[];
  }> {
    const committed: PlanExitRequestEvent[] = [];
    const presented: PlanExitRequestEvent[] = [];
    await jest.isolateModulesAsync(async () => {
      jest.doMock('../../lib/workspace-registry', () => ({
        isCoworkWorkspace: (): boolean => false,
      }));
      jest.doMock('../../canopy-runtime/plan-host-writers', () => ({
        planModeTrackedPlans: {
          createTrackedPlan: (): Promise<unknown> =>
            Promise.resolve({ id: 'plan-1', latestRevisionNumber: 1 }),
          updateTrackedPlan: (): Promise<unknown> => Promise.resolve(null),
        },
      }));
      jest.doMock('../../lib/plan-system-instructions', () => ({
        buildPlanFileSystemInstruction: (): Promise<null> =>
          Promise.resolve(null),
      }));
      jest.doMock('../../services/attention-tracker', () => ({
        getAttentionTracker: (): { mark: () => void } => ({
          mark: (): void => undefined,
        }),
      }));
      jest.doMock('../../services/chat-state-service', () => ({
        getChatStateService: (): Record<string, unknown> => ({
          getState: (): Promise<unknown> =>
            Promise.resolve({
              tabsFile: { tabs: [{ id: 'chat', planMode: true }] },
            }),
          commitPlanExit: (event: PlanExitRequestEvent): Promise<boolean> => {
            committed.push(event);
            return Promise.resolve(applied);
          },
        }),
      }));
      const { publishOpenCodePlanProposal } =
        await import('../../services/chat-state-plan-exit');
      await publishOpenCodePlanProposal({
        projectId: 'ws',
        worktreeId: 'wt',
        chatId: 'chat',
        plan: '1. Do it',
        userMessageId: 'user-1',
        isCurrent: () => true,
        presentPlanExit: (event): void => void presented.push(event),
      });
    });
    return { committed, presented };
  }

  it('presents the committed OpenCode plan proposal through the port, unchanged', async () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const { committed, presented } = await proposeOpenCodePlan(true);
    expect(committed).toHaveLength(1);
    expect(presented).toHaveLength(1);
    expect(presented[0]).toBe(committed[0]);
    expect(presented[0]).toMatchObject({
      projectId: 'ws',
      worktreeId: 'wt',
      chatId: 'chat',
      source: 'opencode',
      reviewMode: 'proposal',
      planId: 'plan-1',
      revisionNumber: 1,
      toolInput: { plan: '1. Do it', source: 'opencode' },
    });
    // The proposal itself sends nothing; the port does.
    expect(send).not.toHaveBeenCalled();
  });

  it('presents nothing when the OpenCode plan proposal was not committed', async () => {
    const { committed, presented } = await proposeOpenCodePlan(false);
    expect(committed).toHaveLength(1);
    expect(presented).toEqual([]);
  });

  it('the OpenCode plan proposal reaches no window itself', () => {
    for (const file of ['../../services/chat-state-plan-exit.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect({ file, windowSend: source.includes('lib/window-send') }).toEqual({
        file,
        windowSend: false,
      });
    }
  });
});

// CAN-6995 S3-2c-1 ratchet: what still reaches the window instead of the
// chat's interfaces. Every `legacyWindow()` call in desktop main (on
// `AgentInterfacePort` and `InterfaceToolRequests`) and every window send in
// the worktree-action files is listed with the slice that moves it. A new
// site fails; a site that goes leaves the list in the same change.
const MAIN_DIR = join(__dirname, '..', '..');

const WORKTREE_ACTION_FILES: ReadonlySet<string> = new Set([
  'canopy-tools/worktree-actions.ts',
  'canopy-tools/start-split-agent-runtime.ts',
  'canopy-tools/worktree-script-actions.ts',
  'lib/shared-plan-sync.ts',
]);

interface WindowSite {
  kind: 'legacyWindow' | 'send';
  file: string;
  method: string;
  /** The property or variable a `legacyWindow()` call fills, or a send's channel. */
  at: string;
  count: number;
  debt: string;
}

const MIKE_ROW = "S3-2c, after Mike's OK to re-key its census row";
const BROWSER = 'browser owner, after #6583 and #6741';

/** Only ever shrinks: a site that moves leaves this list in the same change. */
const WINDOW_SITES: readonly WindowSite[] = Object.freeze([
  ...(
    [
      ['agents/antigravity-session.ts', 'createSession', 'approvals (S3-2b)'],
      [
        'agents/claude-session.ts',
        '_runQuery',
        'approvals and questions (S3-2b), file-comment replies (S3-3), worktree actions (S3-2c)',
      ],
      ['agents/codex-session.ts', 'createSession', 'approvals (S3-2b)'],
      [
        'agents/codex-session.ts',
        '_runSession',
        'questions and secret requests (S3-2b, security), file-comment replies (S3-3), worktree actions (S3-2c)',
      ],
      [
        'agents/copilot-session.ts',
        'createSession',
        'approvals and questions (S3-2b)',
      ],
      ['agents/cursor-session.ts', 'createSession', 'approvals (S3-2b)'],
      ['agents/opencode-session.ts', 'createSession', 'approvals (S3-2b)'],
    ] as const
  ).map(
    ([file, method, debt]): WindowSite => ({
      kind: 'legacyWindow',
      file,
      method,
      at: 'getWindow',
      count: 1,
      debt,
    }),
  ),
  {
    kind: 'legacyWindow',
    file: 'agents/delegation/service.ts',
    method: 'actorFor',
    at: 'getWindow',
    count: 2,
    debt: "a delegate's approvals (S3-2b)",
  },
  {
    kind: 'legacyWindow',
    file: 'agents/delegation/service.ts',
    method: 'publishDetached',
    at: '',
    count: 1,
    debt: "a delegate's detached transcript update (S3-3, after Mike's OK on its census row)",
  },
  {
    kind: 'legacyWindow',
    file: 'mcp/canopy-tool-router.ts',
    method: 'createToolRuntime',
    at: 'getWindow',
    count: 3,
    debt: 'secret requests (S3-2b, security), file-comment replies (S3-3), worktree actions (S3-2c)',
  },
  ...(
    [
      [
        'canopy-tools/start-split-agent-runtime.ts',
        'startSplitAgent',
        'IPC_CHANNELS.worktreeGitReady',
        1,
        MIKE_ROW,
      ],
      [
        'canopy-tools/start-split-agent-runtime.ts',
        'startSplitAgent',
        'IPC_CHANNELS.worktreeGitFailed',
        1,
        MIKE_ROW,
      ],
      [
        'canopy-tools/start-split-agent-runtime.ts',
        'startSplitAgent',
        'IPC_CHANNELS.worktreeNeedsRepair',
        1,
        MIKE_ROW,
      ],
      [
        'canopy-tools/start-split-agent-runtime.ts',
        'startSplitAgent',
        'IPC_CHANNELS.workspaceWorktreesUpdated',
        1,
        MIKE_ROW,
      ],
      [
        'canopy-tools/worktree-actions.ts',
        'setHookPaused',
        'IPC_CHANNELS.workspaceWorktreesUpdated',
        1,
        MIKE_ROW,
      ],
      [
        'canopy-tools/worktree-actions.ts',
        'importTrackedPlanAction',
        'IPC_CHANNELS.trackedPlansUpdated',
        1,
        MIKE_ROW,
      ],
      [
        'canopy-tools/worktree-actions.ts',
        'browserOpen',
        'IPC_CHANNELS.browserEvent',
        4,
        BROWSER,
      ],
      [
        'canopy-tools/worktree-actions.ts',
        'dispatchScopedBrowserAction',
        'IPC_CHANNELS.browserEvent',
        1,
        BROWSER,
      ],
      [
        'canopy-tools/worktree-script-actions.ts',
        'rendererForwarder',
        'channel',
        1,
        MIKE_ROW,
      ],
      [
        'lib/shared-plan-sync.ts',
        'emitPlanUpdated',
        'IPC_CHANNELS.trackedPlansUpdated',
        1,
        MIKE_ROW,
      ],
    ] as const
  ).map(
    ([file, method, at, count, debt]): WindowSite => ({
      kind: 'send',
      file,
      method,
      at,
      count,
      debt,
    }),
  ),
]);

interface FoundSite {
  kind: WindowSite['kind'];
  file: string;
  line: number;
  method: string;
  at: string;
}

function mainSources(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === '__scratch__') continue;
      out.push(...mainSources(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push({
        file: relative(MAIN_DIR, path).split(sep).join('/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  }
  return out;
}

function declaredName(node: ts.Node): string | undefined {
  if (
    (ts.isPropertyAssignment(node) ||
      ts.isVariableDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node)) &&
    node.name &&
    (ts.isIdentifier(node.name) || ts.isPrivateIdentifier(node.name))
  )
    return node.name.text;
  return undefined;
}

function enclosing(node: ts.Node): { method: string; holder: string } {
  let method: string | undefined;
  let holder: string | undefined;
  for (let at = node.parent; at; at = at.parent) {
    if (
      holder === undefined &&
      (ts.isPropertyAssignment(at) ||
        ts.isVariableDeclaration(at) ||
        ts.isPropertyDeclaration(at))
    )
      holder = declaredName(at);
    if (ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) {
      method = declaredName(at);
      break;
    }
  }
  return { method: method ?? '<module>', holder: holder ?? '' };
}

/** The window-send helpers in lib/window-send.ts and the browser module, with the index of their channel argument. */
const WINDOW_SEND_HELPERS: ReadonlyMap<string, number> = new Map([
  ['sendToWindow', 1],
  ['sendToWindowDetailed', 1],
  ['sendToAllWindows', 0],
  ['sendToWebContents', 1],
]);

/**
 * The channel a call sends on, when the call reaches the window: a send
 * helper, by name or as a member, or `send` / `postMessage` on any
 * `webContents`, optional chaining included.
 */
function windowSendChannel(
  node: ts.CallExpression,
  source: ts.SourceFile,
): string | undefined {
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  if (name === undefined) return undefined;
  const helperChannel = WINDOW_SEND_HELPERS.get(name);
  if (helperChannel !== undefined)
    return node.arguments[helperChannel]?.getText(source) ?? '';
  if (
    (name === 'send' || name === 'postMessage') &&
    ts.isPropertyAccessExpression(callee)
  ) {
    const receiver = callee.expression;
    const receiverName = ts.isIdentifier(receiver)
      ? receiver.text
      : ts.isPropertyAccessExpression(receiver)
        ? receiver.name.text
        : undefined;
    if (receiverName === 'webContents')
      return node.arguments[0]?.getText(source) ?? '';
  }
  return undefined;
}

function findWindowSites(
  sources: readonly { file: string; text: string }[],
): FoundSite[] {
  const found: FoundSite[] = [];
  for (const { file, text } of sources) {
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const line =
          source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const callee = node.expression;
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'legacyWindow'
        ) {
          const { method, holder } = enclosing(node);
          found.push({ kind: 'legacyWindow', file, line, method, at: holder });
        } else if (WORKTREE_ACTION_FILES.has(file)) {
          const channel = windowSendChannel(node, source);
          if (channel !== undefined) {
            const { method } = enclosing(node);
            found.push({ kind: 'send', file, line, method, at: channel });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

function windowSiteProblems(
  found: readonly FoundSite[],
  allowed: readonly WindowSite[],
): string[] {
  const problems: string[] = [];
  const same = (a: FoundSite, b: WindowSite): boolean =>
    a.kind === b.kind &&
    a.file === b.file &&
    a.method === b.method &&
    a.at === b.at;
  for (const site of found) {
    if (!allowed.some((entry) => same(site, entry)))
      problems.push(
        site.kind === 'legacyWindow'
          ? `main/${site.file}:${site.line}: a new legacyWindow() call in ${site.method}. The window shim takes no new callers; present through a typed AgentInterfacePort member instead (CAN-6995).`
          : `main/${site.file}:${site.line}: a new window send on ${site.at} in ${site.method}. Worktree actions present through the chat's AgentInterfacePort, not the window (CAN-6995).`,
      );
  }
  for (const entry of allowed) {
    const matching = found.filter((site) => same(site, entry));
    if (matching.length > entry.count)
      problems.push(
        `main/${entry.file} ${entry.method}: ${matching.length} ${entry.kind} sites on ${entry.at || 'its return'} exceed the ${entry.count} listed (${entry.debt}). The list only shrinks.`,
      );
    else if (matching.length < entry.count)
      problems.push(
        `main/${entry.file} ${entry.method}: ${entry.count} ${entry.kind} sites on ${entry.at || 'its return'} are listed but ${matching.length} remain. Lower the count to ${matching.length} in this change.`,
      );
  }
  return problems;
}

describe('what still reaches the window instead of the agent interface port (CAN-6995 ratchet)', () => {
  it('finds exactly the listed legacyWindow() calls and worktree-action window sends', () => {
    const found = findWindowSites(mainSources(MAIN_DIR));
    expect(windowSiteProblems(found, WINDOW_SITES)).toEqual([]);
    expect(found).toHaveLength(
      WINDOW_SITES.reduce((total, entry) => total + entry.count, 0),
    );
  });

  it('fails on a new legacyWindow() call or a new worktree-action window send, naming the file and line', () => {
    const extraCaller = [
      'export function present(interfacePort: any): void {',
      '  const window = interfacePort.legacyWindow();',
      '  void window;',
      '}',
    ].join('\n');
    const extraSend = [
      'declare function sendToWindow(window: unknown, channel: string, payload: unknown): void;',
      'declare const IPC_CHANNELS: Record<string, string>;',
      'export function notify(runtime: any): void {',
      '  sendToWindow(runtime.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {});',
      '}',
    ].join('\n');
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'lib/shared-plan-sync.ts'
        ? { ...source, text: `${source.text}\n${extraSend}\n` }
        : source,
    );
    const problems = windowSiteProblems(
      findWindowSites([
        ...sources,
        { file: 'agents/scratch-session.ts', text: extraCaller },
      ]),
      WINDOW_SITES,
    );
    expect(problems).toEqual([
      expect.stringContaining('main/lib/shared-plan-sync.ts:'),
      expect.stringContaining(
        'main/agents/scratch-session.ts:2: a new legacyWindow() call in present.',
      ),
    ]);
    expect(problems[0]).toContain(
      'a new window send on IPC_CHANNELS.trackedPlansUpdated in notify.',
    );
  });

  it('fails on every way a worktree action can send to the window, not only sendToWindow', () => {
    const extraSends = [
      'declare const IPC_CHANNELS: Record<string, string>;',
      'declare const windowSend: any;',
      'export function viaHelpers(runtime: any, webContents: any): void {',
      '  sendToWindowDetailed(runtime.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {});',
      '  sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {});',
      '  sendToWebContents(webContents, IPC_CHANNELS.browserEvent, {});',
      '  windowSend.sendToWindow(runtime.getWindow(), IPC_CHANNELS.scriptOutput, {});',
      '}',
      'export function viaWebContents(runtime: any, win: any): void {',
      '  runtime.getWindow()?.webContents.send(IPC_CHANNELS.worktreeGitReady, {});',
      '  win.webContents?.send(IPC_CHANNELS.worktreeGitFailed, {});',
      '  win.webContents.postMessage(IPC_CHANNELS.worktreeNeedsRepair, {});',
      '}',
    ].join('\n');
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'canopy-tools/worktree-script-actions.ts'
        ? { ...source, text: `${source.text}\n${extraSends}\n` }
        : source,
    );
    const problems = windowSiteProblems(findWindowSites(sources), WINDOW_SITES);
    expect(problems.map((problem) => problem.replace(/:\d+:/, ':N:'))).toEqual(
      [
        ['IPC_CHANNELS.trackedPlansUpdated', 'viaHelpers'],
        ['IPC_CHANNELS.workspaceWorktreesUpdated', 'viaHelpers'],
        ['IPC_CHANNELS.browserEvent', 'viaHelpers'],
        ['IPC_CHANNELS.scriptOutput', 'viaHelpers'],
        ['IPC_CHANNELS.worktreeGitReady', 'viaWebContents'],
        ['IPC_CHANNELS.worktreeGitFailed', 'viaWebContents'],
        ['IPC_CHANNELS.worktreeNeedsRepair', 'viaWebContents'],
      ].map(
        ([channel, method]): string =>
          `main/canopy-tools/worktree-script-actions.ts:N: a new window send on ${channel} in ${method}. Worktree actions present through the chat's AgentInterfacePort, not the window (CAN-6995).`,
      ),
    );
  });

  it('fails when a listed site goes but the list keeps it, until the count drops', () => {
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'agents/cursor-session.ts'
        ? {
            ...source,
            text: source.text.replace('interfacePort.legacyWindow()', 'null'),
          }
        : source,
    );
    const found = findWindowSites(sources);
    expect(windowSiteProblems(found, WINDOW_SITES)).toEqual([
      expect.stringContaining(
        'main/agents/cursor-session.ts createSession: 1 legacyWindow sites on getWindow are listed but 0 remain.',
      ),
    ]);
    expect(
      windowSiteProblems(
        found,
        WINDOW_SITES.filter(
          (entry) => entry.file !== 'agents/cursor-session.ts',
        ),
      ),
    ).toEqual([]);
  });
});
