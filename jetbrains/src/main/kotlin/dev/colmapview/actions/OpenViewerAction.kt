package dev.colmapview.actions

import com.intellij.openapi.actionSystem.AnActionEvent

/** Open the 3D viewer tool window with an empty scene. */
class OpenViewerAction : ViewerAction() {
    override fun actionPerformed(e: AnActionEvent) {
        service(e)?.activate()
    }
}
