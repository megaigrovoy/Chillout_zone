/**
 * Particle system with real collisions.
 *
 * The flame renderer cannot collide anything: the chaos game iterates a single
 * point through random transforms and the image is a density map, so there are
 * no objects with trajectories to bounce. This mode swaps that for actual
 * bodies — position, velocity, mass — so collisions are computed rather than
 * staged.
 *
 * Everything is stored in flat typed arrays rather than objects. At a few
 * thousand particles resolved 60 times a second, per-particle objects would
 * generate enough garbage to show up as GC stutter.
 */

export const MAX_PARTICLES = 2600

/**
 * Uniform particle radius, px. Uniform because it makes the broad-phase grid
 * cell size trivially correct: no particle can span more than two cells.
 */
export const RADIUS = 3.2

/** Restitution: 1 = perfectly elastic, 0 = fully inelastic. */
const RESTITUTION = 0.82

/**
 * Velocity damping per second.
 *
 * Kept mild: at 0.55 a dense pack settled to 1px/s within ten seconds, so the
 * particles went inert the moment the hands stopped pushing and collisions
 * stopped happening. This retains most of the motion while still preventing
 * the population from accumulating energy indefinitely.
 */
const DRAG = 0.90

export class ParticleSystem {
  x = new Float32Array(MAX_PARTICLES)
  y = new Float32Array(MAX_PARTICLES)
  vx = new Float32Array(MAX_PARTICLES)
  vy = new Float32Array(MAX_PARTICLES)
  /** Palette coordinate, 0..1 — which hand spawned it. */
  hue = new Float32Array(MAX_PARTICLES)
  /** Seconds remaining before the particle is recycled. */
  life = new Float32Array(MAX_PARTICLES)
  /** Collision flash, 0..1, set on impact and decayed each frame. */
  flash = new Float32Array(MAX_PARTICLES)

  count = 0

  /**
   * Spatial hash for broad-phase collision detection.
   *
   * Testing every pair is O(n^2) — at 2600 particles that is 3.4M tests per
   * frame, far past the budget. The grid reduces it to each particle against
   * only those in the neighbouring cells.
   */
  private cellSize = RADIUS * 2
  private cols = 0
  private rows = 0
  private cellStart: Int32Array = new Int32Array(0)
  private cellItems: Int32Array = new Int32Array(MAX_PARTICLES)
  private cellCount: Int32Array = new Int32Array(0)

  clear() {
    this.count = 0
  }

  spawn(x: number, y: number, vx: number, vy: number, hue: number, life: number) {
    if (this.count >= MAX_PARTICLES) return
    const i = this.count++
    this.x[i] = x
    this.y[i] = y
    this.vx[i] = vx
    this.vy[i] = vy
    this.hue[i] = hue
    this.life[i] = life
    this.flash[i] = 0
  }

  /**
   * Remove a particle by swapping the last one into its slot — O(1), and order
   * carries no meaning here.
   */
  private kill(i: number) {
    const last = --this.count
    if (i !== last) {
      this.x[i] = this.x[last]
      this.y[i] = this.y[last]
      this.vx[i] = this.vx[last]
      this.vy[i] = this.vy[last]
      this.hue[i] = this.hue[last]
      this.life[i] = this.life[last]
      this.flash[i] = this.flash[last]
    }
  }

  /** Integrate motion, age particles, and bounce them off the walls. */
  integrate(dt: number, width: number, height: number) {
    const damp = Math.pow(DRAG, dt)
    for (let i = 0; i < this.count; i++) {
      this.life[i] -= dt
      if (this.life[i] <= 0) {
        this.kill(i)
        i--
        continue
      }

      this.vx[i] *= damp
      this.vy[i] *= damp
      this.x[i] += this.vx[i] * dt
      this.y[i] += this.vy[i] * dt
      this.flash[i] *= Math.pow(0.04, dt)

      // Walls, so particles stay on screen and keep colliding rather than
      // drifting away and thinning the population out.
      if (this.x[i] < RADIUS) {
        this.x[i] = RADIUS
        this.vx[i] = Math.abs(this.vx[i]) * RESTITUTION
      } else if (this.x[i] > width - RADIUS) {
        this.x[i] = width - RADIUS
        this.vx[i] = -Math.abs(this.vx[i]) * RESTITUTION
      }
      if (this.y[i] < RADIUS) {
        this.y[i] = RADIUS
        this.vy[i] = Math.abs(this.vy[i]) * RESTITUTION
      } else if (this.y[i] > height - RADIUS) {
        this.y[i] = height - RADIUS
        this.vy[i] = -Math.abs(this.vy[i]) * RESTITUTION
      }
    }
  }

  /**
   * Resolve particle-particle collisions.
   *
   * Equal masses, so an elastic impact reduces to exchanging the velocity
   * components along the contact normal. Overlap is also corrected
   * positionally: without that, particles sink into each other and the whole
   * population collapses into a clump under sustained pressure.
   *
   * @returns total impulse exchanged, used to drive the visual impact flash.
   */
  collide(width: number, height: number): number {
    if (this.count < 2) return 0

    this.rebuildGrid(width, height)

    let totalImpulse = 0
    const minDist = RADIUS * 2
    const minDistSq = minDist * minDist

    for (let i = 0; i < this.count; i++) {
      const cx = (this.x[i] / this.cellSize) | 0
      const cy = (this.y[i] / this.cellSize) | 0

      // Only the 3x3 neighbourhood can hold a particle within contact range,
      // given the cell size equals the collision diameter.
      for (let ny = cy - 1; ny <= cy + 1; ny++) {
        if (ny < 0 || ny >= this.rows) continue
        for (let nx = cx - 1; nx <= cx + 1; nx++) {
          if (nx < 0 || nx >= this.cols) continue

          const cell = ny * this.cols + nx
          const start = this.cellStart[cell]
          const end = start + this.cellCount[cell]

          for (let k = start; k < end; k++) {
            const j = this.cellItems[k]
            // Each pair once: skip j <= i rather than testing twice.
            if (j <= i) continue

            const dx = this.x[j] - this.x[i]
            const dy = this.y[j] - this.y[i]
            const distSq = dx * dx + dy * dy
            if (distSq >= minDistSq || distSq === 0) continue

            const dist = Math.sqrt(distSq)
            const nxn = dx / dist
            const nyn = dy / dist

            // Relative velocity along the normal; positive means separating,
            // and separating pairs must not be "resolved" again or they gain
            // energy and the system explodes.
            const rvx = this.vx[j] - this.vx[i]
            const rvy = this.vy[j] - this.vy[i]
            const along = rvx * nxn + rvy * nyn
            if (along > 0) continue

            // Equal masses: impulse magnitude is -(1+e) * along / 2.
            const impulse = (-(1 + RESTITUTION) * along) / 2
            this.vx[i] -= impulse * nxn
            this.vy[i] -= impulse * nyn
            this.vx[j] += impulse * nxn
            this.vy[j] += impulse * nyn

            totalImpulse += Math.abs(impulse)

            // Positional correction, split between the two bodies.
            const overlap = (minDist - dist) * 0.5
            this.x[i] -= nxn * overlap
            this.y[i] -= nyn * overlap
            this.x[j] += nxn * overlap
            this.y[j] += nyn * overlap

            // Brighten both on contact; this is what makes collisions visible
            // rather than merely correct.
            const f = Math.min(1, Math.abs(impulse) * 0.006)
            if (f > this.flash[i]) this.flash[i] = f
            if (f > this.flash[j]) this.flash[j] = f
          }
        }
      }
    }

    return totalImpulse
  }

  /** Bucket every particle into the spatial hash (counting sort). */
  private rebuildGrid(width: number, height: number) {
    const cols = Math.max(1, Math.ceil(width / this.cellSize))
    const rows = Math.max(1, Math.ceil(height / this.cellSize))
    const cells = cols * rows

    if (cols !== this.cols || rows !== this.rows) {
      this.cols = cols
      this.rows = rows
      this.cellStart = new Int32Array(cells)
      this.cellCount = new Int32Array(cells)
    } else {
      this.cellCount.fill(0)
    }

    // Pass 1: count per cell.
    for (let i = 0; i < this.count; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (this.x[i] / this.cellSize) | 0))
      const cy = Math.min(rows - 1, Math.max(0, (this.y[i] / this.cellSize) | 0))
      this.cellCount[cy * cols + cx]++
    }

    // Pass 2: prefix sum into start offsets.
    let acc = 0
    for (let c = 0; c < cells; c++) {
      this.cellStart[c] = acc
      acc += this.cellCount[c]
      this.cellCount[c] = 0
    }

    // Pass 3: scatter indices.
    for (let i = 0; i < this.count; i++) {
      const cx = Math.min(cols - 1, Math.max(0, (this.x[i] / this.cellSize) | 0))
      const cy = Math.min(rows - 1, Math.max(0, (this.y[i] / this.cellSize) | 0))
      const cell = cy * cols + cx
      this.cellItems[this.cellStart[cell] + this.cellCount[cell]] = i
      this.cellCount[cell]++
    }
  }
}
