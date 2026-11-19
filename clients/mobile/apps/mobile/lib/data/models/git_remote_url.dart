// Ports of `isPlausibleGitRemoteUrl` from the desktop's retired Portal
// workspace adapter (deleted in CAN-5986) and of the protocol's
// `repositoryNameFromCloneUrl` (packages/protocol/src/remote-control/shell/index.ts).
// Keep the name rule identical to the protocol's; the desktop checks every
// clone URL again before it clones.

final RegExp _remoteScheme = RegExp(
  r'^(https?|git|ssh)://',
  caseSensitive: false,
);
final RegExp _scpLike = RegExp(r'^[^\s/@]+@[^\s/:]+:.+$');
final RegExp _anyScheme = RegExp(r'^[a-z][a-z\d+.-]*://', caseSensitive: false);
final RegExp _scpPrefix = RegExp(r'^[^/\\]+@[^/\\]+:');
final RegExp _trailingSeparators = RegExp(r'[/\\]+$');
final RegExp _separator = RegExp(r'[/\\]');

/// Whether [remoteUrl] looks like a remote git URL the paired desktop will
/// clone: an `https`, `http`, `git` or `ssh` URL, or scp-like `user@host:path`.
/// Local paths, `file://` and option-looking values are rejected. A
/// plausibility check only; it does not prove the repository exists.
bool isPlausibleGitRemoteUrl(String remoteUrl) {
  final value = remoteUrl.trim();
  if (value.isEmpty || value.startsWith('-')) return false;
  return _remoteScheme.hasMatch(value) || _scpLike.hasMatch(value);
}

/// The repository name a clone of [remoteUrl] gets, for display only.
/// Credentials, query and fragment never reach the name.
String repositoryNameFromCloneUrl(String remoteUrl) {
  final trimmed = remoteUrl.trim();
  var remotePath = trimmed;
  if (_anyScheme.hasMatch(trimmed)) {
    final uri = Uri.tryParse(trimmed);
    if (uri == null) return 'repository';
    remotePath = uri.path;
  } else if (_scpPrefix.hasMatch(trimmed)) {
    remotePath = trimmed.substring(trimmed.indexOf(':') + 1);
  }
  final segment = remotePath
      .replaceFirst(_trailingSeparators, '')
      .split(_separator)
      .last;
  final name = segment.endsWith('.git')
      ? segment.substring(0, segment.length - 4)
      : segment;
  return name.isEmpty ? 'repository' : name;
}
