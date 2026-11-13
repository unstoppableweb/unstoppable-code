import type { ApprovalMode, ApprovalRule } from '@canopy/desktop-shared/types';
import { ruleMatchesCheck } from '@canopy/desktop-shared/lib/approval-engine';
import path from 'node:path';
import type {
  EffectiveApprovalPolicy,
  EffectiveApprovalRule,
  EffectiveRuleTarget,
} from './effective-approval-policy';
import { isApprovalModeDowngrade } from './live-approval-modes';

/** Whether `inner` is `outer` or lies under it; unknown roots never are. */
export function isRootWithin(
  outer: string | undefined,
  inner: string | undefined,
): boolean {
  if (!outer || !inner) return false;
  const base = path.resolve(outer);
  const candidate = path.resolve(inner);
  return candidate === base || candidate.startsWith(base + path.sep);
}

const hasWildcard = (value: string): boolean => /[*?]/.test(value);

/**
 * Whether every file the absolute pattern `inner` names, `outer` names too:
 * the same pattern, a concrete path `outer` matches, or a pattern under a
 * wildcard-free folder that `outer` names with everything below it.
 */
function filePatternCovers(
  outer: string,
  inner: string,
  caseInsensitive: boolean,
): boolean {
  if (outer === inner) return true;
  if (!hasWildcard(inner)) {
    const rule: ApprovalRule = {
      id: 'cover',
      behavior: 'allow',
      target: { kind: 'file-write', path: outer },
      createdAt: '',
      origin: 'prompt',
    };
    return ruleMatchesCheck(
      rule,
      { kind: 'file-write', path: inner, resolvedPath: inner },
      undefined,
      caseInsensitive,
    );
  }
  if (!outer.endsWith('/**')) return false;
  const folder = outer.slice(0, -'/**'.length);
  return !hasWildcard(folder) && inner.startsWith(`${folder}/`);
}

function hostCovers(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const suffix = outer.startsWith('*.') ? outer.slice(1) : undefined;
  return (
    suffix !== undefined &&
    !hasWildcard(inner) &&
    inner.length > suffix.length &&
    inner.endsWith(suffix)
  );
}

/**
 * Whether `outer` applies to everything `inner` does. Grants compare their
 * roots too (`rooted`), since a command runs where its chat runs; a deny
 * refuses its target wherever the chat holding it runs.
 */
function targetCovers(
  outer: EffectiveRuleTarget,
  inner: EffectiveRuleTarget,
  caseInsensitive: boolean,
  rooted: boolean,
): boolean {
  const sameRoot = (a: { root: string }, b: { root: string }): boolean =>
    !rooted || a.root === b.root;
  switch (inner.kind) {
    case 'file-write':
      return (
        outer.kind === 'file-write' &&
        filePatternCovers(outer.path, inner.path, caseInsensitive)
      );
    case 'command':
      return (
        outer.kind === 'command' &&
        outer.pattern === inner.pattern &&
        sameRoot(outer, inner)
      );
    case 'mcp':
      return (
        outer.kind === 'mcp' &&
        outer.server === inner.server &&
        (outer.tool === undefined || outer.tool === inner.tool) &&
        sameRoot(outer, inner)
      );
    case 'tool':
      return (
        outer.kind === 'tool' &&
        outer.toolName === inner.toolName &&
        sameRoot(outer, inner)
      );
    case 'network':
      return outer.kind === 'network' && hostCovers(outer.host, inner.host);
  }
}

const withBehavior = (
  policy: EffectiveApprovalPolicy,
  behavior: ApprovalRule['behavior'],
): EffectiveApprovalRule[] =>
  policy.rules.filter((rule) => rule.behavior === behavior);

/**
 * Whether the chat with the effective policy `target` can never approve
 * without asking something the chat with `bound` would ask about or
 * refuse. Both are what their approval sessions apply (every tier, file
 * paths absolute in each chat's own root), and either one missing refuses:
 *
 * - the target's mode is no broader, and an Auto target's root lies within
 *   an Auto bound's root;
 * - every grant the target holds, the bound holds too: a file path at the
 *   same absolute path or under a folder the bound grants, a command, tool,
 *   or MCP grant in the same root, a network host the bound's host covers
 *   (a Full Access bound grants everything);
 * - every policy file the bound always asks about, the target asks about;
 * - every deny the bound holds, the target holds at the same absolute path
 *   or a broader one.
 */
export function isApprovalPolicyWithin(
  target: EffectiveApprovalPolicy | undefined,
  bound: EffectiveApprovalPolicy | undefined,
): boolean {
  if (!target || !bound) return false;
  if (target.pathCaseInsensitive !== bound.pathCaseInsensitive) return false;
  const caseInsensitive = bound.pathCaseInsensitive;
  if (isApprovalModeDowngrade(target.mode, bound.mode)) return false;
  if (
    target.mode === 'auto' &&
    bound.mode !== 'full-access' &&
    !isRootWithin(bound.root, target.root)
  ) {
    return false;
  }
  if (bound.mode !== 'full-access') {
    const boundAllows = withBehavior(bound, 'allow');
    const allowsHeld = withBehavior(target, 'allow').every((grant) =>
      boundAllows.some((held) =>
        targetCovers(held.target, grant.target, caseInsensitive, true),
      ),
    );
    if (
      !allowsHeld ||
      !bound.protectedFileWritePaths.every((protectedPath) =>
        target.protectedFileWritePaths.includes(protectedPath),
      )
    ) {
      return false;
    }
  }
  const targetDenies = withBehavior(target, 'deny');
  return withBehavior(bound, 'deny').every((deny) =>
    targetDenies.some((held) =>
      targetCovers(held.target, deny.target, caseInsensitive, false),
    ),
  );
}

/**
 * The mode a chat an agent starts begins in: the stricter of the calling
 * chat's mode and the mode a new chat at the destination gets.
 */
export function startedChatApprovalMode(
  callerMode: ApprovalMode,
  destinationDefaultMode: ApprovalMode,
): ApprovalMode {
  return isApprovalModeDowngrade(callerMode, destinationDefaultMode)
    ? destinationDefaultMode
    : callerMode;
}

/**
 * The session deny rules a chat an agent starts is seeded with: every deny
 * of every tier of each policy, with file paths absolute in that policy's
 * root, so a deny keeps protecting the files it named wherever the started
 * chat runs. Allow grants are never inherited.
 */
export function inheritedDenyRules(
  ...policies: readonly EffectiveApprovalPolicy[]
): ApprovalRule[] {
  const seen = new Set<string>();
  const idUses = new Map<string, number>();
  const rules: ApprovalRule[] = [];
  for (const policy of policies) {
    for (const { anchored } of withBehavior(policy, 'deny')) {
      const key = JSON.stringify(anchored.target);
      if (seen.has(key)) continue;
      seen.add(key);
      const uses = idUses.get(anchored.id) ?? 0;
      idUses.set(anchored.id, uses + 1);
      rules.push(
        uses === 0 ? anchored : { ...anchored, id: `${anchored.id}:${uses}` },
      );
    }
  }
  return rules;
}

/** `policy` with the deny rules of `from` added, as a stricter bound. */
export function withDeniesOf(
  policy: EffectiveApprovalPolicy,
  from: EffectiveApprovalPolicy,
): EffectiveApprovalPolicy {
  return {
    ...policy,
    rules: [...policy.rules, ...withBehavior(from, 'deny')],
  };
}
