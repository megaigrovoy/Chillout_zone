/** Normalized 2D point in video space: x/y are 0..1, origin top-left. */
export interface Point2 {
  x: number
  y: number
}

/**
 * The distilled per-hand signal the visuals actually consume. MediaPipe gives
 * us 21 raw landmarks per hand; almost none of the render code wants to think
 * in landmark indices, so we reduce them here once per frame.
 */
export interface HandState {
  /** "Left" / "Right" as reported by MediaPipe (already mirror-corrected). */
  handedness: 'Left' | 'Right'
  /** Palm centre, normalized video coords. */
  center: Point2
  /**
   * All 21 MediaPipe landmarks, smoothed. Needed to draw the hand skeleton;
   * the visuals themselves still only consume the reduced signals below.
   */
  landmarks: Point2[]
  /**
   * 0 = fist, 1 = fully splayed. Derived from mean fingertip distance to the
   * palm centre, normalized by hand size so it survives moving toward/away
   * from the camera.
   */
  openness: number
  /** Palm rotation in radians, measured wrist -> middle-finger MCP. */
  rotation: number
  /** Apparent hand size (wrist -> middle MCP), a rough proximity proxy. */
  scale: number
  /** Palm centre velocity in normalized units/second, EMA-smoothed. */
  velocity: Point2
}

export interface TrackingFrame {
  hands: HandState[]
  /** performance.now() timestamp of the video frame this came from. */
  timestamp: number
}

export type TrackingStatus =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'running' }
  | { kind: 'error'; message: string }
