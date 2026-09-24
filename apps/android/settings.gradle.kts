pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "remora-android"

include(":app")
include(":core:model", ":core:protocol", ":core:crypto", ":core:transport")
include(":core:security", ":core:data", ":core:ui")
include(":feature:pairing", ":feature:sessions", ":feature:conversation")
include(":feature:workspace", ":feature:files", ":feature:settings")
