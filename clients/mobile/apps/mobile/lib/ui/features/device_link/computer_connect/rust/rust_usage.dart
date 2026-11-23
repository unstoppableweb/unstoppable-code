import 'dart:async';

import 'package:computer_connect_core/computer_connect_core.dart' as core;
import 'package:flutter/foundation.dart';
import 'package:mobile/data/protocol/generated/provider_usage.dart';
import 'package:mobile/ui/core/provider_usage_source.dart';

import '../account_model.dart';
import '../usage_model.dart';
import 'same_name.dart';

/// The selected computer's provider usage over the Rust core's
/// [core.ProviderUsageService]. The core follows the account's selection,
/// reads usage, applies pushes, retries failed reads and words every label
/// and failure; this model maps the latest [core.UsageView] to
/// [ProviderUsageSource] and forwards refreshes. The mapping exists because
/// Account's usage screens read the app's `RemoteControlProviderUsage*` types,
/// which Remote Control shares; enums map by name.
///
/// When the core did not open, the source opens it again once [account]
/// is ready, that is once the account's own retry opened it.
final class RustProviderUsageSource extends ChangeNotifier
    implements ComputerUsageModel {
  RustProviderUsageSource({required this.open, required this.account}) {
    account.addListener(_accountChanged);
    unawaited(_open());
  }

  final Future<core.ComputerConnectCore> Function() open;
  final ComputerAccountModel account;

  void _accountChanged() {
    if (account.ready) unawaited(_open());
  }

  Future<void>? _opening;
  Future<void> _open() async {
    if (_disposed || _service != null) return;
    await (_opening ??= _listen());
    _opening = null;
  }

  core.ProviderUsageService? _service;
  StreamSubscription<core.UsageView>? _views;
  core.UsageView? _view;
  RemoteControlProviderUsageProjection? _projection;
  bool _disposed = false;

  Future<void> _listen() async {
    try {
      final service = (await open()).usage;
      if (_disposed) return;
      _service = service;
      _views = service.watch().listen(_apply);
    } catch (error) {
      debugPrint('Computer connection core did not open: $error');
    }
  }

  void _apply(core.UsageView view) {
    if (_disposed) return;
    final current = _view;
    if (current != null && view.revision <= current.revision) return;
    if (current == null || current.projection != view.projection) {
      _projection = view.projection == null
          ? null
          : _projectionOf(view.projection!);
    }
    _view = view;
    notifyListeners();
  }

  /// Changes whenever the core's selected computer does.
  @override
  Object? get scopeKey => _view?.scope;

  @override
  bool get isAvailable => _view?.available ?? false;

  @override
  ProviderUsageDelivery get delivery => switch (_view?.delivery) {
    core.UsageDelivery.live => ProviderUsageDelivery.live,
    core.UsageDelivery.reconnecting => ProviderUsageDelivery.reconnecting,
    _ => ProviderUsageDelivery.unreachable,
  };

  @override
  RemoteControlProviderUsageProjection? get projection => _projection;

  @override
  bool isRefreshing(RemoteControlProviderUsageProvider provider) =>
      _view?.refreshing.contains(_provider(provider)) ?? false;

  @override
  String? refreshFailure(RemoteControlProviderUsageProvider provider) => _view
      ?.failures
      .where((failure) => failure.provider == _provider(provider))
      .firstOrNull
      ?.message;

  @override
  Future<void> refresh(RemoteControlProviderUsageProvider provider) async {
    await _open();
    final service = _service;
    if (_disposed || service == null) return;
    try {
      _apply(await service.refresh(provider: _provider(provider)));
    } on core.CoreFailure catch (error) {
      debugPrint('Computer connection usage refresh failed: ${error.code}');
    }
  }

  @override
  void dispose() {
    _disposed = true;
    account.removeListener(_accountChanged);
    unawaited(_views?.cancel());
    super.dispose();
  }
}

core.UsageProvider _provider(RemoteControlProviderUsageProvider provider) =>
    sameName(core.UsageProvider.values, provider);

RemoteControlProviderUsageProjection _projectionOf(core.UsageProjection p) =>
    RemoteControlProviderUsageProjection(
      updatedAt: p.updatedAt,
      openCodeAccounts: switch (p.openCodeAccounts) {
        final accounts? => _openCodeOf(accounts),
        null => null,
      },
      providers: [for (final entry in p.providers) _entryOf(entry)],
    );

RemoteControlProviderUsageEntry _entryOf(core.ProviderUsage e) =>
    RemoteControlProviderUsageEntry(
      provider: sameName(RemoteControlProviderUsageProvider.values, e.provider),
      authState: sameName(
        RemoteControlProviderUsageAuthState.values,
        e.authState,
      ),
      accountEmail: e.accountEmail,
      accountLabel: e.accountLabel,
      planLabel: e.planLabel,
      lastUpdatedAt: e.lastUpdatedAt,
      error: _errorOf(e.error),
      windows: [for (final window in e.windows) _windowOf(window)],
      accounts: switch (e.accounts) {
        final accounts? => [for (final a in accounts) _accountOf(a)],
        null => null,
      },
    );

RemoteControlProviderUsageError? _errorOf(core.UsageError? error) =>
    switch (error) {
      null => null,
      final error => RemoteControlProviderUsageError(
        kind: sameName(RemoteControlProviderUsageErrorKind.values, error.kind),
        message: error.message,
      ),
    };

RemoteControlProviderUsageWindow _windowOf(core.UsageWindow w) =>
    RemoteControlProviderUsageWindow(
      id: w.id,
      label: w.label,
      unlimited: w.unlimited,
      usedPercent: w.usedPercent,
      resetsAt: w.resetsAt,
      windowDurationMs: w.windowDurationMs,
      credits: switch (w.credits) {
        final c? => RemoteControlProviderUsageCredits(
          unit: sameName(RemoteControlProviderUsageCreditUnit.values, c.unit),
          spent: c.spent,
          remaining: c.remaining,
          total: c.total,
        ),
        null => null,
      },
      spend: switch (w.spend) {
        final s? => RemoteControlProviderUsageSpend(
          currency: s.currency,
          isEnabled: s.isEnabled,
          limit: s.limit,
          used: s.used,
        ),
        null => null,
      },
    );

RemoteControlProviderUsageAccount _accountOf(core.UsageAccount a) =>
    RemoteControlProviderUsageAccount(
      id: a.id,
      label: a.label,
      planLabel: a.planLabel,
      status: sameName(
        RemoteControlProviderUsageAccountStatus.values,
        a.status,
      ),
      availableAt: a.availableAt,
      usageSource: switch (a.usageSource) {
        final source? => sameName(
          RemoteControlProviderUsageAccountSource.values,
          source,
        ),
        null => null,
      },
      lastUpdatedAt: a.lastUpdatedAt,
      retryAt: a.retryAt,
      error: _errorOf(a.error),
      windows: [for (final window in a.windows) _windowOf(window)],
    );

OpenCodeAccountSnapshot _openCodeOf(core.OpenCodeAccounts o) =>
    OpenCodeAccountSnapshot(
      status: o.status,
      updatedAt: o.updatedAt,
      providers: [
        for (final p in o.providers)
          OpenCodeAccountProvider(
            id: p.id,
            name: p.name,
            accounts: [
              for (final a in p.accounts)
                OpenCodeAccount(
                  label: a.label,
                  // Named differently (`oAuth`, `external_`).
                  method: switch (a.method) {
                    core.OpenCodeMethod.key => OpenCodeAccountMethod.key,
                    core.OpenCodeMethod.oAuth => OpenCodeAccountMethod.oauth,
                    core.OpenCodeMethod.external_ =>
                      OpenCodeAccountMethod.external,
                    core.OpenCodeMethod.env => OpenCodeAccountMethod.env,
                  },
                  needsSignIn: a.needsSignIn,
                  selected: a.selected,
                  usage: switch (a.usage) {
                    final u? => OpenCodeAccountUsage(
                      checkedAt: u.checkedAt,
                      plan: u.plan,
                      status: u.status,
                      windows: switch (u.windows) {
                        final windows? => [
                          for (final w in windows)
                            OpenCodeUsageWindow(
                              id: w.id,
                              percent: w.percent,
                              resetsAt: w.resetsAt,
                            ),
                        ],
                        null => null,
                      },
                    ),
                    null => null,
                  },
                ),
            ],
          ),
      ],
    );
