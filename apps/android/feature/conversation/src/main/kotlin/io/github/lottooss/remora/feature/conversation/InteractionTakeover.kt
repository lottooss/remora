package io.github.lottooss.remora.feature.conversation

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import io.github.lottooss.remora.core.data.PendingApproval
import io.github.lottooss.remora.core.data.PendingQuestion
import io.github.lottooss.remora.core.data.QuestionAnswer

/** Uses the same complete preview in the conversation and approval inbox. */
@Composable
fun ApprovalTakeoverCard(
    approval: PendingApproval,
    onApprove: (approval: PendingApproval) -> Unit,
    onReject: (approval: PendingApproval) -> Unit,
    modifier: Modifier = Modifier,
) {
    ApprovalCard(
        approval = approval,
        onApprove = { onApprove(approval) },
        onReject = { onReject(approval) },
        modifier = modifier.padding(8.dp).heightIn(max = 480.dp).verticalScroll(rememberScrollState()),
    )
}

/** Displays every question in the request and returns RCP's structured answer list. */
@Composable
fun QuestionTakeoverCard(
    question: PendingQuestion,
    onSubmit: (answers: List<QuestionAnswer>) -> Unit,
    modifier: Modifier = Modifier,
) {
    val selections = remember(question) { mutableStateMapOf<String, List<String>>() }
    val customAnswers = remember(question) { mutableStateMapOf<String, String>() }
    val complete = question.questions.isNotEmpty() && question.questions.all {
        !selections[it.id].isNullOrEmpty() || !customAnswers[it.id].isNullOrBlank()
    }

    Card(modifier = modifier.fillMaxWidth().padding(8.dp).heightIn(max = 480.dp)) {
        Column(
            modifier = Modifier.verticalScroll(rememberScrollState()).padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(stringResource(R.string.interaction_questions_title), style = MaterialTheme.typography.titleSmall)
            question.questions.forEach { prompt ->
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    prompt.header?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
                    Text(prompt.question, style = MaterialTheme.typography.titleMedium)
                    prompt.detail?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
                    prompt.intent?.takeIf { it.kind == "plan-review" }?.let {
                        Text(stringResource(R.string.interaction_plan_approval, it.approve), style = MaterialTheme.typography.labelMedium)
                    }
                    prompt.options.forEach { option ->
                        val selected = selections[prompt.id].orEmpty()
                        Row(modifier = Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            if (prompt.multiSelect) {
                                Checkbox(
                                    checked = option.label in selected,
                                    onCheckedChange = { checked ->
                                        selections[prompt.id] = if (checked) (selected + option.label).distinct()
                                            else selected - option.label
                                    },
                                )
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(option.label)
                                    option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                }
                            } else {
                                FilterChip(
                                    selected = option.label in selected,
                                    onClick = { selections[prompt.id] = if (option.label in selected) emptyList() else listOf(option.label) },
                                    label = {
                                        Column {
                                            Text(option.label)
                                            option.description?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                                        }
                                    },
                                )
                            }
                        }
                    }
                    OutlinedTextField(
                        value = customAnswers[prompt.id].orEmpty(),
                        onValueChange = { customAnswers[prompt.id] = it },
                        label = { Text(stringResource(R.string.interaction_custom_answer)) },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 5,
                    )
                }
            }
            Button(
                onClick = {
                    onSubmit(question.questions.map { prompt ->
                        QuestionAnswer(prompt.id, selections[prompt.id].orEmpty(), customAnswers[prompt.id]?.takeIf { it.isNotBlank() })
                    })
                },
                enabled = complete && !question.isExpired,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.interaction_submit_answers))
            }
        }
    }
}
