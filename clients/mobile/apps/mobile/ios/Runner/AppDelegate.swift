import FirebaseCore
import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    if FirebaseApp.app() == nil, FirebaseOptions.defaultOptions() != nil {
      FirebaseApp.configure()
    }
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "FoldRegionsPlugin") {
      FoldRegionsPlugin.register(with: registrar)
    }
    if let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "NoBackupDirectory") {
      FlutterMethodChannel(
        name: "com.unstoppabledomains.canopy/no_backup_directory",
        binaryMessenger: registrar.messenger()
      ).setMethodCallHandler { call, result in
        guard call.method == "path" else {
          result(FlutterMethodNotImplemented)
          return
        }
        do {
          result(try AppDelegate.noBackupDirectory().path)
        } catch {
          result(
            FlutterError(
              code: "NO_BACKUP_DIRECTORY_ERROR",
              message: error.localizedDescription,
              details: nil))
        }
      }
    }
  }

  /// An Application Support folder excluded from iCloud and Finder backups.
  private static func noBackupDirectory() throws -> URL {
    var url = try FileManager.default.url(
      for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
    ).appendingPathComponent("no-backup", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try url.setResourceValues(values)
    return url
  }
}
