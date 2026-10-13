// Keyboard. Driving: W gas (Shift = hard), S brake, Space full brake, C back off, X withdraw (danger),
// T cruise (Shift+T off). Ghost mode: Enter = Go, [ / ] scrub the limit entry. Rewind: Space pause,
// ← → scrub, M flag. Always: V top-down / driver seat (Update 8), Shift+V data view, N invert, 2/3 renderer,
// K chase / driver camera, Q (hold) look back, I inspect, L label-all, B bridge chart, R rewind, H help, Esc.
import type { PedalAction } from '../../shared/types.js';

export interface ControlHandlers {
  pedal(action: PedalAction): void;
  /** Sends the armed pedal; false when nothing is armed. */
  confirmPedal(): boolean;
  /** Update 17: a short on-screen note ("push again to confirm"). */
  notice(text: string): void;
  go(): void;
  nudgeLimit(dir: 1 | -1): void;
  toggleInvert(): void;
  cycleView(): void;
  toggleTopDown(): void;
  setRenderer(r: '2d' | '3d'): void;
  toggleChase(): void;
  toggleSettings(): void;
  toggleRewind(): void;
  toggleHelp(): void;
  toggleInspect(): void;
  toggleLabels(): void;
  toggleChart(): void;
  lookBack(down: boolean): void;
  flag(): void;
  rewindKey(key: 'space' | 'left' | 'right'): void;
  escape(): void;
}

export const KEY_HELP: Array<[string, string]> = [
  ['Enter', 'GO: the focused lane becomes the real car'],
  ['V', 'top-down (spacing) / drive (closing speed)'],
  ['[ / ]', 'scrub the limit entry back / forward on the road (preview); shift-drag on the road or click the chart does the same'],
  ['W', 'gas (add size + collateral)'],
  ['Shift+W', 'HARD gas (size only, leverage up)'],
  ['C', 'back off (add collateral only)'],
  ['S', 'brake (partial close)'],
  ['Space', 'full brake (close all) · in rewind: pause / resume'],
  ['confirm', 'every pedal and every state-changing hotkey needs a second push (pedals: or Enter); a stray key does nothing'],
  ['in CHASE', 'the same keys do the same things; the labels say what each does to the one behind you'],
  ['mouse', 'move it up to rise and look over your car at the car in front; sideways to glance'],
  ['X', 'withdraw collateral (danger)'],
  ['T / Shift+T', 'trailing stop on / off'],
  ['R', 'rewind drive (the past, in the driver\'s seat)'],
  ['← / →', 'rewind: scrub ±5%'],
  ['M', 'drop a flag (rewind or live)'],
  ['Q (hold)', 'look back at the road behind'],
  ['B', 'bridge chart drawer'],
  ['I', 'inspect panel (every live value, source, formula)'],
  ['L', 'label every object on the road'],
  ['N', 'invert road'],
  ['Shift+V', 'data view: price-only / full dash / combined'],
  ['2 / 3', '2D / 3D renderer'],
  ['K', 'CHASE: the same position, the monster behind you in the mirror; the wheel still zooms to first person'],
  ['wheel', 'zoom the camera: out to a high chase, in to first person'],
  ['drag', 'orbit the camera round the point above your car; double-click resets it'],
  ['Esc', 'settings'],
  ['H', 'this help'],
];

export function installControls(h: ControlHandlers, isDriving: () => boolean, isGhost: () => boolean, isRewind: () => boolean): () => void {
  const down = new Set<string>();
  // Update 17: every state-changing hotkey needs a second push within 2.5 s, so a stray key does nothing
  let armedKey = '';
  let armedUntil = 0;
  const confirm = (k: string, name: string, run: () => void) => {
    const now = Date.now();
    if (armedKey === k && now < armedUntil) { armedKey = ''; run(); return; }
    armedKey = k; armedUntil = now + 2500;
    h.notice(`${name} · push ${k === ' ' ? 'Space' : k === 'Enter' ? 'Enter' : k.length === 1 ? k.toUpperCase() : k} again to confirm`);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA');
    if (e.key === 'Escape') { h.escape(); e.preventDefault(); return; }
    if (typing) {
      if (e.key === 'Enter' && isGhost() && (target as HTMLInputElement).type !== 'button') { h.go(); e.preventDefault(); }
      return;
    }
    const k = e.key;
    const repeatOk = k === '[' || k === ']' || k === 'ArrowLeft' || k === 'ArrowRight';
    if (e.repeat && !repeatOk) return;
    if (down.has(k) && !repeatOk) return;
    down.add(k);
    const drive = isDriving();
    const ghost = isGhost();
    const rewind = isRewind();
    switch (k) {
      case 'w': if (drive) h.pedal('gas_light'); break;
      case 'W': if (drive) h.pedal('gas_hard'); break;
      case 's': case 'S': if (drive) h.pedal('brake_light'); break;
      case ' ':
        if (rewind) { h.rewindKey('space'); e.preventDefault(); }
        else if (drive) { h.pedal('brake_full'); e.preventDefault(); }
        break;
      case 'c': case 'C': if (drive) h.pedal('coast'); break;
      case 'x': case 'X': if (drive) h.pedal('withdraw'); break;
      case 't': if (drive) h.pedal('cruise'); break;
      case 'T': if (drive) h.pedal('cruise_off'); break;
      case 'Enter':
        if (drive && h.confirmPedal()) e.preventDefault();
        else if (ghost && !rewind) { confirm('Enter', 'GO', () => h.go()); e.preventDefault(); }
        break;
      case '[': if (ghost && !rewind) h.nudgeLimit(-1); break;
      case ']': if (ghost && !rewind) h.nudgeLimit(1); break;
      case 'ArrowLeft': if (rewind) { h.rewindKey('left'); e.preventDefault(); } break;
      case 'ArrowRight': if (rewind) { h.rewindKey('right'); e.preventDefault(); } break;
      case 'm': case 'M': confirm('m', 'flag', () => h.flag()); break;
      case 'q': case 'Q': h.lookBack(true); break;
      case 'n': case 'N': confirm('n', 'invert', () => h.toggleInvert()); break;
      case 'v': confirm('v', 'top-down / drive', () => h.toggleTopDown()); break;
      case 'V': confirm('V', 'data view', () => h.cycleView()); break;
      case '2': confirm('2', '2D renderer', () => h.setRenderer('2d')); break;
      case '3': confirm('3', '3D renderer', () => h.setRenderer('3d')); break;
      case 'k': case 'K': confirm('k', 'CHASE', () => h.toggleChase()); break;
      case 'r': case 'R': confirm('r', 'rewind', () => h.toggleRewind()); break;
      case 'i': case 'I': h.toggleInspect(); break;
      case 'l': case 'L': h.toggleLabels(); break;
      case 'b': case 'B': h.toggleChart(); break;
      case 'h': case 'H': case '?': h.toggleHelp(); break;
      default: return;
    }
  };
  const onKeyUp = (e: KeyboardEvent) => {
    down.delete(e.key);
    if (e.key === 'q' || e.key === 'Q') h.lookBack(false);
  };
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => { down.clear(); h.lookBack(false); });
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}
