; Inno Setup script for Home Network Monitor. Built by installer\build.ps1, which passes
; AppVersion, StageDir, OutDir and IconFile on the command line.

#define AppName      "Home Network Monitor"
#define AppExe       "Home Network Monitor.exe"
#define AppPublisher "George Junior Boadu"
#define AppEmail     "georgejunior.boadu@gmail.com"
#define AppPhone     "+233 54 235 2886"
#define AppYear      GetDateTimeString('yyyy', '', '')

[Setup]
; Keep this AppId the same in every release so new versions upgrade the old one in place.
AppId={{D47B8FAC-30CC-40EF-A40C-81A501F0A72D}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher={#AppPublisher}
AppPublisherURL=mailto:{#AppEmail}
AppSupportURL=mailto:{#AppEmail}?subject=Home%20Network%20Monitor%20support
AppContact={#AppEmail}
AppSupportPhone={#AppPhone}
AppCopyright=© {#AppYear} {#AppPublisher}
AppComments=Shows the devices on your home network and tracks your data balance.

; Details shown in the setup file's Properties > Details tab.
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoProductVersion={#AppVersion}
VersionInfoCompany={#AppPublisher}
VersionInfoDescription={#AppName} Setup
VersionInfoCopyright=© {#AppYear} {#AppPublisher}

; Per-user install: no admin prompt, goes to %LOCALAPPDATA%\Programs\Home Network Monitor.
PrivilegesRequired=lowest
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
DisableWelcomePage=no
LicenseFile=..\LICENSE
InfoAfterFile=getting-started.txt
OutputDir={#OutDir}
OutputBaseFilename=HomeNetworkMonitor-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
WizardImageFile=images\wizard-large-100.bmp,images\wizard-large-150.bmp,images\wizard-large-200.bmp
WizardSmallImageFile=images\wizard-small-100.bmp,images\wizard-small-150.bmp,images\wizard-small-200.bmp
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0

[Messages]
WelcomeLabel2=This will install [name/ver] on your computer.%n%nHome Network Monitor shows every device on your home network, warns you when something new joins, and keeps track of your data balance. Everything runs on this PC.%n%nNo administrator rights are needed. Close any open Home Network Monitor window before continuing.
InfoAfterLabel=Here's how to get started.
InfoAfterClickLabel=When you're ready, click Next.
FinishedLabel=Setup has installed [name] on your computer. Open it any time from the Start menu.%n%nBuilt by {#AppPublisher}. Questions or ideas? {#AppEmail}

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs
Source: "getting-started.txt"; DestDir: "{app}"; DestName: "Getting started.txt"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Comment: "See the devices on your home network"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; WorkingDir: "{app}"; Tasks: desktopicon; Comment: "See the devices on your home network"

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent

; Settings, routers, history and the Ask AI settings (ai.json) live in %APPDATA%\Home Network Monitor and are
; deliberately kept on uninstall, so reinstalling picks up where the user left off.

[Code]
// The monitor's background server is node.exe running from the install folder. Stop it before
// upgrading or uninstalling, otherwise its files are locked.
procedure StopMonitor();
var
  Code: Integer;
  Cmd: String;
begin
  Cmd := '-NoProfile -NonInteractive -Command "Get-Process node -ErrorAction SilentlyContinue | ' +
         'Where-Object { $_.Path -eq ''' + ExpandConstant('{app}') + '\node.exe'' } | Stop-Process -Force"';
  Exec('powershell.exe', Cmd, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopMonitor();
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopMonitor();
  Result := True;
end;
