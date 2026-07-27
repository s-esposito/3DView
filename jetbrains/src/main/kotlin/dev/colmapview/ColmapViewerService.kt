package dev.colmapview

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileChooser.FileSaverDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.jcef.JBCefApp
import java.nio.file.Path
import java.util.Base64
import javax.swing.JComponent

/**
 * Project-scoped owner of the viewer panel + the native UI flows (file choosers,
 * the multi-model popup, error notifications). Actions and the webview's Scene
 * "+" both route through here. Mirrors the command/picker layer of the VS Code
 * host (extension.ts), while the panel mirrors panel.ts.
 */
@Service(Service.Level.PROJECT)
class ColmapViewerService(private val project: Project) : Disposable {

    // Built lazily (on first tool-window open or first action), so the JBCefBrowser
    // is created only when actually needed and torn down with this service.
    private val panel: JcefViewerPanel by lazy {
        JcefViewerPanel(this).also { p ->
            p.onRequestAdd = { kind ->
                // "colmap" picks a folder; every other kind picks an asset file and
                // only narrows the chooser's filter (mesh / splat / tracks).
                if (kind == "colmap") openReconstructionInteractive() else openAssetInteractive(kind)
            }
            p.onError = ::notifyError
            p.onSaveImage = ::saveImage
        }
    }

    fun component(): JComponent = panel.component

    fun activate() {
        ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID)?.activate(null, true)
    }

    fun openReconstructionInteractive() {
        if (!ensureSupported()) return
        val descriptor = FileChooserDescriptorFactory.createSingleFolderDescriptor()
            .withTitle("Select a COLMAP reconstruction folder")
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        val root = chosen.toNioPath()
        val dirs = ColmapDiscovery.findModelDirs(root)
        when {
            dirs.isEmpty() -> notifyError(
                "No COLMAP model found here (need cameras/images/points3D as .bin or .txt, e.g. under sparse/0)."
            )
            dirs.size == 1 -> openColmap(root, dirs.first())
            else -> chooseModel(root, dirs)
        }
    }

    /** Pick an asset file. `kind` (mesh / splat / tracks) only narrows the filter;
     *  null offers every asset format. What a file *is* comes from the file itself. */
    fun openAssetInteractive(kind: String? = null) {
        if (!ensureSupported()) return
        val exts = kind?.let { ASSET_KIND_EXTS[it] } ?: ASSET_EXTS
        val title = kind?.let { ASSET_KIND_TITLES[it] }
            ?: "Select an asset — mesh, 3DGS splat, or 3D point tracks"
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor()
            .withTitle(title)
            .withFileFilter { vf -> vf.extension?.lowercase() in exts }
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        activate()
        panel.openAsset(chosen.toNioPath())
    }

    private fun chooseModel(root: Path, dirs: List<Path>) {
        val allLabel = "All ${dirs.size} models"
        val labels = listOf(allLabel) + dirs.map { labelOf(root, it) }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labels)
            .setTitle("Multiple COLMAP models found")
            .setItemChosenCallback { label ->
                if (label == allLabel) {
                    dirs.forEach { openColmap(root, it) }
                } else {
                    val dir = dirs.firstOrNull { labelOf(root, it) == label } ?: return@setItemChosenCallback
                    openColmap(root, dir)
                }
            }
            .createPopup()
            .showCenteredInCurrentWindow(project)
    }

    private fun openColmap(root: Path, modelDir: Path) {
        val imagesDir = ColmapDiscovery.findImagesDir(root, modelDir)
        activate()
        panel.openColmap(modelDir, imagesDir)
    }

    private fun labelOf(root: Path, dir: Path): String =
        runCatching { root.relativize(dir).toString() }.getOrNull()?.ifEmpty { dir.fileName.toString() }
            ?: dir.fileName.toString()

    private fun ensureSupported(): Boolean {
        if (JBCefApp.isSupported()) return true
        notifyError("JCEF is not available in this IDE/runtime; the 3D viewer can't be shown.")
        return false
    }

    /** Save a webview-rendered PNG (data URL) to a user-chosen file. */
    private fun saveImage(png: String, suggestedName: String) {
        val bytes = runCatching { Base64.getDecoder().decode(png.substringAfter("base64,")) }.getOrNull()
        if (bytes == null) {
            notifyError("Could not decode the rendered image.")
            return
        }
        val descriptor = FileSaverDescriptor("Save Render", "Save the rendered viewpoint as a PNG", "png")
        val wrapper = FileChooserFactory.getInstance()
            .createSaveFileDialog(descriptor, project)
            .save(null as VirtualFile?, suggestedName) ?: return
        runCatching { wrapper.file.writeBytes(bytes) }
            .onSuccess { notifyInfo("Saved ${wrapper.file.name}") }
            .onFailure { notifyError("Could not save image: ${it.message}") }
    }

    private fun notifyError(message: String) {
        notify(message, NotificationType.ERROR)
    }

    private fun notifyInfo(message: String) {
        notify(message, NotificationType.INFORMATION)
    }

    private fun notify(message: String, type: NotificationType) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("3DView")
            .createNotification("3DView: $message", type)
            .notify(project)
    }

    override fun dispose() {}

    companion object {
        const val TOOL_WINDOW_ID = "3D Viewer"
        // Asset formats per kind, mirroring core's ASSET_KIND_EXTS (the webview's
        // Scene "+" sends the kind). A .ply is under both mesh and splat: the two
        // are told apart by the PLY header, in the webview.
        private val ASSET_KIND_EXTS = mapOf(
            "mesh" to setOf("glb", "gltf", "obj", "ply"),
            "splat" to setOf("ply", "splat", "spz", "ksplat"),
            "tracks" to setOf("npz", "npy"),
        )
        private val ASSET_EXTS = ASSET_KIND_EXTS.values.flatten().toSet()
        private val ASSET_KIND_TITLES = mapOf(
            "mesh" to "Select a mesh (glTF / GLB / OBJ / PLY)",
            "splat" to "Select a 3DGS splat (PLY / SPLAT / SPZ / KSPLAT)",
            "tracks" to "Select 3D point tracks (NPZ / NPY)",
        )
    }
}
