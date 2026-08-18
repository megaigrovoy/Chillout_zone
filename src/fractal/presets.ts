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

export interface FlameControls {
  /** 0..1 hand openness. */
  openness: number
  /** Hand rotation, radians. */
  rotation: number
  /** 0..1 vertical position (0 = top). */
  height: number
  /** 0..1 motion energy. */
  energy: number
  /** Palette rotation seed. */
  hueShift: number
}

/**
 * The "grand julian" family: a julia variation against a rotated affine set.
 *
 * This is the classic Apophysis construction behind the spiral-with-lace look
 * of the reference image — nested spirals whose arms are themselves made of
 * smaller spirals. The julia variation's square-root branch is what generates
 * the self-similar doubling.
 */
export function grandJulian(c: FlameControls): FlameSpec {
  // Openness opens the spiral: more rotation between arms, wider scale.
  const spin = c.rotation
  const spread = 0.45 + c.openness * 0.5

  const xforms: XForm[] = []

  // The julia transform: generates the spiral arms and their nesting.
  xforms.push({
    ...affine(spin, spread, spread, 0, 0),
    weight: 1.0,
    color: 0.0,
    vars: vars([
      ['julia', 1.0],
      ['spiral', 0.06 + c.energy * 0.10],
    ]),
  })

  // A gentle linear contraction keeps density in the core so the centre reads
  // as a bright hub rather than a hole.
  xforms.push({
    ...affine(spin * 0.5 + 0.3, 0.42, 0.42, 0.22, 0.1),
    weight: 0.42,
    color: 0.35,
    vars: vars([
      ['linear', 0.7],
      ['swirl', 0.3 + c.openness * 0.5],
    ]),
  })

  // Depth (hand height) adds a third transform that decorates the arms with
  // finer structure — this is what fills the rim with lace.
  const detail = 1 - c.height
  if (detail > 0.25) {
    xforms.push({
      ...affine(-spin * 0.8, 0.3 + detail * 0.3, 0.3 + detail * 0.3, -0.3, 0.25),
      weight: 0.3 + detail * 0.35,
      color: 0.72,
      vars: vars([
        ['disc', 0.35 * detail],
        ['spherical', 0.5],
        ['linear', 0.3],
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
        ['eyefish', 0.22 + c.energy * 0.15],
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
    const boost = 1 + energy * 0.35
    p[i * 3] = Math.min(255, r * 190 * boost)
    p[i * 3 + 1] = Math.min(255, g * 215 * boost)
    p[i * 3 + 2] = Math.min(255, bl * 255 * boost)
  }
  return p
}
