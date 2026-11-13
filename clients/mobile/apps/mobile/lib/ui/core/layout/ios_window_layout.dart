import 'package:flutter/widgets.dart';
import 'package:mobile/services/ios_fold_regions.dart';

/// Scene-local system chrome geometry. Missing or stale native data never
/// removes the normal safe areas from a Flutter view.
class IosWindowLayout extends InheritedWidget {
  const IosWindowLayout({
    super.key,
    required this.geometry,
    required super.child,
  });

  final IosFoldRegions? geometry;

  static IosFoldRegions? of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<IosWindowLayout>()?.geometry;

  @override
  bool updateShouldNotify(IosWindowLayout oldWidget) =>
      geometry != oldWidget.geometry;
}
