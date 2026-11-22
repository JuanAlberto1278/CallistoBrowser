# Callisto — Investigación técnica y plan de desarrollo

> Fase 0 (investigación y planificación). **No contiene código ni decisiones ejecutadas.**
> Fecha: 2026-11-21. Estado: **pendiente de aprobación**.

---

## 0. Entorno inspeccionado

| Elemento | Valor | Comentario |
|---|---|---|
| Sistema operativo | Windows 11 Pro 10.0.26200, 64 bits | OK |
| CPU | AMD Ryzen 5 9600X, 6 núcleos / 12 hilos | Suficiente para Electron; muy justo para compilar Chromium |
| RAM | 15,6 GB | Suficiente para Electron; **insuficiente en la práctica para compilar Chromium** (Google recomienda >16 GB) |
| Disco | C: 84,7 GB libres · F: 380,4 GB libres | OK |
| Node.js | v26.10.0 | OK para herramientas (Electron trae su propio Node interno) |
| npm | 11.19.1 | OK |
| Git | 2.55.0 | OK (la carpeta del proyecto todavía no es un repositorio) |
| GitHub CLI | instalado | OK |
| Python | 3.13.14 | No es necesario para Electron |
| .NET SDK | 10.0.403 | Útil para un pequeño helper de Windows Hello (ver §6) |
| VS Code | 1.146.0 | OK |
| Visual Studio / Build Tools C++ | **no instalado** | Solo haría falta si usamos módulos nativos de C++ |
| Windows SDK | **no instalado** | Ídem |
| Rust / Cargo | no instalado | Solo necesario para Tauri (no recomendado) |
| WebView2 Runtime | 157.0.4341.60 | Presente (relevante solo si se eligiera WebView2) |
| Microsoft Edge | 158.0.4370.33 | Referencia de la versión actual de Chromium estable (~158) |

No se instaló ni modificó nada.

---

## 1. Tecnologías evaluadas (resumen)

| Tecnología | Qué es | Motor | Lenguaje principal |
|---|---|---|---|
| **Electron** | Framework de escritorio que **empaqueta su propio Chromium** + Node.js | Chromium (incluido en la app) | TypeScript/JavaScript |
| **Fork de Chromium** | Compilar y modificar Chromium (como Brave, Vivaldi, Edge) | Chromium (código fuente propio) | C++ |
| **CEF / CefSharp** | Chromium Embedded Framework: Chromium como biblioteca embebible | Chromium (binarios precompilados) | C++ (o C# con CefSharp) |
| **WebView2** | Control de Microsoft que usa el **runtime de Edge** instalado en Windows | Edge/Chromium (runtime de Microsoft) | C#/C++ |
| **Tauri** | Framework Rust que en Windows usa WebView2 por debajo | WebView2 | Rust + web |
| Qt WebEngine | Chromium dentro de Qt | Chromium | C++/Python |
| Fork de Firefox (Gecko) | Como Zen o Floorp | Gecko | C++/JS |

Datos actuales verificados:
- Electron estable más reciente: **45.3.3 (14-nov-2026), Chromium 156, Node 24.22.3**. Nueva versión mayor cada 8 semanas; se soportan las **3 últimas mayores**; Chromium se actualiza 1–2 semanas después de cada estable de Chromium (en milestones alternos). Electron 46 está en alfa con Chromium 159.
- CEF: el runtime "Alloy" fue retirado (CefSharp lo eliminó en 128.4.9); las extensiones solo funcionan con browsers "Chrome style".
- WebView2: soporta perfiles, InPrivate y extensiones desempaquetadas, con limitaciones importantes (ver §3–§8).

---

## 2. Comparación técnica

Escala: ●●● bueno · ●● aceptable con trabajo · ● débil · ✕ no viable

| Criterio | Importancia | Electron | Fork Chromium | CEF (Chrome style) | WebView2 | Tauri |
|---|---|---|---|---|---|---|
| Compatibilidad web moderna | Muy alta | ●●● | ●●● | ●●● | ●●● | ●●● |
| Extensiones Chromium | **Crítica** | ●● (parcial, ver §3) | ●●● (completa) | ●●? (prometedora, no verificada) | ● | ● |
| Sistema de pestañas | Crítica | ●●● | ●●● (ya existe) | ●● | ●●● | ● (multi-webview inestable) |
| Perfiles independientes | Crítica | ●●● | ●●● | ●●● | ●●● | ●● |
| Cookies/sesiones persistentes | Crítica | ●●● | ●●● | ●●● | ●●● | ●●● |
| Modo privado | Alta | ●●● | ●●● | ●●● | ●●● | ●● |
| Administrador de contraseñas | Alta | ●● (propio, con DPAPI) | ●●● (el de Chrome) | ●●? | ● (el de Edge, sin API de gestión) | ● |
| Interceptación de descargas | **Crítica** | ●● (ver §8) | ●●● (se puede parchear) | ●● | ● (la descarga sigue mientras se pregunta) | ● |
| Control de descargas automáticas | **Crítica** | ●● | ●●● | ●● | ● | ● |
| Seguridad | Crítica | ●● (requiere endurecimiento) | ●●● si se mantiene al día; ✕ si se atrasa | ●● | ●●● (Microsoft actualiza) | ●● |
| Consumo de recursos | Alta | ●● | ●●● | ●● | ●●● (comparte runtime) | ●●● |
| Rendimiento | Alta | ●●● | ●●● | ●●● | ●●● | ●●● |
| Facilidad de desarrollo | Alta | ●●● | ✕ | ● (C++) / ●● (C#) | ●● | ● |
| Mantenimiento | Alta | ●● (actualizar cada ~8 semanas) | ✕ (rebase cada 4 semanas de un código de >30 M líneas) | ●● | ●●● | ●● |
| Actualizaciones del motor | Crítica | ●● (nosotros lo actualizamos; lag de ~1–2 milestones) | ✕ para una sola persona | ●● | ●●● (automáticas, pero no las controlamos) | ●●● |
| Distribución en Windows | Alta | ●●● | ●● | ●● | ●●● | ●●● |
| Desarrollo desde VS Code | Alta | ●●● | ● | ● / ●● | ●● | ●● |
| Flexibilidad futura | Crítica | ●●● | ●●● | ●● | ● (sin acceso al motor) | ● |

**Descartes rápidos**
- **Fork de Chromium**: es lo único que da compatibilidad total con extensiones y control absoluto, pero exige ~100 GB de checkout, compilaciones de horas (con 15,6 GB de RAM y 6 núcleos, muy lentas), y rebasar parches cada 4 semanas para no quedar expuesto a vulnerabilidades. Brave/Vivaldi/Edge tienen equipos dedicados para esto. Para este proyecto es **inviable de mantener**, y un fork desactualizado es peor que no tenerlo.
- **Tauri**: en Windows es WebView2 con menos API expuesta y Rust como capa extra. Hereda todas las limitaciones de WebView2 sin ventajas para un navegador.
- **Qt WebEngine**: no soporta extensiones de Chrome. Descartado por el requisito crítico.
- **Fork de Firefox**: no es Chromium; extensiones desde AMO, no desde Chrome Web Store; compilación igual de pesada. Descartado.

Quedan tres candidatos reales: **Electron**, **CEF** y **WebView2**.

---

## 3. Compatibilidad real con extensiones

Este es el punto más débil de **todas** las opciones embebibles. Resultados de la investigación:

### Electron
- La documentación oficial dice textualmente que Electron soporta **un subconjunto** de la API de extensiones, pensado para DevTools, y que **no soporta extensiones arbitrarias de la Chrome Web Store**; la compatibilidad total es un "non-goal" del proyecto.
- Núcleo de Electron: `chrome.runtime` (parcial), `chrome.storage` (local; `sync` se guarda local sin sincronizar), `chrome.scripting`, `chrome.tabs` (parcial), `chrome.management` (parcial), `chrome.webRequest`, `chrome.devtools.*`. Solo carga extensiones **desempaquetadas**, **por sesión**, y **no en sesiones en memoria** (no habrá extensiones en modo privado). No recuerda extensiones entre reinicios: la app debe recargarlas.
- **`electron-chrome-extensions`** (Samuel Maddock, MIT, requiere Electron ≥ 35): agrega `chrome.action` (botones y popups), `chrome.tabs` casi completo, `chrome.windows`, `chrome.contextMenus`, `chrome.cookies`, `chrome.commands`, `chrome.notifications`, `chrome.webNavigation`. Limitaciones declaradas: los scripts de fondo se tratan como persistentes; usar `session.webRequest` de Electron impide que se llamen los listeners de `chrome.webRequest`.
- **`electron-chrome-web-store`** (mismo autor): **instala y actualiza extensiones desde la Chrome Web Store** (autoactualización al iniciar y cada 5 h), por sesión, con lista de permitidas/bloqueadas y un hook `beforeInstall` para pedir confirmación.
- **Manifest V3**: los service workers de extensiones están soportados desde Electron 35 (PR #44411, fusionado en enero de 2025). Un reporte de julio de 2026 (issue #52265) confirma que **registro de service worker, `chrome.scripting` y `chrome.tabs` funcionan**, pero que `chrome.webRequest` no tiene bindings en service workers MV3 y que `declarativeNetRequest` era indefinido en ese contexto. Electron 45.1.0 corrigió un bug de reglas DNR, así que DNR existe al menos parcialmente. **Estado: incompleto e inconsistente; debe verificarse empíricamente.**
- APIs que **no aparecen** en ninguna de las dos capas (probablemente no funcionen): `chrome.identity` (inicio de sesión de Google en extensiones), `chrome.downloads`, `chrome.sidePanel`, `chrome.offscreen`, `chrome.userScripts`, `chrome.nativeMessaging`, `chrome.alarms` (no listada; muy usada en MV3, verificar).
- Conflicto importante: según el PR #55700 (2026), **registrar listeners en `session.webRequest` desactiva `chrome.webRequest` y las reglas DNR de las extensiones**. Esto condiciona el diseño de descargas (§8): Callisto no puede usar `session.webRequest` libremente si quiere bloqueadores de anuncios funcionales.
- Cargar extensiones con webRequest/DNR en `session.defaultSession` rompe `net.fetch` del proceso principal (issues #55106, #54685). Se evita usando particiones con nombre (que es lo que haremos de todos modos por los perfiles).

**Expectativa realista en Electron**: funcionarán bien las extensiones centradas en *content scripts* y popups (modo oscuro, traductores de página, gestores de pestañas, utilidades de UI, muchas de productividad). Riesgo alto en: bloqueadores de anuncios MV3 (uBlock Origin Lite depende de DNR), gestores de contraseñas que necesitan app de escritorio (native messaging), extensiones que inician sesión con Google (`identity`), Tampermonkey (`userScripts`).

### CEF (Chrome style)
- Desde M125 CEF puede crear browsers "Chrome style", que usan el sistema de extensiones **real de Chrome**. En teoría es la mejor compatibilidad posible sin fork.
- **No pude verificar** con fuentes actuales el soporte de instalación desde Chrome Web Store ni cómo se integran las extensiones que usan `chrome.tabs` cuando la barra de pestañas no es la de Chrome. Requiere C++ (o CefSharp en C#, cuyo soporte de extensiones con Chrome style tampoco está confirmado).

### WebView2
- `AddBrowserExtensionAsync` solo acepta carpetas desempaquetadas; **no hay instalación desde la tienda**; las extensiones con icono, badge o popup **no tienen dónde mostrarse** (lo dice la documentación de Microsoft). Hay reportes de "The request is not supported". Insuficiente para el requisito.

### Conclusión sobre extensiones
Ninguna opción viable para una persona ofrece compatibilidad **completa** con la Chrome Web Store. Electron + librerías de Maddock es la opción más madura y verificable; CEF Chrome style es la alternativa a evaluar si Electron no alcanza un umbral aceptable. **No se mostrará en Callisto compatibilidad que no exista**: la página de extensiones indicará qué permisos/APIs no están soportados por cada extensión.

---

## 4. Viabilidad de perfiles

**Electron: alta.** Cada perfil usa su propia sesión persistente: `session.fromPartition('persist:profile-<id>')`.

| Dato | Aislado por perfil | Mecanismo |
|---|---|---|
| Cookies | Sí | Partición de Chromium |
| Local Storage / Session Storage | Sí | Partición |
| IndexedDB / Cache / Service Workers | Sí | Partición |
| Permisos de sitios | Sí | Handlers por sesión |
| Historial, favoritos, configuración, pestañas | Sí | Base SQLite propia por perfil (`Profiles/<id>/callisto.db`) |
| Contraseñas | Sí | Bóveda cifrada propia por perfil con clave propia |
| Extensiones | Sí | Se cargan por sesión, en carpeta por perfil |

Decisión de diseño: **cada ventana pertenece a un perfil** (como Edge). Cambiar de perfil abre/enfoca una ventana de ese perfil; no se mezclan pestañas de perfiles en una ventana. Esto hace que el escenario "Gmail en Trabajo no aparece en Universidad" se cumpla por construcción, y será verificado con pruebas automáticas.

---

## 5. Cookies y sesiones

**Electron: alta.** Las particiones `persist:` guardan cookies, almacenamiento y caché en disco; el usuario sigue autenticado tras reiniciar según la política de cada sitio. Se activará el fuse `EnableCookieEncryption` (cifra cookies en disco con la clave del SO).

Matices a aceptar o resolver:
- **Cookies de sesión** (sin fecha de expiración) se pierden al cerrar, igual que en Chrome con "abrir página nueva". Chrome las conserva solo con "continuar donde lo dejaste"; replicarlo es posible más adelante.
- Algunos proveedores (sobre todo Google) bloquean inicios de sesión desde "navegadores embebidos" detectando el user-agent de Electron. Mitigación estándar: user-agent limpio (sin `Electron/` ni el nombre de la app), idéntico al de Chrome. Se verifica en la prueba de concepto.
- Popups de OAuth (iniciar sesión con Google/Microsoft) requieren conservar `window.opener`; se manejará con `setWindowOpenHandler` + `createWindow`.

---

## 6. Administrador de contraseñas

Electron **no incluye** el administrador de contraseñas de Chrome (vive en la capa `//chrome`, no en el motor). Hay que implementarlo, con estas garantías:

**Almacenamiento**
- Por perfil: una **clave de datos aleatoria de 256 bits**, envuelta (cifrada) con `safeStorage` de Electron, que en Windows usa **DPAPI** (atada a la cuenta de Windows). Se usará la API asíncrona (`encryptStringAsync`/`decryptStringAsync`), porque la síncrona está deprecada.
- Cada contraseña se cifra con **AES-256-GCM** (módulo `crypto` de Node) usando esa clave. Nada en texto plano, nada en archivos de configuración.
- Cada perfil tiene su propia clave → un perfil no puede descifrar las credenciales de otro desde la app.

**Acceso protegido**
- Ver, copiar o exportar una contraseña requiere **reautenticación de Windows (Windows Hello / PIN / contraseña)** vía la API `UserConsentVerifier`. Como Electron no la expone, se usará un **helper mínimo en C# (.NET 10, ya instalado)** o un módulo nativo; se decide en esa versión.

**Autocompletado**
- Un preload en **mundo aislado** detecta formularios de inicio de sesión y envíos; el proceso principal toma el **origen real del frame** (no el que diga la página) para asociar la credencial.
- Autocompletado **con interacción del usuario** (elegir la sugerencia), no relleno silencioso al cargar: evita ataques de formularios invisibles. Sin relleno en iframes de otro origen. Sin guardar nada en modo privado.

**Límite honesto (igual que Chrome/Edge sin App-Bound Encryption)**: DPAPI protege contra otros usuarios de Windows y robo del disco, **no contra malware que se ejecuta con tu misma cuenta**. Se documentará.

---

## 7. Navegación privada

**Electron: alta.**
- Ventanas privadas con una partición **en memoria** (sin `persist:`) y nombre aleatorio por "sesión privada": nada se escribe en el perfil.
- Al cerrar la última ventana privada: `clearStorageData()`, `clearCache()`, `clearAuthCache()` y se descarta la partición; la siguiente sesión privada usa una nueva.
- No se registra historial, no se guardan contraseñas ni datos de formularios, y la interfaz se distingue claramente.
- Limitación: **sin extensiones en privado** (Electron no las permite en sesiones en memoria). Edge y Chrome las desactivan por defecto en privado, así que es aceptable.
- Las descargas hechas en privado quedan en disco (son archivos del usuario), pero no en la lista de descargas persistente.

---

## 8. Interceptar todas las descargas antes de que se guarden

Es el requisito más delicado. Hallazgos:

1. **En Chromium, una descarga empieza cuando llegan las cabeceras de la respuesta**, y el motor puede escribir los primeros bytes en un archivo temporal mientras la aplicación decide (así funcionan los archivos `Unconfirmed *.crdownload` de Chrome cuando se muestra "Guardar como"). Esto afecta a **todas** las opciones embebibles.
2. **WebView2**: Microsoft documenta que `DownloadStarting` "bloquea el diálogo por defecto pero **no bloquea el progreso de la descarga**". Descartado para este requisito.
3. **Electron** ofrece dos puntos de control:
   - `will-download` (sesión): se dispara para **todos** los mecanismos (enlace directo, `<a download>`, JavaScript, `blob:`, `data:`, redirecciones, formularios POST, iframes). Permite **cancelar** (`preventDefault`) o **pausar** y fijar la ruta, de forma síncrona.
   - `session.webRequest.onHeadersReceived`: podría retener la respuesta antes de que exista la descarga, pero **desactiva `chrome.webRequest` y DNR de las extensiones** (PR #55700). No puede ser el mecanismo principal.

**Diseño propuesto ("DownloadGuard")**
- En `will-download`, **sincrónicamente**: pausar la descarga y fijar su ruta a una **carpeta de cuarentena privada** de Callisto (dentro del perfil, nunca en Descargas del usuario). Mostrar el diálogo de autorización: nombre de archivo, origen, tamaño si se conoce, tipo.
- **Cancelar** → `item.cancel()`: Chromium elimina el parcial. No queda nada.
- **Aceptar** → elegir carpeta (o la predeterminada), reanudar, y al completarse mover el archivo a su destino final.
- Alternativa para GET http(s): cancelar de inmediato y, si se aprueba, volver a pedir con `downloadURL` (cero bytes antes de autorizar, pero falla con POST, `blob:` revocados y URLs de un solo uso). Se evaluarán ambas en la prueba de concepto.
- Regla por defecto: **siempre preguntar**, sin excepciones por sitio.

**Garantía que podemos ofrecer**: ningún archivo llega a la carpeta del usuario ni queda en disco si se cancela. **Garantía que no podemos asegurar todavía**: que *cero* bytes toquen el disco antes de la decisión; puede quedar un parcial pequeño, pausado, en la cuarentena privada hasta que el usuario responda. La versión V0.1 medirá exactamente cuántos bytes y dónde, para cada mecanismo. Si se exige "cero bytes absolutos" en todos los casos, solo un parche de Chromium lo garantiza (inviable, §2) o el gate por cabeceras cuando Electron resuelva el conflicto con extensiones.

---

## 9. Riesgos técnicos

| # | Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|---|
| R1 | Compatibilidad de extensiones insuficiente (MV3, DNR, identity, nativeMessaging) | Alta | Crítico | Prueba de concepto con matriz de extensiones reales en V0.1; umbral de aceptación; plan B: CEF Chrome style |
| R2 | Bytes parciales antes de autorizar una descarga | Media | Crítico | Cuarentena privada + pausa; medición en V0.1; documentar |
| R3 | Atraso del motor (Electron va 1–2 milestones detrás de Chrome; si no actualizamos, quedamos expuestos) | Media | Crítico | Actualizar a cada minor/patch de seguridad; mayor nueva en ≤4 semanas; Dependabot/Renovate + CI |
| R4 | Google u otros bloquean login en "navegador embebido" | Media | Alto | User-agent idéntico a Chrome; probar Google/Microsoft/GitHub en V0.1 |
| R5 | Sin Widevine (Netflix, Disney+, Spotify web no reproducen) | Segura | Alto para uso diario | Opción futura: Electron de castLabs (ECS) con Widevine y firma VMP; decidir más adelante |
| R6 | Sin Google Safe Browsing (Electron no lo incluye) | Segura | Alto | Advertencias HTTPS estrictas; evaluar Safe Browsing API en V1.x |
| R7 | Seguridad de la capa Electron (IPC, preload, Node expuesto) | Media | Crítico | `sandbox`, `contextIsolation`, sin `nodeIntegration`, validación de remitente IPC, fuses, CSP |
| R8 | Librerías de extensiones mantenidas por una sola persona | Media | Alto | Son MIT; se pueden forkear y mantener si se abandonan |
| R9 | Memoria con muchas pestañas | Media | Medio | Descarte de pestañas inactivas con restauración de historial (`navigationHistory.restore`) |
| R10 | Firma de código (SmartScreen avisa en instaladores sin firmar) | Segura | Medio | Certificado o Azure Trusted Signing antes de V1 (costo mensual) |

---

## 10. Tecnología recomendada

**Electron (estable más reciente, hoy 45.x) + TypeScript**, con `electron-chrome-extensions` y `electron-chrome-web-store` para extensiones.

Por qué:
- Es Chromium real, **empaquetado y controlado por Callisto** (no depende del Edge instalado), con API maduras para todo lo que es crítico: pestañas (`WebContentsView`), perfiles (particiones), privado (particiones en memoria), descargas (`will-download` con pausa/cancelación síncrona), búsqueda en página (`findInPage`), zoom, cifrado con DPAPI (`safeStorage`).
- Es la única opción con **instalación desde Chrome Web Store** probada en navegadores reales construidos sobre ella.
- Se desarrolla íntegramente desde VS Code con TypeScript, sin toolchain de C++.
- Actualización del motor = actualizar una dependencia, automatizable.

Condición: **la decisión se confirma después de V0.1**. Si la matriz de extensiones o la medición de descargas no alcanzan el umbral acordado, me detengo y presento la alternativa (CEF Chrome style) antes de seguir.

---

## 11. Arquitectura propuesta

Un solo proyecto, un solo proceso principal, módulos por responsabilidad. Sin capas ni abstracciones que no se usen.

```
┌──────────────────────────── Proceso principal (Node, privilegiado) ────────────────────────────┐
│ AppController ── ProfileManager ──┬── Profile (sesión persist:<id> + callisto.db + bóveda)     │
│        │                          └── PrivateSession (partición en memoria, efímera)           │
│        │                                                                                        │
│  WindowController (1 por ventana, ligada a 1 perfil)                                            │
│        ├── TabManager ── Tab (WebContentsView) ── grupos, orden, restauración                   │
│        └── UI view (WebContentsView con la interfaz: pestañas, barra, menús)                    │
│                                                                                                 │
│  Servicios por perfil: HistoryService · BookmarkService · SettingsService · ZoomService         │
│                        DownloadGuard · PasswordVault · ExtensionHost · SessionStore            │
│  Seguridad: PermissionPolicy · IPC con validación de remitente · fuses                          │
└──────────────────┬────────────────────────────────────────────────┬────────────────────────────┘
          IPC tipado y mínimo                                 sin IPC privilegiado
┌──────────────────▼──────────────┐                ┌───────────────▼───────────────────────────┐
│ UI del navegador (React, sandbox)│                │ Páginas web (sandbox, sin Node)           │
│ + páginas internas callisto://   │                │ + preload en mundo aislado (solo login)  │
│   (historial, descargas, ajustes,│                │   y content scripts de extensiones        │
│   favoritos, contraseñas, ext.)  │                └───────────────────────────────────────────┘
└──────────────────────────────────┘
```

Relaciones clave:
- **Perfil = contexto de navegación completo**: sesión de Chromium + base de datos + bóveda + extensiones. Todos los servicios reciben el perfil al crearse; no existe estado global de datos de usuario.
- **Las pestañas no hablan con los servicios**: los eventos del motor (navegación, título, favicon, descargas) los escucha el proceso principal y los traduce a servicios (p. ej. navegación → `HistoryService`, salvo en privado).
- **La UI no tiene privilegios**: pide acciones por IPC (lista cerrada de comandos validados) y recibe estado.
- **Persistencia**: SQLite por perfil (con migraciones versionadas) para historial, favoritos, grupos, sesión de pestañas, zoom por sitio, descargas y credenciales cifradas. Datos en `%APPDATA%\Callisto\Profiles\<id>\`.
- **Páginas internas** servidas por un protocolo propio `callisto://` desde el paquete de la app.

Estructura de carpetas prevista (no creada todavía):

```
src/
  main/        app, ventanas, perfiles, pestañas, descargas, contraseñas, extensiones, almacenamiento, seguridad
  preload/     ui.ts · internal-pages.ts · web-login.ts
  ui/          interfaz del navegador (React)
  pages/       callisto://history, downloads, bookmarks, passwords, extensions, settings
  shared/      tipos y contratos IPC
tests/         unitarias (Vitest) y end-to-end (Playwright para Electron)
docs/          decisiones, seguridad, limitaciones por versión
```

---

## 12. Roadmap: del prototipo a Callisto V1

Cada versión compila, se ejecuta, se prueba, documenta lo hecho y sus limitaciones, y **no avanzo sin tu aprobación explícita**.

| Versión | Objetivo | Contenido | Criterio de cierre |
|---|---|---|---|
| **V0.1 — Pruebas de concepto** | Validar la tecnología antes de construir | Mini-apps aisladas en `spikes/`: (a) matriz de ~12 extensiones reales desde Chrome Web Store (uBlock Origin Lite, Bitwarden, Dark Reader, Google Translate, Grammarly, 1Password, React DevTools, Tampermonkey, etc.); (b) medición de descargas por mecanismo (enlace, `<a download>`, JS, `blob:`, `data:`, redirección, POST, iframe, múltiples); (c) aislamiento de perfiles; (d) login en Google/Microsoft/GitHub; (e) SQLite (`node:sqlite` vs `better-sqlite3`) | Informe con resultados medidos y decisión go/no-go sobre Electron |
| **V0.2 — Esqueleto navegable** | Navegar de verdad | Proyecto base, una ventana, una pestaña, barra de direcciones (URL vs búsqueda), atrás/adelante/recargar/detener, indicador de carga, indicador HTTPS, endurecimiento de seguridad, empaquetado de desarrollo | Navega sitios reales; pruebas e2e básicas |
| **V0.3 — Pestañas** | Sistema de pestañas completo | Crear/cerrar/cambiar, favicon y título, enlaces y `window.open` a pestañas, popups OAuth, duplicar, reabrir cerradas, menú contextual, atajos, Ctrl+F, zoom por pestaña | Pestañas independientes y sin fugas de estado |
| **V0.4 — Persistencia e historial** | Recordar | SQLite por perfil (perfil por defecto), historial completo (buscar, borrar uno/período/todo), restaurar pestañas al reiniciar, zoom por sitio persistente, sugerencias en la barra | Reinicio conserva todo |
| **V0.5 — Descargas autorizadas** | Requisito crítico | DownloadGuard, diálogo de autorización, carpeta configurable, progreso, pausar/reanudar/cancelar, panel y página de descargas, abrir archivo/carpeta, errores | Matriz de mecanismos de V0.1 pasa al 100 % |
| **V0.6 — Favoritos** | Organizar | Agregar (estrella), editar, eliminar, carpetas y subcarpetas, barra y menú de favoritos, reorganizar | Persisten y se organizan |
| **V0.7 — Perfiles y modo privado** | Contextos reales | Crear/editar/eliminar/cambiar perfiles, identificación visual, ventana por perfil, ventanas privadas efímeras | Pruebas automáticas de aislamiento (cookies, storage, historial) |
| **V0.8 — Grupos de pestañas** | Organización avanzada | Crear grupos, nombre y color, agregar/quitar, contraer/expandir, arrastrar y reordenar pestañas y grupos, persistencia | Persisten entre reinicios |
| **V0.9 — Contraseñas** | Bóveda segura | Detección, oferta de guardado, autocompletado con interacción, administrador (buscar, editar, eliminar, ver con Windows Hello), por perfil, documento de seguridad | Revisión de seguridad aprobada |
| **V0.10 — Extensiones** | Ecosistema | Instalar desde Chrome Web Store con confirmación y permisos, activar/desactivar, eliminar, botones y popups en la barra, por perfil, página de administración con compatibilidad real | Matriz de V0.1 documentada en la app |
| **V1.0 — Distribución y estabilización** | Navegador diario | Instalador NSIS por usuario, firma de código, autoactualización, registro como navegador predeterminado, página de configuración completa, descarte de pestañas, regresión completa, documentación | Uso diario estable durante un período de prueba |

Por qué este orden: lo de mayor riesgo se valida primero (V0.1); el almacenamiento se diseña por perfil desde V0.4 para que V0.7 solo lo generalice; contraseñas y extensiones van después de perfiles porque ambas dependen de ellos.

---

## 13. Dependencias que eventualmente habrá que instalar

**Ya disponibles**: Node.js, npm, Git, GitHub CLI, VS Code, .NET 10 SDK.

**Paquetes npm (locales al proyecto, sin tocar el sistema)**:
- `electron`, `typescript`, `electron-vite` (o Vite + Electron Forge), `react`, `react-dom`
- `electron-chrome-extensions`, `electron-chrome-web-store`
- `electron-builder` + `electron-updater` (instalador y actualizaciones), `@electron/fuses`
- Pruebas y calidad: `vitest`, `@playwright/test`, `eslint`, `prettier`
- Posible: `better-sqlite3` (si `node:sqlite` no alcanza)

**Posibles a nivel sistema (cada una se pedirá cuando haga falta)**:
- Visual Studio Build Tools (C++) + Windows SDK: solo si un módulo nativo no trae binarios precompilados.
- Certificado de firma de código o Azure Trusted Signing: antes de V1.0.

---

## 14. Limitaciones a aceptar o resolver

| Limitación | Propuesta |
|---|---|
| Extensiones no 100 % compatibles con Chrome Web Store | **Aceptar**, medir en V0.1 y mostrar compatibilidad real por extensión |
| Sin extensiones en modo privado | **Aceptar** (igual que el comportamiento por defecto de Edge/Chrome) |
| Posible parcial pausado en cuarentena privada antes de autorizar una descarga | **Decidir tras la medición de V0.1** |
| Sin Widevine (streaming con DRM) | Aceptar en V1 o evaluar Electron de castLabs |
| Sin Safe Browsing de Google | Aceptar en V1; evaluar integración en V1.x |
| Motor 1–2 milestones detrás de Chrome | Aceptar con política de actualización estricta |
| Cookies de sesión no persisten entre reinicios | Aceptar en V1 (comportamiento estándar) |
| Contraseñas protegidas por DPAPI (no contra malware de la misma cuenta) | Aceptar y documentar (mismo modelo que Chrome/Edge básico) |
| Sin sincronización entre dispositivos | Fuera de alcance V1 |

---

## Fuentes principales

- Electron — Releases: https://releases.electronjs.org/ · Timelines: https://www.electronjs.org/docs/latest/tutorial/electron-timelines
- Electron — Chrome Extension Support: https://www.electronjs.org/docs/latest/api/extensions
- Electron — DownloadItem: https://www.electronjs.org/docs/latest/api/download-item · Session: https://www.electronjs.org/docs/latest/api/session · WebRequest: https://www.electronjs.org/docs/latest/api/web-request
- Electron — safeStorage: https://www.electronjs.org/docs/latest/api/safe-storage
- Electron — Migración a WebContentsView: https://www.electronjs.org/blog/migrate-to-webcontentsview
- Electron PR #44411 (service worker preload scripts): https://github.com/electron/electron/pull/44411
- Electron issue #52265 (webRequest en service workers MV3): https://github.com/electron/electron/issues/52265
- Electron PR #55700 (session.webRequest desactiva chrome.webRequest/DNR): https://github.com/electron/electron/pull/55700
- Electron issues #55106 y #54685 (extensiones DNR y net.fetch): https://github.com/electron/electron/issues/55106 · https://github.com/electron/electron/issues/54685
- electron-browser-shell (electron-chrome-extensions, electron-chrome-web-store): https://github.com/samuelmaddock/electron-browser-shell
- WebView2 — DownloadStartingEventArgs: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2downloadstartingeventargs
- WebView2 — AddBrowserExtensionAsync: https://learn.microsoft.com/en-us/dotnet/api/microsoft.web.webview2.core.corewebview2profile.addbrowserextensionasync · Spec: https://github.com/MicrosoftEdge/WebView2Feedback/blob/main/specs/Extensions.md
- WebView2 — CoreWebView2Profile: https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/winrt/microsoft_web_webview2_core/corewebview2profile
- CEF — anuncio Chrome/Alloy runtime: https://groups.google.com/g/cef-announce/c/s1WaovAopFo · Extensiones: https://github.com/chromiumembedded/cef/issues/1947
- CefSharp releases: https://github.com/cefsharp/CefSharp/releases
