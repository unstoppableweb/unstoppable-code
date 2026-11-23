/// Classification of one line of a unified-diff patch.
///
/// Mirrors the dependency-free classifier in
/// `packages/ui-app/src/code/file/UnifiedDiffView.tsx` so mobile colors a
/// patch exactly as the web portal does.
enum UnifiedDiffLineKind { add, del, hunk, meta, context }

/// One classified patch line. [text] keeps its leading `+`/`-`/space marker.
class UnifiedDiffLine {
  const UnifiedDiffLine(this.kind, this.text);

  final UnifiedDiffLineKind kind;
  final String text;
}
