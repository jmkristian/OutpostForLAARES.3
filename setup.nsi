# Copyright 2018 by John Kristian
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

# This is meant to be interpreted by the Nullsoft scriptable install system http://nsis.sourceforge.net

Name "Los Altos ARES" "Outpost forms"
OutFile "OutpostForLAARES_Setup-0.4.exe"

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

!include LogicLib.nsh
!include TextFunc.nsh

Var /GLOBAL OUTPOST_CODE
Var /GLOBAL OUTPOST_DATA

Function StrContainsSpace
  Pop $0
  loop:
    ${If} $0 == ""
      Push false
      Return
    ${Endif}
    StrCpy $1 $0 1 0
    ${If} $1 == " "
      Push true
      Return
    ${Endif}
    StrLen $1 $0
    StrCpy $0 $0 $1 1
    GoTo loop
FunctionEnd
!macro StrContainsSpace OUT S
  Push `${S}`
  Call StrContainsSpace
  Pop `${OUT}`
!macroend
!define StrContainsSpace '!insertmacro "StrContainsSpace"'

Function .onInit
  ${If} $INSTDIR == ""
    StrCpy $INSTDIR "$APPDATA\OutpostForLAARES\"
    ${StrContainsSpace} $0 "$INSTDIR"
    ${If} $0 != false
      ReadEnvStr $0 SystemDrive
      StrCpy $INSTDIR "$0\OutpostForLAARES\"
    ${EndIf}
  ${EndIf}
FunctionEnd

!macro defineFindOutposts un
Function ${un}FindOutpost
  Pop $0
  ClearErrors
  ReadINIStr $1 "$0\Outpost.conf" DataDirectory DataDir
  ${IfNot} ${Errors}
    StrCpy $OUTPOST_CODE "$0"
    StrCpy $OUTPOST_DATA "$OUTPOST_DATA $\"$1$\""
  ${EndIf}
FunctionEnd

# Set $OUTPOST_CODE = a folder that contains Outpost executables, and
# set $OUTPOST_DATA = a space-separated list of folders that contain Outpost configuration files.
# If no such folders are found, set both variables to "".
# If Outpost and SCCo Packet are both installed, $OUTPOST_CODE will be SCCo Packet.
Function ${un}FindOutposts
  StrCpy $OUTPOST_CODE ""
  Push "$PROGRAMFILES\Outpost"
  Call ${un}FindOutpost
  ${If} "$PROGRAMFILES64" != "$PROGRAMFILES"
    Push "$PROGRAMFILES64\Outpost"
    Call ${un}FindOutpost
  ${EndIf}
  Push "$PROGRAMFILES\SCCo Packet"
  Call ${un}FindOutpost
  ${If} "$PROGRAMFILES64" != "$PROGRAMFILES"
    Push "$PROGRAMFILES64\SCCo Packet"
    Call ${un}FindOutpost
  ${EndIf}
FunctionEnd
!macroend
!insertmacro defineFindOutposts ""
!insertmacro defineFindOutposts "un."

Section "Install"
  StrCpy $OUTPOST_DATA ""
  Call FindOutposts
  ${If} "$OUTPOST_DATA" == ""
    MessageBox MB_OK "Outpost Packet Message Manager isn't installed, it appears. Please install it before installing this software."
    Abort "Please install Outpost PMM first."
  ${EndIf}

  # Where to install files:
  CreateDirectory "$INSTDIR"
  SetOutPath "$INSTDIR"

  # Files to install:
  File launch.cmd
  File LOSF.ini
  File LOSF.launch
  File README.md
  File /r bin
  File /r msgs
  File /r pack-it-forms
  CopyFiles "$OUTPOST_CODE\Aoclient.exe" "$INSTDIR\bin"

  # define uninstaller:
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                   "DisplayName" "Outpost for LAARES"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                   "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                   "Publisher" "Los Altos ARES"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                   "URLInfoAbout" "https://github.com/jmkristian/Outpost-for-LAARES/blob/master/README.md"
  WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                   "DisplayVersion" "0.4"
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                     "VersionMajor" 0
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                     "VersionMinor" 4
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                     "NoModify" 1
  WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES" \
                     "NoRepair" 1

  ExecWait "bin\launch.exe install$OUTPOST_DATA" $0
  ${If} $0 != 0
    Abort "bin\launch.exe install: exit status $0"
  ${EndIf}
SectionEnd
 
Section "Uninstall"
  SetOutPath "$INSTDIR"

  # Be sure to delete the uninstaller first.
  Delete "$INSTDIR\uninstall.exe"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\OutpostForLAARES"

  # Remove our line from Outpost configuration files
  Call un.FindOutposts
  ExecWait "bin\launch.exe uninstall$OUTPOST_DATA" $0

  Delete launch.cmd
  Delete LOSF.ini
  Delete LOSF.launch
  Delete README.md
  RMDir /r "$INSTDIR\bin"
  RMDir /r "$INSTDIR\msgs"
  RMDir /r "$INSTDIR\pack-it-forms"
  RMDir "$INSTDIR" # Do nothing if the directory is empty
SectionEnd
