// P0-S4 spike: Noise_IKpsk2_25519_ChaChaPoly_SHA256 over BouncyCastle.
// Throwaway JVM project — not part of the apps/android Gradle build (see docs/spikes/P0-S4.md).
plugins {
    kotlin("jvm") version "2.0.20"
}

group = "remora.spike"
version = "0.0.0"

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21)
    }
}

dependencies {
    implementation("org.bouncycastle:bcprov-jdk18on:1.77")
    testImplementation("junit:junit:4.13.2")
    // Tree API only (no compiler plugin): the vector runner parses the shared conformance JSON.
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.2")
}

// Shared cross-language vectors live at <repo>/conformance (see conformance/README.md).
tasks.test {
    useJUnit()
    testLogging {
        events("passed", "failed", "skipped")
    }
    systemProperty("remora.conformance.dir", rootProject.projectDir.resolve("../../../conformance").canonicalPath)
}

// Fat jar so the cross-language interop test can spawn the Kotlin initiator with `java -jar`.
tasks.jar {
    archiveFileName.set("p0-s4-noise-interop.jar")
    manifest {
        attributes["Main-Class"] = "remora.spike.noise.InteropInitiatorKt"
    }
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA")
    from({ configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) } })
}
