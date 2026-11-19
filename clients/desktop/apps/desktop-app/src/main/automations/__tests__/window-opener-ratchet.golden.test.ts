// CAN-4174 ratchet golden: the automations service opens the Orchestrator
// window only where the allowance below says, and the allowance only goes
// down. Since CAN-4174 PR 4 the window is a reaction to chat.initiated, so a
// direct opener call in automations/ is debt. The one left is the native-path
// session prompt, which publishes no chat.initiated. Every non-test source
// under automations/ is parsed and every call to a window opener is counted;
// a reference passed on as a value (the surfaces the send port hands to the
// chat service for terminal chats) is not a call and is not counted.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const AUTOMATIONS_DIR = join(__dirname, '..');

const WINDOW_OPENERS: ReadonlySet<string> = new Set([
  'ensureAppAdvisorWindow',
  'openAppAdvisorWindow',
  'sendAppAdvisorWindowCommand',
  'requestAppAdvisorPresentation',
]);

const NATIVE_PATH_DEBT_TICKET = 'CAN-7266';

interface AllowedSite {
  file: string;
  method: string;
  callee: string;
  count: number;
  ticket: string;
}

/** Only ever lowered: a removed call lowers its count in the same change. */
const ALLOWANCE: readonly AllowedSite[] = Object.freeze([
  Object.freeze({
    file: 'service.ts',
    method: 'executeAction',
    callee: 'ensureAppAdvisorWindow',
    count: 1,
    ticket: NATIVE_PATH_DEBT_TICKET,
  }),
]);

interface OpenerCall {
  file: string;
  line: number;
  method: string;
  callee: string;
}

function sourcesUnder(dir: string): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sourcesUnder(path));
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push({
        file: relative(AUTOMATIONS_DIR, path).split(sep).join('/'),
        text: readFileSync(path, 'utf8'),
      });
    }
  }
  return out;
}

function calleeName(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    // fn.call(...), fn.apply(...) and fn.bind(...)(...) still call fn.
    if (name === 'call' || name === 'apply' || name === 'bind')
      return calleeName(callee.expression);
    return name;
  }
  if (
    ts.isElementAccessExpression(callee) &&
    ts.isStringLiteralLike(callee.argumentExpression)
  )
    return callee.argumentExpression.text;
  if (ts.isCallExpression(callee)) return calleeName(callee.expression);
  if (ts.isParenthesizedExpression(callee))
    return calleeName(callee.expression);
  return undefined;
}

function enclosingMethod(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (
      (ts.isMethodDeclaration(at) || ts.isFunctionDeclaration(at)) &&
      at.name &&
      (ts.isIdentifier(at.name) || ts.isPrivateIdentifier(at.name))
    )
      return at.name.text;
  }
  return '<module>';
}

function findOpenerCalls(
  sources: readonly { file: string; text: string }[],
): OpenerCall[] {
  const calls: OpenerCall[] = [];
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
        const name = calleeName(node.expression);
        if (name !== undefined && WINDOW_OPENERS.has(name))
          calls.push({
            file,
            line:
              source.getLineAndCharacterOfPosition(node.getStart(source)).line +
              1,
            method: enclosingMethod(node),
            callee: name,
          });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

function allowanceProblems(
  calls: readonly OpenerCall[],
  allowance: readonly AllowedSite[],
): string[] {
  const problems: string[] = [];
  const at = (call: OpenerCall): string =>
    `automations/${call.file}:${call.line}`;
  for (const call of calls) {
    const allowed = allowance.some(
      (site) =>
        site.file === call.file &&
        site.method === call.method &&
        site.callee === call.callee,
    );
    if (!allowed)
      problems.push(
        `${at(call)}: ${call.callee}() in ${call.method} is not allowed. The Orchestrator window is a reaction to chat.initiated (CAN-4174); don't open it from the automations service.`,
      );
  }
  for (const site of allowance) {
    const matching = calls.filter(
      (call) =>
        call.file === site.file &&
        call.method === site.method &&
        call.callee === site.callee,
    );
    if (matching.length > site.count)
      problems.push(
        `automations/${site.file} ${site.method}: ${matching.length} ${site.callee}() calls (${matching.map(at).join(', ')}) exceed the allowance of ${site.count} (${site.ticket}). The allowance only goes down.`,
      );
    else if (matching.length < site.count)
      problems.push(
        `automations/${site.file} ${site.method}: the allowance for ${site.callee}() is ${site.count} but ${matching.length} call(s) remain. Lower it to ${matching.length} in this change (${site.ticket}).`,
      );
  }
  return problems;
}

describe('the automations service opens the Orchestrator window only where its allowance says (CAN-4174 ratchet)', () => {
  it('counts exactly the allowed window opener calls in automations/, no more and no fewer', () => {
    const calls = findOpenerCalls(sourcesUnder(AUTOMATIONS_DIR));
    expect(allowanceProblems(calls, ALLOWANCE)).toEqual([]);
    expect(calls).toEqual([
      expect.objectContaining({
        file: 'service.ts',
        method: 'executeAction',
        callee: 'ensureAppAdvisorWindow',
      }),
    ]);
  });

  it('fails on an extra opener call, naming its file and line, however it is spelled', () => {
    const extra = [
      'export class Extra {',
      '  async run(surfaces: any, request: any): Promise<void> {',
      '    await surfaces.ensureAppAdvisorWindow();',
      '    const { openAppAdvisorWindow } = surfaces;',
      '    await openAppAdvisorWindow(request);',
      "    surfaces['sendAppAdvisorWindowCommand']({ type: 'focus' });",
      '    await surfaces.ensureAppAdvisorWindow.call(surfaces);',
      '    const passedOn = { ensureAppAdvisorWindow: surfaces.ensureAppAdvisorWindow };',
      '    void passedOn;',
      '  }',
      '}',
      'export function present(surfaces: any): void {',
      "  requestAppAdvisorPresentation(surfaces, 'queued_send');",
      '}',
      'declare function requestAppAdvisorPresentation(a: unknown, b: string): void;',
    ].join('\n');
    const calls = findOpenerCalls([
      ...sourcesUnder(AUTOMATIONS_DIR),
      { file: 'scratch.ts', text: extra },
    ]);
    expect(allowanceProblems(calls, ALLOWANCE)).toEqual([
      expect.stringContaining(
        'automations/scratch.ts:3: ensureAppAdvisorWindow() in run is not allowed',
      ),
      expect.stringContaining(
        'automations/scratch.ts:5: openAppAdvisorWindow() in run is not allowed',
      ),
      expect.stringContaining(
        'automations/scratch.ts:6: sendAppAdvisorWindowCommand() in run is not allowed',
      ),
      expect.stringContaining(
        'automations/scratch.ts:7: ensureAppAdvisorWindow() in run is not allowed',
      ),
      expect.stringContaining(
        'automations/scratch.ts:13: requestAppAdvisorPresentation() in present is not allowed',
      ),
    ]);
  });

  it('fails when the allowed call goes but the allowance stays, until the allowance drops', () => {
    const sources = sourcesUnder(AUTOMATIONS_DIR).map((source) =>
      source.file === 'service.ts'
        ? {
            ...source,
            text: source.text.replace(
              'await this.surfaces.ensureAppAdvisorWindow();',
              'void 0;',
            ),
          }
        : source,
    );
    const calls = findOpenerCalls(sources);
    expect(calls).toEqual([]);
    expect(allowanceProblems(calls, ALLOWANCE)).toEqual([
      expect.stringContaining(
        'the allowance for ensureAppAdvisorWindow() is 1 but 0 call(s) remain. Lower it to 0',
      ),
    ]);
    expect(
      allowanceProblems(
        calls,
        ALLOWANCE.map((site) => ({ ...site, count: 0 })),
      ),
    ).toEqual([]);
  });

  it('fails when a second call joins the allowed one in the same method', () => {
    const sources = sourcesUnder(AUTOMATIONS_DIR).map((source) =>
      source.file === 'service.ts'
        ? {
            ...source,
            text: source.text.replace(
              'await this.surfaces.ensureAppAdvisorWindow();',
              'await this.surfaces.ensureAppAdvisorWindow();\n          await this.surfaces.ensureAppAdvisorWindow();',
            ),
          }
        : source,
    );
    expect(allowanceProblems(findOpenerCalls(sources), ALLOWANCE)).toEqual([
      expect.stringMatching(
        /automations\/service\.ts executeAction: 2 ensureAppAdvisorWindow\(\) calls \(automations\/service\.ts:\d+, automations\/service\.ts:\d+\) exceed the allowance of 1/,
      ),
    ]);
  });
});
