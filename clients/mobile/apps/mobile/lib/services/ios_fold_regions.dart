import 'package:flutter/services.dart';

/// Geometry is in logical points relative to the owning Flutter view.
class IosFoldRegions {
  const IosFoldRegions({
    required this.size,
    required this.regions,
    this.verticalBarEdge = IosVerticalBarEdge.none,
    this.occlusions = const [],
    this.statusBar = Rect.zero,
  });

  final Size size;
  final List<Rect> regions;
  final IosVerticalBarEdge verticalBarEdge;
  final List<Rect> occlusions;
  final Rect statusBar;

  static IosFoldRegions decode(Object? message) {
    if (message case {
      'width': final num width,
      'height': final num height,
      'regions': final List<Object?> regions,
    }) {
      return IosFoldRegions(
        size: Size(width.toDouble(), height.toDouble()),
        regions: [for (final region in regions) ?_rect(region)],
        verticalBarEdge: switch (message['verticalBarEdge']) {
          'left' => IosVerticalBarEdge.left,
          'right' => IosVerticalBarEdge.right,
          _ => IosVerticalBarEdge.none,
        },
        occlusions: switch (message['occlusions']) {
          final List<Object?> values => [
            for (final value in values) ?_rect(value),
          ],
          _ => const [],
        },
        statusBar: _rect(message['statusBar']) ?? Rect.zero,
      );
    }
    throw const FormatException('Invalid iOS fold geometry');
  }

  static Rect? _rect(Object? value) => switch (value) {
    {
      'x': final num x,
      'y': final num y,
      'width': final num w,
      'height': final num h,
    }
        when x.isFinite &&
            y.isFinite &&
            w.isFinite &&
            h.isFinite &&
            w >= 0 &&
            h >= 0 =>
      Rect.fromLTWH(x.toDouble(), y.toDouble(), w.toDouble(), h.toDouble()),
    _ => null,
  };

  static Stream<IosFoldRegions> observe() => const EventChannel(
    'com.unstoppabledomains.canopy/fold_regions',
  ).receiveBroadcastStream().map(decode);
}

enum IosVerticalBarEdge { none, left, right }
