; The executable uses the application icon; associated documents use their own icon.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\JSONAtlas.Document\DefaultIcon" "" '"$INSTDIR\document.ico",0'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

; The standard uninstaller removes the ProgID before this hook runs.
; Invalidate Explorer's association/icon cache after all registrations are gone.
; Windows UserChoice is user-managed and must not be overwritten here.
!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
