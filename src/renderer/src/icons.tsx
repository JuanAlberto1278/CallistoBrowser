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
export const PlusIcon = () => (
  <svg {...base}><path d="M8 3v10M3 8h10" /></svg>
);
export const GlobeIcon = () => (
  <svg {...base}><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.7 2.4 3.5 2.4 5.5S9.6 11.8 8 13.5C6.4 11.8 5.6 10 5.6 8S6.4 4.2 8 2.5Z" /></svg>
);
export const ChevronUpIcon = () => (
  <svg {...base} width={14} height={14}><path d="m4 10 4-4 4 4" /></svg>
);
export const ChevronDownIcon = () => (
  <svg {...base} width={14} height={14}><path d="m4 6 4 4 4-4" /></svg>
);
export const ZoomIcon = () => (
  <svg {...base} width={14} height={14}><circle cx="7" cy="7" r="4" /><path d="m10 10 3.5 3.5M5.3 7h3.4M7 5.3v3.4" /></svg>
);
export const MoreIcon = () => (
  <svg {...base}><circle cx="3.5" cy="8" r="0.9" fill="currentColor" /><circle cx="8" cy="8" r="0.9" fill="currentColor" /><circle cx="12.5" cy="8" r="0.9" fill="currentColor" /></svg>
);
export const HistoryIcon = () => (
  <svg {...base}><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7M2.5 2.5v2.6h2.6" /><path d="M8 5v3.2l2.2 1.4" /></svg>
);
export const SettingsIcon = () => (
  <svg {...base}><circle cx="8" cy="8" r="2" /><path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" /></svg>
);
/** Ícono de las páginas internas: una luna (Calisto es una luna de Júpiter). */
export const CallistoIcon = () => (
  <svg {...base} width={14} height={14}><circle cx="8" cy="8" r="5.5" /><circle cx="6.3" cy="6.5" r="1" /><circle cx="9.6" cy="9.8" r="1.4" /></svg>
);
export const DownloadIcon = () => (
  <svg {...base}><path d="M8 2.5v8M4.5 7 8 10.5 11.5 7M3 13.5h10" /></svg>
);
export const FolderIcon = () => (
  <svg {...base} width={14} height={14}><path d="M2 4.5h4l1.3 1.5H14v7H2z" /></svg>
);
export const PauseIcon = () => (
  <svg {...base} width={14} height={14}><path d="M5.5 3.5v9M10.5 3.5v9" /></svg>
);
export const PlayIcon = () => (
  <svg {...base} width={14} height={14}><path d="M5 3.5v9l7-4.5z" /></svg>
);
export const RetryIcon = () => (
  <svg {...base} width={14} height={14}><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" /></svg>
);
export const StarIcon = ({ filled }: { filled?: boolean }) => (
  <svg {...base} fill={filled ? 'currentColor' : 'none'}><path d="M8 2.2 9.8 6l4.1.5-3 2.8.8 4.1L8 11.4l-3.7 2 .8-4.1-3-2.8L6.2 6z" /></svg>
);
export const EditIcon = () => (
  <svg {...base} width={14} height={14}><path d="M10.5 2.5 13.5 5.5 6 13H3v-3z" /></svg>
);
/** Antifaz (ventanas privadas). */
export const MaskIcon = () => (
  <svg {...base}><path d="M1.8 6.2c1.6-1 3.8-1.4 6.2-1.4s4.6.4 6.2 1.4c0 3-1.3 4.8-3.3 4.8-1.3 0-2-.8-2.9-.8s-1.6.8-2.9.8c-2 0-3.3-1.8-3.3-4.8Z" /><circle cx="5.4" cy="7.7" r="0.9" fill="currentColor" /><circle cx="10.6" cy="7.7" r="0.9" fill="currentColor" /></svg>
);
export const KeyIcon = () => (
  <svg {...base}><circle cx="5.5" cy="10.5" r="3" /><path d="M7.6 8.4 13.5 2.5M11.5 4.5l1.8 1.8M10 6l1.5 1.5" /></svg>
);
export const EyeIcon = () => (
  <svg {...base}><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></svg>
);
export const EyeOffIcon = () => (
  <svg {...base}><path d="M2.5 2.5l11 11M6.6 4.4A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a11 11 0 0 1-1.8 2.3M10.6 11.8A6 6 0 0 1 8 12.5C4 12.5 1.5 8 1.5 8a11 11 0 0 1 2.4-2.9M6.6 6.6a2 2 0 0 0 2.8 2.8" /></svg>
);
export const CopyIcon = () => (
  <svg {...base}><rect x="5.5" y="5.5" width="8" height="8" rx="1.2" /><path d="M10.5 3.5V3a1 1 0 0 0-1-1H3a1 1 0 0 0-1 1v6.5a1 1 0 0 0 1 1h.5" /></svg>
);
export const TrashIcon = () => (
  <svg {...base}><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5" /></svg>
);
export const SpeakerIcon = () => (
  <svg {...base} width={14} height={14}><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" /><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8" /></svg>
);
export const SpeakerMutedIcon = () => (
  <svg {...base} width={14} height={14}><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" /><path d="M11 6l3.5 4M14.5 6 11 10" /></svg>
);
