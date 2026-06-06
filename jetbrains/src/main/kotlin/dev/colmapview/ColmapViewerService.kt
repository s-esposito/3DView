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
                if (kind == "asset") openAssetInteractive() else openReconstructionInteractive()
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

    fun openAssetInteractive() {
        if (!ensureSupported()) return
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor()
            .withTitle("Select an asset — mesh (glTF / GLB / OBJ / PLY) or splat (PLY / SPLAT / SPZ / KSPLAT)")
            .withFileFilter { vf -> vf.extension?.lowercase() in ASSET_EXTS }
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        activate()
        panel.openAsset(chosen.toNioPath())
    }

    private fun chooseModel(root: Path, dirs: List<Path>) {
        val labels = dirs.map { labelOf(root, it) }
        JBPopupFactory.getInstance()
            .createPopupChooserBuilder(labels)
            .setTitle("Multiple COLMAP models found")
            .setItemChosenCallback { label ->
                val dir = dirs.firstOrNull { labelOf(root, it) == label } ?: return@setItemChosenCallback
                openColmap(root, dir)
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
        // Meshes (glTF/GLB/OBJ/PLY) + 3DGS splats (PLY/SPLAT/SPZ/KSPLAT); a .ply is
        // disambiguated in the webview.
        private val ASSET_EXTS = setOf("glb", "gltf", "obj", "ply", "splat", "spz", "ksplat")
    }
}
