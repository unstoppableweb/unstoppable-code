import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'dart:convert';
import 'package:mobile/device_link/store.dart';

/// A distinct Keychain/Keystore record. It never imports the account session
/// store or reads its keys. Storage failures preserve the existing record.
final class DeviceLinkSecureStore implements DeviceLinkStore {
  DeviceLinkSecureStore.desktop({FlutterSecureStorage? storage})
    : this._(storage, 'device_link_desktop.v1');
  DeviceLinkSecureStore.connection({
    required String accountId,
    required String origin,
    FlutterSecureStorage? storage,
  }) : this._(
         storage,
         'computer_connect.v1.${base64Url.encode(utf8.encode(jsonEncode([origin, accountId])))}',
       );

  /// The key that wraps the Rust core's databases.
  DeviceLinkSecureStore.rustWrappingKey({FlutterSecureStorage? storage})
    : this._(storage, 'computer-connect-rust.wrapping-key.v1');
  DeviceLinkSecureStore._(FlutterSecureStorage? storage, this._key)
    : _storage =
          storage ??
          const FlutterSecureStorage(
            aOptions: AndroidOptions(resetOnError: false),
            iOptions: IOSOptions(
              accessibility: KeychainAccessibility.first_unlock_this_device,
            ),
          );
  final FlutterSecureStorage _storage;
  final String _key;
  @override
  Future<String?> read() => _storage.read(key: _key);
  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
}
