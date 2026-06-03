/**
 * Stillness detector for a 3-axis accelerometer stream.
 *
 * The user's intuition was "same value to ~5% over 1 second" — at rest
 * a phone reports |g| ≈ 9.81 m/s² along whatever axis is up, with most
 * of the noise on the other two axes hovering near 0. A relative
 * percentage threshold breaks down when the mean is near zero (which
 * is the common case for two of the three axes), so we use an absolute
 * range across a sliding time window: max(x) - min(x) ≤ maxRange on
 * every axis, sustained for [windowMs]. 0.5 m/s² is roughly 5% of g
 * and matches the user-described tolerance.
 *
 * The detector is pure — feed it samples and read the boolean — so it
 * unit-tests cleanly without spinning up the bus or a phone.
 */

export interface AccelSample {
  x: number;
  y: number;
  z: number;
  /** Wall-clock ms — caller-provided so tests can drive a virtual clock. */
  t: number;
}

export interface StillnessOptions {
  /** Window in ms over which all three axes must stay within `maxRange`. */
  windowMs?: number;
  /** Max range (max - min) per axis before "still" is rejected. */
  maxRange?: number;
  /** Minimum samples in the window before a verdict is issued. */
  minSamples?: number;
}

export class StillnessDetector {
  private buffer: AccelSample[] = [];
  private readonly windowMs: number;
  private readonly maxRange: number;
  private readonly minSamples: number;
  private _isStill = false;
  private _stillSince: number | null = null;

  constructor(opts: StillnessOptions = {}) {
    this.windowMs = opts.windowMs ?? 1000;
    this.maxRange = opts.maxRange ?? 0.5;
    this.minSamples = opts.minSamples ?? 5;
  }

  /** True when the window is entirely within tolerance. */
  get isStill(): boolean { return this._isStill; }
  /** Wall-clock ms when stillness began, or null when moving. */
  get stillSince(): number | null { return this._stillSince; }

  /**
   * Push one sample. Returns whether the still/moving verdict
   * changed on this sample, plus the new state. Caller drives the
   * "newly still" / "newly moving" handlers off `changed`.
   */
  feed(s: AccelSample): { changed: boolean; isStill: boolean } {
    this.buffer.push(s);
    const cutoff = s.t - this.windowMs;
    // Keep ONE sample older than the window boundary, so the buffer's span
    // actually reaches `windowMs`. With irregular sample spacing (real sensor
    // jitter, or a throttled stream) the cutoff rarely lands exactly on a
    // sample, so trimming everything older than it left span strictly below
    // windowMs forever — and the verdict never flipped to "still".
    while (this.buffer.length > 1 && this.buffer[1].t < cutoff) {
      this.buffer.shift();
    }

    // Until we have enough samples spanning the window, hold whatever
    // verdict we last issued. Avoids flapping on the first 100 ms of a
    // fresh stream.
    if (this.buffer.length < this.minSamples) {
      return { changed: false, isStill: this._isStill };
    }
    const span = this.buffer[this.buffer.length - 1].t - this.buffer[0].t;
    if (span < this.windowMs) {
      return { changed: false, isStill: this._isStill };
    }

    const stillNow = this.computeStill();
    const changed = stillNow !== this._isStill;
    this._isStill = stillNow;
    if (changed) this._stillSince = stillNow ? s.t : null;
    return { changed, isStill: stillNow };
  }

  reset(): void {
    this.buffer = [];
    this._isStill = false;
    this._stillSince = null;
  }

  private computeStill(): boolean {
    for (const axis of ["x", "y", "z"] as const) {
      let min = Infinity;
      let max = -Infinity;
      for (const s of this.buffer) {
        const v = s[axis];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (max - min > this.maxRange) return false;
    }
    return true;
  }
}
