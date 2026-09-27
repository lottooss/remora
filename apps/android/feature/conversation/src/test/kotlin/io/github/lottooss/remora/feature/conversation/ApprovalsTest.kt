package io.github.lottooss.remora.feature.conversation

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.InteractionRepository
import io.github.lottooss.remora.core.data.PendingApproval
import io.github.lottooss.remora.core.data.PendingInteraction
import io.github.lottooss.remora.core.data.PendingQuestion
import io.github.lottooss.remora.core.data.Preview
import io.github.lottooss.remora.core.data.QuestionOption
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Test

class ApprovalsTest {

    @Test
    fun testPendingApprovalModelAttributes() {
        val approval = PendingApproval(
            id = "appr_123",
            sessionId = "s_main",
            toolName = "write_to_file",
            reason = "Write new configuration",
            preview = Preview(text = "TargetFile: /path/to/file.txt\nContent: hello", bytes = 45, truncated = false),
            argsDigest = "sha256:11223344",
            risk = "normal",
            requiresSignature = false,
            createdAt = 1000L,
            expiresAt = 2000L,
        )

        assertThat(approval.toolName).isEqualTo("write_to_file")
        assertThat(approval.risk).isEqualTo("normal")
        assertThat(approval.requiresSignature).isFalse()
        assertThat(approval.preview.truncated).isFalse()
    }

    @Test
    fun testPendingQuestionModelAndOptions() {
        val question = PendingQuestion(
            id = "q_plan_review",
            sessionId = "s_plan",
            prompt = "Review the proposed implementation plan",
            detail = "### Phase 1: Preparation\n- Setup build configs\n### Phase 2: Implementation",
            options = listOf(
                QuestionOption(id = "approve", label = "Approve Plan", description = "Proceed immediately"),
                QuestionOption(id = "modify", label = "Request Changes", description = "Edit requirements"),
            ),
            multiSelect = false,
            allowCustom = true,
        )

        assertThat(question.prompt).contains("Review the proposed implementation plan")
        assertThat(question.detail).contains("Phase 1: Preparation")
        assertThat(question.options).hasSize(2)
        assertThat(question.options[0].id).isEqualTo("approve")
        assertThat(question.multiSelect).isFalse()
    }

    @Test
    fun testInteractionTakeoverSessionFiltering() = runBlocking {
        val repo = InteractionRepository()
        val s1 = "session_1"
        val s2 = "session_2"

        val app1 = PendingApproval(
            id = "a1",
            sessionId = s1,
            toolName = "bash",
            preview = Preview(text = "echo 1"),
            argsDigest = "sha256:d1",
        )
        val app2 = PendingApproval(
            id = "a2",
            sessionId = s2,
            toolName = "powershell",
            preview = Preview(text = "echo 2"),
            argsDigest = "sha256:d2",
        )

        repo.addOrUpdate(PendingInteraction.Approval(app1))
        repo.addOrUpdate(PendingInteraction.Approval(app2))

        val s1Items = repo.getPendingForSession(s1).first()
        val s2Items = repo.getPendingForSession(s2).first()

        assertThat(s1Items).hasSize(1)
        assertThat(s1Items[0].id).isEqualTo("a1")

        assertThat(s2Items).hasSize(1)
        assertThat(s2Items[0].id).isEqualTo("a2")

        // PC resolves a1
        repo.resolve("a1", by = "pc")
        assertThat(repo.getPendingForSession(s1).first()).isEmpty()
        assertThat(repo.getPendingForSession(s2).first()).hasSize(1)
    }
}
