package com.unstoppabledomains.canopy

import android.content.Context
import android.util.Log

/**
 * Registers the app context with the Computer Connect core's TLS verifier
 * (rustls-platform-verifier), so HTTPS and relay connections trust the
 * Android store, including user and managed CAs. Until this runs, the core
 * falls back to its bundled roots; a failure here never blocks app start.
 */
object ComputerConnectTls {
    @JvmStatic private external fun nativeInit(context: Context): Boolean

    fun init(context: Context) {
        try {
            // The core's Dart binding crate, cc-ffi-dart, builds libcc_ffi_dart.so.
            System.loadLibrary("cc_ffi_dart")
            if (!nativeInit(context)) Log.e("ComputerConnectTls", "Platform verifier unavailable")
        } catch (error: UnsatisfiedLinkError) {
            Log.e("ComputerConnectTls", "Computer Connect core not loaded", error)
        }
    }
}
