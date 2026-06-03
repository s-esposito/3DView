package dev.colmapview.actions

import com.intellij.openapi.actionSystem.AnActionEvent

/** Pick a COLMAP folder and load it into the 3D viewer. */
class OpenReconstructionAction : ViewerAction() {
    override fun actionPerformed(e: AnActionEvent) {
        service(e)?.openReconstructionInteractive()
    }
}
