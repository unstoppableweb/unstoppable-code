import 'package:flutter/material.dart';
import 'package:mobile/data/models/computer_activity/pipeline_content.dart';
import 'package:mobile/data/models/computer_activity/action_exception.dart';
import 'pipeline_unavailable.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';

/// Loads a pipeline document once and shows its loading, unavailable, error
/// and empty states, handing a loaded document with content to [builder].
class PipelineContentLoader extends StatefulWidget {
  const PipelineContentLoader({
    super.key,
    required this.supported,
    required this.load,
    required this.emptyMessage,
    required this.builder,
  });

  /// Whether the desktop can serve the complete content at all.
  final bool supported;
  final Future<List<PipelineContentChunk>> Function() load;
  final String emptyMessage;
  final Widget Function(BuildContext context, List<PipelineContentChunk> chunks)
  builder;

  @override
  State<PipelineContentLoader> createState() => _PipelineContentLoaderState();
}

class _PipelineContentLoaderState extends State<PipelineContentLoader> {
  Future<List<PipelineContentChunk>>? _document;

  @override
  void initState() {
    super.initState();
    if (widget.supported) _document = widget.load();
  }

  void _retry() {
    final document = widget.load();
    setState(() {
      _document = document;
    });
  }

  @override
  Widget build(BuildContext context) {
    final document = _document;
    if (document == null) {
      return const _ContentNotice(
        key: ValueKey('pipeline-content-unsupported'),
        message: kRemotePipelineContentUnsupported,
      );
    }
    return FutureBuilder<List<PipelineContentChunk>>(
      future: document,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Padding(
            key: ValueKey('pipeline-content-loading'),
            padding: EdgeInsets.all(24),
            child: Center(child: CircularProgressIndicator()),
          );
        }
        final error = snapshot.error;
        if (error != null) {
          return _ContentNotice(
            key: const ValueKey('pipeline-content-error'),
            message: error is RemoteControlException
                ? error.message
                : "Couldn't load this content.",
            onRetry: _retry,
          );
        }
        final loaded = snapshot.requireData;
        if (loaded.isEmpty) {
          return _ContentNotice(
            key: const ValueKey('pipeline-content-empty'),
            message: widget.emptyMessage,
          );
        }
        return widget.builder(context, loaded);
      },
    );
  }
}

/// One chunk: rendered Markdown, or command output in a monospace face.
class PipelineContentChunkView extends StatelessWidget {
  const PipelineContentChunkView({super.key, required this.chunk});

  final PipelineContentChunk chunk;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    if (chunk.markdown) {
      return MessageMarkdown(
        text: chunk.text,
        style: theme.textTheme.bodyMedium,
        selectable: true,
      );
    }
    return SelectableText(
      chunk.text,
      style: theme.textTheme.bodySmall?.copyWith(
        fontFamily: AppTypography.monoFamily,
        color: AppColors.of(context).foreground,
      ),
    );
  }
}

class _ContentNotice extends StatelessWidget {
  const _ContentNotice({super.key, required this.message, this.onRetry});

  final String message;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            message,
            textAlign: TextAlign.center,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          if (onRetry case final retry?) ...[
            const SizedBox(height: 12),
            FilledButton.tonal(
              key: const ValueKey('pipeline-content-retry'),
              onPressed: retry,
              child: const Text('Try again'),
            ),
          ],
        ],
      ),
    );
  }
}
