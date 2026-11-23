import 'package:mobile/data/models/computer_recent_order.dart';
import 'package:mobile/ui/features/device_link/computer_connect/account_model.dart';
import 'package:mobile/ui/features/device_link/computer_connect/usage_model.dart';

typedef ComputerConnectBinding = ({
  ComputerAccountModel Function() createAccount,
  ComputerUsageModel Function(ComputerAccountModel account) createUsage,
  ComputerRecentOrder orderRecents,
});

/// The app's Computer Connect runtime.
abstract interface class ComputerConnectTransport {
  Future<void> close();

  /// Ends the sessions of the app session being signed out: [token]'s, or
  /// every one this transport adopted when the app no longer holds a token.
  Future<void> signOut(String? token);

  /// Binds [accountId] at [origin]. [sessionToken] and [twoFactorProof]
  /// return the app's current session for that account on every call.
  ComputerConnectBinding bind({
    required String origin,
    required String accountId,
    required String? Function() sessionToken,
    required String? Function() twoFactorProof,
  });
}
