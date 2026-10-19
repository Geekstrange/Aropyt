### 1. 填四个 GitHub Secrets

在仓库 `Settings → Secrets and variables → Actions → New repository secret`，逐个添加：

| Secret 名称 | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | 上一步复制的整行 Base64 字符串 |
| `ANDROID_KEYSTORE_PASSWORD` | 你刚才输入的 keystore 密码 |
| `ANDROID_KEY_ALIAS` | `aropyt-release` |
| `ANDROID_KEY_PASSWORD` | 你刚才输入的 key 密码（如果和 store 密码相同就填同一个） |

---

### 2. 配置 Gradle 签名

**先确认 Android 工程已生成**。如果还没跑过 `npm run tauri android init`，先执行一次，会在 `src-tauri/gen/android/` 下生成 Gradle 工程。

然后编辑 `src-tauri/gen/android/app/build.gradle.kts`，在 `plugins {}` 块之后、`android {}` 块之前加入：

```kotlin
import java.util.Properties
import java.io.FileInputStream

val keystoreProperties = Properties()
val keystorePropertiesFile = rootProject.file("keystore.properties")
if (keystorePropertiesFile.exists()) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}
```

在 `android {}` 块内部加入 `signingConfigs`，并让 `release` 构建类型使用它：

```kotlin
android {
    // ... 原有内容 ...

    signingConfigs {
        create("release") {
            if (keystorePropertiesFile.exists()) {
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }
        }
    }

    buildTypes {
        getByName("release") {
            signingConfig = signingConfigs.getByName("release")
            // ... 原有内容 ...
        }
    }
}
```

**把 `keystore.properties` 和 `release.keystore` 加入 `.gitignore`**（如果 Tauri 生成的 `.gitignore` 没覆盖到）：

```gitignore
src-tauri/gen/android/keystore.properties
src-tauri/gen/android/release.keystore
release.keystore
release.keystore.b64
```

> 注意：`src-tauri/gen/android/` 整个目录在 Tauri 2 中默认是被 `.gitignore` 掉的（由 CLI 生成），但你的 Gradle 修改如果只存在于本地、没提交，CI 里就没有这些改动。**需要确认 `src-tauri/gen/android/` 是否被跟踪**。如果被忽略，你有两个选择：① 把 `app/build.gradle.kts` 的修改通过 CI 步骤注入；② 取消忽略该目录并提交（推荐，Tauri 官方也支持提交 gen 目录以便自定义）。先跑 `git check-ignore -v src-tauri/gen/android/app/build.gradle.kts` 确认状态。

---