; Callisto (V1.0): registro como navegador para el usuario actual (sin permisos de administrador).
; Con esto Callisto aparece en Configuración de Windows > Aplicaciones > Aplicaciones predeterminadas; elegirlo como
; predeterminado lo hace el usuario ahí (Windows 10/11 no permite que un programa se ponga solo).
; El desinstalador borra todo lo que se escribe acá.

!define CALLISTO_CLIENT "Software\Clients\StartMenuInternet\Callisto"

!macro customInstall
  WriteRegStr HKCU "${CALLISTO_CLIENT}" "" "Callisto"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\DefaultIcon" "" "$INSTDIR\Callisto.exe,0"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\shell\open\command" "" '"$INSTDIR\Callisto.exe"'
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities" "ApplicationName" "Callisto"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities" "ApplicationDescription" "Navegador web Callisto"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities" "ApplicationIcon" "$INSTDIR\Callisto.exe,0"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities\StartMenu" "StartMenuInternet" "Callisto"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities\URLAssociations" "http" "CallistoURL"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities\URLAssociations" "https" "CallistoURL"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities\FileAssociations" ".htm" "CallistoHTML"
  WriteRegStr HKCU "${CALLISTO_CLIENT}\Capabilities\FileAssociations" ".html" "CallistoHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "Callisto" "${CALLISTO_CLIENT}\Capabilities"

  WriteRegStr HKCU "Software\Classes\CallistoURL" "" "Dirección web (Callisto)"
  WriteRegStr HKCU "Software\Classes\CallistoURL\DefaultIcon" "" "$INSTDIR\Callisto.exe,0"
  WriteRegStr HKCU "Software\Classes\CallistoURL\shell\open\command" "" '"$INSTDIR\Callisto.exe" "%1"'
  WriteRegStr HKCU "Software\Classes\CallistoHTML" "" "Documento HTML (Callisto)"
  WriteRegStr HKCU "Software\Classes\CallistoHTML\DefaultIcon" "" "$INSTDIR\Callisto.exe,0"
  WriteRegStr HKCU "Software\Classes\CallistoHTML\shell\open\command" "" '"$INSTDIR\Callisto.exe" "%1"'

  ; Avisar a Windows que cambiaron las asociaciones
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "${CALLISTO_CLIENT}"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Callisto"
  DeleteRegKey HKCU "Software\Classes\CallistoURL"
  DeleteRegKey HKCU "Software\Classes\CallistoHTML"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
