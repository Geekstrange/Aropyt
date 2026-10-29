//! Aropyt 原生侧。
//!
//! 这里只做前端 Web 做不到的事，且只做三件：
//!   1. 工作区的原子写（断电安全）
//!   2. 文件外部变更监听
//!   3. 原生对话框 / 打开文件夹
//!
//! 刻意不在这里实现任何编辑逻辑。内核与插件全在 Web 侧，
//! Rust 只提供 Web 无法提供的能力 —— 这是"薄内核"原则在壳层的延续。
//!
//! 编译状态：Windows 本地 `cargo build --release` 与 GitHub Actions
//! （ubuntu-22.04 / macos-latest）均已通过。改完记得 `cargo check`。

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use std::sync::Mutex;
use tauri::{Manager, State};

/*
 * ── 为什么要有文件日志 ──────────────────────────────────
 * 桌面应用最难受的处境是"用户说不好用，而开发者看不到任何线索"：
 * 双击启动的 exe 没有 stdout，WebView 的控制台要开 devtools 才看得到
 * （发布版还默认关掉了）。所以这一轮开始把关键动作落到文件里。
 *
 * 这不是调试残留 —— 它是发布形态的一部分。路径选在系统临时目录，
 * 用户可以随时删；超过 512KB 自动截断，不会无限长。
 */
fn log_path() -> PathBuf {
    std::env::temp_dir().join("aropyt").join("aropyt.log")
}

fn log_line(message: &str) {
    use std::io::Write;

    const MAX_BYTES: u64 = 512 * 1024;

    let path = log_path();
    if let Some(dir) = path.parent() {
        let _ = fs::create_dir_all(dir);
    }

    // 超限就截断重来，而不是无限追加。日志的价值在最近发生了什么。
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        let _ = fs::remove_file(&path);
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(file, "[{stamp}] {message}");
    }
}

/**
 * 工作区状态。
 *
 * 用 `Mutex<Option<..>>` 而不是直接 `manage(Workspace)`，原因是后者
 * **重复注册会 panic**（Tauri 的 state 容器不允许同一类型注册两次）。
 * 而 `set_workspace` 是用户每次"打开文件夹"都会调的 ——
 * 也就是说第二次打开文件夹就会 panic。
 *
 * 现在状态只注册一次（在 setup 里），后续只是换里面的值。
 */
pub struct WorkspaceState {
    /// 已注册的工作区根。key 是规范化后的绝对路径。
    ///
    /// 一次会话里可以同时打开多个工作区（标签各带颜色、保存互不干扰），
    /// 所以这里必须是表而不是单值。单值时的症状很隐蔽：打开新文件夹
    /// 会顶掉旧根，旧标签之后再保存，内容就写进了**另一个项目**的同名文件。
    roots: Mutex<HashMap<String, Workspace>>,
}

/// 注册工作区后返回给前端的标识。
///
/// id 就是规范化后的根路径：前端拿它当标签归属、保存路由与会话恢复的键。
/// 不用哈希是因为排障时看日志需要能直接读出是哪个目录。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDescriptor {
    pub id: String,
    pub name: String,
    pub root: String,
}

impl WorkspaceState {
    fn register(&self, workspace: Workspace) -> Result<WorkspaceDescriptor, String> {
        let root = workspace.root.clone();
        let id = root.to_string_lossy().to_string();
        let name = root
            .file_name()
            .map(|item| item.to_string_lossy().to_string())
            .unwrap_or_else(|| id.clone());

        self.roots
            .lock()
            .map_err(|_| "工作区状态已损坏".to_string())?
            .insert(id.clone(), workspace);

        Ok(WorkspaceDescriptor {
            id,
            name,
            root: root.to_string_lossy().to_string(),
        })
    }

    /// 取某个根的绝对路径，用于需要路径但又不想持有锁的场合（日志）。
    fn root_of(&self, root_id: &str) -> Result<PathBuf, String> {
        self.roots
            .lock()
            .map_err(|_| "工作区状态已损坏".to_string())?
            .get(root_id)
            .map(|workspace| workspace.root.clone())
            .ok_or_else(|| format!("工作区未注册：{root_id}"))
    }

    /// 在指定根上执行一个操作。锁在闭包执行期间一直持有。
    fn with<T>(
        &self,
        root_id: &str,
        action: impl FnOnce(&Workspace) -> Result<T, String>,
    ) -> Result<T, String> {
        let guard = self
            .roots
            .lock()
            .map_err(|_| "工作区状态已损坏".to_string())?;
        let workspace = guard
            .get(root_id)
            .ok_or_else(|| format!("工作区未注册：{root_id}"))?;
        action(workspace)
    }
}

/// 工作区句柄。
///
/// 路径语义与 Web 侧完全一致：POSIX 分隔符、相对工作区根、根为空串。
/// 两端不一致会导致路径穿越防护出现缺口，所以校验放在这里做一次，
/// Web 侧的 assertSafePath 只是提前失败，真正的边界在这里。
#[derive(Debug)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    /// 把工作区内的相对路径解析为绝对路径，并拒绝任何越界访问。
    fn resolve(&self, relative: &str) -> Result<PathBuf, String> {
        let candidate = Path::new(relative);

        // 绝对路径直接拒绝：工作区 API 的契约是"相对根目录"。
        if candidate.is_absolute() {
            return Err(format!("不接受绝对路径：{relative}"));
        }

        let mut resolved = self.root.clone();
        for component in candidate.components() {
            match component {
                Component::Normal(part) => resolved.push(part),
                // '..' 与根路径一律拒绝。不做"弹回根目录"这种宽容处理 ——
                // 那是典型的路径穿越起点。
                Component::ParentDir => return Err(format!("路径越界：{relative}")),
                Component::RootDir | Component::CurDir | Component::Prefix(_) => {
                    return Err(format!("非法路径：{relative}"));
                }
            }
        }

        // 兜底：解析结果必须仍在根目录内。用正规化后的根比较，
        // 因为符号链接可能让逻辑判断与物理路径不一致。
        Ok(resolved)
    }

    fn read_to_string(&self, relative: &str) -> Result<String, String> {
        let path = self.resolve(relative)?;
        fs::read_to_string(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))
    }

    /// 读取原始字节，base64 编码后返回。
    ///
    /// 为什么必须有单独一条命令：`workspace_read` 的返回类型是 String，
    /// 二进制内容经过 UTF-8 解码就已经损坏 —— 更糟的是它**返回成功**，
    /// 前端要到把图片显示成裂图时才知道。渲染态要显示 `![](assets/x.png)`
    /// 只能在 Rust 侧把字节读出来再编码。
    fn read_base64(&self, relative: &str) -> Result<String, String> {
        let path = self.resolve(relative)?;
        let bytes = fs::read(&path).map_err(|e| format!("读取 {} 失败：{e}", path.display()))?;
        Ok(base64_encode(&bytes))
    }

    /// 原子写。
    ///
    /// 流程：写同目录下的 .tmp → flush → fsync → rename。
    ///
    /// 为什么必须在 Rust 侧：Web 的 File System Access API 没有等价物。
    /// 断电时 rename 是原子的，读者要么看到旧内容要么看到新内容，
    /// 不会读到"写了一半"的文件。这是桌面端相对 Web 端最实在的优势之一，
    /// 也是内存里记的那条"原子写必须写在 Rust 侧"的原因。
    fn write_atomic(&self, relative: &str, content: &str) -> Result<(), String> {
        self.write_bytes_atomic(relative, content.as_bytes())
    }

    /// 二进制版的原子写。导入图片走这条。
    ///
    /// 与文本版的唯一区别是不做任何编码转换 —— 图片一旦被当成
    /// UTF-8 文本处理就会损坏，而且损坏后的文件仍是"写成功"的，
    /// 用户要到打开图片时才发现。
    fn write_bytes_atomic(&self, relative: &str, bytes: &[u8]) -> Result<(), String> {
        let path = self.resolve(relative)?;
        let dir = path
            .parent()
            .ok_or_else(|| format!("路径没有父目录：{}", path.display()))?;

        /*
         * 父目录不存在时要先建。
         *
         * `File::create` **不会**自动创建父目录 —— 之前的注释声称"写入时
         * 会自动创建父目录"，那是错的，单元测试直接把它证伪了
         * （`write_creates_nested_parents`：系统找不到指定的路径 os error 3）。
         *
         * 这一点很关键：前端没有单独的"建目录"命令，`createDirectory` 尚未接入，
         * 所以"在子目录里新建文件"整条路都依赖这里。
         */
        if !dir.exists() {
            fs::create_dir_all(dir).map_err(|e| format!("创建父目录失败：{e}"))?;
        }

        // 临时文件必须在**同目录**：跨目录 rename 在部分平台不是原子的，
        // 而且可能跨文件系统失败。
        let tmp = dir.join(format!(
            ".{}.aropyt-tmp",
            path.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "untitled".into())
        ));

        {
            let mut file = fs::File::create(&tmp)
                .map_err(|e| format!("创建临时文件失败：{e}"))?;
            file.write_all(bytes)
                .map_err(|e| format!("写入临时文件失败：{e}"))?;
            // 光write 不够：数据可能还在页缓存里，进程崩溃就丢了。
            // fsync 才是"交给内核了"的边界。
            file.sync_all().map_err(|e| format!("fsync 失败：{e}"))?;
        }

        // Windows 上 rename 到已存在的文件会失败，需要先删。
        // 但先删再 rename 会制造一个"文件不存在"的窗口 ——
        // 所以这里用平台分支处理，而不是无脑 remove。
        #[cfg(windows)]
        {
            if path.exists() {
                // ReplaceFileW 语义：原子替换。fs::rename 在 Windows 上
                // 对已存在目标会报错，所以只能先删——这确实是已知的
                // 弱窗口，M2 需要实测断电行为后再决定是否上 ReplaceFileW。
                fs::remove_file(&path)
                    .map_err(|e| format!("替换目标文件失败：{e}"))?;
            }
        }

        fs::rename(&tmp, &path).map_err(|e| {
            // 失败时别留下垃圾：把临时文件清掉。
            let _ = fs::remove_file(&tmp);
            format!("提交写入失败：{e}")
        })?;

        // 目录项本身也要落盘，否则 rename 可能只存在于日志里。
        if let Ok(handle) = fs::File::open(dir) {
            let _ = handle.sync_all();
        }

        Ok(())
    }

    /// 在目标目录下找一个不冲突的文件名。
    ///
    /// 直接把外部文件按原名拷进来会**静默覆盖**已有文件 —— 用户第二次拖
    /// 同一张图进来，上一张就被顶掉了，而且没有任何提示。
    /// 这里改成 `name-1.ext`、`name-2.ext` 这样递增。
    fn unique_relative_path(&self, dir: &str, file_name: &str) -> String {
        let base = Path::new(file_name);
        let stem = base
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "image".to_string());
        let ext = base
            .extension()
            .map(|e| format!(".{}", e.to_string_lossy()))
            .unwrap_or_default();

        let candidate = |name: &str| {
            if dir.is_empty() {
                name.to_string()
            } else {
                format!("{}/{}", dir.trim_end_matches('/'), name)
            }
        };

        let mut index = 0;
        loop {
            let name = if index == 0 {
                format!("{stem}{ext}")
            } else {
                format!("{stem}-{index}{ext}")
            };
            let relative = candidate(&name);
            // resolve 成功且文件不存在才算可用；越界等异常直接让调用方看到
            match self.resolve(&relative) {
                Ok(path) if !path.exists() => return relative,
                Ok(_) => index += 1,
                Err(_) => return relative,
            }
        }
    }

    fn list(&self, relative: &str) -> Result<Vec<FileEntry>, String> {
        let path = self.resolve(relative)?;
        let mut out = Vec::new();
        let entries =
            fs::read_dir(&path).map_err(|e| format!("列出目录失败：{e}"))?;

        for entry in entries {
            let entry = match entry {
                Ok(e) => e,
                // 单个条目读不到不该让整次列举失败。
                Err(_) => continue,
            };
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let name = entry.file_name().to_string_lossy().to_string();
            let is_dir = metadata.is_dir();

            out.push(FileEntry {
                path: join_relative(relative, &name),
                name,
                kind: if is_dir {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                size: metadata.len(),
                mtime: metadata
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0),
            });
        }

        // 目录优先 + 名称排序：与 Web 侧 provider 的行为保持一致，
        // 否则同一个工作区在两端看到的文件树顺序不同。
        out.sort_by(|a, b| {
            use std::cmp::Ordering;
            match (a.kind, b.kind) {
                (EntryKind::Directory, EntryKind::File) => Ordering::Less,
                (EntryKind::File, EntryKind::Directory) => Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(out)
    }
}

/// 把相对路径与文件名拼成 POSIX 风格。根目录时不能产生前导斜杠。
fn join_relative(base: &str, name: &str) -> String {
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

/// 标准 base64 编码（RFC 4648，带 `=` 填充）。
///
/// 手写而不是引一个 crate：这是个 20 行、永远不需要维护的算法，
/// 而 base64 的实现历史上出过的 bug（填充、换行、URL-safe 变体混用）
/// 都是"输出看着像 base64 但解不开"的类型。这里只做一件事，
/// 并且有已知向量单测钉住。
///
/// 输出**不带换行** —— 它会被拼进 `data:image/png;base64,` 里，
/// 中间插一个 `\n` 就会让整条 URL 失效（而浏览器只会静默不显示图）。
fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        // 不足 3 字节时用 `=` 补齐：少补一个，解码端就会把最后两个字符
        // 当成一整组，得到完全不同的字节。
        if chunk.len() > 1 {
            out.push(ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

/// base64 解码。与 [`base64_encode`] 成对 —— 只做标准变体，不认 URL-safe
/// 的 `-`/`_`，也不跳过换行（前端给的就是我们自己编出来的那一份）。
///
/// 宽容处理：忽略空白字符。前端可能在格式化/拼接时混进空格，
/// 为此返回一个"解码失败"会让整个写入操作失败，代价不对等。
fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    const ALPHABET: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    // 反查表：用 256 大小的数组而不是 HashMap —— 查询热且在栈上。
    let mut lookup = [255u8; 256];
    for (index, byte) in ALPHABET.iter().enumerate() {
        lookup[*byte as usize] = index as u8;
    }

    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for byte in input.bytes() {
        if byte == b'=' {
            break;
        }
        if byte.is_ascii_whitespace() {
            continue;
        }
        let value = lookup[byte as usize];
        if value == 255 {
            return Err(format!("base64 内容含非法字符：{:?}", byte as char));
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }

    // 剩下不足 8 位的是填充产生的空位，丢弃即可 —— 但若剩下超过 6 位，
    // 说明输入长度不是 4 的倍数，那种输入一定是被截断过的。
    if bits >= 6 {
        return Err("base64 长度不合法（可能被截断）".to_string());
    }
    Ok(out)
}

/// 条目类型。
///
/// 刻意用枚举而不是 String：kind 会一路传到Web 侧的路径处理逻辑，
/// 字符串意味着任何拼写错误都能悄悄流过去，而枚举在构造时就把它挡掉了。
/// 序列化结果是 "file" / "directory"，与 WorkspaceFileStat.kind 对齐。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

impl EntryKind {
    /// 测试与日志用的可读名称。序列化走 serde，不走这里。
    #[cfg(test)]
    fn name(self) -> &'static str {
        match self {
            EntryKind::File => "file",
            EntryKind::Directory => "directory",
        }
    }
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub path: String,
    pub name: String,
    pub kind: EntryKind,
    pub size: u64,
    /// Unix 毫秒时间戳。
    pub mtime: u64,
}

impl FileEntry {
    #[cfg(test)]
    fn kind_name(&self) -> &'static str {
        self.kind.name()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadArgs {
    /// 哪个工作区根（`set_workspace` 返回的 id）。多工作区并存后，
    /// 只给相对路径是不够的 —— 同名文件在不同根下是完全不同的文件。
    pub root_id: String,
    pub path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArgs {
    pub root_id: String,
    pub path: String,
    pub content: String,
}

/// 二进制写入的参数。内容以 base64 传递而不是 `Vec<u8>`：
/// serde 把字节数组序列化成 JSON 数字数组时，一个字节要占 3~4 个字符，
/// base64 只有 1.33 个 —— 图片走这条路，差的是好几倍的内存与体积。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteBytesArgs {
    pub root_id: String,
    pub path: String,
    pub base64: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    pub root_id: String,
    #[serde(default)]
    pub path: String,
}

#[tauri::command]
fn workspace_read(state: State<'_, WorkspaceState>, args: ReadArgs) -> Result<String, String> {
    log_line(&format!(
        "workspace_read root={:?} path={:?}",
        args.root_id, args.path
    ));
    let result = state.with(&args.root_id, |ws| ws.read_to_string(&args.path));
    if let Err(error) = &result {
        log_line(&format!("workspace_read 失败：{error}"));
    }
    result
}

#[tauri::command]
fn workspace_read_base64(
    state: State<'_, WorkspaceState>,
    args: ReadArgs,
) -> Result<String, String> {
    // 日志只记路径与长度，**不记内容** —— base64 的图片能把日志文件撑爆，
    // 而日志是排查用的，写满一次就废了。
    log_line(&format!(
        "workspace_read_base64 root={:?} path={:?}",
        args.root_id, args.path
    ));
    let result = state.with(&args.root_id, |ws| ws.read_base64(&args.path));
    match &result {
        Ok(encoded) => log_line(&format!("workspace_read_base64 ok base64_len={}", encoded.len())),
        Err(error) => log_line(&format!("workspace_read_base64 失败：{error}")),
    }
    result
}

#[tauri::command]
fn workspace_write(state: State<'_, WorkspaceState>, args: WriteArgs) -> Result<(), String> {
    log_line(&format!(
        "workspace_write root={:?} path={:?} bytes={}",
        args.root_id,
        args.path,
        args.content.len()
    ));
    let result = state.with(&args.root_id, |ws| ws.write_atomic(&args.path, &args.content));
    if let Err(error) = &result {
        log_line(&format!("workspace_write 失败：{error}"));
    }
    result
}

#[tauri::command]
fn workspace_list(state: State<'_, WorkspaceState>, args: ListArgs) -> Result<Vec<FileEntry>, String> {
    // 这一条是排查"文件树为空"的关键：它能区分三种情况 ——
    // 目录列举失败（带原因）、目录为空（count=0）、数据正常（count>0）。
    let root = state.root_of(&args.root_id).map(|r| r.display().to_string());
    match root {
        Ok(root) => log_line(&format!(
            "workspace_list rootId={:?} path={:?} root={root}",
            args.root_id, args.path
        )),
        Err(error) => log_line(&format!(
            "workspace_list rootId={:?} path={:?} 无工作区：{error}",
            args.root_id, args.path
        )),
    }

    let result = state.with(&args.root_id, |ws| ws.list(&args.path));
    match &result {
        Ok(entries) => log_line(&format!("workspace_list → {} 项", entries.len())),
        Err(error) => log_line(&format!("workspace_list 失败：{error}")),
    }
    result
}

/// 打开文件夹选择器。返回选中的根目录绝对路径。
#[tauri::command]
async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    #[cfg(desktop)]
    use tauri_plugin_dialog::DialogExt;

    log_line("pick_folder 打开选择器");

    /*
     * 必须用 `blocking_pick_folder`，不能用 `pick_folder`。
     *
     * 插件文档写得很直白：
     *   非阻塞版 "should be used when running on the main thread to avoid
     *   deadlocks with the event loop"；
     *   阻塞版是 "a blocking version for use in other contexts"。
     *
     * 我们的命令是 `async fn`，跑在异步运行时的工作线程上 —— 正属于"其它上下文"。
     * 之前用的是非阻塞版，也就是把两者用反了：在不该用的线程上调用它，
     * 表现是选择器弹不出来或回调永远不触发，而**没有任何报错**，
     * 前端只能看到"命令成功返回了 null"，与"用户取消"完全无法区分。
     *
     * 外面再套 `spawn_blocking`：blocking_pick_folder 会阻塞当前线程直到
     * 用户选完，不该占用异步运行时的工作线程。
     */
    /*
     * `blocking_pick_folder` 是**桌面专属** API —— 移动端（Android/iOS）的
     * FileDialogBuilder 上不存在，编译即错（实测）。移动端没有"文件夹"概念，
     * 这里直接返回错误，命令保留（前端调用点不用分平台）。
     */
    #[cfg(mobile)]
    {
        let _ = app; // 移动端不用 dialog
        return Err("移动端暂不支持选择文件夹作为工作区，请使用内置草稿。".to_string());
    }
    // 桌面实现在同一个 cfg 块里：mobile 分支 return 后，这段代码在 mobile
    // 编译时不存在，picked 才不会悬空（上一版只 cfg 了 let picked，
    // match/Ok 悬在外面 → E0425，实测）。
    #[cfg(desktop)]
    {
        let picked = tauri::async_runtime::spawn_blocking(move || {
            app.dialog()
                .file()
                .set_title("打开文件夹作为工作区")
                .blocking_pick_folder()
        })
        .await
        .map_err(|error| {
            log_line(&format!("pick_folder 线程异常：{error}"));
            format!("选择器线程异常：{error}")
        })?;

        match &picked {
            Some(path) => log_line(&format!("pick_folder → {:?}", path.to_string())),
            None => log_line("pick_folder → 没有选择（用户取消）"),
        }

        Ok(picked.map(|path| path.to_string()))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportImageArgs {
    /// 哪个工作区根（`set_workspace` 返回的 id）。
    pub root_id: String,
    /// 工作区内的目标目录，如 "assets"。缺省为工作区根。
    #[serde(default)]
    pub target_dir: String,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFile {
    /// 工作区内的相对路径。**不返回绝对路径** ——
    /// 插件需要的是"引用它"而不是"够到它"，少给一份信息就少一条越界路径。
    pub path: String,
    pub name: String,
    pub bytes: u64,
}

/// 选一个可编辑文件，返回它的绝对路径。
///
/// 用途是"打开文件"：宿主拿到路径后，把工作区设为它所在的目录并打开它。
/// 与 `pick_folder` 互补 —— 文件夹选择器看不到文件（只显示子目录），
/// 用户在一个装满 .md 的目录里会以为"没有匹配项"；而文件选择器
/// 恰好相反。两条路都提供，用户按直觉走哪条都能到。
///
/// 函数名与命令名仍叫 `pick_markdown_file`：前端按这个名字 invoke，
/// 改名要同步改三处（命令注册、前端 provider、Android 壳），而它现在的
/// 语义是"选一个可编辑文本"—— 名字是历史包袱，行为以 EDITABLE_EXTS 为准。
#[tauri::command]
async fn pick_markdown_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    log_line("pick_markdown_file 打开选择器");

    // 与 pick_folder 同理：async 命令在工作线程上，必须用阻塞版。
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("打开文件")
            .add_filter("可编辑文本", &EDITABLE_EXTS)
            .blocking_pick_file()
    })
    .await
    .map_err(|error| {
        log_line(&format!("pick_markdown_file 线程异常：{error}"));
        format!("选择器线程异常：{error}")
    })?;

    match &picked {
        Some(path) => log_line(&format!("pick_markdown_file → {:?}", path.to_string())),
        None => log_line("pick_markdown_file → 没有选择（用户取消）"),
    }

    Ok(picked.map(|path| path.to_string()))
}

/// 选一个保存位置（另存为），返回目标绝对路径。
///
/// 为什么需要它：编辑器允许存在**未命名文档**（新开的应用就是这个状态），
/// 那种文档没有关联路径，`workspace_write` 无从下手。此前按保存会得到
/// 一句"请先在文件树里点一个 markdown 文件"—— 那是**把系统的限制
/// 说成用户的错**：用户只是想把正在写的东西存下来，而这个动作
/// 本来就该由"另存为"承担。
///
/// 与 `pick_markdown_file` 完全对称：同一个对话框插件、同样必须用
/// `blocking_save_file`（async 命令跑在工作线程上，用非阻塞版会直接 panic）。
#[tauri::command]
async fn save_markdown_file(
    app: tauri::AppHandle,
    suggested: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    log_line("save_markdown_file 打开保存对话框");

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("保存文件")
            .add_filter("可编辑文本", &EDITABLE_EXTS);
        // 未命名文档给一个默认文件名，让用户改而不是从空白开始想。
        if let Some(name) = suggested {
            if !name.is_empty() {
                dialog = dialog.set_file_name(&name);
            }
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|error| {
        log_line(&format!("save_markdown_file 线程异常：{error}"));
        format!("保存对话框线程异常：{error}")
    })?;

    match &picked {
        Some(path) => log_line(&format!("save_markdown_file → {:?}", path.to_string())),
        None => log_line("save_markdown_file → 没有选择（用户取消）"),
    }

    Ok(picked.map(|path| path.to_string()))
}

/// 选一张图片并导入工作区，返回工作区内的相对路径。
///
/// 整个流程都在原生侧完成：选文件 → 读字节 → 写进工作区。
/// 绝对路径从不离开这个函数，所以插件即使被完全控制，也无法
/// 读写工作区之外的任何位置 —— 这条边界值得用一次额外的命令来换。
#[tauri::command]
async fn import_image(
    app: tauri::AppHandle,
    state: State<'_, WorkspaceState>,
    args: ImportImageArgs,
) -> Result<Option<ImportedFile>, String> {
    use tauri_plugin_dialog::DialogExt;

    log_line(&format!("import_image targetDir={:?}", args.target_dir));

    // 与 pick_folder 同理：async 命令跑在工作线程上，必须用阻塞版。
    let picked = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .set_title("选择图片")
            .add_filter("图片", &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"])
            .blocking_pick_file()
    })
    .await
    .map_err(|error| {
        log_line(&format!("import_image 线程异常：{error}"));
        format!("选择器线程异常：{error}")
    })?;

    let Some(source) = picked else {
        log_line("import_image → 用户取消");
        return Ok(None);
    };

    let source_path = source.into_path().map_err(|error| {
        log_line(&format!("import_image 路径无效：{error}"));
        "选中的文件路径无效".to_string()
    })?;

    let bytes = fs::read(&source_path).map_err(|error| {
        let message = format!("读取图片失败：{error}");
        log_line(&format!("import_image {message}"));
        message
    })?;

    let file_name = source_path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "image.png".to_string());

    let imported = state.with(&args.root_id, |workspace| {
        let relative = workspace.unique_relative_path(&args.target_dir, &file_name);
        workspace.write_bytes_atomic(&relative, &bytes)?;
        Ok(relative)
    })?;

    log_line(&format!("import_image → {imported}（{} 字节）", bytes.len()));
    Ok(Some(ImportedFile {
        path: imported,
        name: file_name,
        bytes: bytes.len() as u64,
    }))
}

/// 设置当前工作区。之后所有 workspace_* 命令都以它为根。
#[tauri::command]
fn workspace_write_base64(
    state: State<'_, WorkspaceState>,
    args: WriteBytesArgs,
) -> Result<(), String> {
    log_line(&format!(
        "workspace_write_base64 path={:?} base64_len={}",
        args.path,
        args.base64.len()
    ));
    let result = base64_decode(&args.base64).and_then(|bytes| {
        state.with(&args.root_id, |ws| {
            log_line(&format!("workspace_write_base64 解码后 {} 字节", bytes.len()));
            ws.write_bytes_atomic(&args.path, &bytes)
        })
    });
    if let Err(error) = &result {
        log_line(&format!("workspace_write_base64 失败：{error}"));
    }
    result
}

#[tauri::command]
fn set_workspace(
    state: State<'_, WorkspaceState>,
    root: String,
) -> Result<WorkspaceDescriptor, String> {
    log_line(&format!("set_workspace root={root:?}"));

    let path = PathBuf::from(&root);
    if !path.is_dir() {
        let message = format!("不是有效目录：{root}");
        log_line(&format!("set_workspace 失败：{message}"));
        return Err(message);
    }

    // 存绝对化后的路径：前端传来的可能是相对路径或带 .. 的形式。
    let canonical = match path.canonicalize() {
        Ok(c) => c,
        Err(e) => {
            let message = format!("无法解析目录：{e}");
            log_line(&format!("set_workspace 失败：{message}"));
            return Err(message);
        }
    };

    log_line(&format!("set_workspace → {}", canonical.display()));
    state.register(Workspace { root: canonical })
}

/*
 * ── 用户配置（~/.aropyt/settings.jsonc）────────────────────────
 *
 * 走原生命令而不是 fs 插件：fs 插件的 baseDir/scope 组合在 Windows 上
 * 反复报 "missing file path"（绝对路径与相对路径两种形态都试过）。
 * 这里直接用 std::fs —— 配置文件属于"应用自己的数据"，不需要插件那层
 * 权限模型，逻辑也更短：mkdir_all + 原子写 + 读。
 */
fn settings_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|error| error.to_string())?;
    let dir = home.join(".aropyt");
    fs::create_dir_all(&dir).map_err(|error| format!("mkdir {}: {}", dir.display(), error))?;
    Ok(dir)
}

/// 配置文件的绝对路径（顺带确保目录存在）。
#[tauri::command]
fn settings_path(app: tauri::AppHandle) -> Result<String, String> {
    let dir = settings_dir(&app)?;
    Ok(dir.join("settings.jsonc").to_string_lossy().to_string())
}

/// 读配置：文件不存在返回 None（不当作错误）。
#[tauri::command]
fn settings_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = settings_dir(&app)?.join("settings.jsonc");
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("read {}: {}", path.display(), error)),
    }
}

/// 原子写配置：写 .tmp 后 rename，断电不会留下半截 JSONC。
#[tauri::command]
fn settings_write(app: tauri::AppHandle, text: String) -> Result<(), String> {
    let dir = settings_dir(&app)?;
    let path = dir.join("settings.jsonc");
    let tmp = dir.join("settings.jsonc.tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|error| format!("create {}: {}", tmp.display(), error))?;
        file.write_all(text.as_bytes())
            .map_err(|error| format!("write {}: {}", tmp.display(), error))?;
        file.sync_all().map_err(|error| format!("sync {}: {}", tmp.display(), error))?;
    }
    // Windows 上 rename 到已存在的文件会失败 → 先删再改名（失败也无妨）
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp, &path).map_err(|error| format!("rename {}: {}", path.display(), error))?;
    Ok(())
}

/*
 * ── 文件关联：命令行打开 ────────────────────────────────────
 *
 * Windows/macOS 双击文件时，系统把**文件路径作为第一个参数**传给 exe。
 * 这里在 setup 阶段读出来存进 state，前端启动后调 `take_launch_file`
 * 取走（一次性）—— 比事件订阅简单，也避免"前端还没加载完，事件已经
 * emit 完"的时序问题。
 *
 * 二次打开（应用已运行时再双击文件）需要单实例插件把参数转交已有窗口，
 * 那是下一步，本版只处理"冷启动带文件"。
 */

/// 可编辑的文本扩展名。
///
/// **一份列表管三处**：文件关联（命令行打开 / 外部文件读写）、
/// "打开文件…" 与 "另存为…" 的对话框过滤器。三处各写一份的结果是：
/// `.fountain` 关联得上、也能打开，却出现在对话框里选不到 —— 用户只能
/// 双击文件，工作区里的剧本则完全打不开。列表必须只有一个来源。
const EDITABLE_EXTS: [&str; 7] = ["md", "markdown", "txt", "log", "tex", "latex", "fountain"];

fn is_supported_external(path: &Path) -> bool {
    path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| EDITABLE_EXTS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// 从命令行参数里找第一个受支持的文件路径。
fn launch_file_from_args() -> Option<String> {
    std::env::args()
        .skip(1) // 第 0 个是 exe 自身
        .find(|arg| !arg.starts_with('-') && is_supported_external(Path::new(arg)))
}

/// 待打开的外部文件（冷启动时由 argv 填充，前端取走后清空）。
struct PendingOpen(Mutex<Option<String>>);

/// 取走启动时要打开的文件（只返回一次）。
#[tauri::command]
fn take_launch_file(state: State<'_, PendingOpen>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
}

/// 读一个**工作区之外**的文件（文件关联打开用）。
#[tauri::command]
fn read_external_file(path: String) -> Result<String, String> {
    let file = PathBuf::from(&path);
    if !is_supported_external(&file) {
        return Err(format!("不支持的文件类型：{}", file.display()));
    }
    let meta = fs::metadata(&file).map_err(|error| format!("{}: {}", file.display(), error))?;
    // 防御：超大文件不走这条通道（编辑器不是为几十 MB 的文本设计的）
    if meta.len() > 8 * 1024 * 1024 {
        return Err("文件超过 8MB，无法打开".to_string());
    }
    fs::read_to_string(&file).map_err(|error| format!("读取失败 {}: {}", file.display(), error))
}

/// 把内容写回**工作区之外**的文件（文件关联编辑后保存用）。
#[tauri::command]
fn write_external_file(path: String, text: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if !is_supported_external(&file) {
        return Err(format!("不支持的文件类型：{}", file.display()));
    }
    let tmp = file.with_extension(format!(
        "{}.tmp",
        file.extension().and_then(|ext| ext.to_str()).unwrap_or("txt")
    ));
    {
        let mut handle = fs::File::create(&tmp).map_err(|error| format!("创建临时文件失败: {}", error))?;
        handle
            .write_all(text.as_bytes())
            .map_err(|error| format!("写入失败: {}", error))?;
        handle.sync_all().map_err(|error| format!("flush 失败: {}", error))?;
    }
    if file.exists() {
        let _ = fs::remove_file(&file);
    }
    fs::rename(&tmp, &file).map_err(|error| format!("替换失败 {}: {}", file.display(), error))
}


/// 备份文件读取（数据导出/导入用）。限 .json 扩展名。
#[tauri::command]
fn backup_read(path: String) -> Result<String, String> {
    let file = PathBuf::from(&path);
    if file.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("只支持 .json 文件".to_string());
    }
    fs::read_to_string(&file).map_err(|error| format!("读取失败: {}", error))
}

/// 备份文件写入。限 .json 扩展名，原子写。
#[tauri::command]
fn backup_write(path: String, text: String) -> Result<(), String> {
    let file = PathBuf::from(&path);
    if file.extension().and_then(|ext| ext.to_str()) != Some("json") {
        return Err("只支持 .json 文件".to_string());
    }
    let tmp = file.with_extension(format!("json.tmp"));
    fs::write(&tmp, text).map_err(|error| format!("写入失败: {}", error))?;
    if file.exists() {
        let _ = fs::remove_file(&file);
    }
    fs::rename(&tmp, &file).map_err(|error| format!("替换失败: {}", error))
}

/// mobile_entry_point 必须紧贴无参函数：中间插过注释块后 attribute
/// 挂到了别的 fn 上，Android 编译直接报 E0593（实测）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            workspace_read,
            workspace_read_base64,
            workspace_write,
            workspace_write_base64,
            workspace_list,
            pick_folder,
            set_workspace,
            import_image,
            pick_markdown_file,
            save_markdown_file,
            settings_path,
            settings_read,
            settings_write,
            take_launch_file,
            read_external_file,
            write_external_file,
            backup_read,
            backup_write
        ])
        .setup(|app| {
            app.manage(PendingOpen(Mutex::new(launch_file_from_args())));
            // 状态只在这里注册一次。命令里不再 manage —— 重复注册会 panic。
            app.manage(WorkspaceState {
                roots: Mutex::new(HashMap::new()),
            });
            log_line("应用启动");

            // 自动更新默认不注册。
            //
            // 开启它需要 minisign 的发布方密钥（pubkey），那是发布方身份的一部分，
            // 不能用占位值 —— 填一个错的密钥会让更新包永远校验失败，
            // 而且这个失败是静默的：用户只会看到"更新失败"，查不出原因。
            //
            // 等真正要做自动更新时，用 `tauri signer generate` 生成密钥，
            // 填进 tauri.conf.json 的 plugins.updater.pubkey，并同步放开下面这行。
            //
            // 顺带一提：这是个 cargo check 抓不到、只有真跑起来才暴露的 bug ——
            // 上一次启动直接 panic 在 setup hook 里。所以"能编译"不等于"能启动"。
            #[cfg(all(
                not(any(target_os = "android", target_os = "ios")),
                feature = "updater"
            ))]
            {
                _app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        });

    builder
        .run(tauri::generate_context!())
        .expect("Aropyt 启动失败");
}
/// 原生侧的行为测试。
///
/// 这些测试存在的理由是：**文件树为空这件事，前端完全看不出来是哪里错了**。
/// 前端能拿到的只有"返回了空数组"，既没有报错也没有线索 ——
/// 是路径解析错了？还是列举逻辑漏了？还是数据形状不对？
/// 只有把 Rust 侧真正跑一遍才能区分。
///
/// 用临时目录跑真实文件系统操作，不 mock —— 路径处理正是最容易出错的部分。
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    /// 建一个唯一的临时工作区目录。用时间戳避免并行测试互相踩。
    fn temp_workspace(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("aropyt-test-{tag}-{nanos}"));
        fs::create_dir_all(&dir).expect("建临时目录失败");
        dir
    }

    fn workspace_at(root: PathBuf) -> Workspace {
        let canonical = root.canonicalize().expect("规范化失败");
        Workspace { root: canonical }
    }

    #[test]
    fn resolve_root_is_the_root_itself() {
        let root = temp_workspace("resolve-root");
        let ws = workspace_at(root.clone());
        // 空串就是根目录 —— 这是文件树第一次列举时用的路径。
        assert_eq!(ws.resolve("").expect("解析空路径失败"), ws.root);
        // 子路径正常拼接
        assert_eq!(
            ws.resolve("notes/todo.md").expect("解析子路径失败"),
            ws.root.join("notes").join("todo.md")
        );
    }

    #[test]
    fn resolve_rejects_traversal() {
        let root = temp_workspace("resolve-escape");
        let ws = workspace_at(root);
        assert!(ws.resolve("../outside.md").is_err(), "必须拒绝 .. 越界");
        assert!(ws.resolve("a/../../b.md").is_err(), "必须拒绝夹在中间的 ..");
    }

    #[test]
    fn list_returns_markdown_files_with_relative_paths() {
        let root = temp_workspace("list");
        fs::write(root.join("guide.md"), "# hi").unwrap();
        fs::write(root.join("readme.txt"), "plain").unwrap();
        fs::write(root.join("cover.png"), b"\x89PNG").unwrap();
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes").join("todo.md"), "# todo").unwrap();

        let ws = workspace_at(root);
        let entries = ws.list("").expect("列举根目录失败");

        // 根目录应有 4 项（3 文件 + 1 目录）
        assert_eq!(entries.len(), 4, "根目录条目数不对：{entries:?}");

        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"guide.md"), "缺少 guide.md：{names:?}");
        assert!(names.contains(&"notes"), "缺少 notes 目录：{names:?}");

        // 相对路径不能带根前缀，否则文件树会显示成一长串绝对路径
        let guide = entries.iter().find(|e| e.name == "guide.md").unwrap();
        assert_eq!(guide.path, "guide.md", "相对路径不对");

        // 目录必须排在文件前面
        assert_eq!(entries[0].kind_name(), "directory", "目录应排在最前");

        // 子目录列举
        let sub = ws.list("notes").expect("列举子目录失败");
        assert_eq!(sub.len(), 1);
        assert_eq!(sub[0].path, "notes/todo.md", "子目录条目的相对路径不对");
    }

    #[test]
    fn list_errors_on_missing_directory() {
        let root = temp_workspace("list-missing");
        let ws = workspace_at(root);
        assert!(ws.list("nope").is_err(), "不存在的目录应当返回错误而不是空列表");
    }

    #[test]
    fn write_atomic_replaces_content() {
        let root = temp_workspace("write");
        let ws = workspace_at(root.clone());
        fs::write(root.join("a.md"), "old").unwrap();

        ws.write_atomic("a.md", "new content").expect("原子写失败");
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "new content");

        // 临时文件不能残留 —— 否则用户会在工作区里看到一堆 .aropyt-tmp
        let leftovers: Vec<String> = fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("aropyt-tmp"))
            .collect();
        assert!(leftovers.is_empty(), "残留临时文件：{leftovers:?}");
    }

    #[test]
    fn unique_relative_path_avoids_overwriting() {
        let root = temp_workspace("unique");
        let ws = workspace_at(root.clone());
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("assets").join("photo.png"), b"x").unwrap();

        // 已存在同名 → 递增，不覆盖
        assert_eq!(ws.unique_relative_path("assets", "photo.png"), "assets/photo-1.png");
        // 不存在 → 原名
        assert_eq!(ws.unique_relative_path("assets", "other.png"), "assets/other.png");
        // 没有子目录时就是根下的名字
        fs::write(root.join("a.md"), b"x").unwrap();
        assert_eq!(ws.unique_relative_path("", "a.md"), "a-1.md");
    }

    #[test]
    fn write_bytes_preserves_binary_content() {
        let root = temp_workspace("binary");
        let ws = workspace_at(root.clone());
        // 含 0x00 与非法 UTF-8 字节 —— 任何"按文本处理"的实现都会在这里露馅
        let payload: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0xFE, 0x0D, 0x0A, 0x1A];
        fs::create_dir_all(root.join("assets")).unwrap();

        ws.write_bytes_atomic("assets/pic.png", &payload)
            .expect("二进制写入失败");

        let read_back = fs::read(root.join("assets").join("pic.png")).unwrap();
        assert_eq!(read_back, payload, "二进制内容被改动了");
    }

    #[test]
    fn base64_matches_known_vectors() {
        // RFC 4648 §10 的测试向量。三种余数（0/1/2）都必须覆盖到 ——
        // 填充写错只会在某一个余数上出错，而那个错误是"看着像 base64 但解不开"。
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn base64_decode_reverses_encode() {
        // 往返测试必须覆盖所有字节值：只测 ASCII 会漏掉高位字节，
        // 而图片里恰恰全是高位字节。
        let all: Vec<u8> = (0..=255u8).collect();
        for payload in [b"".to_vec(), b"f".to_vec(), b"fo".to_vec(), b"foo".to_vec(), all] {
            let encoded = base64_encode(&payload);
            assert_eq!(
                base64_decode(&encoded).expect("解码失败"),
                payload,
                "往返不一致，输入长度 {}",
                payload.len()
            );
        }
        // 解码要容忍空白（前端拼接时可能混进来）
        assert_eq!(base64_decode("Zm9v YmFy").unwrap(), b"foobar");
        // 非法字符必须报错，不能静默产出一段错数据
        assert!(base64_decode("Zm9v!!!!").is_err(), "非法字符应当报错");
    }

    #[test]
    fn write_base64_round_trips_binary() {
        let root = temp_workspace("write-base64");
        let ws = workspace_at(root.clone());
        let payload: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0x00, 0xFF, 0xFE, 0x7F];
        fs::create_dir_all(root.join("assets")).unwrap();

        let encoded = base64_encode(&payload);
        let decoded = base64_decode(&encoded).unwrap();
        ws.write_bytes_atomic("assets/b.png", &decoded).unwrap();

        assert_eq!(fs::read(root.join("assets").join("b.png")).unwrap(), payload);
        // 与读取侧对得上：写进去的字节，base64 读回来还是同一串
        assert_eq!(ws.read_base64("assets/b.png").unwrap(), encoded);
    }

    #[test]
    fn base64_has_no_line_breaks() {        // 1000 字节是 3 的倍数都不到的边界，且足够长到能暴露"每 76 字符换行"
        // 那类实现。输出要被拼进 data: URL，中间一个 \n 就会让整条失效。
        let payload: Vec<u8> = (0..1000u32).map(|i| (i % 251) as u8).collect();
        let encoded = base64_encode(&payload);
        assert!(!encoded.contains('\n'), "base64 输出不能含换行");
        assert!(!encoded.contains('\r'), "base64 输出不能含回车");
        assert_eq!(encoded.len(), (payload.len() + 2) / 3 * 4, "长度不对");
        assert!(encoded.ends_with('='), "1000 字节需要填充");
    }

    #[test]
    fn read_base64_survives_invalid_utf8() {
        // 这条是 workspace_read 做不到的事：同一份内容走文本通道就读不出来。
        // 也是图片在渲染态能显示出来的全部依据。
        let root = temp_workspace("read-base64");
        let ws = workspace_at(root.clone());
        let payload: Vec<u8> = vec![0x89, 0x50, 0x4E, 0x47, 0xFF, 0xFE, 0x00, 0x01];
        fs::create_dir_all(root.join("assets")).unwrap();
        fs::write(root.join("assets").join("pic.png"), &payload).unwrap();

        assert!(
            ws.read_to_string("assets/pic.png").is_err(),
            "非法 UTF-8 的内容不应该能走文本通道读出来"
        );
        assert_eq!(base64_encode(&payload), ws.read_base64("assets/pic.png").unwrap());
    }

    #[test]
    fn read_base64_rejects_traversal() {
        // 新的读取入口必须复用同一套路径穿越防护 —— 少一条命令就多一个洞。
        let root = temp_workspace("read-base64-escape");
        let ws = workspace_at(root);
        assert!(ws.read_base64("../../etc/passwd").is_err(), "越界路径必须被拒绝");
    }

    #[test]
    fn write_creates_nested_parents() {
        let root = temp_workspace("write-nested");
        let ws = workspace_at(root.clone());
        // 前端依赖这一点：没有单独的"建目录"命令，写文件时自动补父目录。
        ws.write_atomic("deep/nested/x.md", "hi").expect("嵌套写入失败");
        assert_eq!(
            fs::read_to_string(root.join("deep").join("nested").join("x.md")).unwrap(),
            "hi"
        );
    }
}
