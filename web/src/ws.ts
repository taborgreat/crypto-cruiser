import type { ServerMsg } from '../../shared/types.js';

/** The server sends one message per animation frame: a single ServerMsg or an array of them (Update 9 §D). */
export function connectWs(onMsg: (m: ServerMsg) => void, onState: (connected: boolean) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 500;

  const open = () => {
    if (closed) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => { backoff = 500; onState(true); };
    ws.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data as string) as ServerMsg | ServerMsg[];
        if (Array.isArray(parsed)) for (const m of parsed) onMsg(m);
        else onMsg(parsed);
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      onState(false);
      if (closed) return;
      setTimeout(open, backoff);
      backoff = Math.min(8000, backoff * 2);
    };
    ws.onerror = () => { try { ws?.close(); } catch { /* ignore */ } };
  };
  open();
  return () => { closed = true; ws?.close(); };
}
