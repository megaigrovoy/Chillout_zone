import type { HandState, Point2 } from './types'

/** MediaPipe hand landmark indices we care about. */
const WRIST = 0
const MIDDLE_MCP = 9
const TIPS = [4, 8, 12, 16, 20]
/** Knuckles used to locate the palm centre alongside the wrist. */
const PALM = [0, 5, 9, 13, 17]

/**
 * Fingertip spread (as a fraction of hand size) at a closed fist and at a full
 * splay. Measured empirically from the model; used to rescale raw openness
 * into a usable 0..1 range instead of the ~0.35..0.75 band it actually spans.
 */
const OPENNESS_MIN = 0.38
const OPENNESS_MAX = 0.78

export interface Landmark {
  x: number
  y: number
  z: number
}

const dist = (a: Point2, b: Point2) => Math.hypot(a.x - b.x, a.y - b.y)

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Reduce one hand's 21 landmarks to the signal the visuals consume. */
export function deriveHandState(
  landmarks: Landmark[],
  handedness: 'Left' | 'Right',
  previous: HandState | undefined,
  dtSeconds: number,
): HandState {
  const center = PALM.reduce(
    (acc, i) => ({ x: acc.x + landmarks[i].x / PALM.length, y: acc.y + landmarks[i].y / PALM.length }),
    { x: 0, y: 0 },
  )

  const wrist = landmarks[WRIST]
  const middle = landmarks[MIDDLE_MCP]
  // Hand size normalizes everything else, so it must never be zero — a
  // degenerate frame would otherwise produce Infinity openness downstream.
  const scale = Math.max(dist(wrist, middle), 1e-4)

  // Fingertips are used only to measure how open the hand is; they are no
  // longer exposed, since the visuals emit from the palm alone and per-finger
  // tracking noise would only jitter the figure.
  const spread =
    TIPS.reduce((sum, i) => sum + dist(landmarks[i], center), 0) / TIPS.length / scale
  const openness = clamp01((spread - OPENNESS_MIN) / (OPENNESS_MAX - OPENNESS_MIN))

  const rotation = Math.atan2(middle.y - wrist.y, middle.x - wrist.x)

  // Velocity is noisy frame to frame; an EMA keeps it usable for the
  // motion-reactive parameters without introducing visible lag.
  let velocity: Point2 = { x: 0, y: 0 }
  if (previous && dtSeconds > 0) {
    const raw = {
      x: (center.x - previous.center.x) / dtSeconds,
      y: (center.y - previous.center.y) / dtSeconds,
    }
    const a = 0.35
    velocity = {
      x: previous.velocity.x * (1 - a) + raw.x * a,
      y: previous.velocity.y * (1 - a) + raw.y * a,
    }
  }

  return { handedness, center, openness, rotation, scale, velocity }
}

/**
 * Match this frame's hands to last frame's by handedness so velocity and
 * smoothing follow the same physical hand across frames. MediaPipe does not
 * guarantee a stable ordering when two hands are visible.
 */
export function matchPrevious(
  previous: HandState[],
  handedness: 'Left' | 'Right',
): HandState | undefined {
  return previous.find((h) => h.handedness === handedness)
}
