// Avisos de las páginas web al proceso principal que no son de ninguna función en particular.
// Módulo aparte: lo importan solo el preload de las páginas y el proceso principal (ver shared/autofill-ipc.ts).

/** El usuario editó un campo de la página (escribió, pegó, dictó): puede haber texto sin guardar. */
export const PAGE_EDITED = 'callisto-page:edited';
