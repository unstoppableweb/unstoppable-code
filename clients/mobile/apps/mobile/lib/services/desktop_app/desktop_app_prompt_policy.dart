/// What mobile knows about whether this account works with a desktop.
enum DesktopPairing {
  /// Computer connect has not read the account's saved computers yet.
  unknown,

  /// The saved computers were read and none is paired.
  none,

  /// A computer is saved for this account. One that is offline or
  /// disconnected still counts.
  paired;

  /// [settled] says whether the saved computers were read; [hasComputers]
  /// whether any is saved.
  static DesktopPairing of({
    required bool settled,
    required bool hasComputers,
  }) {
    if (hasComputers) return paired;
    return settled ? none : unknown;
  }
}

/// Whether the signed-in account may be offered the desktop app at all: the
/// drawer entry shows exactly when this holds, and the one-time prompt also
/// needs the account not to have closed it before.
bool canOfferDesktopApp({
  required String? accountScope,
  required DesktopPairing pairing,
}) => accountScope != null && pairing == DesktopPairing.none;
