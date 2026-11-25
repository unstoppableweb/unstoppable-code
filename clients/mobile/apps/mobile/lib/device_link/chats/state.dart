import 'package:computer_connect_core/computer_connect_core.dart' as core;

import 'models.dart';

/// Flutter's projection of the selected chat frame.
final class DeviceChatState {
  DeviceChatState(this.ref);
  final DeviceChatRef ref;
  core.ChatHeaderView? header;

  bool get closed => header?.closed ?? false;
  bool get hasMessages => header?.hasMessages ?? false;
  bool get readOnly => header?.readOnly ?? false;
  bool get hasUnreadTabs => header?.hasUnreadTabs ?? false;
  bool get hasPendingDecision => header?.hasPendingDecision ?? false;
  String get title => header?.title ?? ref.title;
  bool get running => header?.running ?? false;
  bool get awaitingInput => header?.awaitingInput ?? false;
  String? get runtimeError => header?.runtimeError;
  List<core.ChatTabView> get openTabs => header?.tabs ?? const [];
}
