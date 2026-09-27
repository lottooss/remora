package io.github.lottooss.remora.core.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

private val DIFF_FONT_SIZE = 12.sp
private val DIFF_LINE_HEIGHT = 16.sp
private val SIDE_BY_SIDE_LINE_HEIGHT = 20.dp

/**
 * One parsed hunk of a unified diff. Mirrors the `core:data` model so callers
 * can hand over `DiffFileResult.hunks` without conversion.
 */
data class DiffHunk(val header: String, val lines: List<String>)

private enum class DiffLineKind { CONTEXT, ADDED, DELETED }

private sealed interface DiffRow {
    data class HunkHeader(val text: String) : DiffRow
    data class UnifiedLine(val text: String, val kind: DiffLineKind) : DiffRow
    data class ChangeBlock(val deleted: List<String>, val added: List<String>) : DiffRow
}

/**
 * Virtualized unified-diff renderer.
 *
 * Renders [hunks] (`@@ -a,b +c,d @@` headers, `+`/`-`/` ` line prefixes) in a
 * [LazyColumn] so diffs with thousands of lines scroll smoothly. Hunk headers
 * sit on a secondary-container background; added lines (`+`) carry a green
 * tint, deleted lines (`-`) a red tint, and context lines keep the default
 * background.
 *
 * When [isWideScreen] is true, change blocks render as two aligned panes
 * (deleted left, added right) instead of the unified column. When
 * [hasMoreHunks] is true (the caller has more hunks, e.g.
 * `DiffFileResult.nextHunk != null`), a "Load next hunk" button is appended
 * and invokes [onLoadMoreHunks] when pressed.
 */
@Composable
fun DiffView(
    hunks: List<DiffHunk>,
    modifier: Modifier = Modifier,
    onLoadMoreHunks: (() -> Unit)? = null,
    hasMoreHunks: Boolean = false,
    isWideScreen: Boolean = false,
) {
    val rows = remember(hunks, isWideScreen) {
        hunks.flatMap { hunk -> hunkToRows(hunk, isWideScreen) }
    }
    LazyColumn(modifier = modifier.fillMaxSize()) {
        itemsIndexed(rows, key = { index, _ -> index }) { _, row ->
            when (row) {
                is DiffRow.HunkHeader -> HunkHeaderRow(text = row.text)
                is DiffRow.UnifiedLine ->
                    UnifiedDiffLine(text = row.text, kind = row.kind)
                is DiffRow.ChangeBlock -> SideBySideChangeBlock(block = row)
            }
        }
        if (hasMoreHunks) {
            item(key = "load-next-hunk") {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(12.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    TextButton(onClick = { onLoadMoreHunks?.invoke() }) {
                        Text("Load next hunk")
                    }
                }
            }
        }
    }
}

private fun hunkToRows(hunk: DiffHunk, isWideScreen: Boolean): List<DiffRow> {
    val rows = mutableListOf<DiffRow>(DiffRow.HunkHeader(hunk.header))
    if (!isWideScreen) {
        hunk.lines.forEach { line ->
            rows += unifiedRow(line)
        }
        return rows
    }
    var index = 0
    while (index < hunk.lines.size) {
        val line = hunk.lines[index]
        when {
            line.startsWith("+") || line.startsWith("-") -> {
                val deleted = mutableListOf<String>()
                val added = mutableListOf<String>()
                while (index < hunk.lines.size && hunk.lines[index].startsWith("-")) {
                    deleted += hunk.lines[index]
                    index++
                }
                while (index < hunk.lines.size && hunk.lines[index].startsWith("+")) {
                    added += hunk.lines[index]
                    index++
                }
                rows += DiffRow.ChangeBlock(deleted, added)
            }
            else -> {
                rows += unifiedRow(line)
                index++
            }
        }
    }
    return rows
}

private fun unifiedRow(line: String): DiffRow.UnifiedLine = when {
    line.startsWith("+") -> DiffRow.UnifiedLine(line, DiffLineKind.ADDED)
    line.startsWith("-") -> DiffRow.UnifiedLine(line, DiffLineKind.DELETED)
    else -> DiffRow.UnifiedLine(line, DiffLineKind.CONTEXT)
}

@Composable
private fun HunkHeaderRow(text: String) {
    Text(
        text = text,
        fontFamily = FontFamily.Monospace,
        fontSize = DIFF_FONT_SIZE,
        fontWeight = FontWeight.Medium,
        color = MaterialTheme.colorScheme.onSecondaryContainer,
        modifier = Modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.secondaryContainer)
            .padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

@Composable
private fun UnifiedDiffLine(text: String, kind: DiffLineKind) {
    val background = when (kind) {
        DiffLineKind.ADDED -> Color(0x224CAF50)
        DiffLineKind.DELETED -> Color(0x22F44336)
        DiffLineKind.CONTEXT -> Color.Transparent
    }
    Row(modifier = Modifier.fillMaxWidth().background(background)) {
        DiffLineText(text = text, kind = kind, softWrap = true)
    }
}

@Composable
private fun SideBySideChangeBlock(block: DiffRow.ChangeBlock) {
    val lineCount = maxOf(block.deleted.size, block.added.size)
    Row(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.weight(1f)) {
            block.deleted.forEach { line ->
                SideBySideLine(text = line, kind = DiffLineKind.DELETED)
            }
            repeat(lineCount - block.deleted.size) {
                Spacer(modifier = Modifier.height(SIDE_BY_SIDE_LINE_HEIGHT))
            }
        }
        Box(
            modifier = Modifier
                .width(1.dp)
                .height(SIDE_BY_SIDE_LINE_HEIGHT * lineCount)
                .background(MaterialTheme.colorScheme.outlineVariant),
        )
        Column(modifier = Modifier.weight(1f)) {
            block.added.forEach { line ->
                SideBySideLine(text = line, kind = DiffLineKind.ADDED)
            }
            repeat(lineCount - block.added.size) {
                Spacer(modifier = Modifier.height(SIDE_BY_SIDE_LINE_HEIGHT))
            }
        }
    }
}

@Composable
private fun SideBySideLine(text: String, kind: DiffLineKind) {
    val background = when (kind) {
        DiffLineKind.ADDED -> Color(0x224CAF50)
        else -> Color(0x22F44336)
    }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(SIDE_BY_SIDE_LINE_HEIGHT)
            .background(background),
    ) {
        DiffLineText(text = text, kind = kind, softWrap = false)
    }
}

@Composable
private fun DiffLineText(text: String, kind: DiffLineKind, softWrap: Boolean) {
    Text(
        text = annotatedDiffLine(text, kind),
        fontFamily = FontFamily.Monospace,
        fontSize = DIFF_FONT_SIZE,
        lineHeight = DIFF_LINE_HEIGHT,
        softWrap = softWrap,
        maxLines = if (softWrap) Int.MAX_VALUE else 1,
        overflow = TextOverflow.Clip,
    )
}

private fun annotatedDiffLine(text: String, kind: DiffLineKind): AnnotatedString =
    buildAnnotatedString {
        if (text.isEmpty()) {
            append(" ")
            return@buildAnnotatedString
        }
        append(text)
        val signColor = when (kind) {
            DiffLineKind.ADDED -> Color(0xFF1E8E3E)
            DiffLineKind.DELETED -> Color(0xFFD93025)
            DiffLineKind.CONTEXT -> null
        }
        if (signColor != null) {
            addStyle(SpanStyle(color = signColor), 0, 1)
        }
    }

private val SAMPLE_HUNKS = listOf(
    DiffHunk(
        header = "@@ -1,7 +1,8 @@",
        lines = listOf(
            " package io.github.lottooss.remora",
            "",
            "-import fun old(name: String) {",
            "+import androidx.compose.runtime.Composable",
            "+",
            "+fun greet(name: String) {",
            "     // Say hello",
            "-    println(\"Hello, \$name\")",
            "+    println(\"Hello, \$name!\")",
            "+    check(name.isNotEmpty())",
            " }",
        ),
    ),
    DiffHunk(
        header = "@@ -10,4 +11,6 @@",
        lines = listOf(
            " fun main() {",
            "-    old(\"world\")",
            "+    greet(\"world\")",
            "+    greet(\"remora\")",
            "+    // done",
            " }",
        ),
    ),
)

@Preview(name = "Diff view unified", showBackground = true)
@Composable
private fun DiffViewPreview() {
    RemoraTheme {
        DiffView(hunks = SAMPLE_HUNKS, hasMoreHunks = true, onLoadMoreHunks = {})
    }
}

@Preview(name = "Diff view side by side", widthDp = 800, showBackground = true)
@Composable
private fun DiffViewSideBySidePreview() {
    RemoraTheme {
        DiffView(hunks = SAMPLE_HUNKS, isWideScreen = true)
    }
}
