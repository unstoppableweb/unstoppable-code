import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:computer_connect_core/computer_connect_core.dart';
import 'package:mobile/device_link/desktop/ipc.dart';
import 'package:mobile/device_link/rust_core/account_link.dart';
import 'package:mobile/device_link/rust_core/value_codec.dart';
import 'package:mobile/ui/features/device_link/computer_connect/rust/rust_account.dart';

import 'fake_desktop_computer.dart';

const _account = 'test-account';
const _session = 'test-session';

/// A [FakeDesktopComputer] as the Rust core's scripted computer
/// (`ComputerConnectCore.openWithTestDesktop`), connected and selected
/// through the production [RustComputerAccount]: the core's relay lists
/// the computer, its session carries every request envelope to the fake,
/// and the fake's answers and pushes go back in the order it made them.
/// Everything above the session's envelopes is real: the core, its chat
/// services, and the Rust-backed view models the app composes.
final class RustTestComputer {
  RustTestComputer._(this.computer, this._directory);

  final FakeDesktopComputer computer;
  final Directory _directory;
  late final ComputerConnectCore core;
  late final RustComputerAccount account;

  /// What setup acquired, released in reverse by [dispose].
  final _releases = <Future<void> Function()>[];

  /// Requests the fake has not answered yet.
  int get inFlight => _inFlight;
  int _inFlight = 0;

  /// Opens a core over [computer] and connects it. A setup that fails
  /// releases what it acquired before it rethrows.
  static Future<RustTestComputer> connect(FakeDesktopComputer computer) async {
    final directory = await Directory.systemTemp.createTemp('rust-computer-');
    final test = RustTestComputer._(computer, directory);
    test._releases.add(() => directory.delete(recursive: true));
    try {
      await test._connect();
    } catch (_) {
      await test.dispose();
      rethrow;
    }
    return test;
  }

  Future<void> _connect() async {
    core = await ComputerConnectCore.openWithTestDesktop(
      // Loopback, so a stray hosted request fails at once.
      origin: 'http://127.0.0.1:1',
      databasePath: '${_directory.path}/core.sqlite',
      wrappingKey: base64Url.encode(List.filled(32, 3)).replaceAll('=', ''),
      deviceName: 'Test phone',
      platform: 'darwin',
      requests: _request,
    );
    _releases.add(core.close);
    final pushes = computer.events.listen(_deliver);
    _releases.add(pushes.cancel);
    final opened = core;
    account = RustComputerAccount(
      open: () async => opened.account,
      link: RustDesktopAccountLink(
        () async => opened,
        sessionToken: () => _session,
        twoFactorProof: () => null,
        accountId: () => _account,
      ),
      accountId: _account,
    );
    _releases.add(() async => account.dispose());
    await account.restore();
    await account.findComputers();
    final discoveryDeadline = DateTime.now().add(const Duration(seconds: 5));
    while (account.busy ||
        !account.setupRows.any(
          (row) => row.computerId == core.testDesktop.computerId() && !row.busy,
        )) {
      if (DateTime.now().isAfter(discoveryDeadline)) {
        throw StateError('The test computer was not discovered.');
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    await account.connect(core.testDesktop.computerId());
    final deadline = DateTime.now().add(const Duration(seconds: 5));
    while (account.sessions.selected?.chats.online != true) {
      if (DateTime.now().isAfter(deadline)) {
        throw StateError('The test computer did not connect.');
      }
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  void _request(String json) {
    final request = jsonDecode(json) as Map<String, dynamic>;
    final id = request['id'];
    final params = decodeRustValue(request['params']);
    _inFlight++;
    _answer(request['method'], params).then(
      (value) => _respond({'id': id, 'ok': true, 'value': value}),
      onError: (Object error) => _respond({
        'id': id,
        'ok': false,
        'error': {
          'message': '$error',
          'code': error is DesktopIpcRefusal ? error.code : 'unanswered',
        },
      }),
    );
  }

  Future<Object?> _answer(Object? method, Object? params) async =>
      switch ((method, params)) {
        ('session.hello', _) => {
          'version': {'protocolVersion': 7, 'appVersion': 'test'},
          'name': 'Test computer',
        },
        (
          'ipc.invoke',
          {'channel': final String channel, 'args': final List<Object?> args},
        ) =>
          await computer.invoke(channel, args),
        _ => throw DesktopIpcRefusal('Unknown method $method'),
      };

  void _respond(Map<String, dynamic> response) {
    _inFlight--;
    _deliver({'kind': 'response', ...response});
  }

  void _deliver(Map<String, dynamic> message) {
    try {
      core.testDesktop.deliver(
        messageJson: jsonEncode(encodeRustValue(message)),
      );
    } on CoreFailure catch (failure) {
      // The session ended (teardown): the desktop's message is lost.
      if (failure.code != 'not_connected') rethrow;
    }
  }

  Future<void> dispose() async {
    while (_releases.isNotEmpty) {
      await _releases.removeLast()();
    }
  }
}
