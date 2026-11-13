import 'dart:math' as math;

import 'package:mobile/ui/core/navigation/app_route_scope.dart';
import 'package:flutter/material.dart';
import 'package:mobile/services/ios_fold_regions.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/layout/ios_window_layout.dart';
import 'package:mobile/ui/core/navigation/home_navigation_scope.dart';

/// Adapts the same detail navigator and chat list to the available pane.
/// UIKit selects the compact vertical-bar placement; wide windows get a
/// persistent list even on platforms without that trait.
class HomeAdaptiveLayout extends StatefulWidget {
  const HomeAdaptiveLayout({
    super.key,
    required this.child,
    required this.sidebar,
    required this.railBuilder,
    required this.legacyBuilder,
    required this.initiallyShowChats,
  });
  final bool initiallyShowChats;
  final Widget child;
  final Widget sidebar;
  final Widget Function(BuildContext context, bool listVisible) railBuilder;
  final Widget Function(Widget child) legacyBuilder;
  @override
  State<HomeAdaptiveLayout> createState() => HomeAdaptiveLayoutState();
}

class HomeAdaptiveLayoutState extends State<HomeAdaptiveLayout> {
  late bool _listOpen = widget.initiallyShowChats;
  bool _wideListOpen = true;
  int _detailPreparations = 0;
  bool isAdaptive = false;
  bool _wide = false;
  bool get compactListVisible => isAdaptive && !_wide && _listOpen;

  /// Route disposal can await an exit animation even while detail is hidden.
  /// Let those tickers advance without revealing the outgoing screen.
  Future<void> prepareDetail(Future<void> Function() prepare) async {
    setState(() => _detailPreparations++);
    try {
      await prepare();
    } finally {
      if (mounted) setState(() => _detailPreparations--);
    }
  }

  void showDetail() => setState(() => _listOpen = false);
  void showChats() => setState(() {
    _listOpen = true;
    _wideListOpen = true;
  });
  void toggleChats() => setState(() {
    if (_wide) {
      _wideListOpen = !_wideListOpen;
    } else {
      _listOpen = !_listOpen;
    }
  });

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final media = MediaQuery.of(context);
      final native = IosWindowLayout.of(context);
      final edge = native?.verticalBarEdge ?? IosVerticalBarEdge.none;
      final vertical = edge != IosVerticalBarEdge.none;
      final railWidth = vertical
          ? math.max(
              72.0,
              edge == IosVerticalBarEdge.left
                  ? media.viewPadding.left
                  : media.viewPadding.right,
            )
          : 72.0;
      const sidebarWidth = 280.0;
      // Leave at least 400 logical pixels for the composer and transcript.
      _wide =
          constraints.maxWidth - media.padding.horizontal >=
          sidebarWidth + railWidth + 400;
      isAdaptive = vertical || _wide;
      if (!isAdaptive) return widget.legacyBuilder(widget.child);
      final railLeft = edge == IosVerticalBarEdge.left;
      final listVisible = _wide ? _wideListOpen : _listOpen;
      final width = constraints.maxWidth;
      final height = constraints.maxHeight;
      // Without native vertical-bar geometry, the side inset can contain a
      // landscape camera cutout. Keep the entire rail inside the safe area.
      final railInset = vertical ? 0.0 : media.padding.right;
      final railBounds = Rect.fromLTWH(
        railLeft ? 0 : width - railWidth - railInset,
        0,
        railWidth,
        height,
      );
      var railTop = media.padding.top;
      var railBottom = math.max(media.padding.bottom, media.viewInsets.bottom);
      // A side safe area reserves an entire strip. In that strip, clear only
      // the actual status/camera rectangles so the controls can use its height.
      for (final rect in [
        if (native != null) native.statusBar,
        ...?native?.occlusions,
      ]) {
        if (!rect.overlaps(railBounds)) continue;
        if (rect.center.dy < height / 2) {
          railTop = math.max(railTop, rect.bottom);
        } else {
          railBottom = math.max(railBottom, height - rect.top);
        }
      }
      railTop = railTop.clamp(0.0, height);
      railBottom = railBottom.clamp(0.0, height - railTop);
      final left = railLeft ? railWidth : media.padding.left;
      final right = railLeft ? media.padding.right : railWidth + railInset;
      final listWidth = _wide
          ? sidebarWidth
          : math.max(0.0, width - left - right);
      final detailLeft = left + (_wide && listVisible ? listWidth : 0);
      final contentMedia = media.copyWith(
        padding: media.padding.copyWith(left: 0, right: 0),
        viewPadding: media.viewPadding.copyWith(left: 0, right: 0),
      );
      return HomeRailPresentation(
        child: Scaffold(
          // This visible host keeps feedback above the keyboard even while
          // detail is offstage. Panes retain full window constraints and their
          // original MediaQuery below, so they apply keyboard insets once.
          backgroundColor: AppColors.of(context).background,
          body: OverflowBox(
            alignment: Alignment.topCenter,
            minHeight: height,
            maxHeight: height,
            child: Stack(
              children: [
                Positioned(
                  left: detailLeft,
                  right: right,
                  top: 0,
                  bottom: 0,
                  child: Offstage(
                    offstage: !_wide && listVisible,
                    child: TickerMode(
                      enabled: _wide || !listVisible || _detailPreparations > 0,
                      child: MediaQuery(
                        data: contentMedia.copyWith(
                          size: Size(width - detailLeft - right, height),
                        ),
                        child: HomeDetailVisibility(
                          visible: _wide || !listVisible,
                          child: FocusScope(
                            canRequestFocus: _wide || !listVisible,
                            child: widget.child,
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: left,
                  width: listWidth,
                  top: 0,
                  bottom: media.viewInsets.bottom,
                  child: Offstage(
                    offstage: !listVisible,
                    child: MediaQuery(
                      data: contentMedia.copyWith(
                        size: Size(listWidth, height),
                      ),
                      child: FocusScope(
                        canRequestFocus: listVisible,
                        child: widget.sidebar,
                      ),
                    ),
                  ),
                ),
                Positioned(
                  left: railBounds.left,
                  width: railWidth,
                  top: railTop,
                  bottom: railBottom,
                  child: MediaQuery(
                    data: media.removePadding(
                      removeLeft: true,
                      removeRight: true,
                      removeTop: true,
                      removeBottom: true,
                    ),
                    child: widget.railBuilder(context, listVisible),
                  ),
                ),
              ],
            ),
          ),
        ),
      );
    },
  );
}
