package dev.colmapview

import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.file.Path
import java.nio.file.Paths

/**
 * Tracks the filesystem roots the webview is allowed to fetch from, and converts
 * between absolute paths and the in-process resource URLs we serve
 * (http://colmapview/local/...). This is the JCEF analog of VS Code's
 * `asWebviewUri` + `localResourceRoots`, including the image-name path-escape
 * guard from panel.ts (a requested file must resolve under an allowed root).
 */
class ResourceRoots {
    private val roots = mutableListOf<Path>()

    /** Allow serving files under [dir] (and its subtree). */
    @Synchronized
    fun allow(dir: Path) {
        val norm = dir.toAbsolutePath().normalize()
        if (roots.none { norm.startsWith(it) }) {
            roots.removeAll { it.startsWith(norm) } // drop now-redundant children
            roots.add(norm)
        }
    }

    /** Resolve a `/local/...` URL path back to an allowed absolute file, or null. */
    @Synchronized
    fun resolveAllowed(localPath: String): Path? {
        val path = decodePath(localPath) ?: return null
        val norm = path.toAbsolutePath().normalize()
        return if (roots.any { norm.startsWith(it) }) norm else null
    }

    /** Resource URL for an absolute file (directory tree preserved as path segments). */
    fun toResourceUrl(file: Path): String = "$ORIGIN/local/${encodePath(file)}"

    /** Base resource URL for a directory (used as a reconstruction's imageBaseUrl). */
    fun toResourceBaseUrl(dir: Path): String = "$ORIGIN/local/${encodePath(dir)}"

    companion object {
        const val ORIGIN = "http://colmapview"

        // Encode an absolute path as slash-separated, per-segment-encoded text, so
        // the URL mirrors the directory tree. That lets Three.js loaders resolve
        // OBJ .mtl / glTF sibling files relative to the mesh URL.
        private fun encodePath(p: Path): String {
            val posix = p.toAbsolutePath().normalize().toString().replace('\\', '/').trimStart('/')
            return posix.split('/').joinToString("/") {
                URLEncoder.encode(it, Charsets.UTF_8).replace("+", "%20")
            }
        }

        private fun decodePath(localPath: String): Path? {
            val decoded = localPath.split('/')
                .filter { it.isNotEmpty() }
                .joinToString("/") { URLDecoder.decode(it, Charsets.UTF_8) }
            if (decoded.isEmpty()) return null
            // A Windows drive (e.g. "C:/...") is already absolute; POSIX needs "/".
            val abs = if (decoded.matches(Regex("^[A-Za-z]:.*"))) decoded else "/$decoded"
            return runCatching { Paths.get(abs) }.getOrNull()
        }
    }
}
