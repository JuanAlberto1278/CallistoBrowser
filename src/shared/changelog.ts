// Novedades de cada versión de Callisto (se muestran en Configuración > Acerca de Callisto, la más nueva primero).

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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
