/** How far back the rate looks: long enough to even out bursts, short enough to follow changes. */
const WINDOW_MS = 8_000;
/** Less than this is too little to say anything about the rate. */
const MIN_SPAN_MS = 2_000;

/**
 * The rate of a growing byte count over the last few seconds, from samples
 * taken whenever it changes. Network progress arrives in bursts, so the rate
 * over a window says more than the gap between two samples.
 */
export class RateMeter {
  private samples: { at: number; bytes: number }[] = [];
  private changedAt: number | null = null;

  add(bytes: number, at: number = Date.now()) {
    const last = this.samples.at(-1);
    if (last && bytes === last.bytes) return;
    // A count that went back (a part sent again) starts the window over.
    if (last && bytes < last.bytes) this.samples = [];
    this.samples.push({ at, bytes });
    this.changedAt = at;
    // Keep one sample from before the window, so it always spans all of it.
    while (this.samples.length > 2 && this.samples[1].at <= at - WINDOW_MS) {
      this.samples.shift();
    }
  }

  /** Bytes per second, or null while there is too little to tell. */
  rate(at: number = Date.now()): number | null {
    const first = this.samples[0];
    const last = this.samples.at(-1);
    if (!first || !last) return null;
    const span = at - first.at;
    if (span < MIN_SPAN_MS) return null;
    return (last.bytes - first.bytes) / (span / 1000);
  }

  /** How long the count has stood still, in ms; 0 before it ever moved. */
  stillFor(at: number = Date.now()): number {
    return this.changedAt === null ? 0 : at - this.changedAt;
  }
}

/** A rough time left, the way a person would say it: "about 2 min left". */
export function formatTimeLeft(seconds: number): string {
  if (seconds < 10) return "a few seconds left";
  // Below 55 s, as 55 s and more would round to "60 s".
  if (seconds < 55) return `about ${Math.round(seconds / 10) * 10} s left`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  return `about ${hours} h ${minutes % 60} min left`;
}

/** A transfer rate: "1.2 MB/s", "340 KB/s". */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond >= 1024 * 1024) return `${(bytesPerSecond / (1024 * 1024)).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(bytesPerSecond / 1024))} KB/s`;
}
