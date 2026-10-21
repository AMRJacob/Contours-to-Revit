; Contours to Revit — Revit 2026 add-in installer (per user, no admin rights needed).
; Built by .github/workflows/revit-plugin.yml:  iscc /DAppVersion=x.y.z /DSrc=<build output> ContoursToRevit.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef Src
  #define Src "..\src\bin\Release\net8.0-windows"
#endif
#define AddinsDir "{userappdata}\Autodesk\Revit\Addins\2026"

[Setup]
AppId={{66FBEC4C-3C06-47FC-9042-532BF40D79D2}
AppName=Contours to Revit for Revit 2026
AppVersion={#AppVersion}
AppVerName=Contours to Revit {#AppVersion} (Revit 2026)
AppPublisher=AMR Architects
AppPublisherURL=https://github.com/AMRJacob/Contours-to-Revit
AppSupportURL=https://github.com/AMRJacob/Contours-to-Revit/issues
DefaultDirName={#AddinsDir}\ContoursToRevit
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=ContoursToRevit-Setup
OutputDir=..\out
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Contours to Revit (Revit 2026)
DisableWelcomePage=no
VersionInfoVersion={#AppVersion}
VersionInfoCompany=AMR Architects
VersionInfoDescription=Contours to Revit add-in installer
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible

[Messages]
WelcomeLabel2=This adds a Contours to Revit button to Revit 2026 (AMR tab › Site).%n%nIt is installed for your Windows account only — no administrator rights needed. Close Revit before continuing.
FinishedLabelNoIcons=Contours to Revit is installed.%n%nStart Revit 2026 and look for AMR › Site › Contours to Revit. The first time, Revit asks whether to load the add-in: choose "Always Load".

[InstallDelete]
; Remove files from earlier versions before copying the new ones.
Type: filesandordirs; Name: "{app}"

[Files]
Source: "..\ContoursToRevit.addin"; DestDir: "{#AddinsDir}"; Flags: ignoreversion
Source: "{#Src}\ContoursToRevit.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#Src}\ContoursToRevit.pdb"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist
; WebView2 fallback copy — used only if Revit hasn't loaded its own.
Source: "{#Src}\Microsoft.Web.WebView2.Core.dll"; DestDir: "{app}\webview2"; Flags: ignoreversion
Source: "{#Src}\Microsoft.Web.WebView2.Wpf.dll"; DestDir: "{app}\webview2"; Flags: ignoreversion
Source: "{#Src}\runtimes\win-x64\native\WebView2Loader.dll"; DestDir: "{app}\webview2"; Flags: ignoreversion

[UninstallDelete]
Type: files; Name: "{#AddinsDir}\ContoursToRevit.addin"
Type: filesandordirs; Name: "{app}"

[Code]
function RevitRunning(): Boolean;
var
  ResultCode: Integer;
  OutFile: String;
  Lines: TArrayOfString;
  I: Integer;
begin
  Result := False;
  OutFile := ExpandConstant('{tmp}\c2r-tasks.txt');
  if Exec(ExpandConstant('{cmd}'), '/C tasklist /FI "IMAGENAME eq Revit.exe" /NH > "' + OutFile + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    if LoadStringsFromFile(OutFile, Lines) then
      for I := 0 to GetArrayLength(Lines) - 1 do
        if Pos('revit.exe', Lowercase(Lines[I])) > 0 then Result := True;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = wpWelcome then
  begin
    while RevitRunning() do
    begin
      if MsgBox('Revit is running. Close Revit (save your work first), then click OK to continue.' + #13#10 + 'Click Cancel to stop the installation.', mbInformation, MB_OKCANCEL) = IDCANCEL then
      begin
        Result := False;
        Exit;
      end;
    end;
  end;
end;
