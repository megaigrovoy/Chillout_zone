/**
 * Slow parameter drift — the flame's "breathing".
 *
 * Held still, the figure was static: hands set the parameters and nothing
 * moved until they moved. Real flame animations get their life from
 * continuously drifting transform parameters, so this supplies a set of slow
 * oscillators the presets modulate themselves with.
 *
 * The periods are deliberately mutually incommensurable (they are irrational
 * multiples of each other). Round periods like 10s/20s/30s would re-align
 * every 30 seconds and the whole figure would visibly repeat; with these it
 * takes many minutes for the combination to come near a repeat, so the motion
 * reads as endless rather than looped.
 */

/** Period in seconds for each channel, chosen to avoid common multiples. */
const PERIODS = [11.3, 17.9, 23.7, 31.1, 41.3, 7.6]

export interface Breath {
  /** Six independent oscillators in -1..1. */
  ch: number[]
  /**
   * Monotonically advancing rotation for the whole figure, radians.
   *
   * Deliberately not an oscillator: a swinging angle reads as the figure
   * rocking back and forth, while continuous advance reads as drift. The rate
   * itself is modulated slightly so it never becomes a metronomic spin.
   */
  spin: number
  /**
   * A slow global swell in 0..1, used for whole-figure intensity. Distinct
   * from the channels because it must never sit at zero for long — that would
   * read as the figure dying rather than breathing.
   */
  swell: number
}

/**
 * Sample the oscillator bank at time `t` (seconds).
 *
 * Each channel sums two sines an octave-and-a-bit apart rather than using one:
 * a single sine has an obvious rhythm, while the sum wanders and never quite
 * settles into a countable beat.
 */
export function breathe(t: number, amount: number): Breath {
  const ch: number[] = []
  for (let i = 0; i < PERIODS.length; i++) {
    const p = PERIODS[i]
    const a = Math.sin((t / p) * Math.PI * 2 + i * 1.7)
    const b = Math.sin((t / (p * 0.41)) * Math.PI * 2 + i * 0.9)
    ch.push((a * 0.72 + b * 0.28) * amount)
  }

  // Swell stays in 0.55..1 so breathing modulates intensity without ever
  // draining the figure.
  const s = Math.sin((t / 13.7) * Math.PI * 2) * 0.5 + 0.5
  const swell = 1 - (1 - s) * 0.45 * amount

  // Base drift of ~1 revolution per 100s, with the rate itself wavering so
  // the motion never settles into a constant, mechanical turn. Integrating
  // the varying rate in closed form (rather than accumulating per frame)
  // keeps the angle identical regardless of framerate or dropped frames.
  const BASE_RATE = (Math.PI * 2) / 100
  const WOBBLE_PERIOD = 29.3
  const wobble =
    (WOBBLE_PERIOD / (Math.PI * 2)) *
    Math.sin((t / WOBBLE_PERIOD) * Math.PI * 2) *
    0.45
  const spin = (t + wobble) * BASE_RATE * amount

  return { ch, swell, spin }
}
