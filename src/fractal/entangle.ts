import type { Tip } from './growth'

/**
 * Where growth from one hand meets growth from the other, draw a bridge.
 *
 * This is what makes two hands feel like one system rather than two unrelated
 * animations: the forms visibly acknowledge each other. Bridges are drawn, not
 * stored — they land on the same accumulation layer as the branches and decay
 * with everything else.
 */

/** Tips closer than this (px) are considered to have met. */
const LINK_DIST = 46

/**
 * Cap on bridges per frame. Pair-checking is the one genuinely quadratic thing
 * in the render loop, so both the work and the output are bounded.
 */
const MAX_LINKS = 90

/** Only every Nth tip is considered, to keep the pair scan cheap. */
const STRIDE = 3

export function drawEntanglement(
  ctx: CanvasRenderingContext2D,
  tips: Tip[],
  energy: number,
) {
  // Split by owner: we only bridge *across* hands, since linking a hand to
  // itself would just fill its own form with noise.
  const a: Tip[] = []
  const b: Tip[] = []
  for (let i = 0; i < tips.length; i += STRIDE) {
    const t = tips[i]
    if (t.owner === 0) a.push(t)
    else if (t.owner === 1) b.push(t)
  }
  if (a.length === 0 || b.length === 0) return

  ctx.lineCap = 'round'
  let links = 0

  for (const ta of a) {
    if (links >= MAX_LINKS) break
    for (const tb of b) {
      const dx = ta.x - tb.x
      const dy = ta.y - tb.y
      const distSq = dx * dx + dy * dy
      if (distSq > LINK_DIST * LINK_DIST) continue

      const dist = Math.sqrt(distSq)
      // Closer meetings glow harder, so contact reads as an event.
      const closeness = 1 - dist / LINK_DIST
      const alpha = closeness * closeness * (0.35 + energy * 0.4)

      // Bridge hue sits between the two lineages — the colour of the meeting
      // itself, not of either hand.
      const hue = (ta.hue + tb.hue) / 2

      ctx.strokeStyle = `hsla(${hue}, 95%, 78%, ${alpha})`
      ctx.lineWidth = 0.6 + closeness * 1.6
      ctx.beginPath()
      ctx.moveTo(ta.x, ta.y)
      ctx.lineTo(tb.x, tb.y)
      ctx.stroke()

      // A soft node at the midpoint gives the contact a physical centre.
      if (closeness > 0.55) {
        ctx.fillStyle = `hsla(${hue}, 98%, 85%, ${alpha * 0.7})`
        ctx.beginPath()
        ctx.arc((ta.x + tb.x) / 2, (ta.y + tb.y) / 2, 1.2 + closeness * 2.4, 0, Math.PI * 2)
        ctx.fill()
      }

      if (++links >= MAX_LINKS) break
    }
  }
}
