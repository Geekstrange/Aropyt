//! WebDAV 客户端。
//!
//! 只实现"同步一个目录"真正需要的五个动作：
//! `PROPFIND`（列目录 / 测连接）、`GET`（读）、`PUT`（写）、`HEAD`（判存在）。
//! 不做 LOCK / MOVE / COPY —— 单人单机同步用不到，而它们每一个都要额外
//! 处理锁令牌生命周期。
//!
//! ── 两个刻意的选择 ──────────────────────────────────────────
//! 1. **不引入 XML 库**。WebDAV 的 `multistatus` 结构固定，`<href>` /
//!    `<getcontentlength>` 都是纯文本叶子节点；一个通用 XML 解析器要为
//!    "任意文档"负责，而这里只需要在两三个固定标签上取值。
//! 2. **命名空间前缀一律忽略**。RFC 4918 不规定前缀，`D:` / `d:` /
//!    `lp1:` / `ns0:` 全都是合法的 —— 前缀只是文档内的别名，不是语义。
//!    按前缀匹配等于把服务端的实现细节写进解码器。
//!
//! ── 只按协议办事 ────────────────────────────────────────────
//! 这里没有任何针对某个服务商的适配分支：不带厂商猜测、不按域名特判、
//! 也没有"某家网盘需要额外 header"的例外。需要的属性用 PROPFIND 显式要，
//! 目录用 MKCOL 建，跨目录移动用 PUT + DELETE —— RFC 4918 把这四件事定义
//! 清楚了，按它写就能连上任何合规实现。
//!
//! ── 为什么所有命令都收一个 `DavAuth` 参数 ──────────────────
//! 凭据不进 `settings.jsonc`（纯文本，会被截图、会被扔进 dotfiles 仓库），
//! 也不在 Rust 侧做全局缓存 —— 那会让"改密码后旧凭据还在内存里"变成
//! 一个需要主动清理的状态。调用方每次把凭据传进来，进程退出就没了。

use serde::{Deserialize, Serialize};

/* ── base64 ──────────────────────────────────────────────── */

/// 标准 base64（带 `=` 填充、无换行）。
///
/// 自实现而不是加依赖：Basic Auth 只需要编码，为 25 行代码引入一个
/// 编译单元不划算。
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 0x3f] as char);
        out.push(TABLE[(triple >> 12) as usize & 0x3f] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 0x3f] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 0x3f] as char
        } else {
            '='
        });
    }
    out
}

/* ── 数据结构 ────────────────────────────────────────────── */

/// 连接参数。`url` 是服务根（例如 `https://dav.jianguoyun.com/dav/`）。
#[derive(Debug, Clone, Deserialize)]
pub struct DavAuth {
    pub url: String,
    pub username: String,
    pub password: String,
}

/// 远端条目。
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DavEntry {
    /// 服务端返回的 `href`，原样保留。
    ///
    /// 不做 URL 解码、不裁剪前缀：RFC 4918 允许 `href` 是绝对 URL，也允许
    /// 是绝对路径，两种都合法。在这里猜"哪一段是相对路径"必然有猜错的一天。
    /// 谁要用谁按自己的 `base_url` 去裁。
    pub href: String,
    pub is_dir: bool,
    pub size: u64,
    /// `getlastmodified` 的原文（RFC 1123 日期）。
    ///
    /// 原样返回而不是转成时间戳：同步判定以**内容哈希**为准，时间只作
    /// 辅助信息，不值得为它引入一个日期库；调用方那边的 `Date.parse`
    /// 本来就能读这个格式。
    pub modified: Option<String>,
}

/* ── 协议层 ──────────────────────────────────────────────── */

/// 拼接 `base_url` 与相对路径，保证中间只有一个斜杠。
fn join_url(base: &str, path: &str) -> String {
    let base = base.trim_end_matches('/');
    let path = path.trim_start_matches('/');
    if path.is_empty() {
        format!("{base}/")
    } else {
        format!("{base}/{path}")
    }
}

/// 发一个 WebDAV 请求，返回 `(状态码, 响应正文)`。
///
/// 4xx / 5xx 不当成"传输失败"处理：PROPFIND 的 207 与 404 都是有意义的
/// 答案，调用方要能看见状态码自己判断。只有连不上才算错误。
fn dav_call(
    method: &str,
    url: &str,
    auth: &DavAuth,
    depth: Option<&str>,
    body: Option<&str>,
) -> Result<(u16, String), String> {
    let token = base64_encode(format!("{}:{}", auth.username, auth.password).as_bytes());
    let mut request = ureq::request(method, url).set("Authorization", &format!("Basic {token}"));
    if let Some(depth) = depth {
        request = request.set("Depth", depth);
    }

    let result = match body {
        Some(text) => request.send_string(text),
        None => request.call(),
    };

    match result {
        Ok(response) => {
            let status = response.status();
            Ok((status, response.into_string().unwrap_or_default()))
        }
        Err(ureq::Error::Status(status, response)) => {
            let text = response.into_string().unwrap_or_default();
            Ok((status, text))
        }
        Err(ureq::Error::Transport(error)) => Err(format!("无法连接到服务器：{error}")),
    }
}

/// 把 XML 里某个标签的文本取出来，**忽略命名空间前缀**。
///
/// 只认叶子节点（`<D:href>/dav/notes.md</D:href>`），带属性的容器标签
/// 不经过这里。
fn inner_text(block: &str, name: &str) -> Option<String> {
    let with_ns = format!(":{name}>");
    let without_ns = format!("<{name}>");
    let start = block
        .find(&with_ns)
        .map(|index| index + with_ns.len())
        .or_else(|| block.find(&without_ns).map(|index| index + without_ns.len()))?;
    let rest = &block[start..];
    let end = rest.find('<')?;
    Some(rest[..end].to_string())
}

/// 按 `<…:response>` 切出每条记录的 XML 块。
///
/// WebDAV 的 response 不嵌套，所以"下一个 `</`"就是它的结束。这个前提
/// 一旦不成立（有人往里塞嵌套的 response），切出来的块会偏大 —— 那也只会
/// 让解析结果多出重复项，不会 panic。
fn response_blocks(xml: &str) -> Vec<&str> {
    const MARK: &str = ":response>";

    /*
     * 先收集所有 `<…:response>` 的**结束位置**，再两两切片。
     *
     * 不用"从开标签往后找 `</`"的写法：那样第一个命中的是 `</D:href>`，
     * 块会被切成半截（实测：两条都变成空块，断言全红）。
     * 用"下一条 response 之前"作为边界，既简单又不依赖闭合标签的前缀。
     */
    let mut starts = Vec::new();
    let mut cursor = 0;
    while let Some(offset) = xml[cursor..].find(MARK) {
        let position = cursor + offset + MARK.len();
        starts.push(position);
        cursor = position;
    }

    let mut blocks = Vec::new();
    for (index, &start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(xml.len());
        blocks.push(&xml[start..end]);
    }
    blocks
}

/// 解析 PROPFIND 的 `multistatus` 响应。
pub fn parse_multistatus(xml: &str) -> Vec<DavEntry> {
    let mut entries = Vec::new();
    for block in response_blocks(xml) {
        let Some(href) = inner_text(block, "href") else {
            continue;
        };
        let href = href.trim().to_string();
        if href.is_empty() {
            continue;
        }
        /* 目录用 `<D:collection/>` 标记，前缀同样忽略 */
        let is_dir = block.contains(":collection") || block.contains("<collection");
        let size = inner_text(block, "getcontentlength")
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(0);
        let modified = inner_text(block, "getlastmodified").map(|value| value.trim().to_string());
        entries.push(DavEntry {
            href,
            is_dir,
            size,
            modified,
        });
    }
    entries
}

/* ── Tauri 命令 ──────────────────────────────────────────── */

/// 测连接：对服务根做一次 Depth 0 的 PROPFIND。
///
/// 返回服务端的 `Server` 之类的信息没必要 —— 成功就是成功，失败要带原因。
/// 建目录（MKCOL）。
///
/// RFC 4918 §9.3.1：新建成功返回 **201**，目录已存在返回 **405**。
/// 两者对同步都是"这个目录在了"，所以都算成功 —— 否则每次同步前都要先
/// PROPFIND 一遍确认目录存在，白白多一次往返。
///
/// 不递归建父目录：协议本身也不支持，而且同步逻辑是自顶向下走的，
/// 走到子目录时父目录必然已经建好。
fn create_dir(auth: &DavAuth, path: &str) -> Result<(), String> {
    let url = join_url(&auth.url, path);
    let (status, body) = dav_call("MKCOL", &url, auth, None, None)?;
    match status {
        201 | 405 => Ok(()),
        200..=299 => Ok(()),
        _ => Err(describe_status(status, &body)),
    }
}

/// 删远端的一个文件或目录。
///
/// RFC 4918 §9.6：成功是 **204 No Content**（也允许 200）。对目录的 DELETE
/// 是**递归**的（服务端按 Depth: infinity 处理），所以调用方必须清楚自己
/// 传的是文件还是目录。
///
/// 两条宽容都是有意的：
///  · **404 视为成功** —— 同步时"远端已经没有它了"与"刚被删掉"是同一个
///    目标状态，报错只会让同步卡在一个已解决的问题上；
///  · 拒绝删除服务根本身 —— 空路径经过 `join_url` 会变成 `base/`，
///    一次手滑就能清空整个同步目录。
fn delete_entry(auth: &DavAuth, path: &str) -> Result<(), String> {
    if path.trim_matches('/').is_empty() {
        return Err("拒绝删除服务根目录".to_string());
    }

    let url = join_url(&auth.url, path);
    let (status, body) = dav_call("DELETE", &url, auth, None, None)?;
    match status {
        200..=204 => Ok(()),
        404 => Ok(()),
        _ => Err(describe_status(status, &body)),
    }
}

/* 每个命令都拆成「同步实现 + async 包装」：同步那份才测得了（见文件末尾
 * 的假服务测试），Tauri 只需要一层 spawn_blocking。 */

fn test_connection(auth: &DavAuth) -> Result<String, String> {
    let url = join_url(&auth.url, "");
    let (status, body) = dav_call("PROPFIND", &url, auth, Some("0"), Some(PROPFIND_BODY))?;
    if status == 207 || status == 200 {
        return Ok(format!("HTTP {status}"));
    }
    Err(describe_status(status, &body))
}

fn list_dir(auth: &DavAuth, path: &str) -> Result<Vec<DavEntry>, String> {
    let url = join_url(&auth.url, path);
    let (status, body) = dav_call("PROPFIND", &url, auth, Some("1"), Some(PROPFIND_BODY))?;
    if status != 207 && status != 200 {
        return Err(describe_status(status, &body));
    }
    Ok(parse_multistatus(&body))
}

fn get_file(auth: &DavAuth, path: &str) -> Result<Option<String>, String> {
    let url = join_url(&auth.url, path);
    let (status, body) = dav_call("GET", &url, auth, None, None)?;
    match status {
        200 => Ok(Some(body)),
        404 => Ok(None),
        _ => Err(describe_status(status, &body)),
    }
}

fn put_file(auth: &DavAuth, path: &str, content: &str) -> Result<(), String> {
    let url = join_url(&auth.url, path);
    let (status, body) = dav_call("PUT", &url, auth, None, Some(content))?;
    if (200..300).contains(&status) {
        return Ok(());
    }
    Err(describe_status(status, &body))
}

fn head_file(auth: &DavAuth, path: &str) -> Result<Option<DavEntry>, String> {
    let url = join_url(&auth.url, path);
    let (status, body) = dav_call("HEAD", &url, auth, None, None)?;
    match status {
        404 => Ok(None),
        200..=299 =>         Ok(Some(DavEntry {
            href: path.to_string(),
            is_dir: false,
            /* HEAD 不返回 body，大小要另取；需要大小时用 dav_list 的结果 */
            size: 0,
            modified: None,
        })),
        _ => Err(describe_status(status, &body)),
    }
}

/// 测连接（Depth 0 的 PROPFIND）。
#[tauri::command]
pub async fn dav_test(auth: DavAuth) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || test_connection(&auth))
        .await
        .map_err(|error| format!("探测线程异常：{error}"))?
}

/// 列目录（Depth 1）。返回服务端原始顺序，排序交给调用方。
#[tauri::command]
pub async fn dav_list(auth: DavAuth, path: String) -> Result<Vec<DavEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || list_dir(&auth, &path))
        .await
        .map_err(|error| format!("列目录线程异常：{error}"))?
}

/// 读一个文本文件。不存在返回 `Ok(None)` —— 那是同步的正常分支，
/// 不该让调用方区分"没这个文件"和"服务器挂了"。
#[tauri::command]
pub async fn dav_get(auth: DavAuth, path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || get_file(&auth, &path))
        .await
        .map_err(|error| format!("下载线程异常：{error}"))?
}

/// 写一个文本文件。父目录不存在时服务端会拒绝；这里不自动建目录 ——
/// 目录结构由同步逻辑维护，它知道哪些目录该存在。
#[tauri::command]
pub async fn dav_put(auth: DavAuth, path: String, content: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || put_file(&auth, &path, &content))
        .await
        .map_err(|error| format!("上传线程异常：{error}"))?
}

/// 看远端文件在不在。用于同步前比对。
#[tauri::command]
pub async fn dav_head(auth: DavAuth, path: String) -> Result<Option<DavEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || head_file(&auth, &path))
        .await
        .map_err(|error| format!("探测线程异常：{error}"))?
}

/// 建目录。已存在视为成功（见 `create_dir` 的注释）。
#[tauri::command]
pub async fn dav_mkcol(auth: DavAuth, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || create_dir(&auth, &path))
        .await
        .map_err(|error| format!("建目录线程异常：{error}"))?
}

/// 删文件或目录（目录是递归删，见 `delete_entry`）。
#[tauri::command]
pub async fn dav_delete(auth: DavAuth, path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || delete_entry(&auth, &path))
        .await
        .map_err(|error| format!("删除线程异常：{error}"))?
}

/// PROPFIND 的请求体：只要 `getcontentlength` 和 `resourcetype`。
///
/// 也可以用 `allprop`，但那会把服务端**所有**属性都返回，绝大多数用不上，
/// 响应体可能几十 KB。要什么写什么。
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:resourcetype/>
    <d:getcontentlength/>
  </d:prop>
</d:propfind>"#;

/// 把状态码翻译成能读的话。
///
/// 只解释协议含义，不猜具体服务商的行为：`401` 就是认证没通过，至于该用
/// 登录密码还是应用专用密码，那是服务端的规定，客户端无从得知。
fn describe_status(status: u16, body: &str) -> String {
    let hint = match status {
        401 => "认证失败：服务端拒绝了这组凭据（部分服务要求应用专用密码）",
        403 => "没有权限：这个账号可能不允许 WebDAV 访问",
        404 => "路径不存在",
        405 => "服务端不接受这个请求方法（可能不是 WebDAV 端点）",
        409 => "目标目录不存在",
        507 => "云端空间不足",
        _ => "请求失败",
    };
    let detail = body.trim();
    if detail.is_empty() {
        format!("{hint}（HTTP {status}）")
    } else {
        format!(
            "{hint}（HTTP {status}）：{}",
            detail.chars().take(300).collect::<String>()
        )
    }
}

/* ── 测试 ────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        /* 中文用户名 / 密码：必须先按 UTF-8 编码再 base64 */
        assert_eq!(base64_encode("a:b".as_bytes()), "YTpi");
    }

    #[test]
    fn join_url_keeps_one_slash() {
        assert_eq!(join_url("https://x/dav/", ""), "https://x/dav/");
        assert_eq!(join_url("https://x/dav", "notes/a.md"), "https://x/dav/notes/a.md");
        assert_eq!(join_url("https://x/dav/", "/notes/a.md"), "https://x/dav/notes/a.md");
    }

    #[test]
    fn parses_typical_multistatus() {
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/notes.md</D:href>
    <D:propstat><D:prop><D:resourcetype/><D:getcontentlength>1234</D:getcontentlength><D:getlastmodified>Wed, 15 Nov 1995 04:58:08 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;
        let entries = parse_multistatus(xml);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].href, "/dav/");
        assert!(entries[0].is_dir);
        assert_eq!(entries[0].size, 0, "目录没有 getcontentlength");
        assert_eq!(entries[1].href, "/dav/notes.md");
        assert!(!entries[1].is_dir);
        assert_eq!(entries[1].size, 1234);
        assert_eq!(
            entries[1].modified.as_deref(),
            Some("Wed, 15 Nov 1995 04:58:08 GMT"),
            "getlastmodified 原样返回"
        );
    }

    #[test]
    fn parses_lowercase_namespace_prefix() {
        /* 前缀由服务端自定：RFC 4918 只要求它是合法的 XML 命名空间前缀 */
        let xml = r#"<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/a.md</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response></d:multistatus>"#;
        let entries = parse_multistatus(xml);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].href, "/dav/a.md");
        assert!(!entries[0].is_dir);
        assert_eq!(entries[0].size, 0, "没有 getcontentlength 时退化为 0");
    }

    #[test]
    fn survives_garbage() {
        assert!(parse_multistatus("").is_empty());
        assert!(parse_multistatus("<html>404</html>").is_empty());
    }

    #[test]
    fn status_hints_are_actionable() {
        /* 文案只解释协议含义（认证没通过），不猜具体服务商的规定 */
        assert!(describe_status(401, "").contains("认证失败"));
        assert!(describe_status(507, "").contains("空间不足"));
        assert!(describe_status(405, "").contains("WebDAV"));
    }

    /* ── 端到端：起一个只回一次响应的假 WebDAV 服务 ── */

    fn spawn_fake_server(
        status_line: &'static str,
        body: &'static str,
    ) -> (u16, std::thread::JoinHandle<(String, String, String)>) {
        use std::io::{BufRead, BufReader, Read, Write};
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").expect("绑定失败");
        let port = listener.local_addr().unwrap().port();

        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept 失败");
            let mut reader = BufReader::new(stream.try_clone().unwrap());

            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();

            let mut auth = String::new();
            let mut depth = String::new();
            let mut length = 0usize;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line.trim().is_empty() {
                    break;
                }
                let lower = line.to_ascii_lowercase();
                if lower.starts_with("authorization:") {
                    auth = line.trim().to_string();
                } else if lower.starts_with("depth:") {
                    depth = line.trim().to_string();
                } else if lower.starts_with("content-length:") {
                    length = line
                        .split(':')
                        .nth(1)
                        .and_then(|value| value.trim().parse().ok())
                        .unwrap_or(0);
                }
            }
            /* 必须把请求体读掉：不读会让客户端在 write 上等 */
            if length > 0 {
                let mut sink = vec![0u8; length];
                let _ = reader.read_exact(&mut sink);
            }

            let response = format!(
                "{status_line}\r\nContent-Type: application/xml\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(response.as_bytes());
            (request_line.trim().to_string(), auth, depth)
        });

        (port, handle)
    }

    #[test]
    fn propfind_request_carries_auth_and_depth() {
        let xml = r#"<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/notes.md</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontentlength>42</D:getcontentlength></D:prop></D:propstat></D:response></D:multistatus>"#;
        let (port, server) = spawn_fake_server("HTTP/1.1 207 Multi-Status", xml);

        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "user".to_string(),
            password: "pass".to_string(),
        };
        let entries = list_dir(&auth, "").expect("列目录失败");
        let (request_line, auth_header, depth) = server.join().expect("服务线程崩溃");

        assert!(request_line.starts_with("PROPFIND /dav/"), "请求行：{request_line}");
        assert!(
            auth_header.to_ascii_lowercase().starts_with("authorization: basic "),
            "认证头：{auth_header}"
        );
        /* base64("user:pass") —— 大小写敏感，不能用 lowercase 比 */
        assert!(auth_header.ends_with("dXNlcjpwYXNz"), "认证头：{auth_header}");
        assert_eq!(depth.to_ascii_lowercase(), "depth: 1");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].href, "/dav/notes.md");
        assert_eq!(entries[0].size, 42);
    }

    #[test]
    fn unauthorized_reports_actionable_message() {
        let (port, server) =
            spawn_fake_server("HTTP/1.1 401 Unauthorized", "error: password required");
        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "user".to_string(),
            password: "wrong".to_string(),
        };
        let error = list_dir(&auth, "").expect_err("401 必须报错");
        let _ = server.join();
        assert!(error.contains("认证失败"), "错误信息：{error}");
        assert!(error.contains("401"), "错误信息：{error}");
    }

    #[test]
    fn missing_file_is_not_an_error() {
        let (port, server) = spawn_fake_server("HTTP/1.1 404 Not Found", "");
        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "u".to_string(),
            password: "p".to_string(),
        };
        assert_eq!(
            get_file(&auth, "notes/missing.md").expect("GET 不该失败"),
            None,
            "404 应该映射成 None，而不是错误"
        );
        let _ = server.join();
    }

    #[test]
    fn delete_accepts_204_and_missing() {
        /* 204 是正常成功 */
        let (port, server) = spawn_fake_server("HTTP/1.1 204 No Content", "");
        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "u".to_string(),
            password: "p".to_string(),
        };
        delete_entry(&auth, "notes/old.md").expect("204 应该成功");
        let (request_line, _, _) = server.join().expect("服务线程崩溃");
        assert!(request_line.starts_with("DELETE /dav/notes/old.md"), "请求行：{request_line}");

        /* 404 也视为成功：目标状态已经达成 */
        let (port, server) = spawn_fake_server("HTTP/1.1 404 Not Found", "");
        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "u".to_string(),
            password: "p".to_string(),
        };
        delete_entry(&auth, "notes/gone.md").expect("404 不该让同步失败");
        let _ = server.join();
    }

    #[test]
    fn delete_refuses_the_service_root() {
        /* 空路径拼出来是 `base/`，一次手滑能清空整个同步目录 —— 必须在发请求前拦住 */
        let auth = DavAuth {
            url: "http://127.0.0.1:1/dav/".to_string(),
            username: "u".to_string(),
            password: "p".to_string(),
        };
        let error = delete_entry(&auth, "").expect_err("空路径必须被拒绝");
        assert!(error.contains("根目录"), "错误信息：{error}");
        let error = delete_entry(&auth, "/").expect_err("斜杠也必须被拒绝");
        assert!(error.contains("根目录"), "错误信息：{error}");
    }

    #[test]
    fn mkcol_treats_405_as_already_exists() {
        /* RFC 4918 §9.3.1：目录已存在时 MKCOL 返回 405，对同步而言仍是成功 */
        let (port, server) = spawn_fake_server("HTTP/1.1 405 Method Not Allowed", "");
        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "u".to_string(),
            password: "p".to_string(),
        };
        create_dir(&auth, "notes").expect("405 应该被当成「已存在」");
        let (request_line, _, _) = server.join().expect("服务线程崩溃");
        assert!(request_line.starts_with("MKCOL /dav/notes"), "请求行：{request_line}");
    }

    #[test]
    fn put_sends_body_and_accepts_2xx() {
        let (port, server) = spawn_fake_server("HTTP/1.1 201 Created", "");
        let auth = DavAuth {
            url: format!("http://127.0.0.1:{port}/dav/"),
            username: "u".to_string(),
            password: "p".to_string(),
        };
        put_file(&auth, "notes/a.md", "# 标题\n").expect("PUT 应该成功");
        let (request_line, _, _) = server.join().expect("服务线程崩溃");
        assert!(request_line.starts_with("PUT /dav/notes/a.md"), "请求行：{request_line}");
    }
}
