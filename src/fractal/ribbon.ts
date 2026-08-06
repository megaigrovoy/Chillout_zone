/**
 * Ribbon rendering — the visual language of the reference image.
 *
 * A thread-drawn fractal reads as a wire diagram. What makes classic flame /
 * spiral fractals look solid is that every branch is a *tapering band* filled
 * with concentric layers, with a fringe of small self-similar curls riding its
 * outer edge. This module draws one such band per growth step.
 */

export interface RibbonSegment {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Half-width at the start / end of the step, px. */
  w1: number
  w2: number
  /** Heading at the start / end, radians — the band follows the curve. */
  a1: number
  a2: number
  hue: number
  /** 0..1 lightness driver: 0 = deep core, 1 = bright crest. */
  shade: number
  /** 0..1 how strongly the fringe of curls shows on the outer edge. */
  lace: number
  /** Signed curvature of this step; the fringe rides the outer side. */
  curl: number
}

/**
 * Draw one tapering, layered band.
 *
 * The band is a quad whose ends are perpendicular to the local heading, so
 * consecutive segments meet without gaps as the path curves. Inside it we lay
 * a few concentric strips at decreasing width — that layering is what produces
 * the fanned, ribbed look rather than a flat blob.
 */
export function drawRibbon(ctx: CanvasRenderingContext2D, s: RibbonSegment) {
  const n1x = Math.cos(s.a1 + Math.PI / 2)
  const n1y = Math.sin(s.a1 + Math.PI / 2)
  const n2x = Math.cos(s.a2 + Math.PI / 2)
  const n2y = Math.sin(s.a2 + Math.PI / 2)

  // Layers run from the full band inward. Each is lighter than the last, so
  // the band reads as a lit ridge with a dark core.
  const LAYERS = 3
  for (let i = 0; i < LAYERS; i++) {
    const k = 1 - i / LAYERS
    const w1 = s.w1 * k
    const w2 = s.w2 * k

    // Deep core -> bright crest. The inner strips are brightest, which is what
    // gives the reference image its glowing spine.
    const light = 12 + s.shade * 30 + (1 - k) * 46
    const sat = 70 + s.shade * 22
    const alpha = 0.16 + (1 - k) * 0.20

    ctx.fillStyle = `hsla(${s.hue}, ${sat}%, ${light}%, ${alpha})`
    ctx.beginPath()
    ctx.moveTo(s.x1 + n1x * w1, s.y1 + n1y * w1)
    ctx.lineTo(s.x2 + n2x * w2, s.y2 + n2y * w2)
    ctx.lineTo(s.x2 - n2x * w2, s.y2 - n2y * w2)
    ctx.lineTo(s.x1 - n1x * w1, s.y1 - n1y * w1)
    ctx.closePath()
    ctx.fill()
  }

  // Bright rim on the crest edge, the highlight that separates one ribbon
  // from the one behind it.
  const rim = s.curl >= 0 ? 1 : -1
  ctx.strokeStyle = `hsla(${s.hue}, 95%, ${68 + s.shade * 22}%, ${0.25 + s.shade * 0.35})`
  ctx.lineWidth = 0.7 + s.w2 * 0.10
  ctx.beginPath()
  ctx.moveTo(s.x1 + n1x * s.w1 * rim, s.y1 + n1y * s.w1 * rim)
  ctx.lineTo(s.x2 + n2x * s.w2 * rim, s.y2 + n2y * s.w2 * rim)
  ctx.stroke()

  if (s.lace > 0.02 && s.w2 > 1.6) drawLace(ctx, s, rim, n2x, n2y)
}

/**
 * The fringe: small self-similar curls on the outer edge of a turning band.
 *
 * This is the detail that makes the form read as *fractal* rather than as a
 * ribbon — in the reference image every large spiral is trimmed with clusters
 * of the same spiral in miniature. They are drawn as filled arcs so they stay
 * solid at small sizes instead of dissolving into aliased lines.
 */
function drawLace(
  ctx: CanvasRenderingContext2D,
  s: RibbonSegment,
  rim: number,
  nx: number,
  ny: number,
) {
  const ex = s.x2 + nx * s.w2 * rim
  const ey = s.y2 + ny * s.w2 * rim

  const count = 2 + Math.floor(s.lace * 3)
  const baseR = s.w2 * (0.34 + s.lace * 0.4)

  for (let i = 0; i < count; i++) {
    // Curls shrink along the cluster, echoing the parent's taper.
    const t = i / count
    const r = baseR * (1 - t * 0.55)
    if (r < 0.5) break

    // Ride slightly ahead along the edge so the cluster trails the crest.
    const slide = (i - count / 2) * r * 1.5
    const cx = ex + Math.cos(s.a2) * slide - nx * r * rim * 0.35
    const cy = ey + Math.sin(s.a2) * slide - ny * r * rim * 0.35

    const light = 55 + s.shade * 30 + t * 12
    ctx.fillStyle = `hsla(${s.hue}, 92%, ${light}%, ${(0.16 + s.lace * 0.3) * (1 - t * 0.4)})`
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()

    // A dark eye at the centre — the signature of the reference's curls.
    if (r > 1.6) {
      ctx.fillStyle = `hsla(${s.hue}, 80%, 10%, ${0.30 + s.lace * 0.3})`
      ctx.beginPath()
      ctx.arc(cx, cy, r * 0.34, 0, Math.PI * 2)
      ctx.fill()
    }
  }
}
