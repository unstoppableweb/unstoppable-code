import { REMOTE_IPC_CHANNELS } from '@canopy/protocol/remote-control/channels';

export const PIPELINE_CHANNELS = {
  LIST: 'pipelines:list',
  CURATED_LIST: 'pipelines:curated-list',
  CURATED_GET: 'pipelines:curated-get',
  CURATED_IMPORT: REMOTE_IPC_CHANNELS.pipelinesCuratedImport,
  DISCOVER_PROJECT: REMOTE_IPC_CHANNELS.pipelinesDiscoverProject,
  GET: REMOTE_IPC_CHANNELS.pipelinesGet,
  SAVE: 'pipelines:save',
  DELETE: 'pipelines:delete',
  DUPLICATE: 'pipelines:duplicate',
  RESOLVE_ACTION: 'pipelines:resolve-action',
  LIST_ACTIONS: 'pipelines:list-actions',
  EXECUTE: REMOTE_IPC_CHANNELS.pipelinesExecute,
  // Whether the Run dialog may offer "Run on: Cloud" (CAN-6187).
  CLOUD_RUNS_AVAILABILITY: 'pipelines:cloud-runs-availability',
  RESUME: REMOTE_IPC_CHANNELS.pipelinesResume,
  RESUME_AUTOMATION: 'pipelines:resume-automation',
  RETRY_EXECUTION: REMOTE_IPC_CHANNELS.pipelinesRetryExecution,
  RERUN_EXECUTION: REMOTE_IPC_CHANNELS.pipelinesRerunExecution,
  CANCEL_EXECUTION: REMOTE_IPC_CHANNELS.pipelinesCancelExecution,
  RETRY_MATRIX_JOB: 'pipelines:retry-matrix-job',
  CANCEL_MATRIX_VARIANT: 'pipelines:cancel-matrix-variant',
  GET_EXECUTION: 'pipelines:get-execution',
  LIST_EXECUTIONS: 'pipelines:list-executions',
  // Worktree-scoped reads for hosted controllers (CAN-5985): the reads the
  // Portal pipeline commands run, addressed by project and worktree IDs. The
  // same values as HOSTED_IPC_CHANNELS in @canopy/protocol.
  LIST_FOR_WORKTREE: 'pipelines:list-for-worktree',
  LIST_WORKTREE_EXECUTIONS: REMOTE_IPC_CHANNELS.pipelinesListWorktreeExecutions,
  GET_WORKTREE_EXECUTION: REMOTE_IPC_CHANNELS.pipelinesGetWorktreeExecution,
  // One pipeline's detail for a worktree (`portal.pipeline.get`), for
  // browser controllers (CAN-5985).
  GET_FOR_WORKTREE: REMOTE_IPC_CHANNELS.pipelinesGetForWorktree,
  SET_EXECUTION_HIDDEN: 'pipelines:set-execution-hidden',
  EXECUTION_EVENT: REMOTE_IPC_CHANNELS.pipelinesExecutionEvent,
  STEP_OUTPUT_EVENT: 'pipelines:step-output-event',
  READ_STEP_LOG: REMOTE_IPC_CHANNELS.pipelinesReadStepLog,
  READ_REPORT_FILE: 'pipelines:read-report-file',
  RESOLVE_PLUGIN_COLLECTIONS: 'pipelines:resolve-plugin-collections',
  LIST_CAPABILITY_REFS: 'pipelines:list-capability-refs',
  SAVE_PLUGIN_COLLECTION_PREFERENCES:
    'pipelines:save-plugin-collection-preferences',
  LOAD_MODEL_ALIAS_PREFERENCES: 'pipelines:load-model-alias-preferences',
  SAVE_MODEL_ALIAS_PREFERENCES: 'pipelines:save-model-alias-preferences',
  // Shared Canopy Cloud pipeline CRUD. Each handler proxies to the singleton
  // build-time Cloud backend; renderer requests do not carry server identity.
  SHARED_LIST: 'pipelines:shared-list',
  SHARED_GET: 'pipelines:shared-get',
  SHARED_CREATE: 'pipelines:shared-create',
  ANALYZE_PACKAGE: 'pipelines:analyze-package',
  CANCEL_PACKAGE_ANALYSIS: 'pipelines:cancel-package-analysis',
  SHARED_CREATE_PACKAGED: 'pipelines:shared-create-packaged',
  PACKAGE_PROGRESS: 'pipelines:package-progress',
  PACKAGE_READINESS: 'pipelines:package-readiness',
  PACKAGE_INSTALLS_LIST: 'pipelines:package-installs-list',
  INSTALL_PACKAGE_SHARE: 'pipelines:install-package-share',
  SHARED_UPDATE_IMPACT: 'pipelines:shared-update-impact',
  SHARED_UPDATE: 'pipelines:shared-update',
  SHARED_DELETE: 'pipelines:shared-delete',
  SHARED_PUBLIC_PUBLISH: 'pipelines:shared-public-publish',
  SHARED_PUBLIC_REVOKE: 'pipelines:shared-public-revoke',
  // Shared organization / team listing for the pipeline-sharing UI. Each
  // handler proxies to the singleton build-time Canopy Cloud backend.
  SHARED_ORGANIZATIONS_LIST: 'pipelines:shared-organizations-list',
  SHARED_TEAMS_LIST: 'pipelines:shared-teams-list',
  PIPELINE_QUEUE_EVENT: 'pipelines:queue-event',
  LIST_QUEUED_EXECUTIONS: 'pipelines:list-queued-executions',
  CANCEL_QUEUED_EXECUTION: 'pipelines:cancel-queued-execution',
  // Pipeline Advisor (persistent supervisor) channels. Snapshots are stored
  // per-execution at `<executionsDir>/<executionId>/pipeline-advisor.json` and
  // pushed to the renderer via `ADVISOR_EVENT` whenever the supervisor mutates
  // a snapshot (state change, new report, error).
  RUN_ADVISOR: 'pipelines:run-advisor',
  GET_ADVISOR: 'pipelines:get-advisor',
  LIST_ADVISORS: 'pipelines:list-advisors',
  ADVISOR_EVENT: 'pipelines:advisor-event',
} as const;
