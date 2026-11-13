import { resolveFileRulePath } from '@canopy/desktop-shared/lib/approval-engine';
import type {
  ApprovalMode,
  ApprovalRule,
  ApprovalRuleScope,
} from '@canopy/desktop-shared/types';
import {
  approvalPolicyWorkspaceId,
  isPathCaseInsensitiveAt,
  protectedApprovalFileWritePaths,
  readGlobalApprovalRuleTier,
  readWorkspaceApprovalRuleTier,
  resolveExistingAncestorPath,
} from './approval-rule-sources';

/** What an approval session for a chat is created with. */
export interface ApprovalPolicySource {
  projectId: string;
  worktreeId: string;
  policyProjectId?: string;
  mode: ApprovalMode;
  sessionRules: readonly ApprovalRule[];
  /** The directory the chat's turns run in, its session's workspace root. */
  workspaceRoot?: string;
}

/**
 * A rule target in the form two chats' policies compare in. A file path is
 * absolute, resolved in the chat's root as the engine resolves it (folded
 * to lower case where the volume is case-insensitive). A command, tool, or
 * MCP grant acts in the directory the chat runs in, so it carries that root.
 */
export type EffectiveRuleTarget =
  | { kind: 'file-write'; path: string }
  | { kind: 'command'; pattern: string; root: string }
  | { kind: 'mcp'; server: string; tool?: string; root: string }
  | { kind: 'tool'; toolName: string; root: string }
  | { kind: 'network'; host: string };

export interface EffectiveApprovalRule {
  tier: ApprovalRuleScope;
  behavior: ApprovalRule['behavior'];
  /** The rule with a file path written absolute in the chat's root. */
  anchored: ApprovalRule;
  target: EffectiveRuleTarget;
}

/**
 * Everything a chat's approval session applies: its mode, every rule of the
 * session, workspace, and global tiers in the engine's order, the policy
 * files it always asks about, and the canonical root Auto writes within.
 */
export interface EffectiveApprovalPolicy {
  mode: ApprovalMode;
  root: string;
  pathCaseInsensitive: boolean;
  rules: readonly EffectiveApprovalRule[];
  protectedFileWritePaths: readonly string[];
}

function effectiveRule(
  tier: ApprovalRuleScope,
  rule: ApprovalRule,
  root: string,
  caseInsensitive: boolean,
): EffectiveApprovalRule | undefined {
  const base = { tier, behavior: rule.behavior };
  const target = rule.target;
  switch (target.kind) {
    case 'file-write': {
      const anchored = resolveFileRulePath(target.path, root);
      const path = resolveFileRulePath(target.path, root, caseInsensitive);
      if (anchored === null || path === null) return undefined;
      return {
        ...base,
        anchored: { ...rule, target: { kind: 'file-write', path: anchored } },
        target: { kind: 'file-write', path },
      };
    }
    case 'command':
      return {
        ...base,
        anchored: rule,
        target: { kind: 'command', pattern: target.pattern, root },
      };
    case 'mcp':
      return {
        ...base,
        anchored: rule,
        target: {
          kind: 'mcp',
          server: target.server,
          ...(target.tool === undefined ? {} : { tool: target.tool }),
          root,
        },
      };
    case 'tool':
      return {
        ...base,
        anchored: rule,
        target: { kind: 'tool', toolName: target.toolName, root },
      };
    case 'network':
      return {
        ...base,
        anchored: rule,
        target: {
          kind: 'network',
          host: target.host.toLowerCase().replace(/\.+$/, ''),
        },
      };
  }
}

/**
 * The policy the approval session of the chat `source` describes applies,
 * read through the same rule sources and root resolution that session
 * uses. Undefined when any part cannot be known: no root, a root that does
 * not resolve, an unreadable rule tier (the session then asks about
 * everything until it is readable), or a file rule with no absolute form.
 */
export async function effectiveApprovalPolicy(
  source: ApprovalPolicySource,
): Promise<EffectiveApprovalPolicy | undefined> {
  const workspaceRoot = source.workspaceRoot;
  if (!workspaceRoot) return undefined;
  const workspaceId = approvalPolicyWorkspaceId(source);
  const [root, workspaceTier, globalTier, protectedPaths] = await Promise.all([
    resolveExistingAncestorPath(workspaceRoot, workspaceRoot),
    readWorkspaceApprovalRuleTier(workspaceId),
    readGlobalApprovalRuleTier(),
    protectedApprovalFileWritePaths(workspaceId, workspaceRoot),
  ]);
  if (!root || workspaceTier.unreadable || globalTier.unreadable) {
    return undefined;
  }
  const caseInsensitive = await isPathCaseInsensitiveAt(root);
  const tiers: [ApprovalRuleScope, readonly ApprovalRule[]][] = [
    ['session', source.sessionRules],
    ['project', workspaceTier.rules],
    ['global', globalTier.rules],
  ];
  const rules: EffectiveApprovalRule[] = [];
  for (const [tier, tierRules] of tiers) {
    for (const rule of tierRules) {
      const effective = effectiveRule(tier, rule, root, caseInsensitive);
      if (!effective) return undefined;
      rules.push(effective);
    }
  }
  const protectedFileWritePaths: string[] = [];
  for (const path of protectedPaths) {
    const resolved = resolveFileRulePath(path, root, caseInsensitive);
    if (resolved === null) return undefined;
    protectedFileWritePaths.push(resolved);
  }
  return {
    mode: source.mode,
    root,
    pathCaseInsensitive: caseInsensitive,
    rules,
    protectedFileWritePaths,
  };
}
