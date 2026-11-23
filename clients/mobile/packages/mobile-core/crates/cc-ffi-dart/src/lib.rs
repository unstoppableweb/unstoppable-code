//! The Dart binding of the Computer Connect core. The only crate that
//! names a binding generator or exports C symbols.
#![allow(unsafe_code)]

pub mod api;
#[allow(unreachable_pub)]
mod frb_generated;

#[cfg(feature = "legacy-json")]
pub mod legacy_json;

/// Called once by the Android host (Kotlin `ComputerConnectTls.init(context)`,
/// JNI `nativeInit`) before the first core call. Safe to call again.
#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
pub extern "system" fn Java_com_unstoppabledomains_canopy_ComputerConnectTls_nativeInit<'caller>(
    mut env: jni::EnvUnowned<'caller>,
    _class: jni::objects::JClass<'caller>,
    context: jni::objects::JObject<'caller>,
) -> jni::sys::jboolean {
    let ok = env
        .with_env(|env| Ok::<_, jni::errors::Error>(cc_core::platform::android_init(env, context)))
        .into_outcome();
    matches!(ok, jni::Outcome::Ok(true))
}
