; Installer add-on (electron-builder picks up build/installer.nsh automatically).
; On uninstall, remove the app from Windows autostart so Windows does not try to launch a deleted file at sign-in.
; Updates also run the old uninstaller - autostart is kept in that case.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.eyegym.app"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.eyegym.app"
  ${endIf}
!macroend
