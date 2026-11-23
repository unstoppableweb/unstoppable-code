/// The run status vocabulary with no Flutter dependency, so the remote
/// engine's run tracker can tell an active run from a settled one.
/// Re-exported by `pipeline_run_display.dart`.
///
/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::pipelines::presentation; keep both in step until cleanup C5.
library;

/// Folds the wire's spellings onto the executor vocabulary the guards and
/// colors are written against. The desktop's portal projection sends
/// `failed` for a failed run, job or step (`mapRunStatus` in
/// `pipelines-service.ts`), where the executor and `execution-actions.ts`
/// say `failure`.
String normalizePipelineRunStatus(String status) => switch (status) {
  'failed' || 'timed_out' => 'failure',
  'completed' || 'succeeded' => 'success',
  'queued' => 'pending',
  _ => status,
};

bool isPipelineRunActive(String status) =>
    switch (normalizePipelineRunStatus(status)) {
      'pending' || 'running' || 'paused' => true,
      _ => false,
    };
