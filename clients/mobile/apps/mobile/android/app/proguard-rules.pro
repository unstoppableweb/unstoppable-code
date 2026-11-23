# The Computer Connect core calls these through JNI, which R8 cannot see.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
-keep class com.unstoppabledomains.canopy.ComputerConnectTls { *; }
