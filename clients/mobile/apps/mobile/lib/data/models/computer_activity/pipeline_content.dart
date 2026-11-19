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

/// Agent output and reports are Markdown; command output is plain text.
enum RemotePipelineContentFormat { markdown, text }

/// A complete document, joined from its pages.
class RemotePipelineContentDocument {
  const RemotePipelineContentDocument({
    required this.format,
    required this.text,
  });

  final RemotePipelineContentFormat format;
  final String text;
}

/// One page of a document. The document is complete when [nextOffset]
/// equals [length].
class RemotePipelineContentPage {
  const RemotePipelineContentPage({
    required this.format,
    required this.content,
    required this.offset,
    required this.nextOffset,
    required this.length,
    required this.revision,
  });

  final RemotePipelineContentFormat format;
  final String content;
  final int offset;
  final int nextOffset;
  final int length;
  final String revision;

  /// Null when a field is missing or the offsets are inconsistent.
  static RemotePipelineContentPage? fromJson(Map<String, dynamic> json) {
    final format = switch (json['format']) {
      'markdown' => RemotePipelineContentFormat.markdown,
      'text' => RemotePipelineContentFormat.text,
      _ => null,
    };
    if (json
        case {
          'content': final String content,
          'offset': final int offset,
          'nextOffset': final int nextOffset,
          'length': final int length,
          'revision': final String revision,
        }
        when format != null &&
            offset >= 0 &&
            nextOffset == offset + content.length &&
            nextOffset <= length) {
      return RemotePipelineContentPage(
        format: format,
        content: content,
        offset: offset,
        nextOffset: nextOffset,
        length: length,
        revision: revision,
      );
    }
    return null;
  }
}
