'use client';

import styles from './Organize.module.css';

export interface OrganizeSeg { role: string; name: string; text: string }
export interface OrganizeRow {
  item: string;
  planned: boolean;   // 事前に用意された項目か
  covered: boolean;   // 候補者が発言したか
  segments: OrganizeSeg[];
}

const ROLE_LABEL: Record<string, string> = { interviewer: '面接官', candidate: '就活生' };

export function Organize({ rows, role, onClose }: { rows: OrganizeRow[]; role: 'interviewer' | 'candidate'; onClose: () => void }) {
  const notYet = rows.filter((r) => r.planned && !r.covered);

  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="面接まとめ">
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>面接まとめ（項目ごとの整理）</p>
            <h2 className={styles.title}>面接まとめ</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>閉じる</button>
        </div>
        <p className={styles.note}>
          {role === 'candidate'
            ? '話した内容を項目ごとに整理しました。重複を避けつつ、「まだ触れていない項目」を確認できます。'
            : '発言を項目ごとに並べて整理しました。前後の食い違いに気づく手がかりとしてお使いください（AIによる矛盾判定はしません）。'}
          発言は文字起こしがONの区間のみ表示されます。
        </p>

        {notYet.length > 0 && (
          <section className={styles.notYet}>
            <span className={styles.notYetLabel}>
              {role === 'candidate' ? 'まだ話していない項目' : 'まだ触れていない項目'}
            </span>
            <div className={styles.chips}>
              {notYet.map((r, i) => <span key={i} className={styles.chip}>{r.item}</span>)}
            </div>
          </section>
        )}

        {rows.map((r, i) => (
          <section key={i} className={styles.row}>
            <div className={styles.rowHead}>
              <span className={styles.itemName}>{r.item}</span>
              <span className={`${styles.badge} ${r.covered ? styles.badgeOk : styles.badgeNo}`}>
                {r.covered ? '触れた' : '未'}
              </span>
            </div>
            {r.segments.length === 0 ? (
              <p className={styles.empty}>この項目に対応する発言の記録はありません。</p>
            ) : (
              <ul className={styles.segList}>
                {r.segments.map((s, j) => (
                  <li key={j} className={s.role === 'candidate' ? styles.segCand : styles.segIntv}>
                    <span className={styles.who}>{ROLE_LABEL[s.role] ?? s.role}</span>
                    <span className={styles.text}>{s.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}
