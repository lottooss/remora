// Remora for Android — module graph and rules: docs/blueprint.md §10.2, AGENTS.md §7.5.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
}

// Pure-JVM modules run their tests under the same task name as Android modules,
// so `./gradlew testDebugUnitTest` covers every module.
subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        tasks.register("testDebugUnitTest") { dependsOn("test") }
    }
}
