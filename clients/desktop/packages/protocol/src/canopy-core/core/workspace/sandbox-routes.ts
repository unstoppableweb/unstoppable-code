import { z } from 'zod';

import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import { CoreWorkspaceErrorSchema } from './reads';

const id = z.string().min(1).max(512);
const port = z.number().int().min(1).max(65535);

/** One sandbox's Host tab state, as Agentic Core last reported it. */
const SANDBOX_FIELDS = {
  /** Core's sandbox status; null when nothing was read. */
  sandboxStatus: z.string().nullable(),
  declaredPorts: z.array(port),
  /** Live forwarded URLs; empty unless a sandbox session is live. */
  routes: z.array(z.object({ port, url: z.string().min(1) })),
  /** The sandbox session's deadline, when Core reports one. */
  expiresAt: z.iso.datetime({ offset: true }).nullable(),
  /** Why the state is empty: Core could not be asked. */
  warnings: z.array(z.string()).optional(),
};

export const CoreWorkspaceSandboxRoutesGetParamsSchema = z.strictObject({
  workspaceId: id,
});

export const CoreWorkspaceSandboxRoutesGetResultSchema = z.object({
  hostModeEnabled: z.boolean(),
  ...SANDBOX_FIELDS,
  /**
   * A repository project's sandboxes, one per ready worktree; the fields
   * above stay empty for it. Absent for a Cowork project.
   */
  worktrees: z
    .array(
      z.object({
        worktreeId: id,
        label: z.string().nullable(),
        state: z.string().min(1),
        ...SANDBOX_FIELDS,
      }),
    )
    .optional(),
});

/**
 * A cloud project's live sandbox routes (CAN-6111). Served by the web core
 * only, so kept out of the workspace registry the desktop dispatcher serves.
 */
export const CORE_WORKSPACE_SANDBOX_QUERY_DEFINITIONS =
  defineCanopyQueryRegistry('core', {
    'core.workspace.sandboxRoutes.get': defineCanopyQuery({
      plane: 'core',
      domain: 'workspace',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.workspace.read'],
      params: CoreWorkspaceSandboxRoutesGetParamsSchema,
      result: CoreWorkspaceSandboxRoutesGetResultSchema,
      error: CoreWorkspaceErrorSchema,
    }),
  });
