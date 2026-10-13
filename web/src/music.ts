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
  private resumed = false;   // Update 24: the first track after a load is the one that was playing, where it was
  private lastSave = 0;

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

  private save(clear = false): void {
    const el = this.el;
    if (!el || !this.last) return;
    const now = Date.now();
    if (!clear && now - this.lastSave < 2000) return;
    this.lastSave = now;
    try { localStorage.setItem('traffic.music', JSON.stringify({ url: this.last.url, time: clear ? 0 : el.currentTime })); } catch { /* ignore */ }
  }

  private next(): void {
    // Update 24: after a reload, carry on with the track that was playing, from where it was
    let resume: { t: Track; at: number } | null = null;
    if (!this.resumed) {
      this.resumed = true;
      try {
        const raw = localStorage.getItem('traffic.music');
        if (raw) {
          const s = JSON.parse(raw) as { url: string; time: number };
          const found = TRACKS.find((x) => x.url === s.url);
          if (found && s.time > 2) resume = { t: found, at: s.time };
        }
      } catch { /* ignore */ }
    }
    if (resume) {
      this.last = resume.t;
      this.ensureEl();
      const el = this.el!;
      const at = resume.at;
      const onMeta = () => { el.currentTime = Math.min(at, Math.max(0, (el.duration || at + 1) - 1)); el.removeEventListener('loadedmetadata', onMeta); };
      el.addEventListener('loadedmetadata', onMeta);
      el.src = resume.t.url;
      el.volume = 0;
      this.play();
      this.onTrack(resume.t);
      return;
    }
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
    this.ensureEl();
    this.el!.src = t.url;
    this.el!.volume = 0;
    this.play();
    this.onTrack(t);
  }

  private ensureEl(): void {
    if (this.el) return;
    this.el = new Audio();
    this.el.preload = 'auto';
    this.el.addEventListener('ended', () => { this.save(true); if (this.racing) this.next(); });
    this.el.addEventListener('timeupdate', () => this.save());
    this.el.addEventListener('pause', () => this.save());
  }

  private play(): void {
    this.blocked = false;
    this.el?.play().catch(() => { this.blocked = true; });
  }
}
