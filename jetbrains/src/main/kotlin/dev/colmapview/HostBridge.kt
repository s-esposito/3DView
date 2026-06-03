package dev.colmapview

import com.intellij.openapi.Disposable
import com.intellij.openapi.util.Disposer
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery

/**
 * Bridges the host-agnostic webview to the IDE. Provides the `window.__viewerHost`
 * adapter the bundle expects (see shared/hostBridge.ts) — its `postMessage`
 * funnels into a [JBCefJSQuery] back to Kotlin — and delivers host -> webview
 * messages with `executeJavaScript(window.postMessage(...))`. This is the PyCharm
 * counterpart of the VS Code adapter injected in panel.ts `getHtml`; the bundle
 * itself never names a host-specific API.
 */
class HostBridge(
    private val browser: JBCefBrowser,
    parent: Disposable,
    private val onMessage: (WebviewToHost) -> Unit,
) {
    private val query: JBCefJSQuery = JBCefJSQuery.create(browser as JBCefBrowserBase)

    init {
        query.addHandler { request ->
            WebviewToHost.parse(request)?.let(onMessage)
            null
        }
        Disposer.register(parent, query)
    }

    /**
     * JS to inject (before the bundle) that installs the neutral bridge. The
     * `query.inject("JSON.stringify(m)")` call expands to JS that ships the
     * stringified message to the [query] handler above.
     */
    fun adapterScript(): String =
        """
        window.__viewerHost = {
          postMessage: function (m) { ${query.inject("JSON.stringify(m)")} }
        };
        """.trimIndent()

    /** Deliver a host -> webview message (a JSON object literal) to the bundle. */
    fun post(jsonObjectLiteral: String) {
        val cef = browser.cefBrowser
        cef.executeJavaScript("window.postMessage($jsonObjectLiteral, '*');", cef.url ?: "", 0)
    }
}
