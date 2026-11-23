import 'dart:async';

import 'package:flutter/material.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_screen.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_view_model.dart';
import '../chats_view_model.dart';
import 'files_model.dart';

/// [FileViewerScreen] for a file the computer has open in a worktree, read
/// over the computer connection. Reads are stateless, so a reconnect resumes
/// them; while offline the viewer shows its offline notice.
class DeviceFileScreen extends StatefulWidget {
  const DeviceFileScreen({
    super.key,
    required this.model,
    required this.location,
  });

  final DeviceChatsViewModel model;
  final ComputerFileLocation location;

  @override
  State<DeviceFileScreen> createState() => _DeviceFileScreenState();
}

class _DeviceFileScreenState extends State<DeviceFileScreen> {
  late final FileViewerViewModel _file = FileViewerViewModel(
    source: widget.location.source,
    path: widget.location.path,
    online: widget.model.online,
  );

  @override
  void initState() {
    super.initState();
    widget.model.addListener(_onModelChanged);
    unawaited(_file.load());
  }

  @override
  void dispose() {
    widget.model.removeListener(_onModelChanged);
    widget.location.close();
    _file.dispose();
    super.dispose();
  }

  void _onModelChanged() => _file.setOnline(widget.model.online);

  @override
  Widget build(BuildContext context) => FileViewerScreen(file: _file);
}
