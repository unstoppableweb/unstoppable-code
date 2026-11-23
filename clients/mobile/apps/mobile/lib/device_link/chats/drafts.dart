import 'models.dart';

/// Composer drafts of one computer's chats, as the chat view model reads
/// and writes them. Reads are synchronous: the composer follows them on
/// every build.
///
abstract interface class DeviceChatDrafts {
  /// The draft of [ref], or `''`.
  String draftFor(DeviceChatRef ref);

  /// Saves [text] for [ref]; empty text removes the draft.
  void setDraft(DeviceChatRef ref, String text);

  /// The computer has (or the transcript confirmed) [text] sent to [ref]:
  /// the draft is cleared when it still equals [text].
  void sent(DeviceChatRef ref, String text);
}
