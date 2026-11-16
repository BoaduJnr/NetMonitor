# Draws the installer's wizard images in the app's colours (navy background, orange Wi-Fi arcs).
#   wizard-large-*.bmp : the tall banner on the Welcome and Finish pages (164x314 at 100% scaling)
#   wizard-small-*.bmp : the square logo at the top right of the other pages (55x55 at 100%)
# Each comes in 100/150/200% sizes so it stays sharp on high-DPI screens. build.ps1 runs this.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$out = Join-Path $PSScriptRoot 'images'
New-Item -ItemType Directory -Force $out | Out-Null

$navy   = [System.Drawing.Color]::FromArgb(10, 20, 29)
$navy2  = [System.Drawing.Color]::FromArgb(24, 40, 54)
$orange = [System.Drawing.Color]::FromArgb(255, 122, 26)
$muted  = [System.Drawing.Color]::FromArgb(142, 160, 178)

function Draw-Arcs($g, [float]$cx, [float]$cy, [float]$unit, $color) {
  # The same three arcs and dot as the app's header icon, sized by $unit.
  $pen = New-Object System.Drawing.Pen $color, ([float]($unit * 0.9))
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  foreach ($r in @(7.6, 5.2, 2.8)) {
    $rr = [float]($r * $unit)
    $g.DrawArc($pen, [float]($cx - $rr), [float]($cy - $rr), [float]($rr * 2), [float]($rr * 2), 225, 90)
  }
  $d = [float]($unit * 1.25)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $color), [float]($cx - $d), [float]($cy - $d), [float]($d * 2), [float]($d * 2))
}

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
  return @($bmp, $g)
}

foreach ($scale in @(100, 150, 200)) {
  $s = $scale / 100

  # Tall banner
  $w = [int](164 * $s); $h = [int](314 * $s)
  $bmp, $g = New-Canvas $w $h
  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $g.FillRectangle((New-Object System.Drawing.Drawing2D.LinearGradientBrush $rect, $navy2, $navy, 90), $rect)
  # Soft orange glow behind the icon
  $glow = New-Object System.Drawing.Drawing2D.GraphicsPath
  $gr = 70 * $s; $gx = $w / 2; $gy = 120 * $s
  $glow.AddEllipse([float]($gx - $gr), [float]($gy - $gr), [float]($gr * 2), [float]($gr * 2))
  $pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush $glow
  $pgb.CenterColor = [System.Drawing.Color]::FromArgb(70, 255, 122, 26)
  $pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0, 255, 122, 26))
  $g.FillPath($pgb, $glow)
  Draw-Arcs $g $gx ([float](140 * $s)) ([float](5.2 * $s)) $orange
  $fmt = New-Object System.Drawing.StringFormat; $fmt.Alignment = 'Center'
  $title = New-Object System.Drawing.Font 'Segoe UI Semibold', ([float](13 * $s)), ([System.Drawing.GraphicsUnit]::Pixel)
  $sub = New-Object System.Drawing.Font 'Segoe UI', ([float](10 * $s)), ([System.Drawing.GraphicsUnit]::Pixel)
  $g.DrawString('Home Network', $title, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, ([float](200 * $s)), $w, ([float](20 * $s))), $fmt)
  $g.DrawString('Monitor', $title, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, ([float](217 * $s)), $w, ([float](20 * $s))), $fmt)
  $g.DrawString('by George Junior Boadu', $sub, (New-Object System.Drawing.SolidBrush $muted), (New-Object System.Drawing.RectangleF 0, ([float](284 * $s)), $w, ([float](16 * $s))), $fmt)
  $bmp.Save((Join-Path $out "wizard-large-$scale.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $g.Dispose(); $bmp.Dispose()

  # Square logo: navy rounded tile on white (the wizard header is white)
  $n = [int](55 * $s)
  $bmp, $g = New-Canvas $n $n
  $g.Clear([System.Drawing.Color]::White)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $m = 3 * $s; $r = 14 * $s; $e = $n - $m
  $p.AddArc([float]$m, [float]$m, [float]$r, [float]$r, 180, 90)
  $p.AddArc([float]($e - $r), [float]$m, [float]$r, [float]$r, 270, 90)
  $p.AddArc([float]($e - $r), [float]($e - $r), [float]$r, [float]$r, 0, 90)
  $p.AddArc([float]$m, [float]($e - $r), [float]$r, [float]$r, 90, 90)
  $p.CloseFigure()
  $g.FillPath((New-Object System.Drawing.SolidBrush $navy2), $p)
  Draw-Arcs $g ([float]($n / 2)) ([float]($n * 0.66)) ([float](3.3 * $s)) $orange
  $bmp.Save((Join-Path $out "wizard-small-$scale.bmp"), [System.Drawing.Imaging.ImageFormat]::Bmp)
  $g.Dispose(); $bmp.Dispose()
}
Write-Host "Wizard images written to $out"
