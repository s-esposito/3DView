package dev.colmapview.actions

import com.intellij.openapi.actionSystem.AnActionEvent

/** Pick an asset — a mesh (glTF / GLB / OBJ / PLY) or a 3DGS splat (PLY / SPLAT / SPZ / KSPLAT) — and load it into the 3D viewer. */
class OpenAssetAction : ViewerAction() {
    override fun actionPerformed(e: AnActionEvent) {
        service(e)?.openAssetInteractive()
    }
}
