// Fixture: Compose `placeholder = { ... }` parameters keep the word outside the
// quotes, so they are not string-literal stub findings (docs/tasks/P7-G3.md).

fun ComposeForm() {
    TextField(
        value = "",
        placeholder = { Text("Search sessions...") },
        onValueChange = {},
    )
}
