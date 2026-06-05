package dev.colmapview

import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import java.nio.file.Path
import javax.swing.JComponent

/**
 * Hosts the JCEF browser running the shared webview bundle, and mirrors the VS
 * Code host's panel.ts: it tracks scene items (stable ids), queues content until
 * the webview signals `ready`, and translates open requests into host -> webview
 * messages. COLMAP is parsed in the webview (we only serve URLs).
 */
class JcefViewerPanel(parent: Disposable) {
    /** Called when the webview's Scene "+" requests adding content ("colmap"|"mesh"). */
    var onRequestAdd: (kind: String) -> Unit = {}

    /** Called with a user-facing error message (the canvas status is set too). */
    var onError: (message: String) -> Unit = {}

    /** Called with a PNG render of the current viewpoint (data URL) to save. */
    var onSaveImage: (png: String, suggestedName: String) -> Unit = { _, _ -> }

    private val roots = ResourceRoots()
    private val browser: JBCefBrowser = JBCefBrowser.createBuilder()
        .setEnableOpenDevToolsMenuItem(true)
        .build()
    private val bridge: HostBridge

    private sealed interface Target {
        data class Colmap(val modelDir: Path, val imagesDir: Path?) : Target
        data class Mesh(val file: Path) : Target
    }

    private data class Item(val id: String, val target: Target)

    private val content = mutableListOf<Item>()
    private val pending = mutableListOf<() -> Unit>()
    private var webviewReady = false
    private var idCounter = 0

    init {
        // Register the browser first so it is disposed before the bridge's JS query.
        Disposer.register(parent, browser)
        bridge = HostBridge(browser, parent, ::dispatch)
        val requestHandler = ViewerRequestHandler(roots) { indexHtml }
        // Associate the request handler with this browser (JBCefClient allows
        // adding handlers post-creation), then load from our own origin so every
        // request — page, bundle, model files — is intercepted and same-origin.
        browser.jbCefClient.addRequestHandler(requestHandler, browser.cefBrowser)
        browser.loadURL("${ResourceRoots.ORIGIN}/index.html")
    }

    val component: JComponent get() = browser.component

    /** Add a mesh file to the scene. */
    fun openMesh(file: Path) {
        roots.allow(file.parent ?: file)
        val id = "mesh-${++idCounter}"
        content += Item(id, Target.Mesh(file))
        val name = file.fileName.toString()
        queueOrRun { bridge.post(HostMessages.addMesh(id, name, roots.toResourceUrl(file), name)) }
    }

    /** Add a COLMAP reconstruction (the webview fetches + parses the model files). */
    fun openColmap(modelDir: Path, imagesDir: Path?) {
        val format = ColmapDiscovery.detectFormat(modelDir)
        if (format == null) {
            reportError("No COLMAP model in $modelDir (expected cameras/images/points3D as .bin or .txt).")
            return
        }
        roots.allow(modelDir)
        imagesDir?.let(roots::allow)
        val id = "colmap-${++idCounter}"
        content += Item(id, Target.Colmap(modelDir, imagesDir))
        val msg = HostMessages.loadColmap(
            id = id,
            label = ColmapDiscovery.labelFor(modelDir),
            format = format,
            camerasUrl = roots.toResourceUrl(modelDir.resolve("cameras.$format")),
            imagesUrl = roots.toResourceUrl(modelDir.resolve("images.$format")),
            points3dUrl = roots.toResourceUrl(modelDir.resolve("points3D.$format")),
            imageBaseUrl = imagesDir?.let(roots::toResourceBaseUrl),
            source = modelDir.toString(),
        )
        queueOrRun { bridge.post(msg) }
    }

    // --- internals ------------------------------------------------------------

    private fun reportError(message: String) {
        bridge.post(HostMessages.error(message))
        onError(message)
    }

    private fun queueOrRun(action: () -> Unit) {
        if (webviewReady) action() else pending += action
    }

    /** Inbound webview -> host, marshaled onto the EDT (UI + chooser work). */
    private fun dispatch(msg: WebviewToHost) {
        ApplicationManager.getApplication().invokeLater {
            when (msg) {
                WebviewToHost.Ready -> {
                    webviewReady = true
                    val queued = pending.toList()
                    pending.clear()
                    queued.forEach { it() }
                }
                is WebviewToHost.RequestAdd -> onRequestAdd(msg.kind)
                is WebviewToHost.Removed -> content.removeAll { it.id == msg.id }
                is WebviewToHost.SaveImage -> onSaveImage(msg.png, msg.suggestedName)
            }
        }
    }

    /** The page is generated here so the bridge adapter is injected before the bundle. */
    private val indexHtml: ByteArray by lazy {
        """
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <title>3DViewer</title>
          <style>
            html, body { margin: 0; height: 100%; overflow: hidden; background: #1e1e1e; }
            canvas { display: block; position: fixed; top: 0; left: 0; }
            #status {
              position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
              font-family: sans-serif; color: #bbbbbb; pointer-events: none;
            }
          </style>
        </head>
        <body>
          <div id="status">Loading…</div>
          <script>${bridge.adapterScript()}</script>
          <script src="webview.js"></script>
        </body>
        </html>
        """.trimIndent().toByteArray(Charsets.UTF_8)
    }
}
