package io.github.lottooss.remora.core.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.json.*

/** Current host workspace baseline, updated by workspaces.follow. */
class WorkspaceRepository {
    private val state = MutableStateFlow<List<Workspace>>(emptyList())
    val workspaces: StateFlow<List<Workspace>> = state.asStateFlow()
    fun clear() { state.value = emptyList() }
    fun apply(item: JsonObject) {
        when (item["type"]?.jsonPrimitive?.content) {
            "baseline" -> state.value = item.getValue("workspaces").jsonArray.map { parse(it.jsonObject) }
            "upsert" -> {
                val workspace = parse(item.getValue("workspace").jsonObject)
                state.value = state.value.filterNot { it.id == workspace.id } + workspace
            }
            "removed" -> state.value = state.value.filterNot { it.id == item.getValue("id").jsonPrimitive.content }
        }
    }
    private fun parse(obj: JsonObject) = Workspace(
        id = obj.getValue("id").jsonPrimitive.content,
        title = obj.getValue("title").jsonPrimitive.content,
        path = obj.getValue("path").jsonPrimitive.content,
        remoteAllowed = obj.getValue("remoteAllowed").jsonPrimitive.boolean,
    )
}
