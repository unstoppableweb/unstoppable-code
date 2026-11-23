import 'dart:async';
import 'dart:io';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:http/http.dart' as http;

import 'api_client.dart';

/// Transport for the main app's auth repository. The repository continues to
/// interpret status codes and own the session lifecycle.
final class RustAuthHttpClient extends http.BaseClient {
  Future<core.AppAuthHttp>? _transport;
  bool _closed = false;

  Future<core.AppAuthHttp> _open() async {
    await core.initCoreBridge();
    final client = HttpClient();
    try {
      return await core.AppAuthHttp.open(userAgent: client.userAgent);
    } finally {
      client.close(force: true);
    }
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final uri = request.url;
    _checkOpen(uri);
    if (uri.hasQuery || uri.hasFragment || uri.userInfo.isNotEmpty) {
      throw http.ClientException('Invalid authentication endpoint.', uri);
    }
    final authorization = request.headers['authorization'];
    final body = await request.finalize().toBytes();
    _checkOpen(uri);
    try {
      final opening = _transport ??= _open();
      final core.AppAuthHttp transport;
      try {
        transport = await opening;
      } catch (_) {
        if (identical(_transport, opening)) _transport = null;
        rethrow;
      }
      _checkOpen(uri);
      final result = await transport.request(
        request: core.AppAuthRequest(
          origin: uri.origin,
          method: request.method,
          path: uri.path,
          body: body,
          token: authorization != null && authorization.startsWith('Bearer ')
              ? authorization.substring('Bearer '.length)
              : null,
          proof: request.headers['x-two-factor-verified'],
          clientVersion: request.headers[clientSurfaceVersionHeader],
        ),
      );
      return http.StreamedResponse(
        Stream.value(result.body),
        result.status,
        headers: result.headers,
        request: request,
      );
    } on core.CoreFailure catch (error) {
      if (error.kind == core.FailureKind.timeout) {
        throw TimeoutException('Authentication request timed out.');
      }
      throw http.ClientException('Authentication request failed.', uri);
    }
  }

  void _checkOpen(Uri uri) {
    if (_closed) {
      throw http.ClientException('Authentication client closed.', uri);
    }
  }

  @override
  void close() {
    _closed = true;
    final opening = _transport;
    _transport = null;
    if (opening != null) {
      unawaited(
        opening.then(
          (transport) => transport.dispose(),
          onError: (Object _) {},
        ),
      );
    }
    super.close();
  }
}
