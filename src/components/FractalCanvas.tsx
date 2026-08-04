import { useEffect, useRef } from 'react'
import { renderFrame } from '../fractal/render'
import { DEFAULT_PARAMS, easeParams, paramsFromFrame } from '../fractal/params'
import type { FractalParams } from '../fractal/params'
import type { TrackingFrame } from '../tracking/types'

interface Props {
  frameRef: React.RefObject<TrackingFrame>
  /** Reports eased params upward for the debug readout, throttled to ~5Hz. */
  onParams?: (params: FractalParams) => void
}

/**
 * The render loop. Deliberately isolated from React's update cycle: it reads
 * tracking through a ref and never sets state per frame, so the component
 * mounts once and then runs entirely on rAF.
 */
export function FractalCanvas({ frameRef, onParams }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const paramsRef = useRef<FractalParams>(DEFAULT_PARAMS)
  const onParamsRef = useRef(onParams)
  onParamsRef.current = onParams

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let raf = 0
    let last = performance.now()
    let lastReport = 0

    // Cap the backing store at 2x: on a 4K display a full-DPR canvas doing
    // additive blending over ~20k segments will not hold 60fps.
    const dpr = Math.min(window.devicePixelRatio || 1, 2)

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = canvas
      canvas.width = Math.max(1, Math.floor(w * dpr))
      canvas.height = Math.max(1, Math.floor(h * dpr))
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Repaint the backdrop; a resized canvas comes back transparent.
      ctx.fillStyle = '#06080f'
      ctx.fillRect(0, 0, w, h)
    }
    resize()

    const observer = new ResizeObserver(resize)
    observer.observe(canvas)

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, 0.1)
      last = now

      const frame = frameRef.current ?? { hands: [], timestamp: 0 }
      const target = paramsFromFrame(frame)
      paramsRef.current = easeParams(paramsRef.current, target, dt)

      renderFrame(
        ctx,
        canvas.width / dpr,
        canvas.height / dpr,
        paramsRef.current,
        frame.hands,
      )

      if (onParamsRef.current && now - lastReport > 200) {
        lastReport = now
        onParamsRef.current(paramsRef.current)
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [frameRef])

  return <canvas ref={canvasRef} className="fractal-canvas" />
}
