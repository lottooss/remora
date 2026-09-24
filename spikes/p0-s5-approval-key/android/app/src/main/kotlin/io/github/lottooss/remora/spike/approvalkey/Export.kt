package io.github.lottooss.remora.spike.approvalkey

import org.json.JSONArray
import org.json.JSONObject

/** One signature produced behind a BiometricPrompt, with latency evidence. */
data class SignatureRecord(
    val approvalId: String,
    val message: String,
    val sigB64u: String,
    val issuedAt: Long,
    val promptToSignMs: Long,
    val signOnlyMs: Long,
)

/** Phone-side export consumed by `node verify.mjs --json`. */
object ExportJson {
    const val VERSION = 1

    fun build(
        spkiB64u: String,
        deviceModel: String,
        deviceManufacturer: String,
        androidRelease: String,
        sdkInt: Int,
        keygen: CreateOutcome?,
        previewText: String,
        previewJson: String,
        observations: List<String>,
        results: List<SignatureRecord>,
    ): JSONObject {
        val device = JSONObject()
            .put("model", deviceModel)
            .put("manufacturer", deviceManufacturer)
            .put("androidRelease", androidRelease)
            .put("sdkInt", sdkInt)
            .put("keyAlias", ApprovalKeys.ALIAS)
            .put("strongBoxUsed", keygen?.strongBoxUsed ?: false)
            .put("strongBoxError", keygen?.strongBoxError ?: JSONObject.NULL)
            .put("keygenMs", keygen?.keygenMs ?: -1)
            .put(
                "attestation",
                JSONArray().apply {
                    (keygen?.chain ?: emptyList()).forEach { cert ->
                        put(
                            JSONObject()
                                .put("subject", cert.subject)
                                .put("issuer", cert.issuer)
                                .put("serial", cert.serial)
                                .put("notBefore", cert.notBefore)
                                .put("notAfter", cert.notAfter),
                        )
                    }
                },
            )

        val resultsJson = JSONArray()
        results.forEach { r ->
            resultsJson.put(
                JSONObject()
                    .put("approvalId", r.approvalId)
                    .put("message", r.message)
                    .put("sig", r.sigB64u)
                    .put("issuedAt", r.issuedAt)
                    .put("promptToSignMs", r.promptToSignMs)
                    .put("signOnlyMs", r.signOnlyMs),
            )
        }

        return JSONObject()
            .put("v", VERSION)
            .put("spki", spkiB64u)
            .put("device", device)
            .put(
                "preview",
                JSONObject().put("text", previewText).put("json", previewJson),
            )
            .put("observations", JSONArray().apply { observations.forEach { put(it) } })
            .put("results", resultsJson)
    }
}
