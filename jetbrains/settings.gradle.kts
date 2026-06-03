// Standalone Gradle build for the PyCharm/JetBrains plugin. It lives in a
// subdirectory of the (npm-based) repo and consumes the built webview bundle
// from ../out/webview.js — it is NOT a Gradle subproject of the repo root.
rootProject.name = "colmapview-pycharm"

pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}

// Lets Gradle auto-provision the JDK 21 toolchain (see jvmToolchain(21)) if it
// isn't already installed locally.
plugins {
    id("org.gradle.toolchains.foojay-resolver-convention") version "0.8.0"
}
