// Update 9 §D: one websocket message per animation frame. The server queues everything it would have
// sent and flushes once per ~16 ms as a single array; within a flush only the latest animation tick
// (per source), the latest frame and the latest status survive. Events are never dropped.

interface Typed { type: string }

export function collapseBatch<T extends Typed>(msgs: T[]): T[] {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    let key: string | null = null;
    if (m.type === 'anim') key = `anim:${(m as unknown as { source?: string }).source ?? ''}`;
    else if (m.type === 'frame' || m.type === 'status') key = m.type;
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(m);
  }
  out.reverse();
  return out;
}
