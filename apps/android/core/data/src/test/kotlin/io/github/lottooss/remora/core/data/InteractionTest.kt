package io.github.lottooss.remora.core.data

import com.google.common.truth.Truth.assertThat
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Test

class InteractionTest {

    private class FakeRpcCaller(
        private val handler: (method: String, params: JsonObject) -> JsonObject = { _, _ ->
            buildJsonObject { put("accepted", true) }
        },
    ) {
        val calls = mutableListOf<Pair<String, JsonObject>>()

        suspend fun call(method: String, params: JsonObject): JsonObject {
            calls.add(method to params)
            return handler(method, params)
        }
    }

    @Test
    fun testHighRiskApprovalRequiresBiometricSignature() = runBlocking {
        val repo = InteractionRepository()
        val service = InteractionService(repo)
        val caller = FakeRpcCaller()

        val highRiskApproval = PendingApproval(
            id = "appr_high_1",
            sessionId = "s_1",
            toolName = "bash",
            preview = Preview(text = "rm -rf /tmp/data"),
            argsDigest = "sha256:abc123",
            risk = "high",
            requiresSignature = true,
        )
        repo.addOrUpdate(PendingInteraction.Approval(highRiskApproval))

        // 1. Without signature provider -> must fail closed with SecurityException
        val failResult = service.answerApproval(
            approval = highRiskApproval,
            outcome = "allowed-once",
            signatureProvider = null,
            rpcCaller = caller::call,
        )
        assertThat(failResult.isFailure).isTrue()
        assertThat(failResult.exceptionOrNull()).isInstanceOf(SecurityException::class.java)
        assertThat(failResult.exceptionOrNull()?.message).contains("Biometric signature required")

        // 2. With signature provider -> succeeds and dispatches sig
        var providerCalled = false
        val successResult = service.answerApproval(
            approval = highRiskApproval,
            outcome = "allowed-once",
            signatureProvider = { canonicalMsg ->
                providerCalled = true
                assertThat(canonicalMsg).contains("remora/1 approval")
                assertThat(canonicalMsg).contains("appr_high_1")
                "fake_sig_b64u"
            },
            rpcCaller = caller::call,
        )

        assertThat(successResult.isSuccess).isTrue()
        assertThat(providerCalled).isTrue()
        assertThat(caller.calls).hasSize(1)
        assertThat(caller.calls[0].first).isEqualTo("approvals.answer")

        // Should be resolved locally in repository
        val remaining = repo.allPending.value
        assertThat(remaining).isEmpty()
    }

    @Test
    fun testNormalRiskApprovalNeedsOnlyUnlockedApp() = runBlocking {
        val repo = InteractionRepository()
        val service = InteractionService(repo)
        val caller = FakeRpcCaller()

        val normalRiskApproval = PendingApproval(
            id = "appr_normal_1",
            sessionId = "s_1",
            toolName = "read_file",
            preview = Preview(text = "package.json"),
            argsDigest = "sha256:xyz789",
            risk = "normal",
            requiresSignature = false,
        )
        repo.addOrUpdate(PendingInteraction.Approval(normalRiskApproval))

        // Normal risk needs no signature provider
        val result = service.answerApproval(
            approval = normalRiskApproval,
            outcome = "allowed-once",
            signatureProvider = null,
            rpcCaller = caller::call,
        )

        assertThat(result.isSuccess).isTrue()
        assertThat(caller.calls).hasSize(1)
        val params = caller.calls[0].second
        assertThat(params.containsKey("sig")).isFalse()
    }

    @Test
    fun testDigestMismatchBlocksSigning() = runBlocking {
        val repo = InteractionRepository()
        val service = InteractionService(repo)
        val caller = FakeRpcCaller()

        val approval = PendingApproval(
            id = "appr_tampered",
            sessionId = "s_1",
            toolName = "bash",
            preview = Preview(text = "echo 'safe'"),
            argsDigest = "sha256:safe_digest",
            risk = "high",
            requiresSignature = true,
        )

        var signatureProviderInvoked = false
        val result = service.answerApproval(
            approval = approval,
            outcome = "allowed-once",
            displayedPreviewText = "echo 'tampered evil script'", // Mismatched displayed preview!
            signatureProvider = {
                signatureProviderInvoked = true
                "fake_sig"
            },
            rpcCaller = caller::call,
        )

        // Must fail with SecurityException without even calling the signature provider!
        assertThat(result.isFailure).isTrue()
        assertThat(result.exceptionOrNull()).isInstanceOf(SecurityException::class.java)
        assertThat(result.exceptionOrNull()?.message).contains("Preview text mismatch")
        assertThat(signatureProviderInvoked).isFalse()
        assertThat(caller.calls).isEmpty()
    }

    @Test
    fun testQuestionAnsweringDispatchesRpc() = runBlocking {
        val repo = InteractionRepository()
        val service = InteractionService(repo)
        val caller = FakeRpcCaller()

        val question = PendingQuestion(
            id = "q_1",
            sessionId = "s_1",
            prompt = "Select architecture strategy",
            options = listOf(
                QuestionOption(id = "opt_a", label = "Option A"),
                QuestionOption(id = "opt_b", label = "Option B"),
            ),
        )
        repo.addOrUpdate(PendingInteraction.Question(question))

        val result = service.answerQuestion(
            questionId = "q_1",
            answers = listOf("opt_a"),
            text = "Proceed with Option A",
            rpcCaller = caller::call,
        )

        assertThat(result.isSuccess).isTrue()
        assertThat(caller.calls).hasSize(1)
        assertThat(caller.calls[0].first).isEqualTo("questions.answer")
        assertThat(repo.allPending.value).isEmpty()
    }

    @Test
    fun testInteractionRepositoryResolutionEvent() = runBlocking {
        val repo = InteractionRepository()

        val approval = PendingApproval(
            id = "appr_pc_win",
            sessionId = "s_1",
            toolName = "bash",
            preview = Preview(text = "git push"),
            argsDigest = "sha256:digest",
        )
        repo.addOrUpdate(PendingInteraction.Approval(approval))

        assertThat(repo.getPendingForSession("s_1").first()).hasSize(1)

        // PC resolves approval
        repo.resolve("appr_pc_win", by = "pc")

        assertThat(repo.getPendingForSession("s_1").first()).isEmpty()
        val notice = repo.resolvedEvents.first()
        assertThat(notice.id).isEqualTo("appr_pc_win")
        assertThat(notice.by).isEqualTo("pc")
    }
}
