; NSIS Installer Script for OpenWork Desktop
; Custom installer behaviors for Windows

!macro customInit
  ; Avoid external nsProcess plugin dependency. If a window is detected, ask user to close app manually.
  FindWindow $R0 "" "OpenWork Desktop"
  StrCmp $R0 0 done
  MessageBox MB_OK|MB_ICONEXCLAMATION "OpenWork Desktop appears to be running. Please close it before continuing setup."
done:
!macroend

!macro customInstall
  ; Create data directory for user data
  CreateDirectory "$APPDATA\OpenWork Desktop"
  CreateDirectory "$APPDATA\OpenWork Desktop\logs"
  CreateDirectory "$APPDATA\OpenWork Desktop\data"
!macroend

!macro customUnInstall
  ; Ask user if they want to remove user data
  MessageBox MB_YESNO|MB_ICONQUESTION "Do you want to remove all user data and settings?" IDNO skipDataRemoval
    RMDir /r "$APPDATA\OpenWork Desktop"
    RMDir /r "$APPDATA\ClaudeCodeDesktop"
  skipDataRemoval:
!macroend
