'use client';

import { useId } from 'react';

export interface Bar {
  label: string;
  sub?: string;
  peak: number | null;
  avg: number | null;
}

interface Props {
  bars: Bar[];
  threshold: number;
  yMax?: number;
  unit?: string;
  title?: string;
}

/** Peak bars, average markers and a threshold line on a shared question axis. */
export function BarChart({ bars, threshold, yMax = 100, unit = '', title = '質問別の計測値' }: Props) {
  const titleId = useId();
  const descriptionId = useId();
  const height = 290;
  const padL = 47, padR = 20, padT = 31, padB = 67;
  const slot = 82;
  const barWidth = 36;
  const width = Math.max(360, padL + padR + bars.length * slot);
  const plotWidth = width - padL - padR;
  const actualSlot = plotWidth / Math.max(1, bars.length);
  const peakMax = Math.max(threshold, ...bars.map((bar) => bar.peak ?? 0));
  const maximum = Math.max(yMax, Math.ceil(peakMax / 20) * 20);
  const plotHeight = height - padT - padB;
  const y = (value: number) => padT + (1 - Math.max(0, value) / maximum) * plotHeight;
  const grid = Array.from({ length: 5 }, (_, index) => maximum * index / 4);
  const accent = 'var(--accent, #5b8cff)';
  const danger = 'var(--danger, #ec5f5f)';
  const line = 'var(--line-2, #363a47)';
  const muted = 'var(--text-mute, #959bab)';
  const text = 'var(--text, #edeff4)';

  return (
    <div>
      <div style={{ width: '100%', overflowX: 'auto' }} tabIndex={bars.length > 4 ? 0 : undefined} aria-label={bars.length > 4 ? `${title}（横スクロール）` : undefined}>
        <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: width, display: 'block' }}
          role="img" aria-label={title} aria-describedby={descriptionId}>
          <title id={titleId}>{title}</title>
          <desc id={descriptionId}>横軸は質問、縦軸は{unit || '値'}。棒は最大値、白い横線は平均値、破線は基準値 {threshold}。基準値を超えた棒は赤色です。欠測は数値を表示しません。各数値と時刻は下の表でも確認できます。</desc>
          <text x={padL} y={14} fill={muted} fontSize="11">{unit || '値'}</text>
          {grid.map((value) => (
            <g key={value}>
              <line x1={padL} y1={y(value)} x2={width - padR} y2={y(value)} stroke={line} />
              <text x={padL - 8} y={y(value) + 4} textAnchor="end" fontSize="11" fill={muted}>{Number(value.toFixed(1))}</text>
            </g>
          ))}
          {bars.map((bar, index) => {
            const center = padL + actualSlot * (index + 0.5);
            const hasData = bar.peak !== null && bar.avg !== null;
            const over = bar.peak !== null && bar.peak > threshold;
            const topY = y(bar.peak ?? 0);
            return (
              <g key={bar.label}>
                <title>{bar.label} {bar.sub}: {hasData ? `最大 ${bar.peak?.toFixed(1)}、平均 ${bar.avg?.toFixed(1)}${unit}。${over ? '基準超過' : '基準超過なし'}` : '欠測'}</title>
                {hasData ? <>
                  <rect x={center - barWidth / 2} y={topY} width={barWidth} height={Math.max(2, y(0) - topY)} rx="4" fill={over ? danger : accent} opacity="0.92" />
                  <line x1={center - barWidth / 2 - 3} x2={center + barWidth / 2 + 3} y1={y(bar.avg!)} y2={y(bar.avg!)} stroke="#fff" strokeWidth="3" />
                  <text x={center} y={topY - 8} textAnchor="middle" fill={over ? danger : text} fontSize="12" fontWeight="700">{Number(bar.peak!.toFixed(1))}</text>
                </> : <text x={center} y={y(0) - 14} textAnchor="middle" fontSize="11" fill={muted}>欠測</text>}
                <text x={center} y={y(0) + 18} textAnchor="middle" fontSize="12" fontWeight="700" fill={text}>{bar.label}</text>
                <text x={center} y={y(0) + 34} textAnchor="middle" fontSize="10" fill={over ? danger : muted}>{over ? '基準超過' : hasData ? '' : 'データなし'}</text>
                {bar.sub && <text x={center} y={y(0) + 50} textAnchor="middle" fontSize="10" fill={muted}>{bar.sub.length > 7 ? `${bar.sub.slice(0, 7)}…` : bar.sub}</text>}
              </g>
            );
          })}
          <line x1={padL} y1={y(threshold)} x2={width - padR} y2={y(threshold)} stroke={danger} strokeWidth="1.5" strokeDasharray="5 4" />
        </svg>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11, lineHeight: 1.8, color: muted }}>
        <span><span style={{ color: accent }}>■</span> 最大値</span>
        <span><span style={{ color: '#fff' }}>━</span> 平均値</span>
        <span style={{ color: danger }}>┄ 基準値 {threshold}{unit ? ` ${unit}` : ''}（超過は赤）</span>
      </div>
    </div>
  );
}
