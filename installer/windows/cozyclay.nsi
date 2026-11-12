; CozyClay for Windows: one file to download and run. It installs for the current user only (no admin prompt), and
; carries a portable Node.js (node\) and the launcher (CozyClay.cmd), which runs the newest cozyclay from npm.
; Built by .github/workflows/installer.yml: makensis -DNODE_DIR=<unpacked node-win-x64> cozyclay.nsi
Unicode true
!include "MUI2.nsh"

Name "CozyClay"
OutFile "CozyClay-Setup.exe"
InstallDir "$LOCALAPPDATA\Programs\CozyClay"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "CozyClay"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\CozyClay"
!define MUI_ICON "cozyclay.ico"
!define MUI_UNICON "cozyclay.ico"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_TEXT "$(StartNow)"
!define MUI_FINISHPAGE_RUN_FUNCTION StartCozyClay

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "SimpChinese"
LangString StartNow ${LANG_ENGLISH} "Start CozyClay"
LangString StartNow ${LANG_KOREAN} "CozyClay 시작"
LangString StartNow ${LANG_SIMPCHINESE} "启动 CozyClay"

Function StartCozyClay
	ExecShell "" "$INSTDIR\CozyClay.cmd"
FunctionEnd

Section "CozyClay"
	SetOutPath "$INSTDIR"
	File "CozyClay.cmd"
	File "cozyclay.ico"
	SetOutPath "$INSTDIR\node"
	File /r "${NODE_DIR}\*.*"
	WriteUninstaller "$INSTDIR\Uninstall.exe"
	CreateShortcut "$DESKTOP\CozyClay.lnk" "$INSTDIR\CozyClay.cmd" "" "$INSTDIR\cozyclay.ico"
	CreateDirectory "$SMPROGRAMS\CozyClay"
	CreateShortcut "$SMPROGRAMS\CozyClay\CozyClay.lnk" "$INSTDIR\CozyClay.cmd" "" "$INSTDIR\cozyclay.ico"
	WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "CozyClay"
	WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\cozyclay.ico"
	WriteRegStr HKCU "${UNINSTALL_KEY}" "Publisher" "CozyClay"
	WriteRegStr HKCU "${UNINSTALL_KEY}" "URLInfoAbout" "https://cozyclay.org"
	WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
	WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
	WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
	Delete "$DESKTOP\CozyClay.lnk"
	RMDir /r "$SMPROGRAMS\CozyClay"
	RMDir /r "$INSTDIR"
	DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd
