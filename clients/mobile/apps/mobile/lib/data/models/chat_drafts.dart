/// Where a composer draft belongs. Value equality is by [key].
sealed class DraftTarget {
  const DraftTarget();

  String get key;

  @override
  bool operator ==(Object other) => other is DraftTarget && other.key == key;

  @override
  int get hashCode => key.hashCode;

  @override
  String toString() => 'DraftTarget($key)';
}

/// A computer's Home composer in one navigation context. The account and
/// environment already scope the containing store.
final class ComputerHomeDraftTarget extends DraftTarget {
  const ComputerHomeDraftTarget({
    required this.computerId,
    required this.contextId,
  });
  final String computerId, contextId;
  @override
  String get key =>
      'computer:home:${Uri.encodeComponent(computerId)}/${Uri.encodeComponent(contextId)}';
}

abstract interface class ChatDraftPort {
  /// The saved text for [target], or `''`.
  String draftFor(DraftTarget target);

  /// Saves [text] for [target]; empty text removes the draft.
  void setDraft(DraftTarget target, String text);

  /// Re-keys the draft at [from] to [to]. Does nothing when [from] is empty.
  void moveDraft(DraftTarget from, DraftTarget to);

  /// Attempts to write pending changes. Returns false when persistence fails;
  /// the changes remain available for a later retry.
  Future<bool> flush();
}

/// Keeps edits made while the Rust Home drafts are loading.
final class InMemoryChatDraftStore implements ChatDraftPort {
  final _drafts = <DraftTarget, String>{};

  @override
  String draftFor(DraftTarget target) => _drafts[target] ?? '';

  @override
  void setDraft(DraftTarget target, String text) {
    if (text.isEmpty) {
      _drafts.remove(target);
    } else {
      _drafts[target] = text;
    }
  }

  @override
  void moveDraft(DraftTarget from, DraftTarget to) {
    if (from == to) return;
    if (_drafts.remove(from) case final text?) _drafts[to] = text;
  }

  @override
  Future<bool> flush() async => true;
}
