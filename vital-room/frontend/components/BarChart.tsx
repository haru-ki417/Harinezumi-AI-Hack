'use client';

export interface Bar {
  label: string;   // Q1, Q2 ...
  sub?: string;    // 話題名
  peak: number;    // ピーク値
  avg: number;     // 平均値
}

interface Props {
  bars: Bar[];
  threshold: number;      // 基準線(これ以上のピークは赤)
  yMax?: number;          // 縦軸最大(既定100)
  unit?: string;          // 値の単位ラベル
}

/**
 * 質問(Q1,Q2…)を横軸、値を縦軸にした棒グラフ。
 * 棒=ピーク(基準超は赤)、白い横線=平均、破線=基準値。依存なしのSVG。
 */
export function BarChart({ bars, threshold, yMax = 100, unit = '' }: Props) {
  const H = 240;
  const padL = 36, padR = 14, padT = 20, padB = 46;
  const slot = 62;
  const barW = 34;
  const W = Math.max(320, padL + padR + bars.length * slot);
  const plotH = H - padT - padB;
  const y = (v: number) => padT + (1 - Math.max(0, Math.min(yMax, v)) / yMax) * plotH;
  const grid = [0, 25, 50, 75, 100].filter((g) => g <= yMax);

  const accent = 'var(--accent, #5b8cff)';
  const danger = 'var(--danger, #ec5f5f)';
  const line = 'var(--line-2, #363a47)';
  const textMute = 'var(--text-mute, #838895)';
  const text = 'var(--text, #edeff4)';

  return (
    <div style={{ width: '100%', overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%"
        style={{ minWidth: bars.length > 5 ? W : undefined, display: 'block' }}
        role="img" aria-label="質問別ストレスの棒グラフ">
        {/* Yグリッド */}
        {grid.map((g) => (
          <g key={g}>
            <line x1={padL} y1={y(g)} x2={W - padR} y2={y(g)} stroke={line} strokeWidth="1" />
            <text x={padL - 6} y={y(g) + 3} textAnchor="end" fontSize="10" fill={textMute}>{g}</text>
          </g>
        ))}

        {/* 基準線 */}
        <line x1={padL} y1={y(threshold)} x2={W - padR} y2={y(threshold)}
          stroke={danger} strokeWidth="1.5" strokeDasharray="5 4" opacity="0.8" />
        <text x={W - padR} y={y(threshold) - 5} textAnchor="end" fontSize="10" fill={danger}>
          基準 {Math.round(threshold)}
        </text>

        {/* 棒 */}
        {bars.map((b, i) => {
          const cx = padL + i * slot + (slot - barW) / 2;
          const over = b.peak >= threshold;
          const fill = over ? danger : accent;
          const topY = y(b.peak);
          const baseY = y(0);
          return (
            <g key={b.label}>
              {/* ピーク棒 */}
              <rect x={cx} y={topY} width={barW} height={Math.max(0, baseY - topY)}
                rx="5" fill={fill} opacity={over ? 0.95 : 0.85} />
              {/* 平均マーカー(白い横線) */}
              <line x1={cx - 3} y1={y(b.avg)} x2={cx + barW + 3} y2={y(b.avg)}
                stroke="#fff" strokeWidth="2" opacity="0.9" />
              {/* ピーク値ラベル */}
              <text x={cx + barW / 2} y={topY - 6} textAnchor="middle" fontSize="11"
                fontWeight="700" fill={over ? danger : text}>
                {Math.round(b.peak)}
              </text>
              {/* Q番号 */}
              <text x={cx + barW / 2} y={H - padB + 16} textAnchor="middle" fontSize="11"
                fontWeight="700" fill={text}>{b.label}</text>
              {/* 話題名 */}
              {b.sub && (
                <text x={cx + barW / 2} y={H - padB + 30} textAnchor="middle" fontSize="9.5"
                  fill={textMute}>
                  {b.sub.length > 6 ? b.sub.slice(0, 6) + '…' : b.sub}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* 凡例 */}
      <div style={{
        display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 6,
        fontSize: 11, color: textMute,
      }}>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: accent, verticalAlign: -1, marginRight: 5 }} />ピーク{unit}</span>
        <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 2, background: danger, verticalAlign: -1, marginRight: 5 }} />基準超え</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 2, background: '#fff', verticalAlign: 3, marginRight: 5 }} />平均</span>
      </div>
    </div>
  );
}
