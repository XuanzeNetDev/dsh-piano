# 开一个独立的钢琴窗口，钉在 DSH 主窗口正上方。
#
# 为什么不用 window.open：DSH 是 Electron 壳，主进程通常把 window.open 掉
# （setWindowOpenHandler 返回 deny），renderer 里拿到的就是 null，弹不出来。
# 改用 Chrome 自己的 --app 模式：它不经过 DSH 的窗口策略，
# 而且 --window-position 接受绝对屏幕坐标，可以精确贴在主窗口上沿。
param(
  [Parameter(Mandatory = $true)][string]$Url,
  [int]$Height = 300,
  [string]$Chrome = "",
  [string]$ProfileDir = ""
)

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public class PianoWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int L, T, R, B; }

  // 找标题里带 "DeepSeek Harness" 的那个可见窗口（DSH 主窗口）
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

  // 已有的钢琴窗口句柄（标题完全等于传入值）
  public static IntPtr FindByTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString() == title) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // 存在就把它顶到前面（最小化的先还原）
  public static bool Focus(IntPtr h) {
    if (h == IntPtr.Zero) return false;
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    ShowWindow(h, 5);                  // SW_SHOW
    return SetForegroundWindow(h);
  }

  public static string RectOf(IntPtr h) {
    RECT r;
    if (!GetWindowRect(h, out r)) return "";
    return r.L + "," + r.T + "," + (r.R - r.L) + "," + (r.B - r.T);
  }
}
"@

if (-not $Chrome -or -not (Test-Path $Chrome)) {
  $cands = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
  )
  foreach ($c in $cands) { if (Test-Path $c) { $Chrome = $c; break } }
}
if (-not $Chrome) { Write-Output '{"ok":false,"error":"找不到 chrome.exe"}'; exit 1 }

# ① 已经有钢琴窗口：直接拿到前台，不再开第二个。
#    连点多次按钮时，用户要的是"把它叫出来"，不是堆四个一样的窗口。
$existing = [PianoWin]::FindByTitle("DSH 钢琴")
if ($existing -ne [IntPtr]::Zero) {
  [void][PianoWin]::Focus($existing)
  $r = [PianoWin]::RectOf($existing)
  $p = if ($r) { $r.Split(',') } else { @(-1, -1, 0, 0) }
  Write-Output ('{"ok":true,"existing":true,"x":' + $p[0] + ',"y":' + $p[1] + ',"w":' + $p[2] + ',"h":' + $p[3] + '}')
  exit 0
}

$info = [PianoWin]::FindDSH()
$args = @("--app=$Url", "--no-first-run", "--no-default-browser-check",
          "--disable-features=Translate,MediaRouter")
if ($ProfileDir) { $args += "--user-data-dir=$ProfileDir" }

if ($info) {
  $p = $info.Split(',')
  $dx = [int]$p[0]; $dy = [int]$p[1]; $dw = [int]$p[2]; $dh = [int]$p[3]
  # 跟主窗口同宽（留一点边），水平对齐，垂直贴在上沿之上。
  # 高度给足不压缩 —— 压了会切掉键盘，不如让它暂时压住主窗口顶边，
  # 用户把主窗口往下挪一点就自然贴合。
  $w = [Math]::Max(700, $dw - 16)
  $left = $dx + [int](($dw - $w) / 2)
  $h = $Height
  $top = [Math]::Max(0, $dy - $h - 4)
  $args += "--window-size=$w,$h"
  $args += "--window-position=$left,$top"
  Start-Process -FilePath $Chrome -ArgumentList $args
  # 等窗口真的出现再返回。Chrome 启动到窗口可枚举有一两秒延迟，
  # 不等的话下一次点击会"查不到已有窗口"，于是又开一个。
  $waited = 0
  while ($waited -lt 4000) {
    Start-Sleep -Milliseconds 250
    $waited += 250
    if ([PianoWin]::FindByTitle("DSH 钢琴") -ne [IntPtr]::Zero) { break }
  }
  Write-Output ('{"ok":true,"existing":false,"x":' + $left + ',"y":' + $top + ',"w":' + $w + ',"h":' + $h + ',"dshT":' + $dy + '}')
} else {
  # 找不到主窗口就不定位，让系统决定
  $args += "--window-size=1280,$Height"
  Start-Process -FilePath $Chrome -ArgumentList $args
  Write-Output '{"ok":true,"x":-1,"y":-1,"note":"没找到 DSH 窗口，用系统默认位置"}'
}
