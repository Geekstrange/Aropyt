#!/usr/bin/env python3
"""
给 Tauri 生成的 Android Gradle 工程注入签名配置。

为什么在 CI 里注入而不是提交 gen/android/：
`src-tauri/gen/android/` 由 `tauri android init` 生成（内容随 Tauri 版本
变化），提交整个目录会把生成物带进仓库。按文档的做法，在 CI 上先 init
再打补丁，本地无需安装 Android SDK。

幂等：每段补丁带 AROPYT-SIGNING 标记，重复运行不会重复插入。
补丁内容与 test/GitHub打包apk.md 第 2 节一致。

用法：python3 scripts/patch-android-gradle.py [gradle文件路径]
"""
import io
import re
import sys

GRADLE = sys.argv[1] if len(sys.argv) > 1 else "src-tauri/gen/android/app/build.gradle.kts"
MARKER = "AROPYT-SIGNING"

# 用**完全限定名**（java.util.Properties 等）—— 不插任何 import。
# 原因：`tauri android init` 生成的模板**自带** import java.util.Properties，
# 再插一份就是 Conflicting import（实测）；而 FQN 与任何已有 import 无冲突。
IMPORT_SNIPPET = f"""
// {MARKER} keystore.properties（CI 解码 Secret 生成；本地可自行放置）
val keystoreProperties = java.util.Properties()
val keystorePropertiesFile = java.io.File(rootProject.file("keystore.properties").absolutePath)
if (keystorePropertiesFile.exists()) {{
    keystoreProperties.load(java.io.FileInputStream(keystorePropertiesFile))
}}
"""

SIGNING_SNIPPET = f"""
    // {MARKER} release 签名（keystore.properties 存在时生效）
    signingConfigs {{
        create("release") {{
            if (keystorePropertiesFile.exists()) {{
                storeFile = file(keystoreProperties["storeFile"] as String)
                storePassword = keystoreProperties["storePassword"] as String
                keyAlias = keystoreProperties["keyAlias"] as String
                keyPassword = keystoreProperties["keyPassword"] as String
            }}
        }}
    }}
"""

RELEASE_SIGNING = f"""
        // {MARKER} release 走签名配置
        signingConfig = signingConfigs.getByName("release")
"""

source = io.open(GRADLE, encoding="utf-8").read()

# 防御：清掉历史补丁插入的 Properties import（FQN 方案下不再需要）
if "import java.util.Properties" in source and "AROPYT-SIGNING keystore.properties" in source:
    before = source.count("import java.util.Properties")
    source = chr(10).join(l for l in source.split(chr(10)) if l.strip() != "import java.util.Properties" or before <= 1)
    print(f"import 清理：{before} → {source.count('import java.util.Properties')}")

# ① keystore.properties 定义：插在 plugins 块结束后
# 幂等条件查 snippet 的实际内容（val 定义），而不是 import —— 模板里
# 可能有同名 import，查 import 会被骗（实测两次：一次冲突一次漏插）
if "val keystoreProperties" not in source:
    m = re.search(r"plugins\s*\{[^}]*\}\n", source)
    assert m, "找不到 plugins 块"
    source = source[: m.end()] + IMPORT_SNIPPET + source[m.end() :]
    print("① 插入 keystoreProperties 读取")

# ② signingConfigs：插在 android { 之后
if "signingConfigs {" not in source:
    m = re.search(r"android\s*\{\n", source)
    assert m, "找不到 android 块"
    source = source[: m.end()] + SIGNING_SNIPPET + source[m.end() :]
    print("② 插入 signingConfigs")

# ③ buildTypes.release 使用签名：插在 getByName("release") { 之后
if re.search(r'getByName\("release"\)\s*\{[^}]*signingConfig', source, re.S) is None:
    m = re.search(r'getByName\("release"\)\s*\{\n', source)
    assert m, "找不到 buildTypes.release 块"
    source = source[: m.end()] + RELEASE_SIGNING + source[m.end() :]
    print("③ release 使用签名配置")

io.open(GRADLE, "w", encoding="utf-8").write(source)
print(f"patched {GRADLE}")
