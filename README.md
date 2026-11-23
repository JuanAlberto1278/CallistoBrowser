# Callisto

Navegador web de escritorio para Windows, basado en Electron (Chromium).

**Versión actual: V0.8, grupos de pestañas.** Grupos con nombre y color que se contraen, se arrastran y se guardan, sobre V0.7 (perfiles y ventanas privadas), V0.6 (favoritos), V0.5 (descargas autorizadas), V0.4 (historial, sesión, permisos), V0.3 (pestañas) y V0.2 (navegación y seguridad).

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
- [05 — V0.5: descargas autorizadas y nueva pestaña](docs/05-v0.5-descargas.md)
- [06 — V0.6: favoritos](docs/06-v0.6-favoritos.md)
- [07 — V0.7: perfiles y ventanas privadas](docs/07-v0.7-perfiles-y-privado.md)
- [08 — V0.8: grupos de pestañas](docs/08-v0.8-grupos-de-pestanas.md)

Las pruebas de concepto de V0.1 están en [`spikes/`](spikes/README.md), un proyecto separado.
