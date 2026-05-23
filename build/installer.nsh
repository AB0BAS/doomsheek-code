; Custom NSIS include for Doomsheek code installer.
; Adds a "Visit our Telegram channel" checkbox on the final installer page
; that opens https://t.me/Doomshk in the user's default browser.
;
; Hook reference (electron-builder templates):
;   - customWelcomePage  → before license / install-mode pages
;   - customFinishPage   → replaces the default MUI_PAGE_FINISH (must insert it manually)
;   - customHeader       → runs AFTER assistedInstaller.nsh has already inserted
;                          MUI_PAGE_FINISH, so finish-page defines there are too late.

!macro customFinishPage
  ; --- Run app after install ---
  Function StartAppDoomsheek
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartAppDoomsheek"

  ; --- "Show readme" slot repurposed as a Telegram-channel link ---
  Function OpenDoomshkTelegram
    ExecShell "open" "https://t.me/Doomshk"
  FunctionEnd

  !define MUI_FINISHPAGE_SHOWREADME "https://t.me/Doomshk"
  !define MUI_FINISHPAGE_SHOWREADME_NOTCHECKED
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Подписаться на Telegram-канал @Doomshk"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION OpenDoomshkTelegram

  ; --- Finish page wording ---
  !define MUI_FINISHPAGE_TITLE "Doomsheek code установлен"
  !define MUI_FINISHPAGE_TEXT "Doomsheek code был успешно установлен на ваш компьютер.$\r$\n$\r$\nTelegram-канал автора:$\r$\nhttps://t.me/Doomshk"

  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Doomsheek code"
  !define MUI_WELCOMEPAGE_TEXT "Установщик Doomsheek code — бесплатного AI-редактора кода с поддержкой 22 LLM-провайдеров (BYOK).$\r$\n$\r$\nTelegram-канал автора: https://t.me/Doomshk$\r$\n$\r$\nНажмите «Далее», чтобы продолжить."
  !insertmacro MUI_PAGE_WELCOME
!macroend
