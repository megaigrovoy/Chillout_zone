import { useEffect, useImperativeHandle, useRef } from 'react'
import { ParticleRenderer } from '../particles/render'
import type { TrackingFrame } from '../tracking/types'

export interface ParticleHandle {
  reset(): void
}

interface Props {
  frameRef: React.RefObject<TrackingFrame>
  handleRef?: React.Ref<ParticleHandle>
  /** Reports the live particle count for the debug HUD, throttled to ~5Hz. */
  onStats?: (particles: number) => void
}

/**
 * Render loop for collision mode.
 *
 * Mirrors FractalCanvas: tracking is read from a ref and no state is set per
 * frame, so the component mounts once and then runs entirely on rAF.
 */
export function ParticleCanvas({ frameRef, handleRef, onStats }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<ParticleRenderer | null>(null)
  const onStatsRef = useRef(onStats)
  onStatsRef.current = onStats

  useImperativeHandle(handleRef, () => ({ reset: () => rendererRef.current?.reset() }), [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) return

    let raf = 0
    let last = performance.now()
    let lastReport = 0

    // Particles are drawn as canvas arcs, whose cost scales with device
    // pixels; capping at 1.5x keeps a retina display from doubling the fill
    // work for a difference nobody can see on soft glowing dots.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)

    const applySize = () => {
      const w = Math.max(1, Math.floor(canvas.clientWidth))
      const h = Math.max(1, Math.floor(canvas.clientHeight))
      canvas.width = Math.floor(w * dpr)
      canvas.height = Math.floor(h * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      return { w, h }
    }

    const initial = applySize()
    const renderer = new ParticleRenderer(initial.w, initial.h)
    rendererRef.current = renderer

    // Paint the background once so the first frames fade from black rather
    // than from a transparent canvas.
    ctx.fillStyle = '#040c1e'
    ctx.fillRect(0, 0, initial.w, initial.h)

    const observer = new ResizeObserver(() => {
      const { w, h } = applySize()
      renderer.resize(w, h)
      ctx.fillStyle = '#040c1e'
      ctx.fillRect(0, 0, w, h)
    })
    observer.observe(canvas)

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      // Clamped so a backgrounded tab does not resume with one huge step that
      // would tunnel every particle straight through its neighbours.
      const dt = Math.min((now - last) / 1000, 0.033)
      last = now

      const frame = frameRef.current ?? { hands: [], timestamp: 0 }
      renderer.render(ctx, frame.hands, dt)

      if (onStatsRef.current && now - lastReport > 200) {
        lastReport = now
        onStatsRef.current(renderer.particleCount)
      }
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
      rendererRef.current = null
    }
  }, [frameRef])

  return <canvas ref={canvasRef} className="fractal-canvas" />
}
