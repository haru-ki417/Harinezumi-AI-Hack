'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EMPLOYER_TOKEN, hiringApi } from '@/lib/hiring';

type SharingStatus = {
  public_origin: string | null; reachable: boolean; temporary: boolean;
  reason: 'not_configured' | 'invalid' | 'unreachable' | null;
};

// A directly hosted HTTPS deployment can use its current origin without a
// tunnel. Never turn a local/LAN address into an externally shareable link.
function publicOrigin(value: string, verifiedByServer = false) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return '';
    if (verifiedByServer) return url.origin;
    if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || !hostname.includes('.') || hostname.includes(':')) return '';
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      const [first, second] = hostname.split('.').map(Number);
      if ([0, 10, 127].includes(first) || first >= 224 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31) || (first === 169 && second === 254) || (first === 100 && second >= 64 && second <= 127)) return '';
    }
    return url.origin;
  } catch { return ''; }
}

export function useInvitationSharing(enabled: boolean) {
  const [origin, setOrigin] = useState('');
  const [temporary, setTemporary] = useState(false);
  const [checking, setChecking] = useState(false);
  const [reason, setReason] = useState<SharingStatus['reason']>('not_configured');
  const mounted = useRef(false);
  const pending = useRef(false);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled || pending.current) return;
    const token = sessionStorage.getItem(EMPLOYER_TOKEN);
    if (!token) { setOrigin(''); return; }
    const current = generation.current;
    pending.current = true; setChecking(true);
    const direct = publicOrigin(window.location.origin);
    try {
      const status = await hiringApi<SharingStatus>('/sharing', token);
      if (!mounted.current || current !== generation.current) return;
      const shared = status.reachable && status.public_origin ? publicOrigin(status.public_origin, true) : '';
      setOrigin(shared || direct);
      setTemporary(shared ? status.temporary : Boolean(direct && new URL(direct).hostname.endsWith('.trycloudflare.com')));
      setReason(shared || direct ? null : status.reason || 'unreachable');
    } catch {
      if (!mounted.current || current !== generation.current) return;
      setOrigin(direct);
      setTemporary(Boolean(direct && new URL(direct).hostname.endsWith('.trycloudflare.com')));
      setReason(direct ? null : 'unreachable');
    } finally {
      if (current === generation.current) { pending.current = false; if (mounted.current) setChecking(false); }
    }
  }, [enabled]);
  useEffect(() => {
    mounted.current = true; generation.current++; pending.current = false;
    if (!enabled) { setOrigin(''); setChecking(false); return () => { mounted.current = false; generation.current++; }; }
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 15000);
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { mounted.current = false; generation.current++; pending.current = false; window.clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [enabled, refresh]);
  return { origin, temporary, checking, reason, refresh };
}
