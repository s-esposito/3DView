package dev.colmapview

/**
 * Host <-> webview message contract — a hand-written mirror of
 * src/shared/messages.ts. This is the single intentional duplication across the
 * TS/Kotlin boundary; keep the two in sync when the contract changes.
 *
 * Outbound (host -> webview) messages are emitted as JSON object literals and
 * delivered with window.postMessage. Inbound (webview -> host) messages are tiny
 * and well-formed (they originate from our own bundle), so we extract fields with
 * simple regexes instead of taking a JSON-library dependency.
 */

/** Inbound: webview -> host. */
sealed interface WebviewToHost {
    object Ready : WebviewToHost
    data class RequestAdd(val kind: String) : WebviewToHost // "colmap" | "asset"
    data class Removed(val id: String) : WebviewToHost

    /** A PNG render of the current viewpoint to save; `png` is a data URL. */
    data class SaveImage(val png: String, val suggestedName: String) : WebviewToHost

    companion object {
        fun parse(json: String): WebviewToHost? =
            when (field(json, "type")) {
                "ready" -> Ready
                "requestAdd" -> field(json, "kind")?.let(::RequestAdd)
                "removed" -> field(json, "id")?.let(::Removed)
                "saveImage" -> {
                    val png = field(json, "png")
                    val name = field(json, "suggestedName")
                    if (png != null && name != null) SaveImage(png, name) else null
                }
                else -> null
            }

        // Extract a top-level string field ("name":"value"). Sufficient for our
        // flat, trusted inbound messages (no nesting; values are plain strings).
        private fun field(json: String, name: String): String? {
            val re = Regex("\"" + Regex.escape(name) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"")
            return re.find(json)?.groupValues?.get(1)?.let(::unescape)
        }

        // No-escape fast path: skips four full-string passes for large escape-free
        // values (e.g. the base64 `png` of a saveImage message).
        private fun unescape(s: String): String =
            if ('\\' !in s) s
            else s.replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n").replace("\\/", "/")
    }
}

/** Outbound: host -> webview. Each function returns a JSON object literal to post. */
object HostMessages {
    fun loading(message: String): String =
        obj("type" to str("loading"), "message" to str(message))

    fun error(message: String): String =
        obj("type" to str("error"), "message" to str(message))

    fun addAsset(id: String, label: String, uri: String, name: String): String =
        obj(
            "type" to str("addAsset"),
            "id" to str(id),
            "label" to str(label),
            "asset" to obj("uri" to str(uri), "name" to str(name)),
        )

    fun loadColmap(
        id: String,
        label: String,
        format: String, // "bin" | "txt"
        camerasUrl: String,
        imagesUrl: String,
        points3dUrl: String,
        imageBaseUrl: String?,
        source: String?,
    ): String {
        val fields = mutableListOf(
            "type" to str("loadColmap"),
            "id" to str(id),
            "label" to str(label),
            "format" to str(format),
            "urls" to obj(
                "cameras" to str(camerasUrl),
                "images" to str(imagesUrl),
                "points3d" to str(points3dUrl),
            ),
        )
        if (imageBaseUrl != null) fields += "imageBaseUrl" to str(imageBaseUrl)
        if (source != null) fields += "source" to str(source)
        return obj(*fields.toTypedArray())
    }

    // --- minimal JSON building ------------------------------------------------
    // Values passed in are already JSON fragments (from str()/obj()); keys are raw.
    private fun obj(vararg entries: Pair<String, String>): String =
        entries.joinToString(",", "{", "}") { (k, v) -> "${str(k)}:$v" }

    private fun str(s: String): String {
        val sb = StringBuilder(s.length + 2).append('"')
        for (c in s) {
            when (c) {
                '"' -> sb.append("\\\"")
                '\\' -> sb.append("\\\\")
                '\n' -> sb.append("\\n")
                '\r' -> sb.append("\\r")
                '\t' -> sb.append("\\t")
                else -> if (c < ' ') sb.append("\\u%04x".format(c.code)) else sb.append(c)
            }
        }
        return sb.append('"').toString()
    }
}
