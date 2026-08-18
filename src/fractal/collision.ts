/**
 * Collision between the two hands' flames.
 *
 * A flame has no particles to collide: the chaos game iterates one point
 * through random transforms and the image comes from hit density, so there is
 * nothing with a trajectory to bounce. Collision therefore has to be *staged*
 * — expressed through how each hand's transforms respond to the other's
 * presence, so the forms behave as if they had substance.
 *
 * Three effects, which together read as contact:
 *   1. repulsion — each cluster's anchor is pushed away from the other, so the
 *      forms visibly refuse to occupy the same space
 *   2. compression — the squeezed axis flattens, so the shapes deform against
 *      each other rather than passing through
 *   3. impact — the moment of closest approach flares, so contact is an event
 */

/** Distance in flame space at which the forms begin to interact. */
const CONTACT_RANGE = 1.6

/** How hard the anchors push apart at full overlap, in flame-space units. */
const REPULSION = 0.55

export interface Contact {
  /** 0..1 how deeply the two forms interpenetrate. */
  depth: number
  /** Unit vector from hand A to hand B. */
  nx: number
  ny: number
  /** Midpoint of the contact, flame space. */
  mx: number
  my: number
  /** 0..1 impact flare, spiking when the forms are driven together fast. */
  impact: number
}

/** No two hands, no contact — a stable zero so callers need no special case. */
export const NO_CONTACT: Contact = { depth: 0, nx: 1, ny: 0, mx: 0, my: 0, impact: 0 }

/**
 * Tracks the closing speed between hands so a collision can flare on impact
 * rather than merely on proximity. Stateful because closing speed is a
 * derivative — it needs the previous frame's gap.
 */
export class CollisionTracker {
  private lastGap = -1
  private flare = 0
  /**
   * Last well-defined contact normal.
   *
   * When the hands land exactly on top of each other the separation vector is
   * zero and its direction is undefined — precisely at maximum contact, where
   * the repulsion matters most. Reusing the last known direction keeps the
   * forms pushing apart along the axis they were closing on, instead of
   * collapsing into each other.
   */
  private lastNx = 1
  private lastNy = 0

  reset() {
    this.lastGap = -1
    this.flare = 0
    this.lastNx = 1
    this.lastNy = 0
  }

  /**
   * @param ax,ay,bx,by hand positions in flame space
   * @param dt seconds since the previous frame
   */
  update(ax: number, ay: number, bx: number, by: number, dt: number): Contact {
    const dx = bx - ax
    const dy = by - ay
    const rawGap = Math.hypot(dx, dy)

    // Below this the direction is numerically meaningless, not merely small.
    const DEGENERATE = 1e-3
    let nx: number
    let ny: number
    if (rawGap > DEGENERATE) {
      nx = dx / rawGap
      ny = dy / rawGap
      this.lastNx = nx
      this.lastNy = ny
    } else {
      nx = this.lastNx
      ny = this.lastNy
    }

    const gap = Math.max(rawGap, DEGENERATE)

    // Overlap depth: 0 when far apart, 1 when the anchors coincide.
    const depth = Math.max(0, Math.min(1, 1 - gap / CONTACT_RANGE))

    // Closing speed, positive while the hands approach each other. Using the
    // gap's derivative rather than raw hand speed means two hands moving
    // together across the frame do not register as a collision.
    let closing = 0
    if (this.lastGap >= 0 && dt > 0) {
      closing = Math.max(0, (this.lastGap - gap) / dt)
    }
    this.lastGap = gap

    // Flare rises fast on a hard approach and rings out, so a clap reads as a
    // hit while a slow drift together does not.
    const target = Math.min(1, closing * 0.35) * depth
    if (target > this.flare) this.flare += (target - this.flare) * 0.6
    else this.flare *= Math.pow(0.12, dt)

    return {
      depth,
      nx,
      ny,
      mx: (ax + bx) * 0.5,
      my: (ay + by) * 0.5,
      impact: this.flare,
    }
  }
}

/**
 * Displace a hand's anchor away from the other hand.
 *
 * `sign` is +1 for the hand the normal points toward and -1 for the other.
 * The push grows with the square of depth so distant hands are untouched and
 * the resistance ramps up sharply as they close — the feel of pressing two
 * magnets together.
 */
export function repel(
  x: number,
  y: number,
  contact: Contact,
  sign: number,
): { x: number; y: number } {
  if (contact.depth <= 0) return { x, y }
  const push = contact.depth * contact.depth * REPULSION * sign
  return { x: x + contact.nx * push, y: y + contact.ny * push }
}
