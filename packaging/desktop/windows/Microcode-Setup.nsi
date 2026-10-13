Unicode true

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"

!ifndef PROJECT_VERSION
  !error "PROJECT_VERSION is required."
!endif
!ifndef OUTPUT_FILE
  !error "OUTPUT_FILE is required."
!endif
!ifndef PACKAGE_DIRECTORY
  !error "PACKAGE_DIRECTORY is required."
!endif
!ifndef UNINSTALL_FILES
  !error "UNINSTALL_FILES is required."
!endif
!ifndef BRAND_ICON
  !error "BRAND_ICON is required."
!endif
!ifndef WIZARD_BITMAP
  !error "WIZARD_BITMAP is required."
!endif

!ifdef SMOKE_TEST
  !define SETTINGS_KEY "Software\Microcode\Smoke-${SMOKE_ID}"
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MicrocodeSmoke-${SMOKE_ID}"
  !define START_MENU_FOLDER "Microcode Smoke ${SMOKE_ID}"
  !define START_MENU_PATH "${SMOKE_START_MENU_PATH}"
  !define DESKTOP_SHORTCUT_PATH "${SMOKE_DESKTOP_PATH}\Microcode.lnk"
!else
  !define SETTINGS_KEY "Software\Microcode\Desktop"
  !define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\MicrocodeDesktop"
  !define START_MENU_FOLDER "Microcode"
  !define START_MENU_PATH "$SMPROGRAMS\${START_MENU_FOLDER}"
  !define DESKTOP_SHORTCUT_PATH "$DESKTOP\Microcode.lnk"
!endif

Name "Microcode ${PROJECT_VERSION}"
Caption "Microcode Setup"
BrandingText "Microcode"
OutFile "${OUTPUT_FILE}"
!ifdef SMOKE_TEST
  InstallDir "${SMOKE_DEFAULT_INSTALL_DIR}"
!else
  InstallDir "$LOCALAPPDATA\Programs\Microcode"
!endif
InstallDirRegKey HKCU "${SETTINGS_KEY}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
CRCCheck force
XPStyle on
ShowInstDetails show
ShowUninstDetails show
VIProductVersion "${PROJECT_VERSION}.0"
VIAddVersionKey /LANG=1033 "ProductName" "Microcode"
VIAddVersionKey /LANG=1033 "FileDescription" "Microcode Desktop Setup"
VIAddVersionKey /LANG=1033 "CompanyName" "Microcode"
VIAddVersionKey /LANG=1033 "FileVersion" "${PROJECT_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copyright (C) Microcode contributors"

!define MUI_ABORTWARNING
!define MUI_ICON "${BRAND_ICON}"
!define MUI_UNICON "${BRAND_ICON}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${WIZARD_BITMAP}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${WIZARD_BITMAP}"
LangString COMPONENTS_INTRO 1033 "Choose whether to create an additional desktop shortcut."
LangString COMPONENTS_INTRO 2052 "选择是否在桌面创建快捷方式。"
LangString DESKTOP_SHORTCUT_SECTION 1033 "Create a desktop shortcut"
LangString DESKTOP_SHORTCUT_SECTION 2052 "创建桌面快捷方式"
!define MUI_COMPONENTSPAGE_TEXT_TOP "$(COMPONENTS_INTRO)"
!define MUI_FINISHPAGE_RUN "$INSTDIR\Microcode.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch Microcode"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "${SETTINGS_KEY}"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"


Function .onInit
  SetShellVarContext current
  !insertmacro MUI_LANGDLL_DISPLAY
!ifdef SMOKE_TEST
  ReadRegStr $R1 HKCU "${UNINSTALL_KEY}" "InstallLocation"
!else
  ReadRegStr $R1 HKCU "${UNINSTALL_KEY}" "InstallLocation"
  StrCmp $R1 "" init_done
  IfFileExists "$R1\Microcode.exe" 0 no_previous_install
  StrCpy $INSTDIR $R1
  Goto init_done
  no_previous_install:
  StrCpy $R1 ""
  init_done:
!endif
FunctionEnd

Function un.onInit
  !insertmacro MUI_UNGETLANGUAGE
  SetShellVarContext current
FunctionEnd

Section "Microcode Desktop (required)" SecCore
  SectionIn RO
  ${If} $R1 != ""
    GetFullPathName $0 "$R1"
    GetFullPathName $1 "$INSTDIR"
    StrCmp $0 $1 0 different_install_directory
  ${EndIf}
  Goto install_directory_validated
  different_install_directory:
  MessageBox MB_OK|MB_ICONEXCLAMATION "Microcode is already installed at $R1. Uninstall it first before choosing a different directory."
  Abort
  install_directory_validated:
  GetTempFileName $R0 "$TEMP"
  Delete "$R0"
  CreateDirectory "$R0\release"
  SetOutPath "$R0\release"
  File /r "${PACKAGE_DIRECTORY}\*"

  DetailPrint "Verifying the release manifest and files..."
  DetailPrint "Installing Microcode into $INSTDIR..."
  ClearErrors
  nsExec::ExecToStack /TIMEOUT=600000 '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "$R0\release\Install-Microcode.ps1" -InstallRoot "$INSTDIR" -InstallerManaged'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    RMDir /r "$R0"
    FileOpen $R0 "$TEMP\Microcode-Setup-${PROJECT_VERSION}.log" a
    FileWrite $R0 "PowerShell installer exit: $0$\r$1$\r$\n"
    FileClose $R0
    Abort "Microcode could not be installed. See $TEMP\Microcode-Setup-${PROJECT_VERSION}.log for details."
  ${EndIf}

  RMDir /r "$R0"
  WriteUninstaller "$INSTDIR\Uninstall Microcode.exe"
  WriteRegStr HKCU "${SETTINGS_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "Microcode"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${PROJECT_VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "Microcode"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\resources\microcode.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" "$\"$INSTDIR\Uninstall Microcode.exe$\""
  WriteRegStr HKCU "${UNINSTALL_KEY}" "QuietUninstallString" "$\"$INSTDIR\Uninstall Microcode.exe$\" /S"
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1

  CreateDirectory "${START_MENU_PATH}"
  CreateShortCut "${START_MENU_PATH}\Microcode.lnk" "$INSTDIR\Microcode.exe" "" "$INSTDIR\resources\microcode.ico"
  CreateShortCut "${START_MENU_PATH}\Uninstall Microcode.lnk" "$INSTDIR\Uninstall Microcode.exe" "" "$INSTDIR\resources\microcode.ico"
SectionEnd

Section "$(DESKTOP_SHORTCUT_SECTION)" SecDesktop
  SectionIn 1
  CreateShortCut "${DESKTOP_SHORTCUT_PATH}" "$INSTDIR\Microcode.exe" "" "$INSTDIR\resources\microcode.ico"
SectionEnd

Section -DesktopShortcutCleanup
  SectionGetFlags ${SecDesktop} $0
  IntOp $0 $0 & ${SF_SELECTED}
  ${If} $0 == 0
    Delete "${DESKTOP_SHORTCUT_PATH}"
  ${EndIf}
SectionEnd

Section "Uninstall"
  !include "${UNINSTALL_FILES}"
  Delete "$INSTDIR\release-manifest.json"
  Delete "$INSTDIR\release-manifest.sha256"
  Delete "$INSTDIR\Uninstall Microcode.exe"
  RMDir "$INSTDIR"

  Delete "${START_MENU_PATH}\Microcode.lnk"
  Delete "${START_MENU_PATH}\Uninstall Microcode.lnk"
  RMDir "${START_MENU_PATH}"
  Delete "${DESKTOP_SHORTCUT_PATH}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "${SETTINGS_KEY}"
SectionEnd
