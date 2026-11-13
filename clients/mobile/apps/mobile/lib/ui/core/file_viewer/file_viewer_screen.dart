import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:mobile/core/design-system/app-bar/canopy_app_bar.dart';
import 'package:mobile/core/design-system/app-bar/canopy_scaffold.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/file_viewer/file_image_screen.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_page_view.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_source.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_view_model.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';

/// Full-screen, read-only view of one file on a connected computer
/// (CAN-5130). Markdown opens formatted, with images read from the same
/// root; HTML opens rendered; an image file opens zoomable; other text opens
/// as source.
///
/// The caller owns [file] and its session: when the session ends it calls
/// [FileViewerViewModel.endSession], and the screen then closes an open
/// image. Closing the screen or ending the session also releases the decoded
/// images it shows from Flutter's image cache.
class FileViewerScreen extends StatefulWidget {
  const FileViewerScreen({super.key, required this.file});

  final FileViewerViewModel file;

  @override
  State<FileViewerScreen> createState() => _FileViewerScreenState();
}

class _FileViewerScreenState extends State<FileViewerScreen> {
  Route<void>? _imageRoute;

  /// Every image buffer this screen showed. `Image.memory` caches each one
  /// globally under `MemoryImage(bytes)`, outside the view model's budget
  /// and even after the view model evicts it. Weak references find those
  /// entries without keeping the buffers alive.
  final _shownImages = <WeakReference<Uint8List>>[];

  FileViewerViewModel get _file => widget.file;

  @override
  void initState() {
    super.initState();
    _file.addListener(_onFileChanged);
  }

  @override
  void dispose() {
    _file.removeListener(_onFileChanged);
    _releaseImages();
    super.dispose();
  }

  void _onFileChanged() {
    if (!_file.ended) return;
    if (_imageRoute case final route? when route.isActive) {
      Navigator.of(context).removeRoute(route);
    }
    _imageRoute = null;
    _releaseImages();
  }

  Future<Uint8List> _readImage(String source) =>
      _file.readImage(source).then(_trackImage);

  Uint8List _trackImage(Uint8List bytes) {
    _shownImages.removeWhere((shown) => shown.target == null);
    if (!_shownImages.any((shown) => identical(shown.target, bytes))) {
      _shownImages.add(WeakReference(bytes));
    }
    return bytes;
  }

  /// Evicts only this screen's keys; other cached images stay.
  void _releaseImages() {
    for (final shown in _shownImages) {
      if (shown.target case final bytes?) {
        imageCache.evict(MemoryImage(bytes));
      }
    }
    _shownImages.clear();
  }

  void _openImage(String source, Uint8List bytes) {
    // One image at a time, so a session change can close every one.
    if (_file.ended || (_imageRoute?.isActive ?? false)) return;
    _trackImage(bytes);
    final name = source.split(RegExp('[?#]')).first.split('/').last;
    final route = MaterialPageRoute<void>(
      fullscreenDialog: true,
      builder: (_) =>
          FileImageScreen(bytes: bytes, label: name.isEmpty ? 'Image' : name),
    );
    _imageRoute = route;
    unawaited(Navigator.of(context).push(route));
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    return ListenableBuilder(
      listenable: _file,
      builder: (context, _) {
        final folders = _file.folders;
        return CanopyScaffold(
          appBar: CanopyAppBar(
            automaticallyImplyLeading: true,
            content: Text(_file.fileName),
            subtitle: folders.isEmpty
                ? null
                : Text(
                    folders.join(' / '),
                    key: const ValueKey('file-viewer-breadcrumb'),
                    style: Theme.of(context).textTheme.bodySmall?.copyWith(
                      color: colors.foregroundSecondary,
                      fontFamily: AppTypography.monoFamily,
                    ),
                  ),
          ),
          body: Builder(
            builder: (context) {
              final padding = CanopyScaffold.contentPaddingOf(context);
              final contents = _file.contents;
              if (_file.problem case final problem?) {
                return _ProblemBody(
                  padding: padding,
                  problem: problem,
                  retrying: _file.loading,
                  onRetry: () => unawaited(_file.load()),
                );
              }
              if (_file.image case final bytes?) {
                return _ImageBody(
                  padding: padding,
                  bytes: _trackImage(bytes),
                  label: _file.fileName,
                );
              }
              if (contents == null) return _LoadingBody(padding: padding);
              return _ContentBody(
                padding: padding,
                file: _file,
                contents: contents,
                imageResolver: _readImage,
                onImageTap: _openImage,
              );
            },
          ),
        );
      },
    );
  }
}

String _problemMessage(FileViewerProblem problem) => switch (problem) {
  FileViewerProblem.invalidPath =>
    "Couldn't open this file. Its path is outside this workspace.",
  FileViewerProblem.notFound =>
    "Couldn't find this file. It may have been moved or deleted.",
  FileViewerProblem.unsupported => "This file can't be shown as text.",
  FileViewerProblem.permissionDenied =>
    "You don't have permission to open this file.",
  FileViewerProblem.offline =>
    'Your computer is offline. This file opens when it reconnects.',
  FileViewerProblem.timedOut => 'Opening this file took too long. Try again.',
  FileViewerProblem.unavailable => "Couldn't open this file. Try again.",
  FileViewerProblem.sessionEnded =>
    'The connection to your computer ended. Go back and reconnect.',
  FileViewerProblem.outdatedHost =>
    'Update the app on your computer to open this file.',
};

class _ProblemBody extends StatelessWidget {
  const _ProblemBody({
    required this.padding,
    required this.problem,
    required this.retrying,
    required this.onRetry,
  });

  final EdgeInsets padding;
  final FileViewerProblem problem;
  final bool retrying;
  final VoidCallback onRetry;

  bool get _canRetry =>
      problem == FileViewerProblem.timedOut ||
      problem == FileViewerProblem.unavailable;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: padding.add(const EdgeInsets.symmetric(horizontal: 24)),
      child: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              _problemMessage(problem),
              key: const ValueKey('file-viewer-problem'),
              textAlign: TextAlign.center,
              style: theme.textTheme.bodyMedium?.copyWith(
                color: AppColors.of(context).foregroundSecondary,
              ),
            ),
            if (_canRetry) ...[
              const SizedBox(height: 16),
              CanopyButton(
                key: const ValueKey('file-viewer-retry'),
                label: retrying ? 'Trying again…' : 'Try again',
                loading: retrying,
                variant: CanopyButtonVariant.inline,
                onPressed: retrying ? null : onRetry,
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class _ContentBody extends StatelessWidget {
  const _ContentBody({
    required this.padding,
    required this.file,
    required this.contents,
    required this.imageResolver,
    required this.onImageTap,
  });

  final EdgeInsets padding;
  final FileViewerViewModel file;
  final FileViewerText contents;
  final MessageImageResolver imageResolver;
  final MessageImageTap onImageTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = AppColors.of(context);
    final text = contents.contents;
    if (file.kind == FileViewerKind.html) {
      return Padding(
        padding: EdgeInsets.only(top: padding.top),
        child: Column(
          children: [
            _header(context),
            Expanded(child: FileViewerPageView(file: file)),
          ],
        ),
      );
    }
    if (file.hasFormattedView) {
      return _list(
        itemCount: text.isEmpty ? 0 : 1,
        itemBuilder: (_) => Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
          child: MessageMarkdown(
            key: const ValueKey('file-viewer-formatted'),
            text: text,
            selectable: true,
            style: theme.textTheme.bodyMedium?.copyWith(
              color: colors.foreground,
            ),
            // The computer cannot serve images: alt text only, no reads.
            imageResolver: file.imagesUnavailable ? null : imageResolver,
            onImageTap: onImageTap,
          ),
        ),
      );
    }
    final lines = text.isEmpty ? const <String>[] : text.split('\n');
    final lineStyle = AppTypography.code.copyWith(color: colors.foreground);
    // Source lines stay lazy so a large file does not lay out at once.
    return _list(
      itemCount: lines.length,
      itemBuilder: (index) => Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: Text(lines[index], style: lineStyle),
      ),
    );
  }

  Widget _list({
    required int itemCount,
    required Widget Function(int index) itemBuilder,
  }) => SelectionArea(
    child: ListView.builder(
      padding: padding,
      itemCount: 1 + itemCount,
      itemBuilder: (context, index) =>
          index == 0 ? _header(context) : itemBuilder(index - 1),
    ),
  );

  Widget _header(BuildContext context) {
    final noteStyle = Theme.of(context).textTheme.bodySmall?.copyWith(
      color: AppColors.of(context).foregroundSecondary,
    );
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (contents.truncated)
            _Note(
              key: const ValueKey('file-viewer-truncated'),
              text:
                  'Showing the beginning of this file. Open it on your '
                  'computer to see the rest.',
              style: noteStyle,
            ),
          if (file.hasFormattedView && file.imagesUnavailable)
            _Note(
              key: const ValueKey('file-viewer-images-unavailable'),
              text: 'Update the app on your computer to show images.',
              style: noteStyle,
            ),
          if (contents.contents.isEmpty)
            _Note(
              key: const ValueKey('file-viewer-empty'),
              text: 'This file is empty.',
              style: noteStyle,
            ),
        ],
      ),
    );
  }
}

/// An image file, zoomable in place. SVG draws as vectors.
class _ImageBody extends StatelessWidget {
  const _ImageBody({
    required this.padding,
    required this.bytes,
    required this.label,
  });

  final EdgeInsets padding;
  final Uint8List bytes;
  final String label;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    Widget failed(BuildContext context) => Text(
      "Couldn't show this image.",
      key: const ValueKey('file-viewer-image-failed'),
      style: Theme.of(
        context,
      ).textTheme.bodyMedium?.copyWith(color: colors.foregroundSecondary),
    );
    return Padding(
      padding: padding,
      child: InteractiveViewer(
        key: const ValueKey('file-viewer-image'),
        maxScale: FileImageScreen.maxScale,
        child: Center(
          child: label.toLowerCase().endsWith('.svg')
              ? SvgPicture.memory(
                  bytes,
                  semanticsLabel: label,
                  errorBuilder: (context, _, _) => failed(context),
                )
              : Image.memory(
                  bytes,
                  fit: BoxFit.contain,
                  semanticLabel: label,
                  errorBuilder: (context, _, _) => failed(context),
                ),
        ),
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note({super.key, required this.text, this.style});

  final String text;
  final TextStyle? style;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8),
    child: Text(text, style: style),
  );
}

/// Reserves the body, then shows a spinner after 200ms. A file's shape is
/// unknown until it arrives, so DESIGN.md's measured skeletons cannot apply
/// (see docs/design/feedback.md, loading skeletons).
class _LoadingBody extends StatefulWidget {
  const _LoadingBody({required this.padding});

  final EdgeInsets padding;

  @override
  State<_LoadingBody> createState() => _LoadingBodyState();
}

class _LoadingBodyState extends State<_LoadingBody>
    with SingleTickerProviderStateMixin {
  late final AnimationController _delay = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 200),
  )..forward();

  @override
  void dispose() {
    _delay.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _delay,
    builder: (context, _) => !_delay.isCompleted
        ? const SizedBox.expand()
        : Padding(
            padding: widget.padding,
            child: const Center(
              child: LoadingSpinner(
                key: ValueKey('file-viewer-loading'),
                size: 22,
              ),
            ),
          ),
  );
}
