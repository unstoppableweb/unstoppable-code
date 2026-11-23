allprojects {
    repositories {
        google()
        mavenCentral()
        // Kotlin component of the Computer Connect core's OS trust-store TLS
        // verifier (rustls-platform-verifier); group org.rustls.
        maven {
            url = uri("https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/")
            content { includeGroup("org.rustls") }
        }
    }
}

val newBuildDir: Directory =
    rootProject.layout.buildDirectory
        .dir("../../build")
        .get()
rootProject.layout.buildDirectory.value(newBuildDir)

subprojects {
    val newSubprojectBuildDir: Directory = newBuildDir.dir(project.name)
    project.layout.buildDirectory.value(newSubprojectBuildDir)

    // The app temporarily opts out of AGP 9's built-in Kotlin support while
    // older Flutter plugins still apply kotlin-android. file_picker 11 detects
    // AGP 9 and expects built-in Kotlin, so migrate that module independently.
    if (name == "file_picker") {
        pluginManager.withPlugin("com.android.library") {
            pluginManager.apply("com.android.built-in-kotlin")
        }
    }
}
subprojects {
    project.evaluationDependsOn(":app")
}

tasks.register<Delete>("clean") {
    delete(rootProject.layout.buildDirectory)
}
