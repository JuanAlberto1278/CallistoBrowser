# Callisto

Navegador web de escritorio para Windows, basado en Electron (Chromium).

**Versión actual: V0.4, persistencia e historial.** Historial con búsqueda y borrado, sugerencias en la barra, restauración de ventanas y pestañas al reiniciar, permisos por sitio y configuración, sobre la base de V0.3 (pestañas, menús, buscar, zoom) y V0.2 (navegación y seguridad).

## Comandos

| Comando | Qué hace |
|---|---|
| `npm run dev` | Modo desarrollo (perfil `%APPDATA%\Callisto-Dev`) |
| `npm run check` | Tipos + pruebas unitarias + end-to-end |
| `npm run package:dir` | Ejecutable en `dist\win-unpacked\Callisto.exe` |

## Documentación

- [00 — Investigación técnica y plan](docs/00-investigacion-y-plan.md)
- [01 — Resultados de las pruebas de concepto (V0.1)](docs/01-v0.1-resultados.md)
- [02 — V0.2: esqueleto navegable](docs/02-v0.2-esqueleto-navegable.md)
- [03 — V0.3: pestañas](docs/03-v0.3-pestanas.md)
- [04 — V0.4: persistencia e historial](docs/04-v0.4-persistencia.md)

Las pruebas de concepto de V0.1 están en [`spikes/`](spikes/README.md), un proyecto separado.
