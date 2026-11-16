# Draws the app icon (blue rounded square with Wi-Fi arcs) and saves icon.ico (PNG-based, 256px).
Add-Type -AssemblyName System.Drawing
$size = 256
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

$r = 56
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddArc(8, 8, $r, $r, 180, 90)
$path.AddArc($size - 8 - $r, 8, $r, $r, 270, 90)
$path.AddArc($size - 8 - $r, $size - 8 - $r, $r, $r, 0, 90)
$path.AddArc(8, $size - 8 - $r, $r, $r, 90, 90)
$path.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))), $path)

$pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), 22
$pen.StartCap = 'Round'; $pen.EndCap = 'Round'
$cx = 128; $cy = 184
foreach ($rad in 44, 84, 124) {
    $g.DrawArc($pen, $cx - $rad, $cy - $rad, 2 * $rad, 2 * $rad, 225, 90)
}
$g.FillEllipse([System.Drawing.Brushes]::White, $cx - 16, $cy - 16, 32, 32)
$g.Dispose()

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)       # ICO header, 1 image
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0)  # 256x256, no palette
$w.Write([uint16]1); $w.Write([uint16]32)                              # planes, bits per pixel
$w.Write([uint32]$png.Length); $w.Write([uint32]22)                   # size, offset
$w.Write($png)
$w.Flush()
[IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'icon.ico'), $out.ToArray())
"icon.ico written ($($png.Length) bytes)"
