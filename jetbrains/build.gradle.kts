// 3DViewer — PyCharm/JetBrains plugin. Hosts the SAME Three.js webview bundle
// (../core/out/webview.js) inside a JCEF browser. All plugin metadata lives in
// META-INF/plugin.xml; this build only wires the IntelliJ Platform, Kotlin, and
// a task that copies the prebuilt webview bundle into plugin resources.
//
// Versions below are known-good shapes for the IntelliJ Platform Gradle Plugin
// 2.x against PyCharm Community 2024.3; bump as needed for your toolchain.
plugins {
    kotlin("jvm") version "2.0.21"
    id("org.jetbrains.intellij.platform") version "2.5.0"
}

group = "dev.colmapview"
version = "0.0.1"

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // Build + run against PyCharm Community. JCEF is part of the platform, so
        // no extra plugin dependency is needed for the embedded browser.
        pycharmCommunity("2024.3")
        pluginVerifier()
        zipSigner()
    }
}

kotlin {
    jvmToolchain(21) // PyCharm 2024.3 runs on JBR 21
}

// --- Reuse the host-agnostic webview bundle built by the core package's build.
// Single source of truth: we copy ../core/out/webview.js into plugin resources
// rather than vendoring a separate copy.
val repoRoot: File = projectDir.parentFile
val webviewBundle: File = repoRoot.resolve("core/out/webview.js")

val copyWebview by tasks.registering(Copy::class) {
    from(webviewBundle)
    into(layout.projectDirectory.dir("src/main/resources/webview"))
    doFirst {
        if (!webviewBundle.exists()) {
            throw GradleException(
                "Missing ${webviewBundle.path}.\n" +
                    "Build the webview first: run `npm run build` in the repo root (${repoRoot.path})."
            )
        }
    }
}

tasks.named("processResources") {
    dependsOn(copyWebview)
}
