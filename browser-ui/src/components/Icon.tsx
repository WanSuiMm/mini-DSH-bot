import type { SVGProps } from 'react';

export type IconName =
  | 'spark'
  | 'plus'
  | 'refresh'
  | 'globe'
  | 'lock'
  | 'logout'
  | 'check'
  | 'close'
  | 'send'
  | 'stop'
  | 'clock'
  | 'screen'
  | 'arrow'
  | 'shield'
  | 'alert'
  | 'key';

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName;
  size?: number;
}

export function Icon({ name, size = 18, ...props }: IconProps) {
  const shared = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
    ...props,
  };

  switch (name) {
    case 'spark':
      return <svg {...shared}><path d="m12 3 1.4 5.6L19 10l-5.6 1.4L12 17l-1.4-5.6L5 10l5.6-1.4L12 3Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7L19 16Z" /></svg>;
    case 'plus':
      return <svg {...shared}><path d="M12 5v14M5 12h14" /></svg>;
    case 'refresh':
      return <svg {...shared}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M5.7 9A7 7 0 0 1 18 6.5L20 12M4 12l2 5.5A7 7 0 0 0 18.3 15" /></svg>;
    case 'globe':
      return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
    case 'lock':
      return <svg {...shared}><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>;
    case 'logout':
      return <svg {...shared}><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" /></svg>;
    case 'check':
      return <svg {...shared}><path d="m5 12 4 4L19 6" /></svg>;
    case 'close':
      return <svg {...shared}><path d="m18 6-12 12M6 6l12 12" /></svg>;
    case 'send':
      return <svg {...shared}><path d="m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13" /></svg>;
    case 'stop':
      return <svg {...shared}><rect x="5" y="5" width="14" height="14" rx="2" /></svg>;
    case 'clock':
      return <svg {...shared}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
    case 'screen':
      return <svg {...shared}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4" /></svg>;
    case 'arrow':
      return <svg {...shared}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
    case 'shield':
      return <svg {...shared}><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case 'alert':
      return <svg {...shared}><path d="M10.3 4.2 2.7 17.5A2 2 0 0 0 4.4 20h15.2a2 2 0 0 0 1.7-2.5L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4M12 17h.01" /></svg>;
    case 'key':
      return <svg {...shared}><circle cx="8" cy="15" r="5" /><path d="m11.5 11.5 8-8L22 6l-2 2 2 2-3 3-2-2-2 2" /></svg>;
  }
}
