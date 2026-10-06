package io.github.lottooss.remora.core.data

import kotlinx.serialization.Serializable

/**
 * Data structures for Remora AnswerBridge approvals and questions (RCP/1 §8, blueprint §8.6).
 */

@Serializable
data class ApprovalPreview(val text: String, val json: String)

@Serializable
data class PendingApproval(
    val id: String,
    val sessionId: String,
    val callId: String? = null,
    val toolName: String,
    val reason: String? = null,
    val preview: ApprovalPreview,
    val argsDigest: String,
    val risk: String = "normal", // 'normal' | 'high'
    val requiresSignature: Boolean = false,
    val createdAt: Long = System.currentTimeMillis(),
    val expiresAt: Long = createdAt + 3_600_000L,
    val sessionTitle: String? = null,
) {
    val isExpired: Boolean get() = System.currentTimeMillis() >= expiresAt
    val remainingSeconds: Long get() = ((expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
}

@Serializable
data class QuestionOption(
    val label: String,
    val description: String? = null,
)

@Serializable
data class QuestionIntent(val kind: String, val approve: String)

@Serializable
data class QuestionPrompt(
    val id: String,
    val question: String,
    val detail: String? = null,
    val header: String? = null,
    val options: List<QuestionOption> = emptyList(),
    val multiSelect: Boolean = false,
    val intent: QuestionIntent? = null,
)

@Serializable
data class QuestionAnswer(val id: String, val selected: List<String>, val custom: String? = null)

@Serializable
data class PendingQuestion(
    val id: String,
    val sessionId: String,
    val questions: List<QuestionPrompt>,
    val createdAt: Long = System.currentTimeMillis(),
    val expiresAt: Long = createdAt + 3_600_000L,
    val sessionTitle: String? = null,
) {
    val isExpired: Boolean get() = System.currentTimeMillis() >= expiresAt
    val remainingSeconds: Long get() = ((expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
}

sealed interface PendingInteraction {
    val id: String
    val sessionId: String
    val createdAt: Long
    val expiresAt: Long

    data class Approval(val approval: PendingApproval) : PendingInteraction {
        override val id: String get() = approval.id
        override val sessionId: String get() = approval.sessionId
        override val createdAt: Long get() = approval.createdAt
        override val expiresAt: Long get() = approval.expiresAt
    }

    data class Question(val question: PendingQuestion) : PendingInteraction {
        override val id: String get() = question.id
        override val sessionId: String get() = question.sessionId
        override val createdAt: Long get() = question.createdAt
        override val expiresAt: Long get() = question.expiresAt
    }
}

data class ResolvedNotice(
    val id: String,
    val by: String, // 'pc' | 'phone' | 'system'
    val timestamp: Long = System.currentTimeMillis(),
)
