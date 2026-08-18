import { ParticleSystem, RADIUS } from './physics'
import type { HandState } from '../tracking/types'

/**
 * Collision mode renderer.
 *
 * Each hand emits a stream of particles that carry its colour. The two streams
 * genuinely collide — momentum is exchanged, particles rebound — so the forms
 * push against each other as physical matter rather than through the staged
 * interaction the flame mode uses.
 *
 * Trails come from fading the canvas rather than clearing it, matching the
 * flame mode's look and costing one fillRect instead of a per-particle history.
 */

/** Colour coordinates for the two hands, kept in the app's cool palette. */
const LEFT_HUE = 195
const RIGHT_HUE = 300

export class ParticleRenderer {
  private sys = new ParticleSystem()
  private emitCooldown: number[] = []
  private impactGlow = 0

  constructor(private width: number, private height: number) {}

  resize(width: number, height: number) {
    this.width = width
    this.height = height
  }

  reset() {
    this.sys.clear()
    this.emitCooldown.length = 0
    this.impactGlow = 0
  }

  get particleCount() {
    return this.sys.count
  }

  render(ctx: CanvasRenderingContext2D, hands: HandState[], dt: number) {
    const { width, height } = this

    this.emit(hands, dt)
    this.applyHandForces(hands, dt)
    this.sys.integrate(dt, width, height)

    const impulse = this.sys.collide(width, height, dt)
    // Normalise by count so the global flash reflects collision *intensity*
    // rather than merely how many particles are on screen.
    const perParticle = this.sys.count > 0 ? impulse / this.sys.count : 0
    const target = Math.min(1, perParticle * 0.02)
    if (target > this.impactGlow) this.impactGlow += (target - this.impactGlow) * 0.5
    else this.impactGlow *= Math.pow(0.06, dt)

    this.draw(ctx)
  }

  /**
   * Spawn particles at each palm.
   *
   * Emission rate follows openness, so an open hand pours out matter and a
   * fist barely trickles — the same gesture mapping as the flame mode, so the
   * two modes feel related.
   */
  private emit(hands: HandState[], dt: number) {
    hands.forEach((hand, index) => {
      this.emitCooldown[index] = (this.emitCooldown[index] ?? 0) - dt
      if (this.emitCooldown[index] > 0) return
      this.emitCooldown[index] = 0.010 - hand.openness * 0.007

      const cx = (1 - hand.center.x) * this.width
      const cy = hand.center.y * this.height
      const hue = hand.handedness === 'Left' ? LEFT_HUE : RIGHT_HUE

      // Inherit the hand's own velocity so a throwing motion actually throws
      // the particles, which is what makes flinging one stream into the other
      // feel physical.
      const hvx = -hand.velocity.x * this.width * 0.6
      const hvy = hand.velocity.y * this.height * 0.6

      // More droplets per burst, launched slower: a viscous fluid oozes out
      // and stays together rather than spraying.
      const burst = 6
      for (let k = 0; k < burst; k++) {
        const a = Math.random() * Math.PI * 2
        const speed = 25 + Math.random() * 80 + hand.openness * 60
        // Emitted from a tight ring so the droplets start already in contact
        // and cohere immediately instead of having to find each other.
        const r = 6 + Math.random() * 8
        this.sys.spawn(
          cx + Math.cos(a) * r,
          cy + Math.sin(a) * r,
          Math.cos(a) * speed + hvx,
          Math.sin(a) * speed + hvy,
          hue,
          3.4 + Math.random() * 2.6,
        )
      }
    })
  }

  /**
   * Hands act as force fields on existing particles.
   *
   * An open palm attracts, a fist repels — so you can gather a cloud and then
   * punch it into the other hand's cloud. Without this the hands could only
   * emit, and the two streams would never be aimed at each other deliberately.
   */
  private applyHandForces(hands: HandState[], dt: number) {
    if (hands.length === 0) return
    const base = Math.min(this.width, this.height)
    const reach = base * 0.42
    const reachSq = reach * reach

    for (const hand of hands) {
      const hx = (1 - hand.center.x) * this.width
      const hy = hand.center.y * this.height
      // Open hand pulls inward, closed hand pushes away.
      const sign = hand.openness > 0.5 ? 1 : -1
      const strength = base * (2.2 + Math.abs(hand.openness - 0.5) * 6) * sign

      for (let i = 0; i < this.sys.count; i++) {
        const dx = hx - this.sys.x[i]
        const dy = hy - this.sys.y[i]
        const dSq = dx * dx + dy * dy
        if (dSq > reachSq || dSq < 1) continue

        const d = Math.sqrt(dSq)
        // Falloff capped near the palm: an uncapped 1/r would fling particles
        // at absurd speeds the moment they touched the hand.
        const falloff = (1 - d / reach) / Math.max(d, reach * 0.15)
        const f = strength * falloff * dt
        this.sys.vx[i] += (dx / d) * f
        this.sys.vy[i] += (dy / d) * f
      }
    }
  }

  private draw(ctx: CanvasRenderingContext2D) {
    const { width, height } = this

    // Fade rather than clear, which leaves motion trails.
    ctx.globalCompositeOperation = 'source-over'
    ctx.fillStyle = `rgba(4, 12, 30, ${0.18 - this.impactGlow * 0.06})`
    ctx.fillRect(0, 0, width, height)

    ctx.globalCompositeOperation = 'lighter'

    const { x, y, hue, flash, life, count } = this.sys
    for (let i = 0; i < count; i++) {
      // Fade in over the first moments and out at the end of life, so
      // particles do not pop in and out.
      const age = Math.min(1, life[i] * 0.8)
      const f = flash[i]

      // A collision drives the particle toward white, so impacts read as
      // sparks against the coloured streams.
      const l = 55 + f * 40
      const s = 95 - f * 55
      // Lower per-droplet alpha, since there are far more of them and they
      // overlap: additive blending would otherwise blow the body out to white.
      const a = (0.13 + f * 0.5) * age

      // Drawn wider than the physical radius so neighbouring droplets overlap
      // into a continuous body. At the physical size these would read as grains
      // of sand rather than as a fluid.
      ctx.fillStyle = `hsla(${hue[i]}, ${s}%, ${l}%, ${a})`
      ctx.beginPath()
      ctx.arc(x[i], y[i], RADIUS * 2.3 * (1 + f * 1.2), 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.globalCompositeOperation = 'source-over'
  }
}
