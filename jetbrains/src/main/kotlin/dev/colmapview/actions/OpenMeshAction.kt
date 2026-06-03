package dev.colmapview.actions

import com.intellij.openapi.actionSystem.AnActionEvent

/** Pick a mesh (glTF / GLB / OBJ / PLY) and load it into the 3D viewer. */
class OpenMeshAction : ViewerAction() {
    override fun actionPerformed(e: AnActionEvent) {
        service(e)?.openMeshInteractive()
    }
}
