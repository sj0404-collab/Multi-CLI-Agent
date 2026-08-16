plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.uni.browser"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.uni.browser"
        minSdk = 24
        targetSdk = 34
        versionCode = 2
        versionName = "2.0.0"
    }

    signingConfigs {
        create("release") {
            // Keystore в корне репозитория. UNI_KEYSTORE передаётся из CI (абсолютный путь).
            val keystorePath = project.findProperty("UNI_KEYSTORE") as String?
                ?: rootProject.projectDir.parentFile.resolve("keystore/release.jks").absolutePath
            storeFile = file(keystorePath)
            storePassword = "multiagent123"
            keyAlias = "multiagent"
            keyPassword = "multiagent123"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.webkit:webkit:1.9.0")
}
