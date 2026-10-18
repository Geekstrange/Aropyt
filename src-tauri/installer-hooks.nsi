; Aropyt 的 NSIS 安装钩子：**完整建立文件关联**。
;
; 为什么不用 Tauri 的 fileAssociations 就够：
; 实测安装后 `HKCR\.md` 的默认 ProgId 是**空的** —— Tauri 建了 ProgId 键，
; 但没有建立「扩展名 → ProgId」这层映射（那一步在它的 NSIS 模板里是
; 可选的 FileAssociation 调用，没被触发）。结果就是：类型名能显示、
; 图标却还是应用图标、双击也不一定走 Aropyt。
;
; 这里直接把关联写全，不依赖 Tauri 那套：
;   <ProgId>            → 类型名 + DefaultIcon + open command
;   .<ext>              → 默认 ProgId + OpenWithProgids（右键"打开方式"里也能看到）
;
; 图标文件由 `bundle.resources` 随包分发到 $INSTDIR\icons\files\。

; 卸载时清掉本应用写过的关联（只在默认指向我们时才清默认值）
!macro UNSET_ASSOC EXT PROGID
  DeleteRegValue SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  ReadRegStr $0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $0 == "${PROGID}"
    DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
  ${EndIf}
!macroend

!macro AROPYT_SET_FILE_ICON PROGID ICON
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\icons\files\${ICON}"
!macroend

!macro AROPYT_ASSOC EXT PROGID ICON DESC
  ; 类型名（资源管理器的"类型"列显示的就是它）
  WriteRegStr SHCTX "Software\Classes\${PROGID}" "" "${DESC}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\icons\files\${ICON}"
  WriteRegStr SHCTX "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\Aropyt.exe" "%1"'
  ; 扩展名 → ProgId：默认关联 + OpenWith 列表
  WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "${PROGID}"
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}" ""
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro AROPYT_ASSOC "md"       "Aropyt.markdown" "markdown.ico" "Markdown 文档"
  !insertmacro AROPYT_ASSOC "markdown" "Aropyt.markdown" "markdown.ico" "Markdown 文档"
  !insertmacro AROPYT_ASSOC "tex"      "Aropyt.latex"    "latex.ico"    "LaTeX 文档"
  !insertmacro AROPYT_ASSOC "latex"    "Aropyt.latex"    "latex.ico"    "LaTeX 文档"
  !insertmacro AROPYT_ASSOC "fountain" "Aropyt.fountain" "fountain.ico" "Fountain 剧本"

  ; 通知资源管理器刷新图标缓存（否则要等重启才看到新图标）
  System::Call 'shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\Aropyt.markdown"
  DeleteRegKey SHCTX "Software\Classes\Aropyt.latex"
  DeleteRegKey SHCTX "Software\Classes\Aropyt.fountain"
  !insertmacro UNSET_ASSOC "md" "Aropyt.markdown"
  !insertmacro UNSET_ASSOC "markdown" "Aropyt.markdown"
  !insertmacro UNSET_ASSOC "tex" "Aropyt.latex"
  !insertmacro UNSET_ASSOC "latex" "Aropyt.latex"
  !insertmacro UNSET_ASSOC "fountain" "Aropyt.fountain"
!macroend
