import { z } from 'zod';

/** Controlled diagnostics only: never provider values, paths or exception text. */
export const WorkerPipelineSetupFailureSchema = z.enum([
  'resource-selection',
  'unsupported-platform',
  'managed-policy',
  'codex-profile-mismatch',
  'dynamic-settings',
  'dynamic-directory',
  'outside-worktree',
  'claude-profile-mismatch',
  'native-mcp',
  'agent-configuration',
  'preferences-fact',
  'policy-fact',
  'gateway-fact',
  'claude-profile-fact',
  'codex-profile-fact',
  'worktree-fact',
  'settings-dependency',
  'codex-config-read',
  'codex-provider',
  'codex-connection',
  'codex-tools',
  'codex-providers',
  'codex-layer',
  'ambient-resources',
  'mod-admission',
  'changed-facts',
  'invalid-snapshot',
  'setup-inspection',
  'daemon-validation',
  'daemon-shape',
  'daemon-snapshot',
  'daemon-facts',
  'daemon-route',
  'daemon-leases',
]);
export type WorkerPipelineSetupFailure = z.infer<
  typeof WorkerPipelineSetupFailureSchema
>;
