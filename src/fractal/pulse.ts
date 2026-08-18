/**
 * Motion pulse — the flame's reaction to a sharp gesture.
 *
 * The smoothed energy the rest of the app uses is deliberately gentle, which
 * is right for steering parameters but wrong for impact: by the time it rises,
 * the gesture is over. A pulse needs the opposite envelope — snap up on the
 * leading edge, fall away slowly afterwards, the way a struck object rings.
 *
 * Implemented as an asymmetric envelope follower: rise is near-instant, decay
 * is exponential in real time so it behaves identically at any framerate.
 */

export class Pulse {
  /** Current envelope value, 0..1. */
  private level = 0
  /** Smoothed speed baseline, used to detect a *change* in motion. */
  private baseline = 0

  /**
   * @param attack  Fraction of the gap closed per frame while rising. High so
   *                the hit lands on the same frame the gesture starts.
   * @param release Envelope multiplier per second while falling.
   */
  constructor(
    private attack = 0.55,
    private release = 0.18,
  ) {}

  /**
   * Feed the current motion speed and advance the envelope.
   *
   * The trigger is speed *above the running baseline*, not raw speed: a hand
   * moving steadily should not hold the pulse open, only an acceleration
   * should fire it. That is what makes a jab read as a hit while a slow sweep
   * does not.
   */
  update(speed: number, dt: number): number {
    // Baseline tracks sustained motion over roughly a second.
    const bAlpha = 1 - Math.exp(-dt * 1.2)
    this.baseline += (speed - this.baseline) * bAlpha

    const excess = Math.max(0, speed - this.baseline * 1.15)
    const target = Math.min(1, excess * 2.2)

    if (target > this.level) {
      // Attack: jump most of the way immediately.
      this.level += (target - this.level) * this.attack
    } else {
      // Release: exponential decay, framerate-independent.
      this.level *= Math.pow(this.release, dt)
    }

    return this.level
  }

  get value() {
    return this.level
  }

  reset() {
    this.level = 0
    this.baseline = 0
  }
}
