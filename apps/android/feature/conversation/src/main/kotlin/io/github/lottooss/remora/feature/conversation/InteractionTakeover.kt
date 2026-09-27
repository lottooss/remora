package io.github.lottooss.remora.feature.conversation

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.data.PendingApproval
import io.github.lottooss.remora.core.data.PendingQuestion

/**
 * Takeover card shown in conversation when an approval is required (ADR-0008, blueprint §8.6).
 */
@Composable
fun ApprovalTakeoverCard(
    approval: PendingApproval,
    onApprove: (approval: PendingApproval) -> Unit,
    onReject: (approval: PendingApproval) -> Unit,
    modifier: Modifier = Modifier,
) {
    val isHighRisk = approval.risk == "high" || approval.requiresSignature

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(8.dp),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isHighRisk) MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
            else MaterialTheme.colorScheme.surfaceVariant,
        ),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "🚨 Approval Required: ${approval.toolName}",
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                )

                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = if (isHighRisk) MaterialTheme.colorScheme.errorContainer else MaterialTheme.colorScheme.secondaryContainer,
                ) {
                    Text(
                        text = if (isHighRisk) "HIGH RISK (Biometric)" else "NORMAL",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (isHighRisk) MaterialTheme.colorScheme.onErrorContainer else MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
                    )
                }
            }

            val reason = approval.reason
            if (!reason.isNullOrBlank()) {
                Text(
                    text = reason,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            // Command / args preview in monospace, horizontally scrollable, never truncated silently
            Surface(
                shape = RoundedCornerShape(6.dp),
                color = MaterialTheme.colorScheme.surface,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .horizontalScroll(rememberScrollState())
                        .padding(8.dp),
                ) {
                    Text(
                        text = approval.preview.text,
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedButton(
                    onClick = { onReject(approval) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.error),
                ) {
                    Text("Reject")
                }

                Button(
                    onClick = { onApprove(approval) },
                    modifier = Modifier.weight(1f),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isHighRisk) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                    ),
                ) {
                    Text(if (isHighRisk) "Approve (Fingerprint)" else "Approve")
                }
            }
        }
    }
}

/**
 * Takeover card shown in conversation when the agent asks a question (plan review, options, or free text).
 */
@Composable
fun QuestionTakeoverCard(
    question: PendingQuestion,
    onSubmit: (selectedOptions: List<String>, customText: String?) -> Unit,
    modifier: Modifier = Modifier,
) {
    val selectedOptions = remember { mutableStateListOf<String>() }
    var customText by remember { mutableStateOf("") }

    Card(
        modifier = modifier
            .fillMaxWidth()
            .padding(8.dp),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.4f)),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = "❓ Question from Agent",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.primary,
            )

            Text(
                text = question.prompt,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
            )

            // Optional detail markdown / plan review presentation
            val detail = question.detail
            if (!detail.isNullOrBlank()) {
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = MaterialTheme.colorScheme.surface,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        text = detail,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(8.dp),
                    )
                }
            }

            // Options (single or multi-select)
            if (question.options.isNotEmpty()) {
                Text(
                    text = if (question.multiSelect) "Select options:" else "Choose one option:",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.outline,
                )

                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    question.options.forEach { opt ->
                        val isSelected = selectedOptions.contains(opt.id)
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (question.multiSelect) {
                                Checkbox(
                                    checked = isSelected,
                                    onCheckedChange = { checked ->
                                        if (checked) selectedOptions.add(opt.id)
                                        else selectedOptions.remove(opt.id)
                                    },
                                )
                            } else {
                                FilterChip(
                                    selected = isSelected,
                                    onClick = {
                                        selectedOptions.clear()
                                        selectedOptions.add(opt.id)
                                    },
                                    label = { Text(opt.label) },
                                )
                            }
                            if (question.multiSelect) {
                                Text(
                                    text = opt.label,
                                    style = MaterialTheme.typography.bodySmall,
                                )
                            }
                        }
                    }
                }
            }

            // Custom free text input
            if (question.allowCustom) {
                OutlinedTextField(
                    value = customText,
                    onValueChange = { customText = it },
                    label = { Text("Your answer (optional if option selected)") },
                    modifier = Modifier.fillMaxWidth(),
                    shape = RoundedCornerShape(8.dp),
                    maxLines = 3,
                )
            }

            Button(
                onClick = {
                    onSubmit(selectedOptions.toList(), customText.ifBlank { null })
                },
                enabled = selectedOptions.isNotEmpty() || customText.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text("Submit Answer")
            }
        }
    }
}
