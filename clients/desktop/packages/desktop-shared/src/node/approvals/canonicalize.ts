import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { realpath } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join, parse, resolve } from 'node:path';
import type { ApprovalCheck } from '../../types';
import {
  recursiveForcedRemoveOperations,
  commandPathOperations,
} from '../../lib/approval-engine';
import {
  resolveExistingAncestorPath as resolvePath,
  isPathCaseInsensitiveAt,
} from './paths';

export interface CanonicalApprovalCheck {
  check: ApprovalCheck;
  workspaceRoot?: string;
  pathCaseInsensitive?: boolean;
}

function expandDestructiveOperandTilde(
  operand: string,
  effectiveCwd: string,
): string | undefined {
  if (operand === '~' || operand.startsWith('~/')) {
    return join(homedir(), operand.slice(2));
  }
  if (operand === '~+' || operand.startsWith('~+/')) {
    return join(effectiveCwd, operand.slice(3));
  }
  // `~-` is derived from shell-maintained OLDPWD state, which can change
  // within a command chain. The approval layer cannot reproduce it safely.
  if (operand === '~-' || operand.startsWith('~-/')) {
    return undefined;
  }
  if (operand.startsWith('~')) {
    const separatorIndex = operand.indexOf('/');
    const username = operand.slice(
      1,
      separatorIndex < 0 ? operand.length : separatorIndex,
    );
    let currentUsername: string;
    try {
      currentUsername = userInfo().username;
    } catch {
      return undefined;
    }
    if (username !== currentUsername) {
      return undefined;
    }
    const suffix = separatorIndex < 0 ? '' : operand.slice(separatorIndex + 1);
    return suffix ? join(homedir(), suffix) : homedir();
  }
  return operand;
}

export function createApprovalCanonicalizer(
  workspaceRootPath: string,
  protectedPaths: () => Promise<string[]>,
  resolveExistingAncestorPathFrom = resolvePath,
  pathCaseInsensitiveAt = isPathCaseInsensitiveAt,
): {
  canonicalizeCheck: (check: ApprovalCheck) => Promise<CanonicalApprovalCheck>;
  canonicalProtectedFileWritePaths: () => Promise<string[]>;
} {
  let canonicalWorkspaceRootPromise: Promise<string | undefined> | undefined;
  let canonicalProtectedRootsPromise: Promise<string[]> | undefined;
  let canonicalProtectedFileWritePathsPromise: Promise<string[]> | undefined;
  let pathCaseInsensitivePromise: Promise<boolean> | undefined;

  function resolveExistingAncestorPath(
    inputPath: string,
    basePath = workspaceRootPath,
  ): Promise<string | undefined> {
    return resolveExistingAncestorPathFrom(inputPath, basePath);
  }

  function canonicalWorkspaceRoot(): Promise<string | undefined> {
    canonicalWorkspaceRootPromise ??=
      resolveExistingAncestorPath(workspaceRootPath);
    return canonicalWorkspaceRootPromise;
  }

  function canonicalProtectedRoots(): Promise<string[]> {
    canonicalProtectedRootsPromise ??= Promise.all([
      realpath(parse(resolve(workspaceRootPath)).root).catch(() => undefined),
      realpath(homedir()).catch(() => undefined),
    ]).then((roots) =>
      Array.from(
        new Set(roots.filter((root): root is string => root !== undefined)),
      ),
    );
    return canonicalProtectedRootsPromise;
  }

  function canonicalProtectedFileWritePaths(): Promise<string[]> {
    canonicalProtectedFileWritePathsPromise ??= protectedPaths();
    return canonicalProtectedFileWritePathsPromise;
  }

  function pathCaseInsensitive(): Promise<boolean> {
    pathCaseInsensitivePromise ??= canonicalWorkspaceRoot().then(
      pathCaseInsensitiveAt,
    );
    return pathCaseInsensitivePromise;
  }

  async function canonicalizeCheck(
    approvalCheck: ApprovalCheck,
  ): Promise<CanonicalApprovalCheck> {
    if (approvalCheck.kind === 'command') {
      const caseInsensitive = await pathCaseInsensitive();
      const platformCheck: ApprovalCheck = {
        ...approvalCheck,
        shellPlatform: hostOperatingSystem() === 'win32' ? 'windows' : 'posix',
      };
      const pathOperations = commandPathOperations(approvalCheck.command);
      const destructiveOperations = recursiveForcedRemoveOperations(
        approvalCheck.command,
      );
      const operations = [...pathOperations, ...destructiveOperations];
      if (operations.length === 0) {
        return {
          check: platformCheck,
          workspaceRoot: workspaceRootPath,
          pathCaseInsensitive: caseInsensitive,
        };
      }
      const initialCwd = approvalCheck.cwd ?? workspaceRootPath;
      const operandPaths: string[] = [];
      let cwdResolutionFailed = false;
      for (const operation of operations) {
        let effectiveCwd = initialCwd;
        for (const cwdChange of operation.cwdChanges) {
          const nextCwd = await resolveExistingAncestorPath(
            cwdChange,
            effectiveCwd,
          );
          if (!nextCwd) {
            cwdResolutionFailed = true;
            break;
          }
          effectiveCwd = nextCwd;
        }
        cwdResolutionFailed ||= operation.cwdResolutionFailed;
        for (const operand of operation.operands) {
          const expandedOperand = expandDestructiveOperandTilde(
            operand,
            effectiveCwd,
          );
          if (expandedOperand === undefined) {
            cwdResolutionFailed = true;
            continue;
          }
          operandPaths.push(resolve(effectiveCwd, expandedOperand));
        }
      }
      const [resolvedPaths, protectedRoots] = await Promise.all([
        Promise.all(
          operandPaths.map((operand) => resolveExistingAncestorPath(operand)),
        ),
        destructiveOperations.length > 0
          ? canonicalProtectedRoots()
          : Promise.resolve([]),
      ]);
      const pathResolutionFailed =
        cwdResolutionFailed ||
        destructiveOperations.some(
          (operation) => operation.pathResolutionFailed,
        ) ||
        resolvedPaths.some((path) => path === undefined);
      return {
        check: {
          ...platformCheck,
          resolvedPaths: resolvedPaths.filter(
            (path): path is string => path !== undefined,
          ),
          protectedRoots,
          ...(pathResolutionFailed ? { pathResolutionFailed: true } : {}),
        },
        workspaceRoot: workspaceRootPath,
        pathCaseInsensitive: caseInsensitive,
      };
    }
    if (approvalCheck.kind === 'browser-upload') {
      // Upload paths keep the case they were asked for, so rules need the drive's.
      return {
        check: approvalCheck,
        workspaceRoot: workspaceRootPath,
        pathCaseInsensitive: await pathCaseInsensitive(),
      };
    }
    if (approvalCheck.kind === 'tool') {
      // Only this branch may set `resolvedReadPath`; drop a caller's copy so
      // Auto never trusts a canonical path main did not resolve.
      const { toolName, readPath } = approvalCheck;
      if (readPath === undefined) {
        return {
          check: { kind: 'tool', toolName },
          workspaceRoot: workspaceRootPath,
        };
      }
      // A dangling or unreadable link leaves `resolvedReadPath` unset, so Auto
      // has no canonical target and the read prompts.
      const [resolvedReadPath, workspaceRoot, caseInsensitive] =
        await Promise.all([
          resolveExistingAncestorPath(readPath),
          canonicalWorkspaceRoot(),
          pathCaseInsensitive(),
        ]);
      return {
        check: {
          kind: 'tool',
          toolName,
          readPath,
          ...(resolvedReadPath ? { resolvedReadPath } : {}),
        },
        ...(resolvedReadPath && workspaceRoot
          ? { workspaceRoot, pathCaseInsensitive: caseInsensitive }
          : {}),
      };
    }
    if (approvalCheck.kind !== 'file-write') {
      return { check: approvalCheck, workspaceRoot: workspaceRootPath };
    }
    const [resolvedPath, workspaceRoot, caseInsensitive] = await Promise.all([
      resolveExistingAncestorPath(approvalCheck.path),
      canonicalWorkspaceRoot(),
      pathCaseInsensitive(),
    ]);
    return {
      check: resolvedPath ? { ...approvalCheck, resolvedPath } : approvalCheck,
      ...(resolvedPath && workspaceRoot ? { workspaceRoot } : {}),
      ...(resolvedPath && workspaceRoot
        ? { pathCaseInsensitive: caseInsensitive }
        : {}),
    };
  }

  return { canonicalizeCheck, canonicalProtectedFileWritePaths };
}
