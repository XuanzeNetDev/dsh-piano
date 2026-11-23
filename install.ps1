# DSH 钢琴 —— Windows 一键安装
# 用法：右键 PowerShell 运行，或在仓库根目录执行 .\install.ps1

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "== DSH 钢琴安装 ==" -ForegroundColor Cyan

# 1) 定位 DSH profile 目录
$profiles = @(
    "$env:USERPROFILE\.dsh\profiles\desktop",
    "$env:USERPROFILE\.dsh\profiles\default"
)
$profile = $profiles | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $profile) {
    Write-Host "找不到 DSH profile 目录（$env:USERPROFILE\.dsh\profiles\*）" -ForegroundColor Red
    Write-Host "请先安装并启动 DeepSeek Harness 一次，再回来运行本脚本。"
    exit 1
}
Write-Host "  profile: $profile"

# 2) 链接到 node_modules
$nm = Join-Path $profile "node_modules"
if (-not (Test-Path $nm)) { New-Item -ItemType Directory -Path $nm -Force | Out-Null }
$link = Join-Path $nm "dsh-piano-xz"

if (Test-Path $link) {
    $item = Get-Item $link -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Host "  已有链接，先移除"
        cmd /c rmdir "$link"
    } else {
        Write-Host "  目标已存在且不是链接，跳过（请手动处理：$link）" -ForegroundColor Yellow
        exit 1
    }
}

cmd /c mklink /D "$link" "$here" | Out-Null
Write-Host "  已链接：$link -> $here" -ForegroundColor Green

# 3) 检查音源
$wavs = Join-Path $here "assets\yup\wav"
$n = (Get-ChildItem $wavs -Filter *.wav -ErrorAction SilentlyContinue).Count
if ($n -ge 88) {
    Write-Host "  音源：$n 个 wav ✓" -ForegroundColor Green
} elseif ($n -gt 0) {
    Write-Host "  音源：只有 $n 个 wav（应该 88 个），建议重跑 tools\extract-sf2.py" -ForegroundColor Yellow
} else {
    Write-Host "  音源缺失：assets\yup\wav 里没有 wav" -ForegroundColor Yellow
    Write-Host "    需要下载 Yamaha Upright.sf2 后运行：python tools\extract-sf2.py"
}

# 4) 检查 EXE
$exe = Join-Path $here "tools\PianoWindow.exe"
if (Test-Path $exe) {
    Write-Host "  播放器：tools\PianoWindow.exe ✓" -ForegroundColor Green
} else {
    Write-Host "  播放器缺失，正在编译…" -ForegroundColor Yellow
    $csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    if (-not (Test-Path $csc)) {
        Write-Host "    找不到 csc.exe（需要 .NET Framework 4.x）" -ForegroundColor Red
        exit 1
    }
    Push-Location (Join-Path $here "tools")
    & $csc /nologo /target:winexe /optimize+ /out:PianoWindow.exe `
        /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll `
        PianoWindow.cs PianoAudio.cs
    Pop-Location
    if (Test-Path $exe) { Write-Host "    编译完成 ✓" -ForegroundColor Green }
    else { Write-Host "    编译失败" -ForegroundColor Red; exit 1 }
}

Write-Host ""
Write-Host "完成。重启 DSH 后，在插件列表里启用「DSH 钢琴」。" -ForegroundColor Cyan
Write-Host "网页右下角会出现「● 钢琴」胶囊。" -ForegroundColor Cyan
