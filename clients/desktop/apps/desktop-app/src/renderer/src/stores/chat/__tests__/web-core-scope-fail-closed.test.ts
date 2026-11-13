/** @jest-environment jsdom */
/**
 * CAN-6175: a web core scope's chat backend refuses what its authority does
 * not serve yet with `capability_unavailable`. No chat store path may leave
 * that refusal as an unhandled rejection (Jest fails the test on one), and a
 * store action settles it itself unless every caller shows it as its own
 * error. Other failures are still logged as an unhandled rejection was.
 */
// eslint-disable-next-line no-restricted-imports
import { readdirSync, readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import path from 'node:path';
import ts from 'typescript';
import { DEFAULT_MODEL } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { createEmptyTab } from '../tab-utils';
import { isCapabilityUnavailable, reportUnlessUnavailable } from '../backend';

const STORE_DIR = path.join(__dirname, '..');
const PROJECT = 'web-core:ws-1';
const WORKTREE = 'web-core:task-1';
const CHAT = 'web-core:chat-1';
const TARGET = { projectId: PROJECT, worktreeId: WORKTREE, chatId: CHAT };

/** Actions whose every caller shows the refusal as its own error. */
const REFUSAL_SHOWN_BY_CALLER: ReadonlySet<string> = new Set([
  // ArchivedChatsControl's in-flight wrapper and the cost navigator.
  'restoreArchivedChat',
  'summarizeArchivedChat',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name.startsWith('__') ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The outermost expression of the call chain `node` starts. */
function chainTop(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    const parent = current.parent;
    if (
      (ts.isPropertyAccessExpression(parent) &&
        parent.expression === current) ||
      (ts.isCallExpression(parent) && parent.expression === current) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent)
    )
      current = parent;
    else return current;
  }
}

/** `.catch(h)`, or `.then(f, g)`, optionally followed by `.finally(...)`. */
function chainHandlesRejection(top: ts.Node): boolean {
  let call = top;
  for (;;) {
    while (ts.isParenthesizedExpression(call)) call = call.expression;
    if (
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression)
    )
      return false;
    const method = call.expression.name.text;
    if (method !== 'finally')
      return (
        method === 'catch' || (method === 'then' && call.arguments.length >= 2)
      );
    call = call.expression.expression;
  }
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | null {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (ts.isFunctionLike(parent)) return parent;
  return null;
}

function insideTryWithCatch(node: ts.Node, fn: ts.Node | null): boolean {
  for (
    let parent = node.parent;
    parent && parent !== fn;
    parent = parent.parent
  )
    if (
      ts.isTryStatement(parent) &&
      parent.catchClause !== undefined &&
      node.pos >= parent.tryBlock.pos &&
      node.end <= parent.tryBlock.end
    )
      return true;
  return false;
}

/**
 * Whether a rejection of `expr` reaches a statement nothing awaits without a
 * handler, following it through awaits and returns into async IIFEs and
 * callbacks. A rejection a named function or store action returns is its
 * caller's to handle; the store sweep below checks those.
 */
function reachesUnhandled(expr: ts.Node): boolean {
  const top = chainTop(expr);
  const parent = top.parent;
  if (chainHandlesRejection(top)) return false;
  if (ts.isVoidExpression(parent) || ts.isExpressionStatement(parent))
    return true;
  if (
    ts.isArrayLiteralExpression(parent) ||
    ts.isConditionalExpression(parent) ||
    ts.isBinaryExpression(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isCallExpression(parent)
  )
    return reachesUnhandled(parent);
  if (
    ts.isAwaitExpression(parent) ||
    ts.isReturnStatement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === top)
  ) {
    const fn = enclosingFunction(top);
    if (!fn || insideTryWithCatch(top, fn)) return false;
    const anonymous =
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      !ts.isPropertyAssignment(fn.parent) &&
      !ts.isVariableDeclaration(fn.parent);
    return anonymous && reachesUnhandled(fn);
  }
  return false;
}

function unhandledBackendRequests(): string[] {
  return sourceFiles(STORE_DIR).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    if (!text.includes('chatBackendFor(')) return [];
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'chatBackendFor' &&
        reachesUnhandled(node)
      ) {
        const { line } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        found.push(`${path.relative(STORE_DIR, file)}:${line + 1}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

/** Each store action's parameter names, from its declaration. */
function actionParameters(): Map<string, string[]> {
  const file = path.join(STORE_DIR, 'state.ts');
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const parameters = new Map<string, string[]>();
  const names = (list: ts.NodeArray<ts.ParameterDeclaration>): string[] =>
    list.map((parameter) => parameter.name.getText(source));
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertySignature(node) &&
      node.type !== undefined &&
      ts.isFunctionTypeNode(node.type)
    )
      parameters.set(node.name.getText(source), names(node.type.parameters));
    else if (ts.isMethodSignature(node))
      parameters.set(node.name.getText(source), names(node.parameters));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return parameters;
}

/** A web core scope's value for each parameter name; others are omitted. */
const ARGUMENTS: Readonly<Record<string, unknown>> = {
  target: TARGET,
  scope: { projectId: PROJECT, worktreeId: WORKTREE },
  event: { ...TARGET, requestId: 'request-1' },
  projectId: PROJECT,
  worktreeId: WORKTREE,
  chatId: CHAT,
  tabId: CHAT,
  sourceTabId: CHAT,
  fromTabId: CHAT,
  id: CHAT,
  requestId: 'request-1',
  userMessageId: 'message-1',
  index: 0,
  requestedIndex: 0,
  enabled: true,
  text: 'Edited',
  level: 'high',
  model: DEFAULT_MODEL,
  targetModel: DEFAULT_MODEL,
};

/** Local preload stubs: every call resolves, every subscription is inert. */
function inertApi(): unknown {
  const call = (): Promise<undefined> => Promise.resolve(undefined);
  const handler: ProxyHandler<typeof call> = {
    get: (_target, property) => {
      if (property === 'then') return undefined;
      if (typeof property === 'string' && property.startsWith('on'))
        return () => (): void => undefined;
      return new Proxy(call, handler);
    },
    apply: call,
  };
  return new Proxy(call, handler);
}

function seedWebCoreChat(): void {
  const tab = {
    ...createEmptyTab(),
    id: CHAT,
    planMode: true,
    editingQueuedMessageIndex: 0,
    queuedMessages: [
      {
        id: 'queued-1',
        text: 'Queued',
        hostQueueEntryId: 'entry-1',
        dispatchOptions: { acceptedInputId: 'accepted-1' },
      },
    ],
  };
  useChatStore.setState({
    selectedWorktree: { projectId: PROJECT, worktreeId: WORKTREE },
    worktreeChats: {
      [`${PROJECT}/${WORKTREE}`]: { tabs: [tab], activeTabId: CHAT },
    },
  } as never);
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('chat backend refusals for a web core scope (CAN-6175)', () => {
  beforeAll(() => {
    Object.assign(window, { api: inertApi() });
  });

  it('every backend request nothing awaits handles its rejection', () => {
    expect(unhandledBackendRequests()).toEqual([]);
  });

  it('drives every chat store action with a web core scope and leaks no refusal', async () => {
    const parameters = actionParameters();
    const store = useChatStore.getState() as unknown as Record<string, unknown>;
    const actions = Object.keys(store)
      .filter((name) => typeof store[name] === 'function')
      .sort();
    expect(actions.length).toBeGreaterThan(100);
    expect(actions.filter((name) => !parameters.has(name))).toEqual([]);

    const leaked: string[] = [];
    const shownByCaller: string[] = [];
    for (const name of actions) {
      seedWebCoreChat();
      const action = (
        useChatStore.getState() as unknown as Record<
          string,
          (...args: unknown[]) => unknown
        >
      )[name];
      const args = (parameters.get(name) ?? []).map((p) => ARGUMENTS[p]);
      let result: unknown;
      try {
        result = action(...args);
      } catch {
        continue;
      }
      if (result instanceof Promise)
        void result.catch((error: unknown) => {
          if (!isCapabilityUnavailable(error)) return;
          if (REFUSAL_SHOWN_BY_CALLER.has(name)) shownByCaller.push(name);
          else leaked.push(name);
        });
      // Any unhandled rejection while the action runs fails this test.
      await settle();
    }
    expect(leaked).toEqual([]);
    // These reject, so their callers show the refusal instead of a success.
    expect(shownByCaller.sort()).toEqual([...REFUSAL_SHOWN_BY_CALLER].sort());
  }, 120_000);

  it('drops only a typed refusal and logs any other failure as before', () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    reportUnlessUnavailable(
      Object.assign(new Error('Queued messages is not available.'), {
        code: 'capability_unavailable',
      }),
    );
    expect(consoleError).not.toHaveBeenCalled();
    // Message text alone is not a refusal.
    reportUnlessUnavailable(new Error('capability_unavailable'));
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toMatch(
      /^\[renderer\] Unhandled renderer promise rejection .*capability_unavailable/,
    );
    consoleError.mockRestore();
  });

  it('a local chat whose queued message cancel fails still logs it', async () => {
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const failure = new Error('The host queue is gone.');
    const cancelQueuedMessage = jest.fn(() => Promise.reject(failure));
    const previous = window.api;
    Object.assign(window, {
      api: { ...previous, chat: { ...previous.chat, cancelQueuedMessage } },
    });
    const local = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const tab = {
      ...createEmptyTab(),
      id: 'chat-1',
      queuedMessages: [
        { id: 'queued-1', text: 'Queued', hostQueueEntryId: 'entry-1' },
      ],
    };
    useChatStore.setState({
      selectedWorktree: local,
      worktreeChats: {
        'project-1/worktree-1': { tabs: [tab], activeTabId: 'chat-1' },
      },
    } as never);

    useChatStore
      .getState()
      .clearQueuedMessage(0, { ...local, chatId: 'chat-1' });
    await settle();

    expect(cancelQueuedMessage).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError.mock.calls[0]?.[0]).toMatch(
      /^\[renderer\] Unhandled renderer promise rejection .*The host queue is gone\./,
    );
    Object.assign(window, { api: previous });
    consoleError.mockRestore();
  });
});
