import { CANOPY_INJECTED_TOOL_REGISTRY } from '@canopy/execution-engine/lib/canopy-injected-tools';
import * as nodePath from 'node:path';
import { approvalFileChangeForClaudeTool } from '@canopy/protocol/approvals';
import type {
  ApprovalCheck,
  ApprovalRequestDetails,
  ApprovalRuleTarget,
} from '../../types';
import { suggestedCommandPattern } from '../../lib/approval-engine';

interface ClaudeToolApprovalRequirement {
  check: ApprovalCheck;
  details: ApprovalRequestDetails;
  suggestedTarget: ApprovalRuleTarget;
  /**
   * Display label substituted for the raw tool name in the approval title.
   * Call sites compose `<actor> wants to use <titleTool>` so each surface
   * keeps its own actor attribution ("Claude", "Claude Code", "Agent") on the
   * most trusted line of the prompt.
   */
  titleTool?: string;
}

interface ClaudeToolCheckResult extends ClaudeToolApprovalRequirement {
  additionalRequirements?: ClaudeToolApprovalRequirement[];
  failClosedReason?: string;
}

function toolFallback(toolName: string): ClaudeToolCheckResult {
  return {
    check: { kind: 'tool', toolName },
    details: { kind: 'tool', toolName },
    suggestedTarget: { kind: 'tool', toolName },
  };
}

const CLAUDE_SKILL_DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Skill names are `<skill>` or `<plugin>:<skill>` identifiers. The name is
 * model-supplied and lands on the approval prompt, so anything outside that
 * shape (whitespace, control characters, prose that could imitate app-authored
 * copy) falls back to the generic `Skill` display instead of being rendered.
 */
const CLAUDE_SKILL_NAME_PATTERN = /^[A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)?$/;

function checkForSkill(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolCheckResult {
  const rawSkillName = input.skill;
  if (typeof rawSkillName !== 'string') {
    return toolFallback(toolName);
  }

  // The pattern requires at least one character, so empty and whitespace-only
  // names fall back rather than rendering a blank name in the prompt.
  const skillName = rawSkillName.trim();
  if (!CLAUDE_SKILL_NAME_PATTERN.test(skillName)) {
    return toolFallback(toolName);
  }

  const displayName = skillName.slice(0, CLAUDE_SKILL_DISPLAY_NAME_MAX_LENGTH);
  return {
    ...toolFallback(toolName),
    details: { kind: 'tool', toolName: displayName },
    titleTool: `skill ${displayName}`,
  };
}

function commandSuggestedTarget(command: string): ApprovalRuleTarget {
  return { kind: 'command', pattern: suggestedCommandPattern(command) };
}

function checkForCommand(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  const command = input.command;
  if (typeof command !== 'string') {
    return toolFallback(toolName);
  }
  return {
    check: { kind: 'command', command, ...(cwd ? { cwd } : {}) },
    details: { kind: 'command', command },
    suggestedTarget: commandSuggestedTarget(command),
  };
}

/** Lexical display convenience only; deliberately does not resolve symlinks. */
export function approvalFileDisplayPath(
  providerPath: string,
  cwd: string | undefined,
  paths: Pick<
    typeof nodePath,
    'relative' | 'resolve' | 'isAbsolute' | 'sep'
  > = nodePath,
): string | undefined {
  if (!providerPath || !cwd) return undefined;
  const relative = paths.relative(cwd, paths.resolve(cwd, providerPath));
  if (
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  )
    return undefined;
  return relative;
}

function checkForFileWrite(
  toolName: string,
  path: unknown,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  if (typeof path !== 'string') {
    return toolFallback(toolName);
  }
  const displayPath = approvalFileDisplayPath(path, cwd);
  const change = approvalFileChangeForClaudeTool(toolName, input);
  return {
    check: { kind: 'file-write', path },
    details: {
      kind: 'file-write',
      path,
      ...(displayPath ? { displayPath } : {}),
      ...(change ? { change } : {}),
    },
    suggestedTarget: { kind: 'file-write', path },
  };
}

/**
 * True for a Glob pattern that stays under its search root: not absolute on
 * either platform, no leading `~`, and no `..` segment on either separator,
 * inside a brace or extglob alternative (`{..,x}`, `@(..)`), or spelled with
 * escaped dots (`\.\.`), and no alternative that starts with a separator,
 * `~` or a drive letter (`{/etc,x}`) or is a `.` that can join another into
 * `..` (`.{.,}`), any of which an engine that expands or unescapes before
 * matching would follow. `{.github,docs}` stays contained.
 * Managed delegation children and Auto read containment both rely on it.
 */
export function isContainedGlobPattern(pattern: unknown): pattern is string {
  return (
    typeof pattern === 'string' &&
    !nodePath.isAbsolute(pattern) &&
    !nodePath.win32.isAbsolute(pattern) &&
    !pattern.startsWith('~') &&
    !pattern.split(/[\\/{},()|]/).includes('..') &&
    !pattern
      .replace(/\\(.)/g, '$1')
      .split(/[/{},()|]/)
      .includes('..') &&
    !/[{(|,]\s*(?:[\\/~]|[A-Za-z]:|\.(?:[.,})|\\/]|$))/.test(pattern)
  );
}

/**
 * True for a read target Auto may trust: absolute, with no `~` or `..`
 * segment. Splitting on both separators can only make it stricter.
 */
function isCertainReadPath(rawPath: string): boolean {
  return (
    nodePath.isAbsolute(rawPath) &&
    !rawPath
      .split(/[\\/]/)
      .some((segment) => segment === '..' || segment.startsWith('~'))
  );
}

/**
 * For hosts whose native-tool mappers resolve a path before this adapter runs
 * (Copilot, OpenCode): keep the read target only when every raw path argument
 * of the operation is one {@link isCertainReadPath} trusts, so a relative,
 * `~` or `..` argument the mapper collapsed still prompts in Auto. Only a Glob
 * or Grep may name no raw path, because it then searches the launch cwd. A
 * dropped target also drops the mapper's projection from the card, which then
 * shows the raw path the agent sent.
 */
export function guardMappedReadPath(
  result: ClaudeToolCheckResult,
  rawPaths: readonly unknown[],
): ClaudeToolCheckResult {
  const { check, details } = result;
  if (check.kind !== 'tool' || check.readPath === undefined) return result;
  const defaultsToCwd = check.toolName === 'Glob' || check.toolName === 'Grep';
  if (
    (rawPaths.length > 0 || defaultsToCwd) &&
    rawPaths.every(
      (value) => typeof value === 'string' && isCertainReadPath(value),
    )
  )
    return result;
  // Each host passes one operation's raw path, so the first is the target.
  const [rawPath] = rawPaths;
  const path =
    typeof rawPath === 'string'
      ? rawPath
      : details.kind === 'tool'
        ? details.path
        : undefined;
  return {
    ...result,
    check: { kind: 'tool', toolName: check.toolName },
    details:
      details.kind === 'tool'
        ? {
            kind: 'tool',
            toolName: details.toolName,
            ...(path !== undefined ? { path } : {}),
            ...(details.inputSummary !== undefined
              ? { inputSummary: details.inputSummary }
              : {}),
            ...(details.reason !== undefined ? { reason: details.reason } : {}),
          }
        : details,
  };
}

function readInputSummary(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (toolName !== 'Glob' && toolName !== 'Grep') return undefined;
  if (typeof input.pattern !== 'string') return undefined;
  if (toolName === 'Grep' && typeof input.glob === 'string' && input.glob)
    return `${input.pattern} in ${input.glob}`;
  return input.pattern;
}

/**
 * Read tools carry their target on the `tool` check so Auto can allow
 * canonical in-workspace reads. `readPath` is omitted, and the read prompts,
 * whenever its meaning is not certain: relative paths (the provider resolves
 * them against its current directory, which a shell `cd` can move away from
 * the launch cwd), any `~` segment (the provider may expand it, including
 * after a mapper joined it onto the cwd), any `..` segment (collapsing it
 * lexically before symlinks resolve can name a different file from the one
 * the OS opens), and Glob patterns that can leave their root. A Glob or Grep
 * with no `path` arrives here as the launch cwd. That relies on the provider
 * keeping its current directory inside the launch cwd's tree: Claude Code
 * resets its shell cwd when a command leaves the allowed directories, and
 * Canopy grants it none beyond the worktree.
 */
function checkForFileRead(
  toolName: string,
  rawPath: unknown,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  if (typeof rawPath !== 'string') {
    return toolFallback(toolName);
  }
  const readPath = isCertainReadPath(rawPath)
    ? nodePath.resolve(rawPath)
    : undefined;
  const containedPattern =
    toolName !== 'Glob' || isContainedGlobPattern(input.pattern);
  // An uncertain target shows exactly what the agent sent: a lexical
  // projection would collapse `link/..` into a harmless-looking name.
  const displayPath = readPath
    ? (approvalFileDisplayPath(rawPath, cwd) ??
      (cwd !== undefined && rawPath === cwd ? '.' : undefined))
    : undefined;
  const inputSummary = readInputSummary(toolName, input);
  return {
    check: {
      kind: 'tool',
      toolName,
      ...(readPath && containedPattern ? { readPath } : {}),
    },
    details: {
      kind: 'tool',
      toolName,
      path: rawPath,
      ...(displayPath ? { displayPath } : {}),
      ...(inputSummary ? { inputSummary } : {}),
    },
    suggestedTarget: { kind: 'tool', toolName },
  };
}

function checkForNetwork(
  toolName: string,
  input: Record<string, unknown>,
): ClaudeToolCheckResult {
  return checkForNetworkUrl(toolName, input.url);
}

function checkForNetworkUrl(
  toolName: string,
  url: unknown,
): ClaudeToolCheckResult {
  if (typeof url !== 'string') {
    return toolFallback(toolName);
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return toolFallback(toolName);
  }
  return {
    check: { kind: 'network', host },
    details: { kind: 'network', host },
    suggestedTarget: { kind: 'network', host },
  };
}

function networkRequirement(host: string): ClaudeToolApprovalRequirement {
  return {
    check: { kind: 'network', host },
    details: { kind: 'network', host },
    suggestedTarget: { kind: 'network', host },
  };
}

function webSearchDomainHost(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const candidate = value.trim().replace(/\.$/, '').toLowerCase();
  if (!candidate || candidate.includes('*')) {
    return undefined;
  }
  try {
    const parsed = new URL(`https://${candidate}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      return undefined;
    }
    return parsed.hostname;
  } catch {
    return undefined;
  }
}

function checkForWebSearch(
  input: Record<string, unknown>,
): ClaudeToolCheckResult {
  const allowedDomains = input.allowed_domains;
  if (!Array.isArray(allowedDomains) || allowedDomains.length === 0) {
    return {
      ...toolFallback('WebSearch'),
      failClosedReason:
        'WebSearch requires bounded allowed_domains for network approval.',
    };
  }
  const parsedHosts = allowedDomains.map(webSearchDomainHost);
  if (!parsedHosts.every((host): host is string => host !== undefined)) {
    return {
      ...toolFallback('WebSearch'),
      failClosedReason:
        'WebSearch contains an invalid or unsupported allowed domain.',
    };
  }
  const hosts = Array.from(new Set(parsedHosts));
  const [first, ...additional] = hosts.map(networkRequirement);
  return {
    ...first,
    ...(additional.length > 0 ? { additionalRequirements: additional } : {}),
  };
}

function checkForMcp(
  toolName: string,
  server: string,
  tool: string,
): ClaudeToolCheckResult {
  return {
    check: { kind: 'mcp', server, tool },
    details: { kind: 'mcp', server, tool },
    suggestedTarget: { kind: 'mcp', server, tool },
  };
}

/**
 * Derives the policy-engine `ApprovalCheck`, the renderer-facing
 * `ApprovalRequestDetails`, and a suggested "always allow/deny" rule target
 * for a given Claude tool name + input. See the tool -> check mapping table
 * in `docs/planning/2026-07-20-tool-approval-ux/plan.md` (Task 6).
 */
export function approvalCheckForClaudeTool(
  toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): ClaudeToolCheckResult {
  if (toolName === CANOPY_INJECTED_TOOL_REGISTRY.watch_command.claudeToolName)
    return checkForCommand(toolName, input, cwd);
  if (toolName === 'Bash') {
    return checkForCommand(toolName, input, cwd);
  }
  if (toolName === 'Monitor' && typeof input.command === 'string') {
    return checkForCommand(toolName, input, cwd);
  }
  if (
    toolName === 'Monitor' &&
    typeof input.ws === 'object' &&
    input.ws !== null &&
    !Array.isArray(input.ws)
  ) {
    const websocketUrl = 'url' in input.ws ? input.ws.url : undefined;
    return checkForNetworkUrl(toolName, websocketUrl);
  }
  if (toolName === 'Edit' || toolName === 'Write') {
    return checkForFileWrite(toolName, input.file_path, input, cwd);
  }
  if (toolName === 'NotebookEdit') {
    return checkForFileWrite(toolName, input.notebook_path, input, cwd);
  }
  if (toolName === 'WebFetch') {
    return checkForNetwork(toolName, input);
  }
  if (toolName === 'WebSearch') {
    return checkForWebSearch(input);
  }
  if (toolName === 'Skill') {
    return checkForSkill(toolName, input);
  }
  if (toolName === 'Read') {
    return checkForFileRead(toolName, input.file_path, input, cwd);
  }
  if (toolName === 'NotebookRead') {
    return checkForFileRead(toolName, input.notebook_path, input, cwd);
  }
  if (toolName === 'Glob' || toolName === 'Grep') {
    return checkForFileRead(toolName, input.path ?? cwd, input, cwd);
  }
  if (toolName.startsWith('mcp__')) {
    const remainder = toolName.slice('mcp__'.length);
    const separatorIndex = remainder.indexOf('__');
    if (separatorIndex > 0 && separatorIndex < remainder.length - 2) {
      const server = remainder.slice(0, separatorIndex);
      const tool = remainder.slice(separatorIndex + 2);
      if (tool.includes('__')) {
        // The SDK permission callback exposes only the flattened qualified
        // name, not separate MCP server/tool fields. A second separator is
        // therefore ambiguous (server `a` + tool `b__c` and server `a__b` +
        // tool `c` both become `mcp__a__b__c`). Deny instead of persisting an
        // approval identity that could later authorize the other pair.
        const fallback = toolFallback(toolName);
        return {
          ...fallback,
          failClosedReason:
            'Ambiguous MCP server/tool identity; denied by default.',
        };
      }
      return checkForMcp(toolName, server, tool);
    }
  }
  return toolFallback(toolName);
}
