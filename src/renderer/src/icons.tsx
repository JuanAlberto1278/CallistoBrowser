// Iconos de línea simples (16px), dibujados con currentColor.
const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const BackIcon = () => (
  <svg {...base}><path d="M13 8H3.5M7.5 3.5 3 8l4.5 4.5" /></svg>
);
export const ForwardIcon = () => (
  <svg {...base}><path d="M3 8h9.5M8.5 3.5 13 8l-4.5 4.5" /></svg>
);
export const ReloadIcon = () => (
  <svg {...base}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></svg>
);
export const StopIcon = () => (
  <svg {...base}><path d="M4 4l8 8M12 4l-8 8" /></svg>
);
export const LockIcon = () => (
  <svg {...base} width={14} height={14}><rect x="3.5" y="7" width="9" height="6.5" rx="1.2" /><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" /></svg>
);
export const WarningIcon = () => (
  <svg {...base} width={14} height={14}><path d="M8 2.5 14 13H2L8 2.5Z" /><path d="M8 6.5v3M8 11.3v.2" /></svg>
);
export const FileIcon = () => (
  <svg {...base} width={14} height={14}><path d="M4 2h5l3 3v9H4z" /><path d="M9 2v3h3" /></svg>
);
export const SearchIcon = () => (
  <svg {...base} width={14} height={14}><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5" /></svg>
);
export const CloseIcon = () => (
  <svg {...base} width={12} height={12}><path d="M3 3l6 6M9 3l-6 6" /></svg>
);
