import 'package:mobile/app/computer_connect_transport.dart';

/// Ends [token]'s Computer Connect sessions on [transport], or every session
/// it adopted when a session check already cleared the token, then runs
/// [unregisterPush]. Unregistering needs the session token, which is cleared
/// after this returns, so it runs even when ending the sessions throws; that
/// error still propagates.
Future<void> cleanUpBeforeSignOut({
  required String? token,
  required ComputerConnectTransport? transport,
  required Future<void> Function() unregisterPush,
}) async {
  try {
    await transport?.signOut(token);
  } finally {
    await unregisterPush();
  }
}
