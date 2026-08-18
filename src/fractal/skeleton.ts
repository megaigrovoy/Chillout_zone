import type { HandState } from '../tracking/types'

/**
 * Hand skeleton overlay.
 *
 * The plain circles this replaces showed *where* a hand was but not what it
 * was doing. Drawing the actual bone structure makes openness, rotation and
 * individual finger poses directly legible, so the player can see the same
 * thing the flame reacts to.
 *
 * Colour is sampled from the flame's own palette and cycles along the bones,
 * so the overlay shimmers with the fractal rather than sitting on top of it as
 * a foreign UI element.
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

/** Landmarks drawn as joints, sized by importance. */
const TIPS = new Set([4, 8, 12, 16, 20])

/**
 * Sample the flame palette as a CSS colour.
 *
 * The palette is the same Float32Array the chaos game splats with, so the
 * overlay is literally tinted by the fractal's current colours.
 */
function paletteColor(palette: Float32Array, t: number, alpha: number): string {
  const i = Math.max(0, Math.min(255, Math.round(t * 255))) * 3
  // Lift toward white a little: palette entries are tuned for additive
  // accumulation and read too dim as a single stroke.
  const r = Math.min(255, palette[i] * 1.5 + 40) | 0
  const g = Math.min(255, palette[i + 1] * 1.5 + 40) | 0
  const b = Math.min(255, palette[i + 2] * 1.5 + 40) | 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function drawSkeleton(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  hand: HandState,
  palette: Float32Array,
  time: number,
  energy: number,
) {
  const pts = hand.landmarks
  if (!pts || pts.length < 21) return

  // Mirrored to match the video the player sees.
  const px = (i: number) => (1 - pts[i].x) * width
  const py = (i: number) => pts[i].y * height

  // Additive blending so the skeleton glows into the flame instead of
  // punching a flat opaque shape over it.
  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Colour cycles along the hand and drifts over time, which is what produces
  // the shimmer. Offsetting per hand keeps the two hands distinguishable.
  const phase = time * 0.12 + (hand.handedness === 'Left' ? 0 : 0.5)

  // Two passes per bone: a wide soft pass for the glow, a thin bright pass for
  // the line itself. Canvas shadowBlur would be far more expensive per frame.
  for (let pass = 0; pass < 2; pass++) {
    const glow = pass === 0
    ctx.lineWidth = glow ? 9 + energy * 5 : 2.2

    for (let i = 0; i < BONES.length; i++) {
      const [a, b] = BONES[i]
      const t = (i / BONES.length + phase) % 1
      ctx.strokeStyle = paletteColor(palette, t, glow ? 0.07 + energy * 0.05 : 0.5 + energy * 0.25)
      ctx.beginPath()
      ctx.moveTo(px(a), py(a))
      ctx.lineTo(px(b), py(b))
      ctx.stroke()
    }
  }

  // Joints: fingertips get a brighter, larger dot so finger poses read at a
  // glance even when bones overlap.
  for (let i = 0; i < 21; i++) {
    const tip = TIPS.has(i)
    const t = (i / 21 + phase) % 1
    const r = tip ? 4.5 + energy * 2 : 2.4

    ctx.fillStyle = paletteColor(palette, t, tip ? 0.16 : 0.10)
    ctx.beginPath()
    ctx.arc(px(i), py(i), r * 2.6, 0, Math.PI * 2)
    ctx.fill()

    ctx.fillStyle = paletteColor(palette, t, tip ? 0.85 : 0.5)
    ctx.beginPath()
    ctx.arc(px(i), py(i), r, 0, Math.PI * 2)
    ctx.fill()
  }

  ctx.globalCompositeOperation = 'source-over'
}
