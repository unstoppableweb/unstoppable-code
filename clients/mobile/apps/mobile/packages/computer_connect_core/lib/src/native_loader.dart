import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

import 'bindings.dart' as native;

/// The file the Dart native-assets loader resolved for this package's code
/// asset. Taking the address of an `@Native` symbol makes the VM load the
/// asset (APK `lib/<abi>`, iOS framework or host build directory); `dladdr`
/// then names the file that holds it, and `dlopen` of that path returns the
/// already loaded library, so it is never loaded twice.
String nativeAssetLibraryPath() {
  final anchor = Native.addressOf<NativeFunction<Int32 Function()>>(
    native.rustContentHash,
  );
  final dl = Platform.isAndroid
      ? DynamicLibrary.open('libdl.so')
      : DynamicLibrary.process();
  final dladdr = dl
      .lookupFunction<
        Int32 Function(Pointer<Void>, Pointer<_DlInfo>),
        int Function(Pointer<Void>, Pointer<_DlInfo>)
      >('dladdr');
  final info = calloc<_DlInfo>();
  try {
    if (dladdr(anchor.cast(), info) == 0 || info.ref.fileName == nullptr) {
      throw StateError('Native asset not found');
    }
    return info.ref.fileName.toDartString();
  } finally {
    calloc.free(info);
  }
}

/// `Dl_info` from `<dlfcn.h>` (same layout on Android, iOS and macOS).
final class _DlInfo extends Struct {
  external Pointer<Utf8> fileName;
  external Pointer<Void> fileBase;
  external Pointer<Utf8> symbolName;
  external Pointer<Void> symbolAddress;
}
