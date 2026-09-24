plugins {
    alias(libs.plugins.kotlin.jvm)
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) }
}

dependencies {
    implementation(libs.bouncycastle)
    testImplementation(libs.kotlinx.serialization.json)
    testImplementation(libs.junit)
    testImplementation(libs.truth)
}

// Shared cross-language vectors live at <repo>/conformance (see conformance/README.md).
tasks.test {
    systemProperty("remora.conformance.dir", rootProject.projectDir.resolve("../../conformance").canonicalPath)
}
