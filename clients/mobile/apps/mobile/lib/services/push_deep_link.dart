/// The web link a cloud workflow run's push carries (`type: cloud_run`, sent by
/// `apps/web/src/lib/web-core/cloud-run-notice-delivery.ts`), when it opens
/// the run on [appOrigin]. Null for any other push, and for a link to another
/// origin, so a tap never opens a site the app doesn't serve.
String? cloudRunPushUrl(Map<String, String> data, String appOrigin) {
  if (data['type'] != 'cloud_run') return null;
  final url = Uri.tryParse(data['url'] ?? '');
  final app = Uri.tryParse(appOrigin);
  if (url == null || app == null) return null;
  bool web(Uri uri) =>
      (uri.scheme == 'https' || uri.scheme == 'http') && uri.host.isNotEmpty;
  if (!web(url) || !web(app) || url.origin != app.origin) return null;
  return url.toString();
}

/// Relay device ids are 22 base64url characters
/// (`packages/protocol/src/device-relay`).
final _relayDeviceId = RegExp(r'^[A-Za-z0-9_-]{22}$');

/// The chat a desktop chat's push names on the computer that owns it, sent as
/// `computerId` and `clientChatId` by `apps/web/src/lib/push/chat-push-data.ts`.
/// Null unless both are present and `computerId` is a relay device id; an
/// older server or desktop sends no `computerId`.
({String computerId, String clientChatId})? computerChatPushTarget(
  Map<String, String> data,
) {
  final computerId = data['computerId'];
  final clientChatId = data['clientChatId'];
  if (computerId == null || !_relayDeviceId.hasMatch(computerId)) return null;
  if (clientChatId == null || clientChatId.isEmpty) return null;
  return (computerId: computerId, clientChatId: clientChatId);
}
