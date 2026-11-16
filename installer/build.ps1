# Builds the Home Network Monitor installer.
#   powershell -ExecutionPolicy Bypass -File installer\build.ps1
# Output: dist\HomeNetworkMonitor-Setup-<version>.exe
# Needs: Inno Setup 6 (winget install JRSoftware.InnoSetup) and internet the first time (to fetch node.exe).
$ErrorActionPreference = 'Stop'

$NodeVersion = 'v22.17.0'   # the Node version the app is developed and tested on
$Root  = Split-Path -Parent $PSScriptRoot
$Build = Join-Path $Root 'build'
$Stage = Join-Path $Build 'stage'
$Cache = Join-Path $Build 'cache'
$Dist  = Join-Path $Root 'dist'

# Only these files ship. Anything else (.env with the API key, the old Electron files, node_modules) stays out.
$AppFiles = @(
  'server.js', 'router.js', 'routers.js', 'fibre.js', 'pcwifi.js', 'ai.js', 'ai-tools.js',
  'index.html', 'styles.css', 'renderer.js', 'web-bridge.js', 'theme.js',
  'scan.ps1', 'icon.ico', 'package.json'
)

$version = (Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json).version
Write-Host "Building Home Network Monitor $version"

# 1. Fresh staging folder with the app files.
if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
New-Item -ItemType Directory -Force $Stage, $Cache, $Dist | Out-Null
foreach ($f in $AppFiles) { Copy-Item (Join-Path $Root $f) $Stage }

# 2. Portable node.exe, checked against nodejs.org's published SHA-256.
$zipName = "node-$NodeVersion-win-x64.zip"
$zip = Join-Path $Cache $zipName
$base = "https://nodejs.org/dist/$NodeVersion"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not (Test-Path $zip)) {
  Write-Host "Downloading $zipName"
  Invoke-WebRequest "$base/$zipName" -OutFile "$zip.part" -UseBasicParsing
  Move-Item "$zip.part" $zip -Force
}
$sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
$expected = ($sums -split "`n" | Where-Object { $_ -match "\s$([regex]::Escape($zipName))$" }) -replace '\s.*$', ''
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $actual -ne $expected.Trim().ToLower()) {
  Remove-Item $zip -Force
  throw "node.exe download failed its checksum check. Run the build again."
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entry = $archive.Entries | Where-Object { $_.FullName -eq "node-$NodeVersion-win-x64/node.exe" }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Stage 'node.exe'), $true)
  $lic = $archive.Entries | Where-Object { $_.FullName -eq "node-$NodeVersion-win-x64/LICENSE" }
  [IO.Compression.ZipFileExtensions]::ExtractToFile($lic, (Join-Path $Stage 'node-LICENSE.txt'), $true)
} finally { $archive.Dispose() }

# 3. Compile the launcher with the C# compiler that comes with Windows (.NET Framework 4).
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc" }
$exe = Join-Path $Stage 'Home Network Monitor.exe'
# Stamp this release's version and year into the launcher's file details.
$src = Join-Path $Build 'Launcher.cs'
$year = (Get-Date).Year
$c = [char]0xA9   # the copyright sign, kept out of this file so PowerShell 5.1 reads it correctly
(Get-Content (Join-Path $Root 'launcher\Launcher.cs') -Raw -Encoding UTF8) `
  -replace '"0\.0\.0\.0"', "`"$version.0`"" `
  -replace "`"$c George Junior Boadu`"", "`"$c $year George Junior Boadu`"" |
  Set-Content $src -Encoding UTF8
& $csc /nologo /target:winexe /optimize+ /utf8output "/win32icon:$(Join-Path $Root 'icon.ico')" `
  /r:System.Windows.Forms.dll "/out:$exe" $src
if ($LASTEXITCODE -ne 0) { throw 'Launcher failed to compile.' }
# Keep the copy in the project folder current too, for running from source.
Copy-Item $exe (Join-Path $Root 'Home Network Monitor.exe') -Force

# 4. Build the installer (wizard images first).
& (Join-Path $PSScriptRoot 'make-wizard-images.ps1')
$iscc = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
  (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe')
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $iscc) { throw 'Inno Setup 6 is not installed. Run: winget install JRSoftware.InnoSetup' }
& $iscc /Q "/DAppVersion=$version" "/DStageDir=$Stage" "/DOutDir=$Dist" "/DIconFile=$(Join-Path $Root 'icon.ico')" `
  (Join-Path $PSScriptRoot 'HomeNetworkMonitor.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed.' }

Write-Host "Done: $(Join-Path $Dist "HomeNetworkMonitor-Setup-$version.exe")"
