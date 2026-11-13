// ---------------------------------------------------------------------------
// Pure policy engine for the tool-approval subsystem.
//
// This module is intentionally framework-free: no Node/Electron imports, no
// IO. It is consumed by both the desktop main process and (transitively)
// browser-safe code, so it must stay a pure data transform.
// ---------------------------------------------------------------------------

import { APPROVAL_MODES } from '@canopy/execution-engine/types/approvals';
import { currentNameOfRenamedTool } from './renamed-tool-names';
import type {
  ApprovalCheck,
  ApprovalEvaluation,
  ApprovalEvaluationContext,
  ApprovalMode,
  ApprovalRule,
  ApprovalRuleOrigin,
  ApprovalRuleTarget,
  SafetyDenyReason,
} from '@canopy/execution-engine/types/approvals';

/**
 * Hardcoded safety-deny command patterns. These are checked before any user
 * or project rule and cannot be overridden except by switching the approval
 * mode to `'full-access'`. Unlike user rules, safety patterns use PREFIX
 * token matching (extra trailing command tokens are allowed) with
 * slash-aware wildcards; see `safetySegmentMatches`.
 */
export const SAFETY_DENY_COMMAND_PATTERNS: readonly string[] = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf ~/*',
  'sudo rm *',
  'mkfs *',
  'dd if=* of=/dev/*',
  'git push -f origin main',
  'git push -f origin master',
  'git push --force origin main',
  'git push --force origin master',
];

/**
 * Splits a shell command string into its individual chained segments,
 * splitting on `&&`, `||`, `;`, `|&`, `|`, `&`, and newlines. Segments are
 * trimmed and empty segments are dropped. Quoted and escaped operators remain
 * part of their containing command instead of becoming execution boundaries.
 */
export function splitCommandChain(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): string[] {
  return commandChainSegments(command, shellPlatform).map(
    (segment) => segment.command,
  );
}

interface CommandChainSegment {
  command: string;
  nextOperator?: string;
}

function commandChainSegments(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): CommandChainSegment[] {
  const segments: CommandChainSegment[] = [];
  let quote: "'" | '"' | null = null;
  let start = 0;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (shellPlatform === 'posix' && char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote !== null) {
      continue;
    }

    let operator: string | undefined;
    const pair = command.slice(i, i + 2);
    if (pair === '&&' || pair === '||' || pair === '|&' || pair === '\r\n') {
      operator = pair;
    } else if (char === ';' || char === '&' || char === '|' || char === '\n') {
      operator = char;
    }
    if (operator === undefined) {
      continue;
    }

    const segment = command.slice(start, i).trim();
    if (segment) {
      segments.push({ command: segment, nextOperator: operator });
    }
    i += operator.length - 1;
    start = i + 1;
  }
  const finalSegment = command.slice(start).trim();
  if (finalSegment) {
    segments.push({ command: finalSegment });
  }
  return segments;
}

/**
 * Detects shell syntax that can execute a nested command outside the flat
 * command-chain model. The approval engine deliberately fails closed for
 * these forms instead of pretending that a lightweight tokenizer can safely
 * model a complete shell grammar.
 */
export function containsNestedShellExecution(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (shellPlatform === 'posix' && char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote !== "'" && char === '`') {
      return true;
    }
    if (quote !== "'" && char === '$' && command[i + 1] === '(') {
      return true;
    }
    if (
      quote === null &&
      char === '(' &&
      (i === 0 ||
        command[i - 1] === '@' ||
        /[\s;&|<>=]/.test(command[i - 1] ?? ''))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detects shell-active line continuations. POSIX-like shells remove a
 * backslash followed by a newline outside single quotes before tokenization,
 * so splitting the raw text first can hide the command ultimately executed.
 */
export function containsShellLineContinuation(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (char !== '\\' || quote === "'") {
      continue;
    }
    if (
      command[i + 1] === '\n' ||
      (command[i + 1] === '\r' && command[i + 2] === '\n')
    ) {
      return true;
    }
    i++;
  }
  return false;
}

/**
 * Detects shell parameter expansion that can change the approved command at
 * execution time. Single-quoted and escaped dollar signs are literals; other
 * standard parameter forms fail closed because this policy layer does not
 * attempt to reproduce shell environment expansion.
 */
export function containsShellParameterExpansion(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (shellPlatform === 'posix' && char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (shellPlatform === 'windows' && char === '%') {
      const closingPercent = command.indexOf('%', i + 1);
      if (
        closingPercent > i + 1 &&
        /^[A-Za-z_][A-Za-z0-9_]*(?::[^%\r\n]*)?$/.test(
          command.slice(i + 1, closingPercent),
        )
      ) {
        return true;
      }
    }
    if (char !== '$' || quote === "'") {
      continue;
    }
    const next = command[i + 1];
    if (
      next === '{' ||
      (next !== undefined && /[A-Za-z_0-9*@#?$!\-]/.test(next))
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Detects unquoted shell pathname expansion (`*`, `?`, and bracket
 * expressions). The policy engine cannot safely predict the filesystem paths
 * produced by the user's shell, so these forms fail closed before remembered
 * command rules are considered. Quoted and escaped metacharacters remain
 * literal.
 */
export function containsShellPathnameExpansion(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (shellPlatform === 'posix' && char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote !== null) {
      continue;
    }
    if (char === '*' || char === '?') {
      return true;
    }
    if (char === '[') {
      for (let j = i + 1; j < command.length; j++) {
        if (command[j] === '\\') {
          j++;
          continue;
        }
        if (command[j] === ']') {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Detects ANSI-C shell quoting (`$'...'`). Escape processing inside this form
 * can turn an apparently harmless token into a protected path, so the policy
 * engine fails closed instead of attempting to reproduce the shell grammar.
 */
export function containsAnsiCQuoting(command: string): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null && char === '$' && command[i + 1] === "'") {
      return true;
    }
  }
  return false;
}

/**
 * Detects shell redirection syntax outside quoted or escaped literals. The
 * policy engine cannot safely determine the filesystem effect of arbitrary
 * redirections, so these forms fail closed before remembered allow rules.
 */
export function containsShellRedirection(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (shellPlatform === 'posix' && char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote === null && (char === '<' || char === '>')) {
      return true;
    }
  }
  return false;
}

/**
 * Detects unquoted shell brace expansion such as `{a,b}` or `{1..3}`. The
 * expansion happens before command execution and can turn an apparently safe
 * operand into a protected path, so remembered command rules must fail closed.
 */
export function containsShellBraceExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let braceDepth = 0;
  let expansionCandidate = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === '\\' && quote !== "'") {
      i++;
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      continue;
    }
    if (quote !== null) {
      continue;
    }
    if (char === '{') {
      braceDepth++;
      if (braceDepth === 1) {
        expansionCandidate = false;
      }
      continue;
    }
    if (
      braceDepth > 0 &&
      (char === ',' || (char === '.' && command[i + 1] === '.'))
    ) {
      expansionCandidate = true;
      continue;
    }
    if (char === '}' && braceDepth > 0) {
      braceDepth--;
      if (braceDepth === 0 && expansionCandidate) {
        return true;
      }
    }
  }
  return false;
}

const INTERPRETER_PAYLOAD_FLAGS: ReadonlyMap<
  string,
  ReadonlySet<string>
> = new Map([
  ['bash', new Set(['-c'])],
  ['cmd', new Set(['/c', '/k'])],
  ['cmd.exe', new Set(['/c', '/k'])],
  ['dash', new Set(['-c'])],
  ['fish', new Set(['-c'])],
  ['node', new Set(['-e', '-p', '--eval', '--print'])],
  ['osascript', new Set(['-e'])],
  ['perl', new Set(['-e'])],
  ['php', new Set(['-r'])],
  ['py', new Set(['-c', '-m'])],
  ['py.exe', new Set(['-c', '-m'])],
  [
    'powershell',
    new Set(['-c', '-command', '-e', '-encodedcommand', '--encodedcommand']),
  ],
  [
    'powershell.exe',
    new Set(['-c', '-command', '-e', '-encodedcommand', '--encodedcommand']),
  ],
  [
    'pwsh',
    new Set(['-c', '-command', '-e', '-encodedcommand', '--encodedcommand']),
  ],
  [
    'pwsh.exe',
    new Set(['-c', '-command', '-e', '-encodedcommand', '--encodedcommand']),
  ],
  ['python', new Set(['-c', '-m'])],
  ['python3', new Set(['-c', '-m'])],
  ['ruby', new Set(['-e'])],
  ['sh', new Set(['-c'])],
  ['zsh', new Set(['-c'])],
]);

const AWK_INTERPRETERS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const INLINE_COMMAND_INTERPRETERS = new Set([
  'eval',
  'iex',
  'invoke-expression',
]);

function commandBasename(token: string): string {
  const normalized = token.replace(/\\/g, '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1).toLowerCase();
}

function gitCommandBasename(token: string): string {
  const basename = commandBasename(token);
  return basename.endsWith('.exe') ? basename.slice(0, -4) : basename;
}

function interpreterPayloadFlags(
  commandName: string,
): ReadonlySet<string> | undefined {
  const exact = INTERPRETER_PAYLOAD_FLAGS.get(commandName);
  if (exact) {
    return exact;
  }
  const withoutExecutableSuffix = commandName.endsWith('.exe')
    ? commandName.slice(0, -4)
    : commandName;
  const executableVariant = INTERPRETER_PAYLOAD_FLAGS.get(
    withoutExecutableSuffix,
  );
  if (executableVariant) {
    return executableVariant;
  }
  const versionedInterpreter = ['node', 'perl', 'php', 'python', 'ruby'].find(
    (name) =>
      new RegExp(`^${name}\\d+(?:\\.\\d+)*$`).test(withoutExecutableSuffix),
  );
  return versionedInterpreter
    ? INTERPRETER_PAYLOAD_FLAGS.get(versionedInterpreter)
    : undefined;
}

function tokenCarriesInterpreterPayloadFlag(
  token: string,
  flags: ReadonlySet<string>,
): boolean {
  const normalized = token.toLowerCase();
  if (flags.has(normalized)) {
    return true;
  }
  for (const flag of Array.from<string>(flags)) {
    if (flag.startsWith('--') && normalized.startsWith(`${flag}=`)) {
      return true;
    }
    if (
      flag.startsWith('/') &&
      normalized.startsWith(flag) &&
      normalized.length > flag.length
    ) {
      return true;
    }
    if (
      flag.length === 2 &&
      flag.startsWith('-') &&
      normalized.startsWith('-') &&
      !normalized.startsWith('--') &&
      normalized.slice(1).includes(flag[1])
    ) {
      return true;
    }
  }
  return false;
}

function gitConfigOverrides(tokens: readonly string[]): string[] {
  if (gitCommandBasename(tokens[0] ?? '') !== 'git') {
    return [];
  }
  const configs: string[] = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '-c') {
      const config = tokens[index + 1];
      if (config !== undefined) {
        configs.push(config);
        index++;
      }
      continue;
    }
    if (token.startsWith('-c') && token.length > 2) {
      configs.push(token.slice(2));
    }
  }
  return configs;
}

function environmentAssignments(
  tokens: readonly string[],
): ReadonlyMap<string, string> {
  const assignments = new Map<string, string>();
  for (const token of tokens) {
    const equalsIndex = token.indexOf('=');
    if (equalsIndex <= 0) continue;
    assignments.set(token.slice(0, equalsIndex), token.slice(equalsIndex + 1));
  }
  return assignments;
}

function gitConfigEnvOverrides(
  tokens: readonly string[],
  environmentTokens: readonly string[],
): string[] {
  if (gitCommandBasename(tokens[0] ?? '') !== 'git') {
    return [];
  }
  const assignments = environmentAssignments(environmentTokens);
  const configs: string[] = [];
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    const spec =
      token === '--config-env'
        ? tokens[++index]
        : token.startsWith('--config-env=')
          ? token.slice('--config-env='.length)
          : undefined;
    if (spec === undefined) {
      continue;
    }
    const equalsIndex = spec.indexOf('=');
    if (equalsIndex <= 0 || equalsIndex === spec.length - 1) {
      continue;
    }
    const name = spec.slice(0, equalsIndex);
    const environmentName = spec.slice(equalsIndex + 1);
    configs.push(`${name}=${assignments.get(environmentName) ?? ''}`);
  }
  return configs;
}

const MAX_GIT_CONFIG_COUNT = 256;

function gitEnvironmentConfigOverrides(tokens: readonly string[]): string[] {
  const assignments = environmentAssignments(tokens);
  const configs: string[] = [];
  const rawParameters = assignments.get('GIT_CONFIG_PARAMETERS');
  if (rawParameters !== undefined) {
    configs.push(...tokenize(rawParameters));
  }
  const rawCount = assignments.get('GIT_CONFIG_COUNT');
  if (rawCount === undefined || !/^\d+$/.test(rawCount)) {
    return configs;
  }
  const count = Number(rawCount);
  if (
    !Number.isSafeInteger(count) ||
    count < 0 ||
    count > MAX_GIT_CONFIG_COUNT
  ) {
    return configs;
  }
  for (let index = 0; index < count; index++) {
    const key = assignments.get(`GIT_CONFIG_KEY_${index}`);
    const value = assignments.get(`GIT_CONFIG_VALUE_${index}`);
    if (key !== undefined && value !== undefined) {
      configs.push(`${key}=${value}`);
    }
  }
  return configs;
}

function gitConfigOverridesForSegment(segment: string): string[] {
  const originalTokens = tokenize(segment);
  const unwrappedTokens = unwrapSafetyCommandTokens(
    originalTokens.map(normalizeSafetyToken),
  );
  const configs = [
    ...gitConfigOverrides(originalTokens),
    ...gitConfigOverrides(unwrappedTokens),
    ...gitConfigEnvOverrides(originalTokens, originalTokens),
    ...gitConfigEnvOverrides(unwrappedTokens, originalTokens),
  ];
  if (gitCommandBasename(unwrappedTokens[0] ?? '') === 'git') {
    configs.push(...gitEnvironmentConfigOverrides(originalTokens));
  }
  return configs;
}

function containsGitConfigOverride(command: string): boolean {
  return splitCommandChain(command).some(
    (segment) => gitConfigOverridesForSegment(segment).length > 0,
  );
}

function containsGitExecutableOption(command: string): boolean {
  const executableOptions = ['--exec', '--receive-pack', '--upload-pack'];
  return splitCommandChain(command).some((segment) => {
    const tokens = unwrapSafetyCommandTokens(
      tokenize(segment).map(normalizeSafetyToken),
    );
    if (gitCommandBasename(tokens[0] ?? '') !== 'git') {
      return false;
    }
    return tokens.slice(1).some((token) => {
      const option = token.split('=', 1)[0]?.toLowerCase() ?? '';
      return (
        option.length > 2 &&
        executableOptions.some((candidate) => candidate.startsWith(option))
      );
    });
  });
}

function containsGitAliasOverride(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    return gitConfigOverridesForSegment(segment).some((config) => {
      const equalsIndex = config.indexOf('=');
      if (equalsIndex <= 0) {
        return false;
      }
      const name = config.slice(0, equalsIndex).toLowerCase();
      return name.startsWith('alias.');
    });
  });
}

function containsMutableGitConfigSelector(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const originalTokens = tokenize(segment);
    const unwrappedTokens = unwrapSafetyCommandTokens(
      originalTokens.map(normalizeSafetyToken),
    );
    if (gitCommandBasename(unwrappedTokens[0] ?? '') !== 'git') {
      return false;
    }

    const assignments = environmentAssignments(originalTokens);
    if (
      assignments.has('GIT_CONFIG_GLOBAL') ||
      assignments.has('GIT_CONFIG_SYSTEM')
    ) {
      return true;
    }

    return gitConfigOverridesForSegment(segment).some((config) => {
      const equalsIndex = config.indexOf('=');
      if (equalsIndex <= 0) {
        return false;
      }
      const name = config.slice(0, equalsIndex).toLowerCase();
      return (
        name === 'include.path' ||
        (name.startsWith('includeif.') && name.endsWith('.path'))
      );
    });
  });
}

/**
 * Returns true when a command invokes an interpreter's inline-code option.
 * The payload is a second command language and cannot be evaluated safely by
 * this module's intentionally small shell tokenizer.
 */
export function containsInterpreterPayload(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const originalTokens = tokenize(segment);
    const tokenSets = [
      originalTokens,
      unwrapSafetyCommandTokens(originalTokens.map(normalizeSafetyToken)),
    ];
    return tokenSets.some((tokens) => {
      for (let i = 0; i < tokens.length; i++) {
        const commandName = commandBasename(tokens[i]);
        if (
          INLINE_COMMAND_INTERPRETERS.has(commandName) &&
          i < tokens.length - 1
        ) {
          return true;
        }
        // AWK's executable program is positional rather than introduced by a
        // dedicated inline-code flag. Conservatively retain the complete
        // command for every AWK invocation with arguments so approving one
        // program cannot mint a wildcard rule for a different program.
        if (AWK_INTERPRETERS.has(commandName) && i < tokens.length - 1) {
          return true;
        }
        const flags = interpreterPayloadFlags(commandName);
        if (
          flags &&
          tokens
            .slice(i + 1)
            .some((token) => tokenCarriesInterpreterPayloadFlag(token, flags))
        ) {
          return true;
        }
      }
      return false;
    });
  });
}

/**
 * Builds the persistent rule suggested after a command approval. Inline
 * interpreter payloads retain the complete command so one approval never
 * becomes a wildcard grant for arbitrary later code.
 */
export function suggestedCommandPattern(command: string): string {
  const trimmed = command.trim();
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) {
    return trimmed;
  }
  const unwrapped = unwrapSafetyCommandTokensDetailed(tokens);
  const containsWrapper =
    !unwrapped.complete ||
    unwrapped.tokens.length !== tokens.length ||
    unwrapped.tokens.some((token, index) => token !== tokens[index]);
  const dispatchesThroughMulticall = MULTICALL_EXECUTABLES.has(
    commandBasename(unwrapped.tokens[0] ?? ''),
  );
  if (
    splitCommandChain(trimmed).length > 1 ||
    containsInterpreterPayload(trimmed) ||
    containsGitConfigOverride(trimmed) ||
    containsGitExecutableOption(trimmed) ||
    containsWrapper ||
    dispatchesThroughMulticall
  ) {
    return trimmed;
  }
  if (tokens.length <= 1) {
    return `${tokens[0] ?? ''} *`;
  }
  // A leading option can shift the command's actual operation beyond the
  // second token (for example, `git -C /repo status`). Wildcarding from the
  // option would grant every operation accepted after that global option, so
  // retain the exact command whenever the operation cannot be identified from
  // the first two tokens.
  if (tokens[1]?.startsWith('-') && tokens[1] !== '-') {
    return trimmed;
  }
  // Some multi-level command families dispatch again after the second token.
  // Wildcarding `git submodule status` as `git submodule *`, for example,
  // would also authorize `git submodule foreach <shell payload>`. Keep these
  // nested dispatchers exact so shell-bearing subcommands require a fresh
  // approval.
  if (
    /(?:^|[\\/])git(?:\.exe)?$/i.test(tokens[0] ?? '') &&
    tokens[1]?.toLowerCase() === 'submodule'
  ) {
    return trimmed;
  }
  return `${tokens[0]} ${tokens[1]} *`;
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let tokenStarted = false;
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    const isWindowsDrivePath =
      /^[A-Za-z]:/.test(token) && (token.length === 2 || token.includes('\\'));
    if (token === '' && char === '\\' && value[i + 1] === '\\') {
      token = '\\\\';
      tokenStarted = true;
      i++;
      continue;
    }
    if (char === '\\' && (isWindowsDrivePath || token.startsWith('\\\\'))) {
      token += char;
      tokenStarted = true;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      const next = value[i + 1];
      if (next !== undefined) {
        token += next;
        tokenStarted = true;
        i++;
      } else {
        token += char;
        tokenStarted = true;
      }
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      tokenStarted = true;
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      tokenStarted = true;
      continue;
    }
    if (quote === null && /\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token);
        token = '';
        tokenStarted = false;
      }
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (tokenStarted) {
    tokens.push(token);
  }
  return tokens;
}

/**
 * Canonicalizes path-like shell tokens before applying the hardcoded safety
 * deny list. Shells treat redundant separators in absolute and home-relative
 * paths as equivalent, so spellings such as `~//` must not evade `~/*`.
 */
function normalizeSafetyToken(token: string): string {
  let normalizedToken = token;
  if (/^~[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/|$)/.test(normalizedToken)) {
    const slashIndex = normalizedToken.indexOf('/');
    normalizedToken =
      slashIndex < 0 ? '~' : `~/${normalizedToken.slice(slashIndex + 1)}`;
  }
  const homeRelative = normalizedToken.startsWith('~/');
  if (!homeRelative && !normalizedToken.startsWith('/')) {
    return normalizedToken;
  }
  const prefix = homeRelative ? '~/' : '/';
  const remainder = normalizedToken.slice(prefix.length);
  const segments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length > 0) {
        segments.pop();
      }
      continue;
    }
    segments.push(segment);
  }
  return `${prefix}${segments.join('/')}`;
}

/**
 * Linear-time wildcard matcher for a single token: `*` matches any run of
 * characters. Implemented as greedy literal-part scanning (split on `*`,
 * anchor the first part as a prefix and the last as a suffix, locate middle
 * parts left-to-right), so pathological patterns like repeated `a*` cannot
 * cause exponential backtracking. No `RegExp` is ever built from rule or
 * pattern content.
 *
 * When `slashAware` is true (used only by the hardcoded safety-deny check),
 * a `*` whose preceding literal ends with `/` is restricted to a single
 * path segment (it will not match across `/`). This keeps `rm -rf /*`
 * matching `rm -rf /tmp` but not `rm -rf /tmp/foo`, while `dd if=*` still
 * matches `if=/dev/zero` and a standalone `*` still matches any token.
 */
function tokenWildcardMatches(
  pattern: string,
  text: string,
  slashAware: boolean,
): boolean {
  if (!pattern.includes('*')) {
    return pattern === text;
  }
  const parts = pattern.split('*');
  const firstPart = parts[0];
  if (!text.startsWith(firstPart)) {
    return false;
  }
  let pos = firstPart.length;
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const restricted = slashAware && parts[i - 1].endsWith('/');
    const isLast = i === parts.length - 1;
    if (isLast) {
      if (part === '') {
        return !restricted || !text.includes('/', pos);
      }
      const endIdx = text.length - part.length;
      if (endIdx < pos || !text.endsWith(part)) {
        return false;
      }
      return !restricted || !text.slice(pos, endIdx).includes('/');
    }
    const idx = text.indexOf(part, pos);
    if (idx === -1) {
      return false;
    }
    if (restricted && text.slice(pos, idx).includes('/')) {
      return false;
    }
    pos = idx + part.length;
  }
  // Unreachable: a pattern containing '*' always has >= 2 parts, and the
  // loop returns on the final part.
  return true;
}

/**
 * Matches a space-separated command pattern against a single command
 * segment. Tokens must match exactly, except that a pattern token of `*`
 * (whole token) as the final token matches zero or more remaining command
 * tokens, and a `*` embedded within a token matches any run of characters
 * within that token only. Matching is token/word-boundary based — there is
 * no regex exposed to callers.
 */
export function commandPatternMatches(
  pattern: string,
  command: string,
  executableCaseInsensitive = false,
): boolean {
  return commandPatternMatchesTokens(
    pattern,
    tokenize(command),
    executableCaseInsensitive,
  );
}

function commandPatternMatchesTokens(
  pattern: string,
  commandTokensInput: readonly string[],
  executableCaseInsensitive = false,
): boolean {
  const patternTokens = tokenize(pattern);
  const commandTokens = [...commandTokensInput];
  if (executableCaseInsensitive) {
    if (patternTokens[0] !== undefined) {
      patternTokens[0] = patternTokens[0].toLowerCase();
    }
    if (commandTokens[0] !== undefined) {
      commandTokens[0] = commandTokens[0].toLowerCase();
    }
  }
  if (patternTokens.length === 0) {
    return commandTokens.length === 0;
  }
  for (let i = 0; i < patternTokens.length; i++) {
    const patternToken = patternTokens[i];
    const isTrailingStar =
      patternToken === '*' && i === patternTokens.length - 1;
    if (isTrailingStar) {
      return true;
    }
    if (i >= commandTokens.length) {
      return false;
    }
    if (!tokenWildcardMatches(patternToken, commandTokens[i], false)) {
      return false;
    }
  }
  return patternTokens.length === commandTokens.length;
}

/**
 * Matches a hardcoded safety-deny pattern against one command segment using
 * PREFIX semantics: every pattern token must match the corresponding leading
 * command token (slash-aware wildcard matching per token), and any extra
 * trailing command tokens are allowed. This intentionally differs from the
 * exact-token-count semantics of {@link commandPatternMatches} so commands
 * like `dd if=/dev/zero of=/dev/sda bs=1M` cannot escape the safety net by
 * appending arguments.
 */
function safetySegmentMatches(pattern: string, segment: string): boolean {
  const patternTokens = tokenize(pattern).map(normalizeSafetyToken);
  const originalCommandTokens = tokenize(segment).map(normalizeSafetyToken);
  const unwrappedCommandTokens = unwrapSafetyCommandTokens(
    originalCommandTokens,
  );
  const sudoNormalizedCommandTokens =
    commandBasename(originalCommandTokens[0] ?? '') === 'sudo'
      ? [
          originalCommandTokens[0],
          commandBasename(unwrappedCommandTokens[0] ?? ''),
          ...unwrappedCommandTokens.slice(1),
        ]
      : undefined;
  if (patternTokens.length > 0) {
    patternTokens[0] = commandBasename(patternTokens[0]);
  }

  function matches(commandTokensInput: string[]): boolean {
    const commandTokens = [...commandTokensInput];
    if (commandTokens.length > 0) {
      commandTokens[0] = commandBasename(commandTokens[0]);
    }
    if (
      patternTokens.length === 3 &&
      patternTokens[0] === 'rm' &&
      patternTokens[1] === '-rf' &&
      commandTokens[0] === 'rm'
    ) {
      const parsed = recursiveForcedRemoveOperandsFromTokens(commandTokens);
      return (
        parsed !== undefined &&
        parsed.operands.some((operand) =>
          tokenWildcardMatches(patternTokens[2], operand, true),
        )
      );
    }
    if (
      patternTokens.length === 0 ||
      commandTokens.length < patternTokens.length
    ) {
      return false;
    }
    return patternTokens.every((patternToken, i) =>
      tokenWildcardMatches(patternToken, commandTokens[i], true),
    );
  }

  return (
    matches(originalCommandTokens) ||
    matches(unwrappedCommandTokens) ||
    (sudoNormalizedCommandTokens !== undefined &&
      matches(sudoNormalizedCommandTokens))
  );
}

const WRAPPER_OPTIONS_WITH_VALUES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  sudo: new Set([
    '-C',
    '--close-from',
    '-T',
    '--command-timeout',
    '-D',
    '--chdir',
    '-g',
    '--group',
    '-h',
    '--host',
    '-p',
    '--prompt',
    '-R',
    '--chroot',
    '-r',
    '--role',
    '-t',
    '--type',
    '-u',
    '--user',
  ]),
  env: new Set([
    '-C',
    '--chdir',
    '-P',
    '-S',
    '--split-string',
    '-u',
    '--unset',
  ]),
  builtin: new Set(),
  command: new Set(),
  exec: new Set(['-a']),
  nice: new Set(['-n', '--adjustment']),
  nohup: new Set(),
  time: new Set(['-f', '--format', '-o', '--output']),
  timeout: new Set(['-k', '--kill-after', '-s', '--signal']),
  gtimeout: new Set(['-k', '--kill-after', '-s', '--signal']),
  arch: new Set(),
  caffeinate: new Set(['-t', '-w']),
};

const WRAPPER_SHORT_OPTIONS_WITHOUT_VALUES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  sudo: new Set([
    'A',
    'B',
    'b',
    'E',
    'e',
    'H',
    'i',
    'K',
    'k',
    'L',
    'l',
    'n',
    'P',
    'S',
    's',
    'V',
    'v',
  ]),
  env: new Set(['0', 'i', 'v']),
  builtin: new Set(),
  command: new Set(['p', 'V', 'v']),
  exec: new Set(['c', 'l']),
  nice: new Set(),
  nohup: new Set(),
  time: new Set(['a', 'p', 'v', 'V']),
  timeout: new Set(['f', 'p', 'v']),
  gtimeout: new Set(['f', 'p', 'v']),
  arch: new Set(),
  caffeinate: new Set(['d', 'i', 'm', 's', 'u']),
};

function clusteredWrapperOptionConsumesNext(
  wrapper: string,
  token: string,
): boolean | undefined {
  if (!/^-[^-].+/.test(token) || token.includes('=')) {
    return undefined;
  }
  const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[wrapper];
  const optionsWithoutValues = WRAPPER_SHORT_OPTIONS_WITHOUT_VALUES[wrapper];
  if (!optionsWithValues || !optionsWithoutValues) {
    return undefined;
  }
  const valueOptionNames = new Set(
    Array.from(optionsWithValues)
      .filter((option) => /^-[^-]$/.test(option))
      .map((option) => option[1]),
  );
  const cluster = token.slice(1);
  for (let index = 0; index < cluster.length; index++) {
    const option = cluster[index];
    if (valueOptionNames.has(option)) {
      return index === cluster.length - 1;
    }
    if (!optionsWithoutValues.has(option)) {
      return undefined;
    }
  }
  return false;
}

function isEnvironmentAssignment(token: string): boolean {
  const equals = token.indexOf('=');
  if (equals <= 0) {
    return false;
  }
  const name = token.slice(0, equals);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Removes common command wrappers before applying hard safety patterns. This
 * is intentionally limited to wrappers whose next non-option token is the
 * executable they invoke; user approval rules still match the original text.
 */
interface SafetyCommandUnwrapResult {
  tokens: string[];
  complete: boolean;
}

function unwrapSafetyCommandTokensDetailed(
  tokens: string[],
): SafetyCommandUnwrapResult {
  let current = tokens;
  unwrapLoop: for (let depth = 0; depth < 8 && current.length > 0; depth++) {
    let assignmentCount = 0;
    while (
      assignmentCount < current.length &&
      isEnvironmentAssignment(current[assignmentCount])
    ) {
      assignmentCount++;
    }
    if (assignmentCount > 0) {
      current = current.slice(assignmentCount);
      continue;
    }
    const wrapperBasename = commandBasename(current[0]);
    const wrapper =
      wrapperBasename.endsWith('.exe') &&
      WRAPPER_OPTIONS_WITH_VALUES[wrapperBasename.slice(0, -4)]
        ? wrapperBasename.slice(0, -4)
        : wrapperBasename;
    const optionsWithValues = WRAPPER_OPTIONS_WITH_VALUES[wrapper];
    if (!optionsWithValues) {
      return { tokens: current, complete: true };
    }
    let index = 1;
    let optionsEnded = false;
    while (index < current.length) {
      const token = current[index];
      if (!optionsEnded && token === '--') {
        optionsEnded = true;
        index++;
        continue;
      }
      if (wrapper === 'env' && isEnvironmentAssignment(token)) {
        index++;
        continue;
      }
      if (!optionsEnded && token.startsWith('-') && token !== '-') {
        const optionName = token.includes('=')
          ? token.slice(0, token.indexOf('='))
          : token;
        const attachedSplitString =
          wrapper === 'env' && token.startsWith('-S') && token.length > 2
            ? token.slice(2)
            : undefined;
        if (
          wrapper === 'env' &&
          (optionName === '-S' ||
            optionName === '--split-string' ||
            attachedSplitString !== undefined)
        ) {
          const equalsIndex = token.indexOf('=');
          const payload =
            attachedSplitString ??
            (equalsIndex >= 0
              ? token.slice(equalsIndex + 1)
              : current[index + 1]);
          // GNU env's split-string mode has its own escape language (including
          // `\_` as a word separator). The shell tokenizer below deliberately
          // does not emulate that second grammar, so escaped payloads must fail
          // closed instead of being analyzed as a different command.
          if (payload === undefined || payload.includes('\\')) {
            return { tokens: current, complete: false };
          }
          const tailIndex =
            attachedSplitString !== undefined || equalsIndex >= 0
              ? index + 1
              : index + 2;
          current = [...tokenize(payload ?? ''), ...current.slice(tailIndex)];
          continue unwrapLoop;
        }
        if (
          wrapper === 'env' &&
          (optionName === '-C' ||
            optionName === '--chdir' ||
            (token.startsWith('-C') && token.length > 2))
        ) {
          // `env` changes cwd before executing its nested command. This parser
          // cannot carry that cwd through every wrapper form, so fail closed
          // instead of checking destructive relative paths against the
          // provider's original cwd.
          return { tokens: current, complete: false };
        }
        if (wrapper === 'env' && /^-[^-]*[CS]/.test(token)) {
          // GNU env permits value-taking -C/-S options inside short-option
          // clusters (for example -iC and -iS). This lightweight parser does
          // not split those clusters or emulate split-string's second shell
          // grammar, so fail closed instead of discarding their payload.
          return { tokens: current, complete: false };
        }
        const clusteredOptionConsumesNext = clusteredWrapperOptionConsumesNext(
          wrapper,
          token,
        );
        if (
          /^-[^-].+/.test(token) &&
          !optionsWithValues.has(optionName) &&
          clusteredOptionConsumesNext === undefined
        ) {
          return { tokens: current, complete: false };
        }
        index++;
        if (
          (optionsWithValues.has(optionName) && !token.includes('=')) ||
          clusteredOptionConsumesNext === true
        ) {
          index++;
        }
        continue;
      }
      break;
    }
    if (wrapper === 'timeout' || wrapper === 'gtimeout') {
      // GNU timeout places a required duration between its options and the
      // executable. Skip it so hard safety checks inspect the nested command.
      index++;
    }
    current = current.slice(index);
  }
  const nextBasename = commandBasename(current[0] ?? '');
  const nextWrapper =
    nextBasename.endsWith('.exe') &&
    WRAPPER_OPTIONS_WITH_VALUES[nextBasename.slice(0, -4)]
      ? nextBasename.slice(0, -4)
      : nextBasename;
  return {
    tokens: current,
    complete:
      current.length === 0 ||
      (!isEnvironmentAssignment(current[0]) &&
        WRAPPER_OPTIONS_WITH_VALUES[nextWrapper] === undefined),
  };
}

function unwrapSafetyCommandTokens(tokens: string[]): string[] {
  return unwrapSafetyCommandTokensDetailed(tokens).tokens;
}

function hasIncompleteSafetyWrapperUnwrap(command: string): boolean {
  return splitCommandChain(command).some(
    (segment) =>
      !unwrapSafetyCommandTokensDetailed(
        tokenize(segment).map(normalizeSafetyToken),
      ).complete,
  );
}

const RECURSIVE_FORCED_REMOVE_EXECUTABLES = new Set([
  'rm',
  'remove-item',
  // Standard PowerShell aliases for Remove-Item.
  'ri',
  'rmdir',
  'rd',
  'del',
  'erase',
]);

const MULTICALL_EXECUTABLES = new Set(['busybox', 'toybox']);

function unwrapMulticallAppletTokens(
  commandTokens: readonly string[],
): readonly string[] {
  if (
    MULTICALL_EXECUTABLES.has(commandBasename(commandTokens[0] ?? '')) &&
    commandTokens[1] &&
    !commandTokens[1].startsWith('-')
  ) {
    return commandTokens.slice(1);
  }
  return commandTokens;
}

interface RecursiveForcedRemoveOperandsResult {
  operands: string[];
  pathResolutionFailed: boolean;
}

function recursiveForcedRemoveOperandsFromTokens(
  commandTokens: readonly string[],
): RecursiveForcedRemoveOperandsResult | undefined {
  commandTokens = unwrapMulticallAppletTokens(commandTokens);
  const executable = gitCommandBasename(commandTokens[0] ?? '');
  if (!RECURSIVE_FORCED_REMOVE_EXECUTABLES.has(executable)) {
    return undefined;
  }
  let recursive = false;
  let force = false;
  const operands: string[] = [];
  let pathResolutionFailed = false;
  let optionsEnded = false;
  for (const token of commandTokens.slice(1)) {
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token !== '-') {
      const attachedPowerShellValue = /^-([^:]+):(.*)$/i.exec(token);
      if (attachedPowerShellValue) {
        const parameter = attachedPowerShellValue[1]?.toLowerCase();
        const value = attachedPowerShellValue[2] ?? '';
        if (parameter === 'path' || parameter === 'literalpath') {
          if (value) {
            operands.push(value);
          } else {
            pathResolutionFailed = true;
          }
        } else {
          // PowerShell supports attached values for many parameters. If this
          // lightweight parser cannot prove their meaning, fail closed rather
          // than silently discarding a possible destructive path operand.
          pathResolutionFailed = true;
        }
        continue;
      }
      if (token === '--recursive') recursive = true;
      if (token === '--force') force = true;
      if (!token.startsWith('--')) {
        // PowerShell parameters are case-insensitive, including the common
        // `-Recurse -Force` spelling used by its `rm` alias.
        const flags = token.slice(1).toLowerCase();
        recursive ||= flags.includes('r');
        force ||= flags.includes('f');
      }
      continue;
    }
    if (
      !optionsEnded &&
      (executable === 'rd' || executable === 'rmdir') &&
      /^\/(?:[sq]+(?:\/[sq]+)*)$/i.test(token)
    ) {
      const flags = token.toLowerCase().replace(/\//g, '');
      recursive ||= flags.includes('s');
      // cmd.exe's /q suppresses confirmation for a recursive directory
      // removal, so it is the Windows equivalent of the force signal this
      // safety parser requires before canonicalizing destructive operands.
      force ||= flags.includes('q');
      continue;
    }
    operands.push(token);
  }
  return recursive && force ? { operands, pathResolutionFailed } : undefined;
}

/**
 * Returns operands from recursive, forced `rm` commands after unwrapping
 * supported execution wrappers. The main process canonicalizes these paths so
 * symlinks cannot disguise a protected root from the pure safety matcher.
 */
export function recursiveForcedRemoveOperands(command: string): string[] {
  return recursiveForcedRemoveOperations(command).flatMap(
    (operation) => operation.operands,
  );
}

export interface RecursiveForcedRemoveOperation {
  operands: string[];
  cwdChanges: string[];
  cwdResolutionFailed: boolean;
  pathResolutionFailed: boolean;
}

export interface CommandPathOperation {
  operands: string[];
  cwdChanges: string[];
  cwdResolutionFailed: boolean;
}

/**
 * Returns command operands together with preceding provable directory changes.
 * Main-process approval handling canonicalizes these candidates so remembered
 * command rules cannot disguise a protected policy-file target.
 */
export function commandPathOperations(command: string): CommandPathOperation[] {
  const operations: CommandPathOperation[] = [];
  const cwdChanges: string[] = [];
  let cwdResolutionFailed = false;
  for (const segment of commandChainSegments(command)) {
    const tokens = tokenize(segment.command).map(normalizeSafetyToken);
    const unwrapped = unwrapSafetyCommandTokens(tokens);
    const executable = commandBasename(unwrapped[0] ?? '');
    if (
      executable === 'chdir' ||
      executable === 'set-location' ||
      executable === 'sl'
    ) {
      cwdResolutionFailed = true;
      continue;
    }
    if (executable === 'cd' || executable === 'pushd') {
      const operands =
        unwrapped[1] === '--' ? unwrapped.slice(2) : unwrapped.slice(1);
      if (
        operands.length !== 1 ||
        segment.nextOperator !== '&&' ||
        operands[0].startsWith('~') ||
        operands[0] === '-' ||
        (executable === 'pushd' && /^[+-]\d+$/.test(operands[0]))
      ) {
        cwdResolutionFailed = true;
      } else {
        cwdChanges.push(operands[0]);
      }
      continue;
    }
    if (executable === 'popd' || executable === 'dirs') {
      cwdResolutionFailed = true;
      continue;
    }
    if (!executable) {
      continue;
    }
    const operands = unwrapped.slice(1).flatMap((token) => {
      if (token === '--') return [];
      const equalsIndex = token.indexOf('=');
      return equalsIndex >= 0 && equalsIndex < token.length - 1
        ? [token, token.slice(equalsIndex + 1)]
        : [token];
    });
    operations.push({
      operands,
      cwdChanges: [...cwdChanges],
      cwdResolutionFailed,
    });
  }
  return operations;
}

/**
 * Associates destructive operands with preceding provable `cd ... &&` and
 * `pushd ... &&` segments. Unsupported directory-stack mutations fail closed
 * because their effective directory depends on shell execution state this
 * lightweight parser cannot prove.
 */
export function recursiveForcedRemoveOperations(
  command: string,
): RecursiveForcedRemoveOperation[] {
  const operations: RecursiveForcedRemoveOperation[] = [];
  const cwdChanges: string[] = [];
  let cwdResolutionFailed = false;
  for (const segment of commandChainSegments(command)) {
    const tokens = tokenize(segment.command).map(normalizeSafetyToken);
    const unwrapped = unwrapSafetyCommandTokens(tokens);
    const executable = commandBasename(unwrapped[0] ?? '');
    if (
      executable === 'chdir' ||
      executable === 'set-location' ||
      executable === 'sl'
    ) {
      cwdResolutionFailed = true;
      continue;
    }
    if (executable === 'cd' || executable === 'pushd') {
      const hasCdPathAssignment = tokens.some((token) => {
        if (!isEnvironmentAssignment(token)) {
          return false;
        }
        return token.slice(0, token.indexOf('=')).toUpperCase() === 'CDPATH';
      });
      const operands =
        unwrapped[1] === '--' ? unwrapped.slice(2) : unwrapped.slice(1);
      if (
        hasCdPathAssignment ||
        operands.length !== 1 ||
        segment.nextOperator !== '&&'
      ) {
        cwdResolutionFailed = true;
      } else {
        if (
          operands[0].startsWith('~') ||
          operands[0] === '-' ||
          (executable === 'pushd' && /^[+-]\d+$/.test(operands[0]))
        ) {
          cwdResolutionFailed = true;
        } else {
          cwdChanges.push(operands[0]);
        }
      }
      continue;
    }
    if (executable === 'popd' || executable === 'dirs') {
      cwdResolutionFailed = true;
      continue;
    }
    const parsed = recursiveForcedRemoveOperandsFromTokens(unwrapped);
    if (parsed) {
      operations.push({
        operands: parsed.operands,
        cwdChanges: [...cwdChanges],
        cwdResolutionFailed,
        pathResolutionFailed: parsed.pathResolutionFailed,
      });
    }
  }
  return operations;
}

function dangerousGitPushReason(segment: string): SafetyDenyReason | undefined {
  const tokens = unwrapSafetyCommandTokens(
    tokenize(segment).map(normalizeSafetyToken),
  );
  if (gitCommandBasename(tokens[0] ?? '') !== 'git') {
    return undefined;
  }
  const pushIndex = tokens.findIndex(
    (token, index) => index > 0 && token.toLowerCase() === 'push',
  );
  if (pushIndex < 0) {
    return undefined;
  }
  const pushTokens = tokens
    .slice(pushIndex + 1)
    .map((token) => token.toLowerCase());
  const matchesLongOption = (token: string, option: string): boolean => {
    const optionName = token.split('=', 1)[0] ?? token;
    return optionName.length > 2 && option.startsWith(optionName);
  };
  const optionsWithSeparateValues = [
    '--exec',
    '--push-option',
    '--receive-pack',
    '--repo',
  ];
  const optionTokens: string[] = [];
  const positionalTokens: string[] = [];
  let optionsEnded = false;
  for (let index = 0; index < pushTokens.length; index++) {
    const token = pushTokens[index];
    if (!optionsEnded && token === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && token.startsWith('-') && token !== '-') {
      optionTokens.push(token);
      const consumesSeparateValue =
        token === '-o' ||
        optionsWithSeparateValues.some((option) =>
          matchesLongOption(token, option),
        );
      if (
        consumesSeparateValue &&
        !token.includes('=') &&
        token !== '-o' &&
        index < pushTokens.length - 1
      ) {
        index++;
      } else if (token === '-o' && index < pushTokens.length - 1) {
        index++;
      }
      continue;
    }
    positionalTokens.push(token);
  }
  const forceFlag = optionTokens.some(
    (token) =>
      token === '--force' ||
      matchesLongOption(token, '--force-with-lease') ||
      (token.startsWith('-') &&
        !token.startsWith('--') &&
        token.slice(1).includes('f')),
  );
  const mirrorFlag = optionTokens.some((token) =>
    matchesLongOption(token, '--mirror'),
  );
  const deleteFlag = optionTokens.some(
    (token) =>
      matchesLongOption(token, '--delete') ||
      (/^-[a-z]+$/.test(token) && token.slice(1).includes('d')),
  );
  const isProtectedDestination = (token: string): boolean => {
    const refspec = token.startsWith('+') ? token.slice(1) : token;
    const colonIndex = refspec.lastIndexOf(':');
    const destination =
      colonIndex >= 0 ? refspec.slice(colonIndex + 1) : refspec;
    return (
      destination === 'main' ||
      destination === 'master' ||
      destination === 'refs/heads/main' ||
      destination === 'refs/heads/master'
    );
  };
  const protectedBranch = positionalTokens.some(isProtectedDestination);
  const forcedProtectedRefspec = positionalTokens.some(
    (token) => token.startsWith('+') && isProtectedDestination(token),
  );
  const deletedProtectedRefspec = positionalTokens.some(
    (token) => token.startsWith(':') && isProtectedDestination(token),
  );
  const refspecs = positionalTokens.slice(1);
  const hasImplicitDestination =
    forceFlag &&
    (refspecs.length === 0 ||
      refspecs.some((refspec) => {
        const normalized = refspec.toLowerCase();
        return normalized === 'head' || normalized === 'refs/heads/head';
      }));
  if (mirrorFlag || forcedProtectedRefspec) return 'force-push';
  if (deletedProtectedRefspec || (deleteFlag && protectedBranch))
    return 'destructive-delete';
  if ((forceFlag && protectedBranch) || hasImplicitDestination)
    return 'force-push';
  return undefined;
}

function isDangerousMkfs(segment: string): boolean {
  const tokens = unwrapMulticallAppletTokens(
    unwrapSafetyCommandTokens(tokenize(segment).map(normalizeSafetyToken)),
  );
  const executable = commandBasename(tokens[0] ?? '');
  return executable === 'mkfs' || executable.startsWith('mkfs.');
}

function isDangerousDdWrite(segment: string): boolean {
  const tokens = unwrapMulticallAppletTokens(
    unwrapSafetyCommandTokens(tokenize(segment).map(normalizeSafetyToken)),
  );
  if (commandBasename(tokens[0] ?? '') !== 'dd') {
    return false;
  }
  return tokens.slice(1).some((token) => {
    if (!token.startsWith('of=')) {
      return false;
    }
    const outputPath = normalizedAbsolutePathForMatching(token.slice(3));
    return outputPath?.startsWith('/dev/') === true;
  });
}

/**
 * Linear-time path glob matcher: `*` matches within a single path segment,
 * `**` (as a whole segment) matches zero or more segments. Implemented as a
 * two-pointer walk over `/`-split segments with backtracking only to the
 * last `**`, and greedy literal-part scanning within segments — no regex,
 * no exponential backtracking.
 */
function filePatternMatches(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  let p = 0;
  let t = 0;
  let starP = -1;
  let starT = 0;
  while (t < pathSegments.length) {
    if (p < patternSegments.length && patternSegments[p] === '**') {
      starP = p;
      starT = t;
      p++;
    } else if (
      p < patternSegments.length &&
      tokenWildcardMatches(patternSegments[p], pathSegments[t], false)
    ) {
      p++;
      t++;
    } else if (starP !== -1) {
      p = starP + 1;
      starT++;
      t = starT;
    } else {
      return false;
    }
  }
  while (p < patternSegments.length && patternSegments[p] === '**') {
    p++;
  }
  return p === patternSegments.length;
}

/** A workspace path glob, without case where the filesystem has none. */
function uploadPathMatches(
  pattern: string,
  path: string,
  caseInsensitive: boolean,
): boolean {
  return caseInsensitive
    ? filePatternMatches(pattern.toLowerCase(), path.toLowerCase())
    : filePatternMatches(pattern, path);
}

function uploadOriginMatches(rule: string, origin: string): boolean {
  const canonical = (value: string): string =>
    value.trim().toLowerCase().replace(/\/+$/, '');
  return canonical(rule) === canonical(origin);
}

function networkHostMatches(pattern: string, host: string): boolean {
  const canonicalPattern = pattern.toLowerCase().replace(/\.+$/, '');
  const canonicalHost = host.toLowerCase().replace(/\.+$/, '');
  if (canonicalPattern === canonicalHost) {
    return true;
  }
  if (canonicalPattern.startsWith('*.')) {
    const suffix = canonicalPattern.slice(1);
    return (
      canonicalHost.length > suffix.length && canonicalHost.endsWith(suffix)
    );
  }
  return false;
}

/**
 * The absolute path a file-write rule or check names, as rule matching
 * resolves it: an absolute path as is, a relative one against the chat's
 * workspace root. Null when it is relative and there is no root.
 */
export function resolveFileRulePath(
  path: string,
  workspaceRoot: string | undefined,
  pathCaseInsensitive = false,
): string | null {
  return (
    normalizedAbsolutePathForMatching(path, pathCaseInsensitive) ??
    (workspaceRoot
      ? normalizedAbsolutePathForMatching(
          `${workspaceRoot.replace(/[\\/]$/, '')}/${path}`,
          pathCaseInsensitive,
        )
      : null)
  );
}

function normalizedFileRulePath(
  path: string,
  workspaceRoot: string | undefined,
  pathCaseInsensitive: boolean,
): string {
  return (
    resolveFileRulePath(path, workspaceRoot, pathCaseInsensitive) ??
    (pathCaseInsensitive ? path.toLowerCase() : path)
  );
}

function fileGrantMayContainTarget(
  grantPath: string,
  targetPath: string,
  workspaceRoot: string | undefined,
  pathCaseInsensitive: boolean,
): boolean {
  const grant = normalizedFileRulePath(
    grantPath,
    workspaceRoot,
    pathCaseInsensitive,
  );
  const target = normalizedFileRulePath(
    targetPath,
    workspaceRoot,
    pathCaseInsensitive,
  );
  if (filePatternMatches(target, grant)) {
    return true;
  }

  const grantScope = literalPathScope(grant);
  const targetScope = literalPathScope(target);

  // Permission paths represent roots/globs rather than concrete writes.
  // Conservatively treat overlapping literal scopes as intersecting so a
  // broad grant can never leapfrog a narrower deny.
  return (
    isPathWithinScope(targetScope, grantScope) ||
    isPathWithinScope(grantScope, targetScope)
  );
}

/** The wildcard-free folder (or path) a normalized file pattern starts with. */
function literalPathScope(value: string): string {
  const wildcard = value.search(/[*?]/);
  const literal = wildcard < 0 ? value : value.slice(0, wildcard);
  const slash = literal.lastIndexOf('/');
  return (wildcard < 0 ? literal : literal.slice(0, slash + 1)).replace(
    /[\\/]$/,
    '',
  );
}

function isPathWithinScope(candidate: string, parent: string): boolean {
  return (
    parent === '' ||
    parent === '/' ||
    candidate === parent ||
    candidate.startsWith(`${parent}/`)
  );
}

/**
 * Whether a write grant may reach a protected file. A protected file-name
 * glob only names files directly in its folder, so unlike a deny pattern it
 * stays clear of a grant scoped below that folder.
 */
function fileGrantMayContainProtectedFile(
  grantPath: string,
  protectedPath: string,
  workspaceRoot: string | undefined,
  pathCaseInsensitive: boolean,
): boolean {
  const protectedFile = normalizedFileRulePath(
    protectedPath,
    workspaceRoot,
    pathCaseInsensitive,
  );
  const slash = protectedFile.lastIndexOf('/');
  const folder = protectedFile.slice(0, slash);
  if (
    slash < 0 ||
    !protectedFile.slice(slash + 1).includes('*') ||
    /[*?]/.test(folder)
  ) {
    return fileGrantMayContainTarget(
      grantPath,
      protectedPath,
      workspaceRoot,
      pathCaseInsensitive,
    );
  }
  const grant = normalizedFileRulePath(
    grantPath,
    workspaceRoot,
    pathCaseInsensitive,
  );
  return (
    filePatternMatches(protectedFile, grant) ||
    filePatternMatches(grant, protectedFile) ||
    isPathWithinScope(folder, literalPathScope(grant))
  );
}

/**
 * True when two tool names are one of the app's own tools before and after a
 * rename. A rule keeps the name it was saved with, so without this a deny
 * saved before a rename would stop blocking the tool.
 */
function sameToolAcrossRename(ruleName: string, checkName: string): boolean {
  return (
    currentNameOfRenamedTool(ruleName) === currentNameOfRenamedTool(checkName)
  );
}

function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`;
}

function targetMatchesCheck(
  target: ApprovalRuleTarget,
  check: ApprovalCheck,
  workspaceRoot?: string,
  pathCaseInsensitive = false,
): boolean {
  if (target.kind === 'command') {
    const shellPlatform =
      check.kind === 'command' ? (check.shellPlatform ?? 'posix') : 'posix';
    const targetSegments = splitCommandChain(target.pattern, shellPlatform);
    return (
      check.kind === 'command' &&
      (targetSegments.length > 1
        ? commandPatternMatches(
            target.pattern,
            check.command,
            pathCaseInsensitive,
          )
        : splitCommandChain(check.command, shellPlatform).every((segment) =>
            commandPatternMatches(target.pattern, segment, pathCaseInsensitive),
          ))
    );
  }
  if (target.kind === 'file-write') {
    if (check.kind !== 'file-write') {
      return false;
    }
    return fileTargetMatchesPath(
      target,
      check.resolvedPath ?? check.path,
      workspaceRoot,
      pathCaseInsensitive,
    );
  }
  if (target.kind === 'mcp') {
    return (
      check.kind === 'mcp' &&
      target.server === check.server &&
      (target.tool === undefined ||
        target.tool === check.tool ||
        sameToolAcrossRename(
          mcpToolName(target.server, target.tool),
          mcpToolName(check.server, check.tool),
        ))
    );
  }
  if (target.kind === 'network') {
    return (
      check.kind === 'network' && networkHostMatches(target.host, check.host)
    );
  }
  if (target.kind === 'browser-upload') {
    const path = target.path;
    // An allow covers the upload only when it covers every file.
    return (
      check.kind === 'browser-upload' &&
      uploadOriginMatches(target.origin, check.origin) &&
      (path === undefined ||
        check.files.every((file) =>
          uploadPathMatches(path, file.displayPath, pathCaseInsensitive),
        ))
    );
  }
  return (
    check.kind === 'tool' &&
    (target.toolName === check.toolName ||
      sameToolAcrossRename(target.toolName, check.toolName))
  );
}

function fileTargetMatchesPath(
  target: Extract<ApprovalRuleTarget, { kind: 'file-write' }>,
  path: string,
  workspaceRoot: string | undefined,
  pathCaseInsensitive: boolean,
): boolean {
  const normalizedCandidate = normalizedFileRulePath(
    path,
    workspaceRoot,
    pathCaseInsensitive,
  );
  const normalizedPattern = normalizedFileRulePath(
    target.path,
    workspaceRoot,
    pathCaseInsensitive,
  );
  return filePatternMatches(normalizedPattern, normalizedCandidate);
}

/**
 * Answers whether a single rule, on its own, fully covers the given check.
 * For `command` checks this requires every chained segment (per
 * {@link splitCommandChain}) to match the rule's pattern — combining
 * multiple rules to jointly cover a command chain is handled by
 * {@link evaluateApproval}, not by this function.
 */
export function ruleMatchesCheck(
  rule: ApprovalRule,
  check: ApprovalCheck,
  workspaceRoot?: string,
  pathCaseInsensitive = false,
): boolean {
  return targetMatchesCheck(
    rule.target,
    check,
    workspaceRoot,
    pathCaseInsensitive,
  );
}

function ruleMatchesAnySegment(
  rule: ApprovalRule,
  segments: readonly string[],
  executableCaseInsensitive = false,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  const target = rule.target;
  if (
    target.kind !== 'command' ||
    splitCommandChain(target.pattern, shellPlatform).length > 1
  ) {
    return false;
  }
  return segments.some((segment) => {
    if (
      commandPatternMatches(target.pattern, segment, executableCaseInsensitive)
    ) {
      return true;
    }
    const originalTokens = tokenize(segment);
    const unwrapped = unwrapSafetyCommandTokensDetailed(originalTokens);
    return (
      unwrapped.complete &&
      (unwrapped.tokens.length !== originalTokens.length ||
        unwrapped.tokens.some(
          (token, index) => token !== originalTokens[index],
        )) &&
      commandPatternMatchesTokens(
        target.pattern,
        unwrapped.tokens,
        executableCaseInsensitive,
      )
    );
  });
}

function findDenyMatch(
  check: ApprovalCheck,
  rules: readonly ApprovalRule[],
  workspaceRoot?: string,
  pathCaseInsensitive = false,
): ApprovalRule | undefined {
  const denyRules = rules.filter((rule) => rule.behavior === 'deny');
  if (check.kind === 'command') {
    const shellPlatform = check.shellPlatform ?? 'posix';
    const atomicMatch = denyRules.find(
      (rule) =>
        rule.target.kind === 'command' &&
        splitCommandChain(rule.target.pattern, shellPlatform).length > 1 &&
        commandPatternMatches(
          rule.target.pattern,
          check.command,
          pathCaseInsensitive,
        ),
    );
    if (atomicMatch) {
      return atomicMatch;
    }
    const segments = splitCommandChain(check.command, shellPlatform);
    return denyRules.find((rule) =>
      ruleMatchesAnySegment(rule, segments, pathCaseInsensitive, shellPlatform),
    );
  }
  if (check.kind === 'network' && check.isGrant && check.host === '*') {
    return denyRules.find((rule) => rule.target.kind === 'network');
  }
  if (check.kind === 'browser-upload') {
    // A deny covers the upload when it covers any one of its files.
    return denyRules.find((rule) => {
      const target = rule.target;
      if (
        target.kind !== 'browser-upload' ||
        !uploadOriginMatches(target.origin, check.origin)
      )
        return false;
      const path = target.path;
      return (
        path === undefined ||
        check.files.some(
          (file) =>
            uploadPathMatches(path, file.displayPath, pathCaseInsensitive) ||
            (file.requestedPath !== undefined &&
              uploadPathMatches(path, file.requestedPath, pathCaseInsensitive)),
        )
      );
    });
  }
  if (check.kind === 'file-write' && check.isGrant) {
    return denyRules.find(
      (rule) =>
        rule.target.kind === 'file-write' &&
        fileGrantMayContainTarget(
          check.resolvedPath ?? check.path,
          rule.target.path,
          workspaceRoot,
          pathCaseInsensitive,
        ),
    );
  }
  if (check.kind === 'file-write' && check.resolvedPath !== undefined) {
    const resolvedPath = check.resolvedPath;
    return denyRules.find(
      (rule) =>
        rule.target.kind === 'file-write' &&
        (fileTargetMatchesPath(
          rule.target,
          check.path,
          workspaceRoot,
          pathCaseInsensitive,
        ) ||
          fileTargetMatchesPath(
            rule.target,
            resolvedPath,
            workspaceRoot,
            pathCaseInsensitive,
          )),
    );
  }
  return denyRules.find((rule) =>
    targetMatchesCheck(rule.target, check, workspaceRoot, pathCaseInsensitive),
  );
}

function findAllowMatch(
  check: ApprovalCheck,
  rules: readonly ApprovalRule[],
  workspaceRoot?: string,
  pathCaseInsensitive = false,
): ApprovalRule | undefined {
  const allowRules = rules.filter((rule) => rule.behavior === 'allow');
  if (check.kind === 'command') {
    const shellPlatform = check.shellPlatform ?? 'posix';
    const allowPatternMatches = (pattern: string, command: string): boolean =>
      containsGitExecutableOption(command)
        ? pattern.trim() === command.trim()
        : commandPatternMatches(pattern, command, pathCaseInsensitive);
    const atomicMatch = allowRules.find(
      (rule) =>
        rule.target.kind === 'command' &&
        splitCommandChain(rule.target.pattern, shellPlatform).length > 1 &&
        allowPatternMatches(rule.target.pattern, check.command),
    );
    if (atomicMatch) {
      return atomicMatch;
    }
    const segments = splitCommandChain(check.command, shellPlatform);
    const allSegmentsCovered = segments.every((segment) =>
      allowRules.some(
        (rule) =>
          rule.target.kind === 'command' &&
          allowPatternMatches(rule.target.pattern, segment),
      ),
    );
    if (!allSegmentsCovered) {
      return undefined;
    }
    return allowRules.find((rule) =>
      ruleMatchesAnySegment(rule, segments, pathCaseInsensitive, shellPlatform),
    );
  }
  return allowRules.find((rule) =>
    targetMatchesCheck(rule.target, check, workspaceRoot, pathCaseInsensitive),
  );
}

function unquotedShellSyntax(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): string {
  let result = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (shellPlatform === 'posix' && char === '\\' && quote !== "'") {
      result += ' ';
      if (command[i + 1] !== undefined) {
        result += ' ';
        i++;
      }
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      result += ' ';
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      result += ' ';
      continue;
    }
    result += quote === null ? char : ' ';
  }
  return result;
}

function containsUnsupportedShellControlSyntax(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  const syntax = unquotedShellSyntax(command, shellPlatform);
  const boundary = String.raw`(?:^|[;&|()\n])\s*`;
  const controlWord = String.raw`(?:if|then|elif|else|fi|for|while|until|do|done|case|esac|select|function)\b`;
  if (new RegExp(`${boundary}${controlWord}`).test(syntax)) {
    return true;
  }
  if (
    shellPlatform === 'windows' &&
    new RegExp(
      String.raw`(?:^|[;&|(){}\n])\s*(?:begin|process|end|clean|dynamicparam|if|elseif|else|switch|for|foreach|while|do|until|try|catch|finally|trap|function|filter|class|enum)\b`,
      'i',
    ).test(syntax)
  ) {
    return true;
  }
  if (
    new RegExp(
      `${boundary}(?:function\\s+)?[A-Za-z_][A-Za-z0-9_]*\\s*\\(\\s*\\)\\s*\\{`,
    ).test(syntax)
  ) {
    return true;
  }
  return (
    new RegExp(`${boundary}!\\s+\\S`).test(syntax) ||
    new RegExp(`${boundary}[{}](?:\\s|$)`).test(syntax)
  );
}

function containsFindExecutor(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const tokens = unwrapSafetyCommandTokens(
      tokenize(segment).map(normalizeSafetyToken),
    );
    if (commandBasename(tokens[0] ?? '') !== 'find') {
      return false;
    }
    return tokens
      .slice(1)
      .some((token) => ['-exec', '-execdir', '-ok', '-okdir'].includes(token));
  });
}

function containsFindDelete(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const tokens = unwrapSafetyCommandTokens(
      tokenize(segment).map(normalizeSafetyToken),
    );
    return (
      commandBasename(tokens[0] ?? '') === 'find' &&
      tokens.slice(1).includes('-delete')
    );
  });
}

function containsXargsExecutor(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const tokens = unwrapSafetyCommandTokens(
      tokenize(segment).map(normalizeSafetyToken),
    );
    return commandBasename(tokens[0] ?? '') === 'xargs';
  });
}

function containsScriptExecutor(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const tokens = unwrapSafetyCommandTokens(
      tokenize(segment).map(normalizeSafetyToken),
    );
    return commandBasename(tokens[0] ?? '') === 'script';
  });
}

function containsEnvCwdMutation(command: string): boolean {
  return splitCommandChain(command).some((segment) => {
    const tokens = tokenize(segment).map(normalizeSafetyToken);
    const envIndex = tokens.findIndex(
      (token) => commandBasename(token) === 'env',
    );
    if (envIndex < 0) {
      return false;
    }
    return tokens
      .slice(envIndex + 1)
      .some(
        (token) =>
          token === '-C' ||
          token.startsWith('-C ') ||
          (token.startsWith('-C') && token.length > 2) ||
          token === '--chdir' ||
          token.startsWith('--chdir=') ||
          token.startsWith('--chdir '),
      );
  });
}

function safetyDeniedCommandReason(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): SafetyDenyReason | undefined {
  // PowerShell and cmd.exe do not use backslash to escape command
  // separators. Fail closed if POSIX parsing would hide a Windows boundary.
  if (
    shellPlatform === 'windows' &&
    splitCommandChain(command, 'windows').length !==
      splitCommandChain(command, 'posix').length
  ) {
    return 'unverifiable-command';
  }
  if (
    containsNestedShellExecution(command, shellPlatform) ||
    containsShellLineContinuation(command) ||
    containsAnsiCQuoting(command) ||
    containsInterpreterPayload(command) ||
    containsGitAliasOverride(command) ||
    containsMutableGitConfigSelector(command) ||
    containsUnsupportedShellControlSyntax(command, shellPlatform) ||
    containsScriptExecutor(command) ||
    hasIncompleteSafetyWrapperUnwrap(command) ||
    containsEnvCwdMutation(command)
  ) {
    return 'unverifiable-command';
  }
  if (containsFindDelete(command)) return 'destructive-delete';
  for (const segment of splitCommandChain(command)) {
    const normalizedTokens = tokenize(segment).map(normalizeSafetyToken);
    const effectiveSegment = unwrapMulticallAppletTokens(
      unwrapSafetyCommandTokens(normalizedTokens),
    ).join(' ');
    const sudoMulticallRemove =
      normalizedTokens.some((token) => commandBasename(token) === 'sudo') &&
      commandBasename(tokenize(effectiveSegment)[0] ?? '') === 'rm';
    const gitPushReason = dangerousGitPushReason(segment);
    if (gitPushReason) return gitPushReason;
    if (isDangerousMkfs(segment) || isDangerousDdWrite(segment))
      return 'disk-write';
    if (sudoMulticallRemove) return 'destructive-delete';
    for (const pattern of SAFETY_DENY_COMMAND_PATTERNS) {
      if (
        safetySegmentMatches(pattern, segment) ||
        safetySegmentMatches(pattern, effectiveSegment)
      ) {
        // Preserve the original pattern iteration order and prefix matching.
        if (pattern.startsWith('git ')) return 'force-push';
        if (pattern.startsWith('mkfs ') || pattern.startsWith('dd '))
          return 'disk-write';
        return 'destructive-delete';
      }
    }
  }
  return undefined;
}

function commandRequiresExplicitPrompt(
  command: string,
  shellPlatform: 'posix' | 'windows' = 'posix',
): boolean {
  return (
    containsShellParameterExpansion(command, shellPlatform) ||
    containsShellPathnameExpansion(command, shellPlatform) ||
    containsShellRedirection(command, shellPlatform) ||
    containsShellBraceExpansion(command) ||
    containsFindExecutor(command) ||
    containsXargsExecutor(command)
  );
}

function isProtectedResolvedDeletionPath(
  path: string,
  protectedRoot: string,
): boolean {
  const candidate = normalizeAbsolutePath(path);
  const root = normalizeAbsolutePath(protectedRoot);
  if (
    !candidate ||
    !root ||
    candidate.root !== root.root ||
    candidate.caseInsensitive !== root.caseInsensitive ||
    root.segments.some(
      (segment, index) => candidate.segments[index] !== segment,
    )
  ) {
    return false;
  }
  const relativeDepth = candidate.segments.length - root.segments.length;
  return relativeDepth >= 0 && relativeDepth <= 1;
}

function hasResolvedDeletionSafetyRisk(
  check: Extract<ApprovalCheck, { kind: 'command' }>,
): boolean {
  if (check.pathResolutionFailed) {
    return (check.protectedRoots?.length ?? 0) > 0;
  }
  if (!check.resolvedPaths?.length || !check.protectedRoots?.length) {
    return false;
  }
  return check.resolvedPaths.some((path) =>
    check.protectedRoots?.some((root) =>
      isProtectedResolvedDeletionPath(path, root),
    ),
  );
}

function commandTargetsProtectedFile(
  check: Extract<ApprovalCheck, { kind: 'command' }>,
  ctx: ApprovalEvaluationContext,
): boolean {
  if (!ctx.protectedFileWritePaths?.length) {
    return false;
  }
  if (check.pathResolutionFailed) {
    return true;
  }
  const recursiveForcedRemoval =
    recursiveForcedRemoveOperations(check.command).length > 0;
  return (
    check.resolvedPaths?.some((resolvedPath) =>
      ctx.protectedFileWritePaths?.some((protectedPath) => {
        const relation = protectedFileRelation(
          resolvedPath,
          protectedPath,
          ctx.pathCaseInsensitive,
        );
        return (
          relation === 'exact' ||
          (recursiveForcedRemoval && relation === 'ancestor')
        );
      }),
    ) === true
  );
}

/**
 * Whether the absolute `path` is a file the protected entry names, or a
 * folder above one. Entry segments match as `*` wildcards.
 */
function protectedFileRelation(
  path: string,
  protectedPath: string,
  pathCaseInsensitive = false,
): 'exact' | 'ancestor' | undefined {
  const candidate = normalizeAbsolutePath(path, pathCaseInsensitive);
  const protectedFile = normalizeAbsolutePath(
    protectedPath,
    pathCaseInsensitive,
  );
  if (
    !candidate ||
    !protectedFile ||
    candidate.root !== protectedFile.root ||
    candidate.segments.length > protectedFile.segments.length ||
    !candidate.segments.every((segment, index) =>
      tokenWildcardMatches(protectedFile.segments[index], segment, false),
    )
  ) {
    return undefined;
  }
  return candidate.segments.length === protectedFile.segments.length
    ? 'exact'
    : 'ancestor';
}

interface NormalizedAbsolutePath {
  root: string;
  segments: string[];
  caseInsensitive: boolean;
}

function normalizeAbsolutePath(
  value: string,
  forceCaseInsensitive = false,
): NormalizedAbsolutePath | null {
  const windowsPath = /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\');
  const normalizedSeparators = windowsPath ? value.replace(/\\/g, '/') : value;
  let root: string;
  let remainder: string;
  let caseInsensitive = false;

  const driveMatch = /^([A-Za-z]:)\/(.*)$/.exec(normalizedSeparators);
  if (driveMatch) {
    root = driveMatch[1].toLowerCase();
    remainder = driveMatch[2];
    caseInsensitive = true;
  } else if (
    normalizedSeparators.startsWith('//') &&
    (windowsPath || forceCaseInsensitive)
  ) {
    const parts = normalizedSeparators.slice(2).split('/');
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      return null;
    }
    root = `//${parts[0].toLowerCase()}/${parts[1].toLowerCase()}`;
    remainder = parts.slice(2).join('/');
    caseInsensitive = true;
  } else if (normalizedSeparators.startsWith('/')) {
    root = '/';
    remainder = normalizedSeparators.slice(1);
    caseInsensitive = forceCaseInsensitive;
  } else {
    return null;
  }

  const segments: string[] = [];
  for (const segment of remainder.split('/')) {
    if (!segment || segment === '.') {
      continue;
    }
    if (segment === '..') {
      if (segments.length === 0) {
        return null;
      }
      segments.pop();
      continue;
    }
    segments.push(caseInsensitive ? segment.toLowerCase() : segment);
  }
  return { root, segments, caseInsensitive };
}

function normalizedAbsolutePathForMatching(
  value: string,
  pathCaseInsensitive = false,
): string | null {
  const normalized = normalizeAbsolutePath(value, pathCaseInsensitive);
  if (!normalized) {
    return null;
  }
  const suffix = normalized.segments.join('/');
  if (normalized.root === '/') {
    return `/${suffix}`;
  }
  return suffix ? `${normalized.root}/${suffix}` : `${normalized.root}/`;
}

function isPathInsideWorkspace(
  path: string,
  workspaceRoot: string,
  pathCaseInsensitive = false,
): boolean {
  const candidate = normalizeAbsolutePath(path, pathCaseInsensitive);
  const workspace = normalizeAbsolutePath(workspaceRoot, pathCaseInsensitive);
  if (!candidate || !workspace || candidate.root !== workspace.root) {
    return false;
  }
  if (candidate.segments.length < workspace.segments.length) {
    return false;
  }
  return workspace.segments.every(
    (segment, index) => candidate.segments[index] === segment,
  );
}

/**
 * Whether a canonical read target is a protected policy file, or, for Glob
 * and Grep, a directory whose traversal would read one.
 */
function readTargetsProtectedFile(
  check: Extract<ApprovalCheck, { kind: 'tool' }>,
  ctx: ApprovalEvaluationContext,
): boolean {
  const target = check.resolvedReadPath;
  if (target === undefined) return false;
  const traverses = check.toolName === 'Glob' || check.toolName === 'Grep';
  return (
    ctx.protectedFileWritePaths?.some((path) => {
      const relation = protectedFileRelation(
        target,
        path,
        ctx.pathCaseInsensitive,
      );
      return relation === 'exact' || (traverses && relation === 'ancestor');
    }) === true
  );
}

/**
 * Evaluates a single approval check against the current mode and rule sets.
 *
 * Order of precedence:
 *   1. Hardcoded safety denies (skipped entirely in `'full-access'` mode).
 *   2. Deny rules, across all three tiers (session/project/global).
 *   3. Protected policy files prompt (writes, commands, and canonical read
 *      targets, including a Glob/Grep directory that contains one), then
 *      allow rules, across all three tiers.
 *   4. Mode-based fallback: `'full-access'` allows everything; `'auto'`
 *      allows `file-write` checks resolved inside `ctx.workspaceRoot`, and
 *      read `tool` checks whose canonical `resolvedReadPath` is inside it.
 *   5. Otherwise, prompt the user.
 */
export function evaluateApproval(
  check: ApprovalCheck,
  ctx: ApprovalEvaluationContext,
): ApprovalEvaluation {
  // The user picks the files: no rule or mode answers a file request.
  if (check.kind === 'browser-file-request') {
    return { outcome: 'prompt' };
  }
  if (ctx.mode !== 'full-access' && check.kind === 'command') {
    const safetyReason =
      safetyDeniedCommandReason(check.command, check.shellPlatform) ??
      (hasResolvedDeletionSafetyRisk(check)
        ? check.pathResolutionFailed
          ? 'unverifiable-command'
          : 'destructive-delete'
        : undefined);
    if (safetyReason) return { outcome: 'deny', safety: true, safetyReason };
  }

  const allRules: ApprovalRule[] = [
    ...ctx.rules.session,
    ...ctx.rules.project,
    ...ctx.rules.global,
  ];

  const denyMatch = findDenyMatch(
    check,
    allRules,
    ctx.workspaceRoot,
    ctx.pathCaseInsensitive,
  );
  if (denyMatch) {
    return { outcome: 'deny', matchedRule: denyMatch };
  }

  if (
    ctx.mode !== 'full-access' &&
    ((check.kind === 'file-write' &&
      ctx.protectedFileWritePaths?.some((path) =>
        check.isGrant
          ? fileGrantMayContainProtectedFile(
              check.resolvedPath ?? check.path,
              path,
              ctx.workspaceRoot,
              ctx.pathCaseInsensitive ?? false,
            )
          : protectedFileRelation(
              check.resolvedPath ?? check.path,
              path,
              ctx.pathCaseInsensitive,
            ) === 'exact',
      )) ||
      (check.kind === 'command' && commandTargetsProtectedFile(check, ctx)) ||
      (check.kind === 'tool' && readTargetsProtectedFile(check, ctx)))
  ) {
    return { outcome: 'prompt' };
  }

  const requiresExplicitPrompt =
    ctx.mode !== 'full-access' &&
    check.kind === 'command' &&
    commandRequiresExplicitPrompt(check.command, check.shellPlatform);
  if (!requiresExplicitPrompt) {
    const allowMatch = findAllowMatch(
      check,
      allRules,
      ctx.workspaceRoot,
      ctx.pathCaseInsensitive,
    );
    if (allowMatch) {
      return { outcome: 'allow', matchedRule: allowMatch };
    }
  }

  // An upload sends workspace bytes to a site, so no mode approves one
  // without a rule.
  if (check.kind === 'browser-upload') {
    return { outcome: 'prompt' };
  }

  if (ctx.mode === 'full-access') {
    return { outcome: 'allow' };
  }

  if (
    ctx.mode === 'auto' &&
    check.kind === 'file-write' &&
    ctx.workspaceRoot !== undefined &&
    isPathInsideWorkspace(
      check.resolvedPath ?? check.path,
      ctx.workspaceRoot,
      ctx.pathCaseInsensitive,
    )
  ) {
    return { outcome: 'allow' };
  }

  // Only the canonical target qualifies: an unresolved `readPath` never
  // auto-allows, unlike the write fallback above.
  if (
    ctx.mode === 'auto' &&
    check.kind === 'tool' &&
    READ_TOOL_NAMES.has(check.toolName) &&
    check.resolvedReadPath !== undefined &&
    ctx.workspaceRoot !== undefined &&
    isPathInsideWorkspace(
      check.resolvedReadPath,
      ctx.workspaceRoot,
      ctx.pathCaseInsensitive,
    )
  ) {
    return { outcome: 'allow' };
  }

  return { outcome: 'prompt' };
}

/** The only tools whose canonical target Auto may allow without a prompt. */
const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Read',
  'NotebookRead',
  'Glob',
  'Grep',
]);

/** Type guard for {@link ApprovalMode}. */
export function isApprovalMode(value: unknown): value is ApprovalMode {
  return (
    typeof value === 'string' && APPROVAL_MODES.some((mode) => mode === value)
  );
}

const VALID_BEHAVIORS: ReadonlySet<string> = new Set(['allow', 'deny']);
const VALID_ORIGINS: ReadonlySet<string> = new Set([
  'prompt',
  'settings',
  'canopy-json',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isApprovalRuleBehavior(
  value: unknown,
): value is ApprovalRule['behavior'] {
  return typeof value === 'string' && VALID_BEHAVIORS.has(value);
}

function isApprovalRuleOrigin(value: unknown): value is ApprovalRuleOrigin {
  return typeof value === 'string' && VALID_ORIGINS.has(value);
}

function normalizeApprovalRuleTarget(
  value: unknown,
): ApprovalRuleTarget | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const kind = value.kind;
  if (kind === 'command') {
    return typeof value.pattern === 'string'
      ? { kind: 'command', pattern: value.pattern }
      : undefined;
  }
  if (kind === 'file-write') {
    return typeof value.path === 'string'
      ? { kind: 'file-write', path: value.path }
      : undefined;
  }
  if (kind === 'mcp') {
    if (typeof value.server !== 'string') {
      return undefined;
    }
    if (value.tool !== undefined && typeof value.tool !== 'string') {
      return undefined;
    }
    if (value.tool === undefined) {
      return { kind: 'mcp', server: value.server };
    }
    return { kind: 'mcp', server: value.server, tool: value.tool };
  }
  if (kind === 'network') {
    return typeof value.host === 'string'
      ? { kind: 'network', host: value.host }
      : undefined;
  }
  if (kind === 'tool') {
    return typeof value.toolName === 'string'
      ? { kind: 'tool', toolName: value.toolName }
      : undefined;
  }
  if (kind === 'browser-upload') {
    if (typeof value.origin !== 'string') return undefined;
    if (value.path === undefined)
      return { kind: 'browser-upload', origin: value.origin };
    return typeof value.path === 'string'
      ? { kind: 'browser-upload', origin: value.origin, path: value.path }
      : undefined;
  }
  return undefined;
}

function normalizeApprovalRule(value: unknown): ApprovalRule | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (!isApprovalRuleBehavior(value.behavior)) {
    return undefined;
  }
  const target = normalizeApprovalRuleTarget(value.target);
  if (!target) {
    return undefined;
  }
  const id = typeof value.id === 'string' ? value.id : '';
  const createdAt = typeof value.createdAt === 'string' ? value.createdAt : '';
  const origin = isApprovalRuleOrigin(value.origin) ? value.origin : 'settings';
  return {
    id,
    behavior: value.behavior,
    target,
    createdAt,
    origin,
  };
}

/**
 * Leniently validates and normalizes unknown persisted/imported input into
 * an array of {@link ApprovalRule}. Invalid entries are dropped rather than
 * throwing; missing `origin` coerces to `'settings'` and missing
 * `createdAt` coerces to `''`.
 */
export function normalizeApprovalRules(value: unknown): ApprovalRule[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const result: ApprovalRule[] = [];
  for (const entry of value) {
    const rule = normalizeApprovalRule(entry);
    if (rule) {
      result.push(rule);
    }
  }
  return result;
}
