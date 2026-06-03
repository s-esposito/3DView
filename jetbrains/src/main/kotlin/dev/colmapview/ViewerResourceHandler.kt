package dev.colmapview

import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.callback.CefCallback
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.handler.CefResourceHandler
import org.cef.handler.CefResourceRequestHandler
import org.cef.handler.CefResourceRequestHandlerAdapter
import org.cef.misc.BoolRef
import org.cef.misc.IntRef
import org.cef.misc.StringRef
import org.cef.network.CefRequest
import org.cef.network.CefResponse
import java.io.InputStream
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import kotlin.math.min

/**
 * Serves all viewer content from a single in-process origin
 * (http://colmapview/...): the generated index.html, the bundled webview.js, and
 * `/local/...` files under allowed roots. The JCEF analog of VS Code's
 * `asWebviewUri`; same-origin avoids CSP/CORS friction. Files stream from disk so
 * large point clouds aren't buffered whole.
 */
class ViewerRequestHandler(
    private val roots: ResourceRoots,
    private val indexHtml: () -> ByteArray,
) : CefRequestHandlerAdapter() {

    private val resourceRequestHandler = object : CefResourceRequestHandlerAdapter() {
        override fun getResourceHandler(
            browser: CefBrowser?,
            frame: CefFrame?,
            request: CefRequest?,
        ): CefResourceHandler? = request?.url?.let(::handlerFor)
    }

    override fun getResourceRequestHandler(
        browser: CefBrowser?,
        frame: CefFrame?,
        request: CefRequest?,
        isNavigation: Boolean,
        isDownload: Boolean,
        requestInitiator: String?,
        disableDefaultHandling: BoolRef?,
    ): CefResourceRequestHandler? {
        val host = runCatching { URI(request?.url ?: "").host }.getOrNull()
        return if (host == HOST) resourceRequestHandler else null
    }

    private fun handlerFor(url: String): CefResourceHandler? {
        val uri = runCatching { URI(url) }.getOrNull() ?: return null
        if (uri.host != HOST) return null
        val path = uri.rawPath ?: "/"
        return when {
            path == "/" || path == "/index.html" -> ByteResourceHandler(indexHtml(), "text/html")
            path == "/webview.js" -> {
                val bytes = javaClass.getResourceAsStream("/webview/webview.js")?.use { it.readBytes() }
                if (bytes != null) ByteResourceHandler(bytes, "text/javascript")
                else ByteResourceHandler(BUNDLE_MISSING, "text/javascript")
            }
            path.startsWith("/local/") -> {
                val file = roots.resolveAllowed(path.removePrefix("/local/"))
                if (file != null && Files.isRegularFile(file)) {
                    FileResourceHandler(file, mimeFor(file.fileName.toString()))
                } else {
                    StatusResourceHandler(404)
                }
            }
            else -> StatusResourceHandler(404)
        }
    }

    companion object {
        const val HOST = "colmapview"
        private val BUNDLE_MISSING =
            "document.getElementById('status').textContent='webview.js missing — run npm run build';"
                .toByteArray(Charsets.UTF_8)

        private fun mimeFor(name: String): String =
            when (name.substringAfterLast('.', "").lowercase()) {
                "html" -> "text/html"
                "js" -> "text/javascript"
                "json", "gltf" -> "application/json"
                "glb" -> "model/gltf-binary"
                "obj", "mtl", "txt" -> "text/plain"
                "ply", "bin" -> "application/octet-stream"
                "png" -> "image/png"
                "jpg", "jpeg" -> "image/jpeg"
                "webp" -> "image/webp"
                "bmp" -> "image/bmp"
                "tif", "tiff" -> "image/tiff"
                else -> "application/octet-stream"
            }
    }
}

/** Serves a fixed byte array (index.html, the bundle). */
private class ByteResourceHandler(
    private val data: ByteArray,
    private val mime: String,
) : CefResourceHandler {
    private var offset = 0

    override fun processRequest(request: CefRequest?, callback: CefCallback?): Boolean {
        callback?.Continue()
        return true
    }

    override fun getResponseHeaders(response: CefResponse?, responseLength: IntRef?, redirectUrl: StringRef?) {
        response?.mimeType = mime
        response?.status = 200
        response?.setHeaderByName("Access-Control-Allow-Origin", "*", true)
        responseLength?.set(data.size)
    }

    override fun readResponse(dataOut: ByteArray?, bytesToRead: Int, bytesRead: IntRef?, callback: CefCallback?): Boolean {
        if (dataOut == null || offset >= data.size) {
            bytesRead?.set(0)
            return false
        }
        val n = min(bytesToRead, data.size - offset)
        System.arraycopy(data, offset, dataOut, 0, n)
        offset += n
        bytesRead?.set(n)
        return true
    }

    override fun cancel() {}
}

/** Streams a file from disk (so hundred-MB point clouds aren't buffered whole). */
private class FileResourceHandler(
    private val file: Path,
    private val mime: String,
) : CefResourceHandler {
    private var stream: InputStream? = null
    private var length: Long = -1

    override fun processRequest(request: CefRequest?, callback: CefCallback?): Boolean =
        try {
            length = Files.size(file)
            stream = Files.newInputStream(file)
            callback?.Continue()
            true
        } catch (_: Exception) {
            close()
            callback?.Continue()
            false
        }

    override fun getResponseHeaders(response: CefResponse?, responseLength: IntRef?, redirectUrl: StringRef?) {
        response?.mimeType = mime
        response?.status = 200
        response?.setHeaderByName("Access-Control-Allow-Origin", "*", true)
        responseLength?.set(if (length in 0..Int.MAX_VALUE.toLong()) length.toInt() else -1)
    }

    override fun readResponse(dataOut: ByteArray?, bytesToRead: Int, bytesRead: IntRef?, callback: CefCallback?): Boolean {
        val s = stream
        if (dataOut == null || s == null) {
            bytesRead?.set(0)
            return false
        }
        val n = s.read(dataOut, 0, bytesToRead)
        return if (n <= 0) {
            bytesRead?.set(0)
            close()
            false
        } else {
            bytesRead?.set(n)
            true
        }
    }

    override fun cancel() = close()

    private fun close() {
        runCatching { stream?.close() }
        stream = null
    }
}

/** Empty response with a given HTTP status (e.g. 404). */
private class StatusResourceHandler(private val status: Int) : CefResourceHandler {
    override fun processRequest(request: CefRequest?, callback: CefCallback?): Boolean {
        callback?.Continue()
        return true
    }

    override fun getResponseHeaders(response: CefResponse?, responseLength: IntRef?, redirectUrl: StringRef?) {
        response?.status = status
        responseLength?.set(0)
    }

    override fun readResponse(dataOut: ByteArray?, bytesToRead: Int, bytesRead: IntRef?, callback: CefCallback?): Boolean {
        bytesRead?.set(0)
        return false
    }

    override fun cancel() {}
}
