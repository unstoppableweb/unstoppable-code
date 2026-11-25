/// Mobile side of `portal.pipeline.content.read` (CAN-3717,
/// `RemoteControlPipelineContentReadResult` in
/// `packages/protocol/src/remote-control/shell/index.ts`).
library;

/// What a content read reads: one step's readable output, or the run's
/// saved report.
sealed class RemotePipelineContentSource {
  const RemotePipelineContentSource();

  Map<String, Object> toJson();
}

final class RemotePipelineStepOutputSource extends RemotePipelineContentSource {
  const RemotePipelineStepOutputSource({
    required this.jobId,
    required this.stepId,
  });

  /// The physical job id: a matrix variant's own id.
  final String jobId;
  final String stepId;

  @override
  Map<String, Object> toJson() => {
    'kind': 'step_output',
    'jobId': jobId,
    'stepId': stepId,
  };
}

final class RemotePipelineReportSource extends RemotePipelineContentSource {
  const RemotePipelineReportSource();

  @override
  Map<String, Object> toJson() => {'kind': 'report'};
}

/// Markdown or a section of command output projected by the core.
typedef PipelineContentChunk = ({bool markdown, String text});
