//! 构建门禁。
//!
//! ── 这里防的是什么 ──────────────────────────────────────
//! `carog build --release` 单独跑出来的 exe **能启动，但界面加载不出来**，
//! WebView 显示"没有网络连接"。原因是 Tauri 用 `custom-protocol` 这个 feature
//! 来判断自己是哪种形态（tauri crate 的 build.rs）：
//!
//! ```ignore
//! let custom_protocol = has_feature(&mut checked_features, "custom-protocol");
//! let dev = !custom_protocol;          // ← dev 完全由它决定
//! ```
//!
//! `dev = true` 时，`tauri::generate_context!`（tauri-macros/src/context.rs:155
//! 的 `dev: cfg!(not(feature = "custom-protocol"))`）会**不内嵌前端资源**，
//! 转而让 WebView 去加载 `tauri.conf.json` 里的 `devUrl`
//! —— 也就是 `http://localhost:5173`。没有 dev server 在跑，就是一个连不上的页面。
//!
//! 实测对照（本项目）：
//!   cargo build --release                              3.51 MB  无内嵌资源  连不上
//!   cargo build --release --features custom-protocol   5.75 MB  已内嵌资源  正常
//!
//! 官方约定是靠 `tauri build`（CLI 会自动加 `--features tauri/custom-protocol`）。
//! 但直接手敲 cargo 是很自然的动作，而失败方式**完全静默**：
//! 编译成功、没有警告，运行时才表现为一个网络错误页 —— 极易误判成网络问题。
//!
//! 所以这里把它变成构建期错误：宁可构建失败，也不交付一个打不开界面的 exe。

use std::env;

fn main() {
    gate_release_without_custom_protocol();
    tauri_build::build();
}

/// release 构建必须开 `custom-protocol`，否则前端口令会指向 devUrl。
///
/// 只拦 release：debug 构建（`tauri dev` / `cargo build`）本来就该走 devUrl，
/// 那是热更新的前提，不该被拦。
///
/// 注意这里读的是 cargo 传给构建脚本的 `CARGO_FEATURE_CUSTOM_PROTOCOL` ——
/// 它是本 crate 自己的 feature（`custom-protocol = ["tauri/custom-protocol"]`），
/// 开启时会自动转发给 tauri，不需要额外判断 tauri 那一侧。
fn gate_release_without_custom_protocol() {
    // PROFILE 对构建脚本必定可见（cargo 注入），取值只有 "debug" / "release"。
    let profile = env::var("PROFILE").unwrap_or_default();
    if profile != "release" {
        return;
    }

    if env::var_os("CARGO_FEATURE_CUSTOM_PROTOCOL").is_some() {
        return;
    }

    // 允许显式跳过：万一有人真的要构建一个"指向远程 devUrl"的版本
    // （比如把前端部署在别处），可以设这个环境变量放行。
    if env::var_os("AROPYT_ALLOW_DEV_URL_RELEASE").is_some() {
        println!("cargo:warning=已按 AROPYT_ALLOW_DEV_URL_RELEASE 跳过校验：本次 release 构建不会内嵌前端资源。");
        return;
    }

    panic!(
        "\n\n\
        ════════════════════════════════════════════════════════════════\n\
        release 构建禁用了默认 feature，产出的 exe 打不开界面。\n\
        \n\
        你显式传了 `--no-default-features`，它连同 `custom-protocol` 一起关掉了。\n\
        Tauri 的判定是 dev = !custom_protocol：没有这个 feature，\n\
        WebView 会去加载 devUrl（http://localhost:5173）而不是内嵌的前端资源，\n\
        于是显示“没有网络连接”。\n\
        \n\
        去掉那个参数即可 —— custom-protocol 已是默认 feature：\n\
          cargo build --release                      # 直接可用\n\
        或走 Tauri CLI（会顺带构建前端）：\n\
          npm run build:exe                          # 只要 exe\n\
          npm run build:installer                    # 带安装包\n\
        \n\
        确实需要一个不内嵌前端资源的 release 版本时，设\n\
          AROPYT_ALLOW_DEV_URL_RELEASE=1\n\
        显式放行。\n\
        ════════════════════════════════════════════════════════════════\n\n"
    );
}
