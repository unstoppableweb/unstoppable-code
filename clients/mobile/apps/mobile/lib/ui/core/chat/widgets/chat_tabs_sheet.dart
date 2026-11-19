import 'package:flutter/material.dart';
import 'package:mobile/core/design-system/button/canopy_button.dart';
import 'package:mobile/core/design-system/icon-button/canopy_icon_button.dart';
import 'package:mobile/core/design-system/icon/canopy_glyph.dart';
import 'package:mobile/core/design-system/icon/canopy_icon.dart';
import 'package:mobile/core/design-system/overlay-action/canopy_overlay_action.dart';
import 'package:mobile/core/design-system/spinner/comet_spinner.dart';
import 'package:mobile/data/models/chat_tab_item.dart';
import 'package:mobile/ui/core/design_tokens.dart';
import 'package:mobile/ui/core/status_colors.dart';
import 'package:mobile/ui/core/typography.dart';
import 'package:mobile/ui/core/chat/widgets/pending_question_indicator.dart';

/// Floating entry point to a worktree's chats. Replaces the horizontal
/// tab strip that used to sit above the transcript: on a phone the strip cost
/// a permanent 48px band and still truncated every title past the second tab.
///
/// The dot is an aggregate over the worktree's chats, carrying the
/// same two signals the sidebar worktree row does — and, like that row, at
/// most one of them at a time. A question outranks unread because reading
/// does not clear it: unseen output stops mattering the moment you look at it,
/// while an unanswered question keeps blocking its agent either way.
///
/// The open chat acknowledges its own unread state through the screen's
/// read-receipt path, so it clears without being special-cased here. Its
/// questions deliberately still count: the card can be scrolled far out of
/// view, and the sheet is where you find out which chat is waiting.
class ChatTabsFab extends StatelessWidget {
  const ChatTabsFab({
    super.key,
    required this.hasUnread,
    required this.needsAnswer,
    required this.onPressed,
  });

  final bool hasUnread;

  /// Some conversation in this worktree has an unanswered question.
  final bool needsAnswer;

  final VoidCallback onPressed;

  CanopyOverlayActionBadge? _badge(StatusColors status) {
    if (needsAnswer) {
      return CanopyOverlayActionBadge(
        color: status.warning,
        label: PendingQuestionIndicator.message,
        dotKey: const ValueKey('chat-tabs-question'),
      );
    }
    if (hasUnread) {
      return CanopyOverlayActionBadge(
        color: status.unread,
        label: 'Unread',
        dotKey: const ValueKey('chat-tabs-unread'),
      );
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    return CanopyOverlayAction(
      key: const ValueKey('chat-tabs-fab'),
      glyph: CanopyGlyph.listBullets,
      label: 'Chats',
      onPressed: onPressed,
      badge: _badge(StatusColors.of(context)),
    );
  }
}

/// Everything about a worktree's chats that can change while the sheet is
/// open, resolved fresh on every notification rather than captured once.
@immutable
class ChatTabsLiveState {
  const ChatTabsLiveState({
    this.working = const {},
    this.unread = const {},
    this.needsAnswer = const {},
  });

  /// Chats with a turn in flight. They cannot be closed, and their progress
  /// takes the trailing slot.
  final Set<String> working;

  /// Chats with finished output nobody has looked at yet.
  final Set<String> unread;

  /// Chats blocked on an unanswered question.
  final Set<String> needsAnswer;
}

/// Opens the chat list for a worktree: one row per chat tab plus a pinned
/// "New chat" action. When [files] is not empty, the files the computer has
/// open in the worktree follow under their own heading and open through
/// [onOpenFile].
///
/// Row *state* is live. [chatState] is the owning screen's change source (its
/// view model) and [resolveLiveState] re-derives [ChatTabsLiveState] on every
/// notification, so a turn starting or finishing, output going unread, and a
/// question arriving all reach an already-open sheet. Without it the sheet was
/// a photograph taken when the FAB was tapped, and a chat could sit there
/// spinning long after its turn ended.
///
/// Row *membership* is deliberately still the [summaries] snapshot. The screen
/// layers optimistic create/close bookkeeping over the projection, and every
/// sheet action pops before invoking its callback, so a row never has to
/// disappear underneath the user's finger.
///
/// [chatState] is passed in rather than looked up from a provider: a modal
/// route is a sibling overlay entry of the route that opened it, not a
/// descendant, so providers around the opening chat screen are not visible
/// from here.
Future<void> showChatTabsSheet(
  BuildContext context, {
  required List<ChatTabItem> summaries,
  required String? selectedChatId,
  required ValueChanged<String> onSelect,
  required VoidCallback? onNewChat,
  required Listenable chatState,
  required ChatTabsLiveState Function() resolveLiveState,
  ValueChanged<String>? onClose,
  List<ChatFileTabItem> files = const [],
  ValueChanged<String>? onOpenFile,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    showDragHandle: true,
    builder: (sheetContext) => _ChatTabsSheetBody(
      summaries: summaries,
      selectedChatId: selectedChatId,
      chatState: chatState,
      resolveLiveState: resolveLiveState,
      onSelect: onSelect,
      onNewChat: onNewChat,
      onClose: onClose,
      files: onOpenFile == null ? const [] : files,
      onOpenFile: onOpenFile,
    ),
  );
}

class _ChatTabsSheetBody extends StatelessWidget {
  const _ChatTabsSheetBody({
    required this.summaries,
    required this.selectedChatId,
    required this.chatState,
    required this.resolveLiveState,
    required this.onSelect,
    required this.onNewChat,
    required this.onClose,
    required this.files,
    required this.onOpenFile,
  });

  /// Width of every row's trailing slot, which carries whichever of the two
  /// mutually exclusive controls applies: the close button, or the progress
  /// spinner on a running chat that cannot be closed.
  ///
  /// It is the close control's own padded touch target, so the row adds no
  /// right content inset on top of it — stacking the two pushed the glyph
  /// ~40px off the edge, which read as a gap rather than a margin. The slot is
  /// reserved even when it is empty so every title ends on the same edge.
  ///
  /// The slot centers its child rather than sizing it: a tight width overrides
  /// [CanopyIconButton]'s own `fixedSize` and stretches the pressed surface
  /// into a 48x32 rectangle instead of the design system's square control.
  static const double _trailingSlotWidth = 48;

  /// Progress footprint, matching the close glyph it stands in for so the slot
  /// keeps one optical weight across the two states.
  static const double _progressSize = 20;

  final List<ChatTabItem> summaries;
  final String? selectedChatId;
  final Listenable chatState;
  final ChatTabsLiveState Function() resolveLiveState;
  final ValueChanged<String> onSelect;
  final VoidCallback? onNewChat;
  final ValueChanged<String>? onClose;
  final List<ChatFileTabItem> files;
  final ValueChanged<String>? onOpenFile;

  /// The attention signal shown beside this chat's name, or null when it has
  /// none. Progress is not one of them — it lives in the trailing slot, where
  /// it stands in for the close control it displaces.
  ///
  /// A question outranks unread, matching the FAB's aggregate dot. Unread is
  /// suppressed while the chat is running: output that is still arriving is
  /// not yet something you have failed to read.
  Widget? _status(BuildContext context, ChatTabsLiveState live, String chatId) {
    if (live.needsAnswer.contains(chatId)) {
      return PendingQuestionIndicator.dot(
        key: ValueKey('chat-question-$chatId'),
      );
    }
    if (live.working.contains(chatId)) {
      return null;
    }
    if (live.unread.contains(chatId)) {
      return Semantics(
        label: 'Unread',
        child: Container(
          key: ValueKey('chat-unread-$chatId'),
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            color: StatusColors.of(context).unread,
            shape: BoxShape.circle,
          ),
        ),
      );
    }
    return null;
  }

  Widget _filesHeading(BuildContext context) => Padding(
    key: const ValueKey('chat-tabs-files-heading'),
    padding: const EdgeInsets.fromLTRB(16, 16, 16, 4),
    child: Text(
      'Files',
      style: Theme.of(context).textTheme.labelSmall?.copyWith(
        color: AppColors.of(context).foregroundSecondary,
        fontWeight: AppTypography.emphasisWeight,
        fontVariations: AppTypography.emphasisVariations,
      ),
    ),
  );

  /// Files have no live state: no progress, unread or close control. The
  /// trailing slot is still reserved so titles end on the chats' edge.
  Widget _fileRow(BuildContext context, ChatFileTabItem file) {
    final colors = AppColors.of(context);
    final theme = Theme.of(context);
    final folder = file.displayFolder;
    return ListTile(
      key: ValueKey('chat-file-tab-${file.fileTabId}'),
      titleTextStyle: theme.textTheme.bodyMedium,
      contentPadding: const EdgeInsets.fromLTRB(16, 4, 0, 4),
      minLeadingWidth: 0,
      horizontalTitleGap: 12,
      leading: CanopyIcon(
        glyph: CanopyGlyph.fileText,
        size: 16,
        tint: colors.foregroundSecondary,
      ),
      title: Text(
        file.displayTitle,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      subtitle: folder == null
          ? null
          : Text(
              folder,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: theme.textTheme.bodySmall?.copyWith(
                color: colors.foregroundSecondary,
              ),
            ),
      onTap: () {
        Navigator.of(context).pop();
        onOpenFile?.call(file.fileTabId);
      },
      trailing: const SizedBox(width: _trailingSlotWidth),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = AppColors.of(context);
    final theme = Theme.of(context);
    final onClose = this.onClose;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          // 16 matches the rows' leading content inset, so the header lines up
          // with the titles below it.
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Text('Chats', style: theme.textTheme.titleMedium),
          ),
        ),
        Flexible(
          // Only the rows listen: the header and the pinned action do not
          // depend on chat state, so a turn ticking over does not rebuild
          // them.
          child: ListenableBuilder(
            listenable: chatState,
            builder: (context, _) {
              final live = resolveLiveState();
              return ListView.builder(
                shrinkWrap: true,
                padding: EdgeInsets.zero,
                itemCount:
                    summaries.length + (files.isEmpty ? 0 : files.length + 1),
                itemBuilder: (context, index) {
                  if (index >= summaries.length) {
                    final fileIndex = index - summaries.length - 1;
                    return fileIndex < 0
                        ? _filesHeading(context)
                        : _fileRow(context, files[fileIndex]);
                  }
                  final summary = summaries[index];
                  final chatId = summary.chatId;
                  // A running chat cannot be closed — the desktop rejects it and
                  // the strip suppressed the control for the same reason. Its
                  // progress takes the slot the close control would have had.
                  final Widget? trailingControl = live.working.contains(chatId)
                      ? const ThinkingSpinner(size: _progressSize)
                      : onClose == null
                      ? null
                      : CanopyIconButton(
                          key: ValueKey('chat-tab-close-$chatId'),
                          glyph: CanopyGlyph.crossMedium,
                          size: CanopyIconButtonSize.small,
                          tooltip: 'Close ${summary.displayTitle}',
                          // Explicit tint: ListTile's selectedColor otherwise
                          // paints the selected row's close glyph accent blue,
                          // which reads as a primary action rather than the quiet
                          // dismissal it is.
                          tint: colors.foregroundSecondary,
                          onPressed: () {
                            Navigator.of(context).pop();
                            onClose(chatId);
                          },
                        );
                  return ListTile(
                    key: ValueKey('chat-tab-$chatId'),
                    selected: chatId == selectedChatId,
                    selectedTileColor: colors.surfaceRaised,
                    // Accent title, not just a tinted row: on a sheet whose own
                    // background is already a raised surface, the fill alone is
                    // too weak to say "this is the chat you are in".
                    selectedColor: colors.accent,
                    // One step below body: the sheet is a dense list to scan
                    // against a header, not prose.
                    titleTextStyle: theme.textTheme.bodyMedium,
                    contentPadding: const EdgeInsets.fromLTRB(16, 8, 0, 8),
                    minVerticalPadding: 8,
                    title: Row(
                      children: [
                        // Two lines before truncating: one line turned most real
                        // titles into a prefix, and the sheet is where you tell
                        // similarly-named chats apart.
                        Flexible(
                          child: Text(
                            summary.displayTitle,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        // Beside the name rather than out in the trailing cluster:
                        // the status belongs to the chat you are reading, and next
                        // to the close control it read as part of that control.
                        if (_status(context, live, chatId)
                            case final status?) ...[
                          const SizedBox(width: 8),
                          status,
                        ],
                      ],
                    ),
                    onTap: () {
                      Navigator.of(context).pop();
                      onSelect(chatId);
                    },
                    trailing: SizedBox(
                      width: _trailingSlotWidth,
                      child: trailingControl == null
                          ? null
                          : Center(child: trailingControl),
                    ),
                  );
                },
              );
            },
          ),
        ),
        // No rule above the action: the gap and the filled button already
        // separate it from the list, and a line here was a boundary the
        // layout had not earned.
        Padding(
          padding: EdgeInsets.fromLTRB(
            16,
            12,
            16,
            16 + MediaQuery.paddingOf(context).bottom,
          ),
          child: CanopyButton(
            key: const ValueKey('new-chat-button'),
            glyph: CanopyGlyph.plusSmall,
            label: 'New chat',
            expand: true,
            onPressed: onNewChat == null
                ? null
                : () {
                    Navigator.of(context).pop();
                    onNewChat!();
                  },
          ),
        ),
      ],
    );
  }
}
