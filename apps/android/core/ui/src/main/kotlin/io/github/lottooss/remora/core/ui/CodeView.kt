package io.github.lottooss.remora.core.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.text.MatchResult

private const val PREFETCH_LINES = 5
private val CODE_FONT_SIZE = 12.sp
private val CODE_LINE_HEIGHT = 16.sp

private val KEYWORDS = setOf(
    "abstract", "as", "assert", "async", "await", "break", "by", "case", "catch",
    "class", "companion", "const", "constructor", "continue", "crossinline", "data",
    "def", "default", "del", "do", "dyn", "elif", "else", "enum", "extends",
    "false", "final", "finally", "fn", "for", "from", "fun", "function", "global",
    "goto", "if", "impl", "import", "in", "include", "infix", "init", "inline",
    "instanceof", "interface", "is", "lambda", "lateinit", "let", "macro", "mod",
    "move", "mut", "namespace", "new", "nil", "noinline", "nonlocal", "null",
    "object", "operator", "out", "override", "package", "pass", "private",
    "protected", "pub", "public", "ref", "reified", "return", "sealed", "self",
    "sizeof", "static", "struct", "super", "suspend", "switch", "tailrec", "this",
    "throw", "throws", "trait", "true", "try", "typealias", "typeof", "union",
    "using", "val", "var", "vararg", "void", "when", "where", "while", "yield",
    "None", "True", "False",
)

private val TOKEN_PATTERN = Regex(
    """(?<comment>//[^\n]*|/\*.*?\*/|#[^\n]*)""" +
        """|(?<string>"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`[^`]*`)""" +
        """|(?<annotation>@[A-Za-z_][\w.]*)""" +
        """|(?<number>\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlL]?\b|0[xX][0-9a-fA-F_]+)""" +
        """|(?<keyword>\b(?:${KEYWORDS.joinToString("|")})\b)""",
)

private data class SearchMatch(val line: Int, val start: Int)

/** Syntax and search highlight palette for [CodeView]; theme-aware by default. */
data class CodeColors(
    val keyword: Color,
    val comment: Color,
    val string: Color,
    val number: Color,
    val annotation: Color,
    val lineNumber: Color,
    val gutterBackground: Color,
    val matchBackground: Color,
    val currentMatchBackground: Color,
)

@Composable
fun rememberCodeColors(colorScheme: ColorScheme = MaterialTheme.colorScheme): CodeColors =
    remember(colorScheme) {
        CodeColors(
            keyword = colorScheme.primary,
            comment = Color(0xFF6E7781),
            string = Color(0xFF1E7A34),
            number = Color(0xFF8250DF),
            annotation = colorScheme.tertiary,
            lineNumber = colorScheme.onSurfaceVariant,
            gutterBackground = colorScheme.surfaceVariant.copy(alpha = 0.4f),
            matchBackground = Color(0x4DFFC107),
            currentMatchBackground = Color(0xFFFF9800),
        )
    }

/**
 * Virtualized source-code viewer (blueprint §10.6 monospace previews).
 *
 * Renders [text] in a [LazyColumn] so files with 20,000+ lines scroll smoothly.
 * Line numbers sit in a dimmed, unselectable gutter whose width fits the last
 * line number; [startLineNumber] offsets the first rendered number. [softWrap]
 * picks the initial layout: horizontal scroll per row, or text wrapping. The
 * magnifier opens an in-text search bar that highlights every match, shows
 * "current/total", and scrolls prev/next navigation into view. When
 * [onLoadMore] is non-null (caller has more content) and the viewport nears the
 * end of the loaded lines, the callback fires so the caller can append; a
 * spinner marks the pending tail.
 */
@Composable
fun CodeView(
    text: String,
    modifier: Modifier = Modifier,
    startLineNumber: Int = 1,
    softWrap: Boolean = false,
    searchQuery: String = "",
    onLoadMore: (() -> Unit)? = null,
    hasMore: Boolean = false,
) {
    var wrapOn by remember { mutableStateOf(softWrap) }
    var searchQuery by remember { mutableStateOf(searchQuery) }
    var currentMatch by remember { mutableIntStateOf(1) }
    val listState = rememberLazyListState()
    val horizontalScroll = rememberScrollState()
    val lines = remember(text) { text.lines() }
    val codeColors = rememberCodeColors()
    val searchMatches = remember(lines, searchQuery) { findMatches(lines, searchQuery) }
    val totalMatches = searchMatches.size
    val safeCurrentMatch = if (totalMatches == 0) 0 else currentMatch.coerceIn(1, totalMatches)
    val matchesByLine = remember(searchMatches) {
        val grouped = mutableMapOf<Int, MutableList<Pair<Int, Int>>>()
        searchMatches.forEachIndexed { ordinal, match ->
            grouped.getOrPut(match.line) { mutableListOf() } += ordinal to match.start
        }
        grouped
    }

    LaunchedEffect(searchQuery) { currentMatch = 1 }
    LaunchedEffect(safeCurrentMatch, searchMatches) {
        val match = searchMatches.getOrNull(safeCurrentMatch - 1)
        if (match != null) {
            listState.animateScrollToItem(match.line)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        CodeViewToolbar(
            wrapOn = wrapOn,
            onToggleWrap = { wrapOn = !wrapOn },
        )
        CodeSearchBar(
            query = searchQuery,
            onQueryChange = { searchQuery = it },
            current = safeCurrentMatch,
            total = totalMatches,
            onPrevious = {
                if (totalMatches > 0) {
                    currentMatch = if (safeCurrentMatch > 1) safeCurrentMatch - 1 else totalMatches
                }
            },
            onNext = {
                if (totalMatches > 0) {
                    currentMatch = if (safeCurrentMatch < totalMatches) safeCurrentMatch + 1 else 1
                }
            },
            onClose = { },
        )
        val gutterWidth = remember(lines.size, startLineNumber) {
            val last = startLineNumber + lines.size - 1
            (maxOf(2, last.toString().length) * 7 + 14).dp
        }
        LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            if (lines.isEmpty()) {
                item(key = "empty-file") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(32.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "Empty file",
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            itemsIndexed(lines, key = { index, _ -> index }) { index, line ->
                val lineMatches = matchesByLine[index].orEmpty()
                val syntax = remember(line, lineMatches, safeCurrentMatch, searchQuery, codeColors) {
                    highlightedLine(line, lineMatches, searchQuery.length, safeCurrentMatch, codeColors)
                }
                CodeLineRow(
                    lineNumber = startLineNumber + index,
                    gutterWidth = gutterWidth,
                    syntax = syntax,
                    softWrap = wrapOn,
                    horizontalScroll = horizontalScroll,
                    colors = codeColors,
                )
            }
            if (hasMore) {
                item(key = "load-more-footer") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(12.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        TextButton(onClick = { onLoadMore?.invoke() }) {
                            Text("Load more lines")
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun CodeViewToolbar(
    wrapOn: Boolean,
    onToggleWrap: () -> Unit,
    searchVisible: Boolean,
    onToggleSearch: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Spacer(modifier = Modifier.weight(1f))
        IconButton(onClick = onToggleSearch) {
            Icon(
                imageVector = Icons.Filled.Search,
                contentDescription = if (searchVisible) "Hide search" else "Search code",
            )
        }
        TextButton(onClick = onToggleWrap) {
            Text(
                text = if (wrapOn) "Wrap: on" else "Wrap: off",
                color = if (wrapOn) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                },
            )
        }
    }
}

@Composable
private fun CodeSearchBar(
    query: String,
    onQueryChange: (String) -> Unit,
    current: Int,
    total: Int,
    onPrevious: () -> Unit,
    onNext: () -> Unit,
    onClose: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 8.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextField(
            value = query,
            onValueChange = onQueryChange,
            modifier = Modifier.weight(1f),
            placeholder = { Text("Search code") },
            singleLine = true,
            leadingIcon = {
                Icon(imageVector = Icons.Filled.Search, contentDescription = null)
            },
            textStyle = TextStyle(
                fontFamily = FontFamily.Monospace,
                fontSize = 14.sp,
            ),
        )
        IconButton(onClick = onPrevious) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowUp,
                contentDescription = "Previous match",
            )
        }
        IconButton(onClick = onNext) {
            Icon(
                imageVector = Icons.Filled.KeyboardArrowDown,
                contentDescription = "Next match",
            )
        }
        Text(
            text = if (query.isEmpty()) "" else "$current/$total",
            style = MaterialTheme.typography.labelSmall,
            modifier = Modifier.padding(horizontal = 4.dp),
        )
        IconButton(onClick = onClose) {
            Icon(imageVector = Icons.Filled.Clear, contentDescription = "Close search")
        }
    }
}

@Composable
private fun CodeLineRow(
    lineNumber: Int,
    gutterWidth: Dp,
    syntax: AnnotatedString,
    softWrap: Boolean,
    horizontalScroll: ScrollState,
    colors: CodeColors,
) {
    Row(modifier = Modifier.fillMaxWidth()) {
        DisableSelection {
            Text(
                text = lineNumber.toString(),
                fontFamily = FontFamily.Monospace,
                fontSize = CODE_FONT_SIZE,
                color = colors.lineNumber,
                textAlign = TextAlign.End,
                modifier = Modifier
                    .width(gutterWidth)
                    .background(colors.gutterBackground)
                    .padding(end = 12.dp, start = 4.dp),
            )
        }
        Text(
            text = syntax,
            fontFamily = FontFamily.Monospace,
            fontSize = CODE_FONT_SIZE,
            lineHeight = CODE_LINE_HEIGHT,
            softWrap = softWrap,
            modifier = Modifier
                .weight(1f)
                .then(if (softWrap) Modifier else Modifier.horizontalScroll(horizontalScroll)),
        )
    }
}

private fun findMatches(lines: List<String>, query: String): List<SearchMatch> {
    if (query.isEmpty()) {
        return emptyList()
    }
    val matches = mutableListOf<SearchMatch>()
    lines.forEachIndexed { lineIndex, line ->
        var from = 0
        while (from + query.length <= line.length) {
            val at = line.indexOf(query, from)
            if (at < 0) {
                break
            }
            matches += SearchMatch(lineIndex, at)
            from = at + query.length
        }
    }
    return matches
}

private fun highlightedLine(
    line: String,
    matchesOnLine: List<Pair<Int, Int>>,
    queryLength: Int,
    currentOrdinal: Int,
    colors: CodeColors,
): AnnotatedString = buildAnnotatedString {
    append(line)
    TOKEN_PATTERN.findAll(line).forEach { match ->
        addStyle(spanStyleFor(match, colors), match.range.first, match.range.last + 1)
    }
    if (queryLength > 0) {
        matchesOnLine.forEach { (start, ordinal) ->
            val background = if (ordinal + 1 == currentOrdinal) {
                colors.currentMatchBackground
            } else {
                colors.matchBackground
            }
            addStyle(
                SpanStyle(background = background),
                start,
                (start + queryLength).coerceAtMost(line.length),
            )
        }
    }
}

private fun spanStyleFor(match: MatchResult, colors: CodeColors): SpanStyle = when {
    match.groups["comment"] != null ->
        SpanStyle(color = colors.comment, fontStyle = FontStyle.Italic)
    match.groups["string"] != null -> SpanStyle(color = colors.string)
    match.groups["annotation"] != null -> SpanStyle(color = colors.annotation)
    match.groups["number"] != null -> SpanStyle(color = colors.number)
    else -> SpanStyle(color = colors.keyword, fontWeight = FontWeight.Medium)
}

private const val SAMPLE_CODE = """package io.github.lottooss.remora

import androidx.compose.runtime.Composable

// Renders source code with syntax highlighting (2.0x scale).
@Composable
fun greet(name: String, count: Int = 3) {
    val message = "Hello, ${'$'}name!".repeat(count)
    /* Multi-line comment
       spanning lines */
    check(count >= 0) { "negative count" }
    for (i in 0 until count) {
        println("# ${'$'}i of 0x0F: ${'$'}message")  // trailing comment
    }
}
"""

@Preview(name = "Code view", showBackground = true)
@Composable
private fun CodeViewPreview() {
    RemoraTheme {
        CodeView(text = SAMPLE_CODE)
    }
}

@Preview(name = "Code view with search", showBackground = true)
@Composable
private fun CodeViewSearchPreview() {
    RemoraTheme {
        CodeView(
            text = SAMPLE_CODE,
            softWrap = true,
            searchOpen = true,
            initialSearchQuery = "fun",
        )
    }
}

@Preview(name = "Code view with pagination footer", showBackground = true)
@Composable
private fun CodeViewPaginationPreview() {
    RemoraTheme {
        CodeView(text = SAMPLE_CODE, startLineNumber = 41, onLoadMore = {})
    }
}
