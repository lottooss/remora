package io.github.lottooss.remora.feature.sessions

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.ModelRef
import io.github.lottooss.remora.core.data.SessionRepository
import io.github.lottooss.remora.core.data.SessionSummary
import io.github.lottooss.remora.core.data.WorkspaceRef
import org.junit.Test

class SessionsTest {

    @Test
    fun testSessionsGroupingByWorkspace() {
        val repo = SessionRepository()
        val s1 = SessionSummary(
            id = "s_1",
            title = "Task 1",
            workspace = WorkspaceRef(id = "ws_1", title = "Repo A"),
            status = "running",
            updatedAt = 1000L,
        )
        val s2 = SessionSummary(
            id = "s_2",
            title = "Task 2",
            workspace = WorkspaceRef(id = "ws_1", title = "Repo A"),
            status = "idle",
            updatedAt = 2000L,
        )
        val s3 = SessionSummary(
            id = "s_3",
            title = "Task 3",
            workspace = WorkspaceRef(id = "ws_2", title = "Repo B"),
            status = "idle",
            updatedAt = 1500L,
        )

        repo.setSessions(listOf(s1, s2, s3))
        val sessions = repo.sessions.value

        val grouped = sessions.groupBy { it.workspace.title ?: "Default" }
        assertThat(grouped.keys).containsExactly("Repo A", "Repo B")
        assertThat(grouped["Repo A"]).hasSize(2)
        assertThat(grouped["Repo B"]).hasSize(1)
    }

    @Test
    fun testSessionCardStatusMapping() {
        val runningSession = SessionSummary(
            id = "s_run",
            title = "Active task",
            status = "running",
            model = ModelRef("deepseek", "deepseek-chat"),
        )
        assertThat(runningSession.status).isEqualTo("running")
        assertThat(runningSession.model?.model).isEqualTo("deepseek-chat")
    }
}
