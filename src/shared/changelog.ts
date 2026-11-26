// Novedades de cada versión de Callisto (se muestran en Configuración > Acerca de Callisto, la más nueva primero).

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '1.6.0',
    date: '2026-11-25',
    items: [
      'Importá tus favoritos e historial desde Chrome o Edge: Configuración → Importar y exportar. Los favoritos quedan en su propia carpeta («Importados de Chrome») dentro de Otros favoritos.',
      'Importá tus contraseñas con el archivo CSV que exportan Chrome, Edge o Firefox. Si ya tenías otra contraseña para el mismo sitio y usuario, Callisto te pregunta cuál conservar.',
      'Exportá tus contraseñas a un archivo CSV (Windows verifica tu identidad antes).',
      'La primera vez que abrís un perfil nuevo, si tenés Chrome o Edge, Callisto ofrece importar.',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-25',
    items: [
      'Panel del sitio: tocá el candado junto a la dirección para ver si la conexión es segura y cambiar los permisos del sitio, su sonido, ventanas emergentes, JavaScript e imágenes, el zoom, «No dormir nunca», ver sus contraseñas guardadas o borrar sus datos.',
      'Bloqueador de ventanas emergentes: las que un sitio abre sin que hagas clic se bloquean, con un aviso para abrirla o permitir siempre ese sitio.',
      'Silenciar un sitio: sus pestañas quedan sin sonido, también las que abras después.',
      'Al abrir Callisto podés elegir páginas específicas (o usar las que tenés abiertas).',
      'Al cerrar Callisto puede borrar el historial, las cookies y datos de sitios o la caché: cada uno se elige por separado (apagados por defecto).',
      'Nueva pestaña con tus accesos directos: agregá, renombrá, editá o quitá los tuyos. Los más visitados se pueden sumar con un clic o mostrar también.',
      'Las extensiones que cambian ajustes de sitios (chrome.contentSettings) ahora funcionan.',
    ],
  },
  {
    version: '1.4.4',
    date: '2026-11-25',
    items: [
      'Tampermonkey y Violentmonkey funcionan: los scripts de usuario que instalás corren en las páginas.',
      'Por seguridad, cada extensión que usa scripts de usuario necesita que actives «Permitir scripts de usuario» en su tarjeta de Configuración → Extensiones (como en Chrome).',
      'Las extensiones con documentos ocultos (offscreen) reciben todas las funciones de Callisto.',
    ],
  },
  {
    version: '1.4.3',
    date: '2026-11-25',
    items: [
      'Panel lateral de las extensiones (Bitwarden, Grammarly…): a la derecha de la página, con su ancho ajustable. Se abre desde el botón de la extensión (clic derecho → «Abrir el panel lateral») o cuando la extensión lo pide.',
      'Las extensiones pueden comunicarse con programas instalados (por ejemplo KeePassXC o la app de escritorio de Bitwarden). La primera vez Callisto te pregunta, y muestra qué programa se va a abrir.',
      'Las extensiones que muestran su botón solo en ciertas páginas ahora funcionan: el botón aparece desactivado donde no corresponde.',
    ],
  },
  {
    version: '1.4.2',
    date: '2026-11-25',
    items: [
      'Más extensiones funcionan: historial, pestañas cerradas, búsqueda, borrar datos, iniciar sesión con otros servicios, guardar páginas, proxy y descargas.',
      'Las extensiones reciben el aviso de instalación (las que abren su página de bienvenida o se configuran al instalarse).',
      'Los atajos de teclado de las extensiones funcionan, y su palabra clave en la barra de direcciones (por ejemplo, escribir la palabra y un espacio).',
      'El menú del botón de una extensión muestra sus propias opciones.',
      'Una descarga pedida por una extensión pasa por la misma autorización que cualquier otra, y dice qué extensión la pidió.',
      'Se quitó la tabla de «Compatibilidad probada»: si una extensión usa algo que Callisto todavía no tiene, lo dice en su tarjeta.',
    ],
  },
  {
    version: '1.4.1',
    date: '2026-11-25',
    items: [
      'Ya no aparece la franja de color del perfil arriba de las pestañas (se veía cortada junto a los botones de la ventana). El perfil se sigue viendo en su botón y en el título de la ventana.',
      'El botón «Administrador de tareas» de Configuración muestra su texto en una sola línea.',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-11-24',
    items: [
      'Administrador de tareas (Shift+Esc o menú ⋯): memoria y CPU de cada proceso de Callisto, con sus pestañas y extensiones, y «Finalizar proceso».',
      'Si una página no responde, Callisto lo avisa: podés esperar o detenerla.',
      'Una pestaña en segundo plano que usa mucha CPU muestra un ícono; un clic la duerme.',
      'Si a Windows le falta memoria, las pestañas que no usás se duermen antes (se puede desactivar en Configuración → Rendimiento).',
      'Configuración → Rendimiento muestra cuánta memoria liberaron hoy las pestañas dormidas.',
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-24',
    items: [
      'Pestañas fijadas: clic derecho → Fijar. Van a la izquierda, solo con su ícono, se recuerdan al reiniciar y no se duermen solas.',
      'Las pestañas que suenan muestran un parlante; un clic las silencia (también desde el menú de la pestaña).',
      'Al cerrar una ventana con 2 pestañas o más, Callisto pregunta antes (se puede desactivar en Configuración).',
      'Menú ⋯ → Cerradas recientemente: las últimas 10 pestañas y ventanas cerradas, para reabrir la que quieras.',
      'La barra de direcciones también sugiere pestañas abiertas («Cambiar a esta pestaña») y favoritos; si lo que escribís ya está abierto, Enter te lleva a esa pestaña.',
      'Ctrl+Shift+A busca entre todas las pestañas abiertas.',
    ],
  },
  {
    version: '1.2.0',
    date: '2026-11-24',
    items: [
      'Las pestañas van en la barra de título, en la misma fila que los botones de minimizar, maximizar y cerrar (como en Edge y Chrome).',
      'Los botones de la ventana toman los colores del tema, y al pasar por maximizar aparecen los diseños de ajuste de Windows 11.',
      'El espacio libre junto a las pestañas arrastra la ventana; el doble clic la maximiza y el clic derecho abre el menú de Windows.',
    ],
  },
  {
    version: '1.1.0',
    date: '2026-11-24',
    items: [
      'Cuando hay una versión nueva lista para instalarse, el botón ⋯ muestra un punto y el menú ofrece «Reiniciar para actualizar».',
      'Después de actualizar, Callisto avisa a qué versión se actualizó; las novedades están acá.',
      'Rendimiento: sitios que nunca se duermen (por ejemplo, el de tu música o tu correo).',
      'Rendimiento: cuánta memoria usa Callisto en este momento y cuántas pestañas están dormidas.',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-11-23',
    items: [
      'Primera versión: pestañas y grupos, historial, favoritos, descargas autorizadas, perfiles y ventanas privadas, contraseñas con Windows Hello, extensiones de la Chrome Web Store.',
      'Pestañas dormidas y liberación de memoria, temas, instalador y actualizaciones.',
    ],
  },
];
