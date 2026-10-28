#Requires -Version 7.0
<#
.SYNOPSIS
  把单个架构的裸 exe 打成一个未签名的 .msix。

.DESCRIPTION
  Tauri 的 bundler 只出 NSIS/MSI，没有 msix target，所以这里自己组装：
  暂存目录（exe + 清单 + 图标）→ makeappx pack。

  产物**不要自己签名**：提交微软商店后由微软重签，自己签只会白折腾
  （而且要为此买证书）。本地想装上试跑才需要临时自签证书，见 README。

.PARAMETER Arch
  x64 或 arm64。必须与 exe 的编译目标一致，写错会在安装时报架构不匹配。

.PARAMETER Exe
  裸 exe 的路径（`tauri build --no-bundle` 的产物，**不是** setup.exe）。

.PARAMETER Pdb
  可选的符号文件。给了就一起收进 .appxsym，Partner Center 的崩溃分析才有数据。

.EXAMPLE
  ./pack.ps1 -Arch x64 -Exe ../../target/release/Aropyt.exe -Pdb ../../target/release/Aropyt.pdb
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidateSet('x64', 'arm64')][string]$Arch,
  [Parameter(Mandatory)][string]$Exe,
  [string]$Pdb,
  [string]$Version,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)

# ── 1. 身份与版本 ────────────────────────────────────────────
$identity = Get-Content (Join-Path $here 'identity.json') -Raw | ConvertFrom-Json

if (-not $Version) {
  $Version = (Get-Content (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
}

<#
  清单的 Version **必须**是四段（A.B.C.D），每段 ≤ 65535。
  `0.1.5` 会被 makeappx 直接拒，而且报错只说"版本格式无效"，
  于是每次发版都得有人想起来补个 `.0`。这里自动补齐。
#>
$parts = @($Version.Split('.'))
if ($parts.Count -gt 4) { throw "版本号最多四段，收到：$Version" }
while ($parts.Count -lt 4) { $parts += '0' }
foreach ($part in $parts) {
  if ($part -notmatch '^\d{1,5}$') { throw "版本段必须是纯数字：$part（来自 $Version）" }
  if ([int]$part -gt 65535) { throw "版本段不能超过 65535：$part（来自 $Version）" }
}
$packageVersion = $parts -join '.'

# ── 2. 找 makeappx ───────────────────────────────────────────
function Resolve-MakeAppx {
  if ($env:MSIX_MAKEAPPX -and (Test-Path $env:MSIX_MAKEAPPX)) { return $env:MSIX_MAKEAPPX }

  $roots = @(
    'C:\Program Files (x86)\Windows Kits\10\bin',
    'C:\Program Files\Windows Kits\10\bin'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path $root)) { continue }
    # 取版本号最大的 SDK：多个 SDK 并存时老版本可能不认识新 schema
    $sdks = Get-ChildItem $root -Directory | Sort-Object Name -Descending
    foreach ($sdk in $sdks) {
      foreach ($archDir in @('x64', 'x86')) {
        $candidate = Join-Path $sdk.FullName "$archDir\makeappx.exe"
        if (Test-Path $candidate) { return $candidate }
      }
    }
  }
  throw '找不到 makeappx.exe。装 Windows 10 SDK（含"Windows SDK for Desktop Apps"），或用 MSIX_MAKEAPPX 指定完整路径。'
}

$makeappx = Resolve-MakeAppx

# ── 3. 准备暂存目录 ──────────────────────────────────────────
if (-not $OutDir) { $OutDir = Join-Path $repo 'src-tauri/target/msix' }
$OutDir = [IO.Path]::GetFullPath($OutDir)
$stage = Join-Path $OutDir "stage-$Arch"
$assets = Join-Path $stage 'Assets'

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $assets | Out-Null

if (-not (Test-Path $Exe)) { throw "exe 不存在：$Exe`n先跑 `npm run tauri build -- --no-bundle`。" }

<#
  包内文件名固定成 Aropyt.exe —— 清单里的 Executable 指向它。
  不直接用源文件名，是因为 cargo 产物名会跟着 Cargo.toml 的 package name 变，
  而清单是静态文件，两边一旦不一致，装上去的应用双击没反应。
#>
Copy-Item $Exe (Join-Path $stage 'Aropyt.exe') -Force

<#
  磁贴图标在这里现生成，而不是复用 `src-tauri/icons/Square*Logo.png`。

  那两个文件是 `npx tauri icon` 的副产品，属于"生成器范围外"的残留
  （`npm run check:icons` 会因此报红），拿它们当商店资源的唯一来源，
  等于把发布链路挂在一个随时会被清理掉的目录上。
  从 icons/icon.png（make-icons.mjs 的正规产物）缩放，来源唯一且可重复。
#>
Add-Type -AssemblyName System.Drawing

function New-TileImage {
  param(
    [Parameter(Mandatory)][string]$Source,
    [Parameter(Mandatory)][int]$Size,
    [Parameter(Mandatory)][string]$Destination,
    [double]$ContentScale = 0.82
  )

  $image = [System.Drawing.Image]::FromFile($Source)
  try {
    $bitmap = New-Object System.Drawing.Bitmap $Size, $Size
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        # 透明底：磁贴的底色由清单的 BackgroundColor 决定，图片本身不留白边
        $graphics.Clear([System.Drawing.Color]::Transparent)
        <#
          缩到 82% 再居中，模拟 Windows 磁贴的安全边距。
          满幅贴边在 150x150 上会显得比别人"放大了一号"，
          而商店列表页是并排比较，观感差异很明显。
        #>
        $inner = [int][Math]::Round($Size * $ContentScale)
        $offset = [int][Math]::Floor(($Size - $inner) / 2)
        $graphics.DrawImage($image, $offset, $offset, $inner, $inner)
      } finally { $graphics.Dispose() }
      $bitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $bitmap.Dispose() }
  } finally { $image.Dispose() }
}

$logoSource = Join-Path $repo 'src-tauri/icons/icon.png'
if (-not (Test-Path $logoSource)) { throw "找不到源图标：$logoSource`n先跑 `npm run build:icons`。" }

New-TileImage -Source $logoSource -Size 50 -Destination (Join-Path $assets 'StoreLogo.png') -ContentScale 1.0
New-TileImage -Source $logoSource -Size 150 -Destination (Join-Path $assets 'Square150x150Logo.png')
New-TileImage -Source $logoSource -Size 44 -Destination (Join-Path $assets 'Square44x44Logo.png') -ContentScale 1.0

# ── 4. 渲染清单 ──────────────────────────────────────────────
$manifest = Get-Content (Join-Path $here 'AppxManifest.xml.template') -Raw
$manifest = $manifest.
  Replace('{{NAME}}', $identity.name).
  Replace('{{PUBLISHER}}', $identity.publisher).
  Replace('{{DISPLAY_NAME}}', $identity.publisherDisplayName).
  Replace('{{VERSION}}', $packageVersion).
  Replace('{{ARCH}}', $Arch)

<#
  注释要在打包前剥掉：模板里的注释是给维护者看的（包含"为什么"这类内部说明），
  没必要跟着安装包发给每一个用户，而且它们是清单体积里最没意义的那部分。
  用单行模式，否则跨行注释会只吃掉第一行、剩下的直接变成非法 XML。
#>
$manifest = [regex]::Replace($manifest, '<!--.*?-->', '', [System.Text.RegularExpressions.RegexOptions]::Singleline)
$manifest = $manifest -replace '(\r?\n){3,}', "`r`n`r`n"

if ($manifest -match '\{\{[A-Z_]+\}\}') {
  throw "清单模板里还有没替换的占位符：$($Matches[0])"
}

$manifestPath = Join-Path $stage 'AppxManifest.xml'
<#
  必须写 UTF-8 **不带 BOM**。makeappx 遇到 BOM 会在第一行报
  "清单无效：根元素缺失"，看起来像 XML 语法错，实际是编码问题。
#>
[IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))

# ── 5. 打包 ─────────────────────────────────────────────────
$msixPath = Join-Path $OutDir "Aropyt_${packageVersion}_$Arch.msix"
if (Test-Path $msixPath) { Remove-Item $msixPath -Force }

Write-Host "makeappx: $makeappx"
Write-Host "打包 $Arch → $msixPath"
& $makeappx pack /o /d $stage /p $msixPath
if ($LASTEXITCODE -ne 0) { throw "makeappx pack 失败（退出码 $LASTEXITCODE）" }

# 符号：暂存起来交给 bundle.ps1 一起压进 .appxsym
if ($Pdb -and (Test-Path $Pdb)) {
  $symDir = Join-Path $OutDir "sym-$Arch"
  New-Item -ItemType Directory -Force -Path $symDir | Out-Null
  Copy-Item $Pdb (Join-Path $symDir 'Aropyt.pdb') -Force
  Write-Host "符号：$Pdb"
} elseif ($Pdb) {
  Write-Warning "给了 -Pdb 但文件不存在：$Pdb（包里不会有符号，商店的崩溃分析会是空的）"
}

$sizeMb = [Math]::Round((Get-Item $msixPath).Length / 1MB, 2)
Write-Host "完成：$msixPath（$sizeMb MB）"
