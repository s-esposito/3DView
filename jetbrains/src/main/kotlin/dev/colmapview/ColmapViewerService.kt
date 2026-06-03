package dev.colmapview

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.jcef.JBCefApp
import java.nio.file.Path
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
                if (kind == "mesh") openMeshInteractive() else openReconstructionInteractive()
            }
            p.onError = ::notifyError
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

    fun openMeshInteractive() {
        if (!ensureSupported()) return
        val descriptor = FileChooserDescriptorFactory.createSingleFileDescriptor()
            .withTitle("Select a mesh (glTF / GLB / OBJ / PLY)")
            .withFileFilter { vf -> vf.extension?.lowercase() in MESH_EXTS }
        val chosen = FileChooser.chooseFile(descriptor, project, null) ?: return
        activate()
        panel.openMesh(chosen.toNioPath())
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

    private fun notifyError(message: String) {
        NotificationGroupManager.getInstance()
            .getNotificationGroup("3DViewer")
            .createNotification("3DViewer: $message", NotificationType.ERROR)
            .notify(project)
    }

    override fun dispose() {}

    companion object {
        const val TOOL_WINDOW_ID = "3D Viewer"
        private val MESH_EXTS = setOf("glb", "gltf", "obj", "ply")
    }
}
