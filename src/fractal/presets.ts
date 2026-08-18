import { VARIATIONS } from './variations'
import type { XForm, FlameSpec } from './flame'
import type { Variation } from './variations'

/**
 * Flame construction driven by hand state.
 *
 * A flame's character comes almost entirely from *which variations* are
 * blended and how the affine parts are rotated/scaled. Rather than randomising
 * freely (which mostly yields mush), we interpolate between hand-tuned
 * archetypes that are known to produce the spiral imagery this app is after.
 */

/** Build an affine transform from readable parameters instead of raw a..f. */
function affine(
  rotation: number,
  scaleX: number,
  scaleY: number,
  tx: number,
  ty: number,
): Pick<XForm, 'a' | 'b' | 'c' | 'd' | 'e' | 'f'> {
  const cos = Math.cos(rotation)
  const sin = Math.sin(rotation)
  return {
    a: cos * scaleX,
    b: -sin * scaleY,
    c: tx,
    d: sin * scaleX,
    e: cos * scaleY,
    f: ty,
  }
}

function vars(spec: Array<[keyof typeof VARIATIONS, number]>) {
  return spec
    .filter(([, w]) => w !== 0)
    .map(([name, w]) => ({ fn: VARIATIONS[name] as Variation, w }))
}

/** One hand, already converted into flame space (-1..1, y up-ish). */
export interface HandControl {
  /** Position in flame space — where this hand's structure is anchored. */
  x: number
  y: number
  /** 0..1 hand openness. */
  openness: number
  /** Hand rotation, radians. */
  rotation: number
  /** 0..1 motion energy for this hand. */
  energy: number
  /** Apparent hand size, a proximity proxy. */
  scale: number
  /** Palette offset for this hand, 0..1. */
  colorBase: number
}

export interface FlameControls {
  hands: HandControl[]
  energy: number
  /** Seconds since start, for the idle drift. */
  time: number
}

/**
 * Build the flame from the tracked hands.
 *
 * Each hand contributes its own transform cluster anchored at its position, so
 * structure visibly emanates from the hands rather than from a fixed centre.
 * With two hands the clusters share one attractor, which is what makes the
 * forms grow toward each other and interlock instead of sitting side by side.
 */
export function handFlame(c: FlameControls): FlameSpec {
  const xforms: XForm[] = []

  if (c.hands.length === 0) {
    return idleFlame(c.time, c.energy)
  }

  for (const hand of c.hands) {
    // Openness maps to spiral spread over a deliberately wide range: the
    // previous 0.45..0.95 band was too narrow to feel responsive.
    const spread = 0.28 + hand.openness * 0.72
    const spin = hand.rotation

    // The julia transform anchored at the hand — the spiral arms. Translating
    // the affine part by the hand position is what makes the figure grow out
    // of the hand instead of out of the origin.
    xforms.push({
      ...affine(spin, spread, spread, hand.x, hand.y),
      weight: 1.0,
      color: hand.colorBase,
      vars: vars([
        ['julia', 1.0],
        ['spiral', 0.04 + hand.energy * 0.22],
        // Openness swaps in swirl, which visibly churns the arms when the
        // hand opens — a much stronger read than a scale change alone.
        ['swirl', hand.openness * 0.35],
      ]),
    })

    // A contracting transform that keeps density near the hand, so each hand
    // has a bright core the structure radiates from.
    xforms.push({
      ...affine(
        spin * 0.6 + 0.3,
        0.36 + hand.openness * 0.22,
        0.36 + hand.openness * 0.22,
        hand.x * 0.72,
        hand.y * 0.72,
      ),
      weight: 0.5 + hand.openness * 0.35,
      color: hand.colorBase + 0.18,
      vars: vars([
        ['linear', 0.62],
        ['spherical', 0.2 + hand.openness * 0.4],
        ['disc', hand.energy * 0.3],
      ]),
    })

    // Fast movement adds a third transform that throws off filaments, so
    // waving actually changes the figure's structure and not just its colour.
    if (hand.energy > 0.12) {
      xforms.push({
        ...affine(-spin * 1.1, 0.3 + hand.energy * 0.4, 0.3, hand.x * 1.1, hand.y * 1.1),
        weight: 0.25 + hand.energy * 0.6,
        color: hand.colorBase + 0.4,
        vars: vars([
          ['handkerchief', 0.3 + hand.energy * 0.5],
          ['linear', 0.35],
          ['horseshoe', hand.energy * 0.35],
        ]),
      })
    }
  }

  // With both hands up, one shared transform links the two clusters. It is
  // what makes the halves reach toward each other and entangle rather than
  // rendering as two independent flames in one frame.
  if (c.hands.length >= 2) {
    const [a, b] = c.hands
    const mx = (a.x + b.x) * 0.5
    const my = (a.y + b.y) * 0.5
    const between = Math.atan2(b.y - a.y, b.x - a.x)
    const gap = Math.hypot(b.x - a.x, b.y - a.y)
    // Closer hands bind harder, so bringing them together visibly fuses the
    // two structures into one.
    const bind = Math.max(0, 1 - gap / 2.2)

    xforms.push({
      ...affine(between, 0.55 + bind * 0.3, 0.34, mx, my),
      weight: 0.35 + bind * 0.9,
      color: 0.55,
      vars: vars([
        ['linear', 0.45],
        ['swirl', 0.3 + bind * 0.6],
        ['spherical', 0.35],
      ]),
    })
  }

  return {
    xforms,
    // A mild eyefish final transform curves the whole figure outward, which is
    // what gives flames their characteristic bulge instead of a flat disc.
    final: {
      ...affine(0, 1, 1, 0, 0),
      weight: 1,
      color: 0,
      vars: vars([
        ['eyefish', 0.18 + c.energy * 0.2],
        ['linear', 0.85],
      ]),
    },
  }
}

/** Slowly drifting figure shown when no hands are visible. */
function idleFlame(time: number, energy: number): FlameSpec {
  const spin = time * 0.12
  const spread = 0.6 + Math.sin(time * 0.2) * 0.25
  return {
    xforms: [
      {
        ...affine(spin, spread, spread, 0, 0),
        weight: 1,
        color: 0.1,
        vars: vars([
          ['julia', 1.0],
          ['spiral', 0.08],
        ]),
      },
      {
        ...affine(spin * 0.5 + 0.3, 0.42, 0.42, 0.22, 0.1),
        weight: 0.45,
        color: 0.55,
        vars: vars([
          ['linear', 0.7],
          ['swirl', 0.4],
        ]),
      },
    ],
    final: {
      ...affine(0, 1, 1, 0, 0),
      weight: 1,
      color: 0,
      vars: vars([
        ['eyefish', 0.2 + energy * 0.15],
        ['linear', 0.82],
      ]),
    },
  }
}

/** Palette: a smooth cosine gradient, 256 entries as RGB triples. */
export function buildPalette(hueShift: number, energy: number): Float32Array {
  const p = new Float32Array(256 * 3)
  for (let i = 0; i < 256; i++) {
    const t = i / 255
    // Cosine palettes (Inigo Quilez's formulation): compact and always smooth,
    // which suits flames because colour index varies continuously.
    const a = 0.5
    const b = 0.5
    const freq = 1.0
    const phase = hueShift

    const r = a + b * Math.cos(2 * Math.PI * (freq * t + phase))
    const g = a + b * Math.cos(2 * Math.PI * (freq * t + phase + 0.22))
    const bl = a + b * Math.cos(2 * Math.PI * (freq * t + phase + 0.45))

    // Bias toward the cool end so the palette stays in the blue/violet family
    // of the reference rather than sweeping through every hue.
    const boost = 1 + energy * 0.45
    p[i * 3] = Math.min(255, r * 190 * boost)
    p[i * 3 + 1] = Math.min(255, g * 215 * boost)
    p[i * 3 + 2] = Math.min(255, bl * 255 * boost)
  }
  return p
}
