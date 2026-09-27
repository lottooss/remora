plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "io.github.lottooss.remora.core.security"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":core:crypto"))
    implementation(libs.bouncycastle)
    implementation(libs.kotlinx.coroutines.core)
    implementation(libs.androidx.biometric)
    implementation(libs.tink.android)
    testImplementation(libs.junit)
    testImplementation(libs.truth)
}
