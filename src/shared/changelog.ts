// Novedades de cada versión de Callisto (se muestran en Configuración > Acerca de Callisto, la más nueva primero).

export interface ChangelogEntry {
  version: string;
  date: string;
  items: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
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
