package dev.colmapview

import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import javax.swing.SwingConstants

/** Builds the "3D Viewer" tool window: the JCEF viewer, or a notice if JCEF is absent. */
class ColmapViewerToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val component = if (JBCefApp.isSupported()) {
            project.getService(ColmapViewerService::class.java).component()
        } else {
            JBLabel(
                "JCEF is not available in this IDE/runtime, so the 3D viewer can't be shown.",
                SwingConstants.CENTER,
            )
        }
        val content = ContentFactory.getInstance().createContent(component, "", false)
        toolWindow.contentManager.addContent(content)
    }
}
