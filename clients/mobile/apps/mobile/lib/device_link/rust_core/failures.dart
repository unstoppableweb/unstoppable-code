import 'package:computer_connect_core/computer_connect_core.dart';

import '../desktop/ipc.dart';
import '../desktop/relay_access.dart';
import '../protocol.dart';

/// Maps typed Rust core failures to the exceptions and messages the Dart
/// transport throws in the same situation. Product code distinguishes
/// [DesktopIpcRefusal] (the desktop answered), [DesktopIpcNotSent] (safe to
/// retry), [DesktopRelayAccessException] (sign-in or plan) and other
/// [DeviceLinkException]s, and shows their messages.

/// `session.dart:166-176`.
const desktopRefusedMessage = 'The desktop refused the request.';

/// `session.dart:359-361` (`_end`): pending requests and closed admission.
const connectionEndedMessage = 'The connection to the computer ended.';

/// `repository.dart:153,173`, `session.dart:342`.
const connectFirstMessage = 'Connect to a computer first.';

/// `session.dart:268-270`.
const noAnswerMessage =
    'The desktop peer did not answer. Reconnect to try again.';

/// `session.dart:260`, and any encoder failure (`_send` -> `catchError`).
const notSentMessage = 'The request could not be sent.';

/// `repository.dart:93,97,132,136`, `hub.dart:129`.
const cancelledMessage = 'Connection cancelled.';

/// `session.dart:105`.
const secureConnectionMessage = 'The secure connection did not finish.';

/// `relay.dart:195-197`.
const relayAuthenticationMessage =
    'Could not authenticate with the device relay.';

/// `desktop_link_model.dart:78-80`: what the product shows for a failure that
/// is not a [DeviceLinkException].
const unknownFailureMessage = 'The connection could not complete. Try again.';

/// Messages for local codes, used when the core sent none. Each repeats the
/// Dart transport's wording for the same situation.
const rustLocalMessages = <String, String>{
  'not_connected': connectFirstMessage,
  'send_failed': notSentMessage,
  'cancelled': cancelledMessage,
  // repository.dart:103-105
  'peer_offline': 'This computer is offline or remote access is turned off.',
  'remote_access_off':
      'This computer is offline or remote access is turned off.',
  // repository.dart:109
  'pairing_required': 'Pair this computer again to connect.',
  // repository.dart:112, hub.dart:89
  'peer_identity_changed': 'The computer identity changed.',
  // relay.dart:362
  'session_exists': 'This computer already has a session.',
  // session.dart:297
  'pairing_declined': 'Pairing was declined or expired.',
  // session.dart:333-335
  'protocol_changed':
      'The computer connection version changed. Reconnect to try again.',
  // version.dart:12-15
  'unreadable_version':
      'The computer sent an unreadable connection version. '
      'Update the desktop app and try again.',
  // relay.dart:303
  'relay_connect': 'Could not open the device relay.',
  // relay.dart:307
  'relay_protocol': 'Unsupported relay protocol.',
  // relay.dart:342-343
  'relay_outdated': 'The connection service is out of date. Try again later.',
  // relay.dart:288
  'invalid_relay': 'Invalid relay URL.',
  // relay.dart:360,490
  'relay_closed': 'The relay disconnected.',
  'relay_auth_failed': relayAuthenticationMessage,
  'invalid_token': relayAuthenticationMessage,
  // hub.dart:112 (a disposed hub), the core after close
  'shutdown': 'The connection ended.',
  // The call's account signed out or was switched; the Dart transport
  // disposes that account's hub, so it reads as the hub's end above.
  'account_changed': 'The connection ended.',
  // hub.dart:64-66
  'identity_unreadable':
      'The saved device identity could not be read. It was preserved.',
  // Handshake failures: session.dart:105.
  'handshake_failed': secureConnectionMessage,
  'handshake_timeout': secureConnectionMessage,
  'handshake_order': secureConnectionMessage,
  'peer_identity': secureConnectionMessage,
  'peer_signature': secureConnectionMessage,
};

/// Codes that only a broken caller or a core bug produce. They surface as a
/// [StateError], as a programming error in the Dart transport would, instead
/// of a user-facing [DeviceLinkException].
const _contractCodes = {
  'invalid_input',
  'invalid_json',
  'invalid_surface',
  'unknown_operation',
  'native_panic',
};

/// The core stopped under a call (`ComputerConnectCore.close`).
const coreShutdown = CoreFailure(kind: FailureKind.local, code: 'shutdown');

/// A service's views ended under a call that waits for one: the account
/// scope the service was opened in ended, or the core stopped. As a
/// connection that ends under a request, `session.dart:359-361`.
const viewsEnded = CoreFailure(kind: FailureKind.ended, code: 'views_ended');

/// The exception the Dart transport throws for [error].
Object rustFailure(CoreFailure error) {
  switch (error.kind) {
    case FailureKind.refused:
      // session.dart:165-180: the desktop's message (first 4096 UTF-16
      // units, already cut by the core) and code. The core reports a missing
      // code as `desktop_refused`; Dart has null.
      return DesktopIpcRefusal(
        error.message ?? desktopRefusedMessage,
        code: error.code == 'desktop_refused' ? null : error.code,
      );
    case FailureKind.notSent:
      return DesktopIpcNotSent(error.message ?? connectionEndedMessage);
    case FailureKind.timeout:
      return const DeviceLinkException(noAnswerMessage);
    case FailureKind.ended:
      return const DeviceLinkException(connectionEndedMessage);
    case FailureKind.http:
      return _httpFailure(error);
    case FailureKind.local:
      break;
  }
  if (_contractCodes.contains(error.code)) {
    return StateError('Computer connection core: ${error.code}');
  }
  return switch (error.code) {
    // The core validates the app session before relay work. Dart reaches the
    // same server answer from the relay-token route instead:
    // computer_connect_access.dart:28 for a missing session, and the route's
    // 403 `personal_account_required` for a guest.
    'account_required' => const DesktopRelayAccessException(
      403,
      code: 'personal_account_required',
    ),
    _ => DeviceLinkException(
      error.message ?? rustLocalMessages[error.code] ?? unknownFailureMessage,
    ),
  };
}

/// relay.dart:163-175: 401/403/404 are access failures with the route's code
/// (null when the body had none); other statuses are temporary.
Exception _httpFailure(CoreFailure error) {
  final status = error.status;
  if (error.code == 'sign_in_required') {
    // The core found no valid session; the relay-token route answers 401
    // `unauthorized` for that.
    return DesktopRelayAccessException(status ?? 401, code: 'unauthorized');
  }
  if (status == 401 || status == 403 || status == 404) {
    return DesktopRelayAccessException(
      status!,
      code: error.code == 'relay_access_denied' ? null : error.code,
    );
  }
  if (error.code == 'relay_unavailable' && error.message != null) {
    return DeviceLinkException(error.message!);
  }
  return const DeviceLinkException(relayAuthenticationMessage);
}
