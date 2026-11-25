# Callisto

Navegador web de escritorio para Windows, basado en Electron (Chromium).

**Versión actual: 1.4.3** (extensiones: panel lateral, programas instalados con permiso, reglas según el contenido de la página). **1.4.2:** (extensiones: historial, sesiones, búsqueda, borrar datos, identidad, MHTML, proxy, descargas, sitios más visitados, atajos, palabra clave en la barra y aviso de instalación). **1.4.1:** sin la franja de color del perfil; botones con el texto en una línea. **1.4.0:** (Administrador de tareas con Shift+Esc, aviso de página que no responde, pestañas de fondo que usan mucha CPU, dormir antes con poca memoria, memoria liberada hoy). **1.3.0:** pestañas fijadas, parlante para silenciar, preguntar antes de cerrar varias pestañas, cerradas recientemente, pestañas abiertas y favoritos en la barra, Ctrl+Shift+A. **1.2.0:** pestañas en la barra de título, como en Edge y Chrome. **1.1.0:** aviso de actualización en la barra, novedades, sitios que nunca se duermen y memoria en uso. **V1.0:** Instalador por usuario, navegador predeterminado, actualizaciones desde GitHub Releases, pestañas dormidas y liberación de memoria (216 MB con 5 páginas, 4 dormidas), temas y configuración completa, sobre V0.10 (extensiones), V0.9 (contraseñas), V0.8 (grupos de pestañas), V0.7 (perfiles y ventanas privadas), V0.6 (favoritos), V0.5 (descargas autorizadas), V0.4 (historial, sesión, permisos), V0.3 (pestañas) y V0.2 (navegación y seguridad).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Modo desarrollo (perfil `%APPDATA%\Callisto-Dev`) |
| `npm run check` | Tipos + pruebas unitarias + end-to-end |
| `npm run package` | Instalador en `dist\Callisto-Setup-<versión>.exe` (sin firma: SmartScreen avisa la primera vez) |
| `npm run package:dir` | Ejecutable en `dist\win-unpacked\Callisto.exe` |

## Documentación

- [00 — Investigación técnica y plan](docs/00-investigacion-y-plan.md)
- [01 — Resultados de las pruebas de concepto (V0.1)](docs/01-v0.1-resultados.md)
- [02 — V0.2: esqueleto navegable](docs/02-v0.2-esqueleto-navegable.md)
- [03 — V0.3: pestañas](docs/03-v0.3-pestanas.md)
- [04 — V0.4: persistencia e historial](docs/04-v0.4-persistencia.md)
- [05 — V0.5: descargas autorizadas y nueva pestaña](docs/05-v0.5-descargas.md)
- [06 — V0.6: favoritos](docs/06-v0.6-favoritos.md)
- [07 — V0.7: perfiles y ventanas privadas](docs/07-v0.7-perfiles-y-privado.md)
- [08 — V0.8: grupos de pestañas](docs/08-v0.8-grupos-de-pestanas.md)
- [09 — V0.9: contraseñas (incluye el documento de seguridad)](docs/09-v0.9-contrasenas.md)
- [10 — V0.10: extensiones](docs/10-v0.10-extensiones.md)
- [11 — V1.0: distribución, liviandad y temas](docs/11-v1.0-distribucion.md)
- [12 — 1.1.0 y 1.2.0](docs/12-v1.1.md)
- [13 — 1.3.0: pestañas y búsqueda (bloque 1 de la 2.0)](docs/13-v1.3.md)
- [14 — 1.4.0: recursos a la vista (bloque 2 de la 2.0)](docs/14-v1.4.md)
- [15 — 1.4.2: extensiones que funcionan](docs/15-v1.4.2.md)
- [16 — 1.4.3: panel lateral, programas instalados y reglas según el contenido](docs/16-v1.4.3.md)

Las pruebas de concepto de V0.1 están en [`spikes/`](spikes/README.md), un proyecto separado.
