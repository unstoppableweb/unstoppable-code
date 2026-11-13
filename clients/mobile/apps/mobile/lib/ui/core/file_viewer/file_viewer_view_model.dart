import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_path.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_source.dart';
import 'package:mobile/ui/core/widgets/message_markdown_image.dart';

const _markdownExtensions = {'md', 'markdown', 'mdx'};
const _htmlExtensions = {'html', 'htm'};
const _imageExtensions = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'};

/// Default budget for the encoded image bytes one viewer keeps in memory.
const fileViewerImageCacheBytes = 20 * 1024 * 1024;

/// How the file is shown.
enum FileViewerKind { text, markdown, html, image }

/// Reads one root-scoped file and the files it links to: the images in its
/// Markdown, or the assets of a rendered page (CAN-5130). Images are kept in memory only, under an encoded-byte budget,
/// and only for this screen's session: [endSession] and [dispose] drop them
/// and make every pending read answer with a failure.
class FileViewerViewModel extends ChangeNotifier {
  FileViewerViewModel({
    required this.source,
    required String path,
    required this._online,
    this.imageCacheBytes = fileViewerImageCacheBytes,
  }) : _requestedPath = path,
       _path = normalizeFileViewerPath(path);

  final FileViewerSource source;

  /// Upper bound on retained encoded image bytes.
  final int imageCacheBytes;

  final String _requestedPath;

  /// Null when the requested path is unsafe; nothing is read then.
  final String? _path;

  bool _online;
  bool _loading = false;
  FileViewerText? _contents;
  Uint8List? _image;
  FileViewerProblem? _problem;
  bool _imagesUnavailable = false;
  int _loadSeq = 0;

  /// Bumped by [endSession] and [dispose]; reads from an older epoch are
  /// discarded.
  int _epoch = 0;
  bool _ended = false;
  bool _disposed = false;

  /// Least recently used first.
  final _images = <String, Uint8List>{};
  int _retainedBytes = 0;
  final _pendingImages = <String, Future<Uint8List>>{};

  List<String> get _segments => _requestedPath
      .split('/')
      .where((segment) => segment.isNotEmpty && segment != '.')
      .toList();

  String get fileName => _segments.lastOrNull ?? _requestedPath;

  /// The normalized root-relative path, or null when it was unsafe.
  String? get path => _path;

  /// Folder names from the root to the file, for the breadcrumb.
  List<String> get folders {
    final segments = _segments;
    return segments.isEmpty
        ? const []
        : segments.sublist(0, segments.length - 1);
  }

  FileViewerKind get kind {
    final name = fileName;
    final dot = name.lastIndexOf('.');
    final extension = dot > 0 ? name.substring(dot + 1).toLowerCase() : '';
    if (_markdownExtensions.contains(extension)) return FileViewerKind.markdown;
    if (_htmlExtensions.contains(extension)) return FileViewerKind.html;
    if (_imageExtensions.contains(extension)) return FileViewerKind.image;
    return FileViewerKind.text;
  }

  bool get isMarkdown => kind == FileViewerKind.markdown;

  /// Markdown and HTML show only their formatted view: rendered Markdown, or
  /// the rendered page. Other text shows as source.
  bool get hasFormattedView =>
      kind == FileViewerKind.markdown || kind == FileViewerKind.html;

  bool get loading => _loading;
  FileViewerText? get contents => _contents;

  /// The loaded bytes of an image file.
  Uint8List? get image => _image;
  FileViewerProblem? get problem => _problem;

  /// The session that served this file ended; the screen closes anything it
  /// opened from it.
  bool get ended => _ended;

  /// The computer cannot serve images; Markdown shows alt text instead.
  bool get imagesUnavailable => _imagesUnavailable;

  @visibleForTesting
  int get retainedImageBytes => _retainedBytes;

  /// Reading again when the computer returns replaces the offline notice.
  void setOnline(bool online) {
    final returned = online && !_online;
    _online = online;
    if (returned && _problem == FileViewerProblem.offline) unawaited(load());
  }

  /// Loads the file, or reloads it after a failure.
  Future<void> load() async {
    if (_ended || _disposed) return;
    final seq = ++_loadSeq;
    final epoch = _epoch;
    final path = _path;
    if (path == null || !_online) {
      _settle(
        problem: path == null
            ? FileViewerProblem.invalidPath
            : FileViewerProblem.offline,
      );
      return;
    }
    // A failure stays visible while it is retried, so nothing blanks.
    _loading = true;
    notifyListeners();
    FileViewerText? contents;
    Uint8List? image;
    FileViewerProblem? problem;
    try {
      if (kind == FileViewerKind.image) {
        image = await source.readBytes(path);
      } else {
        contents = await source.readText(path);
      }
    } on FileViewerException catch (error) {
      problem = error.problem;
    } catch (_) {
      problem = FileViewerProblem.unavailable;
    }
    if (_disposed || epoch != _epoch || seq != _loadSeq) return;
    _settle(contents: contents, image: image, problem: problem);
  }

  void _settle({
    FileViewerText? contents,
    Uint8List? image,
    FileViewerProblem? problem,
  }) {
    _loading = false;
    _contents = contents;
    _image = image;
    _problem = problem;
    notifyListeners();
  }

  /// The session changed; nothing read under it may stay visible.
  void endSession() {
    if (_ended || _disposed) return;
    _ended = true;
    _discardSession();
    _settle(problem: FileViewerProblem.sessionEnded);
  }

  @override
  void dispose() {
    _disposed = true;
    _discardSession();
    super.dispose();
  }

  void _discardSession() {
    _epoch++;
    _images.clear();
    _retainedBytes = 0;
    _pendingImages.clear();
  }

  /// [MessageImageResolver] for the formatted Markdown. Rejected sources,
  /// remote URLs and failures throw a [MessageImageFailure] without I/O.
  Future<Uint8List> readImage(String reference) {
    if (_ended || _disposed) {
      return Future.error(MessageImageFailure.unavailable);
    }
    final document = _path;
    final path = document == null
        ? null
        : resolveFileViewerLinkPath(documentPath: document, source: reference);
    if (path == null || _imagesUnavailable) {
      return Future.error(MessageImageFailure.unsupported);
    }
    final cached = _images.remove(path);
    if (cached != null) {
      _images[path] = cached;
      return Future.value(cached);
    }
    if (_pendingImages[path] case final pending?) return pending;
    final read = _readImage(path, _epoch);
    _pendingImages[path] = read;
    read.whenComplete(() {
      if (identical(_pendingImages[path], read)) {
        _pendingImages.remove(path);
      }
    }).ignore();
    return read;
  }

  Future<Uint8List> _readImage(String path, int epoch) async {
    final Uint8List bytes;
    try {
      bytes = await source.readBytes(path);
    } on FileViewerException catch (error) {
      if (epoch != _epoch) throw MessageImageFailure.unavailable;
      if (error.problem == FileViewerProblem.outdatedHost) {
        if (!_imagesUnavailable) {
          _imagesUnavailable = true;
          notifyListeners();
        }
        throw MessageImageFailure.unsupported;
      }
      throw _imageFailure(error.problem);
    } catch (_) {
      throw MessageImageFailure.unavailable;
    }
    if (epoch != _epoch) throw MessageImageFailure.unavailable;
    _retain(path, bytes);
    return bytes;
  }

  /// A file the rendered page asks for, by root-relative [path]. Null when
  /// it cannot be read; the page then sees an empty response. The page
  /// itself comes from the text already loaded.
  Future<Uint8List?> readPageAsset(String path) async {
    if (_ended || _disposed) return null;
    if (path == _path) {
      final contents = _contents;
      return contents == null ? null : utf8.encode(contents.contents);
    }
    final epoch = _epoch;
    try {
      final bytes = await source.readBytes(path);
      return epoch == _epoch ? bytes : null;
    } catch (_) {
      return null;
    }
  }

  void _retain(String path, Uint8List bytes) {
    if (bytes.length > imageCacheBytes) return;
    _images[path] = bytes;
    _retainedBytes += bytes.length;
    while (_retainedBytes > imageCacheBytes) {
      final oldest = _images.keys.first;
      _retainedBytes -= _images.remove(oldest)!.length;
    }
  }
}

MessageImageFailure _imageFailure(FileViewerProblem problem) =>
    switch (problem) {
      FileViewerProblem.notFound ||
      FileViewerProblem.invalidPath => MessageImageFailure.notFound,
      FileViewerProblem.unsupported => MessageImageFailure.unsupported,
      _ => MessageImageFailure.unavailable,
    };
