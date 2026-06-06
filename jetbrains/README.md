# 3DView — PyCharm / JetBrains plugin

A third host for the 3DView core, alongside the [VS Code extension](../vscode/)
and the [web demo](../demo/). It embeds the **same** host-agnostic
`core/out/webview.js` bundle inside a JCEF (Chromium) tool window — no viewer code
is duplicated. Built against PyCharm Community, so it runs in PyCharm and other
IntelliJ-based IDEs. For what the viewer does and its controls, see the
[root README](../README.md).

## How it works

- The webview bundle talks to its host only through `window.__viewerHost` (see
  `core/src/shared/hostBridge.ts`) and fetches images, meshes, and the COLMAP
  `.bin`/`.txt` files from plain URLs.
- The plugin provides that bridge with a `JBCefJSQuery` and serves all content
  from a single in-process origin (`http://colmapview/…`) via a CEF resource
  handler, guarded to allowed roots.
- COLMAP is parsed **in the webview** (`webview/colmapLoader.ts`); the plugin only
  discovers the model directory and serves bytes. Kotlin never parses COLMAP.

## Build & install

Needs **Node + npm** (builds the bundle), **JDK 21**, and a **Gradle 8.10+**
launcher — the `gradlew` wrapper if present, otherwise a system Gradle (or open
this folder in the IDE and let it generate the wrapper).

From the repo root, **`./jetbrains_build.sh`** does both steps (build the shared
webview bundle, then `buildPlugin`) and prints the output zip. Or run them by hand:

```bash
# 1) repo root — build the shared webview bundle (run `npm install` once first)
npm run build -w @3dview/core
# 2) here — package the plugin zip
cd jetbrains
gradle wrapper && ./gradlew buildPlugin   # -> build/distributions/colmapview-pycharm-<version>.zip
```

Then in the IDE: **Settings → Plugins → ⚙ → Install Plugin from Disk…**, pick that
zip, and restart. A **3D Viewer** tool window docks on the right and **Tools ▸**
gains *3DView: Open Reconstruction… / Open Mesh… / Open Empty Viewer*. (Loads on
IDE build 2024.3 and newer.)

For development, `./gradlew runIde` launches a sandbox IDE with the plugin loaded —
no install needed; `./gradlew verifyPlugin` runs the JetBrains plugin verifier.

No `gradlew` and no system Gradle? Download one and call it by full path:

```bash
mkdir -p ~/.local/gradle && cd ~/.local/gradle
curl -sSL -o gradle-8.10.2-bin.zip https://services.gradle.org/distributions/gradle-8.10.2-bin.zip
unzip -q gradle-8.10.2-bin.zip   # use ~/.local/gradle/gradle-8.10.2/bin/gradle in place of ./gradlew
```

## Notes

- **Build the webview first.** `copyWebview` fails with a clear message if
  `../core/out/webview.js` is missing — run step 1 before `buildPlugin`.
- The wrapper jar is binary and isn't committed; `gradle wrapper` (or opening the
  folder in the IDE) generates it once.
- Config cache stays on. If `buildPlugin` ever fails with a configuration-cache
  serialization error (usually pointing at `copyWebview`), re-run with
  `--no-configuration-cache`.
