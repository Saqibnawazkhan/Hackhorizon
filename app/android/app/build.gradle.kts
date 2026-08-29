plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // Must come after the Android plugin. Fails the build if
    // google-services.json is missing, which is the correct behaviour: a
    // build that silently ships without push is worse than one that stops.
    id("com.google.gms.google-services")
}

android {
    namespace = "com.agentflow.agentflow"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
        // flutter_local_notifications uses java.time, which only exists from
        // API 26. Desugaring back-ports it so the app still runs on older
        // devices instead of forcing minSdk up.
        isCoreLibraryDesugaringEnabled = true
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_11.toString()
    }

    defaultConfig {
        applicationId = "com.agentflow.agentflow"
        // flutter_local_notifications and firebase_messaging both require 23+.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
        // Debug builds pull in several plugins; without this the 64K method
        // limit is reached on older devices.
        multiDexEnabled = true
    }

    buildTypes {
        release {
            // TODO: replace with a real signing config before shipping.
            // Debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

flutter {
    source = "../.."
}
