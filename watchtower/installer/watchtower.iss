; ============================================================================
; Watchtower Agent Installer
; ----------------------------------------------------------------------------
; Installs the Watchtower monitoring agent on a client Windows PC:
;   - Drops watchtower-svc.exe + watchtower-tray.exe into Program Files
;   - Writes %ProgramData%\Watchtower\config.json with the per-client
;     install token, worker URL, client name, and a freshly-generated
;     pcId (one unique UUID per install)
;   - Registers WatchtowerAgent as an auto-start LocalSystem service
;   - Adds the tray to HKLM Run so it autostarts for every interactive user
;
; Build via installer\build.ps1 — that script wraps PyInstaller for both
; EXEs, then invokes ISCC with the right /D defines per client.
;
; Per-client values come from /D flags at compile time:
;   ISCC.exe watchtower.iss /DClientName=OPFD /DInstallToken=<base64>
;
; If not provided, the build falls back to empty defaults — useful for
; smoke-testing a build but produces an installer that won't check in
; successfully because the worker will 401 the empty token.
; ============================================================================

#ifndef ClientName
  #define ClientName ""
#endif
#ifndef InstallToken
  #define InstallToken ""
#endif
#ifndef WorkerUrl
  #define WorkerUrl "https://watchtower-worker.sevendwarfs.workers.dev"
#endif
#ifndef AppVersion
  #define AppVersion "0.1.0"
#endif

#define AppName       "Watchtower Agent"
#define AppPublisher  "Umbrella Automation"
#define ServiceName   "WatchtowerAgent"

[Setup]
; Stable AppId so reinstalls / upgrades over the same EXE work.
AppId={{F4D2A1E6-9B3C-4A82-8F7E-1D2C3B4A5E6F}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#AppPublisher}
DefaultDirName={autopf}\Watchtower
DisableProgramGroupPage=yes
DisableDirPage=yes
PrivilegesRequired=admin
OutputBaseFilename=Watchtower-Setup-{#ClientName}
OutputDir=dist
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
ShowLanguageDialog=no
UninstallDisplayName={#AppName} ({#ClientName})

; ----------------------------------------------------------------------------
; Files — produced by build.ps1 / PyInstaller into installer\build\
; ----------------------------------------------------------------------------
[Files]
Source: "build\watchtower-svc.exe";  DestDir: "{app}"; Flags: ignoreversion
Source: "build\watchtower-tray.exe"; DestDir: "{app}"; Flags: ignoreversion

; ----------------------------------------------------------------------------
; %ProgramData%\Watchtower — created with users-modify so the tray
; (running in a user session) can still read state.json. config.json
; itself is written by [Code] below.
; ----------------------------------------------------------------------------
[Dirs]
Name: "{commonappdata}\Watchtower"; Permissions: users-modify

; ----------------------------------------------------------------------------
; HKLM Run — system-wide tray autostart so the tray launches for every
; interactive user, not just the admin who ran the installer.
; ----------------------------------------------------------------------------
[Registry]
Root: HKLM; Subkey: "SOFTWARE\Microsoft\Windows\CurrentVersion\Run"; \
    ValueType: string; ValueName: "WatchtowerTray"; \
    ValueData: """{app}\watchtower-tray.exe"""; \
    Flags: uninsdeletevalue

; ----------------------------------------------------------------------------
; Service registration. sc.exe is more explicit than letting pywin32's
; HandleCommandLine do it — and it works the same on every Windows version
; we care about.
; ----------------------------------------------------------------------------
[Run]
Filename: "{sys}\sc.exe"; \
    Parameters: "create {#ServiceName} binPath= ""\""{app}\watchtower-svc.exe\"""" start= auto obj= LocalSystem DisplayName= ""Watchtower Monitoring Agent"""; \
    Flags: runhidden; \
    StatusMsg: "Registering Watchtower service..."
Filename: "{sys}\sc.exe"; \
    Parameters: "description {#ServiceName} ""Daily check-in to Umbrella Automation's Watchtower. Reports external IP, Veeam backup status, LogMeIn state, and asset inventory."""; \
    Flags: runhidden
Filename: "{sys}\sc.exe"; \
    Parameters: "failure {#ServiceName} reset= 86400 actions= restart/60000/restart/60000/restart/60000"; \
    Flags: runhidden
Filename: "{sys}\sc.exe"; \
    Parameters: "start {#ServiceName}"; \
    Flags: runhidden; \
    StatusMsg: "Starting Watchtower service..."

; ----------------------------------------------------------------------------
; Uninstall: stop + delete service, then [Code] cleans up ProgramData.
; ----------------------------------------------------------------------------
[UninstallRun]
Filename: "{sys}\sc.exe"; Parameters: "stop {#ServiceName}";   Flags: runhidden; RunOnceId: "StopWatchtower"
Filename: "{sys}\sc.exe"; Parameters: "delete {#ServiceName}"; Flags: runhidden; RunOnceId: "DeleteWatchtower"
Filename: "{cmd}";        Parameters: "/c taskkill /im watchtower-tray.exe /f"; Flags: runhidden; RunOnceId: "KillTray"

[UninstallDelete]
Type: filesandordirs; Name: "{commonappdata}\Watchtower"

; ----------------------------------------------------------------------------
; Pascal Script: generate per-install pcId UUID + write config.json
; ----------------------------------------------------------------------------
[Code]

function GenerateUuid(): string;
var
  ResultCode: Integer;
  TmpPath, Content: string;
  AnsiContent: AnsiString;
begin
  // Ask PowerShell for a fresh UUID. Capture by writing to a tmp file
  // because Inno's Exec() doesn't return stdout.
  TmpPath := ExpandConstant('{tmp}\watchtower-pcid.txt');
  Exec('powershell.exe',
       '-NoProfile -Command "[guid]::NewGuid().ToString() | Out-File -FilePath ''' + TmpPath + ''' -Encoding ASCII -NoNewline"',
       '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  if FileExists(TmpPath) and LoadStringFromFile(TmpPath, AnsiContent) then
  begin
    Content := Trim(string(AnsiContent));
    if Length(Content) >= 36 then
    begin
      Result := Content;
      Exit;
    end;
  end;

  // Fallback — extremely unlikely path. Hex from {tmp} path + random.
  Randomize();
  Result := Format('%.8x-%.4x-%.4x-%.4x-%.12x', [
    Random($FFFFFFFF), Random($FFFF), Random($FFFF), Random($FFFF), Random($FFFFFFFF)
  ]);
end;

function JsonEscape(const S: string): string;
var
  i: Integer;
  C: Char;
begin
  Result := '';
  for i := 1 to Length(S) do
  begin
    C := S[i];
    case C of
      '"': Result := Result + '\"';
      '\': Result := Result + '\\';
      #10: Result := Result + '\n';
      #13: Result := Result + '\r';
      #9:  Result := Result + '\t';
      else Result := Result + C;
    end;
  end;
end;

procedure WriteConfigJson(const PcId: string);
var
  ConfigDir, ConfigPath, Body: string;
begin
  ConfigDir := ExpandConstant('{commonappdata}\Watchtower');
  ForceDirectories(ConfigDir);
  ConfigPath := ConfigDir + '\config.json';

  Body :=
    '{' + #13#10 +
    '  "workerUrl": "'   + JsonEscape('{#WorkerUrl}')    + '",' + #13#10 +
    '  "installToken": "' + JsonEscape('{#InstallToken}') + '",' + #13#10 +
    '  "client": "'      + JsonEscape('{#ClientName}')   + '",' + #13#10 +
    '  "pcId": "'        + JsonEscape(PcId)              + '",' + #13#10 +
    '  "agentVersion": "' + JsonEscape('{#AppVersion}')  + '"' + #13#10 +
    '}' + #13#10;

  SaveStringToFile(ConfigPath, Body, False);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  PcId: string;
begin
  if CurStep = ssInstall then
  begin
    // Generate pcId BEFORE Files copy so it's ready when the service
    // first starts. We only generate a new UUID if config.json doesn't
    // already exist — re-running the installer over an existing install
    // should preserve the pcId so the dashboard sees the same host.
    PcId := '';
    if not FileExists(ExpandConstant('{commonappdata}\Watchtower\config.json')) then
    begin
      PcId := GenerateUuid();
      WriteConfigJson(PcId);
    end;
  end;
end;
