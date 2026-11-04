; BrowserForge for Windows: an installer for one user, with no administrator rights.
;
; It installs three things under %LOCALAPPDATA%\Programs\BrowserForge:
;   node\   the official Node.js 22 for Windows (so nothing has to be installed first, and `browserforge plugin add` still finds npm)
;   app\    the program from `npm run release` (bin\browserforge.mjs, the extensions, skills, docs)
;   browserforge.cmd   the command, added to your PATH
; Settings, tokens, flows and logs live in %APPDATA%\browserforge and are never touched by installing or uninstalling.
;
; Build (done by .github/workflows/windows-installer.yml):
;   ISCC /DAppVersion=0.2.0 /DReleaseDir=<release\browserforge-mcp-0.2.0> /DNodeDir=<unzipped node-v22.x-win-x64> /DOutDir=<where to write the .exe> browserforge.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef ReleaseDir
  #error Pass /DReleaseDir=<the folder npm run release wrote>
#endif
#ifndef NodeDir
  #error Pass /DNodeDir=<the unzipped official Node.js for Windows x64>
#endif
#ifndef OutDir
  #define OutDir "."
#endif

#define Chrome  "https://chromewebstore.google.com/detail/browserforge/ihbkpcclcolaeppmfgmndmemjljmiaec"
#define Firefox "https://addons.mozilla.org/en-US/firefox/addon/browserforge/"
#define Home    "https://github.com/zoghlamimostafa/BrowserForge-MCP"

[Setup]
AppId={{AA771CB4-1C4B-4F85-A9D7-C092BFE50802}
AppName=BrowserForge
AppVersion={#AppVersion}
AppVerName=BrowserForge {#AppVersion}
AppPublisher=BrowserForge contributors
AppPublisherURL={#Home}
AppSupportURL={#Home}/issues
AppUpdatesURL={#Home}/releases
VersionInfoVersion={#AppVersion}
DefaultDirName={localappdata}\Programs\BrowserForge
DefaultGroupName=BrowserForge
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
SetupIconFile=browserforge.ico
UninstallDisplayIcon={app}\browserforge.ico
LicenseFile={#ReleaseDir}\LICENSE
OutputDir={#OutDir}
OutputBaseFilename=BrowserForge-Setup-{#AppVersion}
; Adding to PATH changes the user's environment: tell Windows so new terminals see it.
ChangesEnvironment=yes
; If the server is running (it holds node.exe open), offer to close it instead of failing half way.
CloseApplications=yes
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "addtopath"; Description: "Add the &browserforge command to my PATH (so it works in PowerShell and cmd)"
Name: "autostart"; Description: "Start the BrowserForge &server when I sign in"; Flags: unchecked

[Files]
Source: "{#NodeDir}\*"; DestDir: "{app}\node"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#ReleaseDir}\*"; DestDir: "{app}\app"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "browserforge.cmd"; DestDir: "{app}"; Flags: ignoreversion
Source: "browserforge.ico"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
; The server keeps its window open (cmd /k) so a start-up error can be read.
Name: "{group}\BrowserForge server"; Filename: "{sys}\cmd.exe"; Parameters: "/k """"{app}\browserforge.cmd"" serve"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\browserforge.ico"; Comment: "Start the local BrowserForge server. Keep this window open while your agent works."
Name: "{group}\BrowserForge dashboard"; Filename: "{sys}\cmd.exe"; Parameters: "/c """"{app}\browserforge.cmd"" dashboard || pause"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\browserforge.ico"; Comment: "See tools, plugins, skills and flows (the server must be running)."
Name: "{group}\Setup steps and tokens"; Filename: "{sys}\cmd.exe"; Parameters: "/k """"{app}\browserforge.cmd"" setup"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\browserforge.ico"; Comment: "Show the extension token and how to connect Claude Code or Codex."
Name: "{group}\Uninstall BrowserForge"; Filename: "{uninstallexe}"
; Runs the server minimised when you sign in (only if you ticked the task).
Name: "{userstartup}\BrowserForge server"; Filename: "{sys}\cmd.exe"; Parameters: "/c """"{app}\browserforge.cmd"" serve"""; WorkingDir: "{userdocs}"; IconFilename: "{app}\browserforge.ico"; Flags: runminimized; Tasks: autostart

[INI]
Filename: "{group}\Add BrowserForge to Chrome (Chrome Web Store).url"; Section: "InternetShortcut"; Key: "URL"; String: "{#Chrome}"
Filename: "{group}\Add BrowserForge to Firefox (Firefox Add-ons).url"; Section: "InternetShortcut"; Key: "URL"; String: "{#Firefox}"
Filename: "{group}\BrowserForge on GitHub.url"; Section: "InternetShortcut"; Key: "URL"; String: "{#Home}"
Filename: "{group}\BrowserForge documentation.url"; Section: "InternetShortcut"; Key: "URL"; String: "{#Home}/tree/main/docs"

[UninstallDelete]
; Shortcuts written by [INI] are plain files: remove them, so the Start-menu folder can go too.
Type: files; Name: "{group}\*.url"

[Registry]
; The user's own PATH (HKCU), never the machine's. Removed again on uninstall (see [Code]).
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{code:AppendToPath|{app}}"; Check: NeedsAddPath(ExpandConstant('{app}')); Tasks: addtopath

[Run]
Filename: "{sys}\cmd.exe"; Parameters: "/k """"{app}\browserforge.cmd"" setup"""; WorkingDir: "{userdocs}"; Description: "Show the setup steps (extension token, how to connect Claude Code or Codex)"; Flags: postinstall nowait skipifsilent
Filename: "{#Chrome}"; Description: "Open the Chrome Web Store page (Chrome, Edge, Brave)"; Flags: postinstall shellexec skipifsilent unchecked
Filename: "{#Firefox}"; Description: "Open the Firefox Add-ons page"; Flags: postinstall shellexec skipifsilent unchecked
Filename: "{sys}\cmd.exe"; Parameters: "/k """"{app}\browserforge.cmd"" serve"""; WorkingDir: "{userdocs}"; Description: "Start the BrowserForge server now"; Flags: postinstall nowait skipifsilent unchecked

[Code]
// The user's own PATH with the install folder added, without doubling the separator. The value is read as it is stored (still holding
// things like %USERPROFILE%), so the user's other entries are written back unchanged.
function AppendToPath(Dir: string): string;
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then Paths := '';
  while (Length(Paths) > 0) and (Paths[Length(Paths)] = ';') do Delete(Paths, Length(Paths), 1);
  if Paths = '' then Result := Dir else Result := Paths + ';' + Dir;
end;

function NeedsAddPath(Dir: string): Boolean;
var
  Paths: string;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';') = 0;
end;

procedure RemoveFromPath(Dir: string);
var
  Paths: string;
  P: Integer;
begin
  if not RegQueryStringValue(HKCU, 'Environment', 'Path', Paths) then exit;
  P := Pos(';' + Uppercase(Dir) + ';', ';' + Uppercase(Paths) + ';');
  if P = 0 then exit;
  // P counts from the padded copy, so it is also the first character of Dir in Paths. Take the separator before it, or after it when it is first.
  if P > 1 then
    Delete(Paths, P - 1, Length(Dir) + 1)
  else
    Delete(Paths, 1, Length(Dir) + 1);
  RegWriteExpandStringValue(HKCU, 'Environment', 'Path', Paths);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
  begin
    RemoveFromPath(ExpandConstant('{app}'));
    if not UninstallSilent then
      MsgBox('BrowserForge was removed.' + #13#10#13#10 +
        'Your settings, tokens, recorded flows and logs in' + #13#10 +
        ExpandConstant('{userappdata}\browserforge') + #13#10 +
        'were kept. Delete that folder yourself if you want them gone.' + #13#10#13#10 +
        'The browser extension is removed from your browser''s own extensions page.', mbInformation, MB_OK);
  end;
end;
