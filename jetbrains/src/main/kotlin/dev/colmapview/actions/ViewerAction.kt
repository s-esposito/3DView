package dev.colmapview.actions

import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import dev.colmapview.ColmapViewerService

/** Shared base for the 3DView actions: enabled only with a project in context. */
abstract class ViewerAction : AnAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabled = e.project != null
    }

    protected fun service(e: AnActionEvent): ColmapViewerService? =
        e.project?.getService(ColmapViewerService::class.java)
}
