/**
 * Band rendering for the self-similar spirals.
 *
 * The reference image's depth comes from *stacked parallel strips* inside each
 * band, not from a single filled shape: a dark core, then progressively
 * lighter ribs toward the crest. Drawing each segment as a set of nested quads
 * reproduces that ribbed, fanned look, and because the strip count is fixed,
 * a small copy of an arm gets the same internal structure as a large one —
 * which is what keeps the self-similarity readable at every scale.
 */

export interface BandSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  w1: number
  w2: number
  a1: number
  a2: number
  hue: number
  /** 0..1 along the arm — core to rim. */
  t: number
  /** Recursion level, drives darkening of deep detail. */
  depth: number
}

/** Parallel strips per band. Fixed, so scaled copies look identical. */
const RIBS = 5

export function drawSpiralBand(ctx: CanvasRenderingContext2D, s: BandSegment) {
  const n1x = Math.cos(s.a1 + Math.PI / 2)
  const n1y = Math.sin(s.a1 + Math.PI / 2)
  const n2x = Math.cos(s.a2 + Math.PI / 2)
  const n2y = Math.sin(s.a2 + Math.PI / 2)

  for (let i = 0; i < RIBS; i++) {
    // Strips run from the outer edge inward, each offset across the band.
    const outer = 1 - i / RIBS
    const inner = 1 - (i + 1) / RIBS

    const o1 = s.w1 * outer
    const o2 = s.w2 * outer
    const i1 = s.w1 * inner
    const i2 = s.w2 * inner

    // Light rises toward the crest and falls with recursion depth, so deep
    // clusters read as the dark lace of the reference rather than as noise.
    const rib = i / RIBS
    const light = 8 + rib * 62 + s.t * 14 - s.depth * 7
    const sat = 62 + rib * 26

    ctx.fillStyle = `hsl(${s.hue}, ${sat}%, ${Math.max(4, Math.min(88, light))}%)`
    ctx.beginPath()
    ctx.moveTo(s.x1 + n1x * o1, s.y1 + n1y * o1)
    ctx.lineTo(s.x2 + n2x * o2, s.y2 + n2y * o2)
    ctx.lineTo(s.x2 + n2x * i2, s.y2 + n2y * i2)
    ctx.lineTo(s.x1 + n1x * i1, s.y1 + n1y * i1)
    ctx.closePath()
    ctx.fill()

    // Mirror strip on the other side of the spine keeps the band symmetric.
    ctx.beginPath()
    ctx.moveTo(s.x1 - n1x * o1, s.y1 - n1y * o1)
    ctx.lineTo(s.x2 - n2x * o2, s.y2 - n2y * o2)
    ctx.lineTo(s.x2 - n2x * i2, s.y2 - n2y * i2)
    ctx.lineTo(s.x1 - n1x * i1, s.y1 - n1y * i1)
    ctx.closePath()
    ctx.fill()
  }

  // Dark seam along the spine — the near-black channel that separates the two
  // halves of every band in the reference.
  if (s.w2 > 1.2) {
    ctx.strokeStyle = `hsl(${s.hue}, 70%, ${Math.max(3, 9 - s.depth * 2)}%)`
    ctx.lineWidth = Math.max(0.5, s.w2 * 0.22)
    ctx.beginPath()
    ctx.moveTo(s.x1, s.y1)
    ctx.lineTo(s.x2, s.y2)
    ctx.stroke()
  }
}
