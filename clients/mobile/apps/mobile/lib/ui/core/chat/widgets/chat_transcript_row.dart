import 'package:flutter/material.dart';
import 'package:mobile/data/models/chat_message.dart';
import 'package:mobile/data/models/turn_timer.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/shimmer/shimmer_text.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/widgets/message_markdown.dart';
import 'package:mobile/ui/core/chat/view_models/attachment_thumbnail_cache.dart';
import 'package:mobile/ui/core/chat/view_models/transcript_projection.dart';
import 'package:mobile/ui/core/chat/view_models/turn_grouping.dart';
import 'package:mobile/ui/core/chat/view_models/response_action_target.dart';
import 'package:mobile/ui/core/chat/widgets/response_actions.dart';
import 'package:mobile/ui/core/chat/widgets/attachment_thumbnail_scope.dart';
import 'package:mobile/ui/core/chat/widgets/delivery_footer.dart';
import 'package:mobile/ui/core/chat/widgets/message_bubble_surface.dart';
import 'package:mobile/ui/core/chat/widgets/retained_message_attribution.dart';
import 'package:mobile/ui/core/chat/widgets/step_chevron.dart';
import 'package:mobile/ui/core/chat/widgets/step_run_row.dart';
import 'package:mobile/ui/core/chat/widgets/tool_call_row.dart';
import 'package:mobile/ui/core/chat/widgets/watcher_message_bubble.dart';

/// Renders a projected row. The viewport owns list identity and scroll anchors.
class ChatTranscriptRow extends StatelessWidget {
  const ChatTranscriptRow({
    super.key,
    required this.row,
    this.onToggle,
    this.onResend,
    this.onDiscard,
    this.onFork,
    this.forkEnabled = false,
  });

  final TranscriptRow row;
  final ValueChanged<String>? onToggle;
  final ValueChanged<String>? onResend;
  final ValueChanged<String>? onDiscard;
  final ForkResponse? onFork;
  final bool forkEnabled;

  @override
  Widget build(BuildContext context) => switch (row) {
    TranscriptResponseActionsRow(:final message, :final target) => Padding(
      padding: const EdgeInsets.symmetric(
        horizontal: MessageBubbleSurface.textInset,
      ),
      child: ResponseActions(
        text: message.text,
        target: target,
        occurredAt: message.occurredAt,
        forkEnabled: forkEnabled,
        onFork: onFork,
      ),
    ),
    TranscriptMessageRow(
      :final message,
      :final toolResults,
      :final streamingSpinner,
      :final parts,
    ) =>
      _MessageBubble(
        key: ValueKey('message-content-${message.messageId}'),
        message: message,
        toolResults: toolResults,
        streamingSpinner: streamingSpinner,
        showParts: parts,
        onResend: onResend,
        onDiscard: onDiscard,
      ),
    TranscriptStepsRow(
      :final turnKey,
      :final counts,
      :final expanded,
      :final timer,
    ) =>
      _TurnWorkHeader(
        turnKey: turnKey,
        counts: counts,
        expanded: expanded,
        timer: timer,
        onTap: () => onToggle?.call(turnKey),
      ),
    TranscriptRunRow(
      :final runKey,
      :final steps,
      :final shownFrom,
      :final expanded,
      :final toolResults,
    ) =>
      StepRunRow(
        steps: steps,
        shownFrom: shownFrom,
        expanded: expanded,
        toolResults: toolResults,
        onToggle: () => onToggle?.call(runKey),
      ),
    TranscriptTimerRow(:final timer) => _TurnStatusRow(timer: timer),
    TranscriptTurnFooterRow() => const SizedBox.shrink(),
  };
}

/// A finished turn's header, as desktop's clean `TurnWorkHeader`: "Worked
/// for 3m 24s" in the step rows' quiet ink with a chevron that opens the
/// steps the turn folded away, over a hairline that closes the header. The
/// semantics label names what the steps did. A turn with no steps keeps the
/// words and nothing to open.
class _TurnWorkHeader extends StatelessWidget {
  const _TurnWorkHeader({
    required this.turnKey,
    required this.counts,
    required this.expanded,
    required this.timer,
    required this.onTap,
  });

  final String turnKey;
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
            key: ValueKey('turn-steps-$turnKey'),
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
