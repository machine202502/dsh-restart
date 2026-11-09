# Watchdog overlay (PowerShell tier).
#
# Used when Python/tkinter is unavailable on Windows. Same contract as the Tk
# window: read an ASCII mode from overlay.json, own the user-facing strings, and
# close itself on success. The window is resizable and the log takes the full
# width and the remaining height.
param(
  [string]$State = (Join-Path $env:LOCALAPPDATA 'dsh-restart\overlay.json'),
  [string]$Log = (Join-Path $env:LOCALAPPDATA 'dsh-restart\restart.log'),
  [string]$Lang = ''
)

$ErrorActionPreference = 'Continue'

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  exit 0
}

try {
  $code = 'using System;' + [Environment]::NewLine + 'using System.Runtime.InteropServices;' + [Environment]::NewLine + 'public static class Win32U {' + [Environment]::NewLine + '  [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);' + [Environment]::NewLine + '}'
  Add-Type -TypeDefinition $code
} catch {
  # Without the scroll probe the window still works, it just always pins.
}

$TEXTS = @{
  ru = @{
    title = 'DeepSeek Harness — перезапуск'
    restart = 'Перезапуск…'
    rollback = 'Откат: запуск не удался'
    safeMode = 'Безопасный режим'
    doneOk = 'Готово: приложение работает'
    doneRecovered = 'Восстановлено, но не всё'
    doneFailed = 'Защитник не справился'
    hint = 'Защитник проверяет запуск. Приложение не трогайте — если всё хорошо, окно закроется само.'
    recovering = 'Запуск не удался: восстанавливаю профиль и отключаю подозрительные расширения.'
    safe = 'Перезапускаю только с базовыми расширениями.'
    ok = 'Запуск в порядке. Можно продолжать работу.'
    recovered = 'Запуск восстановлен, но расширения пришлось отключить — проверьте баннер в приложении.'
    failed = 'Автоматически восстановить не удалось. Приложение работает в урезанном виде — нужна ваша проверка.'
    elapsed = 'идёт {0} с'
    needYou = 'это уже к вам'
    close = 'Закрыть'
    reason = 'Причина'
    plugins = 'Плагины'
  }
  en = @{
    title = 'DeepSeek Harness — restart'
    restart = 'Restarting…'
    rollback = 'Rollback: the boot failed'
    safeMode = 'Safe mode'
    doneOk = 'Done: the app is running'
    doneRecovered = 'Recovered, but not everything'
    doneFailed = 'The watchdog could not recover'
    hint = 'The watchdog is checking the boot. Do not touch the app — the window closes when everything is fine.'
    recovering = 'The boot failed: restoring the profile and disabling the suspects.'
    safe = 'Restarting with the base extensions only.'
    ok = 'The boot is fine. You can continue working.'
    recovered = 'The boot was restored, but extensions had to be disabled — check the banner in the app.'
    failed = 'Automatic recovery failed. The app runs in a reduced mode — your check is needed.'
    elapsed = '{0}s'
    needYou = 'this one is on you'
    close = 'Close'
    reason = 'Reason'
    plugins = 'Plugins'
  }
  zh = @{
    title = 'DeepSeek Harness — 重启'
    restart = '正在重启…'
    rollback = '回滚：启动失败'
    safeMode = '安全模式'
    doneOk = '完成：应用正在运行'
    doneRecovered = '已恢复，但并非全部'
    doneFailed = '守护程序未能恢复'
    hint = '守护程序正在检查启动。请勿操作应用——一切正常时窗口会自动关闭。'
    recovering = '启动失败：正在恢复配置文件并禁用可疑扩展。'
    safe = '仅使用基础扩展重启。'
    ok = '启动正常，可以继续工作。'
    recovered = '启动已恢复，但部分扩展被禁用——请查看应用内的提示条。'
    failed = '自动恢复失败。应用以精简模式运行——需要您检查。'
    elapsed = '{0}s'
    needYou = '需要您处理'
    close = '关闭'
    reason = '原因'
    plugins = '插件'
  }
}

$language = if ($Lang -eq 'ru' -or $Lang -eq 'en' -or $Lang -eq 'zh') { $Lang } else { 'ru' }
$t = $TEXTS[$language]

$font = New-Object System.Drawing.Font('Segoe UI', 9)
$titleFont = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$monoFont = New-Object System.Drawing.Font('Cascadia Mono', 9)
if ($monoFont.Name -ne 'Cascadia Mono') { $monoFont = New-Object System.Drawing.Font('Consolas', 9) }

$form = New-Object System.Windows.Forms.Form
$form.Text = $t.title
$form.ClientSize = New-Object System.Drawing.Size(640, 420)
$form.MinimumSize = New-Object System.Drawing.Size(460, 300)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'Sizable'
$form.MaximizeBox = $false
$form.TopMost = $true
$form.BackColor = [System.Drawing.Color]::FromArgb(24, 24, 27)
$form.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 240)

function New-Label($x, $y, $w, $h, $text, $font, $color) {
  $label = New-Object System.Windows.Forms.Label
  $label.Location = New-Object System.Drawing.Point($x, $y)
  $label.Size = New-Object System.Drawing.Size($w, $h)
  $label.Text = $text
  $label.Font = $font
  $label.ForeColor = $color
  $label.BackColor = [System.Drawing.Color]::Transparent
  return $label
}

$headline = New-Label 16 12 608 26 $t.restart $titleFont ([System.Drawing.Color]::FromArgb(240, 240, 240))
$headline.Anchor = 'Top,Left,Right'
$form.Controls.Add($headline)

$detail = New-Label 16 42 608 40 $t.hint $font ([System.Drawing.Color]::FromArgb(166, 166, 171))
$detail.Anchor = 'Top,Left,Right'
$form.Controls.Add($detail)

$meta = New-Label 16 86 608 34 '' $font ([System.Drawing.Color]::FromArgb(166, 166, 171))
$meta.Anchor = 'Top,Left,Right'
$form.Controls.Add($meta)

$timer = New-Label 16 124 320 20 '' $font ([System.Drawing.Color]::FromArgb(140, 140, 145))
$timer.Anchor = 'Top,Left'
$form.Controls.Add($timer)

$close = New-Object System.Windows.Forms.Button
$close.Location = New-Object System.Drawing.Point(534, 122)
$close.Size = New-Object System.Drawing.Size(90, 26)
$close.Text = $t.close
$close.Anchor = 'Top,Right'
$close.Visible = $false
$close.Add_Click({ $form.Close() })
$form.Controls.Add($close)

$tail = New-Object System.Windows.Forms.TextBox
$tail.Location = New-Object System.Drawing.Point(16, 150)
$tail.Size = New-Object System.Drawing.Size(608, 254)
$tail.Multiline = $true
$tail.ReadOnly = $true
$tail.ScrollBars = 'Vertical'
$tail.WordWrap = $false
$tail.Font = $monoFont
$tail.BackColor = [System.Drawing.Color]::FromArgb(16, 16, 18)
$tail.ForeColor = [System.Drawing.Color]::FromArgb(180, 180, 186)
$tail.BorderStyle = 'None'
$tail.Anchor = 'Top,Bottom,Left,Right'
$form.Controls.Add($tail)

$script:started = Get-Date
$script:knownLast = ''
$script:doneAt = $null
$script:verdict = $null
$script:autoClose = $false

$tick = {
  $now = Get-Date
  $timer.Text = ($t.elapsed -f [int]($now - $script:started).TotalSeconds)

  if (Test-Path -LiteralPath $State) {
    try {
      $raw = Get-Content -LiteralPath $State -Raw -Encoding UTF8
      $raw = $raw -replace [string][char]0xFEFF, ''
      $state = $raw | ConvertFrom-Json
    } catch {
      $state = $null
    }
    if ($null -ne $state) {
      $mode = [string]$state.detail
      if ($mode -notmatch '^[a-z-]*$') { $mode = '' }
      switch ($state.phase) {
        'restart' { $headline.Text = $t.restart; $headline.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 240) }
        'rollback' { $headline.Text = $t.rollback; $headline.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 240) }
        'safe-mode' { $headline.Text = $t.safeMode; $headline.ForeColor = [System.Drawing.Color]::FromArgb(240, 240, 240) }
        'done' {
          if ($state.ok) {
            $headline.Text = $t.doneOk
            $headline.ForeColor = [System.Drawing.Color]::FromArgb(120, 200, 140)
          } elseif ($mode -eq 'recovered') {
            $headline.Text = $t.doneRecovered
            $headline.ForeColor = [System.Drawing.Color]::FromArgb(230, 180, 110)
          } else {
            $headline.Text = $t.doneFailed
            $headline.ForeColor = [System.Drawing.Color]::FromArgb(230, 120, 110)
          }
        }
        default { $headline.Text = $t.restart }
      }
      $key = 'hint'
      if ($state.phase -eq 'done') {
        if ($state.ok) { $key = 'ok' } elseif ($mode -eq 'recovered') { $key = 'recovered' } else { $key = 'failed' }
      } elseif ($state.phase -eq 'rollback') { $key = 'recovering' } elseif ($state.phase -eq 'safe-mode') { $key = 'safe' }
      $detail.Text = $t[$key]

      $lines = @()
      $reason = [string]$state.reason
      if ($reason) { $lines += ($t.reason + ': ' + $reason) }
      $plugins = @($state.plugins | Where-Object { $_ })
      if ($plugins.Count -gt 0) { $lines += ($t.plugins + ': ' + ($plugins -join ', ')) }
      $meta.Text = ($lines -join [Environment]::NewLine)

      if ($state.phase -eq 'done') {
        $script:verdict = [bool]$state.ok
        if ($null -eq $script:doneAt) { $script:doneAt = $now }
        if ($state.ok -or $mode -eq 'recovered') {
          # "Recovered" closes by itself: the in-app banner owns the follow-up.
          $script:autoClose = $true
          $timer.Text = ($t.elapsed -f [int]($now - $script:started).TotalSeconds)
        } else {
          $script:autoClose = $false
          $timer.Text = $t.needYou
          $close.Visible = $true
        }
      }
    }
  }

  if (Test-Path -LiteralPath $Log) {
    try {
      $fileLines = Get-Content -LiteralPath $Log -Tail 200 -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($fileLines) {
        $first = [Win32U]::SendMessage($tail.Handle, 0x00CE, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
        $lineHeight = [Math]::Max(1, [int]$tail.Font.GetHeight())
        $visible = [Math]::Max(1, [int]($tail.ClientSize.Height / $lineHeight))
        $total = $tail.Lines.Count
        $pinned = ($total -le 1) -or (($first + $visible) -ge ($total - 1))
        $last = $fileLines[$fileLines.Count - 1]
        if ($last -ne $script:knownLast) {
          $start = 0
          if ($script:knownLast -ne '') {
            for ($i = $fileLines.Count - 1; $i -ge 0; $i--) {
              if ($fileLines[$i] -eq $script:knownLast) { $start = $i + 1; break }
            }
          }
          $added = @()
          if ($start -lt $fileLines.Count) { $added = $fileLines[$start..($fileLines.Count - 1)] }
          $firstFill = ($script:knownLast -eq '')
          $script:knownLast = $last
          if ($added.Count -gt 0) { $tail.AppendText((($added -join [Environment]::NewLine) + [Environment]::NewLine)) }
          if ($firstFill -or (-not $script:userScrolled) -or $pinned) {
            $script:userScrolled = $false
            $tail.SelectionStart = $tail.TextLength
            $tail.ScrollToCaret()
          }
        }
      }
    } catch {
    }
  }

  if ($null -ne $script:doneAt) {
    $age = ($now - $script:doneAt).TotalSeconds
    if ($script:autoClose -and $age -gt 1.5) { $form.Close(); return }
    if (-not $script:verdict -and $age -gt 900) { $form.Close() }
  }
  if (($now - $script:started).TotalSeconds -gt 600) { $form.Close() }
}

# The user takes over the scroll explicitly; returning to the bottom resumes it.
$script:userScrolled = $false
$tail.Add_MouseWheel({ $script:userScrolled = $true })
$tail.Add_KeyDown({ if ($_.KeyCode -in @('Up','Down','PageUp','PageDown','Home','End')) { $script:userScrolled = $true } })

$clock = New-Object System.Windows.Forms.Timer
$clock.Interval = 300
$clock.Add_Tick($tick)
$clock.Start()

$form.Add_Shown({ & $tick })
[void]$form.ShowDialog()
exit 0
