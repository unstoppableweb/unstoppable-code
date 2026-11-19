import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/device_link/dto.dart';

/// Display mapping of the existing desktop usage IPC. Keep window semantics
/// aligned with desktop-shared/lib/account-proxy-usage-projection.ts.
Map<String, dynamic> usageObject(Object? value) {
  final dto = deviceChatDto(value);
  return dto is Map<String, dynamic> ? dto : const {};
}

List<Map<String, dynamic>> _rows(Object? value) =>
    value is List ? value.map(usageObject).toList() : const [];

String? _iso(Object? value) {
  final date = value is num && value.isFinite
      ? DateTime.fromMillisecondsSinceEpoch(value.toInt(), isUtc: true)
      : value is String
      ? DateTime.tryParse(value)
      : null;
  return date?.toUtc().toIso8601String();
}

num? _number(Object? value) => value is num && value.isFinite ? value : null;

RemoteControlProviderUsageProjection projectDesktopUsage(
  Map<String, dynamic> overview,
  Map<String, dynamic> proxy,
  Map<String, dynamic> preferences,
) => RemoteControlProviderUsageProjection(
  updatedAt: overview['updatedAt'] as String,
  openCodeAccounts: overview['openCodeAccounts'] is Map
      ? OpenCodeAccountSnapshot.fromJson(
          usageObject(overview['openCodeAccounts']),
        )
      : null,
  providers: [
    for (final provider in RemoteControlProviderUsageProvider.values)
      if (provider != RemoteControlProviderUsageProvider.copilot ||
          _rows(
            overview['providers'],
          ).any((row) => row['provider'] == provider.wire))
        _entry(
          provider,
          _rows(
                overview['providers'],
              ).where((row) => row['provider'] == provider.wire).firstOrNull ??
              const {},
          servesUsageProxy(provider, proxy, preferences)
              ? _rows(proxy['accounts'])
                    .where((row) => row['provider'] == provider.wire)
                    .map((row) => _account(provider, row))
                    .toList()
              : null,
        ),
  ],
);

/// The desktop's device-wide account-source rule, including local runtime
/// readiness and the global AI Credits override. No organization is inferred.
bool servesUsageProxy(
  RemoteControlProviderUsageProvider provider,
  Map<String, dynamic> proxy,
  Map<String, dynamic> preferences,
) {
  if (provider == RemoteControlProviderUsageProvider.copilot ||
      preferences['aiCreditsRoutingMode'] == 'on' ||
      proxy['available'] != true ||
      proxy['state'] != 'connected' ||
      proxy['error'] != null ||
      proxy[provider == RemoteControlProviderUsageProvider.claude
              ? 'routeClaude'
              : 'routeCodex'] !=
          true) {
    return false;
  }
  final connection = usageObject(proxy['connection']);
  if (connection.isEmpty) return false;
  if (connection['kind'] != 'local') return true;
  final local = usageObject(proxy['local']);
  final uri = Uri.tryParse(connection['url'] as String? ?? '');
  return local['phase'] == 'running' &&
      local['port'] != null &&
      uri?.port == local['port'];
}

RemoteControlProviderUsageEntry _entry(
  RemoteControlProviderUsageProvider provider,
  Map<String, dynamic> row,
  List<RemoteControlProviderUsageAccount>? accounts,
) {
  final unauthenticated = row['authState'] == 'unauthenticated';
  final windows = unauthenticated
      ? <RemoteControlProviderUsageWindow>[]
      : _windows(provider, row['rateLimits']);
  final info = usageObject(row['errorInfo']);
  final kind =
      info['kind'] as String? ??
      (row['error'] != null || row['authState'] == 'error' ? 'unknown' : null);
  final retainedThrottle = kind == 'rate_limited' && windows.isNotEmpty;
  return RemoteControlProviderUsageEntry(
    provider: provider,
    authState: unauthenticated
        ? RemoteControlProviderUsageAuthState.unauthenticated
        : retainedThrottle ||
              kind == null && row['authState'] == 'authenticated'
        ? RemoteControlProviderUsageAuthState.authenticated
        : kind != null
        ? RemoteControlProviderUsageAuthState.error
        : RemoteControlProviderUsageAuthState.unknown,
    accountEmail: unauthenticated ? null : row['accountEmail'] as String?,
    accountLabel: unauthenticated ? null : row['accountLabel'] as String?,
    planLabel: unauthenticated ? null : row['subscriptionLabel'] as String?,
    lastUpdatedAt: _iso(row['lastUpdatedAt']),
    error: unauthenticated || retainedThrottle || kind == null
        ? null
        : _error(provider, kind),
    windows: kind != null && !retainedThrottle ? const [] : windows,
    accounts: accounts,
  );
}

RemoteControlProviderUsageError _error(
  RemoteControlProviderUsageProvider provider,
  String kind,
) {
  final label = switch (provider) {
    RemoteControlProviderUsageProvider.claude => 'Claude',
    RemoteControlProviderUsageProvider.codex => 'Codex',
    RemoteControlProviderUsageProvider.copilot => 'Copilot',
  };
  // Curated desktop headlines only; raw provider errors can contain secrets.
  final message = switch (kind) {
    'auth' => 'Sign in to $label again to see live usage.',
    'network' => 'Check your connection, then try reaching $label again.',
    'service' => '$label is not answering right now, so try again in a moment.',
    'rate_limited' =>
      '$label is limiting usage checks right now. Try again later.',
    'unsupported' => "This $label account doesn't expose usage details.",
    _ => 'Try again to load $label usage.',
  };
  return RemoteControlProviderUsageError(
    kind:
        RemoteControlProviderUsageErrorKind.values
            .where(
              (value) =>
                  value.wire == (kind == 'rate_limited' ? 'service' : kind),
            )
            .firstOrNull ??
        RemoteControlProviderUsageErrorKind.unknown,
    message: message,
  );
}

List<RemoteControlProviderUsageWindow> _windows(
  RemoteControlProviderUsageProvider provider,
  Object? raw,
) {
  final rows = _rows(raw);
  final counts = <String, int>{};
  final credited = <String>{};
  return [
    // Preserve provider order within each group, as desktop's stable sort does.
    for (final priority in [0, 1])
      for (final row in rows.where((row) => _sortKey(row) == priority))
        ..._limitWindows(provider, row, counts, credited),
  ];
}

int _sortKey(Map<String, dynamic> row) =>
    '${row['limitName'] ?? row['limitId'] ?? ''}'.toLowerCase() == 'codex'
    ? 0
    : 1;

List<RemoteControlProviderUsageWindow> _limitWindows(
  RemoteControlProviderUsageProvider provider,
  Map<String, dynamic> row,
  Map<String, int> counts,
  Set<String> credited,
) {
  final codex = provider == RemoteControlProviderUsageProvider.codex;
  final key = '${row['limitId'] ?? row['limitName'] ?? 'default'}';
  final credits = usageObject(row['credits']);
  final hasCredits = [
    'usedUsd',
    'remainingUsd',
    'totalUsd',
  ].any((key) => _number(credits[key]) != null);
  final slots = codex
      ? [
          if (row['primary'] is Map) 'primary',
          if (row['secondary'] is Map) 'secondary',
          if (row['primary'] is! Map &&
              row['secondary'] is! Map &&
              (_number(credits['usedUsd']) != null ||
                  _number(credits['remainingUsd']) != null))
            'balance',
        ]
      : ['primary'];
  return [
    for (final slot in slots)
      (() {
        final window = usageObject(row[slot]);
        final mins = _number(window['windowDurationMins']);
        final duration = mins != null && mins > 0
            ? mins * 60000
            : switch (row['limitId']) {
                'five_hour' || 'session' => 18000000,
                final String id
                    when id.startsWith('seven_day') ||
                        id.startsWith('weekly') =>
                  604800000,
                _ => null,
              };
        final base = '${row['limitName'] ?? row['limitId'] ?? ''}';
        final suffix = base.isEmpty || base.toLowerCase() == 'codex'
            ? 'window'
            : base;
        final label = codex
            ? slot == 'balance'
                  ? row['limitName'] as String? ?? 'Credits'
                  : '${_durationLabel(mins) ?? (slot == 'primary' ? 'Primary' : 'Secondary')} $suffix'
            : '${row['limitName'] ?? row['limitId'] ?? 'Current window'}';
        final id = '$key-$slot';
        final count = counts.update(id, (n) => n + 1, ifAbsent: () => 1);
        final includeCredits = hasCredits && credited.add(key);
        return RemoteControlProviderUsageWindow(
          id: count == 1 ? id : '$id-$count',
          label: window['unlimited'] == true
              ? label.replaceFirst(RegExp(r' · Unlimited$'), '')
              : label,
          unlimited: window['unlimited'] == true ? true : null,
          usedPercent: _number(window['usedPercent']),
          resetsAt: _iso(window['resetsAt']),
          windowDurationMs: duration,
          credits: includeCredits
              ? RemoteControlProviderUsageCredits(
                  unit: codex
                      ? RemoteControlProviderUsageCreditUnit.credits
                      : RemoteControlProviderUsageCreditUnit.usd,
                  spent: _number(credits['usedUsd']),
                  remaining: _number(credits['remainingUsd']),
                  total: _number(credits['totalUsd']),
                )
              : null,
          spend: row['spend'] is Map
              ? RemoteControlProviderUsageSpend.fromJson(
                  usageObject(row['spend']),
                )
              : null,
        );
      })(),
  ];
}

String? _durationLabel(num? mins) {
  if (mins == null || mins <= 0) return null;
  if (mins % 1440 == 0) return '${mins ~/ 1440}-day';
  if (mins % 60 == 0) return '${mins ~/ 60}-hour';
  return '${mins % 1 == 0 ? mins.toInt() : mins}-minute';
}

RemoteControlProviderUsageAccount _account(
  RemoteControlProviderUsageProvider provider,
  Map<String, dynamic> row,
) {
  final usage = usageObject(row['usage']);
  final info = usageObject(usage['errorInfo']);
  final limits = _rows(row['limits']);
  return RemoteControlProviderUsageAccount(
    id: row['authIndex'] as String,
    label: row['label'] as String?,
    planLabel: row['source'] == 'api-key'
        ? 'API key'
        : _planLabel(provider, row['planType'] as String?),
    status: RemoteControlProviderUsageAccountStatus.fromWire(
      row['status'] as String,
    ),
    availableAt: _iso(row['availableAt']),
    usageSource: row['usage'] is Map
        ? RemoteControlProviderUsageAccountSource.fromWire(
            usage['source'] as String,
          )
        : limits.isEmpty
        ? null
        : RemoteControlProviderUsageAccountSource.passive,
    lastUpdatedAt: _iso(usage['lastUpdatedAt']),
    retryAt: _iso(usage['retryAt']),
    error: info['kind'] is String
        ? _error(provider, info['kind'] as String)
        : null,
    windows: row['usage'] is Map
        ? _windows(provider, usage['rateLimits'])
        : [
            for (final limit in limits)
              RemoteControlProviderUsageWindow(
                id: limit['id'] as String,
                label: limit['id'] == 'five-hour'
                    ? '5-hour limit'
                    : 'Weekly limit',
                usedPercent: _number(limit['usedPercent']),
                resetsAt: _iso(limit['resetsAt']),
                windowDurationMs: limit['id'] == 'five-hour'
                    ? 18000000
                    : 604800000,
              ),
          ],
  );
}

String? _planLabel(RemoteControlProviderUsageProvider provider, String? raw) {
  var slug = (raw ?? '').trim().toLowerCase().replaceAll(
    RegExp(r'[\s_]+'),
    '-',
  );
  if (slug.isEmpty || slug == 'unknown') return null;
  if (provider == RemoteControlProviderUsageProvider.claude &&
      slug.contains('max')) {
    if (RegExp(r'(?:^|\D)20x?(?:\D|$)').hasMatch(slug) ||
        slug == 'max20x' ||
        slug == 'max-20') {
      slug = 'max-20x';
    } else if (RegExp(r'(?:^|\D)5x?(?:\D|$)').hasMatch(slug) ||
        slug == 'max' ||
        slug == 'max5x' ||
        slug == 'max-5') {
      slug = 'max-5x';
    }
  }
  if (provider == RemoteControlProviderUsageProvider.codex && slug == 'team') {
    slug = 'business';
  }
  final title = slug
      .split('-')
      .map(
        (part) =>
            part.isEmpty ? '' : '${part[0].toUpperCase()}${part.substring(1)}',
      )
      .join(' ');
  return '${provider == RemoteControlProviderUsageProvider.codex ? 'ChatGPT' : 'Claude'} ${switch (slug) {
    'max-5x' => 'Max 5x',
    'max-20x' => 'Max 20x',
    'team-premium' => 'Team Premium',
    _ => title,
  }}';
}
