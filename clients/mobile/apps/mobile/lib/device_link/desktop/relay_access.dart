import '../protocol.dart';

final class DesktopRelayAccessException extends DeviceLinkException {
  const DesktopRelayAccessException(this.statusCode, {this.code})
    : super(
        'Connection access is unavailable. Try again or check your account.',
      );
  final int statusCode;

  /// The token route's machine-readable reason, when it sent one.
  final String? code;

  /// Only this code means the plan lacks Remote Control. Expired sign-in,
  /// disabled features and origin or configuration errors are not upgrades.
  bool get entitlementDenied => code == 'entitlement_denied';
}
