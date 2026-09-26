import type { CSSProperties } from 'react';

const paths = {
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  person: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 8 0 0 1 16 0v2',
  briefcase: 'M8 7V4h8v3M3 7h18v13H3ZM3 12a20 20 0 0 0 18 0M12 11v4',
  link: 'm9 15 6-6M8 17l-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2-1 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0',
  conversation: 'M3 4h18v12H9l-6 4ZM7 8h10M7 12h6',
  chart: 'M4 3v18h17M8 16v-4m5 4V7m5 9V4',
} as const;

export function UiIcon({ name, size = 20, style }: { name: keyof typeof paths; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" style={style}><path d={paths[name]} /></svg>;
}
