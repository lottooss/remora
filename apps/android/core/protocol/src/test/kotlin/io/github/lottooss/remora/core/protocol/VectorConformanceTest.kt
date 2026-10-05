package io.github.lottooss.remora.core.protocol

import com.google.common.truth.Truth.assertThat
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Test
import java.io.File

/**
 * Conformance vector consumer for RCP/1 and RLY/1 (task P7-V2). Decodes every
 * case under conformance/vectors/rcp and conformance/vectors/relay with the
 * :core:protocol codecs and agrees with the TypeScript consumer on valid and
 * invalid cases: valid cases decode to payloads carrying every field the case's
 * `expect` names, invalid cases are rejected with the case's stable error code.
 */
class VectorConformanceTest {

    private val conformanceDir by lazy {
        val path = System.getProperty("remora.conformance.dir") ?: "../../conformance"
        File(path).canonicalFile
    }

    private fun loadVector(relativePath: String): VectorFile {
        val doc = Json.parseToJsonElement(File(conformanceDir, "vectors/$relativePath").readText()).jsonObject
        val cases = doc["cases"]!!.jsonArray.map { case ->
            val obj = case.jsonObject
            VectorCase(
                name = obj["name"]!!.jsonPrimitive.content,
                input = obj["input"]!!.jsonObject,
                expect = obj["expect"],
                error = obj["error"]?.jsonPrimitive?.content,
            )
        }
        return VectorFile(suite = doc["suite"]!!.jsonPrimitive.content, cases = cases)
    }

    private class VectorFile(val suite: String, val cases: List<VectorCase>)
    private class VectorCase(val name: String, val input: JsonObject, val expect: JsonElement?, val error: String?)

    /** Subset match: every field named by [expected] must be present and equal. */
    private fun matchesExpect(decoded: JsonElement?, expected: JsonElement?): Boolean = when {
        expected is JsonObject -> decoded is JsonObject &&
            expected.entries.all { (key, value) -> decoded.containsKey(key) && matchesExpect(decoded[key], value) }
        expected is JsonArray -> decoded is JsonArray &&
            decoded.size == expected.size && expected.indices.all { matchesExpect(decoded[it], expected[it]) }
        else -> decoded == expected
    }

    private fun expectValid(case: VectorCase, decoded: JsonElement) {
        assertThat(matchesExpect(decoded, case.expect)).isTrue()
    }

    /** Runs one params/result/item/error method case against the Kotlin validators. */
    private fun runMethodCase(vector: VectorFile, case: VectorCase, method: String) {
        val direction = case.input["direction"]?.jsonPrimitive?.content
            ?: error("${vector.suite}/${case.name}: input.direction is required")
        val value = case.input.getValue("value")
        val decoded: JsonObject = try {
            when (direction) {
                "params" -> RcpPayloads.params(method, value)
                "result" -> RcpPayloads.result(method, value)
                "item" -> RcpPayloads.item(method, value)
                "error" -> RcpPayloads.error(value)
                else -> error("${vector.suite}/${case.name}: unknown direction $direction")
            }
        } catch (failure: RcpPayloadException) {
            assertThat(case.error).isNotNull()
            assertThat(failure.code).isEqualTo(case.error)
            return
        }
        assertThat(case.error).isNull()
        expectValid(case, decoded)
    }

    private fun ByteArray.toHex(): String = joinToString("") { ((it.toInt() and 0xff)).toString(16).padStart(2, '0') }

    private fun String.hexToBytes(): ByteArray = ByteArray(length / 2) { index ->
        ((this[index * 2].digitToInt(16) shl 4) or this[index * 2 + 1].digitToInt(16)).toByte()
    }

    @Test
    fun rcpMethodVectorsAgree() {
        val methodsDir = File(conformanceDir, "vectors/rcp/methods")
        val files = methodsDir.listFiles { file -> file.name.endsWith(".json") }.orEmpty().map { it.name }.sorted()
        assertThat(files).isNotEmpty()
        for (fileName in files) {
            val method = fileName.removeSuffix(".json")
            assertThat(RcpPayloads.metadata(method)).isNotNull()
            val vector = loadVector("rcp/methods/$fileName")
            for (case in vector.cases) runMethodCase(vector, case, method)
        }
    }

    @Test
    fun rcpEnvelopeVectorsAgree() {
        val vector = loadVector("rcp/envelope.json")
        for (case in vector.cases) {
            val value = case.input.getValue("value")
            val decoded: JsonObject = try {
                RcpPayloads.envelope(value)
            } catch (failure: RcpPayloadException) {
                assertThat(case.error).isEqualTo(failure.code)
                continue
            }
            assertThat(case.error).isNull()
            expectValid(case, decoded)
        }
    }

    @Test
    fun rcpSessionEventVectorsAgree() {
        val vector = loadVector("rcp/session-events.json")
        for (case in vector.cases) {
            val value = case.input.getValue("value")
            val decoded: JsonObject = try {
                RcpPayloads.sessionEvent(value)
            } catch (failure: RcpPayloadException) {
                assertThat(case.error).isEqualTo(failure.code)
                continue
            }
            assertThat(case.error).isNull()
            expectValid(case, decoded)
            // The typed codec agrees with the payload validator, including the
            // unknown-kind fallback (kind rewritten to "unknown").
            val event = RcpJson.decodeFromString(SessionEvent.serializer(), value.toString())
            assertThat(event.kind).isEqualTo(decoded["kind"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun rcpLimitVectorsAgree() {
        val vector = loadVector("rcp/limits.json")
        for (case in vector.cases) {
            val input = case.input
            val unit = input["unit"]!!.jsonPrimitive.content
            val repeat = input["repeat"]!!.jsonPrimitive.long.toInt()
            val padding = input["padding"]?.jsonPrimitive?.content ?: ""
            val message = """{"k":"req","id":1,"m":"sessions.prompt","p":{"text":"${unit.repeat(repeat)}$padding"}}"""
            val bytes = message.toByteArray(Charsets.UTF_8).size
            val expected = case.expect?.jsonObject?.get("bytes")?.jsonPrimitive?.long
            if (expected != null) {
                assertThat(bytes).isEqualTo(expected)
                assertThat(bytes).isAtMost(Limits.MAX_RCP_MESSAGE_BYTES)
            } else {
                assertThat(case.error).isEqualTo("too_large")
                assertThat(bytes).isGreaterThan(Limits.MAX_RCP_MESSAGE_BYTES)
            }
        }
    }

    @Test
    fun relayDataFrameVectorsAgree() {
        val vector = loadVector("relay/data-frame.json")
        for (case in vector.cases) {
            val bytes = case.input.getValue("hex").jsonPrimitive.content.hexToBytes()
            val decoded = try {
                decodeDataFrame(bytes)
            } catch (failure: DataFrameException) {
                assertThat(case.error).isNotNull()
                continue
            }
            assertThat(case.error).isNull()
            val expected = case.expect!!.jsonObject
            assertThat(decoded.version).isEqualTo(expected["version"]!!.jsonPrimitive.long.toInt())
            assertThat(decoded.type).isEqualTo(expected["type"]!!.jsonPrimitive.long.toInt())
            assertThat(decoded.channel).isEqualTo(expected["channel"]!!.jsonPrimitive.long)
            assertThat(decoded.peerKind.value).isEqualTo(expected["peerKind"]!!.jsonPrimitive.long.toInt())
            assertThat(decoded.peerId.toHex()).isEqualTo(expected["peerId"]!!.jsonPrimitive.content)
            assertThat(decoded.payload.toHex()).isEqualTo(expected["payload"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun relayControlFrameVectorsAgree() {
        for (relativePath in listOf("relay/control-frames.json", "relay/auth.json")) {
            val vector = loadVector(relativePath)
            for (case in vector.cases) {
                val value = case.input.getValue("value")
                val frame = try {
                    RelayJson.decodeFromString(ControlFrame.serializer(), value.toString())
                } catch (failure: Exception) {
                    assertThat(case.error).isNotNull()
                    continue
                }
                assertThat(case.error).isNull()
                val encoded = RelayJson.encodeToJsonElement(ControlFrame.serializer(), frame)
                expectValid(case, encoded)
            }
        }
    }
}
