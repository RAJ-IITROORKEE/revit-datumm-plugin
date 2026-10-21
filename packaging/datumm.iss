#ifndef Payload
  #error Payload must point to the verified staging directory
#endif
#ifndef PackageVersion
  #error PackageVersion is required
#endif
[Setup]
AppId={{D5F8E3C5-C425-4AA4-8C51-AB80F83634E4}
AppName=DATUMM Agent Development
AppVersion={#PackageVersion}
AppPublisher=DATUMM
DefaultDirName={localappdata}\Programs\DatummAgent
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\artifacts\releases
OutputBaseFilename=DatummAgent-{#PackageVersion}-unsigned-win-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupMutex=DatummAgentSetup
UninstallDisplayName=DATUMM Agent Development {#PackageVersion}
InfoBeforeFile=installer-notice.txt
VersionInfoVersion=0.5.0.2

[Files]
Source: "{#Payload}\*"; DestDir: "{app}\releases\{#PackageVersion}"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#Payload}\runtime\node.exe"; Flags: dontcopy
Source: "{#Payload}\setup.mjs"; Flags: dontcopy
Source: "{#Payload}\lifecycle.mjs"; Flags: dontcopy
Source: "{#Payload}\release.json"; Flags: dontcopy
Source: "{#Payload}\release-manifest.json"; Flags: dontcopy

[Icons]
Name: "{userprograms}\DATUMM Agent\Setup instructions"; Filename: "{app}\releases\{#PackageVersion}\QUICKSTART.txt"

[Code]
function RunHelper(const Mode: String; const Temporary: Boolean): Boolean;
var Node, Script: String; Code: Integer;
begin
  if Temporary then begin
    Node := ExpandConstant('{tmp}\node.exe');
    Script := ExpandConstant('{tmp}\setup.mjs');
  end else begin
    Node := ExpandConstant('{app}\releases\{#PackageVersion}\runtime\node.exe');
    Script := ExpandConstant('{app}\releases\{#PackageVersion}\setup.mjs');
  end;
  Result := Exec(Node, '"' + Script + '" ' + Mode, '', SW_HIDE, ewWaitUntilTerminated, Code);
  if Result then Result := Code = 0;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  if CompareText(ExpandConstant('{app}'), ExpandConstant('{localappdata}\Programs\DatummAgent')) <> 0 then begin
    Result := 'DATUMM requires its fixed per-user application directory.';
    Exit;
  end;
  ExtractTemporaryFile('node.exe');
  ExtractTemporaryFile('setup.mjs');
  ExtractTemporaryFile('lifecycle.mjs');
  ExtractTemporaryFile('release.json');
  ExtractTemporaryFile('release-manifest.json');
  if not RunHelper('check', True) then
    Result := 'Preflight failed. Close Revit and check %LOCALAPPDATA%\DatummAgent\installer.log. No models are closed automatically.';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    if not RunHelper('install', False) then
      RaiseException('DATUMM activation failed and registration was rolled back. See %LOCALAPPDATA%\DatummAgent\installer.log.');
end;

function InitializeUninstall(): Boolean;
begin
  Result := RunHelper('check-uninstall', False);
  if not Result then MsgBox('Cannot uninstall. Close Revit and check %LOCALAPPDATA%\DatummAgent\installer.log.', mbError, MB_OK);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    if not RunHelper('uninstall', False) then
      RaiseException('Registration removal failed. Installed files were retained; see installer.log.');
end;
