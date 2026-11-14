// dart format off
// GENERATED FILE. Do not edit by hand.
// Maintainer-generated API bindings; verify with the adjacent public digest manifest.

enum BrowserPortalCommandStatus {
  queued('QUEUED'),
  delivered('DELIVERED'),
  completed('COMPLETED'),
  failed('FAILED'),
  expired('EXPIRED'),
  ;

  const BrowserPortalCommandStatus(this.wire);

  final String wire;

  static BrowserPortalCommandStatus fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown BrowserPortalCommandStatus: $wire'),
      );
}

/// Response of `GET .../portal/browser/sessions/{sessionId}/commands/{commandId}`. A small-RPC submit waits a bounded time for the desktop completion; when the paired desktop's outbox is saturated the completion can land well after that wait expires. This endpoint lets the browser keep asking for the late result instead of treating the queued submit as a failure.
class BrowserPortalCommandStatusResponse {
  const BrowserPortalCommandStatusResponse({this.archiveDeadlineRemainingMs, required this.commandId, this.delivered, this.error, this.result, required this.status});

  /// Remaining time until a standalone archive's server-assigned start deadline.
  final num? archiveDeadlineRemainingMs;
  final String commandId;
  /// Delivered work may outlive expiry; only undelivered expiry is retryable.
  final bool? delivered;
  /// Present once `status` is `FAILED` or `EXPIRED`; always path-free.
  final String? error;
  /// Present once `status` is `COMPLETED` and the desktop returned a payload.
  final Map<String, dynamic>? result;
  final BrowserPortalCommandStatus status;

  factory BrowserPortalCommandStatusResponse.fromJson(Map<String, dynamic> json) => BrowserPortalCommandStatusResponse(
        archiveDeadlineRemainingMs: json['archiveDeadlineRemainingMs'] as num?,
        commandId: json['commandId'] as String,
        delivered: json['delivered'] as bool?,
        error: json['error'] as String?,
        result: json['result'] as Map<String, dynamic>?,
        status: BrowserPortalCommandStatus.fromWire(json['status'] as String),
      );
}
