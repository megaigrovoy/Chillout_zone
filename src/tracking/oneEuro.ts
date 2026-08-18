/**
 * One Euro Filter (Casiez, Roussel & Vogel, CHI 2012).
 *
 * A plain EMA forces a single trade-off: smooth enough to kill jitter means
 * laggy enough to feel disconnected from the hand. The One Euro filter adapts
 * its cutoff to speed instead — heavy smoothing when the hand is still (where
 * jitter is visible and lag is not), light smoothing when it moves fast (where
 * lag is visible and jitter is not). That is exactly the trade-off hand
 * tracking needs, which is why it is the standard choice for this.
 */

class LowPass {
  private y: number | null = null

  filter(x: number, alpha: number): number {
    this.y = this.y === null ? x : alpha * x + (1 - alpha) * this.y
    return this.y
  }

  get value() {
    return this.y
  }

  reset() {
    this.y = null
  }
}

export class OneEuroFilter {
  private x = new LowPass()
  private dx = new LowPass()
  private lastTime: number | null = null

  /**
   * @param minCutoff Baseline cutoff in Hz. Lower = smoother when still.
   * @param beta      Speed coefficient. Higher = less lag when moving fast.
   * @param dCutoff   Cutoff for the derivative estimate itself.
   */
  constructor(
    private minCutoff = 0.8,
    private beta = 5.0,
    private dCutoff = 1.0,
  ) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(value: number, timestamp: number): number {
    if (this.lastTime === null) {
      this.lastTime = timestamp
      return this.x.filter(value, 1)
    }

    let dt = (timestamp - this.lastTime) / 1000
    this.lastTime = timestamp
    // Guard against a zero or absurd dt (tab wake, duplicate frame), which
    // would otherwise make alpha degenerate.
    if (!(dt > 0) || dt > 0.5) dt = 1 / 60

    const prev = this.x.value
    const rawSpeed = prev === null ? 0 : (value - prev) / dt
    const speed = this.dx.filter(rawSpeed, this.alpha(this.dCutoff, dt))

    // The adaptive step: cutoff rises with speed, so fast motion passes
    // through nearly unfiltered while a still hand is smoothed hard.
    const cutoff = this.minCutoff + this.beta * Math.abs(speed)
    return this.x.filter(value, this.alpha(cutoff, dt))
  }

  reset() {
    this.x.reset()
    this.dx.reset()
    this.lastTime = null
  }
}

/** Convenience wrapper filtering a 2D point with one filter per axis. */
export class OneEuroPoint {
  private fx: OneEuroFilter
  private fy: OneEuroFilter

  constructor(minCutoff = 0.8, beta = 5.0) {
    this.fx = new OneEuroFilter(minCutoff, beta)
    this.fy = new OneEuroFilter(minCutoff, beta)
  }

  filter(x: number, y: number, t: number): { x: number; y: number } {
    return { x: this.fx.filter(x, t), y: this.fy.filter(y, t) }
  }

  reset() {
    this.fx.reset()
    this.fy.reset()
  }
}
