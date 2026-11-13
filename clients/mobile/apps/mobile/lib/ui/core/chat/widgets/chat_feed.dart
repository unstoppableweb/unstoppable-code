import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:mobile/core/design-system/shimmer/shimmer_text.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:mobile/ui/core/chat/widgets/response_actions.dart';

import 'package:mobile/ui/core/chat/widgets/attachment_thumbnail_scope.dart';
import 'package:mobile/ui/core/chat/widgets/delivery_footer.dart';
import 'package:mobile/ui/core/chat/widgets/head_change_anchor.dart';
import 'package:mobile/ui/core/chat/widgets/latest_first_scroll_controller.dart';
import 'package:mobile/ui/core/chat/widgets/message_bubble_surface.dart';
import 'package:mobile/ui/core/chat/widgets/row_widget_cache.dart';
import 'package:mobile/ui/core/chat/widgets/feed_items_cache.dart';
import 'package:mobile/ui/core/chat/widgets/retained_message_attribution.dart';
import 'package:mobile/ui/core/chat/widgets/step_chevron.dart';
import 'package:mobile/ui/core/chat/widgets/step_run_row.dart';
import 'package:mobile/ui/core/chat/widgets/tool_call_row.dart';
import 'package:mobile/ui/core/chat/widgets/watcher_message_bubble.dart';

/// Transport-neutral chat transcript presentation: the turn-structured
/// message feed, collapsed steps rows, the live working indicator, and the
/// floating scroll-to-bottom affordance. The owning
/// route supplies messages and resolved callbacks; this widget has no
/// repository access (same contract as `ChatInput`).
class ChatFeed extends StatefulWidget {
  const ChatFeed({
    super.key,
    required this.chatId,
    required this.messages,
    required this.expandedTurns,
    required this.turnInProgress,
    required this.onToggleTurn,
    this.onLoadOlder,
    this.loadingOlder = false,
    this.trailing = const [],
    this.turnFooters = const {},
    this.bottomActionInset = 0,
    this.topContentInset = 0,
    this.controller,
    this.onResend,
    this.canResend,
    this.onDiscard,
    this.onForkResponse,
    this.forkEnabled = true,
  });

  /// The resolved chat this transcript belongs to — always non-null here,
  /// since this widget is only built once a chat has messages to show.
  final String chatId;
  final List<ChatMessage> messages;
  final Set<String> expandedTurns;

  /// Authoritative liveness for the selected chat. This includes the
  /// per-chat `turnActive` summary, streamed transcript rows, and the
  /// post-send bridge before either projection has landed.
  final bool turnInProgress;

  final ValueChanged<String> onToggleTurn;

  /// Fired once on entering the oldest-content threshold. The feed rearms on
  /// leaving that threshold and on any new drag, so a request that failed
  /// without ever rendering a loading frame stays retryable. Repeat calls are
  /// expected: the caller single-flights in flight requests and stops once the
  /// transcript start is reached.
  final VoidCallback? onLoadOlder;

  /// True while an older-history page is in flight (renders a top spinner).
  final bool loadingOlder;

  /// Rows appended below the newest turn, inside the transcript's scrollable.
  /// Today this carries the awaiting AskUserQuestion cards. Each entry should
  /// carry a stable `ValueKey<String>` so it keeps its element (and any typed
  /// freeform text) as streaming rows land above it.
  final List<Widget> trailing;

  /// Rows closing a turn, keyed by turn key (the opening user message id):
  /// placed after the turn's footer, or under the working row while the turn
  /// runs. Turns not in the transcript get nothing. The feed rebuilds these
  /// on every build, so the owner keeps them cheap and few.
  final Map<String, Widget> turnFooters;

  /// Vertical space claimed in the bottom-right corner by another floating
  /// action, such as the conversation-list button.
  final double bottomActionInset;

  /// Scrollable clearance for overlaid chrome above the oldest message.
  final double topContentInset;

  /// Overrides the feed's own controller so a test can observe the position
  /// writes it makes. The feed keeps ownership of a controller it created and
  /// never disposes one passed in here.
  @visibleForTesting
  final ScrollController? controller;

  /// Resends a not-sent or uncertain user row, by message id.
  final ValueChanged<String>? onResend;

  /// Restricts Resend to rows the owning controller can retry. When omitted,
  /// every delivery row can use [onResend].
  final bool Function(ChatMessage)? canResend;

  /// Removes a not-sent or uncertain user row, by message id.
  final ValueChanged<String>? onDiscard;

  final ForkResponse? onForkResponse;
  final bool forkEnabled;

  @override
  State<ChatFeed> createState() => _ChatFeedState();
}

class _PrependAnchorKeeper extends StatefulWidget {
  const _PrependAnchorKeeper({
    required super.key,
    required this.keepAlive,
    required this.child,
  });

  final bool keepAlive;
  final Widget child;

  @override
  State<_PrependAnchorKeeper> createState() => _PrependAnchorKeeperState();
}

class _PrependAnchorKeeperState extends State<_PrependAnchorKeeper>
    with AutomaticKeepAliveClientMixin {
  @override
  bool get wantKeepAlive => widget.keepAlive;

  @override
  void didUpdateWidget(_PrependAnchorKeeper oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.keepAlive != widget.keepAlive) updateKeepAlive();
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    return widget.child;
  }
}

class _ChatFeedState extends State<ChatFeed> {
  /// Distance from the newest content within which the reader still counts as
  /// being on it, absorbing sub-pixel drift and small jitter. Shared by the
  /// follow cutoff and the return affordance so the two cannot disagree.
  static const double _latestContentSlack = 24;

  /// Distance within which the position counts as already on the newest
  /// content, ending the landing. Sub-pixel, so it absorbs the drift of
  /// summing row heights in doubles without ever masking a real gap.
  static const double _landedSlack = 0.5;

  /// Re-clamp passes allowed for one landing. Each pass re-measures against
  /// the rows the previous jump forced into existence; the transcripts
  /// measured here converge in one. The cap bounds a pathological list.
  static const int _latestLandingPasses = 4;

  late final ScrollController _controller =
      widget.controller ??
      LatestFirstScrollController(landedSlack: _landedSlack);
  late final bool _ownsController = widget.controller == null;
  final TranscriptProjection _projection = TranscriptProjection();
  final RowWidgetCache _rowWidgets = RowWidgetCache();
  final FeedItemsCache _items = FeedItemsCache();
  final Map<String, GlobalKey> _messageAnchorKeys = {};
  bool _showScrollToBottom = false;
  bool _scrollToBottomScheduled = false;
  bool _scheduledLandingForce = false;
  bool _landingInProgress = false;
  int _landingGeneration = 0;

  /// Hides the transcript until it has landed on the newest content. The
  /// landing runs in a post-frame callback, so the frame before it is still
  /// at the top of the history — the reader must not be shown that.
  bool _awaitingFirstLanding = true;
  bool _followJumpDeferred = false;
  bool _metricsRefreshScheduled = false;
  bool _loadOlderArmed = true;
  bool _followingLatest = true;
  bool _animatingToLatest = false;
  final HeadChangeAnchor _prependAnchor = HeadChangeAnchor();
  int? _prependMessageCount;
  String? _prependFirstMessageId;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_handleScroll);
    // The initial transcript has no reader-owned position to preserve. Its
    // first landing is authoritative and must finish re-clamping any lazy-list
    // estimate before the visibility gate opens.
    _scheduleScrollToBottom(force: true);
  }

  @override
  void didUpdateWidget(ChatFeed oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.chatId != widget.chatId) {
      _loadOlderArmed = true;
      _followingLatest = true;
      // The previous chat's latest animation must not keep owning the
      // position, or the scheduled jump below is deferred while the tween
      // chases an offset that means nothing in this transcript.
      _animatingToLatest = false;
      _followJumpDeferred = false;
      _clearPrependAnchor();
      // A new transcript lands from scratch, so hide it again until it does.
      _awaitingFirstLanding = true;
      _scheduleScrollToBottom(force: true);
      return;
    }

    final transcriptHydrated =
        oldWidget.messages.isEmpty && widget.messages.isNotEmpty;
    if (transcriptHydrated) {
      // The same chat can mount before its transcript arrives. Treat that
      // hydration like a fresh transcript so its stale top frame is never
      // painted while the authoritative landing is still resolving.
      _followingLatest = true;
      _followJumpDeferred = false;
      _awaitingFirstLanding = true;
      _scheduleScrollToBottom(force: true);
    }

    final historyWasPrepended =
        _prependMessageCount != null &&
        widget.messages.length > _prependMessageCount! &&
        widget.messages.first.messageId != _prependFirstMessageId;
    // Rows above a reader who left the latest content can also change without
    // a prepend: a cached tail replaced by a fresher one, or by the desktop's
    // snapshot (CAN-3373). Keep the row they are reading where it is.
    final headReplaced =
        !historyWasPrepended &&
        !transcriptHydrated &&
        !_followingLatest &&
        oldWidget.messages.isNotEmpty &&
        widget.messages.isNotEmpty &&
        oldWidget.messages.first.messageId != widget.messages.first.messageId;
    if (historyWasPrepended) {
      // Retire the detector now that the prepend has been observed. A rebuild
      // inside the multi-frame restore window would otherwise re-enter here
      // and repoint the anchor the in-flight restore is still resolving.
      _prependMessageCount = null;
      _prependFirstMessageId = null;
      _anchorAcrossHeadChange(oldWidget.messages);
    } else if (headReplaced) {
      _anchorAcrossHeadChange(oldWidget.messages);
    } else if (oldWidget.loadingOlder &&
        !widget.loadingOlder &&
        _prependMessageCount != null) {
      _loadOlderArmed = true;
      _clearPrependAnchor();
    }

    // Keep following appended/streamed rows only when the reader was already
    // on the latest content. `_followingLatest` tracks the resting scroll
    // position, so it already covers "sitting at the bottom".
    if (!transcriptHydrated && !historyWasPrepended && _followingLatest) {
      _scheduleScrollToBottom();
    }
    _scheduleMetricsRefresh();
  }

  @override
  void dispose() {
    _controller.removeListener(_handleScroll);
    if (_ownsController) _controller.dispose();
    super.dispose();
  }

  void _handleScroll() {
    if (!_controller.hasClients) return;
    final position = _controller.position;
    _updateScrollAffordance();
    final loadOlderThreshold = position.minScrollExtent + 200;
    if (position.pixels > loadOlderThreshold) {
      _loadOlderArmed = true;
    }
    // Oldest content is at the top. A transcript shorter than the viewport has
    // maxScrollExtent == 0 and satisfies the threshold at rest, so require a
    // scrollable extent before treating this as intent to page.
    if (position.maxScrollExtent > 0 &&
        position.pixels <= loadOlderThreshold &&
        _loadOlderArmed &&
        widget.messages.isNotEmpty &&
        widget.onLoadOlder != null) {
      _loadOlderArmed = false;
      // Only the prepend detector is recorded here. The scroll anchor is
      // captured when the prepend actually lands, so a reader who keeps
      // moving during an in-flight request is restored to where they are
      // now rather than where they started the request.
      _prependMessageCount = widget.messages.length;
      _prependFirstMessageId = widget.messages.first.messageId;
      widget.onLoadOlder!();
    }
  }

  void _updateScrollAffordance() {
    if (!_controller.hasClients) return;
    // The affordance is the only way back from an opt-out, so it appears on
    // exactly the same threshold that ends following. Anything wider leaves a
    // band where the feed has stopped following with nothing to tap.
    final shouldShow = !_isAtBottom;
    if (shouldShow != _showScrollToBottom) {
      setState(() => _showScrollToBottom = shouldShow);
    }
  }

  void _scrollToBottom() {
    if (!_controller.hasClients) return;
    _followingLatest = true;
    // A second tap would supersede the first animation's activity, completing
    // its future early so its finally clears the flag out from under the one
    // still running. Let the animation already in flight finish instead.
    if (_animatingToLatest) return;
    // An explicit tap outranks preserving the old reading position: cancel any
    // pending history restore so it cannot re-pin a mid-flight offset.
    _clearPrependAnchor();
    unawaited(_animateToLatest());
  }

  Future<void> _animateToLatest() async {
    _animatingToLatest = true;
    try {
      await _controller.animateTo(
        _controller.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
    } finally {
      _animatingToLatest = false;
      if (mounted && _followingLatest) {
        _scheduleScrollToBottom();
      }
    }
  }

  bool get _isAtBottom {
    if (!_controller.hasClients) return true;
    final position = _controller.position;
    return position.maxScrollExtent - position.pixels <= _latestContentSlack;
  }

  /// Lands on the newest content after the current frame.
  ///
  /// [force] marks an authoritative landing — switching chats — that outranks
  /// whatever activity owns the position. Ordinary follow jumps defer to a
  /// reader gesture instead of cancelling it.
  void _scheduleScrollToBottom({bool force = false}) {
    if (force) {
      // Lay the transcript out on its newest rows in the coming frame
      // already; the post-frame landing below confirms that position.
      if (_controller case final LatestFirstScrollController controller) {
        controller.landOnLatestInNextLayout();
      }
      // Authoritative landings supersede every callback from the previous
      // transcript. Stale continuations observe the generation mismatch and
      // cannot reveal or move the replacement transcript.
      _landingGeneration += 1;
      _landingInProgress = false;
    } else if (_landingInProgress) {
      // Metrics changes caused by a jump are absorbed by the active chain.
      // Starting a second chain here could mistake that jump for convergence.
      return;
    }
    if (_scrollToBottomScheduled) {
      _scheduledLandingForce = _scheduledLandingForce || force;
      return;
    }
    _scrollToBottomScheduled = true;
    _scheduledLandingForce = force;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _scrollToBottomScheduled = false;
      final landingForce = _scheduledLandingForce;
      _scheduledLandingForce = false;
      // Every bail-out below leaves the position untouched, so each one has to
      // reveal the transcript too — otherwise the gate hides it forever.
      if (!mounted) return;
      if (!_controller.hasClients) {
        _revealTranscript();
        return;
      }
      if (!_followingLatest) {
        _revealTranscript();
        return;
      }
      // The latest animation owns the position while it runs. Jumping here
      // would cut it short on its first frame; its finally re-schedules so
      // anything that landed mid-flight is still absorbed.
      if (_animatingToLatest) {
        _revealTranscript();
        return;
      }
      // A flick's ballistic phase is still the reader's gesture, and
      // [ScrollPosition.jumpTo] opens with goIdle(), which cancels it
      // outright. iOS ends the drag phase within a few dozen pixels of the
      // bottom and lets momentum carry the rest, so the follow cutoff still
      // reads as the latest content and this jump would erase the flick
      // before it travels. Defer to the activity and re-arm on its end.
      if (!landingForce && _controller.position.isScrollingNotifier.value) {
        _followJumpDeferred = true;
        _revealTranscript();
        return;
      }
      final generation = ++_landingGeneration;
      _landingInProgress = true;
      _landOnLatest(
        _latestLandingPasses,
        force: landingForce,
        generation: generation,
      );
    });
  }

  /// Lands exactly on the newest content, re-measuring until the position and
  /// the extent agree.
  ///
  /// A lazily built list only *estimates* [ScrollPosition.maxScrollExtent],
  /// extrapolating from the average height of the rows it has actually built.
  /// On an uneven transcript that estimate is wrong by thousands of pixels.
  /// [ScrollController.jumpTo] force-sets the offset and then goes ballistic,
  /// so once the real rows lay out and the extent collapses, the position is
  /// stranded out of range and the physics *animate* it back — scrolling the
  /// reader down the whole history. Re-clamping keeps that correction from
  /// ever starting: `jumpTo` opens with `goIdle()`, which cancels it.
  void _landOnLatest(
    int remainingPasses, {
    required bool force,
    required int generation,
    double? previousExtent,
  }) {
    if (generation != _landingGeneration || !mounted) return;
    if (!_controller.hasClients) {
      _finishLanding(generation);
      return;
    }
    // A reader who took the transcript mid-landing owns it now.
    if (!_followingLatest) {
      _finishLanding(generation);
      return;
    }
    final position = _controller.position;
    // Continuation passes run in their own post-frame callbacks, after the
    // scheduling guard above. Re-check ownership before every non-forced
    // write so a drag or ballistic that began between passes is not cancelled.
    if (!force && position.isScrollingNotifier.value) {
      _followJumpDeferred = true;
      _finishLanding(generation);
      return;
    }
    final extent = position.maxScrollExtent;
    final landed = (position.pixels - extent).abs() <= _landedSlack;
    final extentStable =
        previousExtent != null &&
        (previousExtent - extent).abs() <= _landedSlack;
    // A forced landing must also end an activity still driving the position
    // (the previous chat's latest animation, say), even when the layout has
    // already put it on the newest rows. `jumpTo` opens with `goIdle()`.
    if (!landed || (force && position.isScrollingNotifier.value)) {
      _controller.jumpTo(extent);
    }
    _updateScrollAffordance();
    // Equality immediately after another callback's jump is not convergence.
    // Reveal only when a later layout pass confirms the same measured extent.
    if ((landed && extentStable) || remainingPasses <= 0) {
      _finishLanding(generation);
      return;
    }
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => _landOnLatest(
        remainingPasses - 1,
        force: force,
        generation: generation,
        previousExtent: extent,
      ),
    );
    // A transcript laid out on its newest rows needs no jump here, and
    // nothing else may ask for the frame that confirms it and opens the gate.
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  void _finishLanding(int generation) {
    if (generation != _landingGeneration) return;
    _landingInProgress = false;
    _revealTranscript();
  }

  /// Ends the first-paint gate. Every path that stops a landing calls this, so
  /// the gate can never outlive the landing it was hiding.
  void _revealTranscript() {
    if (!_awaitingFirstLanding) return;
    setState(() => _awaitingFirstLanding = false);
  }

  void _scheduleMetricsRefresh() {
    if (_metricsRefreshScheduled) return;
    _metricsRefreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _metricsRefreshScheduled = false;
      if (!mounted) return;
      _updateScrollAffordance();
    });
  }

  void _schedulePrependAnchorRestore() {
    if (_prependAnchor.restoreScheduled) return;
    final anchorMessageId = _prependAnchor.messageId;
    final viewportOffset = _prependAnchor.viewportOffset;
    final oldPixels = _prependAnchor.pixels;
    final oldMaxScrollExtent = _prependAnchor.maxScrollExtent;
    if (anchorMessageId == null ||
        viewportOffset == null ||
        oldPixels == null ||
        oldMaxScrollExtent == null) {
      _clearPrependAnchor();
      return;
    }
    _prependAnchor.restoreScheduled = true;
    final anchorVersion = _prependAnchor.version;
    var approximatedAnchor = false;
    void restoreAnchor(Duration _, int remainingPasses) {
      if (anchorVersion != _prependAnchor.version) return;
      if (!mounted || !_controller.hasClients) {
        _prependAnchor.restoreScheduled = false;
        return;
      }
      if (!approximatedAnchor) {
        approximatedAnchor = true;
        final position = _controller.position;
        final addedExtent = position.maxScrollExtent - oldMaxScrollExtent;
        _controller.jumpTo(
          (oldPixels + addedExtent).clamp(
            position.minScrollExtent,
            position.maxScrollExtent,
          ),
        );
      }
      final anchorContext = _messageAnchorKeys[anchorMessageId]?.currentContext;
      final anchor = anchorContext?.findRenderObject();
      if (anchor != null && anchor.attached && _isLaidOutSliverChild(anchor)) {
        final position = _controller.position;
        final viewport = RenderAbstractViewport.of(anchor);
        final rowOffset = viewport.getOffsetToReveal(anchor, 0).offset;
        final currentViewportOffset = rowOffset - position.pixels;
        _controller.jumpTo(
          (position.pixels + currentViewportOffset - viewportOffset).clamp(
            position.minScrollExtent,
            position.maxScrollExtent,
          ),
        );
        _updateScrollAffordance();
      }
      if (remainingPasses > 0) {
        WidgetsBinding.instance.addPostFrameCallback(
          (elapsed) => restoreAnchor(elapsed, remainingPasses - 1),
        );
      } else {
        _prependAnchor.restoreScheduled = false;
        if (mounted) {
          setState(_clearPrependAnchor);
        }
      }
    }

    WidgetsBinding.instance.addPostFrameCallback(
      (elapsed) => restoreAnchor(elapsed, 3),
    );
  }

  bool _isLaidOutSliverChild(RenderObject anchor) {
    RenderObject? current = anchor;
    while (current != null) {
      final parentData = current.parentData;
      if (parentData is SliverMultiBoxAdaptorParentData) {
        return !parentData.keptAlive && parentData.layoutOffset != null;
      }
      current = current.parent;
    }
    return false;
  }

  /// Holds the reader's row in place while rows above it change: older
  /// history prepended, or a cached head replaced.
  void _anchorAcrossHeadChange(List<ChatMessage> previousMessages) {
    final position = _controller.hasClients ? _controller.position : null;
    _prependAnchor.captureAcrossChange(
      scroll: position == null
          ? null
          : (
              pixels: position.pixels,
              maxScrollExtent: position.maxScrollExtent,
              viewportExtent: position.viewportDimension,
            ),
      currentIds: [for (final message in widget.messages) message.messageId],
      previousIds: [for (final message in previousMessages) message.messageId],
      layoutOf: _laidOutRow,
    );
    _schedulePrependAnchorRestore();
  }

  /// [messageId]'s row as currently laid out, its top relative to the
  /// viewport; null when the row has no current layout.
  ({double top, double height})? _laidOutRow(String messageId) {
    final context = _messageAnchorKeys[messageId]?.currentContext;
    final renderObject = context?.findRenderObject();
    if (renderObject is! RenderBox ||
        !renderObject.attached ||
        !_isLaidOutSliverChild(renderObject)) {
      return null;
    }
    final viewport = RenderAbstractViewport.of(renderObject);
    final rowOffset = viewport.getOffsetToReveal(renderObject, 0).offset;
    return (
      top: rowOffset - _controller.position.pixels,
      height: renderObject.size.height,
    );
  }

  void _clearPrependAnchor() {
    _prependAnchor.clear();
    _prependMessageCount = null;
    _prependFirstMessageId = null;
  }

  bool _handleScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    if (notification is ScrollStartNotification &&
        notification.dragDetails != null) {
      // The reader has taken the transcript back from any animation of ours.
      _animatingToLatest = false;
      // A new gesture is a fresh request to page older history, so re-arm the
      // latch even when the previous request failed without ever rendering a
      // loading frame. Short transcripts cannot clear the scroll threshold,
      // and that is their only other way back.
      _loadOlderArmed = true;
      _followingLatest = _isAtBottom;
    } else if (notification is ScrollUpdateNotification ||
        notification is ScrollEndNotification) {
      // The tap-to-latest animation passes through every not-at-bottom offset
      // on its way down. Reading intent from its own ticks would cancel the
      // follow the tap just asked for, and strand the reader on the extent
      // captured when the animation started.
      if (_animatingToLatest) return false;
      // Follow intent tracks the live position, not just the resting one: a
      // scroll end only arrives after the drag *and* its ballistic settle, so
      // waiting for it would let a row appended mid-gesture snap the reader
      // back to the bottom while their finger is still down.
      _followingLatest = _isAtBottom;
      // Content that grew while the gesture owned the position still has to
      // be caught up, but only for a jump that was actually deferred —
      // re-arming on every scroll end would reschedule off our own jump.
      if (notification is ScrollEndNotification && _followJumpDeferred) {
        _followJumpDeferred = false;
        if (_followingLatest) _scheduleScrollToBottom();
      }
    }
    return false;
  }

  void _handlePointerDown(PointerDownEvent event) {
    if (!_controller.hasClients || _isAtBottom) return;
    _followingLatest = false;
    if (_animatingToLatest) {
      // Touching the transcript hands it back to the reader. Clearing the
      // intent flag alone would leave the tween driving to the bottom
      // underneath their finger, so stop it where they caught it.
      _animatingToLatest = false;
      _controller.jumpTo(_controller.position.pixels);
    }
  }

  bool _handleScrollMetricsNotification(
    ScrollMetricsNotification notification,
  ) {
    if (notification.depth != 0) return false;
    if (_followingLatest) {
      _scheduleScrollToBottom();
    } else {
      _scheduleMetricsRefresh();
    }
    return false;
  }

  /// The widget for a transcript row, reused while the row and the feed
  /// state it reads are unchanged so streaming elsewhere skips it.
  Widget _buildRow(TranscriptRow row) {
    switch (row) {
      case TranscriptResponseActionsRow(:final message, :final target):
        return Padding(
          key: ValueKey(row.key),
          padding: const EdgeInsets.symmetric(
            horizontal: MessageBubbleSurface.textInset,
          ),
          child: ResponseActions(
            text: message.text,
            target: target,
            occurredAt: message.occurredAt,
            forkEnabled: widget.forkEnabled,
            onFork: widget.onForkResponse,
          ),
        );
      case TranscriptMessageRow(:final message):
        final canResend =
            widget.onResend != null &&
            (widget.canResend?.call(message) ?? true);
        final anchorKey = _messageAnchorKeys.putIfAbsent(
          message.messageId,
          GlobalKey.new,
        );
        final keepAlive = message.messageId == _prependAnchor.messageId;
        return _rowWidgets.obtain(
          row.key,
          (row, anchorKey, keepAlive, canResend, widget.onDiscard != null),
          () => KeyedSubtree(
            // Stable identity prevents inserted history rows from migrating
            // ToolCallRow expansion state between messages.
            key: ValueKey(row.key),
            child: _PrependAnchorKeeper(
              key: anchorKey,
              keepAlive: keepAlive,
              child: _MessageBubble(
                key: ValueKey('message-content-${message.messageId}'),
                message: message,
                toolResults: row.toolResults,
                streamingSpinner: row.streamingSpinner,
                showParts: row.parts,
                onResend: !canResend
                    ? null
                    : (messageId) => widget.onResend?.call(messageId),
                onDiscard: widget.onDiscard == null
                    ? null
                    : (messageId) => widget.onDiscard?.call(messageId),
              ),
            ),
          ),
        );
      case TranscriptStepsRow(
        :final turn,
        :final counts,
        :final expanded,
        :final timer,
      ):
        Widget build() => _TurnWorkHeader(
          turn: turn,
          counts: counts,
          expanded: expanded,
          timer: timer,
          // Reads the callback when tapped, so a reused row never calls a
          // callback from an older build.
          onTap: () => widget.onToggleTurn(turn.key),
        );
        return _keyedRow(row, row, build);
      case TranscriptRunRow(
        :final runKey,
        :final steps,
        :final shownFrom,
        :final expanded,
        :final toolResults,
        :final anchorMessageId,
      ):
        Widget build() => StepRunRow(
          steps: steps,
          shownFrom: shownFrom,
          expanded: expanded,
          toolResults: toolResults,
          // Reads the callback when tapped, so a reused row never calls a
          // callback from an older build.
          onToggle: () => widget.onToggleTurn(runKey),
        );
        if (anchorMessageId == null) return _keyedRow(row, row, build);
        // A run is the only row of its step-only messages, so it holds the
        // reader in place across history loads, as a message row does.
        final anchorKey = _messageAnchorKeys.putIfAbsent(
          anchorMessageId,
          GlobalKey.new,
        );
        final keepAlive = anchorMessageId == _prependAnchor.messageId;
        return _rowWidgets.obtain(
          row.key,
          (row, anchorKey, keepAlive),
          () => KeyedSubtree(
            key: ValueKey(row.key),
            child: _PrependAnchorKeeper(
              key: anchorKey,
              keepAlive: keepAlive,
              child: build(),
            ),
          ),
        );
      case TranscriptTimerRow(:final timer):
        Widget build() => _TurnStatusRow(timer: timer);
        return _keyedRow(row, row, build);
      case TranscriptTurnFooterRow(:final turnKey):
        // Owner-supplied and owner-updated: never served from the row cache.
        return KeyedSubtree(
          key: ValueKey(row.key),
          child: widget.turnFooters[turnKey] ?? const SizedBox.shrink(),
        );
    }
  }

  Widget _keyedRow(TranscriptRow row, Object inputs, Widget Function() build) {
    final key = row.key;
    if (key == null) return build();
    return _rowWidgets.obtain(
      key,
      inputs,
      () => KeyedSubtree(key: ValueKey(key), child: build()),
    );
  }

  @override
  Widget build(BuildContext context) {
    _messageAnchorKeys.removeWhere(
      (messageId, key) =>
          messageId != _prependAnchor.messageId && key.currentContext == null,
    );
    final changed = _items.update(
      rows: _projection.rows(
        messages: widget.messages,
        turnInProgress: widget.turnInProgress,
        expandedTurns: widget.expandedTurns,
        footerTurns: widget.turnFooters.keys.toSet(),
      ),
      trailing: widget.trailing,
      loadingOlder: widget.loadingOlder,
      topInset: widget.topContentInset,
    );
    final items = _items.items;
    final builderIndexByKey = _items.indexByKey;
    if (changed) _rowWidgets.retainWhere(builderIndexByKey.containsKey);

    return Stack(
      children: [
        // Opacity still lays the list out — and layout is what builds sliver
        // children — so the landing can resolve behind the gate. Offstage
        // would skip layout and strand it.
        Opacity(
          key: const ValueKey('remote-chat-transcript-visibility'),
          opacity: _awaitingFirstLanding ? 0 : 1,
          child: NotificationListener<ScrollMetricsNotification>(
            onNotification: _handleScrollMetricsNotification,
            child: NotificationListener<ScrollNotification>(
              onNotification: _handleScrollNotification,
              child: Listener(
                onPointerDown: _handlePointerDown,
                child: ListView.builder(
                  key: const ValueKey('remote-chat-transcript'),
                  controller: _controller,
                  padding: EdgeInsets.fromLTRB(
                    12,
                    0,
                    12,
                    8 + widget.bottomActionInset,
                  ),
                  itemCount: items.length,
                  // Keys alone do NOT survive index shifts in a builder list — the
                  // framework only remaps a keyed child to its new slot when the
                  // delegate can find it. Without this, every appended message would
                  // deactivate the keyed message elements and collapse any expanded
                  // tool-call panel mid-stream. Indexed once per item build — a
                  // linear scan with per-comparison string interpolation would run
                  // per materialized child per streaming frame.
                  findChildIndexCallback: (key) => key is ValueKey<String>
                      ? builderIndexByKey[key.value]
                      : null,
                  itemBuilder: (context, index) {
                    final item = items[index];
                    return switch (item) {
                      FeedRowItem(:final row) => _buildRow(row),
                      TrailingItem(:final child) => child,
                      HistoryLoadingItem() => const Padding(
                        key: ValueKey('transcript-history-loading'),
                        padding: EdgeInsets.symmetric(vertical: 12),
                        child: Center(child: LoadingSpinner(size: 14)),
                      ),
                      TopInsetSpacerItem(:final height) => SizedBox(
                        key: const ValueKey('remote-chat-top-inset-space'),
                        height: height,
                      ),
                    };
                  },
                ),
              ),
            ),
          ),
        ),
        Positioned(
          right: CanopyOverlayAction.gutter,
          // The composer's own top padding supplies this control's bottom
          // gutter, so it sits on the same 8px grid as the composer's edges.
          bottom: widget.bottomActionInset,
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 150),
            transitionBuilder: (child, animation) => FadeTransition(
              opacity: animation,
              child: ScaleTransition(scale: animation, child: child),
            ),
            child: _showScrollToBottom
                ? CanopyOverlayAction(
                    key: const ValueKey('remote-chat-scroll-to-bottom'),
                    glyph: CanopyGlyph.chevronDownMedium,
                    label: 'Scroll to latest message',
                    onPressed: _scrollToBottom,
                  )
                : const SizedBox.shrink(),
          ),
        ),
      ],
    );
  }
}

/// A finished turn's header, as desktop's clean `TurnWorkHeader`: "Worked
/// for 3m 24s" in the step rows' quiet ink with a chevron that opens the
/// steps the turn folded away, over a hairline that closes the header. The
/// semantics label names what the steps did. A turn with no steps keeps the
/// words and nothing to open.
class _TurnWorkHeader extends StatelessWidget {
  const _TurnWorkHeader({
    required this.turn,
    required this.counts,
    required this.expanded,
    required this.timer,
    required this.onTap,
  });

  final ChatTurn turn;
  final List<TurnStepCount> counts;
  final bool expanded;
  final TurnTimer? timer;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final label = turnWorkLabel(timer);
    final opens = counts.isNotEmpty;
    // The hairline sits on the reply's text inset, as desktop's `px-3`.
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        MessageBubbleSurface.textInset,
        8,
        MessageBubbleSurface.textInset,
        4,
      ),
      child: Semantics(
        button: opens,
        expanded: opens ? expanded : null,
        label: opens ? 'Agent steps: ${describeTurnStepCounts(counts)}' : label,
        value: opens ? label : null,
        child: Container(
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: colors.border)),
          ),
          padding: const EdgeInsets.only(bottom: 4),
          child: InkWell(
            key: ValueKey('turn-steps-${turn.key}'),
            onTap: opens ? onTap : null,
            borderRadius: BorderRadius.circular(AppRadii.sm),
            child: ExcludeSemantics(
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 4),
                child: Row(
                  children: [
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AppTypography.bodySmall.copyWith(
                          color: colors.foregroundSecondary,
                        ),
                      ),
                    ),
                    if (opens) ...[
                      const SizedBox(width: 4),
                      StepChevron(open: expanded),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Bottom-of-turn status while a turn runs, as desktop's clean look: the
/// shimmering "Thinking" while the agent works, or "Waiting for you" while
/// it waits on input. No elapsed count; a finished turn's duration reads in
/// its "Worked for" header instead.
class _TurnStatusRow extends StatelessWidget {
  const _TurnStatusRow({required this.timer});

  final TurnTimer? timer;

  @override
  Widget build(BuildContext context) {
    final style = AppTypography.bodySmall;
    final waiting = timer?.isPaused ?? false;
    return Padding(
      key: const ValueKey('remote-chat-working-indicator'),
      padding: const EdgeInsets.symmetric(
        horizontal: MessageBubbleSurface.textInset,
        vertical: 4,
      ),
      child: Align(
        alignment: Alignment.centerLeft,
        child: waiting
            ? Text(
                'Waiting for you',
                style: style.copyWith(
                  color: AppColors.of(context).foregroundSecondary,
                ),
              )
            : ShimmerText('Thinking', style: style),
      ),
    );
  }
}

/// One transcript message. Desktop parity (`ChatMessageItem` + the shared
/// `UserBubble`): only the USER prompt lives in a bubble — a full-width
/// `bg-quaternary` surface with the house border and rounded-xl corners,
/// matching the composer directly below it. Everything the agent
/// produces is flat, full-width content at the bubble's text inset; tool
/// calls and thinking render as flat rows, never as chips inside a bubble.
class _MessageBubble extends StatelessWidget {
  const _MessageBubble({
    super.key,
    required this.message,
    this.toolResults = const {},
    this.streamingSpinner = true,
    this.showParts = true,
    this.onResend,
    this.onDiscard,
  });

  static const double _textInset = MessageBubbleSurface.textInset;

  final ChatMessage message;

  /// The owning turn's `tool_result` outcomes keyed by `toolUseId`.
  final Map<String, ToolCallResult> toolResults;

  /// Whether a streaming message shows its own spinner; false while the
  /// turn's working row already does.
  final bool streamingSpinner;

  /// False when the message's steps draw in the run before it.
  final bool showParts;

  /// Resends a not-sent or uncertain user row, by message id.
  final ValueChanged<String>? onResend;

  /// Removes a not-sent or uncertain user row, by message id.
  final ValueChanged<String>? onDiscard;

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final status = StatusColors.of(context);
    final isUser = message.role == ChatRole.user;
    final failed =
        message.status == ChatMessageStatus.failed ||
        message.status == ChatMessageStatus.cancelled;

    final partRows = _partRows();
    final text = message.text.trim();
    final spinner = message.isStreaming && streamingSpinner;
    final showContent =
        text.isNotEmpty ||
        message.attachments.isNotEmpty ||
        message.delivery != null ||
        failed ||
        (spinner && partRows.isEmpty);

    final content = !showContent
        ? null
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              RetainedMessageAttribution(message: message),
              if (text.isNotEmpty)
                MessageMarkdown(
                  text: text,
                  style: AppTypography.body.copyWith(color: colors.foreground),
                  selectable: true,
                ),
              if (message.attachments.isNotEmpty) ...[
                if (text.isNotEmpty) const SizedBox(height: 6),
                Wrap(
                  spacing: 4,
                  runSpacing: 4,
                  children: [
                    for (final attachment in message.attachments)
                      _MessageAttachmentChip(
                        key: ValueKey(
                          'message-attachment-${attachment.attachmentId}',
                        ),
                        attachment: attachment,
                      ),
                  ],
                ),
              ],
              if (spinner) ...[
                if (text.isNotEmpty) const SizedBox(height: 6),
                ShimmerText('Thinking', style: AppTypography.bodySmall),
              ],
              if (message.delivery case final delivery?) ...[
                const SizedBox(height: 4),
                DeliveryFooter(
                  key: ValueKey('message-delivery-${message.messageId}'),
                  messageId: message.messageId,
                  delivery: delivery,
                  note: message.deliveryNote,
                  onResend: onResend,
                  onDiscard: onDiscard,
                ),
              ] else if (failed) ...[
                const SizedBox(height: 4),
                Text(
                  message.status == ChatMessageStatus.cancelled
                      ? 'Cancelled'
                      : 'Failed',
                  style: AppTypography.bodySmall.copyWith(color: status.failed),
                ),
              ],
            ],
          );

    final Widget? body;
    if (message.watcherFired case final watcherFired? when isUser) {
      // The title still shows when the watcher posted no visible notice.
      body = WatcherMessageBubble(
        messageId: message.messageId,
        watcherFired: watcherFired,
        child: content,
      );
    } else if (content == null) {
      body = null;
    } else if (isUser) {
      body = MessageBubbleSurface(
        key: ValueKey('user-bubble-${message.messageId}'),
        color: colors['bg-quaternary'],
        child: content,
      );
    } else {
      body = Padding(
        padding: const EdgeInsets.symmetric(horizontal: _textInset),
        child: content,
      );
    }
    // A streaming row with nothing to show yet: the working row carries it.
    if (body == null && partRows.isEmpty) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Desktop keeps tool/thinking rows inside the same px-3 wrapper as
          // the prose, so every agent row shares the bubble text's left edge.
          if (partRows.isNotEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: _textInset),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: partRows,
              ),
            ),
          if (body != null)
            Padding(
              padding: EdgeInsets.only(top: partRows.isEmpty ? 0 : 4),
              child: body,
            ),
        ],
      ),
    );
  }

  /// Renders the message's tool/thinking/agent parts in order as flat rows.
  List<Widget> _partRows() {
    if (!showParts) return const [];
    const renderedKinds = {'tool_use', 'thinking', 'agent'};
    return [
      for (var index = 0; index < message.parts.length; index++)
        if (renderedKinds.contains(message.parts[index].kind))
          stepPartRow(message, index, toolResults),
    ];
  }
}

/// Chip for a file the user attached. The filename is the durable part: the
/// bytes live on the desktop, which is the surface that can open them.
///
/// When this device is the one that staged the image, its retained thumbnail
/// (see [AttachmentThumbnailCache]) stands in for the generic glyph, so a
/// photo you just sent reads as that photo rather than as a filename. Every
/// other case — history paged in from the desktop, a desktop-side attachment,
/// a restart — keeps the glyph.
class _MessageAttachmentChip extends StatelessWidget {
  const _MessageAttachmentChip({super.key, required this.attachment});

  static const double _thumbnailSize = 32;

  final ChatMessageAttachment attachment;

  bool get _isImage => attachment.mediaType.startsWith('image/');

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    // The media type is the authority on what this attachment is; a retained
    // thumbnail can only ever decorate something already known to be an image.
    final thumbnail = _isImage
        ? AttachmentThumbnailScope.maybeOf(
            context,
          )?.thumbnailFor(attachment.attachmentId)
        : null;
    final glyph = CanopyIcon(
      glyph: _isImage ? CanopyGlyph.images1 : CanopyGlyph.pageAttachment,
      size: 14,
      tint: colors.foregroundSecondary,
    );
    return Container(
      padding: EdgeInsets.fromLTRB(thumbnail == null ? 8 : 4, 4, 8, 4),
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border.all(color: colors.border),
        borderRadius: BorderRadius.circular(8),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (thumbnail == null)
            glyph
          else
            ClipRRect(
              borderRadius: BorderRadius.circular(6),
              child: Image.memory(
                thumbnail,
                width: _thumbnailSize,
                height: _thumbnailSize,
                fit: BoxFit.cover,
                gaplessPlayback: true,
                // The cache re-encoded these bytes itself, so a failure here
                // is not expected — but an unbounded error placeholder would
                // blow out the chip's layout, so fall back to the glyph.
                errorBuilder: (context, error, stackTrace) => SizedBox.square(
                  dimension: _thumbnailSize,
                  child: Center(child: glyph),
                ),
              ),
            ),
          const SizedBox(width: 4),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 200),
            child: Text(
              attachment.filename,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: AppTypography.bodySmall.copyWith(color: colors.foreground),
            ),
          ),
        ],
      ),
    );
  }
}
