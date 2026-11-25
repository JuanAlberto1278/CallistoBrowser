// Novedades de cada versión de Callisto (se muestran en Configuración > Acerca de Callisto, la más nueva primero).

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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
