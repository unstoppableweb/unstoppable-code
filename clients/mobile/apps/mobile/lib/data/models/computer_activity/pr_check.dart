/// One CI check on a pull request, mirroring an element of the Portal
/// `RemoteControlPullRequestRepoStatus.checkDetails` list (CAN-3618).
///
/// Parsing is lenient: a malformed entry is skipped without losing its
/// siblings, and unknown status strings are kept so the display layer can
/// degrade them to Neutral rather than fail.
class RemotePrCheck {
  const RemotePrCheck({
    required this.name,
    this.status,
    this.executionState,
    this.detailsUri,
  });

  final String name;

  /// Four-value wire status: `'success' | 'failure' | 'pending' |
  /// 'neutral'` (open set). Null when the host sent no string.
  final String? status;

  /// Detailed GitHub state: `'queued' | 'running' | 'success' | 'failure' |
  /// 'cancelled' | 'timed_out' | 'skipped' | 'action_required' | 'neutral'`
  /// (open set). Older desktops omit it.
  final String? executionState;

  /// The check's details page, kept only when it is an absolute http(s) URL
  /// with a host; anything else cannot be opened from the phone.
  final Uri? detailsUri;

  /// Parses the wire list, keeping host order. A missing or non-list value
  /// yields an empty list.
  static List<RemotePrCheck> listFromJson(Object? json) {
    if (json is! List) return const [];
    return [for (final entry in json) ?_fromJson(entry)];
  }

  static RemotePrCheck? _fromJson(Object? json) {
    if (json is! Map) return null;
    final name = json['name'];
    if (name is! String || name.isEmpty) return null;
    final status = json['status'];
    final executionState = json['executionState'];
    return RemotePrCheck(
      name: name,
      status: status is String ? status : null,
      executionState: executionState is String ? executionState : null,
      detailsUri: _webUri(json['detailsUrl']),
    );
  }

  static Uri? _webUri(Object? value) {
    if (value is! String) return null;
    final uri = Uri.tryParse(value.trim());
    if (uri == null || uri.host.isEmpty) return null;
    return uri.scheme == 'https' || uri.scheme == 'http' ? uri : null;
  }
}
