/// Display vocabulary for the desktop composer's grouped work drawer. The
/// rows are the core's work types (`cc-domain::work`, P7), which the Dart
/// work drawer builds too; the drawer keeps its own static labels.
library;

import 'package:computer_connect_core/computer_connect_core.dart';

export 'package:computer_connect_core/computer_connect_core.dart'
    show
        WorkAction,
        WorkActionLabelView,
        WorkDetailView,
        WorkDrawerView,
        WorkGroup,
        WorkGroupCountView,
        WorkItemView,
        WorkKind,
        WorkTone;

extension WorkGroupLabel on WorkGroup {
  String get label => switch (this) {
    WorkGroup.needsYou => 'Needs you',
    WorkGroup.queued => 'Queued',
    WorkGroup.running => 'Running',
    WorkGroup.pullRequests => 'Pull requests',
    WorkGroup.watching => 'Watching',
  };
}

extension WorkDrawerCounts on WorkDrawerView {
  /// Unfinished items in [group], counted as the core counted them.
  int count(WorkGroup group) =>
      counts.where((c) => c.group == group).firstOrNull?.count ?? 0;
}

extension WorkItemActionLabel on WorkItemView {
  /// The item's own label for [action], if it has one.
  String? actionLabel(WorkAction action) =>
      actionLabels.where((l) => l.action == action).firstOrNull?.label;
}
