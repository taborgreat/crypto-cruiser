// Race music: a shuffled playlist that plays only while driving (never on the menu). Every race start
// picks a fresh track; when one ends the next in the shuffle follows. Drop more .mp3 files into
// web/music/ and they join the rotation.
const URLS = import.meta.glob<string>('../music/*.mp3', { eager: true, query: '?url', import: 'default' });

export interface Track { title: string; url: string }

const TRACKS: Track[] = Object.entries(URLS).map(([file, url]) => ({
  title: file.replace(/^.*\//, '').replace(/\.mp3$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  url,
}));

export const MUSIC_CREDIT = 'Karl Casey @ White Bat Audio';

export class Music {
  private el: HTMLAudioElement | null = null;
  private bag: Track[] = [];
  private last: Track | null = null;
  private racing = false;
  private blocked = false;   // autoplay refused: retry on the next user gesture

  constructor(private onTrack: (t: Track) => void = () => undefined) {
    const retry = () => { if (this.blocked && this.racing) this.play(); };
    window.addEventListener('keydown', retry, { passive: true });
    window.addEventListener('pointerdown', retry, { passive: true });
  }

  /** Called ~20 times a second. `racing` rising = a race started: new random track. */
  update(racing: boolean, volume: number): void {
    const want = racing && volume > 0 && TRACKS.length > 0;
    if (want && !this.racing) this.next();
    this.racing = want;
    const el = this.el;
    if (!el) return;
    // fade toward the target; pause once silent
    const target = want ? volume : 0;
    const v = el.volume + Math.max(-0.08, Math.min(0.08, target - el.volume));
    el.volume = Math.min(1, Math.max(0, v));
    if (!want && el.volume <= 0.001 && !el.paused) el.pause();
  }

  private next(): void {
    if (!this.bag.length) {
      this.bag = [...TRACKS];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      // never the same track twice in a row across a reshuffle
      if (this.bag.length > 1 && this.bag[this.bag.length - 1] === this.last) this.bag.reverse();
    }
    const t = this.bag.pop()!;
    this.last = t;
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = 'auto';
      this.el.addEventListener('ended', () => { if (this.racing) this.next(); });
    }
    this.el.src = t.url;
    this.el.volume = 0;
    this.play();
    this.onTrack(t);
  }

  private play(): void {
    this.blocked = false;
    this.el?.play().catch(() => { this.blocked = true; });
  }
}
