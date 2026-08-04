import type { HandState } from '../tracking/types'

/**
 * The vector field that growth tips flow through. Each hand contributes a
 * vortex; the field is the sum of all of them plus a slow ambient drift.
 *
 * Everything here works in pixel space, not normalized space, so the feel does
 * not change with window size.
 */

export interface Vortex {
  x: number
  y: number
  /** Signed angular strength — sign is spin direction, magnitude is pull. */
  strength: number
  /** Radius of meaningful influence, in pixels. */
  radius: number
  /** Positive draws tips inward, negative pushes them out. */
  radial: number
  hue: number
}

export interface Field {
  vortices: Vortex[]
  /** Ambient drift so the form keeps moving when hands are still. */
  time: number
}

/**
 * Build this frame's vortices from the tracked hands.
 *
 * Hand rotation sets spin direction, so turning the wrist reverses the swirl.
 * Openness sets radius: an open palm stirs a wide slow eddy, a fist becomes a
 * tight fast one. That keeps the two obvious gestures mapped to the two most
 * legible properties of a vortex.
 */
export function fieldFromHands(
  hands: HandState[],
  width: number,
  height: number,
  time: number,
): Field {
  const base = Math.min(width, height)

  const vortices = hands.map<Vortex>((hand) => {
    const spin = Math.sin(hand.rotation)
    const speed = Math.hypot(hand.velocity.x, hand.velocity.y)
    return {
      x: (1 - hand.center.x) * width, // mirrored to match the video
      y: hand.center.y * height,
      // Fast movement stirs harder, which makes swiping feel physical.
      strength: spin * (0.6 + speed * 1.6) * (1.4 - hand.openness * 0.6),
      radius: base * (0.18 + hand.openness * 0.30),
      // An open hand gently gathers, a fist repels — so you can push the form
      // away or cup it toward you.
      radial: hand.openness * 0.5 - 0.25,
      hue: hand.handedness === 'Left' ? 195 : 310,
    }
  })

  return { vortices, time }
}

/**
 * Sample the field at a point, writing the result into `out` to avoid
 * allocating a vector per tip per frame (this runs tens of thousands of times
 * a second, and the garbage would show up as GC stutter).
 */
export function sampleField(field: Field, x: number, y: number, out: { x: number; y: number }) {
  // Ambient curl: two offset sines make a cheap, non-repeating drift that
  // keeps the field alive when no hand is moving.
  const t = field.time * 0.12
  out.x = Math.sin(y * 0.004 + t) * 0.35 + Math.sin(y * 0.011 - t * 1.7) * 0.12
  out.y = Math.cos(x * 0.004 - t) * 0.35 + Math.cos(x * 0.013 + t * 1.3) * 0.12

  for (const v of field.vortices) {
    const dx = x - v.x
    const dy = y - v.y
    const distSq = dx * dx + dy * dy
    const r = v.radius
    if (distSq > r * r) continue

    const dist = Math.sqrt(distSq) || 1e-3
    // Falloff is smooth at the rim and capped at the core: without the cap the
    // 1/r term explodes and tips near the palm shoot off at absurd speeds.
    const falloff = 1 - dist / r
    const weight = (falloff * falloff) / Math.max(dist, r * 0.12)

    const nx = dx / dist
    const ny = dy / dist

    // Perpendicular component = rotation, radial component = pull/push.
    out.x += (-ny * v.strength + nx * v.radial) * weight * r * 0.5
    out.y += (nx * v.strength + ny * v.radial) * weight * r * 0.5
  }
}

/** Hue at a point, blended by vortex proximity — colour follows the field. */
export function sampleHue(field: Field, x: number, y: number, fallback: number): number {
  let bestWeight = 0
  let hue = fallback
  for (const v of field.vortices) {
    const dist = Math.hypot(x - v.x, y - v.y)
    if (dist > v.radius) continue
    const w = 1 - dist / v.radius
    if (w > bestWeight) {
      bestWeight = w
      hue = v.hue
    }
  }
  // Blend toward the vortex hue rather than snapping, so boundaries are soft.
  return fallback + shortestHueDelta(fallback, hue) * bestWeight
}

function shortestHueDelta(from: number, to: number): number {
  const d = ((to - from + 180) % 360) - 180
  return d < -180 ? d + 360 : d
}
