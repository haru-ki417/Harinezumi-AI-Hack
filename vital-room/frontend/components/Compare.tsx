'use client';

import styles from './Compare.module.css';

export interface CompareRow {
  question: string;
  esAnswer: string;
  segments: string[]; // 面接での候補者の発言(その質問区間)
}

export function Compare({ rows, onClose }: { rows: CompareRow[]; onClose: () => void }) {
  return (
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="ES照合">
        <div className={styles.head}>
          <div>
            <p className={styles.eyebrow}>ES × 面接発言の照合</p>
            <h2 className={styles.title}>事前回答と発言の照合</h2>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>閉じる</button>
        </div>
        <p className={styles.note}>
          事前質問への回答（ES）と、面接中にその質問で話した内容を並べて表示します。
          <b>整合しているか・深掘りすべきかの判断は面接官が行ってください</b>（AIによる矛盾判定は行いません）。
          発言は文字起こしがONの区間のみ表示されます。
        </p>

        {rows.length === 0 ? (
          <p className={styles.empty}>事前質問がありません。</p>
        ) : rows.map((r, i) => (
          <section key={i} className={styles.row}>
            <div className={styles.qHead}><span className={styles.qTag}>Q{i + 1}</span>{r.question}</div>
            <div className={styles.cols}>
              <div className={styles.col}>
                <span className={styles.colLabel}>事前回答（ES）</span>
                <p className={styles.esText}>{r.esAnswer.trim() || '（未回答）'}</p>
              </div>
              <div className={styles.col}>
                <span className={styles.colLabel}>面接での発言</span>
                {r.segments.length === 0 ? (
                  <p className={styles.noSeg}>この質問の区間に、記録された発言はありません。<br />（話題チップでこの質問を選び、文字起こしをONにすると記録されます）</p>
                ) : (
                  <ul className={styles.segList}>
                    {r.segments.map((s, j) => <li key={j}>{s}</li>)}
                  </ul>
                )}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
