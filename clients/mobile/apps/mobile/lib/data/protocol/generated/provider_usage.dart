// dart format off
// GENERATED FILE. Do not edit by hand.
// Maintainer-generated API bindings; verify with the adjacent public digest manifest.

/// Parses a JSON list, skipping any element this build cannot decode.
///
/// These collections are `required` on their parent, so letting one bad
/// element throw would fail the entire response. Dropping the row degrades
/// a single table instead of blanking every surface that shares the payload.
List<T> _parseList<T>(dynamic json, T Function(dynamic) parse) {
  final out = <T>[];
  for (final e in json as List<dynamic>) {
    try {
      out.add(parse(e));
    } catch (_) {
      // Unparseable row: skip it rather than failing the whole response.
      continue;
    }
  }
  return List<T>.of(out, growable: false);
}

enum OpenCodeAccountMethod {
  key('key'),
  oauth('oauth'),
  external('external'),
  env('env'),
  ;

  const OpenCodeAccountMethod(this.wire);

  final String wire;

  static OpenCodeAccountMethod fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown OpenCodeAccountMethod: $wire'),
      );
}

/// Where an account's limits came from: `live` is the desktop's own quota read; `passive` is what the account proxy last reported from its traffic.
enum PortalProviderUsageAccountSource {
  live('live'),
  passive('passive'),
  ;

  const PortalProviderUsageAccountSource(this.wire);

  final String wire;

  static PortalProviderUsageAccountSource fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageAccountSource: $wire'),
      );
}

/// Whether an account-proxy account can serve requests now, and why not.
enum PortalProviderUsageAccountStatus {
  active('active'),
  cooling('cooling'),
  error('error'),
  disabled('disabled'),
  refreshing('refreshing'),
  pending('pending'),
  ;

  const PortalProviderUsageAccountStatus(this.wire);

  final String wire;

  static PortalProviderUsageAccountStatus fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageAccountStatus: $wire'),
      );
}

/// Sign-in state of one provider. `error` means the last usage fetch failed; the entry's `error` field then explains it.
enum PortalProviderUsageAuthState {
  authenticated('authenticated'),
  unauthenticated('unauthenticated'),
  unknown('unknown'),
  error('error'),
  ;

  const PortalProviderUsageAuthState(this.wire);

  final String wire;

  static PortalProviderUsageAuthState fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageAuthState: $wire'),
      );
}

/// `usd` amounts are dollars (Claude Extra usage). `credits` amounts are a count of provider credits (the Codex balance), not money.
enum PortalProviderUsageCreditUnit {
  usd('usd'),
  credits('credits'),
  ;

  const PortalProviderUsageCreditUnit(this.wire);

  final String wire;

  static PortalProviderUsageCreditUnit fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageCreditUnit: $wire'),
      );
}

/// Broad category of a failed usage fetch; mirrors the desktop's kinds.
enum PortalProviderUsageErrorKind {
  auth('auth'),
  network('network'),
  service('service'),
  unsupported('unsupported'),
  unknown('unknown'),
  ;

  const PortalProviderUsageErrorKind(this.wire);

  final String wire;

  static PortalProviderUsageErrorKind fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageErrorKind: $wire'),
      );
}

/// Providers whose plan limits the `provider_usage` projection carries.
enum PortalProviderUsageProvider {
  claude('claude'),
  codex('codex'),
  copilot('copilot'),
  ;

  const PortalProviderUsageProvider(this.wire);

  final String wire;

  static PortalProviderUsageProvider fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageProvider: $wire'),
      );
}

/// Payload for `portal.provider_usage.refresh`.
enum PortalProviderUsageRefreshProvider {
  claude('claude'),
  codex('codex'),
  copilot('copilot'),
  opencode('opencode'),
  ;

  const PortalProviderUsageRefreshProvider(this.wire);

  final String wire;

  static PortalProviderUsageRefreshProvider fromWire(String wire) => values.firstWhere(
        (e) => e.wire == wire,
        orElse: () => throw FormatException('Unknown PortalProviderUsageRefreshProvider: $wire'),
      );
}

/// What the desktop knows about the Google account behind Antigravity chats. The pinned runtime reports only a plan label with each session. It is not account identity, quota, a usage period or a billing signal, and no usage limits are reported. `unavailable` means the last read failed, never that the user signed out.
class AntigravityAccountSnapshot {
  const AntigravityAccountSnapshot({this.planLabel, required this.status, required this.updatedAt});

  /// Only with `ready`, and absent when the runtime did not report a plan. Kept flat (like the OpenCode snapshot) so every binding, including the generated mobile one, carries the fields; the schema enforces the pairing.
  final String? planLabel;
  final String status;
  final String updatedAt;

  factory AntigravityAccountSnapshot.fromJson(Map<String, dynamic> json) => AntigravityAccountSnapshot(
        planLabel: json['planLabel'] as String?,
        status: json['status'] as String,
        updatedAt: json['updatedAt'] as String,
      );
}

class OpenCodeAccount {
  const OpenCodeAccount({required this.label, required this.method, required this.needsSignIn, required this.selected, this.usage});

  final String label;
  final OpenCodeAccountMethod method;
  final bool needsSignIn;
  /// Reported by the native active-connection API, never inferred from order.
  final bool selected;
  /// Read from the selected provider's usage API, never derived from chat tokens.
  final OpenCodeAccountUsage? usage;

  factory OpenCodeAccount.fromJson(Map<String, dynamic> json) => OpenCodeAccount(
        label: json['label'] as String,
        method: OpenCodeAccountMethod.fromWire(json['method'] as String),
        needsSignIn: json['needsSignIn'] as bool,
        selected: json['selected'] as bool,
        usage: json['usage'] == null ? null : OpenCodeAccountUsage.fromJson(json['usage'] as Map<String, dynamic>),
      );
}

class OpenCodeAccountProvider {
  const OpenCodeAccountProvider({required this.accounts, required this.id, required this.name});

  final List<OpenCodeAccount> accounts;
  final String id;
  final String name;

  factory OpenCodeAccountProvider.fromJson(Map<String, dynamic> json) => OpenCodeAccountProvider(
        accounts: _parseList(json['accounts'], (e) => OpenCodeAccount.fromJson(e as Map<String, dynamic>)),
        id: json['id'] as String,
        name: json['name'] as String,
      );
}

class OpenCodeAccountSnapshot {
  const OpenCodeAccountSnapshot({required this.providers, required this.status, required this.updatedAt});

  /// Empty when unavailable; never retain a previous account after failure.
  final List<OpenCodeAccountProvider> providers;
  final String status;
  final String updatedAt;

  factory OpenCodeAccountSnapshot.fromJson(Map<String, dynamic> json) => OpenCodeAccountSnapshot(
        providers: _parseList(json['providers'], (e) => OpenCodeAccountProvider.fromJson(e as Map<String, dynamic>)),
        status: json['status'] as String,
        updatedAt: json['updatedAt'] as String,
      );
}

/// The runtime schema requires all usage fields for ready and strips them on failure.
class OpenCodeAccountUsage {
  const OpenCodeAccountUsage({this.checkedAt, this.plan, required this.status, this.windows});

  final String? checkedAt;
  final String? plan;
  final String status;
  final List<OpenCodeUsageWindow>? windows;

  factory OpenCodeAccountUsage.fromJson(Map<String, dynamic> json) => OpenCodeAccountUsage(
        checkedAt: json['checkedAt'] as String?,
        plan: json['plan'] as String?,
        status: json['status'] as String,
        windows: json['windows'] == null ? null : _parseList(json['windows'], (e) => OpenCodeUsageWindow.fromJson(e as Map<String, dynamic>)),
      );
}

class OpenCodeUsageWindow {
  const OpenCodeUsageWindow({required this.id, required this.percent, required this.resetsAt});

  final String id;
  final num percent;
  final String resetsAt;

  factory OpenCodeUsageWindow.fromJson(Map<String, dynamic> json) => OpenCodeUsageWindow(
        id: json['id'] as String,
        percent: (json['percent'] as num?) ?? 0,
        resetsAt: json['resetsAt'] as String,
      );
}

/// One account the multi-account proxy shares for a provider. Display fields only: no credential file names, proxy messages, connection ids or URLs. Absent `usageSource` with no windows means usage is unavailable, never 0%.
class PortalProviderUsageAccount {
  const PortalProviderUsageAccount({this.availableAt, this.error, required this.id, this.label, this.lastUpdatedAt, this.planLabel, this.retryAt, this.signInRequired, required this.status, this.usageSource, required this.windows});

  /// ISO timestamp when a cooling account can serve again.
  final String? availableAt;
  /// The latest failed read; `windows` keep the last known values.
  final PortalProviderUsageError? error;
  /// Opaque id, unique within its entry and stable across refreshes.
  final String id;
  /// Email or account name; hosts block it from session replay.
  final String? label;
  /// ISO timestamp of the last successful usage read for this account.
  final String? lastUpdatedAt;
  /// Plan display label, e.g. `Claude Max 20x`, or `API key`.
  final String? planLabel;
  /// ISO timestamp before which the desktop will not ask again.
  final String? retryAt;
  /// The proxy can no longer renew this account's sign-in; sent with status `error`, which older hosts show. Sign in again in proxy settings.
  final bool? signInRequired;
  final PortalProviderUsageAccountStatus status;
  final PortalProviderUsageAccountSource? usageSource;
  final List<PortalProviderUsageWindow> windows;

  factory PortalProviderUsageAccount.fromJson(Map<String, dynamic> json) => PortalProviderUsageAccount(
        availableAt: json['availableAt'] as String?,
        error: json['error'] == null ? null : PortalProviderUsageError.fromJson(json['error'] as Map<String, dynamic>),
        id: json['id'] as String,
        label: json['label'] as String?,
        lastUpdatedAt: json['lastUpdatedAt'] as String?,
        planLabel: json['planLabel'] as String?,
        retryAt: json['retryAt'] as String?,
        signInRequired: json['signInRequired'] as bool?,
        status: PortalProviderUsageAccountStatus.fromWire(json['status'] as String),
        usageSource: json['usageSource'] == null ? null : PortalProviderUsageAccountSource.fromWire(json['usageSource'] as String),
        windows: _parseList(json['windows'], (e) => PortalProviderUsageWindow.fromJson(e as Map<String, dynamic>)),
      );
}

/// Credits for one window. Absent amounts were not reported.
class PortalProviderUsageCredits {
  const PortalProviderUsageCredits({this.remaining, this.spent, this.total, required this.unit});

  final num? remaining;
  final num? spent;
  final num? total;
  final PortalProviderUsageCreditUnit unit;

  factory PortalProviderUsageCredits.fromJson(Map<String, dynamic> json) => PortalProviderUsageCredits(
        remaining: json['remaining'] as num?,
        spent: json['spent'] as num?,
        total: json['total'] as num?,
        unit: PortalProviderUsageCreditUnit.fromWire(json['unit'] as String),
      );
}

/// Current-account usage of one provider.
class PortalProviderUsageEntry {
  const PortalProviderUsageEntry({this.accountEmail, this.accountLabel, this.accounts, required this.authState, this.error, this.lastUpdatedAt, this.planLabel, required this.provider, required this.windows});

  final String? accountEmail;
  /// Non-email account identity, such as a GitHub login.
  final String? accountLabel;
  /// Present only while the desktop's multi-account proxy serves this provider: its accounts, in place of the native sign-in, whose limits no longer apply. An empty list means the proxy has no account for it. Older desktops omit it.
  final List<PortalProviderUsageAccount>? accounts;
  final PortalProviderUsageAuthState authState;
  final PortalProviderUsageError? error;
  /// ISO timestamp of the desktop's last usage read for this provider.
  final String? lastUpdatedAt;
  /// Plan display label, e.g. `Claude Max 20x` or `ChatGPT Pro`.
  final String? planLabel;
  final PortalProviderUsageProvider provider;
  final List<PortalProviderUsageWindow> windows;

  factory PortalProviderUsageEntry.fromJson(Map<String, dynamic> json) => PortalProviderUsageEntry(
        accountEmail: json['accountEmail'] as String?,
        accountLabel: json['accountLabel'] as String?,
        accounts: json['accounts'] == null ? null : _parseList(json['accounts'], (e) => PortalProviderUsageAccount.fromJson(e as Map<String, dynamic>)),
        authState: PortalProviderUsageAuthState.fromWire(json['authState'] as String),
        error: json['error'] == null ? null : PortalProviderUsageError.fromJson(json['error'] as Map<String, dynamic>),
        lastUpdatedAt: json['lastUpdatedAt'] as String?,
        planLabel: json['planLabel'] as String?,
        provider: PortalProviderUsageProvider.fromWire(json['provider'] as String),
        windows: _parseList(json['windows'], (e) => PortalProviderUsageWindow.fromJson(e as Map<String, dynamic>)),
      );
}

/// Classified fetch failure with user-safe copy; never raw provider text.
class PortalProviderUsageError {
  const PortalProviderUsageError({required this.kind, required this.message});

  final PortalProviderUsageErrorKind kind;
  final String message;

  factory PortalProviderUsageError.fromJson(Map<String, dynamic> json) => PortalProviderUsageError(
        kind: PortalProviderUsageErrorKind.fromWire(json['kind'] as String),
        message: json['message'] as String,
      );
}

/// Payload of the account-level `provider_usage` singleton entity (CAN-3635), whose `localId` is `overview` in overview snapshots and deltas. Carries exactly one entry each for Claude and Codex. Copilot is included only when the host publishes its gated account-usage summary. No host paths, credentials or raw provider responses cross this boundary.
class PortalProviderUsageProjection {
  const PortalProviderUsageProjection({this.antigravityAccount, this.openCodeAccounts, required this.providers, required this.updatedAt});

  /// Optional Antigravity plan metadata, separate from quotas so older peers ignore it. Never identity, quota or a billing signal.
  final AntigravityAccountSnapshot? antigravityAccount;
  /// Optional metadata, separate from quotas so older peers can ignore it.
  final OpenCodeAccountSnapshot? openCodeAccounts;
  final List<PortalProviderUsageEntry> providers;
  final String updatedAt;

  factory PortalProviderUsageProjection.fromJson(Map<String, dynamic> json) => PortalProviderUsageProjection(
        antigravityAccount: json['antigravityAccount'] == null ? null : AntigravityAccountSnapshot.fromJson(json['antigravityAccount'] as Map<String, dynamic>),
        openCodeAccounts: json['openCodeAccounts'] == null ? null : OpenCodeAccountSnapshot.fromJson(json['openCodeAccounts'] as Map<String, dynamic>),
        providers: _parseList(json['providers'], (e) => PortalProviderUsageEntry.fromJson(e as Map<String, dynamic>)),
        updatedAt: json['updatedAt'] as String,
      );
}

/// Billing-period spend and cap in major currency units, not wallet credits.
class PortalProviderUsageSpend {
  const PortalProviderUsageSpend({this.currency, this.isEnabled, this.limit, this.used});

  final String? currency;
  final bool? isEnabled;
  /// Omitted when no reliable cap is reported; null only for a known uncapped cap.
  final num? limit;
  final num? used;

  factory PortalProviderUsageSpend.fromJson(Map<String, dynamic> json) => PortalProviderUsageSpend(
        currency: json['currency'] as String?,
        isEnabled: json['isEnabled'] as bool?,
        limit: json['limit'] as num?,
        used: json['used'] as num?,
      );
}

/// One plan limit window, normalized on the desktop. `id` stays stable across refreshes and reordering; `label` is display copy such as `5-hour window`, `7-day Opus` or `Extra usage`.
class PortalProviderUsageWindow {
  const PortalProviderUsageWindow({this.credits, required this.id, required this.label, this.resetsAt, this.spend, this.unlimited, this.usedPercent, this.windowDurationMs});

  final PortalProviderUsageCredits? credits;
  final String id;
  final String label;
  /// ISO timestamp of the next reset.
  final String? resetsAt;
  /// Optional for compatibility with older paired clients.
  final PortalProviderUsageSpend? spend;
  /// Explicitly unlimited; absent usage alone does not imply this.
  final bool? unlimited;
  final num? usedPercent;
  final num? windowDurationMs;

  factory PortalProviderUsageWindow.fromJson(Map<String, dynamic> json) => PortalProviderUsageWindow(
        credits: json['credits'] == null ? null : PortalProviderUsageCredits.fromJson(json['credits'] as Map<String, dynamic>),
        id: json['id'] as String,
        label: json['label'] as String,
        resetsAt: json['resetsAt'] as String?,
        spend: json['spend'] == null ? null : PortalProviderUsageSpend.fromJson(json['spend'] as Map<String, dynamic>),
        unlimited: json['unlimited'] as bool?,
        usedPercent: json['usedPercent'] as num?,
        windowDurationMs: json['windowDurationMs'] as num?,
      );
}

class PortalProviderUsageRefreshPayload {
  const PortalProviderUsageRefreshPayload({required this.provider});

  final PortalProviderUsageRefreshProvider provider;

  factory PortalProviderUsageRefreshPayload.fromJson(Map<String, dynamic> json) => PortalProviderUsageRefreshPayload(
        provider: PortalProviderUsageRefreshProvider.fromWire(json['provider'] as String),
      );
}
