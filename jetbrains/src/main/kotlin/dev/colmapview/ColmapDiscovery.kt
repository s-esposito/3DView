package dev.colmapview

import java.nio.file.Files
import java.nio.file.Path

/**
 * COLMAP model discovery on disk — a Kotlin port of the pure directory logic in
 * the VS Code host's colmapLoad.ts (detectFormat / findModelDirs / findImagesDir
 * / labelFor). No bytes are parsed here; parsing happens in the webview
 * (colmapLoader.ts). Keep this in sync with colmapLoad.ts.
 */
object ColmapDiscovery {
    private val STEMS = listOf("cameras", "images", "points3D")

    /** "bin" | "txt" | null — prefers binary (the COLMAP default). */
    fun detectFormat(dir: Path): String? = when {
        STEMS.all { Files.exists(dir.resolve("$it.bin")) } -> "bin"
        STEMS.all { Files.exists(dir.resolve("$it.txt")) } -> "txt"
        else -> null
    }

    /**
     * Candidate model dirs at/below [root]: root, its immediate subdirs, `sparse`,
     * and `sparse`'s immediate subdirs (covers the common layouts without an
     * unbounded walk).
     */
    fun findModelDirs(root: Path): List<Path> {
        val found = LinkedHashSet<Path>()

        fun consider(dir: Path) {
            val resolved = dir.toAbsolutePath().normalize()
            if (Files.isDirectory(resolved) && detectFormat(resolved) != null) found.add(resolved)
        }

        fun considerChildren(dir: Path) {
            if (!Files.isDirectory(dir)) return
            runCatching {
                Files.newDirectoryStream(dir).use { stream ->
                    for (entry in stream) if (Files.isDirectory(entry)) consider(entry)
                }
            }
        }

        consider(root)
        considerChildren(root)
        val sparse = root.resolve("sparse")
        consider(sparse)
        considerChildren(sparse)
        return found.toList()
    }

    /**
     * Locate the source-images dir for a model: probe `<root>/images` and a couple
     * of levels up from the model dir. Returns the first existing dir, or null.
     */
    fun findImagesDir(root: Path, modelDir: Path): Path? {
        val candidates = listOf(
            root.resolve("images"),
            modelDir.resolve("images"),
            modelDir.resolve("..").resolve("images"),
            modelDir.resolve("..").resolve("..").resolve("images"),
        )
        return candidates.firstOrNull { Files.isDirectory(it) }?.toAbsolutePath()?.normalize()
    }

    /** Readable label for a model dir, disambiguating numeric dirs like `sparse/0`. */
    fun labelFor(modelDir: Path): String {
        val base = modelDir.fileName?.toString() ?: modelDir.toString()
        return if (base.matches(Regex("^\\d+$"))) {
            val parent = modelDir.parent?.fileName?.toString()
            if (parent != null) "$parent/$base" else base
        } else {
            base
        }
    }
}
