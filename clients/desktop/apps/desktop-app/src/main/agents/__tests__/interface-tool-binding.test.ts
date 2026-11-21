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
  type WorktreeData,
  type WorktreeGitFailedEvent,
  type WorktreeGitReadyEvent,
  type WorktreeNeedsRepairEvent,
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

  it('sends each worktree-action notice on its channel with the payload its caller sent itself', () => {
    const send = jest.mocked(sendToWindow);
    send.mockClear();
    const port = windowAgentInterfacePort(() => null);
    const ready: WorktreeGitReadyEvent = {
      projectId: 'ws',
      worktreeId: 'wt-new',
      branchName: 'agent/continue',
    };
    const failed: WorktreeGitFailedEvent = {
      projectId: 'ws',
      worktreeId: 'wt-new',
      error: 'git failed',
    };
    const repair: WorktreeNeedsRepairEvent = {
      projectId: 'ws',
      worktreeId: 'wt-new',
      branchName: 'agent/continue',
      repairIssues: [],
    };
    const worktree: WorktreeData = {
      id: 'wt-new',
      branchName: 'agent/continue',
      createdAt: '2026-11-20T00:00:00.000Z',
    };
    port.publishWorktreeGitReady(ready);
    port.publishWorktreeGitFailed(failed);
    port.publishWorktreeNeedsRepair(repair);
    port.publishWorkspaceWorktrees('ws', [worktree]);
    port.publishHookPauseChanged('ws', worktree);
    port.publishHookPauseChanged('ws', undefined);
    expect(
      send.mock.calls.map(([window, channel]) => [window, channel]),
    ).toEqual([
      [null, IPC_CHANNELS.worktreeGitReady],
      [null, IPC_CHANNELS.worktreeGitFailed],
      [null, IPC_CHANNELS.worktreeNeedsRepair],
      [null, IPC_CHANNELS.workspaceWorktreesUpdated],
      [null, IPC_CHANNELS.workspaceWorktreesUpdated],
      [null, IPC_CHANNELS.workspaceWorktreesUpdated],
    ]);
    // The setup events pass through as the same objects; the others are the
    // bytes each caller built: start-split's { workspaceId, worktrees } and
    // setHookPaused's { workspaceId, worktree? }, with no worktree key when it
    // has none.
    expect(send.mock.calls[0]?.[2]).toBe(ready);
    expect(send.mock.calls[1]?.[2]).toBe(failed);
    expect(send.mock.calls[2]?.[2]).toBe(repair);
    expect(
      send.mock.calls.slice(3).map(([, , payload]) => JSON.stringify(payload)),
    ).toEqual([
      JSON.stringify({ workspaceId: 'ws', worktrees: [worktree] }),
      JSON.stringify({ workspaceId: 'ws', worktree }),
      JSON.stringify({ workspaceId: 'ws' }),
    ]);
    expect(send.mock.calls[5]?.[2]).not.toHaveProperty('worktree');
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
  kind: 'legacyWindow' | 'send' | 'hold';
  file: string;
  method: string;
  /**
   * The property or variable a `legacyWindow()` call fills, a send's
   * channel, or what a hold keeps (`webContents` or a send helper).
   */
  at: string;
  count: number;
  debt: string;
}

const PLAN_IMPORT =
  "S3-2c, after Mike's say: the move takes its row out of his Phase 3 'plans' exclusion";
const SCRIPT_EVENTS =
  "S3-2c, after Mike's say on how the worktree script push moves";
const SHARED_PLAN =
  'S3-2c, after #9423, which rewrites this send, merges or closes';
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
        'canopy-tools/worktree-actions.ts',
        'importTrackedPlanAction',
        'IPC_CHANNELS.trackedPlansUpdated',
        1,
        PLAN_IMPORT,
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
        SCRIPT_EVENTS,
      ],
      [
        'lib/shared-plan-sync.ts',
        'emitPlanUpdated',
        'IPC_CHANNELS.trackedPlansUpdated',
        1,
        SHARED_PLAN,
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
  {
    kind: 'hold',
    file: 'canopy-tools/worktree-actions.ts',
    method: 'dispatchWorktreeAction',
    at: 'webContents',
    count: 4,
    debt: `the browser handoff's focus checks (${BROWSER})`,
  },
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
 * The send helpers a file imports under another name, by local name:
 * `import { sendToWindow as send }` makes `send` mean `sendToWindow`.
 */
function helperAliases(source: ts.SourceFile): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of source.statements) {
    const bindings = ts.isImportDeclaration(statement)
      ? statement.importClause?.namedBindings
      : undefined;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const specifier of bindings.elements) {
      const imported = specifier.propertyName?.text;
      if (imported !== undefined && WINDOW_SEND_HELPERS.has(imported))
        aliases.set(specifier.name.text, imported);
    }
  }
  return aliases;
}

/**
 * A destructuring key's name, however it is spelled: `webContents`,
 * `'webContents'`, `"webContents"`, `['webContents']` or `` [`webContents`] ``.
 */
function bindingKeyName(key: ts.Node): string | undefined {
  if (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) return key.text;
  if (ts.isComputedPropertyName(key) && ts.isStringLiteralLike(key.expression))
    return key.expression.text;
  return undefined;
}

/** A member's name, whether read as `.name` or as a string-literal `['name']`. */
function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression)
  )
    return node.argumentExpression.text;
  return undefined;
}

/**
 * The channel a call sends on, when the call reaches the window: a send
 * helper, by name or as a member, or `send` / `postMessage` on any
 * `webContents`, optional chaining included.
 */
function windowSendChannel(
  node: ts.CallExpression,
  source: ts.SourceFile,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  const callee = node.expression;
  const name = ts.isIdentifier(callee)
    ? (aliases.get(callee.text) ?? callee.text)
    : memberName(callee);
  if (name === undefined) return undefined;
  const helperChannel = WINDOW_SEND_HELPERS.get(name);
  if (helperChannel !== undefined)
    return node.arguments[helperChannel]?.getText(source) ?? '';
  if (
    (name === 'send' || name === 'postMessage') &&
    (ts.isPropertyAccessExpression(callee) ||
      ts.isElementAccessExpression(callee))
  ) {
    const receiver = callee.expression;
    const receiverName = ts.isIdentifier(receiver)
      ? receiver.text
      : memberName(receiver);
    if (receiverName === 'webContents')
      return node.arguments[0]?.getText(source) ?? '';
  }
  return undefined;
}

/**
 * What a non-call node in a worktree-action file keeps of the window: a
 * `webContents` access (unless it is the receiver of a send counted above),
 * a destructured `webContents`, or a send helper taken as a value. Holding
 * either is how an alias would reach the window unseen.
 */
function windowHold(
  node: ts.Node,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  const calledAs = (expression: ts.Node): boolean =>
    ts.isCallExpression(expression.parent) &&
    expression.parent.expression === expression;
  const name = memberName(node);
  if (name === 'webContents') {
    const outer = node.parent;
    const outerName = memberName(outer);
    const sends =
      (ts.isPropertyAccessExpression(outer) ||
        ts.isElementAccessExpression(outer)) &&
      outer.expression === node &&
      (outerName === 'send' || outerName === 'postMessage') &&
      calledAs(outer);
    return sends ? undefined : 'webContents';
  }
  if (
    name !== undefined &&
    ts.isElementAccessExpression(node) &&
    WINDOW_SEND_HELPERS.has(name)
  )
    return calledAs(node) ? undefined : name;
  if (
    ts.isBindingElement(node) &&
    bindingKeyName(node.propertyName ?? node.name) === 'webContents'
  )
    return 'webContents';
  const helper = ts.isIdentifier(node)
    ? (aliases.get(node.text) ?? node.text)
    : undefined;
  if (helper !== undefined && WINDOW_SEND_HELPERS.has(helper)) {
    const parent = node.parent;
    if (
      ts.isImportSpecifier(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isTypeQueryNode(parent)
    )
      return undefined;
    const reference =
      ts.isPropertyAccessExpression(parent) && parent.name === node
        ? parent
        : node;
    return calledAs(reference) ? undefined : helper;
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
    const aliases = helperAliases(source);
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
          const channel = windowSendChannel(node, source, aliases);
          if (channel !== undefined) {
            const { method } = enclosing(node);
            found.push({ kind: 'send', file, line, method, at: channel });
          }
        }
      }
      if (WORKTREE_ACTION_FILES.has(file)) {
        const hold = windowHold(node, aliases);
        if (hold !== undefined) {
          const line =
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1;
          const { method } = enclosing(node);
          found.push({ kind: 'hold', file, line, method, at: hold });
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
          : site.kind === 'send'
            ? `main/${site.file}:${site.line}: a new window send on ${site.at} in ${site.method}. Worktree actions present through the chat's AgentInterfacePort, not the window (CAN-6995).`
            : `main/${site.file}:${site.line}: a new hold on ${site.at} in ${site.method}. Worktree actions present through the chat's AgentInterfacePort; don't keep the window or a send helper (CAN-6995).`,
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

  it('fails where a worktree action takes hold of the window or a send helper, so an alias cannot slip past', () => {
    const extraHandles = [
      'declare const IPC_CHANNELS: Record<string, string>;',
      'declare const windowSend: any;',
      'export function viaAliases(runtime: any, win: any): void {',
      '  const wc = win.webContents;',
      '  wc.send(IPC_CHANNELS.scriptOutput, {});',
      '  const { webContents: contents } = runtime.getWindow();',
      '  contents.send(IPC_CHANNELS.scriptOutput, {});',
      '  const send = sendToWindow;',
      '  send(runtime.getWindow(), IPC_CHANNELS.scriptOutput, {});',
      '  const forward = windowSend.sendToAllWindows;',
      '  forward(IPC_CHANNELS.scriptOutput, {});',
      '}',
    ].join('\n');
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'canopy-tools/worktree-script-actions.ts'
        ? { ...source, text: `${source.text}\n${extraHandles}\n` }
        : source,
    );
    const problems = windowSiteProblems(findWindowSites(sources), WINDOW_SITES);
    expect(problems.map((problem) => problem.replace(/:\d+:/, ':N:'))).toEqual(
      ['webContents', 'webContents', 'sendToWindow', 'sendToAllWindows'].map(
        (handle): string =>
          `main/canopy-tools/worktree-script-actions.ts:N: a new hold on ${handle} in viaAliases. Worktree actions present through the chat's AgentInterfacePort; don't keep the window or a send helper (CAN-6995).`,
      ),
    );
  });

  it('fails on the same sends and holds spelled with bracket access', () => {
    const extraBrackets = [
      'declare const IPC_CHANNELS: Record<string, string>;',
      'declare const windowSend: any;',
      'export function viaBrackets(runtime: any, win: any): void {',
      "  win['webContents'].send(IPC_CHANNELS.worktreeGitReady, {});",
      "  const wc = win['webContents'];",
      "  windowSend['sendToWindowDetailed'](runtime.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {});",
      "  const forward = windowSend['sendToAllWindows'];",
      "  win.webContents['postMessage'](IPC_CHANNELS.worktreeNeedsRepair, {});",
      '}',
    ].join('\n');
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'canopy-tools/worktree-script-actions.ts'
        ? { ...source, text: `${source.text}\n${extraBrackets}\n` }
        : source,
    );
    const problems = windowSiteProblems(findWindowSites(sources), WINDOW_SITES);
    const at = 'main/canopy-tools/worktree-script-actions.ts:N:';
    const send = (channel: string): string =>
      `${at} a new window send on ${channel} in viaBrackets. Worktree actions present through the chat's AgentInterfacePort, not the window (CAN-6995).`;
    const hold = (handle: string): string =>
      `${at} a new hold on ${handle} in viaBrackets. Worktree actions present through the chat's AgentInterfacePort; don't keep the window or a send helper (CAN-6995).`;
    expect(problems.map((problem) => problem.replace(/:\d+:/, ':N:'))).toEqual([
      send('IPC_CHANNELS.worktreeGitReady'),
      hold('webContents'),
      send('IPC_CHANNELS.trackedPlansUpdated'),
      hold('sendToAllWindows'),
      send('IPC_CHANNELS.worktreeNeedsRepair'),
    ]);
  });

  it('fails on a destructured webContents under a quoted, bracketed or template key', () => {
    const extraKeys = [
      'declare const IPC_CHANNELS: Record<string, string>;',
      'export function viaQuotedKeys(win: any): void {',
      "  const { 'webContents': single } = win;",
      '  single.send(IPC_CHANNELS.scriptOutput, {});',
      '  const { "webContents": double } = win;',
      '  double.send(IPC_CHANNELS.scriptOutput, {});',
      "  const { ['webContents']: bracketed } = win;",
      '  bracketed.send(IPC_CHANNELS.scriptOutput, {});',
      '  const { [`webContents`]: template } = win;',
      '  template.send(IPC_CHANNELS.scriptOutput, {});',
      '}',
    ].join('\n');
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'canopy-tools/worktree-script-actions.ts'
        ? { ...source, text: `${source.text}\n${extraKeys}\n` }
        : source,
    );
    const problems = windowSiteProblems(findWindowSites(sources), WINDOW_SITES);
    expect(problems.map((problem) => problem.replace(/:\d+:/, ':N:'))).toEqual(
      Array<string>(4).fill(
        "main/canopy-tools/worktree-script-actions.ts:N: a new hold on webContents in viaQuotedKeys. Worktree actions present through the chat's AgentInterfacePort; don't keep the window or a send helper (CAN-6995).",
      ),
    );
  });

  it('fails on a send helper reached through an import alias, a namespace import or a variable', () => {
    const extraImports = [
      "import { sendToWindow as send, sendToAllWindows as broadcast } from '../lib/window-send';",
      "import * as ws from '../lib/window-send';",
      'declare const IPC_CHANNELS: Record<string, string>;',
      'export function viaImports(runtime: any): void {',
      '  send(runtime.getWindow(), IPC_CHANNELS.worktreeGitReady, {});',
      '  broadcast(IPC_CHANNELS.workspaceWorktreesUpdated, {});',
      '  ws.sendToWindow(runtime.getWindow(), IPC_CHANNELS.trackedPlansUpdated, {});',
      '  const s = sendToWindow;',
      '  s(runtime.getWindow(), IPC_CHANNELS.scriptOutput, {});',
      '  const again = send;',
      '  const viaNamespace = ws.sendToWindowDetailed;',
      '}',
    ].join('\n');
    const sources = mainSources(MAIN_DIR).map((source) =>
      source.file === 'canopy-tools/worktree-script-actions.ts'
        ? { ...source, text: `${source.text}\n${extraImports}\n` }
        : source,
    );
    const problems = windowSiteProblems(findWindowSites(sources), WINDOW_SITES);
    const at = 'main/canopy-tools/worktree-script-actions.ts:N:';
    const send = (channel: string): string =>
      `${at} a new window send on ${channel} in viaImports. Worktree actions present through the chat's AgentInterfacePort, not the window (CAN-6995).`;
    const hold = (handle: string): string =>
      `${at} a new hold on ${handle} in viaImports. Worktree actions present through the chat's AgentInterfacePort; don't keep the window or a send helper (CAN-6995).`;
    expect(problems.map((problem) => problem.replace(/:\d+:/, ':N:'))).toEqual([
      send('IPC_CHANNELS.worktreeGitReady'),
      send('IPC_CHANNELS.workspaceWorktreesUpdated'),
      send('IPC_CHANNELS.trackedPlansUpdated'),
      hold('sendToWindow'),
      hold('sendToWindow'),
      hold('sendToWindowDetailed'),
    ]);
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
