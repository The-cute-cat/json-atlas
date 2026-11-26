; Use the same capability path as the WiX installer for the Default apps entry.
!define JSON_ATLAS_CAPABILITIES "Software\The_cute_cat\JSON Atlas\Capabilities"

!macro JSON_ATLAS_REGISTER_DOCUMENT EXT PROGID ICON
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" '"$INSTDIR\${ICON}",0'
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
  WriteRegStr SHCTX "${JSON_ATLAS_CAPABILITIES}\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

!macro JSON_ATLAS_UNREGISTER_DOCUMENT EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey /ifempty SHCTX "Software\Classes\.${EXT}\OpenWithProgids"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro JSON_ATLAS_REGISTER_DOCUMENT "json" "JSONAtlas.Document" "document.ico"
  !insertmacro JSON_ATLAS_REGISTER_DOCUMENT "jsonl" "JSONAtlas.Jsonl" "document-jsonl.ico"
  !insertmacro JSON_ATLAS_REGISTER_DOCUMENT "ndjson" "JSONAtlas.Ndjson" "document-ndjson.ico"
  !insertmacro JSON_ATLAS_REGISTER_DOCUMENT "jsonlines" "JSONAtlas.JsonLines" "document-jsonlines.ico"
  WriteRegStr SHCTX "${JSON_ATLAS_CAPABILITIES}" "ApplicationName" "JSON Atlas"
  WriteRegStr SHCTX "${JSON_ATLAS_CAPABILITIES}" "ApplicationDescription" "Local JSON and JSONL reader"
  WriteRegStr SHCTX "${JSON_ATLAS_CAPABILITIES}" "ApplicationIcon" '"$INSTDIR\json-atlas.exe",0'
  WriteRegStr SHCTX "Software\RegisteredApplications" "JSON Atlas" "${JSON_ATLAS_CAPABILITIES}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend

; The standard uninstaller removes the ProgID before this hook runs.
; Invalidate Explorer's association/icon cache after all registrations are gone.
; Windows UserChoice is user-managed and must not be overwritten here.
!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro JSON_ATLAS_UNREGISTER_DOCUMENT "json" "JSONAtlas.Document"
  !insertmacro JSON_ATLAS_UNREGISTER_DOCUMENT "jsonl" "JSONAtlas.Jsonl"
  !insertmacro JSON_ATLAS_UNREGISTER_DOCUMENT "ndjson" "JSONAtlas.Ndjson"
  !insertmacro JSON_ATLAS_UNREGISTER_DOCUMENT "jsonlines" "JSONAtlas.JsonLines"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "JSON Atlas"
  DeleteRegKey SHCTX "${JSON_ATLAS_CAPABILITIES}"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
