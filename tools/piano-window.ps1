# 原生钢琴显示窗（不依赖任何浏览器）
#
# 定位：只做"看得见"这件事 —— 画 88 键、按宿主时间轴点亮。
# 声音仍然由 DSH 页面里的 WebAudio 发，这里不碰音频：
# ① 采样解码、力度分层、踏板衰减那一套已经在 JS 里调好了，重写一遍只会更差；
# ② 两边都发声就是重奏。
#
# 参数：
#   -Api   宿主接口根，例如 http://127.0.0.1:60420/api/dsh-piano-xz
#   -Height 窗口高度
param(
  [Parameter(Mandatory = $true)][string]$Api,
  [int]$Height = 300
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }

  public static string FindDSH() {
    string found = "";
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      var t = sb.ToString();
      if (t.Contains("DeepSeek Harness")) {
        RECT r;
        if (GetWindowRect(h, out r) && (r.R - r.L) > 600) {
          found = r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T);
          return false;
        }
      }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$WHITE = @(0, 2, 4, 5, 7, 9, 11)
$MIN = 21
$MAX = 108

# ── 位置：贴在 DSH 主窗口上沿之上 ──────────────────────────────
$info = [PW]::FindDSH()
if ($info) {
  $p = $info.Split(',')
  $dx = [int]$p[0]; $dy = [int]$p[1]; $dw = [int]$p[2]
  $w = [Math]::Max(700, $dw - 16)
  $left = $dx + [int](($dw - $w) / 2)
  $top = [Math]::Max(0, $dy - $Height - 4)
} else {
  $w = 1200; $left = 100; $top = 40
}

# ── 窗体 ──────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 钢琴'
$form.FormBorderStyle = 'None'
$form.StartPosition = 'Manual'
$form.Bounds = New-Object System.Drawing.Rectangle($left, $top, $w, $Height)
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(11, 16, 23)
$form.ShowInTaskbar = $true

# 双缓冲：Form.DoubleBuffered 是 protected，PowerShell 直接赋值不生效，得走反射。
# 不开的话每帧整片重绘，边界会闪。
$setStyle = [System.Windows.Forms.Control].GetMethod(
  'SetStyle', [System.Reflection.BindingFlags]'NonPublic,Instance')
$styles = [System.Windows.Forms.ControlStyles]::AllPaintingInWmPaint -bor
          [System.Windows.Forms.ControlStyles]::UserPaint -bor
          [System.Windows.Forms.ControlStyles]::OptimizedDoubleBuffer
[void]$setStyle.Invoke($form, @($styles, $true))
$updateStyle = [System.Windows.Forms.Control].GetMethod(
  'UpdateStyles', [System.Reflection.BindingFlags]'NonPublic,Instance')
[void]$updateStyle.Invoke($form, @())

# 拖动：无边框窗口得自己接管
$script:drag = $false
$script:dx = 0
$script:dy = 0
$form.Add_MouseDown({
  $script:drag = $true
  $script:dx = [System.Windows.Forms.Cursor]::Position.X - $form.Left
  $script:dy = [System.Windows.Forms.Cursor]::Position.Y - $form.Top
})
$form.Add_MouseMove({
  if ($script:drag) {
    $form.Left = [System.Windows.Forms.Cursor]::Position.X - $script:dx
    $form.Top = [System.Windows.Forms.Cursor]::Position.Y - $script:dy
  }
})
$form.Add_MouseUp({ $script:drag = $false })

# ── 键盘几何 ──────────────────────────────────────────────────
$whiteCount = 0
for ($m = $MIN; $m -le $MAX; $m++) { if ($WHITE -contains ($m % 12)) { $whiteCount++ } }
$kw = $w / $whiteCount
$blackW = $kw * 0.62

$script:keys = @()
$wi = 0
for ($m = $MIN; $m -le $MAX; $m++) {
  $pc = (($m % 12) + 12) % 12
  if ($WHITE -contains $pc) {
    $script:keys += [pscustomobject]@{ Midi = $m; Black = $false; X = ($wi * $kw); W = $kw }
    $wi++
  } else {
    $off = @{ 1 = -0.10; 3 = 0.10; 6 = -0.12; 8 = 0.0; 10 = 0.12 }[$pc]
    $x = ($wi * $kw) + ($off * $kw) - ($blackW / 2)
    $script:keys += [pscustomobject]@{ Midi = $m; Black = $true; X = [Math]::Max(0, $x); W = $blackW }
  }
}

# 当前亮着的键：midi → 结束时间（本地 DateTime）
$script:lit = @{}

# ── 轮询：把事件变成"什么时候该亮" ────────────────────────────
$script:seq = 0
$script:primed = $false
$script:skew = 0   # 宿主时钟 - 本机时钟

function Poll {
  try {
    $r = Invoke-RestMethod -Uri "$Api/events?since=$script:seq" -TimeoutSec 2
    if (-not $r.ok) { return }
    $now = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$r.now)
    $local = [DateTimeOffset]::UtcNow
    $script:skew = ($now - $local).TotalMilliseconds
    foreach ($e in $r.events) {
      if ($e.i -gt $script:seq) { $script:seq = $e.i }
      # 只有"此刻正在响"的音才画，未来的一律等到了再说
      $endLocal = $now.ToUnixTimeMilliseconds() + $e.d
      $curLocal = $local.ToUnixTimeMilliseconds() + $script:skew
      if ($endLocal -gt $curLocal) {
        $script:lit[[int]$e.m] = $endLocal
      }
    }
    $script:primed = $true
  } catch {
    # 宿主没起来/端口变了，静默重试
  }
}

# ── 绘制 ──────────────────────────────────────────────────────
$brushWhite = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(250, 252, 255))
$brushBlack = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(24, 30, 42))
$brushLh = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))
$brushRh = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(34, 197, 94))
$brushBar = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(13, 18, 25))
$font = New-Object System.Drawing.Font('Segoe UI', 8)
$brushLabel = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(140, 150, 168))

$form.Add_Paint({
  # 必须用事件给的 Graphics —— 自己 CreateGraphics 会绕开双缓冲，
  # 每帧和系统的重绘互相覆盖，看起来就是一明一暗地闪。
  $g = $_.Graphics
  $g.SmoothingMode = 'AntiAlias'
  $h = $form.ClientSize.Height
  $barH = 28

  # 顶栏
  $g.FillRectangle($brushBar, 0, 0, $w, $barH)
  $g.DrawString('♪ 钢琴', (New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)),
    (New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(125, 211, 160))), 10, 5)

  $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() + $script:skew
  $keyTop = $barH + 6
  $keyH = $h - $keyTop - 4

  # 白键
  foreach ($k in $script:keys) {
    if ($k.Black) { continue }
    $lit = $script:lit.ContainsKey($k.Midi) -and $script:lit[$k.Midi] -gt $nowMs
    $b = if ($lit) { if ($k.Midi -lt 60) { $brushLh } else { $brushRh } } else { $brushWhite }
    $g.FillRectangle($b, [float]$k.X, [float]$keyTop, [float]($k.W - 1), [float]$keyH)
    if ($k.Midi % 12 -eq 0) {
      $g.DrawString("C" + ($k.Midi / 12 - 1), $font, $brushLabel, [float]($k.X + 3), [float]($keyTop + $keyH - 16))
    }
  }
  # 黑键
  foreach ($k in $script:keys) {
    if (-not $k.Black) { continue }
    $lit = $script:lit.ContainsKey($k.Midi) -and $script:lit[$k.Midi] -gt $nowMs
    $b = if ($lit) { if ($k.Midi -lt 60) { $brushLh } else { $brushRh } } else { $brushBlack }
    $g.FillRectangle($b, [float]$k.X, [float]$keyTop, [float]$k.W, [float]($keyH * 0.62))
  }

  # 清掉过期的
  foreach ($key in @($script:lit.Keys)) {
    if ($script:lit[$key] -le $nowMs) { $script:lit.Remove($key) }
  }
})

# 两个定时器：轮询 120ms、重绘 33ms
$pollTimer = New-Object System.Windows.Forms.Timer
$pollTimer.Interval = 120
$pollTimer.Add_Tick({ Poll })
$pollTimer.Start()

$drawTimer = New-Object System.Windows.Forms.Timer
$drawTimer.Interval = 33
$drawTimer.Add_Tick({ $form.Invalidate() })
$drawTimer.Start()

# Esc 关闭
$form.KeyPreview = $true
$form.Add_KeyDown({ if ($_.KeyCode -eq 'Escape') { $form.Close() } })

$form.Add_Shown({ Poll })
[void]$form.ShowDialog()
