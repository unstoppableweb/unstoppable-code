import { basename, dirname } from 'node:path';
import type {
  CanopyCallerDescriptor,
  CanopyInstructionHandler,
  CanopyQueryHandler,
  CoreWorkspaceInstructionsGetResult,
  CoreWorkspaceInstructionsUpdateResult,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';
import {
  instructionFileErrorCode,
  mergeMultiRepoGuidance,
  UnsupportedInstructionLayoutError,
  type InstructionFileTarget,
  type MultiRepoGuidanceHeadings,
} from './instruction-files';

/** Read a target's instructions; a missing file is empty, other failures throw. */
export async function readInstructionTarget(
  target: Pick<InstructionFileTarget, 'filePath'>,
  files: { readText(path: string): Promise<string> },
): Promise<string> {
  try {
    return await files.readText(target.filePath);
  } catch (error) {
    // Only "no file yet" is empty. Any other failure must propagate so an
    // unreadable file is never shown, and then saved back, as empty.
    if (error instanceof Error && instructionFileErrorCode(error) === 'ENOENT')
      return '';
    throw error;
  }
}

/** Write a target's instructions, creating its folder and keeping its mirror. */
export async function writeInstructionTarget(
  target: Pick<InstructionFileTarget, 'filePath' | 'mirrorPath'>,
  content: string,
  files: {
    ensureDirectory(path: string): Promise<void>;
    writeTarget(
      target: Pick<InstructionFileTarget, 'filePath' | 'mirrorPath'>,
      content: string,
    ): Promise<void>;
  },
): Promise<void> {
  await files.ensureDirectory(dirname(target.filePath));
  await files.writeTarget(target, content);
}

/**
 * Host port for `core.workspace.instructions.*`. The host resolves the
 * instruction location from trusted workspace state and owns the writes.
 */
export interface CoreWorkspaceInstructionsHost {
  read(workspaceId: string): Promise<string>;
  write(
    workspaceId: string,
    content: string,
    caller: CanopyCallerDescriptor,
  ): Promise<void>;
  /** Whether a host error rejected the workspace ID before any effect. */
  isInvalidWorkspaceId(error: unknown): boolean;
}

export interface CoreWorkspaceInstructionsHandlers {
  queries: {
    'core.workspace.instructions.get': CanopyQueryHandler<
      'core.workspace.instructions.get',
      CanopyHandlerContext
    >;
  };
  instructions: {
    'core.workspace.instructions.update': CanopyInstructionHandler<
      'core.workspace.instructions.update',
      CanopyHandlerContext
    >;
  };
}

// The original error stays the runtime cause so in-process projections can
// rethrow it with its exact message.
function typedError(
  error: unknown,
  host: CoreWorkspaceInstructionsHost,
): unknown {
  const message = error instanceof Error ? error.message.slice(0, 4_096) : '';
  if (message && host.isInvalidWorkspaceId(error))
    return new CanopyOperationError(
      {
        kind: 'invalid_argument',
        code: 'core.workspace.instructions.invalidWorkspaceId',
        message,
        retry: { kind: 'never' },
      },
      error,
    );
  if (message && error instanceof UnsupportedInstructionLayoutError)
    return new CanopyOperationError(
      {
        kind: 'failed_precondition',
        code: 'core.workspace.instructions.unsupportedLayout',
        message,
        retry: { kind: 'never' },
      },
      error,
    );
  return error;
}

export function createCoreWorkspaceInstructionsHandlers(
  host: CoreWorkspaceInstructionsHost,
): CoreWorkspaceInstructionsHandlers {
  return {
    queries: {
      'core.workspace.instructions.get': async ({
        workspaceId,
      }): Promise<CoreWorkspaceInstructionsGetResult> => {
        try {
          return { content: await host.read(workspaceId) };
        } catch (error) {
          throw typedError(error, host);
        }
      },
    },
    instructions: {
      'core.workspace.instructions.update': async (
        { workspaceId, content },
        context,
      ): Promise<CoreWorkspaceInstructionsUpdateResult> => {
        try {
          await host.write(workspaceId, content, context.caller);
          return {};
        } catch (error) {
          throw typedError(error, host);
        }
      },
    },
  };
}

/*
 * Create and regenerate are library functions, not wire operations: the
 * W5-owned flows (CAN-3806, CAN-3819) call them in process, between their own
 * boundary steps, so no repository lock spans them.
 */

export interface InstructionScaffoldPort {
  writeClaudeMd(content: string): Promise<void>;
  /** The caller's own AGENTS.md alias variant; their platform rules differ. */
  ensureAgentsMdAlias(): Promise<void>;
}

/** Write a new workspace's default `CLAUDE.md`, then its alias when requested. */
export async function scaffoldWorkspaceInstructions(
  input: { readonly content: string; readonly agentsMdAlias: boolean },
  port: InstructionScaffoldPort,
): Promise<void> {
  await port.writeClaudeMd(input.content);
  if (input.agentsMdAlias) await port.ensureAgentsMdAlias();
}

export interface InstructionTargetPort {
  readText(path: string): Promise<string>;
  write(target: InstructionFileTarget, content: string): Promise<void>;
}

/**
 * Regenerate a converted project's instructions: `replace` writes the
 * default, `update` replaces only the generated guidance block, `keep` leaves
 * existing instructions alone, and a project with no instructions gets the
 * default in every mode. `target` is absent for `unchanged` and for
 * unsupported layouts, which are never written.
 */
export async function regenerateProjectInstructions(
  input: {
    readonly target: InstructionFileTarget | undefined;
    readonly mode: 'replace' | 'update' | 'keep';
    readonly defaultContent: string;
    readonly headings: MultiRepoGuidanceHeadings;
  },
  port: InstructionTargetPort,
): Promise<void> {
  const { target } = input;
  if (!target) return;
  if (!target.exists || input.mode === 'replace') {
    await port.write(target, input.defaultContent);
    return;
  }
  if (input.mode === 'keep') return;
  const current = await port.readText(target.filePath);
  await port.write(
    target,
    mergeMultiRepoGuidance(current, input.defaultContent, input.headings),
  );
}

/** Apply edited instructions from a source change; equal content is skipped. */
export async function applyProjectInstructionsChange(
  target: InstructionFileTarget | undefined,
  content: string,
  port: InstructionTargetPort,
): Promise<void> {
  if (!target) return;
  const existing = target.exists ? await port.readText(target.filePath) : '';
  if (existing === content) return;
  await port.write(target, content);
}

export interface WorkspaceRootInstructionsPort {
  resolve(dir: string): Promise<InstructionFileTarget>;
  agentsMdExists(): Promise<boolean>;
  ensureAgentsMdAlias(): Promise<void>;
  restore(
    source: InstructionFileTarget,
    target: InstructionFileTarget,
  ): Promise<void>;
}

/**
 * Keep or restore a workspace root's instructions. Existing project-owned
 * files are never replaced; an existing `CLAUDE.md` gains an `AGENTS.md`
 * alias only when none exists, and a restore adds one only for a restored
 * `CLAUDE.md` into a target with no alias of its own.
 */
export async function restoreWorkspaceRootInstructions(
  input: {
    readonly targetDir: string;
    readonly sourceDir: string;
    readonly restore: boolean;
  },
  port: WorkspaceRootInstructionsPort,
): Promise<void> {
  const existing = await port.resolve(input.targetDir);
  if (existing.exists) {
    if (
      basename(existing.filePath) === 'CLAUDE.md' &&
      !(await port.agentsMdExists())
    ) {
      await port.ensureAgentsMdAlias();
    }
    return;
  }
  if (!input.restore) return;
  const source = await port.resolve(input.sourceDir);
  if (!source.exists) return;
  await port.restore(source, existing);
  if (!existing.aliasPath && basename(source.filePath) === 'CLAUDE.md')
    await port.ensureAgentsMdAlias();
}
