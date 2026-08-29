import java.io.FileInputStream
import java.util.Properties

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

// Release signing credentials.
//
// android/key.properties is gitignored and holds the keystore password. It is
// absent on a fresh clone and on CI, which is deliberate: a signing key that
// lives in the repository is not a signing key. When it is missing the release
// build falls back to debug keys below, so `flutter run --release` still works
// for anyone without it -- but such a build CANNOT be uploaded to Play.
//
// See android/key.properties.example for the four values and the keytool
// command that produces them.
val keystorePropertiesFile = rootProject.file("key.properties")
val keystoreProperties = Properties().apply {
    if (keystorePropertiesFile.exists()) {
        FileInputStream(keystorePropertiesFile).use { load(it) }
    }
}
val hasReleaseKeystore = keystorePropertiesFile.exists() &&
    keystoreProperties.getProperty("storeFile") != null

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

    signingConfigs {
        create("release") {
            if (hasReleaseKeystore) {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            // Real keys when key.properties is present; debug keys otherwise so
            // `flutter run --release` still works on a machine without the
            // keystore. Play rejects a debug-signed bundle outright, so the
            // fallback can never be mistaken for a shippable build.
            signingConfig = if (hasReleaseKeystore) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }

            // R8 strips unused code and resources. Flutter ships the rules its
            // own engine needs and each plugin contributes its own via
            // consumer-proguard files, so nothing here has to be hand-written.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }
}

// Fail loudly rather than shipping something unusable: a bundle is what gets
// uploaded to Play, and a debug-signed one is rejected on upload with an error
// that does not explain itself. Catching it here costs one line and saves the
// round trip.
// Checked once the task graph is known, so it fails in seconds rather than
// after Dart has finished compiling. assembleRelease is left alone: that is
// `flutter run --release`, which is a legitimate thing to do without a
// keystore. Only the bundle -- the artefact that gets uploaded -- is gated.
gradle.taskGraph.whenReady {
    val buildingBundle = allTasks.any { it.name == "bundleRelease" }
    if (buildingBundle && !hasReleaseKeystore) {
        throw GradleException(
            "\n\nRefusing to build a release bundle with debug keys — " +
                "Google Play rejects them on upload.\n\n" +
                "Create android/key.properties. See android/key.properties.example\n" +
                "for the four values it needs and the keytool command that makes\n" +
                "the keystore.\n"
        )
    }
}

dependencies {
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}

flutter {
    source = "../.."
}
