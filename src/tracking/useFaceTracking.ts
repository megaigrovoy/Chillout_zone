import { useCallback, useEffect, useRef } from 'react'
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { OneEuroPoint } from './oneEuro'
import type { Point2 } from './types'

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

/**
 * A tracked face, reduced to what the overlay needs.
 *
 * The model returns 478 landmarks; the visuals only ever draw the contour sets
 * and need a couple of derived scalars, so the raw points are exposed as-is
 * and everything else is computed once here.
 */
export interface FaceState {
  /** All landmarks, smoothed, in normalized video coords. */
  landmarks: Point2[]
  /** Centre of the face, for placing effects. */
  center: Point2
  /** Apparent face size (eye-to-eye distance), a proximity proxy. */
  scale: number
  ready: boolean
}

export interface FaceFrame {
  face: FaceState | null
  timestamp: number
}

/** Landmark indices for the outer eye corners, used to size the face. */
const LEFT_EYE_OUTER = 33
const RIGHT_EYE_OUTER = 263

/**
 * Face tracking, run as a task separate from the hands.
 *
 * Deliberately throttled below the render rate: the face model is heavier than
 * the hand one and a face moves far less than a gesturing hand, so detecting
 * every frame would spend GPU time for no visible gain.
 */
export function useFaceTracking(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const faceRef = useRef<FaceFrame>({ face: null, timestamp: 0 })

  const landmarkerRef = useRef<FaceLandmarker | null>(null)
  const rafRef = useRef<number | null>(null)
  const activeRef = useRef(false)
  const filtersRef = useRef<OneEuroPoint[]>([])

  const stop = useCallback(() => {
    activeRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    landmarkerRef.current?.close()
    landmarkerRef.current = null
    filtersRef.current = []
    faceRef.current = { face: null, timestamp: 0 }
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return
    activeRef.current = true

    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT)
      const landmarker = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        // Blendshapes and matrices are extra work per frame and nothing here
        // consumes them.
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      })
      if (!activeRef.current) {
        landmarker.close()
        return
      }
      landmarkerRef.current = landmarker

      let lastVideoTime = -1
      let lastRun = 0
      const INTERVAL = 1000 / 24

      const tick = () => {
        if (!activeRef.current) return
        rafRef.current = requestAnimationFrame(tick)

        const el = videoRef.current
        const lm = landmarkerRef.current
        if (!el || !lm || el.readyState < 2) return

        const now = performance.now()
        if (now - lastRun < INTERVAL) return
        if (el.currentTime === lastVideoTime) return
        lastVideoTime = el.currentTime
        lastRun = now

        const result = lm.detectForVideo(el, now)
        const raw = result.faceLandmarks?.[0]
        if (!raw || raw.length === 0) {
          faceRef.current = { face: null, timestamp: now }
          return
        }

        // Lazily size the filter bank: the landmark count is fixed per model
        // but stating it here would duplicate a number the model owns.
        if (filtersRef.current.length !== raw.length) {
          filtersRef.current = Array.from(
            { length: raw.length },
            () => new OneEuroPoint(0.8, 5.0),
          )
        }
        const filters = filtersRef.current

        const landmarks: Point2[] = new Array(raw.length)
        let sx = 0
        let sy = 0
        for (let i = 0; i < raw.length; i++) {
          const p = filters[i].filter(raw[i].x, raw[i].y, now)
          landmarks[i] = p
          sx += p.x
          sy += p.y
        }

        const a = landmarks[LEFT_EYE_OUTER]
        const b = landmarks[RIGHT_EYE_OUTER]
        const scale = a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0.1

        faceRef.current = {
          face: {
            landmarks,
            center: { x: sx / raw.length, y: sy / raw.length },
            scale,
            ready: true,
          },
          timestamp: now,
        }
      }

      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      // The face overlay is decorative; if the model cannot load the rest of
      // the app must keep working. Logged rather than swallowed, so a failure
      // is not mistaken for the feature being absent.
      console.warn('[chillout] face tracking unavailable:', err)
      activeRef.current = false
    }
  }, [videoRef])

  useEffect(() => stop, [stop])

  return { faceRef, start, stop }
}
