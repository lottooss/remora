package io.github.lottooss.remora.feature.conversation

import com.google.common.truth.Truth.assertThat
import io.github.lottooss.remora.core.data.LiveDeltaOverlay
import io.github.lottooss.remora.core.data.ModelRef
import io.github.lottooss.remora.core.data.Preview
import io.github.lottooss.remora.core.data.SessionEvent
import org.junit.Test

class ConversationTest {

    @Test
    fun testLiveDeltaOverlayAccumulation() {
        val initial = LiveDeltaOverlay(attempt = "att_1", text = "Hello", reasoning = "Thinking")
        val updated = initial.copy(text = initial.text + " world!", reasoning = initial.reasoning + " done")

        assertThat(updated.text).isEqualTo("Hello world!")
        assertThat(updated.reasoning).isEqualTo("Thinking done")
        assertThat(updated.active).isTrue()
    }

    @Test
    fun testToolEventFormatting() {
        val toolCall = SessionEvent.ToolCall(
            seq = 1,
            at = 1000,
            callId = "call_bash",
            tool = "bash",
            title = "git status",
            args = Preview(text = "git status -s", bytes = 13, truncated = false),
        )
        assertThat(toolCall.tool).isEqualTo("bash")
        assertThat(toolCall.args.truncated).isFalse()

        val toolResult = SessionEvent.ToolResult(
            seq = 2,
            at = 1200,
            callId = "call_bash",
            status = "ok",
            output = Preview(text = "M apps/android", bytes = 14, truncated = false),
        )
        assertThat(toolResult.status).isEqualTo("ok")
        assertThat(toolResult.output.text).contains("M apps/android")
    }

    @Test
    fun testModelRefCreation() {
        val model = ModelRef(provider = "deepseek", model = "deepseek-reasoner", reasoningEffort = "high")
        assertThat(model.provider).isEqualTo("deepseek")
        assertThat(model.model).isEqualTo("deepseek-reasoner")
        assertThat(model.reasoningEffort).isEqualTo("high")
    }
}
