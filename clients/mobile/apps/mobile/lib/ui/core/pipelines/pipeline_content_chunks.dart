/// Shared with Remote Control. Computer Connect uses the Rust port in
/// cc-domain::pipelines::presentation (`content_chunks`); keep both in step
/// until cleanup C5.
library;

import 'package:mobile/data/models/computer_activity/pipeline_content.dart';

/// Most lines in one chunk of command output.
const int kPipelineContentChunkLines = 200;

/// One piece of a pipeline document as laid out on screen. Markdown stays
/// whole so its blocks keep their structure; command output is split on line
/// boundaries so a long log only lays out what is visible.
typedef PipelineContentChunk = ({bool markdown, String text});

List<PipelineContentChunk> pipelineContentChunks(
  RemotePipelineContentDocument document,
) {
  if (document.format == RemotePipelineContentFormat.markdown) {
    return [(markdown: true, text: document.text)];
  }
  final text = document.text.endsWith('\n')
      ? document.text.substring(0, document.text.length - 1)
      : document.text;
  final lines = text.split('\n');
  return [
    for (
      var start = 0;
      start < lines.length;
      start += kPipelineContentChunkLines
    )
      (
        markdown: false,
        text: lines
            .sublist(
              start,
              (start + kPipelineContentChunkLines).clamp(0, lines.length),
            )
            .join('\n'),
      ),
  ];
}
