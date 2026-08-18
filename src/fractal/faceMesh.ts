import { FaceLandmarker } from '@mediapipe/tasks-vision'
import type { FaceState } from '../tracking/useFaceTracking'

/**
 * Glowing face overlay, drawn in the same visual language as the hand
 * skeleton: colour sampled from the flame's live palette, a wide soft pass for
 * glow and a thin bright pass for the line.
 *
 * The connection sets come from FaceLandmarker rather than being written out
 * by hand — the model owns which of its 478 landmarks form the eyes, brows and
 * lips, and transcribing those indices would be both huge and fragile.
 */

/**
 * Feature groups, ordered back to front. Each carries its own palette offset so
 * the features read as distinct rather than as one uniform web, and its own
 * weight so the eyes and lips stand out against the outline.
 */
const GROUPS: Array<{ connections: typeof FaceLandmarker.FACE_LANDMARKS_LIPS; offset: number; weight: number }> = [
  { connections: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, offset: 0.0, weight: 1.0 },
  { connections: FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, offset: 0.18, weight: 0.85 },
  { connections: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, offset: 0.18, weight: 0.85 },
  { connections: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, offset: 0.34, weight: 1.1 },
  { connections: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, offset: 0.34, weight: 1.1 },
  { connections: FaceLandmarker.FACE_LANDMARKS_LIPS, offset: 0.52, weight: 1.0 },
  { connections: FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS, offset: 0.7, weight: 1.3 },
  { connections: FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS, offset: 0.7, weight: 1.3 },
]

/** Sample the flame palette as a CSS colour, matching the hand skeleton. */
function paletteColor(palette: Float32Array, t: number, alpha: number): string {
  const i = Math.max(0, Math.min(255, Math.round(((t % 1) + 1) % 1 * 255))) * 3
  // Lifted toward white: palette entries are tuned for additive accumulation
  // and read too dim as a single stroke.
  const r = Math.min(255, palette[i] * 1.5 + 40) | 0
  const g = Math.min(255, palette[i + 1] * 1.5 + 40) | 0
  const b = Math.min(255, palette[i + 2] * 1.5 + 40) | 0
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function drawFaceMesh(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  face: FaceState,
  palette: Float32Array,
  time: number,
  energy: number,
) {
  const pts = face.landmarks
  if (!pts || pts.length === 0) return

  ctx.globalCompositeOperation = 'lighter'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'

  // Drifts with the same rate as the hand skeleton so the whole overlay family
  // shimmers together rather than each part cycling on its own clock.
  const phase = time * 0.12 + 0.25

  for (let pass = 0; pass < 2; pass++) {
    const glow = pass === 0

    for (const group of GROUPS) {
      const hue = phase + group.offset
      ctx.strokeStyle = paletteColor(
        palette,
        hue,
        glow ? (0.05 + energy * 0.04) * group.weight : (0.42 + energy * 0.28) * group.weight,
      )
      ctx.lineWidth = glow ? 7 + energy * 4 : 1.4 * group.weight

      // One path per group rather than per connection: stroke() is the
      // expensive call, and the face has several hundred segments.
      ctx.beginPath()
      for (const c of group.connections) {
        const a = pts[c.start]
        const b = pts[c.end]
        if (!a || !b) continue
        // Mirrored to match the video the player sees.
        ctx.moveTo((1 - a.x) * width, a.y * height)
        ctx.lineTo((1 - b.x) * width, b.y * height)
      }
      ctx.stroke()
    }
  }

  ctx.globalCompositeOperation = 'source-over'
}
