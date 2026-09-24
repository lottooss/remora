plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "io.github.lottooss.remora.core.data"
    compileSdk = libs.versions.compileSdk.get().toInt()
    defaultConfig { minSdk = libs.versions.minSdk.get().toInt() }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":core:model"))
    implementation(project(":core:transport"))
    implementation(project(":core:security"))
    testImplementation(libs.junit)
}
