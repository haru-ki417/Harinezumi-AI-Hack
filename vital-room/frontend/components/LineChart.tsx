'use client';

import styles from './LineChart.module.css';

export interface Series {
  name: string;
  color: string;
  values: number[];
}

interface Props {
  series: Series[];
  yMin?: number;
  yMax?: number;
  height?: number;
  /** 縦のマーカー(トピック切替など)。位置は 0..1 の割合 */
  markers?: { at: number; label?: string }[];
  showLegend?: boolean;
  yLabel?: string;
}

const W = 300;

/** 依存ライブラリなしの軽量な折れ線チャート(SVG)。 */
export function LineChart({
  series,
  yMin = 0,
  yMax = 100,
  height = 120,
  markers = [],
  showLegend = false,
  yLabel,
}: Props) {
  const H = height;
  const span = Math.max(1e-6, yMax - yMin);

  const toPath = (values: number[]): string => {
    const n = values.length;
    if (n === 0) return '';
    if (n === 1) {
      const y = H - ((values[0] - yMin) / span) * H;
      return `M 0 ${y.toFixed(1)} L ${W} ${y.toFixed(1)}`;
    }
    return values
      .map((v, i) => {
        const x = (i / (n - 1)) * W;
        const y = H - (Math.max(yMin, Math.min(yMax, v)) - yMin) / span * H;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      })
      .join(' ');
  };

  return (
    <div className={styles.wrap}>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={yLabel ?? 'time series'}
      >
        {/* 目盛りライン(25/50/75%) */}
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1={0} x2={W} y1={H * g} y2={H * g}
            stroke="#2a2c36" strokeWidth={1} />
        ))}
        {/* トピック切替マーカー */}
        {markers.map((m, i) => (
          <line key={i} x1={m.at * W} x2={m.at * W} y1={0} y2={H}
            stroke="#4a4d57" strokeWidth={1} strokeDasharray="3 3" />
        ))}
        {series.map((s) => (
          <path key={s.name} d={toPath(s.values)} fill="none"
            stroke={s.color} strokeWidth={2}
            strokeLinejoin="round" strokeLinecap="round" />
        ))}
      </svg>
      {showLegend && (
        <div className={styles.legend}>
          {series.map((s) => (
            <span key={s.name} className={styles.legendItem}>
              <span className={styles.swatch} style={{ background: s.color }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
