import { WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS } from './git-worktree-writes';
import {
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
} from '../definitions';
import {
  WorkerFilesystemDirectoryListParamsSchema,
  WorkerFilesystemDirectoryListErrorSchema,
  WorkerFilesystemDirectoryListResultSchema,
  WorkerFilesystemFileReadErrorSchema,
  WorkerFilesystemFileReadParamsSchema,
  WorkerFilesystemFileReadResultSchema,
  WorkerFilesystemLinkResolveErrorSchema,
  WorkerFilesystemLinkResolveParamsSchema,
  WorkerFilesystemLinkResolveResultSchema,
  WorkerFilesystemRootsListParamsSchema,
  WorkerFilesystemRootsListErrorSchema,
  WorkerFilesystemRootsListResultSchema,
  WorkerFilesystemSearchErrorSchema,
  WorkerFilesystemSearchParamsSchema,
  WorkerFilesystemSearchResultSchema,
  WorkerFilesystemWatchEndSchema,
  WorkerFilesystemWatchErrorSchema,
  WorkerFilesystemWatchItemSchema,
  WorkerFilesystemWatchOpenResultSchema,
  WorkerFilesystemWatchParamsSchema,
} from './filesystem';
import { WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS } from './agent-providers';
import { WORKER_AGENT_USAGE_LIMITS_QUERY_DEFINITIONS } from './agent-usage-limits';
import {
  WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
  WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
} from './code-graph';
import {
  WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
} from './code-graph-reads';
import {
  WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
  WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
} from './filesystem-writes';
import {
  WORKER_GIT_QUERY_DEFINITIONS,
  WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
} from './git';
import {
  WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
} from './git-branch-writes';
import { WORKER_GIT_DIFF_QUERY_DEFINITIONS } from './git-changes';
import { WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS } from './git-executable';
import {
  WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS,
  WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS,
} from './operation-receipts';
import { WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS } from './git-merge';
import {
  WORKER_GIT_COMMIT_PUSH_INSTRUCTION_DEFINITIONS,
  WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
} from './git-sync-writes';
import { WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS } from './git-worktree-health';
import {
  WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
  WORKER_SCRIPT_QUERY_DEFINITIONS,
} from './script';
import {
  WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
  WORKER_PIPELINE_QUERY_DEFINITIONS,
  WORKER_PIPELINE_STREAM_DEFINITIONS,
} from './pipeline';

export const WORKER_FILESYSTEM_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'worker',
  {
    'worker.filesystem.roots.list': defineCanopyQuery({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      params: WorkerFilesystemRootsListParamsSchema,
      result: WorkerFilesystemRootsListResultSchema,
      error: WorkerFilesystemRootsListErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    }),
    'worker.filesystem.directory.list': defineCanopyQuery({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      params: WorkerFilesystemDirectoryListParamsSchema,
      result: WorkerFilesystemDirectoryListResultSchema,
      error: WorkerFilesystemDirectoryListErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    }),
    'worker.filesystem.file.read': defineCanopyQuery({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      params: WorkerFilesystemFileReadParamsSchema,
      result: WorkerFilesystemFileReadResultSchema,
      error: WorkerFilesystemFileReadErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    }),
    'worker.filesystem.search': defineCanopyQuery({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      params: WorkerFilesystemSearchParamsSchema,
      result: WorkerFilesystemSearchResultSchema,
      error: WorkerFilesystemSearchErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    }),
    'worker.filesystem.link.resolve': defineCanopyQuery({
      plane: 'worker',
      domain: 'filesystem',
      version: 1,
      placement: 'target-selectable',
      params: WorkerFilesystemLinkResolveParamsSchema,
      result: WorkerFilesystemLinkResolveResultSchema,
      error: WorkerFilesystemLinkResolveErrorSchema,
      idempotency: 'inherent',
      requiredGrants: ['worker.filesystem.read'],
    }),
  },
);

export const WORKER_QUERY_DEFINITIONS = defineCanopyQueryRegistry('worker', {
  ...WORKER_AGENT_PROVIDER_QUERY_DEFINITIONS,
  ...WORKER_AGENT_USAGE_LIMITS_QUERY_DEFINITIONS,
  ...WORKER_FILESYSTEM_QUERY_DEFINITIONS,
  ...WORKER_GIT_QUERY_DEFINITIONS,
  ...WORKER_GIT_EXECUTABLE_QUERY_DEFINITIONS,
  ...WORKER_GIT_REMOTE_QUERY_DEFINITIONS,
  ...WORKER_GIT_WORKTREE_HEALTH_QUERY_DEFINITIONS,
  ...WORKER_GIT_DIFF_QUERY_DEFINITIONS,
  ...WORKER_SCRIPT_QUERY_DEFINITIONS,
  ...WORKER_PIPELINE_QUERY_DEFINITIONS,
  ...WORKER_CODE_GRAPH_QUERY_DEFINITIONS,
  ...WORKER_CODE_GRAPH_READ_QUERY_DEFINITIONS,
  ...WORKER_OPERATION_RECEIPT_QUERY_DEFINITIONS,
});
export const WORKER_INSTRUCTION_DEFINITIONS = defineCanopyInstructionRegistry(
  'worker',
  {
    ...WORKER_FILESYSTEM_ENTRY_INSTRUCTION_DEFINITIONS,
    ...WORKER_FILESYSTEM_WRITE_INSTRUCTION_DEFINITIONS,
    ...WORKER_GIT_BRANCH_WRITE_INSTRUCTION_DEFINITIONS,
    ...WORKER_GIT_BRANCH_REF_INSTRUCTION_DEFINITIONS,
    ...WORKER_GIT_SYNC_WRITE_INSTRUCTION_DEFINITIONS,
    ...WORKER_GIT_COMMIT_PUSH_INSTRUCTION_DEFINITIONS,
    ...WORKER_GIT_MERGE_INSTRUCTION_DEFINITIONS,
    ...WORKER_GIT_WORKTREE_WRITE_INSTRUCTION_DEFINITIONS,
    ...WORKER_SCRIPT_INSTRUCTION_DEFINITIONS,
    ...WORKER_PIPELINE_INSTRUCTION_DEFINITIONS,
    ...WORKER_CODE_GRAPH_INSTRUCTION_DEFINITIONS,
    ...WORKER_CODE_GRAPH_WRITE_INSTRUCTION_DEFINITIONS,
    ...WORKER_OPERATION_RECEIPT_INSTRUCTION_DEFINITIONS,
  },
);
export const WORKER_STREAM_DEFINITIONS = defineCanopyStreamRegistry('worker', {
  'worker.filesystem.watch': defineCanopyStream({
    plane: 'worker',
    domain: 'filesystem',
    version: 1,
    placement: 'target-selectable',
    idempotency: 'inherent',
    requiredGrants: ['worker.filesystem.read'],
    params: WorkerFilesystemWatchParamsSchema,
    openResult: WorkerFilesystemWatchOpenResultSchema,
    item: WorkerFilesystemWatchItemSchema,
    end: WorkerFilesystemWatchEndSchema,
    error: WorkerFilesystemWatchErrorSchema,
  }),
  ...WORKER_PIPELINE_STREAM_DEFINITIONS,
});
