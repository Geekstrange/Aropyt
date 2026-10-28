#Requires -Version 7.0
<#
.SYNOPSIS
  把各架构的 .msix 合成 .msixbundle，再包成商店提交用的 .msixupload。

.DESCRIPTION
  为什么非要走 bundle + upload 两层，而不是直接传 `.msix`：

  * **bundle**：一个文件同时覆盖 x64 和 arm64，商店按设备挑对应的包。
    更重要的是——首次提交选定"单包"之后，后续每次提交都必须维持单包形态，
    不能再改成 bundle。一步到位省掉以后的麻烦。
  * **upload**：`.msixupload` 就是个改了扩展名的 zip，
    里面放 bundle（以及可选的 .appxsym 符号）。商店接受裸 `.msix`，
    但 `.msixupload` 是面向商店的标准投递格式，且是符号文件的唯一载体。

  判定依据：`makeappx bundle` 的 `/bv` 必须**等于**清单里的 Version，
  否则 Partner Center 会以 "package version mismatch" 拒绝整个提交。

.EXAMPLE
  ./bundle.ps1            # 版本号从 tauri.conf.json 读
  ./bundle.ps1 -Version 0.1.5
#>
[CmdletBinding()]
param(
  [string]$Version,
  [string]$OutDir
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent (Split-Path -Parent $here)

if (-not $Version) {
  $Version = (Get-Content (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json).version
}

$parts = @($Version.Split('.'))
if ($parts.Count -gt 4) { throw "版本号最多四段，收到：$Version" }
# 清单版本必须是四段 —— 与 pack.ps1 用同一套补齐规则，两边一旦不一致，
# bundle 的 /bv 会和包内版本对不上，报错却在 Partner Center 那端
while ($parts.Count -lt 4) { $parts += '0' }
$packageVersion = $parts -join '.'

if (-not $OutDir) { $OutDir = Join-Path $repo 'src-tauri/target/msix' }
$OutDir = [IO.Path]::GetFullPath($OutDir)

function Resolve-MakeAppx {
  if ($env:MSIX_MAKEAPPX -and (Test-Path $env:MSIX_MAKEAPPX)) { return $env:MSIX_MAKEAPPX }
  foreach ($root in @('C:\Program Files (x86)\Windows Kits\10\bin', 'C:\Program Files\Windows Kits\10\bin')) {
    if (-not (Test-Path $root)) { continue }
    foreach ($sdk in (Get-ChildItem $root -Directory | Sort-Object Name -Descending)) {
      foreach ($archDir in @('x64', 'x86')) {
        $candidate = Join-Path $sdk.FullName "$archDir\makeappx.exe"
        if (Test-Path $candidate) { return $candidate }
      }
    }
  }
  throw '找不到 makeappx.exe。装 Windows 10 SDK，或用 MSIX_MAKEAPPX 指定完整路径。'
}

$makeappx = Resolve-MakeAppx

# ── 1. 收集各架构的包 ────────────────────────────────────────
$packages = @(Get-ChildItem $OutDir -Filter "Aropyt_${packageVersion}_*.msix" -File)
if ($packages.Count -lt 2) {
  throw "至少要两个架构才能 bundle，$OutDir 里只找到 $($packages.Count) 个 Aropyt_${packageVersion}_*.msix。先分别跑 pack.ps1。"
}

<#
  架构顺序固定成 x64 在前。
  字母序会给出 arm64_x64（a 排在 x 前面），文件名读起来像"arm64 为主"，
  而实际上绝大多数用户拿到的就是 x64 —— 文件名是第一眼信息，别让它说谎。
#>
$rank = @{ x64 = 0; arm64 = 1 }
$archs = ($packages |
  ForEach-Object { $_.BaseName.Split('_')[-1] } |
  Sort-Object { if ($rank.ContainsKey($_)) { $rank[$_] } else { 9 } }) -join '_'

$bundleStage = Join-Path $OutDir 'bundle-stage'
if (Test-Path $bundleStage) { Remove-Item $bundleStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $bundleStage | Out-Null
foreach ($package in $packages) { Copy-Item $package.FullName $bundleStage -Force }

$bundlePath = Join-Path $OutDir "Aropyt_${packageVersion}_$archs.msixbundle"
if (Test-Path $bundlePath) { Remove-Item $bundlePath -Force }

Write-Host "合成 bundle（$($packages.Count) 个包：$archs）→ $bundlePath"
& $makeappx bundle /o /bv $packageVersion /d $bundleStage /p $bundlePath
if ($LASTEXITCODE -ne 0) { throw "makeappx bundle 失败（退出码 $LASTEXITCODE）" }

# ── 2. 符号 ─────────────────────────────────────────────────
<#
  `.appxsym` 按官方文档就是一个"改了扩展名的 zip"，里面放 pdb。
  没有符号文件商店照样收，只是 Partner Center 的 Health Reports 一直是空的 ——
  所以是"有就带上"，缺了不报错。
#>
$symDirs = @(Get-ChildItem $OutDir -Filter 'sym-*' -Directory)
$symPath = Join-Path $OutDir "Aropyt_${packageVersion}_$archs.appxsym"
$haveSymbols = $false

if ($symDirs.Count -gt 0) {
  $symStage = Join-Path $OutDir 'sym-stage'
  if (Test-Path $symStage) { Remove-Item $symStage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $symStage | Out-Null

  foreach ($dir in $symDirs) {
    # pdb 同名（Aropyt.pdb）会互相覆盖 —— 用架构后缀区分，否则只有最后一个架构的符号进包
    $arch = $dir.Name -replace '^sym-', ''
    foreach ($pdb in (Get-ChildItem $dir.FullName -Filter '*.pdb' -File)) {
      Copy-Item $pdb.FullName (Join-Path $symStage "Aropyt_$arch.pdb") -Force
    }
  }

  if ((Get-ChildItem $symStage -File).Count -gt 0) {
    if (Test-Path $symPath) { Remove-Item $symPath -Force }
    <#
      用 ZipFile 直接写目标扩展名，不用 Compress-Archive：
        * Compress-Archive 在 PowerShell 5.1 里拒绝写非 `.zip` 扩展名，
          必须先写 zip 再改名；
        * 它的进度条关不掉（`$ProgressPreference` 对它无效），CI 日志里
          会刷出几百行花括号，把真正的报错挤没。
      这两个文件（符号 / 提交件）本质就是 zip，直接压更省事。
    #>
    [System.IO.Compression.ZipFile]::CreateFromDirectory($symStage, $symPath)
    $haveSymbols = $true
    Write-Host "符号：$symPath"
  }
}

# ── 3. 打成 .msixupload ─────────────────────────────────────
$uploadPath = Join-Path $OutDir "Aropyt_${packageVersion}_$archs.msixupload"
$uploadStage = Join-Path $OutDir 'upload-stage'
if (Test-Path $uploadStage) { Remove-Item $uploadStage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $uploadStage | Out-Null
Copy-Item $bundlePath $uploadStage -Force
if ($haveSymbols) { Copy-Item $symPath $uploadStage -Force }

if (Test-Path $uploadPath) { Remove-Item $uploadPath -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($uploadStage, $uploadPath)

$sizeMb = [Math]::Round((Get-Item $uploadPath).Length / 1MB, 2)
Write-Host ''
Write-Host "提交件：$uploadPath（$sizeMb MB，$(if ($haveSymbols) { '含符号' } else { '无符号' })）"
Write-Host '把它拖进 Partner Center → 提交 → 包 页面上传。**不要签名**，商店会重签。'
