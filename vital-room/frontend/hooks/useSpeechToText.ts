import { useEffect, useRef, useState } from 'react';

export type SttStatus = 'unsupported' | 'idle' | 'listening' | 'error';

/**
 * Web Speech API で「自分のマイク」の発話を認識し、確定文を onFinal に渡す。
 * 音声そのものは外に出さず、確定テキストだけを扱う。
 * enabled が true の間だけ動作。Chrome/Edge のみ対応(非対応は 'unsupported')。
 */
export function useSpeechToText(
  enabled: boolean,
  lang: string,
  onFinal: (text: string) => void,
): { status: SttStatus } {
  const [status, setStatus] = useState<SttStatus>('idle');
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { setStatus('unsupported'); return; }
    if (!enabled) { setStatus('idle'); return; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = false; // 確定文のみ(記録向け・送信量削減)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (e: any) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) {
          const t = (r[0]?.transcript ?? '').trim();
          if (t) onFinalRef.current(t);
        }
      }
    };
    rec.onerror = () => { /* onend で再開判定するので握りつぶす */ };
    rec.onend = () => {
      if (enabledRef.current) {
        try { rec.start(); } catch { /* already running */ }
      } else {
        setStatus('idle');
      }
    };

    try { rec.start(); setStatus('listening'); } catch { setStatus('error'); }

    return () => {
      enabledRef.current = false;
      try { rec.onend = null; rec.stop(); } catch { /* noop */ }
      setStatus('idle');
    };
  }, [enabled, lang]);

  return { status };
}
