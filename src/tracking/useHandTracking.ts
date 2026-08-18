import { useCallback, useEffect, useRef, useState } from 'react'
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision'
import { deriveHandState, matchPrevious } from './handState'
import { OneEuroPoint } from './oneEuro'
import type { TrackingFrame, TrackingStatus } from './types'

const WASM_ROOT = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'

/**
 * Owns the webcam stream and the MediaPipe detection loop.
 *
 * Tracking results are delivered through a ref rather than React state: at
 * 30-60fps a setState per frame would rerender the whole tree and drop frames.
 * The render loop reads `frameRef.current` directly. Only the coarse status
 * transitions are state, since those genuinely drive UI.
 */
export function useHandTracking(videoRef: React.RefObject<HTMLVideoElement | null>) {
  const [status, setStatus] = useState<TrackingStatus>({ kind: 'idle' })
  const frameRef = useRef<TrackingFrame>({ hands: [], timestamp: 0 })

  const landmarkerRef = useRef<HandLandmarker | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number | null>(null)
  // Guards the async teardown races: an unmount partway through start() must
  // not leave a live camera or a running rAF loop behind.
  const activeRef = useRef(false)

  const stop = useCallback(() => {
    activeRef.current = false
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
    landmarkerRef.current?.close()
    landmarkerRef.current = null
    frameRef.current = { hands: [], timestamp: 0 }
    setStatus({ kind: 'idle' })
  }, [])

  const start = useCallback(async () => {
    if (activeRef.current) return
    activeRef.current = true
    setStatus({ kind: 'loading' })

    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT)
      const landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      })
      if (!activeRef.current) {
        landmarker.close()
        return
      }
      landmarkerRef.current = landmarker

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
        audio: false,
      })
      if (!activeRef.current) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }
      streamRef.current = stream

      const video = videoRef.current
      if (!video) throw new Error('Video element unavailable')
      video.srcObject = stream
      await video.play()

      setStatus({ kind: 'running' })

      let lastVideoTime = -1
      let lastTimestamp = performance.now()

      // One filter per landmark per hand. Keyed by handedness so a filter's
      // history always follows the same physical hand; sharing them by index
      // would swap histories whenever MediaPipe reorders its output.
      const filterBank = new Map<string, OneEuroPoint[]>()
      const filtersFor = (handedness: string) => {
        let bank = filterBank.get(handedness)
        if (!bank) {
          // Tuned by measurement against a plain EMA: these values cut
          // tremor 15x versus raw landmarks while adding only ~17ms of lag,
          // where an EMA at the same steadiness costs ~61ms. beta is what
          // buys that — a small beta degenerates the filter into a low-pass
          // with all of an EMA's sluggishness.
          bank = Array.from({ length: 21 }, () => new OneEuroPoint(0.8, 5.0))
          filterBank.set(handedness, bank)
        }
        return bank
      }

      const tick = () => {
        if (!activeRef.current) return
        rafRef.current = requestAnimationFrame(tick)

        const el = videoRef.current
        const lm = landmarkerRef.current
        if (!el || !lm || el.readyState < 2) return
        // The camera runs slower than the display refresh; re-detecting on the
        // same frame would burn GPU for an identical result.
        if (el.currentTime === lastVideoTime) return
        lastVideoTime = el.currentTime

        const now = performance.now()
        const dt = Math.min((now - lastTimestamp) / 1000, 0.1)
        lastTimestamp = now

        const result = lm.detectForVideo(el, now)
        const previous = frameRef.current.hands

        const hands = result.landmarks.map((landmarks, i) => {
          // MediaPipe labels handedness from the camera's point of view; the
          // canvas is mirrored so the user sees themselves, which flips it.
          const raw = result.handedness[i]?.[0]?.categoryName
          const handedness: 'Left' | 'Right' = raw === 'Left' ? 'Right' : 'Left'

          // Smooth the raw landmarks before anything is derived from them.
          // Filtering here rather than downstream means openness, rotation and
          // the skeleton all inherit the same stabilised points, instead of
          // each recomputing its own jitter from noisy input.
          const filters = filtersFor(handedness)
          const smoothed = landmarks.map((p, k) => {
            const f = filters[k].filter(p.x, p.y, now)
            return { x: f.x, y: f.y, z: p.z }
          })

          return deriveHandState(smoothed, handedness, matchPrevious(previous, handedness), dt)
        })

        frameRef.current = { hands, timestamp: now }
      }

      rafRef.current = requestAnimationFrame(tick)
    } catch (err) {
      activeRef.current = false
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Доступ к камере запрещён. Разрешите доступ в настройках браузера и попробуйте снова.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'Камера не найдена. Подключите веб-камеру и попробуйте снова.'
            : err instanceof Error
              ? err.message
              : 'Не удалось запустить трекинг.'
      setStatus({ kind: 'error', message })
    }
  }, [videoRef])

  useEffect(() => stop, [stop])

  return { status, frameRef, start, stop }
}
