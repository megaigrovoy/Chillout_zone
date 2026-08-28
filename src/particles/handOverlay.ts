import type { HandState } from '../tracking/types'

/**
 * Hand skeleton drawn in the emitter's own colour.
 *
 * The flame mode has an equivalent overlay, but it samples the flame's palette
 * buffer — which does not exist here. Rather than force that module to work
 * against two colour models, this one takes a plain hue: paint mode thinks in
 * per-hand hues, so the overlay reads as the nozzle the paint comes out of.
 */

/** MediaPipe hand connections: the 21-landmark bone graph. */
const BONES: Array<[number, number]> = [
  // thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // middle
  [9, 10], [10, 11], [11, 12],
  // ring
  [13, 14], [14, 15], [15, 16],
  // pinky
  [0, 17], [17, 18], [18, 19], [19, 20],
  // knuckle bridge
  [5, 9], [9, 13], [13, 17],
]

const TIPS = new Set([4, 8, 12, 16, 20])

export function drawHandOverlay(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hand: HandState,
  hue: number,
  /** 0..1 — how open the tap is; 0 means no paint is flowing. */
  flow: number,
) {
  const pts = hand.landmarks
  if (!pts || pts.length < 21) return

  // Mirrored to match the video the player sees.
  const px = (i: number) => (1 - pts[i].x) * width
  const py = (i: number) => pts[i].y * height

  // Additive, so the overlay glows into the paint rather than punching an
  // opaque shape over it.
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // A closed hand is dimmed rather than hidden: the player still needs to see
  // where their hand is while the tap is shut, but the overlay should make it
  // obvious that nothing is coming out.
  const lit = 0.3 + flow * 0.7

  for (let pass = 0; pass < 2; pass++) {
    const glow = pass === 0
    ctx.lineWidth = glow ? 8 + flow * 5 : 2
    ctx.strokeStyle = `hsla(${hue}, 90%, ${58 + flow * 18}%, ${
      (glow ? 0.05 : 0.34) * lit
    })`

    // One path for all bones: stroke() is the expensive call, not the geometry.
    ctx.beginPath()
    for (const [a, b] of BONES) {
      ctx.moveTo(px(a), py(a))
      ctx.lineTo(px(b), py(b))
    }
    ctx.stroke()
  }

  // Joints, with fingertips brighter so the pose reads even where bones cross.
  for (let i = 0; i < 21; i++) {
    const tip = TIPS.has(i)
    const r = tip ? 3.6 + flow * 1.8 : 2

    ctx.fillStyle = `hsla(${hue}, 92%, 72%, ${(tip ? 0.14 : 0.09) * lit})`
    ctx.beginPath()
    ctx.arc(px(i), py(i), r * 2.6, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = `hsla(${hue}, 92%, ${70 + flow * 15}%, ${(tip ? 0.7 : 0.42) * lit})`
    ctx.beginPath()
    ctx.arc(px(i), py(i), r, 0, Math.PI * 2)
    ctx.fill()
  }

  // A ring at the palm marking the emission radius, so it is visible where
  // paint will actually appear — and it grows as the hand opens.
  if (flow > 0) {
    const cx = (1 - hand.center.x) * width
    const cy = hand.center.y * height
    ctx.strokeStyle = `hsla(${hue}, 95%, 76%, ${0.10 + flow * 0.22})`
    ctx.lineWidth = 1.5
    ctx.beginPath()
    ctx.arc(cx, cy, 10 + flow * 26, 0, Math.PI * 2)
    ctx.stroke()
  }

  ctx.globalCompositeOperation = 'source-over'
}
