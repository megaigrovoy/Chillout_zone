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

/**
 * Raised along with the smaller radius: fine droplets only read as a fluid if
 * there are enough of them to form a continuous body.
 */
export const MAX_PARTICLES = 5200

/**
 * Uniform particle radius, px. Uniform because it keeps the broad-phase grid
 * cell size trivially correct.
 */
export const RADIUS = 1.6

/**
 * Restitution: 1 = perfectly elastic, 0 = fully inelastic.
 *
 * Low, because a fluid does not bounce — droplets meeting head-on should lose
 * their relative motion and travel together, not ping apart.
 */
const RESTITUTION = 0.18

/**
 * Velocity damping per second.
 *
 * Very heavy: thick paint barely coasts. Motion should stop almost as soon as
 * the hand stops pushing, which is what separates dragging a finger through
 * paint from stirring water.
 */
const DRAG = 0.08

/**
 * Range over which particles attract each other, as a multiple of RADIUS.
 *
 * This is what turns a cloud of colliding balls into something cohesive.
 * Contact forces alone cannot do it: they only ever push apart, so a pile of
 * particles disperses. Attraction at a distance is what holds a body together
 * and lets it stretch into strands instead of scattering.
 */
const COHESION_RANGE = 9.0

/**
 * Strength of that mutual attraction, px/s per second.
 *
 * Sized against the drag, which removes 45% of velocity per second: at 190
 * with a squared falloff the effective pull at typical droplet spacing was
 * only 8.9px/s^2 and friction simply ate it, so the fluid never gathered.
 */
const COHESION = 1400

/**
 * Viscosity: how strongly neighbours pull each other toward a common
 * velocity. This is the property that actually reads as "thick" — without it
 * a cohesive fluid still slides through itself like dry sand.
 */
const VISCOSITY = 26

/**
 * Preferred neighbour spacing, in radii. Below it droplets push apart, above
 * it they pull together, so the fluid has a natural density instead of
 * collapsing as hard as cohesion allows.
 *
 * The collision radius is derived from this rather than from RADIUS itself:
 * with hard contact at 2*RADIUS the positional correction shoved droplets back
 * to 3.2px every frame while tension was trying to hold them at 5.4px, and the
 * correction won — the fluid packed to a measured 0.62px spacing. Making the
 * two agree is what lets the fluid hold an open, rounded structure.
 */
const REST_SPACING = 3.4

/**
 * Neighbour count at which cohesion is at full strength. Above it the pull is
 * divided down, so packing more droplets together does not compress the fluid
 * further — a fluid's density should be a property, not a function of how much
 * of it there happens to be.
 */
const COHESION_NORM = 6

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
  // The cell must cover the longest interaction range, not just contact:
  // sized to the collision diameter, cohesion neighbours would fall outside
  // the searched 3x3 block and the fluid would never bind.
  private cellSize = RADIUS * COHESION_RANGE
  private cols = 0
  private rows = 0
  private cellStart: Int32Array = new Int32Array(0)
  private cellItems: Int32Array = new Int32Array(MAX_PARTICLES)
  private cellCount: Int32Array = new Int32Array(0)
  /** Neighbours in cohesion range per droplet, used to normalise the pull. */
  private neighbourCount = new Float32Array(MAX_PARTICLES)

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
  collide(width: number, height: number, dt = 1 / 60): number {
    if (this.count < 2) return 0
    // Cached because it is read inside the innermost loop.
    const dtCache = dt

    // Cohesion is summed over every neighbour in range, while the contact
    // response only pushes back from the nearest few. In open space that
    // balances at the rest spacing, but inside a pack the inward pull wins by
    // sheer count and crushes the fluid — measured at 1.17px spacing against a
    // 5.44px target. Counting each droplet's neighbours lets the pull be
    // normalised so density does not amplify it.
    if (this.neighbourCount.length < this.count) {
      this.neighbourCount = new Float32Array(this.count * 2)
    }
    this.neighbourCount.fill(0, 0, this.count)

    this.rebuildGrid(width, height)

    let totalImpulse = 0
    // Contact begins at the rest spacing, not at the physical radius, so the
    // collision response and surface tension push toward the same distance
    // instead of fighting each other.
    const minDist = RADIUS * REST_SPACING
    const minDistSq = minDist * minDist
    const cohesionDist = RADIUS * COHESION_RANGE
    const cohesionDistSq = cohesionDist * cohesionDist

    // Phase 1: count neighbours within cohesion range.
    for (let i = 0; i < this.count; i++) {
      const cx0 = (this.x[i] / this.cellSize) | 0
      const cy0 = (this.y[i] / this.cellSize) | 0
      for (let ny = cy0 - 1; ny <= cy0 + 1; ny++) {
        if (ny < 0 || ny >= this.rows) continue
        for (let nx = cx0 - 1; nx <= cx0 + 1; nx++) {
          if (nx < 0 || nx >= this.cols) continue
          const cell = ny * this.cols + nx
          const start = this.cellStart[cell]
          const end = start + this.cellCount[cell]
          for (let k = start; k < end; k++) {
            const j = this.cellItems[k]
            if (j === i) continue
            const dx = this.x[j] - this.x[i]
            const dy = this.y[j] - this.y[i]
            const d2 = dx * dx + dy * dy
            if (d2 > 0 && d2 < cohesionDistSq) this.neighbourCount[i]++
          }
        }
      }
    }

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
            if (distSq === 0 || distSq >= cohesionDistSq) continue

            const dist = Math.sqrt(distSq)
            const nxn = dx / dist
            const nyn = dy / dist

            // Cohesion and viscosity act across the whole neighbourhood, not
            // only on touching pairs — that is the difference between a fluid
            // and a bag of marbles.
            if (distSq >= minDistSq) {
              // Linear falloff, not squared: squaring collapsed the force to
              // near nothing across most of the interaction band, leaving
              // attraction only for droplets already touching.
              const falloff = 1 - dist / cohesionDist

              // Beyond the rest spacing this branch is purely attractive;
              // everything closer is handled by the contact response above,
              // which now separates to exactly the rest spacing.
              // Normalise by neighbour count so a droplet deep inside the mass
              // is not pulled harder than one on the surface. Without this the
              // fluid's density feeds back into its own compression.
              const crowd = Math.max(
                1,
                (this.neighbourCount[i] + this.neighbourCount[j]) * 0.5 / COHESION_NORM,
              )
              const pull = (COHESION * falloff * dtCache) / crowd
              this.vx[i] += nxn * pull
              this.vy[i] += nyn * pull
              this.vx[j] -= nxn * pull
              this.vy[j] -= nyn * pull

              // Viscosity: drag neighbouring velocities toward each other.
              // Clamped: with a large VISCOSITY and a long frame this could
              // otherwise overshoot past the shared velocity and oscillate,
              // adding energy instead of removing it.
              const visc = Math.min(0.5, VISCOSITY * falloff * dtCache)
              const dvx = (this.vx[j] - this.vx[i]) * visc
              const dvy = (this.vy[j] - this.vy[i]) * visc
              this.vx[i] += dvx
              this.vy[i] += dvy
              this.vx[j] -= dvx
              this.vy[j] -= dvy
              continue
            }

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

            // Positional correction, split between the two bodies. Relaxed
            // rather than applied in full: correcting all the way each frame in
            // a dense pack makes neighbours shove each other back and forth and
            // the surface jitters.
            const overlap = (minDist - dist) * 0.5 * 0.6
            this.x[i] -= nxn * overlap
            this.y[i] -= nyn * overlap
            this.x[j] += nxn * overlap
            this.y[j] += nyn * overlap

            // Brighten both on contact; this is what makes collisions visible
            // rather than merely correct.
            const f = Math.min(1, Math.abs(impulse) * 0.02)
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
