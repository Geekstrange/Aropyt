# MSIX 打包（微软商店提交用）

这个目录只管一件事：把 `tauri build --no-bundle` 的裸 exe 装进微软商店
能接收的包。**它不参与 GitHub Release 的常规产物**——那边的 Windows 包
仍然是 NSIS 的 `setup.exe`。

## 为什么不用 MSI/EXE 提交

| | MSI/EXE | MSIX |
|---|---|---|
| 代码签名 | 必须自己买证书（Azure Trusted Signing ≈ $10/月，OV 证书 $100–300/年） | 商店免费重签 |
| 托管 | 自己的 CDN / GitHub Release | 商店 CDN |
| 更新 | 自己做 | 商店推 |
| 安装形态 | 用户可选路径 | 固定装到 WindowsApps |

商店对 MSI/EXE **不重签**，所以那条路必须自备证书；MSIX 通过认证后由微软
用自家证书覆盖签名——这是选 MSIX 的全部理由。

## 本机构建

```powershell
# 1. 只要裸 exe，不要安装包
npm run tauri build -- --no-bundle

# 2. 各架构打 .msix（-Pdb 可选，给了才有崩溃分析数据）
./src-tauri/msix/pack.ps1 -Arch x64   -Exe src-tauri/target/release/Aropyt.exe `
                          -Pdb src-tauri/target/release/Aropyt.pdb
./src-tauri/msix/pack.ps1 -Arch arm64 -Exe src-tauri/target/aarch64-pc-windows-msvc/release/Aropyt.exe `
                          -Pdb src-tauri/target/aarch64-pc-windows-msvc/release/Aropyt.pdb

# 3. 合成 bundle 并包成提交件
./src-tauri/msix/bundle.ps1
```

产物都在 `src-tauri/target/msix/`：

```
Aropyt_0.1.5.0_x64.msix            中间产物
Aropyt_0.1.5.0_arm64.msix          中间产物
Aropyt_0.1.5.0_x64_arm64.msixbundle        中间产物
Aropyt_0.1.5.0_x64_arm64.appxsym           符号（有 pdb 才有）
Aropyt_0.1.5.0_x64_arm64.msixupload  ← 这个传给 Partner Center
```

需要 Windows 10 SDK 里的 `makeappx.exe`。脚本会自己在
`C:\Program Files (x86)\Windows Kits\10\bin\*` 下找版本号最大的那个；
装在别处就用环境变量 `MSIX_MAKEAPPX` 指定完整路径。

## 提交

Partner Center → 你的产品 → 提交 → **包** 页面 → 把 `.msixupload` 拖进去。

- **不要签名**。自己签了商店也会覆盖，白白多一道证书依赖。
- 首次提交一旦用了单 `.msix`，以后就只能一直用单 `.msix`；这里默认出
  bundle，正是为了不把自己锁进那条路。
- 提交后这个二进制就不能再改了。要重发就打新 tag。

## 身份

`identity.json` 里的四个值，前三个必须与 Partner Center **逐字符**一致：

```json
{
  "name": "Geekstrange.Aropyt",
  "publisher": "CN=0D2F5EE7-F423-4A55-9E5A-23548FCAD974",
  "displayName": "Aropyt",
  "publisherDisplayName": "Geekstrange"
}
```

- `publisher` 是账户级的值（Partner Center → 账户设置 → 开发者信息 →
  Windows publisher ID），不是你自己起的名字。大小写差一个字符，上传时就是
  "identity mismatch"，而报错不会告诉你是哪一位不同。
- **`displayName` 必须是已预留的应用名**，`publisherDisplayName` 是开发者名。
  这两个字段作用不同、校验也不同：前者对不上预留名，商店会报
  「此软件包的清单（Package/Properties/DisplayName）使用了你未保留的显示名称」；
  后者写开发者名即可，不校验预留。第一次提交就是因为两者混用被拒的。

## 几个已知的坑（都写在脚本注释里，这里只列清单）

1. 清单 `Version` 必须是四段：`0.1.5` → `0.1.5.0`，脚本自动补。
2. 清单必须 UTF-8 **无 BOM**，带 BOM 会报"根元素缺失"。
3. 子元素顺序由 schema 规定，`Capabilities` 必须在 `Applications` 之后。
4. 声明 `Square310x310Logo` 就必须同时给 `Wide310x150Logo`，所以这里不声明大图标。
5. MSIX 有注册表虚拟化：NSIS 安装器写注册表那套文件关联无效，
   关联必须写在清单的 `<uap:Extension>` 里（已对应 `bundle.fileAssociations`）。
6. 包内**不捆绑** WebView2 固定运行时（要 +150MB），依赖系统已装的 Evergreen 版；
   `MinVersion` 定在 10.0.19041.0 就是为此。

## 本地装上试跑

未签名的 MSIX 装不上，要么开开发者模式（仅限本机调试），要么用临时自签证书：

```powershell
$cert = New-SelfSignedCertificate -Type Custom -Subject "CN=0D2F5EE7-F423-4A55-9E5A-23548FCAD974" `
  -KeyUsage DigitalSignature -FriendlyName "Aropyt dev" `
  -CertStoreLocation "Cert:\CurrentUser\My" `
  -TextExtension @("2.5.29.37={text}1.3.6.1.5.5.7.3.3", "2.5.29.19={text}")
# 证书要进「受信任的根」，只进「受信任人」装不上
Export-Certificate -Cert $cert -FilePath aropyt-dev.cer
Import-Certificate -FilePath aropyt-dev.cer -CertStoreLocation Cert:\LocalMachine\Root
```

自签证书的 Subject 必须与清单 `Publisher` 完全一致，否则签名阶段就失败。
测完记得把证书从「受信任的根」里删掉。
