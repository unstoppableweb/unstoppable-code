import type { PipelineInputValue } from '@canopy/execution-engine/types/pipeline';
import {
  buildExpressionContext,
  type ExpressionContext,
} from './execution-context';

type TokenType =
  | 'identifier'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'operator'
  | 'paren'
  | 'dot'
  | 'comma'
  | 'bracket';

interface Token {
  type: TokenType;
  value: string;
}

const MATRIX_CONTEXT_IDENTIFIERS = new Set(['matrix']);
const PHYSICAL_JOB_CONTEXT_IDENTIFIERS = new Set(['job', 'matrix']);

export interface EvaluationFunctions {
  success?: () => boolean;
  failure?: () => boolean;
  always?: () => boolean;
  cancelled?: () => boolean;
}

function stringifyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  // Match GitHub expression coercion: arrays and objects are not implicitly
  // converted to JSON. Authors must opt in with toJson().
  return '';
}

/**
 * Supported subset:
 * - string, number, boolean, null literals
 * - property access (`steps.build.outputs.tag`)
 * - function calls (`success()`, `contains(...)`, `join(...)`)
 * - `()`, `!`, `&&`, `||`, `==`, `!=`, `<`, `<=`, `>`, `>=`
 */
function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const current = expression[index];

    if (/\s/.test(current)) {
      index += 1;
      continue;
    }

    const twoCharOperator = expression.slice(index, index + 2);
    if (['&&', '||', '==', '!=', '<=', '>='].includes(twoCharOperator)) {
      tokens.push({ type: 'operator', value: twoCharOperator });
      index += 2;
      continue;
    }

    if (['!', '<', '>'].includes(current)) {
      tokens.push({ type: 'operator', value: current });
      index += 1;
      continue;
    }

    if (current === '(' || current === ')') {
      tokens.push({ type: 'paren', value: current });
      index += 1;
      continue;
    }

    if (current === '[' || current === ']') {
      tokens.push({ type: 'bracket', value: current });
      index += 1;
      continue;
    }

    if (current === '.') {
      tokens.push({ type: 'dot', value: current });
      index += 1;
      continue;
    }

    if (current === ',') {
      tokens.push({ type: 'comma', value: current });
      index += 1;
      continue;
    }

    if (current === "'" || current === '"') {
      const quote = current;
      let value = '';
      index += 1;
      while (index < expression.length && expression[index] !== quote) {
        if (expression[index] === '\\' && index + 1 < expression.length) {
          value += expression[index + 1];
          index += 2;
          continue;
        }
        value += expression[index];
        index += 1;
      }
      if (expression[index] !== quote) {
        throw new Error(`Unterminated string literal in "${expression}"`);
      }
      tokens.push({ type: 'string', value });
      index += 1;
      continue;
    }

    const numberMatch = expression.slice(index).match(/^\d+(?:\.\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: numberMatch[0] });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = expression
      .slice(index)
      .match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifierMatch) {
      const value = identifierMatch[0];
      if (value === 'true' || value === 'false') {
        tokens.push({ type: 'boolean', value });
      } else if (value === 'null') {
        tokens.push({ type: 'null', value });
      } else {
        tokens.push({ type: 'identifier', value });
      }
      index += value.length;
      continue;
    }

    throw new Error(`Unexpected token "${current}" in "${expression}"`);
  }

  return tokens;
}

function referencesContextIdentifiers(
  expression: string | boolean | undefined,
  identifiers: ReadonlySet<string>,
): boolean {
  if (typeof expression !== 'string' || !expression.trim()) {
    return false;
  }
  const tokens = tokenize(expression);
  return tokens.some(
    (token, index) =>
      token.type === 'identifier' &&
      identifiers.has(token.value) &&
      tokens[index - 1]?.type !== 'dot',
  );
}

export function referencesMatrixContext(
  expression: string | boolean | undefined,
): boolean {
  return referencesContextIdentifiers(expression, MATRIX_CONTEXT_IDENTIFIERS);
}

export function referencesPhysicalJobContext(
  expression: string | boolean | undefined,
): boolean {
  return referencesContextIdentifiers(
    expression,
    PHYSICAL_JOB_CONTEXT_IDENTIFIERS,
  );
}

class Parser {
  private index = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly context: ExpressionContext,
    private readonly functions: EvaluationFunctions,
  ) {}

  parse(): unknown {
    const value = this.parseOr();
    if (this.peek()) {
      throw new Error(`Unexpected token "${this.peek()?.value}"`);
    }
    return value;
  }

  private parseOr(): unknown {
    let left = this.parseAnd();
    while (this.match('operator', '||')) {
      const right = this.parseAnd();
      left = Boolean(left) || Boolean(right);
    }
    return left;
  }

  private parseAnd(): unknown {
    let left = this.parseEquality();
    while (this.match('operator', '&&')) {
      const right = this.parseEquality();
      left = Boolean(left) && Boolean(right);
    }
    return left;
  }

  private parseEquality(): unknown {
    let left = this.parseRelational();
    while (true) {
      if (this.match('operator', '==')) {
        left = left === this.parseRelational();
        continue;
      }
      if (this.match('operator', '!=')) {
        left = left !== this.parseRelational();
        continue;
      }
      return left;
    }
  }

  private parseRelational(): unknown {
    let left = this.parseUnary();
    while (true) {
      if (this.match('operator', '<')) {
        left = this.compare(left, this.parseUnary(), '<');
        continue;
      }
      if (this.match('operator', '<=')) {
        left = this.compare(left, this.parseUnary(), '<=');
        continue;
      }
      if (this.match('operator', '>')) {
        left = this.compare(left, this.parseUnary(), '>');
        continue;
      }
      if (this.match('operator', '>=')) {
        left = this.compare(left, this.parseUnary(), '>=');
        continue;
      }
      return left;
    }
  }

  private parseUnary(): unknown {
    if (this.match('operator', '!')) {
      return !Boolean(this.parseUnary());
    }
    return this.parsePrimary();
  }

  private parsePrimary(): unknown {
    const token = this.peek();
    if (!token) {
      throw new Error('Unexpected end of expression');
    }

    if (this.match('paren', '(')) {
      const value = this.parseOr();
      this.expect('paren', ')');
      return value;
    }

    if (token.type === 'string') {
      this.index += 1;
      return token.value;
    }

    if (token.type === 'number') {
      this.index += 1;
      return Number(token.value);
    }

    if (token.type === 'boolean') {
      this.index += 1;
      return token.value === 'true';
    }

    if (token.type === 'null') {
      this.index += 1;
      return null;
    }

    if (token.type === 'identifier') {
      return this.parseIdentifierExpression();
    }

    throw new Error(`Unexpected token "${token.value}"`);
  }

  private parseIdentifierExpression(): unknown {
    const identifier = this.expect('identifier').value;
    let value: unknown;

    if (this.match('paren', '(')) {
      const args: unknown[] = [];
      if (!this.match('paren', ')')) {
        do {
          args.push(this.parseOr());
        } while (this.match('comma', ','));
        this.expect('paren', ')');
      }
      value = this.invokeFunction(identifier, args);
    } else {
      const rootContext = this.context as unknown as Record<string, unknown>;
      value = rootContext[identifier];
    }

    while (true) {
      if (this.match('dot', '.')) {
        const key = this.expect('identifier').value;
        value = this.readProperty(value, key);
        continue;
      }

      if (this.match('bracket', '[')) {
        const key = this.parseOr();
        this.expect('bracket', ']');
        value = this.readProperty(value, String(key));
        continue;
      }

      return value;
    }
  }

  private invokeFunction(name: string, args: unknown[]): unknown {
    switch (name) {
      case 'success':
        return this.functions.success?.() ?? true;
      case 'failure':
        return this.functions.failure?.() ?? false;
      case 'always':
        return this.functions.always?.() ?? true;
      case 'cancelled':
        return this.functions.cancelled?.() ?? false;
      case 'contains': {
        const [haystack, needle] = args;
        if (Array.isArray(haystack)) {
          return haystack.includes(needle);
        }
        if (typeof haystack === 'string') {
          return haystack.includes(stringifyValue(needle));
        }
        return false;
      }
      case 'join': {
        const [value, separator = ','] = args;
        if (!Array.isArray(value)) {
          return '';
        }
        return value
          .map((entry) => stringifyValue(entry))
          .join(stringifyValue(separator));
      }
      case 'parseJson': {
        const [value] = args;
        if (typeof value !== 'string' || value.trim().length === 0) {
          return undefined;
        }
        try {
          return JSON.parse(value) as unknown;
        } catch {
          throw new Error('parseJson() received invalid JSON');
        }
      }
      case 'toJson': {
        const [value] = args;
        if (value === undefined) {
          return '';
        }
        return JSON.stringify(value);
      }
      default:
        return undefined;
    }
  }

  private readProperty(value: unknown, key: string): unknown {
    if (value === null || value === undefined) {
      return undefined;
    }
    if (Array.isArray(value)) {
      const index = Number(key);
      return Number.isInteger(index) ? value[index] : undefined;
    }
    if (typeof value === 'object') {
      return (value as Record<string, unknown>)[key];
    }
    return undefined;
  }

  private compare(left: unknown, right: unknown, operator: string): boolean {
    switch (operator) {
      case '<':
        return (left as number | string) < (right as number | string);
      case '<=':
        return (left as number | string) <= (right as number | string);
      case '>':
        return (left as number | string) > (right as number | string);
      case '>=':
        return (left as number | string) >= (right as number | string);
      default:
        return false;
    }
  }

  private expect(type: TokenType, value?: string): Token {
    const token = this.peek();
    if (!token || token.type !== type || (value && token.value !== value)) {
      throw new Error(
        `Expected ${value ? `"${value}"` : type} but found "${token?.value ?? 'end'}"`,
      );
    }
    this.index += 1;
    return token;
  }

  private match(type: TokenType, value?: string): boolean {
    const token = this.peek();
    if (!token || token.type !== type || (value && token.value !== value)) {
      return false;
    }
    this.index += 1;
    return true;
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }
}

export function evaluateExpression(
  expression: string,
  context: ExpressionContext,
  functions: EvaluationFunctions = {},
): unknown {
  const trimmed = expression.trim();
  if (!trimmed) {
    return '';
  }
  const parser = new Parser(tokenize(trimmed), context, functions);
  return parser.parse();
}

export function evaluateCondition(
  expression: string | boolean | undefined,
  context: ExpressionContext,
  functions: EvaluationFunctions = {},
): boolean {
  // Normalization coerces YAML booleans to 'true'/'false' strings, but
  // pipeline definitions persisted before that coercion existed can still
  // carry raw booleans — honor their literal value instead of crashing.
  if (typeof expression === 'boolean') {
    return expression;
  }
  if (!expression?.trim()) {
    return true;
  }
  return Boolean(evaluateExpression(expression, context, functions));
}

/**
 * An embedded `${{ }}` expression as step values are interpolated at run time.
 * It does not span lines, so analysis that mirrors a run must share it.
 */
const TEMPLATE_EXPRESSION_PATTERN = /\$\{\{\s*(.*?)\s*\}\}/g;

export function interpolateExpression(
  template: string,
  context: ExpressionContext,
  functions: EvaluationFunctions = {},
): string {
  return template.replace(
    TEMPLATE_EXPRESSION_PATTERN,
    (_match, expression: string) => {
      const value = evaluateExpression(expression, context, functions);
      return stringifyValue(value);
    },
  );
}

export function evaluateTemplateValue(
  template: string,
  context: ExpressionContext,
  functions: EvaluationFunctions = {},
): unknown {
  const match = template.trim().match(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/);
  if (match) {
    return evaluateExpression(match[1], context, functions);
  }
  return interpolateExpression(template, context, functions);
}

/** The input named by `inputs.<name>` or `inputs['<name>']` at `index`. */
function staticInputName(tokens: Token[], index: number): string | undefined {
  const next = tokens[index + 1];
  const name = tokens[index + 2];
  if (next?.type === 'dot') {
    return name?.type === 'identifier' ? name.value : undefined;
  }
  const close = tokens[index + 3];
  return next?.type === 'bracket' &&
    next.value === '[' &&
    name?.type === 'string' &&
    close?.type === 'bracket' &&
    close.value === ']'
    ? name.value
    : undefined;
}

/**
 * The trigger inputs an expression reads, when inputs are all it reads.
 *
 * Returns `undefined` when the expression reads any other context (a step
 * output, `needs`, the job, the environment), indexes `inputs` with a computed
 * key, or does not tokenize: its value then cannot be known before a run.
 */
function expressionInputReferences(
  expression: string,
): ReadonlySet<string> | undefined {
  let tokens: Token[];
  try {
    tokens = tokenize(expression);
  } catch {
    return undefined;
  }
  const names = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type !== 'identifier') continue;
    const next = tokens[index + 1];
    // A property name, or a function name such as `parseJson(`.
    if (tokens[index - 1]?.type === 'dot') continue;
    if (next?.type === 'paren' && next.value === '(') continue;
    const name =
      token.value === 'inputs' ? staticInputName(tokens, index) : undefined;
    if (name === undefined) return undefined;
    names.add(name);
  }
  return names;
}

/**
 * The trigger inputs a step value's `${{ }}` expressions read, as a run
 * interpolates them, or `undefined` when any of them reads something other
 * than a named input.
 */
export function templateInputReferences(
  template: string,
): ReadonlySet<string> | undefined {
  const names = new Set<string>();
  for (const match of Array.from(
    template.matchAll(TEMPLATE_EXPRESSION_PATTERN),
  )) {
    const references = expressionInputReferences(match[1] ?? '');
    if (!references) return undefined;
    references.forEach((name) => names.add(name));
  }
  return names;
}

/**
 * Substitute the `${{ }}` expressions of a step value that read only the
 * given inputs, as a run would, and leave every other expression as authored.
 * This shows the text a known input selection produces without guessing at
 * run-time values; an expression that fails to evaluate is left as authored.
 */
export function interpolateKnownInputs(
  template: string,
  inputs: Readonly<Record<string, PipelineInputValue>>,
  /** Inputs known to have no value, as a run leaves them out of `inputs`. */
  absentInputs: readonly string[] = [],
): string {
  const context = buildExpressionContext({ inputs: { ...inputs } });
  const known = (name: string): boolean =>
    Object.prototype.hasOwnProperty.call(inputs, name) ||
    absentInputs.includes(name);
  return template.replace(
    TEMPLATE_EXPRESSION_PATTERN,
    (match: string, expression: string) => {
      const references = expressionInputReferences(expression);
      if (!references || !Array.from(references).every(known)) {
        return match;
      }
      try {
        return stringifyValue(evaluateExpression(expression, context));
      } catch {
        return match;
      }
    },
  );
}
