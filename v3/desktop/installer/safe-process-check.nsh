# electron-builder invokes this macro for both install and uninstall checks.
# Its stock check falls back to taskkill /IM when PowerShell is unavailable,
# which cannot distinguish a different ThreadTerm installation.  Keep this
# check read-only and only consider our application and bundled workers below
# this exact $INSTDIR.
!macro customCheckAppRunning
  Push $0
  Push $1

  threadterm_nsis_check_start:
  # Pass the installer-selected directory through the process environment so
  # it is never interpolated into PowerShell source code.
  System::Call 'kernel32::SetEnvironmentVariable(t "THREADTERM_NSIS_INSTALLDIR", t "$INSTDIR") i.r0'
  ${If} $0 == 0
    Goto threadterm_nsis_check_failed
  ${EndIf}

  # ExecToStack lets us require both a successful exit code and an explicit
  # response marker. An unavailable PowerShell/CIM query (including policy
  # failures), or a relevant process whose executable path cannot be read,
  # therefore blocks the operation instead of treating it as "not running".
  nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "& { $$ErrorActionPreference = 'Stop'; try { $$installDir = [Environment]::GetEnvironmentVariable('THREADTERM_NSIS_INSTALLDIR', 'Process'); if ([String]::IsNullOrWhiteSpace($$installDir)) { [Console]::Out.Write('THREADTERM_NSIS_CHECK_ERROR'); exit 2 }; $$installDir = [IO.Path]::GetFullPath($$installDir).TrimEnd('\', '/'); $$prefix = $$installDir + '\'; $$names = @('ThreadTerm.exe', 'threadterm-v3-runtime.exe', 'threadterm-v3-mcp.exe', 'claude-sdk-cli.exe'); $$running = $$false; foreach ($$process in @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object { $$names -contains $$_.Name })) { if ([String]::IsNullOrWhiteSpace($$process.ExecutablePath)) { [Console]::Out.Write('THREADTERM_NSIS_CHECK_ERROR'); exit 2 }; $$processPath = [IO.Path]::GetFullPath($$process.ExecutablePath); if ($$processPath.StartsWith($$prefix, [StringComparison]::OrdinalIgnoreCase)) { $$running = $$true; break } }; if ($$running) { [Console]::Out.Write('THREADTERM_NSIS_CHECK_RUNNING'); exit 0 } else { [Console]::Out.Write('THREADTERM_NSIS_CHECK_CLEAR'); exit 0 } } catch { [Console]::Out.Write('THREADTERM_NSIS_CHECK_ERROR'); exit 2 } }"`
  Pop $0
  Pop $1

  StrCmp $0 "0" 0 threadterm_nsis_check_failed
  StrCmp $1 "THREADTERM_NSIS_CHECK_CLEAR" threadterm_nsis_check_done
  StrCmp $1 "THREADTERM_NSIS_CHECK_RUNNING" threadterm_nsis_check_running

  threadterm_nsis_check_failed:
    IfSilent threadterm_nsis_check_failed_silent
    MessageBox MB_OK|MB_ICONEXCLAMATION "ThreadTerm could not verify whether this installation is in use. Close ThreadTerm and try again."
    Quit
  threadterm_nsis_check_failed_silent:
    SetErrorLevel 2
    Quit

  threadterm_nsis_check_running:
    IfSilent threadterm_nsis_check_running_silent
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "ThreadTerm is running from this installation. Close it, then click Retry." IDRETRY threadterm_nsis_check_retry
    Quit
  threadterm_nsis_check_running_silent:
    SetErrorLevel 2
    Quit
  threadterm_nsis_check_retry:
    Goto threadterm_nsis_check_start

  threadterm_nsis_check_done:
  Pop $1
  Pop $0
!macroend

# electron-builder's stock upgrade path executes the registered old
# uninstaller before it copies this version's files.  The first transition to
# this safe installer must therefore refuse an unmarked predecessor instead
# of giving that predecessor a chance to use its global taskkill fallback.
!macro customInit
  ReadRegStr $R0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "ThreadTermSafeProcessCheck"
  ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R1 != ""
  ${AndIf} $R0 != "path-bound-v1"
    Goto threadterm_nsis_legacy_upgrade
  ${EndIf}

  # A per-machine upgrade also invokes the current-user uninstaller. Check it
  # here as well so neither inherited executable can run before installation.
  ReadRegStr $R0 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" "ThreadTermSafeProcessCheck"
  ReadRegStr $R1 HKEY_CURRENT_USER "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${If} $R1 != ""
  ${AndIf} $R0 != "path-bound-v1"
    Goto threadterm_nsis_legacy_upgrade
  ${EndIf}
  Goto threadterm_nsis_legacy_upgrade_done

  threadterm_nsis_legacy_upgrade:
    IfSilent threadterm_nsis_legacy_upgrade_silent
    MessageBox MB_OK|MB_ICONEXCLAMATION "This ThreadTerm installation was created by an older installer. Uninstall that existing ThreadTerm installation from Windows Settings, then run this installer again."
    Quit
  threadterm_nsis_legacy_upgrade_silent:
    SetErrorLevel 2
    Quit
  threadterm_nsis_legacy_upgrade_done:
!macroend

# Later upgrades can identify this path-bound installer without inspecting or
# executing an earlier unmarked uninstaller.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "ThreadTermSafeProcessCheck" "path-bound-v1"
!macroend
