package com.unstoppabledomains.canopy

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsClient
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.File

private const val BROWSER_CAPABILITIES_CHANNEL =
    "com.unstoppabledomains.canopy/browser_capabilities"
private const val INSTALL_BEACON_CHANNEL =
    "com.unstoppabledomains.canopy/install_beacon"
private const val INSTALL_BEACON_MARKER = "install_beacon_reported_v1"
private const val NO_BACKUP_DIRECTORY_CHANNEL =
    "com.unstoppabledomains.canopy/no_backup_directory"

class MainActivity : FlutterActivity() {
    private var imeInsetsRecovery: ImeInsetsRecovery? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            imeInsetsRecovery = ImeInsetsRecovery(findViewById(android.R.id.content))
        }
        // Android 12+ fades its splash out over the app by default. Flutter's
        // first frame is the launch view, which draws the same mark on the
        // same background, so the fade only makes the mark dim and reappear.
        // Taking over the exit and removing the splash at once makes the
        // handoff invisible.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            splashScreen.setOnExitAnimationListener { splashView ->
                splashView.remove()
            }
        }
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            imeInsetsRecovery?.dispose()
        }
        super.onDestroy()
    }
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        // Before Dart can open the Computer Connect core, so its TLS uses the
        // Android trust store like dart:io.
        ComputerConnectTls.init(applicationContext)

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            BROWSER_CAPABILITIES_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "supportsHttpsAuthTabRedirect" ->
                    result.success(supportsHttpsAuthTabRedirect())
                else -> result.notImplemented()
            }
        }

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            INSTALL_BEACON_CHANNEL,
        ).setMethodCallHandler { call, result ->
            try {
                val marker = File(noBackupFilesDir, INSTALL_BEACON_MARKER)
                when (call.method) {
                    "hasReported" -> result.success(marker.exists())
                    "markReported" -> {
                        marker.writeText("reported")
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (error: Exception) {
                result.error(
                    "INSTALL_BEACON_STORAGE_ERROR",
                    error.message,
                    null,
                )
            }
        }

        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            NO_BACKUP_DIRECTORY_CHANNEL,
        ).setMethodCallHandler { call, result ->
            when (call.method) {
                "path" -> result.success(noBackupFilesDir.absolutePath)
                else -> result.notImplemented()
            }
        }
    }

    /**
     * Whether the Custom Tabs provider that will host the OAuth flow implements
     * Chrome's Auth Tab contract, and can therefore return the claimed HTTPS
     * App Link to the app.
     *
     * Asks the resolved provider through androidx rather than comparing browser
     * version numbers: the version thresholds differ per browser and go stale
     * as each one ships support. A browser without Auth Tab keeps the final
     * redirect and renders it, which is what dead-ends sign-in on the server's
     * fallback page — the Dart side falls back to the custom scheme instead.
     */
    @SuppressLint("UnsafeOptInUsageError", "UnsafeOptInUsageWarning")
    private fun supportsHttpsAuthTabRedirect(): Boolean {
        val provider = CustomTabsClient.getPackageName(this, null) ?: return false
        return CustomTabsClient.isAuthTabSupported(this, provider)
    }
}
