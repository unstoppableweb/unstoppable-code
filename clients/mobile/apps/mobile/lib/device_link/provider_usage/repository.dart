import 'package:mobile/data/protocol/generated/provider_usage.dart';
import '../desktop/ipc.dart';
import 'projection.dart';

/// Borrows one Computer Connect session. Existing desktop handlers remain the
/// authority; no Portal pairing, hosted snapshot, or local persistence is used.
final class DeviceProviderUsageRepository {
  DeviceProviderUsageRepository(this.ipc);
  final DesktopIpc ipc;
  Map<String, dynamic>? _overview;
  Map<String, dynamic> _proxy = const {}, _preferences = const {};
  bool _ready = false;
  int _loadRevision = 0, _usageRevision = 0, _proxyRevision = 0;

  RemoteControlProviderUsageProjection? get projection =>
      !_ready || _overview == null
      ? null
      : projectDesktopUsage(_overview!, _proxy, _preferences);

  /// A payloadless preference event may have changed the native/proxy route.
  /// Keep observations, but do not publish or refresh against the old route.
  void invalidateRoute() => _ready = false;

  Future<RemoteControlProviderUsageProjection> load() async {
    final loadRevision = ++_loadRevision;
    final usageRevision = _usageRevision, proxyRevision = _proxyRevision;
    // Serialize these reads to leave room for chat hydration on the same link.
    final proxy = usageObject(await ipc.invoke('account-proxy:status'));
    final preferences = usageObject(await ipc.invoke('preferences:load'));
    final snapshot = usageObject(
      await ipc.invoke('observability:load-snapshot'),
    );
    final overview = usageRevision == _usageRevision
        ? usageObject(snapshot['usage'])
        : _overview!;
    final currentProxy = proxyRevision == _proxyRevision ? proxy : _proxy;
    final result = projectDesktopUsage(overview, currentProxy, preferences);
    if (loadRevision != _loadRevision) return result;
    _overview = overview;
    _proxy = currentProxy;
    _preferences = preferences;
    _ready = true;
    return result;
  }

  /// Pushes carry the same cached observations as a read. No polling or audit
  /// snapshot reload is needed for background usage updates.
  bool applyPush(Map<String, dynamic> push) {
    final args = push['args'];
    if (args is! List || args.isEmpty) return false;
    final value = usageObject(args.first);
    switch (push['channel']) {
      case 'observability:event':
        if (value['type'] != 'usage' || value['usage'] is! Map) return false;
        _overview = usageObject(value['usage']);
        _usageRevision++;
      case 'account-proxy:changed':
        _proxy = value;
        _proxyRevision++;
      default:
        return false;
    }
    return true;
  }

  Future<void> refresh(RemoteControlProviderUsageProvider provider) async {
    if (!_ready) throw StateError('Usage has not loaded for this session.');
    // Desktop provider reads can take 45 seconds, with proxy reads queued
    // behind other accounts. Allow a bounded read beyond the link's 15s default.
    const timeout = Duration(minutes: 2);
    if (servesUsageProxy(provider, _proxy, _preferences)) {
      await ipc.invoke('account-proxy:status', [
        {'refreshUsage': true},
      ], timeout);
    } else {
      await ipc.invoke('observability:refresh-usage', [provider.wire], timeout);
    }
  }
}
