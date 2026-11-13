import { z } from 'zod';

export type RepoRuleKind =
  | 'always'
  | 'auto'
  | 'agent-requested'
  | 'manual'
  | 'legacy-cursorrules';
export type RepoRuleFlag =
  | 'duplicate'
  | 'unsupported-frontmatter'
  | 'malformed-frontmatter'
  | 'missing-file-reference'
  | 'unsupported-glob';
export interface RepoRuleProposal {
  id: string;
  repoId: string;
  path: string;
  kind: RepoRuleKind;
  description: string;
  globs: string[];
  scope: string;
  hash: string;
  bytes: number;
  selected: boolean;
  flags: RepoRuleFlag[];
}
export interface RepoRuleSkipped {
  repoId: string;
  path: string;
  reason:
    | 'unavailable'
    | 'unsafe-path'
    | 'too-large'
    | 'changed'
    | 'limit'
    | 'unsupported-git';
}
const workspaceId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
export const repoRulesScanRequestSchema = z.strictObject({
  workspaceId,
  worktreeId: workspaceId.optional(),
});
export type RepoRulesScanRequest = z.infer<typeof repoRulesScanRequestSchema>;
export const repoRulesApplyRequestSchema = z.strictObject({
  workspaceId,
  enabled: z.boolean(),
  scanId: z.string().uuid().optional(),
  disabledRuleIds: z.array(z.string().max(4096)).max(200).optional(),
});
export type RepoRulesApplyRequest = z.infer<typeof repoRulesApplyRequestSchema>;
export interface RepoRulesStatus {
  enabled: boolean;
  disabledRuleIds: string[];
  revision: number;
  reviewedAt?: string;
  diagnostic?: 'missing' | 'invalid' | 'unsupported-version' | 'unavailable';
}
export type RepoRulesApplyResponse = RepoRulesStatus;
export interface RepoRulesScanResponse {
  scanId: string;
  enabled: boolean;
  revision: number;
  /** The selected checkout; absent means the configured source repositories. */
  worktreeId?: string;
  proposals: RepoRuleProposal[];
  nestedDirectories: Record<string, string[]>;
  skipped: RepoRuleSkipped[];
  diagnostic?: RepoRulesStatus['diagnostic'];
}
export const repoRulesPreviewRequestSchema = z.strictObject({
  workspaceId,
  scanId: z.string().uuid(),
  ruleId: z.string().max(4096),
});
export type RepoRulesPreviewRequest = z.infer<
  typeof repoRulesPreviewRequestSchema
>;
export interface RepoRulesPreviewResponse {
  body: string;
}
export interface EditorSetupPresence {
  cursorRulesPresent: boolean;
}
