// Remora for Android — module graph and rules: docs/blueprint.md §10.2, AGENTS.md §7.5.
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
    alias(libs.plugins.hilt) apply false
    // Applied in :app only when the owner's git-ignored google-services.json exists (P5-K1).
    alias(libs.plugins.google.services) apply false
}

// Pure-JVM modules run their tests under the same task name as Android modules,
// so `./gradlew testDebugUnitTest` covers every module.
subprojects {
    plugins.withId("org.jetbrains.kotlin.jvm") {
        tasks.register("testDebugUnitTest") { dependsOn("test") }
    }
}

// Blueprint §10.2 dependency rule, enforced as a Gradle check: feature modules may
// depend only on :core:ui, :core:data and :core:model, and never on OkHttp, Room
// or Tink. The Keystore half of the rule (android.security.keystore only inside
// :core:security) is a source-review rule — see apps/android/README.md.
val forbiddenFeatureGroups = setOf(
    "com.squareup.okhttp3",
    "androidx.room",
    "androidx.room3",
    "com.google.crypto.tink",
)
val allowedFeatureProjects = setOf(":core:ui", ":core:data", ":core:model")

val checkModuleDependencyRules = tasks.register("checkModuleDependencyRules") {
    group = "verification"
    description = "Fails when a :feature:* module depends on projects or libraries outside blueprint §10.2."
    doLast {
        val violations = mutableListOf<String>()
        subprojects.filter { it.path.startsWith(":feature:") }.forEach { feature ->
            listOf("implementation", "api", "compileOnly", "runtimeOnly").forEach { configurationName ->
                feature.configurations.findByName(configurationName)?.dependencies?.forEach { dependency ->
                    if (dependency is ProjectDependency) {
                        val target = dependency.path
                        if (target !in allowedFeatureProjects) {
                            violations += "${feature.path} -> project($target); features may depend only on $allowedFeatureProjects"
                        }
                    } else if (dependency.group in forbiddenFeatureGroups) {
                        violations += "${feature.path} -> ${dependency.group}:${dependency.name}; forbidden in feature modules"
                    }
                }
            }
        }
        if (violations.isNotEmpty()) {
            throw GradleException("Module dependency rules violated:\n" + violations.joinToString("\n"))
        }
        logger.lifecycle("Module dependency rules OK")
    }
}

// The check joins each feature module's `check` lifecycle so CI catches violations.
subprojects.filter { it.path.startsWith(":feature:") }.forEach { feature ->
    feature.tasks.matching { it.name == "check" }.configureEach { dependsOn(checkModuleDependencyRules) }
}
