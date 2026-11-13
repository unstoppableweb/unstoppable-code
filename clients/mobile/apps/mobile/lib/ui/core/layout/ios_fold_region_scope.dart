import 'dart:ui';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:mobile/services/ios_fold_regions.dart';
import 'ios_window_layout.dart';

/// Supplies the active iOS fold until Flutter's engine reports it itself.
/// Keep this above the navigator so sheets and routes share the same geometry.
class IosFoldRegionScope extends StatefulWidget {
  const IosFoldRegionScope({super.key, required this.child, this.regions});

  final Widget child;
  final Stream<IosFoldRegions>? regions;

  @override
  State<IosFoldRegionScope> createState() => _IosFoldRegionScopeState();
}

class _IosFoldRegionScopeState extends State<IosFoldRegionScope> {
  late final stream =
      widget.regions ??
      (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS
          ? IosFoldRegions.observe()
          : null);

  @override
  Widget build(BuildContext context) => StreamBuilder<IosFoldRegions>(
    stream: stream,
    builder: (context, snapshot) {
      final media = MediaQuery.of(context);
      final native = snapshot.hasError ? null : snapshot.data;
      // An event from the previous orientation must not constrain a new view.
      final matches =
          native != null &&
          (native.size.width - media.size.width).abs() < 0.5 &&
          (native.size.height - media.size.height).abs() < 0.5;
      final engineHasFold = media.displayFeatures.any(
        (feature) =>
            feature.type == DisplayFeatureType.fold ||
            feature.type == DisplayFeatureType.hinge,
      );
      return MediaQuery(
        data: media.copyWith(
          displayFeatures: [
            ...media.displayFeatures,
            if (matches && !engineHasFold)
              for (final bounds in native.regions)
                DisplayFeature(
                  bounds: bounds,
                  type: DisplayFeatureType.fold,
                  state: DisplayFeatureState.postureHalfOpened,
                ),
          ],
        ),
        child: IosWindowLayout(
          geometry: matches ? native : null,
          child: widget.child,
        ),
      );
    },
  );
}
