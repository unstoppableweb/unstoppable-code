import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:mobile/data/models/chat_tab_item.dart';
import 'package:mobile/device_link/chats/state.dart';
import 'package:mobile/device_link/protocol.dart';
import 'package:mobile/ui/core/file_viewer/file_viewer_source.dart';

/// No root of the file's worktree holds it, so it cannot open here.
final class ComputerFileOutsideWorktree extends DeviceLinkException {
  const ComputerFileOutsideWorktree()
    : super('The file is outside this worktree.');
}

/// A file tab in the shared chat-tabs sheet: the core's view of it.
final class ComputerFileTab implements ChatFileTabItem {
  const ComputerFileTab(this.tab);
  final core.FileTabView tab;

  @override
  String get fileTabId => tab.id;
  @override
  String get displayTitle => tab.title;
  @override
  String? get displayFolder => tab.folder;
}

/// An opened file tab: the viewer's path under its worktree root, the
/// source that reads it and the files it links to, and [close] for when
/// the viewer goes.
final class ComputerFileLocation {
  const ComputerFileLocation({
    required this.path,
    required this.source,
    required this.close,
  });
  final String path;
  final FileViewerSource source;
  final void Function() close;
}

/// Lists and opens the file tabs for the selected chat.
abstract interface class ComputerFiles {
  /// The selected chat's worktree file tabs, in tab order.
  List<ComputerFileTab> tabs(DeviceChatState? state);

  /// Finds [tab]'s worktree root. Throws [ComputerFileOutsideWorktree]
  /// when no root holds it and [DeviceLinkException] when the roots could
  /// not be read.
  Future<ComputerFileLocation> open(ComputerFileTab tab);

  /// Forgets cached roots, for example after a reconnect.
  void clear();
}
