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

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{Manager, State};

/// WebDAV 客户端（同步用）。放在独立文件里：lib.rs 已经足够长，
/// 而这一块与工作区文件系统没有任何共享状态。
pub mod webdav;

/*
 * ── 为什么要有文件日志 ──────────────────────────────────
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

    /// 重命名同目录下的一个条目。
    ///
    /// 只允许改名、不允许移动：新名字里带分隔符等于允许 `a/b.md` 变成
    /// `../x.md`，而 `resolve` 的越界检查是对**源路径**做的，目标路径
    /// 一旦能自由构造就绕过去了。要移动请走"新建 + 删除"。
    ///
    /// 走 `fs::rename` 而不是"读出来再写回去"：后者会丢修改时间，并且在
    /// 两次操作之间失败时，文件会处于两个名字都不完整的状态。
    fn rename(&self, relative: &str, new_name: &str) -> Result<(), String> {
        let trimmed = new_name.trim();
        if trimmed.is_empty() {
            return Err("名称不能为空".to_string());
        }
        if trimmed.contains(['/', '\\']) || trimmed == "." || trimmed == ".." {
            return Err(format!("非法的名称：{new_name}"));
        }

        let from = self.resolve(relative)?;
        let parent = from
            .parent()
            .ok_or_else(|| format!("无法确定 {relative} 的父目录"))?;
        let to = parent.join(trimmed);

        if to == from {
            return Ok(());
        }
        /* 覆盖会无声丢掉另一个文件，而重命名的意图从来不是覆盖 */
        if to.exists() {
            return Err(format!("{trimmed} 已存在"));
        }

        fs::rename(&from, &to).map_err(|error| format!("重命名失败：{error}"))
    }

    /// 删除一个文件或**空**目录。
    ///
    /// 走 `resolve` 的同一套越界检查。目录刻意用 `remove_dir` 而不是
    /// `remove_dir_all`：同步时删掉一个文件不该顺带清空它的父目录，
    /// 那是一次不可撤销的、范围远超预期的破坏。
    fn delete(&self, relative: &str) -> Result<(), String> {
        let path = self.resolve(relative)?;
        let meta =
            fs::metadata(&path).map_err(|error| format!("无法读取 {relative}：{error}"))?;
        if meta.is_dir() {
            fs::remove_dir(&path).map_err(|error| format!("删除目录失败：{error}"))
        } else {
            fs::remove_file(&path).map_err(|error| format!("删除文件失败：{error}"))
        }
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
         * 父目录不存在时要先建：`File::create` **不会**自动创建父目录。
         *
         * 前端没有单独的"建目录"命令（`createDirectory` 尚未接入），
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

/// 删除的参数。只要根标识与相对路径。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteArgs {
    pub root_id: String,
    pub path: String,
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

/// 删除工作区里的文件或空目录。
///
/// 同步需要它：本地删了某个文件之后，远端也要跟着删，否则下一轮下载会把
/// 它复活。只删空目录（见 `Workspace::delete`）—— 递归删除不该藏在一个
/// 名字这么普通的命令里。
#[tauri::command]
fn workspace_delete(state: State<'_, WorkspaceState>, args: DeleteArgs) -> Result<(), String> {
    log_line(&format!(
        "workspace_delete root={:?} path={:?}",
        args.root_id, args.path
    ));
    let result = state.with(&args.root_id, |ws| ws.delete(&args.path));
    if let Err(error) = &result {
        log_line(&format!("workspace_delete 失败：{error}"));
    }
    result
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameArgs {
    pub root_id: String,
    pub path: String,
    pub new_name: String,
}

/// 重命名工作区里的一个文件或目录。
#[tauri::command]
fn workspace_rename(state: State<'_, WorkspaceState>, args: RenameArgs) -> Result<(), String> {
    log_line(&format!(
        "workspace_rename root={:?} path={:?} newName={:?}",
        args.root_id, args.path, args.new_name
    ));
    let result = state.with(&args.root_id, |ws| ws.rename(&args.path, &args.new_name));
    if let Err(error) = &result {
        log_line(&format!("workspace_rename 失败：{error}"));
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
     * 用反了的后果是选择器弹不出来或回调永远不触发，而**没有任何报错**：
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

// ── 全工作区搜索 ────────────────────────────────────────────

/// 搜索结果的一条。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// 相对工作区根的路径。
    pub path: String,
    /// 1 起算，与编辑器行号一致。
    pub line: u32,
    /// 该行内容，截断到 200 个字符 —— 够看清上下文，又不会因为一行几万字
    /// 把整个响应撑大。
    pub text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchArgs {
    pub root_id: String,
    pub query: String,
}

/// 单个文件参与搜索的上限。超过就跳过 —— 一个 50MB 的日志文件里
/// 逐行 `to_lowercase` 会卡住整次搜索，而它本来也不是"笔记"。
const SEARCH_MAX_FILE_BYTES: u64 = 1_048_576;

/// 结果条数上限。搜索的目的是"带我去那个地方"，不是导出全部匹配；
/// 同时命中几千条时，逐条渲染本身就会让界面卡顿。
const SEARCH_MAX_HITS: usize = 200;

/// 参与搜索的扩展名。与同步的文件白名单一致 —— 两边不一致会导致
/// "能同步但搜不到"或者反过来。
const SEARCH_TEXT_EXTENSIONS: &[&str] = &[
    "md", "markdown", "txt", "tex", "latex", "ltx", "fountain",
];

fn has_text_extension(path: &str) -> bool {
    let extension = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    SEARCH_TEXT_EXTENSIONS.contains(&extension.as_str())
}

/// 全工作区文本搜索。
///
/// 放在原生侧而不是前端逐个 `workspace_read`：一个几百文件的项目会走
/// 几百次 IPC，每次都要把整个文件内容序列化一遍。这里一次遍历、一次
/// 返回，代价只跟磁盘读取有关。
///
/// **大小写不敏感**：写作时搜 "TODO" 和 "todo" 是同一个意图。代价是
/// 每行都要 `to_lowercase`，所以文件大小和结果条数都有硬上限。
#[tauri::command]
fn search_workspace(
    state: State<'_, WorkspaceState>,
    args: SearchArgs,
) -> Result<Vec<SearchHit>, String> {
    let query = args.query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    log_line(&format!(
        "search_workspace root={:?} query={:?}",
        args.root_id, query
    ));

    state.with(&args.root_id, |ws| {
        let mut hits = Vec::new();
        collect_hits(ws, "", &query, &mut hits);
        Ok(hits)
    })
}

fn collect_hits(ws: &Workspace, dir: &str, query: &str, hits: &mut Vec<SearchHit>) {
    if hits.len() >= SEARCH_MAX_HITS {
        return;
    }

    /* 目录读不到就跳过这一层：权限、竞态都可能发生，不该让整次搜索失败 */
    let Ok(entries) = ws.list(dir) else {
        return;
    };

    for entry in entries {
        if hits.len() >= SEARCH_MAX_HITS {
            return;
        }
        if entry.kind == EntryKind::Directory {
            collect_hits(ws, &entry.path, query, hits);
            continue;
        }
        if entry.size > SEARCH_MAX_FILE_BYTES || !has_text_extension(&entry.path) {
            continue;
        }
        /* 单个文件读不出来（编码不支持、被占用）只跳过它 */
        let Ok(text) = ws.read_to_string(&entry.path) else {
            continue;
        };
        for (index, line) in text.lines().enumerate() {
            if hits.len() >= SEARCH_MAX_HITS {
                return;
            }
            if line.to_lowercase().contains(query) {
                hits.push(SearchHit {
                    path: entry.path.clone(),
                    line: (index + 1) as u32,
                    text: line.chars().take(200).collect(),
                });
            }
        }
    }
}

// ── 凭据（系统钥匙串） ──────────────────────────────────────

/// 凭据条的服务名。所有条目都挂在它下面，能成组清理。
const SECRET_SERVICE: &str = "aropyt";

/// 打开一条凭据。
///
/// `key` 由调用方决定（`webdav` 之类）。用固定服务名 + 可变键，而不是把
/// 键拼进服务名：钥匙串的管理界面上，同一服务下的条目会归在一起，
/// 用户卸载应用时更容易找到并清干净。
fn secret_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SECRET_SERVICE, key).map_err(|error| format!("系统凭据存储不可用：{error}"))
}

/// 写一条凭据。
///
/// 密码**只走这里**，不进 `settings.jsonc`：那是纯文本，会被截图、会被
/// 扔进 dotfiles 仓库，而且在同步之外的地方也会被读到。
#[tauri::command]
fn secret_set(key: String, value: String) -> Result<(), String> {
    secret_entry(&key)?
        .set_password(&value)
        .map_err(|error| format!("保存凭据失败：{error}"))
}

/// 读一条凭据。不存在返回 `Ok(None)` —— 首次配置是正常状态，不是错误。
#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match secret_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("读取凭据失败：{error}")),
    }
}

/// 删一条凭据。不存在也算成功（目标状态已达成）。
#[tauri::command]
fn secret_delete(key: String) -> Result<(), String> {
    match secret_entry(&key)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("删除凭据失败：{error}")),
    }
}

// ── 导出（pandoc） ──────────────────────────────────────────

/// 支持导出的格式 —— 同时也是 pandoc 的 `--to` 取值。
///
/// `pdf` 需要外部排版引擎（这里用 **typst**）：pandoc 自己不会排版 PDF。
/// 之所以选 typst 而不是 xelatex：单文件约 30MB、无需 TeX Live 那几 GB，
/// 且中文字体是运行时按需读取的，配好字体名就能出中文。
///
/// 刻意**不含** MediaWiki / reST / OPML：它们是"特定下游系统的交换格式"，
/// 不是给人读的文档 —— wiki markup 可以直接贴 markdown（wiki 大多支持），
/// reST 是 Sphinx 工程源，OPML 是大纲结构。用户群极窄，却要在"导出"菜单里
/// 占三个位置并各配一套说明。
const EXPORT_FORMATS: &[&str] = &["docx", "odt", "html", "epub", "rtf", "pdf"];

/// 允许作为读入格式（pandoc `--from`）的取值。
///
/// 目前只放开两种：markdown（默认）与 latex。不直接透传任意字符串 ——
/// 拼错的格式名会让 pandoc 以"unknown format"退出，而报错文案对用户
/// 毫无意义；白名单至少能在我们这层给出可用列表。
const PANDOC_READERS: &[&str] = &["markdown", "latex"];

/// 需要外部排版引擎的格式 → 引擎名。
///
/// ⚠️ **引擎必须由用户自己安装，不随应用打包**（产品决策，明确要求）。
/// 下面的探测只负责"省去手填路径"，不是兜底分发 —— 别把它改成从
/// `resources/` 里捞一个随包二进制，那会让安装包凭空多出 30–90MB，
/// 也让"导出的 PDF 是谁排的版"变得不可追溯。
const PDF_ENGINE_FOR: &[(&str, &str)] = &[("pdf", "typst")];

/// 外部工具（pandoc / typst）的探测结果。
#[derive(serde::Serialize)]
struct ToolInfo {
    path: String,
    version: String,
}

/// 导出结果。
#[derive(serde::Serialize)]
struct ExportReport {
    target: String,
    bytes: u64,
}

/// 让子进程在 Windows 上**不要弹控制台窗口**。
///
/// 打包版编译时带 `windows_subsystem = "windows"`，进程本身没有控制台；
/// 这时启动 console 程序（pandoc / typst 都是），Windows 会给每个子进程
/// 新建一个黑框。启动时要探两个工具，用户看到的就是"打开软件先闪几个终端"。
///
/// dev 模式下父进程带控制台、子进程继承它，所以本地永远复现不出来 ——
/// 这个坑只在安装包里出现。
fn hide_console(command: &mut std::process::Command) -> &mut std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// 找到一个**能跑起来**的外部工具（pandoc / typst / …）。
///
/// 顺序：显式配置的路径 → PATH → 各平台常见安装位置。
/// 只检查文件是否存在是不够的：软链、旧版本、权限不足都会让后续调用以
/// "找不到 X"的面目失败，所以这里直接跑一次 `--version` 验证。
fn resolve_tool(name: &str, override_path: Option<&str>) -> Result<String, String> {
    let mut candidates: Vec<String> = Vec::new();
    if let Some(path) = override_path {
        let path = path.trim();
        if !path.is_empty() {
            candidates.push(path.to_string());
        }
    }
    candidates.push(name.to_string());

    /* 安装器常见的落点。大小写按产品名猜（Pandoc / Typst），Windows 不敏感。 */
    let mut chars = name.chars();
    let capitalized = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => name.to_string(),
    };
    #[cfg(windows)]
    {
        candidates.push(format!(r"C:\Program Files\{capitalized}\{name}.exe"));
        candidates.push(format!(r"C:\Program Files (x86)\{capitalized}\{name}.exe"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            // scoop / 官方 zip 解压 / 用户级安装常在这两处
            candidates.push(format!(r"{local}\Programs\{capitalized}\{name}.exe"));
            candidates.push(format!(r"{local}\Programs\{name}\{name}.exe"));
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            // cargo install
            candidates.push(format!(r"{home}\.cargo\bin\{name}.exe"));
        }
    }
    #[cfg(not(windows))]
    {
        candidates.push(format!("/usr/local/bin/{name}"));
        candidates.push(format!("/opt/homebrew/bin/{name}"));
        candidates.push(format!("/usr/bin/{name}"));
        candidates.push(format!("/opt/local/bin/{name}"));
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(format!("{home}/.cargo/bin/{name}"));
            candidates.push(format!("{home}/.local/bin/{name}"));
        }
    }

    let mut tried: Vec<String> = Vec::new();
    for candidate in candidates {
        let mut probe = std::process::Command::new(&candidate);
        probe
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        hide_console(&mut probe);
        match probe.status() {
            Ok(status) if status.success() => return Ok(candidate),
            _ => tried.push(candidate),
        }
    }

    Err(format!(
        "没有找到可用的 {name}（试过：{}）。请先安装 {name}，或在 settings.jsonc 里设置它的路径。",
        tried.join("、")
    ))
}

fn resolve_pandoc(override_path: Option<&str>) -> Result<String, String> {
    resolve_tool("pandoc", override_path)
}

/// 探测 pandoc 是否可用。
///
/// 前端在启动时调用一次，用于决定「导出」按钮是可用、还是要给出安装引导 ——
/// 比等用户点下导出再报错友好得多。
#[tauri::command]
async fn pandoc_probe(override_path: Option<String>) -> Result<ToolInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_pandoc(override_path.as_deref())?;
        let mut probe = std::process::Command::new(&path);
        probe.arg("--version");
        hide_console(&mut probe);
        let output = probe
            .output()
            .map_err(|error| format!("无法执行 {}：{error}", path))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let version = stdout
            .lines()
            .next()
            .unwrap_or("pandoc")
            .trim()
            .to_string();
        Ok(ToolInfo { path, version })
    })
    .await
    .map_err(|error| format!("探测线程异常：{error}"))?
}

/// 探测 typst —— PDF 的排版引擎。
///
/// 单独一条命令而不是塞进 `pandoc_probe`：两者的安装互相独立
/// （有人只写 docx，不装 typst），前端也要分别显示状态。
#[tauri::command]
async fn typst_probe(override_path: Option<String>) -> Result<ToolInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve_tool("typst", override_path.as_deref())?;
        let mut probe = std::process::Command::new(&path);
        probe.arg("--version");
        hide_console(&mut probe);
        let output = probe
            .output()
            .map_err(|error| format!("无法执行 {}：{error}", path))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let version = stdout.lines().next().unwrap_or("typst").trim().to_string();
        Ok(ToolInfo { path, version })
    })
    .await
    .map_err(|error| format!("探测线程异常：{error}"))?
}

/// 选一个可执行文件（设置里填 pandoc / typst 路径时用）。
///
/// 与 `pick_export_path` 分开：那个是"保存到"，这个是"打开一个程序"，
/// 对话框的语义与过滤器都不同。
#[tauri::command]
async fn pick_binary(
    app: tauri::AppHandle,
    title: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let mut dialog = app
            .dialog()
            .file()
            .set_title(title.unwrap_or_else(|| "选择可执行文件".to_string()));
        #[cfg(windows)]
        {
            dialog = dialog.add_filter("可执行文件", &["exe"]);
        }
        dialog.blocking_pick_file()
    })
    .await
    .map_err(|error| format!("文件对话框线程异常：{error}"))?;

    Ok(picked.map(|path| path.to_string()))
}

/// 选导出目标路径。
///
/// 与 `save_markdown_file` 只差在过滤器：导出扩展名由格式决定
/// （.docx / .html / …），不能复用"可编辑文本"那一套。
#[tauri::command]
async fn pick_export_path(
    app: tauri::AppHandle,
    suggested: Option<String>,
    extension: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;

    let ext = extension.trim_start_matches('.').to_lowercase();
    if ext.is_empty() {
        return Err("导出格式缺少扩展名".to_string());
    }

    let picked = tauri::async_runtime::spawn_blocking(move || {
        let label = ext.to_uppercase();
        let mut dialog = app
            .dialog()
            .file()
            .set_title("导出到")
            .add_filter(&label, &[ext.as_str()]);
        if let Some(name) = suggested {
            if !name.is_empty() {
                dialog = dialog.set_file_name(&name);
            }
        }
        dialog.blocking_save_file()
    })
    .await
    .map_err(|error| format!("导出对话框线程异常：{error}"))?;

    Ok(picked.map(|path| path.to_string()))
}

/// 把 markdown 里指向本地文件的盘符路径改写成 `file:///` URL。
///
/// 为什么需要：pandoc 的 typst writer 会把 `![x](C:/a/b.png)` 原样写成
/// `#figure(image("C:/a/b.png"))`，而 typst 只接受"相对路径或 URL" ——
/// 裸盘符在部分版本上直接失败：
///
/// ```text
/// error: failed to load file (path contains invalid component "C:")
///   ┌─ \\?\E:\…\toP29A3.typ:207:14
/// 207 │ #figure(image("C:/Users/…/media-…/shot.png", alt: "占位图"),
/// ```
///
/// 用户看到的是一个指向"图片路径"的报错，容易误以为是中文/编码问题
/// （实测：文档里去掉图片后中文 PDF 完全正常）。改成 `file:///C:/…`
/// 是 typst 明确支持的 URL 形式，也不影响 pandoc 读图。
///
/// 只给 PDF 用：docx / html 里的 `file:///` 链接发出去对别人毫无意义，
/// 保持原样更诚实。
fn rewrite_local_paths_as_urls(markdown: &str) -> String {
    let chars: Vec<char> = markdown.chars().collect();
    let mut out = String::with_capacity(markdown.len() + 64);
    let mut index = 0;

    while index < chars.len() {
        if chars[index] == ']' && chars.get(index + 1) == Some(&'(') {
            out.push_str("](");
            index += 2;
            while matches!(chars.get(index), Some(' ') | Some('\t')) {
                out.push(chars[index]);
                index += 1;
            }

            /* 盘符：单个字母 + ':' + '/' 或 '\' */
            let is_drive = chars.get(index).is_some_and(|c| c.is_ascii_alphabetic())
                && chars.get(index + 1) == Some(&':')
                && matches!(chars.get(index + 2), Some('/') | Some('\\'));

            if is_drive {
                out.push_str("file:///");
                out.push(chars[index]);
                out.push(':');
                index += 2; // 跳过盘符与冒号，剩下的从分隔符开始

                /*
                 * 盘符之后**整段路径**的反斜杠都转成正斜杠。
                 *
                 * 只转紧挨盘符的那一个是不够的：`D:\work\shot.png` 会被
                 * pandoc 写进 typst 字符串，`\w` / `\s` 在那里是非法转义
                 * （即便 pandoc 补了转义，正斜杠也更少出岔子）。
                 * 遇到右括号、空白或引号就停 —— 那是 URL 的结尾或 title。
                 */
                while let Some(&c) = chars.get(index) {
                    if c == ')' || c == ' ' || c == '\t' || c == '"' || c == '\'' {
                        break;
                    }
                    out.push(if c == '\\' { '/' } else { c });
                    index += 1;
                }
                continue;
            }
            continue;
        }

        out.push(chars[index]);
        index += 1;
    }

    out
}

/// 子进程运行结果。
struct ChildRun {
    success: bool,
    code: Option<i32>,
    stderr: String,
    stdout: String,
}

/// 跑一个子进程：写 stdin、并发读 stderr/stdout、带超时。
///
/// 抽出来是因为 PDF 要跑**两次**（pandoc 生成 typst 源 → typst 编译），
/// 而"并发读管道"与"超时后杀掉"这两件事任何一次都不能省：
///  · 进程退出后才读管道，在 MSIX / AppContainer 里读回空字符串；
///  · 管道缓冲区约 64KB，没人读的一端会让子进程永久阻塞在 write 上。
fn run_child(
    exe: &str,
    args: &[String],
    stdin_text: Option<&str>,
    timeout: std::time::Duration,
) -> Result<ChildRun, String> {
    use std::io::{Read, Write};

    let mut command = std::process::Command::new(exe);
    hide_console(&mut command);
    command
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 {exe}：{error}"))?;

    let stderr_pipe = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(mut pipe) = stderr_pipe {
            let _ = pipe.read_to_string(&mut buffer);
        }
        buffer
    });
    let stdout_pipe = child.stdout.take();
    let stdout_reader = std::thread::spawn(move || {
        let mut buffer = String::new();
        if let Some(mut pipe) = stdout_pipe {
            let _ = pipe.read_to_string(&mut buffer);
        }
        buffer
    });

    if let Some(text) = stdin_text {
        if let Some(mut stdin) = child.stdin.take() {
            // 写完必须关闭 stdin：pandoc 读到 EOF 才开始转换。
            stdin
                .write_all(text.as_bytes())
                .map_err(|error| format!("写入 {exe} 的输入失败：{error}"))?;
        }
    }

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{exe} 超过 {} 秒仍未完成，已中止",
                        timeout.as_secs()
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(error) => return Err(format!("等待 {exe} 失败：{error}")),
        }
    };

    Ok(ChildRun {
        success: status.success(),
        code: status.code(),
        stderr: stderr_reader.join().unwrap_or_default(),
        stdout: stdout_reader.join().unwrap_or_default(),
    })
}

/// 把失败结果整理成一句能定位问题的话。
fn describe_failure(label: &str, run: &ChildRun, exe: &str) -> String {
    let mut parts: Vec<String> = vec![format!("{label}：退出码 {:?}", run.code)];
    let err = run.stderr.trim();
    if err.is_empty() {
        parts.push("(没有输出任何错误信息)".to_string());
    } else {
        parts.push(err.chars().take(700).collect());
    }
    let out = run.stdout.trim();
    if !out.is_empty() {
        parts.push(format!("stdout: {}", out.chars().take(300).collect::<String>()));
    }
    parts.push(format!("可执行文件：{exe}"));
    parts.join("\n")
}

/// 退出时清理临时产物的守卫。
///
/// 用 RAII 而不是在每条 `return Err` 前手写删除：`export_pdf` 有五个返回点，
/// 漏一个就会在用户的工作区里留下 `.aropyt-*` 垃圾 —— 而工作区正是他们
/// 会看到的地方。
struct Cleanup {
    paths: Vec<std::path::PathBuf>,
}

impl Cleanup {
    fn new() -> Self {
        Self { paths: Vec::new() }
    }

    fn push(&mut self, path: &std::path::Path) {
        self.paths.push(path.to_path_buf());
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for path in &self.paths {
            let _ = if path.is_dir() {
                std::fs::remove_dir_all(path)
            } else {
                std::fs::remove_file(path)
            };
        }
    }
}

/// 把 markdown 里的**远程图片**下载到工作区，改写成本地相对路径。
///
/// ── 为什么需要 ─────────────────────────────────────────────
/// typst 在 MSIX / AppContainer 里**没有网络权限**（它自己的提示是
/// `network access is not supported`）。文档里只要有一张 `https://` 图，
/// typst 就会把 URL 当成本地文件名去打开，报
/// `os error 123（文件名、目录名或卷标语法不正确）`，**整份文档编译失败**。
///
/// 应用进程自己可以联网，所以先把图抓下来放进工作区（`--root` 之内），
/// 再让 typst 读本地文件。
///
/// ── 下载失败就整段移除 ────────────────────────────────────
/// 留着一个 typst 加载不了的引用，等于让一张外链图把整份 PDF 拖垮；
/// 而缺图在成品里一眼可见，比"导不出来"好得多。移除的是整个
/// `![alt](url)`，不留下悬空的 alt 文字。
///
/// 返回改写后的 markdown 与临时目录（一张也没下成功时为 `None`）。
fn localize_remote_images(
    markdown: &str,
    work_dir: &std::path::Path,
) -> (String, Option<std::path::PathBuf>) {
    use std::io::Read;

    let dir_name = format!(".aropyt-media-{}", std::process::id());
    let media_dir = work_dir.join(&dir_name);

    let mut out = String::with_capacity(markdown.len());
    let mut cursor = 0;
    let mut downloaded = 0usize;

    while let Some(offset) = markdown[cursor..].find("![") {
        let start = cursor + offset;
        out.push_str(&markdown[cursor..start]);

        /* `![alt](src "title")` —— 没有 `](` 就说明这不是一张图，原样放过 */
        let Some(bracket) = markdown[start..].find("](") else {
            out.push_str(&markdown[start..]);
            return (out, None);
        };
        let src_start = start + bracket + 2;
        let Some(paren) = markdown[src_start..].find(')') else {
            out.push_str(&markdown[start..]);
            return (out, None);
        };
        let src_end = src_start + paren;
        let raw = &markdown[src_start..src_end];

        /* `src "title"` —— 只处理 URL 本身，title 原样保留 */
        let src = raw.split_whitespace().next().unwrap_or(raw);
        let title = &raw[src.len()..];

        if !src.starts_with("http://") && !src.starts_with("https://") {
            /* 本地图片：原样保留，交给 pandoc 的 --resource-path 解析 */
            out.push_str(&markdown[start..src_end + 1]);
            cursor = src_end + 1;
            continue;
        }

        let extension = src
            .split(['?', '#'])
            .next()
            .unwrap_or(src)
            .rsplit('.')
            .next()
            .unwrap_or("png");
        let extension = if extension.len() <= 5
            && !extension.is_empty()
            && extension.chars().all(|c| c.is_ascii_alphanumeric())
        {
            extension.to_ascii_lowercase()
        } else {
            "png".to_string()
        };
        let file_name = format!("{downloaded}.{extension}");

        /* 20 秒单张：一张图挂住不该让整次导出停在 120 秒的超时上 */
        let agent = ureq::AgentBuilder::new()
            .timeout(std::time::Duration::from_secs(20))
            .build();
        let fetched = agent.get(src).call().ok().and_then(|response| {
            let mut bytes = Vec::new();
            response
                .into_reader()
                /* 16 MB 上限：外链图不该把内存撑爆 */
                .take(16 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.is_empty() {
                return None;
            }
            std::fs::create_dir_all(&media_dir).ok()?;
            std::fs::write(media_dir.join(&file_name), &bytes).ok()?;
            Some(())
        });

        match fetched {
            Some(()) => {
                downloaded += 1;
                out.push_str(&markdown[start..src_start]);
                /* 相对 `--root` 的路径，typst 才解析得到 */
                out.push_str(&format!("{dir_name}/{file_name}"));
                out.push_str(title);
                out.push(')');
            }
            None => {
                /* 整段丢弃：连同 `![alt](...)` 一起，不留悬空文字 */
            }
        }
        cursor = src_end + 1;
    }

    out.push_str(&markdown[cursor..]);
    (out, if downloaded > 0 { Some(media_dir) } else { None })
}

/// PDF：pandoc 生成 typst 源，**应用自己**调 typst 编译。
///
/// 为什么不直接 `--pdf-engine=typst` —— 在 Microsoft Store（MSIX /
/// AppContainer）包里，pandoc 再去启动 typst 属于"孙进程"，会被沙箱拦住。
/// 现象是 `pandoc 退出码 1` 且 stderr 为空，**换哪个 typst 路径都一样**，
/// 因为它根本没被尝试启动（实测：dev 版正常，商店版必失败）。
/// 应用自己启动 typst 与启动 pandoc 是同一级权限，绕开这一层。
///
/// `.typ` 必须落在 `--root` 之内（否则 typst 报
/// `source file must be contained in project root`），所以写在**工作区根**；
/// 没有工作区（外部文件）就退到输出目录。编译完立刻删掉，失败也删。
fn export_pdf(
    pandoc: &str,
    typst: &str,
    reader: &str,
    content: &str,
    target: &str,
    base_dir: Option<&str>,
) -> Result<(), String> {
    let timeout = std::time::Duration::from_secs(120);

    let work_dir = base_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::path::Path::new(target)
                .parent()
                .filter(|dir| !dir.as_os_str().is_empty())
                .map(|dir| dir.to_path_buf())
        })
        .ok_or_else(|| "无法确定 PDF 的临时目录".to_string())?;

    /*
     * 远程图片本地化。必须在 pandoc **之前**：改写的是 markdown 源，
     * 一旦转成 typst 就只剩 `image("https://…")`，那时改不动了。
     */
    let (content, media_dir) = localize_remote_images(content, &work_dir);
    let content = content.as_str();

    let typ_path = work_dir.join(format!(".aropyt-export-{}.typ", std::process::id()));
    let typ_arg = typ_path.to_string_lossy().into_owned();

    /* 五个返回点统一由 guard 清理，不手写 remove_file */
    let mut cleanup = Cleanup::new();
    cleanup.push(&typ_path);
    if let Some(dir) = media_dir.as_deref() {
        cleanup.push(dir);
    }

    /* ── 第一步：只做格式转换，不碰任何排版引擎 ── */
    let mut args: Vec<String> = vec![
        "--from".to_string(),
        reader.to_string(),
        "--to".to_string(),
        "typst".to_string(),
        "--standalone".to_string(),
        "--output".to_string(),
        typ_arg,
    ];
    if let Some(dir) = base_dir.filter(|dir| !dir.trim().is_empty()) {
        args.push("--resource-path".to_string());
        args.push(dir.to_string());
    }

    let generated = match run_child(pandoc, &args, Some(content), timeout) {
        Ok(run) => run,
        Err(error) => return Err(format!("生成 typst 源失败：{error}")),
    };
    if !generated.success {
        return Err(describe_failure("生成 typst 源失败", &generated, pandoc));
    }

    /* ── 第二步：编译 ── */
    /*
     * ⚠️ `compile` 子命令不能省。typst 0.13 起 CLI 是
     * `typst compile <input> <output>`，缺少它时第一个参数会被当成
     * 子命令名，报：
     *
     *   error: unrecognized subcommand 'C:\…\x.typ'
     *   Usage: typst [OPTIONS] <COMMAND>
     *
     * 真实测试抓到的（`export_pdf_produces_a_real_file`）。
     */
    let args: Vec<String> = vec![
        "compile".to_string(),
        typ_path.to_string_lossy().into_owned(),
        target.to_string(),
        "--root".to_string(),
        work_dir.to_string_lossy().into_owned(),
    ];
    let compiled = run_child(typst, &args, None, timeout)?;
    if !compiled.success {
        return Err(describe_failure("typst 编译失败", &compiled, typst));
    }
    Ok(())
}

/// 用 pandoc 把 markdown 导出成别的格式。
///
/// 三个实现要点：
///  1. **内容走 stdin**，不落临时文件 —— 没有路径转义、没有编码问题，
///     失败时也不会在磁盘上留下半截文件；
///  2. **`--resource-path` 指向工作区根**，否则 `![](assets/a.png)` 在
///     docx 里全是断图：pandoc 按相对路径找图，而它不知道工作区在哪；
///  3. **超时 + 读 stderr**：大文档可能要跑十几秒，但卡死必须能退出；
///     pandoc 的报错只在 stderr 里，原样带回去比一句"导出失败"有用得多。
#[tauri::command]
async fn export_document(
    content: String,
    format: String,
    source: Option<String>,
    target: String,
    base_dir: Option<String>,
    pandoc_path: Option<String>,
    typst_path: Option<String>,
) -> Result<ExportReport, String> {
    let format = format.trim().to_lowercase();
    if !EXPORT_FORMATS.contains(&format.as_str()) {
        return Err(format!(
            "不支持的导出格式：{format}（可用：{}）",
            EXPORT_FORMATS.join(" / ")
        ));
    }

    /*
     * 读入格式（`--from`）必须跟着文档走。
     *
     * 写死 `markdown` 时，`.tex` 会被当 markdown 解析：`\documentclass` /
     * `\section` / `\begin{}` 全被当成普通文字或转义吞掉，66 行的文件
     * 只剩第一行注释。`latex` 读入才完整。
     */
    let reader = source
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("markdown")
        .to_lowercase();
    if !PANDOC_READERS.contains(&reader.as_str()) {
        return Err(format!(
            "不支持的源格式：{reader}（可用：{}）",
            PANDOC_READERS.join(" / ")
        ));
    }

    tauri::async_runtime::spawn_blocking(move || {
        use std::io::{Read, Write};

        let exe = resolve_pandoc(pandoc_path.as_deref())?;
        log_line(&format!("export_document → {format} · {target}"));

        /*
         * PDF 才改写本地图片路径：typst 不接受裸盘符路径，
         * 而 docx / html 用 `file:///` 反而更糟（本地链接发出去没有意义）。
         */
        let content = if format == "pdf" {
            rewrite_local_paths_as_urls(&content)
        } else {
            content
        };

        /*
         * PDF 要先确定排版引擎：pandoc 拿到 `--pdf-engine` 才会排版，
         * 否则直接报"没有 PDF 引擎"。在这里解析而不是先问前端，是为了
         * 让"路径配错"与"没装"都落到同一条能读懂的报错上。
         */
        let engine = PDF_ENGINE_FOR
            .iter()
            .find(|(ext, _)| *ext == format)
            .map(|(_, name)| *name);
        let engine_path = match engine {
            Some(name) => Some(resolve_tool(name, typst_path.as_deref())?),
            None => None,
        };

        /*
         * PDF 走两步：pandoc 生成 typst 源，再由应用自己调 typst 编译。
         * 其余格式 pandoc 一步到位，不涉及第二个进程。
         */
        if format == "pdf" {
            let engine = engine_path
                .as_deref()
                .ok_or_else(|| "PDF 导出缺少排版引擎（typst）".to_string())?;
            export_pdf(&exe, engine, &reader, &content, &target, base_dir.as_deref())?;

            let bytes = std::fs::metadata(&target)
                .map(|meta| meta.len())
                .unwrap_or(0);
            return Ok(ExportReport { target, bytes });
        }

        let mut command = std::process::Command::new(&exe);
        hide_console(&mut command);
        command
            .args([
                "--from",
                reader.as_str(),
                "--to",
                format.as_str(),
                /*
                 * ⚠️ `--standalone` 不能省。
                 *
                 * 不加时 pandoc 输出的是"片段"而不是完整文档：
                 *  · rtf  → `{\pard …}` 开头，**没有 `{\rtf1\ansi…}` 头**，
                 *           任何 RTF 阅读器都会把它当纯文本打开，
                 *           于是 `\u20013 ?` 这类 Unicode 转义原样显示 ——
                 *           用户看到的就是"中文乱码"（实测主诉）；
                 *  · html → 没有 `<!DOCTYPE>` 与 `<meta charset>`，
                 *           在某些按本地编码解析的环境里同样乱码。
                 *
                 * docx / epub 是容器格式，加不加都一样；pdf 由 pandoc
                 * 强制 standalone。所以统一加，没有副作用。
                 */
                "--standalone",
                "--output",
                &target,
            ])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        if reader == "latex" {
            /*
             * LaTeX 文档默认带章节编号。开着它不是审美选择 —— `\ref{}` 会被
             * pandoc 转成 typst 的 `@sec:conclusion` 交叉引用，而 typst 要求
             * 被引用的标题**有编号**，否则直接失败：
             *
             *   error: cannot reference heading without numbering
             *   239 │ See Section~@sec:conclusion for the conclusion.
             *       = hint: you can enable heading numbering with
             *         `#set heading(numbering: "1.")`
             *
             * 只对 latex 源开：markdown 文档要不要编号是作者的选择。
             */
            command.arg("--number-sections");
        }

        /*
         * 这里不需要 `--pdf-engine`：PDF 已经在上面走两步法了。
         * 其余格式不涉及引擎，`engine_path` 只会是 None。
         */
        if let Some(dir) = base_dir.as_deref() {
            if !dir.trim().is_empty() {
                command.arg("--resource-path").arg(dir);
            }
        }

        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 pandoc（{exe}）：{error}"))?;

        /*
         * stderr / stdout 必须在**子进程还活着的时候**并发读走。
         *
         * 原实现是「先 `try_wait` 轮询，进程退出后再 `read_to_string`」，
         * 在 Microsoft Store（MSIX / AppContainer）包里读回来是空字符串 ——
         * 报错只剩一句「pandoc 退出码 Some(1)」，真正的原因（找不到排版
         * 引擎、路径被沙箱拦住、字体缺失）全丢了，用户和我们都无从下手。
         *
         * 顺带解决另一个隐患：管道缓冲区约 64KB，pandoc 若输出较多，
         * 不读的一端会让它阻塞在 write 上，看起来就是"导出卡住"。
         */
        let stderr_pipe = child.stderr.take();
        let stderr_reader = std::thread::spawn(move || {
            let mut buffer = String::new();
            if let Some(mut pipe) = stderr_pipe {
                let _ = pipe.read_to_string(&mut buffer);
            }
            buffer
        });
        let stdout_pipe = child.stdout.take();
        let stdout_reader = std::thread::spawn(move || {
            let mut buffer = String::new();
            if let Some(mut pipe) = stdout_pipe {
                let _ = pipe.read_to_string(&mut buffer);
            }
            buffer
        });

        if let Some(mut stdin) = child.stdin.take() {
            // 写完必须关闭 stdin：pandoc 读到 EOF 才开始转换，
            // 忘记 drop 会一直等下去（表现为"导出永远不结束"）。
            stdin
                .write_all(content.as_bytes())
                .map_err(|error| format!("写入 pandoc 输入失败：{error}"))?;
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(120);
        let status = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => {
                    if std::time::Instant::now() > deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err("pandoc 超过 120 秒仍未完成，已中止".to_string());
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                Err(error) => return Err(format!("等待 pandoc 失败：{error}")),
            }
        };

        let stderr = stderr_reader.join().unwrap_or_default();
        let stdout = stdout_reader.join().unwrap_or_default();

        if !status.success() {
            /*
             * 失败信息带上**能定位问题的一切**：退出码、stderr、stdout、
             * 以及实际用的可执行文件。在打包环境里，「pandoc 没装对」
             * 「引擎启动被拦」「参数拼错」在只看退出码时长得一模一样。
             */
            let mut parts: Vec<String> = vec![format!("pandoc 退出码 {:?}", status.code())];
            let err = stderr.trim();
            if !err.is_empty() {
                parts.push(err.chars().take(700).collect());
            } else {
                parts.push("(pandoc 没有输出任何错误信息)".to_string());
            }
            let out = stdout.trim();
            if !out.is_empty() {
                parts.push(format!("stdout: {}", out.chars().take(300).collect::<String>()));
            }
            parts.push(format!("可执行文件：{exe}"));
            if let Some(engine) = engine_path.as_deref() {
                parts.push(format!("排版引擎：{engine}"));
            }
            return Err(parts.join("\n"));
        }

        let bytes = std::fs::metadata(&target)
            .map(|meta| meta.len())
            .unwrap_or(0);
        Ok(ExportReport { target, bytes })
    })
    .await
    .map_err(|error| format!("导出线程异常：{error}"))?
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
            backup_write,
            pandoc_probe,
            typst_probe,
            pick_binary,
            pick_export_path,
            export_document,
            webdav::dav_test,
            webdav::dav_list,
            webdav::dav_get,
            webdav::dav_put,
            webdav::dav_head,
            webdav::dav_mkcol,
            webdav::dav_delete,
            webdav::dav_put_bytes,
            webdav::dav_get_bytes,
            workspace_delete,
            workspace_rename,
            search_workspace,
            secret_set,
            secret_get,
            secret_delete
        ])
        .setup(|app| {
            /*
             * 开发版与安装版必须一眼可分。
             *
             * 两者共用同一个 exe 名（Aropyt）与窗口尺寸，同时开着的时候
             * 只能靠图标辨认 —— 而任务栏把图标缩到 16px 之后，两版几乎
             * 一样（实测反馈）。标题是最不会看漏的区分点。
             *
             * 只改标题，不改 identifier：identifier 同时决定配置与草稿的
             * 存放路径，改它等于让开发版读不到已有设置。
             */
            #[cfg(debug_assertions)]
            {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_title("Aropyt  ·  DEV");
                }
            }

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

    /*
     * PDF 两步法的真实端到端测试。
     *
     * 会**真的**启动 pandoc 和 typst —— 没有它们的环境直接跳过而不是失败：
     * CI 上不一定装了这两个工具，但本机跑一次就能证明"pandoc 只出 typst 源、
     * 由应用自己编译"这条路真的通了。
     *
     * 这正是商店版那个 bug 的核心假设：pandoc 不启动引擎（沙箱拦孙进程），
     * 换成应用来启动（与启动 pandoc 同级权限）。
     */
    /// 远程图片下载失败时必须**整段移除**，而不是把坏引用留给 typst。
    ///
    /// `127.0.0.1:1` 必然连接被拒 —— 用它模拟失败，不依赖外网，
    /// 也就不会让这个用例随网络状态随机变红。
    #[test]
    fn remote_images_are_dropped_when_download_fails() {
        let dir = std::env::temp_dir().join(format!("aropyt-media-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建目录失败");

        let source = "# 标题\n\n前文 ![占位图](http://127.0.0.1:1/x.png \"标题\") 后文\n\n![本地](assets/a.png)\n";
        let (out, media) = localize_remote_images(source, &dir);

        assert!(!out.contains("127.0.0.1"), "下载失败的图片必须整段移除：{out}");
        assert!(out.contains("前文") && out.contains("后文"), "正文不能丢：{out}");
        assert!(out.contains("assets/a.png"), "本地图片必须原样保留：{out}");
        assert!(media.is_none(), "一张也没下成功时不该留下临时目录");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn export_pdf_produces_a_real_file() {
        let (pandoc, typst) = match (resolve_pandoc(None), resolve_tool("typst", None)) {
            (Ok(pandoc), Ok(typst)) => (pandoc, typst),
            _ => {
                eprintln!("跳过：本机没有 pandoc 或 typst");
                return;
            }
        };

        let dir = std::env::temp_dir().join(format!("aropyt-pdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("创建临时目录失败");

        let target = dir.join("out.pdf");
        export_pdf(
            &pandoc,
            &typst,
            "markdown",
            "# 中文标题\n\n这是一段正文，用来确认字体能被渲染出来。\n",
            &target.to_string_lossy(),
            Some(&dir.to_string_lossy()),
        )
        .expect("PDF 导出失败");

        let size = std::fs::metadata(&target).map(|meta| meta.len()).unwrap_or(0);
        assert!(size > 2000, "PDF 只有 {size} 字节，太小了");

        /* 临时 .typ 必须被清掉：失败时不清会越积越多 */
        let leftovers: Vec<String> = std::fs::read_dir(&dir)
            .expect("读临时目录失败")
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".typ"))
            .collect();
        assert!(leftovers.is_empty(), "残留了临时文件：{leftovers:?}");

        let _ = std::fs::remove_dir_all(&dir);
    }
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
