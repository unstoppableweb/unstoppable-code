import 'package:computer_connect_core/computer_connect_core.dart' as core;

import 'models.dart';

/// Flutter's projection of the selected chat frame.
final class DeviceChatState {
  DeviceChatState(this.ref);
  final DeviceChatRef ref;
  Map<String, dynamic> tab = {};
  final messages = <DeviceChatMessage>[];
  int? before;
  bool closed = false;
  core.ChatHeaderView? header;

  bool get readOnly => header?.readOnly ?? false;
  bool get hasUnreadTabs => header?.hasUnreadTabs ?? false;
  bool get hasPendingDecision => header?.hasPendingDecision ?? false;
  String get title => header?.title ?? ref.title;
  bool get running => header?.running ?? false;
  bool get awaitingInput => header?.awaitingInput ?? false;
  String? get runtimeError => header?.runtimeError;
  List<core.ChatTabView> get openTabs => header?.tabs ?? const [];
}
