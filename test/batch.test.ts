import { describe, expect, it } from 'vitest';
import { collapseBatch } from '../shared/batch.js';

describe('websocket batching (Update 9 §D)', () => {
  it('keeps only the latest anim per source, the latest frame and status, and every event, in order', () => {
    const msgs = [
      { type: 'anim', source: 'coinbase', t: 1 },
      { type: 'frame', t: 2 },
      { type: 'event', kind: 'opened', t: 3 },
      { type: 'anim', source: 'coinbase', t: 4 },
      { type: 'status', t: 5 },
      { type: 'anim', source: 'truth', t: 6 },
      { type: 'event', kind: 'flag', t: 7 },
      { type: 'frame', t: 8 },
      { type: 'status', t: 9 },
      { type: 'anim', source: 'coinbase', t: 10 },
    ];
    const out = collapseBatch(msgs);
    expect(out.map((m) => m.t)).toEqual([3, 6, 7, 8, 9, 10]);
  });
  it('passes a single message through', () => {
    expect(collapseBatch([{ type: 'hello' }])).toEqual([{ type: 'hello' }]);
    expect(collapseBatch([])).toEqual([]);
  });
});
