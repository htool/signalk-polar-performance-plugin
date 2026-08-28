const SI = require('./SI');

/**
 * PolarTable - A class for managing and interpolating sailing boat polar performance data.
 * 
 * Polar tables contain boat performance data across different True Wind Speeds (TWS) and 
 * True Wind Angles (TWA), including optimal sailing angles, speeds, and VMG calculations.
 * 
 * The class provides interpolation capabilities to get smooth performance data for any
 * wind condition, even between measured data points.
 * 
 * @example
 * const polar = new PolarTable();
 * polar.loadFromCanonical(resource);
 * polar.setPerformanceAdjustment(0.9); // 90% performance
 * 
 * const beatAngle = polar.getBeatAngle(SI.fromKnots(12)); // Get optimal beating angle
 * const boatSpeed = polar.getBoatSpeed(SI.fromKnots(15), SI.fromDegrees(90)); // Get boat speed
 */
class PolarTable {
  /**
   * Creates a new PolarTable instance.
   * Initializes with empty table and default performance adjustment of 1.0 (100%).
   */
  constructor() {
    this.table = [];
    this.perfAdjust = 1;
    this.pinchFactor = 0.9;     // TWA below pinchFactor × beatAngle returns null (in irons)
    this.pinchAngle  = SI.fromDegrees(25); // Hard minimum pinch-to-zero angle — zero speed at or below this TWA
    this.runExtrapFactor = 0.3; // Fraction of (π − runAngle) to extrapolate beyond the last tabulated angle
  }

  /**
   * Sets the performance adjustment factor for all speed-related calculations.
   * This allows scaling the entire polar table performance up or down.
   * 
   * @param {number} value - Performance multiplier (1.0 = 100%, 0.9 = 90%, etc.)
   * @example
   * polar.setPerformanceAdjustment(0.85); // Conservative 85% performance
   * polar.setPerformanceAdjustment(1.1);  // Optimistic 110% performance
   */
  setPerformanceAdjustment(value) {
    this.perfAdjust = value;
  }

  /**
   * Gets the current performance adjustment factor.
   * 
   * @returns {number} Current performance multiplier
   */
  getPerformanceAdjustment() {
    return this.perfAdjust;
  }

  /**
   * Helper function to find the two closest TWS values and calculate interpolation ratio.
   * Handles edge cases where target TWS is outside the available data range.
   * 
   * @private
   * @param {number} targetTws - Target True Wind Speed in m/s
   * @returns {Object|null} Interpolation data with lowerIndex, upperIndex, and ratio, or null if no data
   */
  _findTwsInterpolation(targetTws) {
    if (!this.table || this.table.length === 0) {
      return null;
    }

    // Find the two closest TWS values
    let lowerIndex = -1;
    let upperIndex = -1;

    for (let i = 0; i < this.table.length; i++) {
      if (this.table[i].tws <= targetTws) {
        lowerIndex = i;
      }
      if (this.table[i].tws >= targetTws && upperIndex === -1) {
        upperIndex = i;
        break;
      }
    }

    // Edge case: target TWS is below all available data
    if (lowerIndex === -1) {
      return { lowerIndex: 0, upperIndex: 0, ratio: 0 };
    }

    // Edge case: target TWS is above all available data
    if (upperIndex === -1) {
      const lastIndex = this.table.length - 1;
      return { lowerIndex: lastIndex, upperIndex: lastIndex, ratio: 0 };
    }

    // Exact match or normal interpolation
    if (lowerIndex === upperIndex) {
      return { lowerIndex: lowerIndex, upperIndex: upperIndex, ratio: 0 };
    }

    // Calculate interpolation ratio
    const lowerTws = this.table[lowerIndex].tws;
    const upperTws = this.table[upperIndex].tws;
    const ratio = (targetTws - lowerTws) / (upperTws - lowerTws);

    return { lowerIndex: lowerIndex, upperIndex: upperIndex, ratio: ratio };
  }

  /**
   * Helper function to find the two closest TWA values and interpolation ratio within a TWS entry.
   * Used for bilinear interpolation when getting boat speeds at specific wind angles.
   * 
   * @private
   * @param {Array} twaArray - Array of TWA data points from a specific TWS entry
   * @param {number} targetTwa - Target True Wind Angle in radians
   * @returns {Object|null} Interpolation data with lowerIndex, upperIndex, and ratio, or null if no data
   */
  _findTwaInterpolation(twaArray, targetTwa) {
    if (!twaArray || twaArray.length === 0) {
      return null;
    }

    // Find the two closest TWA values
    let lowerIndex = -1;
    let upperIndex = -1;

    for (let i = 0; i < twaArray.length; i++) {
      if (twaArray[i].twa <= targetTwa) {
        lowerIndex = i;
      }
      if (twaArray[i].twa >= targetTwa && upperIndex === -1) {
        upperIndex = i;
        break;
      }
    }

    // Edge case: target TWA is below all available data — boat is in irons, no polar data
    if (lowerIndex === -1) {
      return null;
    }

    // Edge case: target TWA is above all available data — clamp to last entry
    if (upperIndex === -1) {
      const lastIndex = twaArray.length - 1;
      return { lowerIndex: lastIndex, upperIndex: lastIndex, ratio: 0 };
    }

    // Exact match or normal interpolation
    if (lowerIndex === upperIndex) {
      return { lowerIndex: lowerIndex, upperIndex: upperIndex, ratio: 0 };
    }

    // Calculate interpolation ratio
    const lowerTwa = twaArray[lowerIndex].twa;
    const upperTwa = twaArray[upperIndex].twa;
    const ratio = (targetTwa - lowerTwa) / (upperTwa - lowerTwa);

    return { lowerIndex: lowerIndex, upperIndex: upperIndex, ratio: ratio };
  }

  /**
   * Returns the interpolation state for a given TWS and TWA.
   *
   * Useful for display layers that want to communicate whether values are
   * within the polar table bounds, extrapolated, or undefined.
   *
   * @param {number} tws - True Wind Speed in m/s
   * @param {number} twa - True Wind Angle in radians (positive, 0–π)
   * @returns {{ tws: string, twa: string }|null}
   *   null if the table is empty, otherwise an object with:
   *   - tws: 'below_range' | 'in_range' | 'above_range'
   *   - twa: 'in_irons' | 'pinching' | 'in_range' | 'above_range'
   */
  getInterpolationState(tws, twa) {
    if (!this.table || this.table.length === 0) return null

    // Ignore the zero-padding entry (tws ≈ 0.0001) when finding real bounds
    const realEntries = this.table.filter(e => e.tws > 0.001)
    if (realEntries.length === 0) return null

    const minTws = realEntries[0].tws
    const maxTws = realEntries[realEntries.length - 1].tws

    let twsState
    if (tws < minTws)      twsState = 'below_range'
    else if (tws > maxTws) twsState = 'above_range'
    else                   twsState = 'in_range'

    // Beat angle at requested TWS for TWA boundary checks
    const beatAngle = this.getBeatAngle(tws)

    let twaState
    const normalizedTwa = Math.abs(twa)

    if (!beatAngle) {
      // No beat angle data — use first entry's twa array for range check
      twaState = 'in_range'
    } else if (normalizedTwa < this.pinchFactor * beatAngle) {
      twaState = 'in_irons'
    } else if (normalizedTwa < beatAngle) {
      twaState = 'pinching'
    } else {
      // Check against max TWA using interpolated extrap limit (mirrors getBoatSpeed logic)
      const twsInterp = this._findTwsInterpolation(tws)
      const lowerEntry = this.table[twsInterp.lowerIndex]
      const upperEntry = this.table[twsInterp.upperIndex]
      const lowerTwaArr = lowerEntry.twa
      const upperTwaArr = upperEntry.twa
      const lowerLastTwa = lowerTwaArr?.[lowerTwaArr.length - 1]?.twa ?? 0
      const upperLastTwa = upperTwaArr?.[upperTwaArr.length - 1]?.twa ?? 0
      const maxTwa = Math.max(lowerLastTwa, upperLastTwa)
      const lowerLimit = lowerEntry._runExtrap?.extrapLimit ?? lowerLastTwa
      const upperLimit = upperEntry._runExtrap?.extrapLimit ?? upperLastTwa
      // The interpolated limit is the effective polar boundary at this TWS —
      // getBoatSpeed returns null above it, so report above_range even when the
      // TWA is still tabulated for one of the brackets (the other bracket's
      // tighter limit wins by design, keeping the boundary smooth across TWS).
      const extrapLimit = lowerLimit + twsInterp.ratio * (upperLimit - lowerLimit)
      if (normalizedTwa > extrapLimit) {
        twaState = 'above_range'
      } else if (normalizedTwa > maxTwa) {
        twaState = 'extrapolated'
      } else {
        twaState = 'in_range'
      }
    }

    return { tws: twsState, twa: twaState }
  }

  /**
   * Gets the optimal beating angle (upwind) for a given true wind speed.
   * Uses linear interpolation between the closest TWS data points.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @returns {number|null} Optimal beating angle in radians, or null if no data available
   * @example
   * const beatAngle = polar.getBeatAngle(SI.fromKnots(12)); // Get beat angle for 12 knots
   */
  getBeatAngle(tws) {
    const interpolation = this._findTwsInterpolation(tws);
    if (!interpolation) {
      return null;
    }

    const lowerAngle = this.table[interpolation.lowerIndex]['Beat angle'];
    const upperAngle = this.table[interpolation.upperIndex]['Beat angle'];
    return lowerAngle + interpolation.ratio * (upperAngle - lowerAngle);
  }

  /**
   * Gets the optimal running angle (downwind) for a given true wind speed.
   * Uses linear interpolation between the closest TWS data points.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @returns {number|null} Optimal running angle in radians, or null if no data available
   * @example
   * const runAngle = polar.getRunAngle(SI.fromKnots(20)); // Get run angle for 20 knots
   */
  getRunAngle(tws) {
    const interpolation = this._findTwsInterpolation(tws);
    if (!interpolation) {
      return null;
    }

    const lowerAngle = this.table[interpolation.lowerIndex]['Run angle'];
    const upperAngle = this.table[interpolation.upperIndex]['Run angle'];
    return lowerAngle + interpolation.ratio * (upperAngle - lowerAngle);
  }

  /**
   * Gets the Velocity Made Good (VMG) when beating for a given true wind speed.
   * VMG represents the effective speed toward the wind direction.
   * Result is scaled by the performance adjustment factor.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @returns {number|null} Beat VMG in m/s (scaled by perfAdjust), or null if no data available
   * @example
   * const beatVMG = polar.getBeatVMG(SI.fromKnots(15)); // Get beat VMG for 15 knots
   */
  getBeatVMG(tws) {
    const interpolation = this._findTwsInterpolation(tws);
    if (!interpolation) {
      return null;
    }

    const lowerVMG = this.table[interpolation.lowerIndex]['Beat VMG'];
    const upperVMG = this.table[interpolation.upperIndex]['Beat VMG'];
    return (lowerVMG + interpolation.ratio * (upperVMG - lowerVMG)) * this.perfAdjust;
  }

  /**
   * Gets the Velocity Made Good (VMG) when running for a given true wind speed.
   * VMG represents the effective speed away from the wind direction.
   * Result is scaled by the performance adjustment factor.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @returns {number|null} Run VMG in m/s (scaled by perfAdjust), or null if no data available
   * @example
   * const runVMG = polar.getRunVMG(SI.fromKnots(18)); // Get run VMG for 18 knots
   */
  getRunVMG(tws) {
    const interpolation = this._findTwsInterpolation(tws);
    if (!interpolation) {
      return null;
    }

    const lowerVMG = this.table[interpolation.lowerIndex]['Run VMG'];
    const upperVMG = this.table[interpolation.upperIndex]['Run VMG'];
    return (lowerVMG + interpolation.ratio * (upperVMG - lowerVMG)) * this.perfAdjust;
  }

  /**
   * Gets the maximum achievable boat speed for a given true wind speed.
   * This represents the peak performance speed regardless of wind angle.
   * Result is scaled by the performance adjustment factor.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @returns {number|null} Maximum boat speed in m/s (scaled by perfAdjust), or null if no data available
   * @example
   * const maxSpeed = polar.getMaxSpeed(SI.fromKnots(25)); // Get max speed for 25 knots
   */
  getMaxSpeed(tws) {
    const interpolation = this._findTwsInterpolation(tws);
    if (!interpolation) {
      return null;
    }

    const lowerSpeed = this.table[interpolation.lowerIndex]['Max speed'];
    const upperSpeed = this.table[interpolation.upperIndex]['Max speed'];
    return (lowerSpeed + interpolation.ratio * (upperSpeed - lowerSpeed)) * this.perfAdjust;
  }

  /**
   * Gets the true wind angle at which maximum speed is achieved for a given true wind speed.
   * This indicates the optimal angle for achieving peak boat speed.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @returns {number|null} Angle of maximum speed in radians, or null if no data available
   * @example
   * const maxSpeedAngle = polar.getMaxSpeedAngle(SI.fromKnots(20)); // Get angle for max speed
   */
  getMaxSpeedAngle(tws) {
    const interpolation = this._findTwsInterpolation(tws);
    if (!interpolation) {
      return null;
    }

    const lowerAngle = this.table[interpolation.lowerIndex]['Max speed angle'];
    const upperAngle = this.table[interpolation.upperIndex]['Max speed angle'];
    return lowerAngle + interpolation.ratio * (upperAngle - lowerAngle);
  }


  /**
   * Gets the boat speed for specific true wind speed and true wind angle.
   * Uses bilinear interpolation to provide smooth speed data between measured points.
   * Result is scaled by the performance adjustment factor.
   * 
   * Handles negative wind angles (port tack) by using symmetry - negative angles
   * are converted to their positive equivalents since sailboat performance is
   * typically symmetric between port and starboard tacks.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @param {number} twa - True Wind Angle in radians (positive or negative)
   * @returns {number|null} Boat speed in m/s (scaled by perfAdjust), or null if no data available
   * @example
   * const speed = polar.getBoatSpeed(SI.fromKnots(15), SI.fromDegrees(90)); // Speed at 15kt, 90°
   * const speedPort = polar.getBoatSpeed(SI.fromKnots(15), SI.fromDegrees(-90)); // Same as +90°
   */
  /**
   * Returns the polar speed for a single TWS table entry at a given TWA.
   * Handles beat-angle quadratic extrapolation, run-angle quadratic extrapolation,
   * and normal bilinear lookup.
   *
   * The in-irons boundary itself is NOT checked here — getBoatSpeed evaluates it
   * against the interpolated beat angle so both TWS brackets share one boundary.
   * When this entry's own beat angle is above the requested TWA, the boat is
   * treated as stopped (0) rather than "no data", so the other bracket can
   * still contribute to the TWS interpolation.
   *
   * @private
   * @param {Object} entry  - A single TWS table entry (this.table[i])
   * @param {number} twa    - True Wind Angle in radians (0–π, already normalised)
   * @returns {number|null} Boat speed in m/s, or null when no tabulated data
   *   covers the angle
   */
  _getSpeedFromEntry(entry, twa) {
    const beatAngle = entry['Beat angle']
    const twaArray  = entry.twa

    // ── Beat angle extrapolation zone (pinch point … beat angle) ─────────────
    // Quadratic ramp anchored at 0 speed at pinchAngle (25°) through beat angle
    // with C1 continuity at beat angle.
    if (beatAngle && twa < beatAngle) {
      if (!entry._beatExtrap) return 0
      const u = twa - entry._beatExtrap.zeroAngle
      if (u <= 0) return 0                            // below the analytic zero — stopped
      return Math.max(0, entry._beatExtrap.a * u * u + entry._beatExtrap.b * u)
    }

    // ── Run angle extrapolation zone (last tabulated angle … π) ────────────────
    // Limit check is handled by getBoatSpeed using the interpolated extrap limit
    // so that the boundary is smooth across TWS brackets.  Here we only guard
    // against going beyond π or missing coefficients.
    if (twaArray && twaArray.length > 0) {
      const lastTwa = twaArray[twaArray.length - 1].twa
      if (twa > lastTwa) {
        if (!entry._runExtrap || twa > Math.PI) return null
        const { runVMG, omega, runAngle } = entry._runExtrap
        const vmg = runVMG * Math.cos(omega * (twa - runAngle))
        const cosTwa = Math.cos(twa)  // negative for twa > 90°
        if (Math.abs(cosTwa) < 1e-9) return null
        return Math.max(0, vmg / cosTwa)
      }
    }

    // ── Normal bilinear lookup ────────────────────────────────────────────────
    const interp = this._findTwaInterpolation(twaArray, twa)
    if (!interp) return null
    const tbs1 = twaArray[interp.lowerIndex].tbs
    const tbs2 = twaArray[interp.upperIndex].tbs
    return tbs1 + interp.ratio * (tbs2 - tbs1)
  }

  getBoatSpeed(tws, twa) {
    // Handle negative angles by using symmetry (port tack = starboard tack performance)
    const normalizedTwa = Math.abs(twa)

    const twsInterpolation = this._findTwsInterpolation(tws)
    if (!twsInterpolation) return null

    const lowerEntry = this.table[twsInterpolation.lowerIndex]
    const upperEntry = this.table[twsInterpolation.upperIndex]

    // ── In irons: below the pinch point of the interpolated beat angle ──────
    // Evaluating the boundary against the interpolated beat angle (like
    // getInterpolationState) keeps the two consistent and avoids a discontinuity
    // when neighbouring TWS entries carry different beat angles: with per-entry
    // boundaries, the stricter bracket would null the whole interpolation.
    const beatAngle = this.getBeatAngle(tws)
    if (beatAngle && normalizedTwa < this.pinchFactor * beatAngle) return null

    // ── Run extrap limit: interpolate the limit between the two TWS brackets ───
    // Moving the check here (rather than per-entry) prevents a discontinuity
    // where the lower bracket's tighter limit would otherwise cause a sudden jump
    // to the upper bracket's value.
    const lowerLastTwa = lowerEntry.twa?.length ? lowerEntry.twa[lowerEntry.twa.length - 1].twa : 0
    const upperLastTwa = upperEntry.twa?.length ? upperEntry.twa[upperEntry.twa.length - 1].twa : 0
    if (normalizedTwa > lowerLastTwa || normalizedTwa > upperLastTwa) {
      const lowerLimit = lowerEntry._runExtrap?.extrapLimit ?? lowerLastTwa
      const upperLimit = upperEntry._runExtrap?.extrapLimit ?? upperLastTwa
      const limit = lowerLimit + twsInterpolation.ratio * (upperLimit - lowerLimit)
      if (normalizedTwa > limit) return null
    }

    const lowerBoatSpeed = this._getSpeedFromEntry(lowerEntry, normalizedTwa)
    if (lowerBoatSpeed === null) return null
    const upperBoatSpeed = this._getSpeedFromEntry(upperEntry, normalizedTwa)
    if (upperBoatSpeed === null) return null

    // Interpolate between the two TWS values and scale by performance adjustment
    return (lowerBoatSpeed + twsInterpolation.ratio * (upperBoatSpeed - lowerBoatSpeed)) * this.perfAdjust
  }

  /**
   * Gets the Velocity Made Good (VMG) for specific true wind speed and true wind angle.
   * VMG represents the component of boat speed in the direction toward or away from the wind.
   * 
   * Handles negative wind angles (port tack) correctly by using the original angle
   * for VMG calculation while using symmetry for boat speed lookup.
   * 
   * @param {number} tws - True Wind Speed in m/s
   * @param {number} twa - True Wind Angle in radians (positive or negative)
   * @returns {number|null} VMG in m/s (positive = toward wind, negative = away from wind), or null if no data
   * @example
   * const vmg = polar.getVMG(SI.fromKnots(12), SI.fromDegrees(45)); // VMG at 12kt, 45°
   * const vmgPort = polar.getVMG(SI.fromKnots(12), SI.fromDegrees(-45)); // VMG at 12kt, -45° (port)
   */
  getVMG(tws, twa) {
    const boatSpeed = this.getBoatSpeed(tws, twa);
    if (boatSpeed === null) {
      return null;
    }

    // VMG = boat speed * cos(original true wind angle) 
    // Use original angle (not normalized) to preserve sign for VMG direction
    return boatSpeed * Math.cos(twa);
  }


  /**
   * Helper method to add speed data to a polar table entry.
   * Handles TWA data addition and max speed tracking.
   * 
   * @private
   * @param {Object} polarEntry - Polar table entry to update
   * @param {number} angle - True wind angle in radians
   * @param {number} tbs - True boat speed in m/s
   * @param {number} vmg - Velocity made good in m/s
   * @param {string} angleName - Optional angle property name ('Beat angle' or 'Run angle')
   * @param {string} VMGName - Optional VMG property name ('Beat VMG' or 'Run VMG')
   * @param {Object} app - Optional debug logging object
   */
  _addSpeedData(polarEntry, angle, tbs, vmg, angleName, VMGName, app) {
    if (!polarEntry.twa) {
      polarEntry.twa = []
    }
    
    // Set beat/run specific data
    if (angleName) {
      polarEntry[angleName] = angle
      polarEntry[VMGName] = this._roundDec(vmg)
    }
    
    // Add to TWA array (upsert: overwrite if same angle already present)
    const existingIdx = polarEntry.twa.findIndex(e => e.twa === angle)
    if (existingIdx >= 0) {
      app && app.error('Duplicate TWA %.1f°: overwriting existing entry', SI.toDegrees(angle))
      polarEntry.twa[existingIdx] = { twa: angle, tbs: tbs, vmg: vmg }
    } else {
      polarEntry.twa.push({ twa: angle, tbs: tbs, vmg: vmg })
    }
    
    // Update max speed if necessary
    if (!polarEntry['Max speed'] || tbs > polarEntry['Max speed']) {
      polarEntry['Max speed'] = tbs
      polarEntry['Max speed angle'] = angle
      app && app.debug('Found max speed: %s', JSON.stringify(polarEntry))
    }
  }

  /**
   * Helper method for decimal rounding.
   * 
   * @private
   * @param {number} num - Number to round
   * @param {number} decimals - Number of decimal places (default: 2)
   * @returns {number} Rounded number
   */
  _roundDec(num, decimals = 2) {
    return Math.round(num * Math.pow(10, decimals)) / Math.pow(10, decimals)
  }

  /**
   * Computes quadratic extrapolation coefficients for each TWS entry and stores
   * them on the entry as `_beatExtrap` and `_runExtrap`.
   *
   * Called after _sortAndOptimizePolar (needs sorted twa arrays and beat/run
   * angles) and after _addPolarPadding, so the zero-wind padding entry receives
   * degenerate zero-valued coefficients — exactly what light-wind interpolation
   * toward zero needs.
   *
   * Beat angle model — f(u) = a·u² + b·u, u = twa − zeroAngle (pinchAngle = 25°):
   *   f(d)  = beatSpeed   where d = beatAngle − zeroAngle
   *   f'(d) = slope       slope estimated from first data point above beatAngle
   *   → a = (slope·d − beatSpeed) / d²,  b = slope − 2·a·d
   *
   * Run angle model — f(twa) = a·(twa − π)² + c  (vertex = zero-slope at 180°):
   *   f(runAngle)  = runSpeed
   *   f'(runAngle) = slope       slope estimated from last two points at/before runAngle
   *   → a = slope / (2·(runAngle − π)),  c = runSpeed − a·(runAngle − π)²
   *
   * @private
   * @param {Array}  polar - Polar table array (sorted, beat/run angles set)
   * @param {Object} app   - Optional debug logger
   */
  _computeExtrapolationCoefficients(polar, app) {
    polar.forEach(entry => {
      if (!entry.twa || entry.twa.length < 2) return

      const beatAngle = entry['Beat angle']
      const runAngle  = entry['Run angle']

      // ── Beat angle quadratic ───────────────────────────────────────────────
      // Only meaningful when beatAngle > pinchAngle so the zone is non-degenerate.
      if (beatAngle && beatAngle > this.pinchAngle) {
        const beatIdx = entry.twa.findIndex(p => Math.abs(p.twa - beatAngle) < 1e-9)
        if (beatIdx >= 0) {
          const beatSpeed = entry.twa[beatIdx].tbs
          // Slope from beat angle to the next tabulated point (bearing away upwind)
          let slope = 0
          if (beatIdx + 1 < entry.twa.length) {
            const p0 = entry.twa[beatIdx]
            const p1 = entry.twa[beatIdx + 1]
            slope = (p1.tbs - p0.tbs) / (p1.twa - p0.twa)
          }
          const zeroAngle = this.pinchAngle
          const d = beatAngle - zeroAngle
          const a = (slope * d - beatSpeed) / (d * d)
          const b = slope - 2 * a * d
          entry._beatExtrap = { zeroAngle, a, b }
          app && app.debug(
            'Beat extrap TWS %.0fkn: beatAngle=%.1f° zeroAt=%.1f° slope=%.4f m/s/rad a=%.4f b=%.4f',
            SI.toKnots(entry.tws), SI.toDegrees(beatAngle), SI.toDegrees(zeroAngle), slope, a, b
          )
        }
      }

      // ── Run angle cosine-VMG model ────────────────────────────────────────
      // VMG(twa) = runVMG × cos(ω × (twa − runAngle))
      // where ω is chosen so that VMG = 0 at twa = 90° (π/2):
      //   cos(ω × (π/2 − runAngle)) = 0  ⇒  ω × (runAngle − π/2) = π/2
      //   ω = π / (2 × (runAngle − π/2))
      // bsp(twa) = VMG(twa) / cos(twa)  (cos(twa) < 0 for twa > 90°, runVMG < 0 ⇒ bsp > 0)
      if (runAngle) {
        const runIdx = entry.twa.findIndex(p => Math.abs(p.twa - runAngle) < 1e-9)
        if (runIdx >= 0) {
          // Compute signed VMG: tbs × cos(runAngle).  cos(runAngle) < 0 for runAngle > 90°
          // so runVMG is negative (downwind).  The stored .vmg field uses Math.abs(cos) —
          // always positive — so we must not use it here.
          const runVMG = entry.twa[runIdx].tbs * Math.cos(runAngle)
          const denom = runAngle - Math.PI / 2
          if (Math.abs(denom) > 1e-6) {
            const omega = Math.PI / (2 * denom)
            // Extrapolation limit: start from the last tabulated angle (which may be
            // beyond runAngle for some polars) and extend by the same fractional width
            // as the beat pinch zone uses on the upwind side.
            const lastTwa = entry.twa[entry.twa.length - 1].twa
            const extrapLimit = lastTwa + (Math.PI - runAngle) * this.runExtrapFactor
            entry._runExtrap = { runVMG, omega, runAngle, extrapLimit }
            app && app.debug(
              'Run extrap TWS %.0fkn: runAngle=%.1f° limit=%.1f° ω=%.4f',
              SI.toKnots(entry.tws), SI.toDegrees(runAngle), SI.toDegrees(extrapLimit), omega
            )
          }
        }
      }
    })
  }

  /**
   * Helper method to sort TWA arrays and find optimal beat/run angles.
   * Sorts all TWA data by angle and calculates best VMG angles if not already set.
   *
   * @private
   * @param {Array} polar - Polar table array to process
   * @param {Object} app - Optional debug logging object
   */
  _sortAndOptimizePolar(polar, app) {
    const halfPi = Math.PI / 2

    // Sort the twa arrays by angle
    polar.forEach(twsEntry => {
      if (twsEntry.twa && twsEntry.twa.length > 0) {
        twsEntry.twa.sort((a, b) => a.twa - b.twa)
      }
    })

    // Find beat/run angles if not already set
    polar.forEach((twsEntry, index) => {
      // Skip entries without twa data
      if (!twsEntry.twa || twsEntry.twa.length === 0) {
        app && app.debug('Skipping TWS %s - no angle data available', SI.toKnots(twsEntry.tws).toFixed(0))
        return
      }
      
      if (typeof twsEntry['Beat angle'] === 'undefined') {
        app && app.debug('Finding beat angle for TWS %s', SI.toKnots(twsEntry.tws).toFixed(0))
        
        let beatVMG = 0, beatElement = 0, runVMG = 0, runElement = 0

        twsEntry.twa.forEach((twaObj, element) => {
          if (twaObj.twa < halfPi && twaObj.vmg > beatVMG) {
            beatVMG = twaObj.vmg
            beatElement = element
          } else if (twaObj.twa >= halfPi && twaObj.vmg > runVMG) {
            runVMG = twaObj.vmg
            runElement = element
          }
        })

        app && app.debug(
          'beatVMG for %s is %s (angle %s)',
          SI.toKnots(twsEntry.tws).toFixed(0),
          SI.toKnots(twsEntry.twa[beatElement].vmg).toFixed(2),
          SI.toDegrees(twsEntry.twa[beatElement].twa).toFixed(1)
        )
        app && app.debug(
          'runVMG for %s is %s (angle %s)',
          SI.toKnots(twsEntry.tws).toFixed(0),
          SI.toKnots(twsEntry.twa[runElement].vmg).toFixed(2),
          SI.toDegrees(twsEntry.twa[runElement].twa).toFixed(1)
        )

        twsEntry['Beat angle'] = twsEntry.twa[beatElement].twa
        twsEntry['Beat VMG'] = twsEntry.twa[beatElement].vmg
        twsEntry['Run angle'] = twsEntry.twa[runElement].twa
        twsEntry['Run VMG'] = twsEntry.twa[runElement].vmg
      }
    })
  }

  /**
   * Helper method to add padding for interpolation at wind angle extremes.
   * Adds zero-wind-speed entry and pads TWA ranges from 0 to π radians.
   * 
   * @private
   * @param {Array} polar - Polar table array to pad
   * @param {Object} app - Optional debug logging object
   */
  _addPolarPadding(polar, app) {
    // Add zero wind speed entry for low wind interpolation
    if (polar.length > 0 && polar[0].tws > 0 && polar[0].twa && polar[0].twa.length > 0) {
      app && app.debug('Add a 0 line to allow interpolation at very low wind speeds')
      const zeroEntry = {
        tws: 0.0001,
        'Beat angle': polar[0]['Beat angle'],
        'Beat VMG': 0,
        'Run angle': polar[0]['Run angle'],
        'Run VMG': 0,
        'Max speed': 0,
        'Max speed angle': polar[0]['Max speed angle'],
        twa: polar[0].twa.map(twaObj => ({ twa: twaObj.twa, tbs: 0, vmg: 0 }))
      }
      polar.unshift(zeroEntry)
    }

    // Add padding at low and high wind angles for each TWS
    polar.forEach(twsEntry => {
      // Skip entries without twa data
      if (!twsEntry.twa || twsEntry.twa.length === 0) {
        return
      }
      
      const twaArray = twsEntry.twa
      const lowTWA = twaArray[0].twa

      // Beat angle extrapolation is now handled analytically by _getSpeedFromEntry
      // using the quadratic coefficients in entry._beatExtrap.  No padding point needed.
    })
  }

  /**
   * Builds a complete per-TWS derived target table, filling gaps by interpolation.
   *
   * Many polar sources (Jieter/Expedition CSV exports, ORC data) only emit
   * beat/run target rows for a subset of the TWS columns.  Without this pass,
   * TWS entries lacking a target fall back to _sortAndOptimizePolar's
   * argmax-VMG-over-tabulated-angles heuristic, which pins the beat angle to
   * the lowest tabulated angle and disagrees sharply with neighbouring TWS
   * entries — nulling out the pinch zone for every TWS interpolated against
   * the gap (polar speed reads 0 while sailing).
   *
   * For each TWS axis value missing a beat (or run) target, the target is
   * linearly interpolated from the nearest entries below and above that have
   * one; at the ends of the axis the nearest available target is used as-is.
   *
   * @private
   * @param {number[]} twsAxis - TWS axis values in m/s (ascending)
   * @param {Array} derivedRows - Derived rows from the canonical resource
   * @returns {Array<Object>} Array aligned with twsAxis; each item has optional
   *   `beat`/`run` targets ({twa, tbs, vmg} in SI units)
   */
  _interpolateDerivedTargets(twsAxis, derivedRows) {
    const targets = twsAxis.map(tws => {
      const row = derivedRows.find(candidate => Math.abs(candidate.tws - tws) < 1e-6)
      const target = {}
      if (row?.beat && Number.isFinite(row.beat.twa) && Number.isFinite(row.beat.tbs)) {
        target.beat = { ...row.beat }
      }
      if (row?.run && Number.isFinite(row.run.twa) && Number.isFinite(row.run.tbs)) {
        target.run = { ...row.run }
      }
      return target
    })

    for (const key of ['beat', 'run']) {
      for (let i = 0; i < targets.length; i++) {
        if (targets[i][key]) continue

        let lo = -1
        let hi = -1
        for (let j = i - 1; j >= 0; j--) { if (targets[j][key]) { lo = j; break } }
        for (let j = i + 1; j < targets.length; j++) { if (targets[j][key]) { hi = j; break } }

        if (lo >= 0 && hi >= 0 && twsAxis[hi] - twsAxis[lo] > 1e-9) {
          const ratio = (twsAxis[i] - twsAxis[lo]) / (twsAxis[hi] - twsAxis[lo])
          const a = targets[lo][key]
          const b = targets[hi][key]
          const twa = a.twa + ratio * (b.twa - a.twa)
          const tbs = a.tbs + ratio * (b.tbs - a.tbs)
          targets[i][key] = { twa, tbs, vmg: tbs * Math.abs(Math.cos(twa)) }
        } else if (lo >= 0) {
          targets[i][key] = { ...targets[lo][key] }
        } else if (hi >= 0) {
          targets[i][key] = { ...targets[hi][key] }
        }
      }
    }

    return targets
  }

  /**
   * Loads polar table data from the canonical PolarResource representation.
   *
   * @param {Object} resource - Canonical polar resource with axes and boatSpeedMatrix in SI units.
   * @returns {PolarTable} Returns this instance for method chaining.
   */
  loadFromCanonical(resource) {
    const twsAxis = resource?.axes?.tws
    const twaAxis = resource?.axes?.twa
    const matrix = resource?.values?.boatSpeedMatrix

    if (!Array.isArray(twsAxis) || !Array.isArray(twaAxis) || !Array.isArray(matrix)) {
      throw new Error('Invalid canonical polar resource')
    }
    if (matrix.length !== twsAxis.length) {
      throw new Error('boatSpeedMatrix row count must match axes.tws length')
    }

    const derivedRows = Array.isArray(resource?.derived?.rows) ? resource.derived.rows : []
    // Fill gaps in derived beat/run targets across TWS so entries without an
    // explicit target get an interpolated one instead of falling back to the
    // argmax-VMG-over-tabulated-angles heuristic (which pins the beat angle to
    // the lowest tabulated angle and disagrees sharply with neighbouring TWS,
    // nulling out the pinch zone for every TWS interpolated against the gap).
    const derivedTargets = this._interpolateDerivedTargets(twsAxis, derivedRows)
    const polar = twsAxis.map(tws => ({ tws, twa: [] }))

    for (let rowIndex = 0; rowIndex < twsAxis.length; rowIndex++) {
      const row = matrix[rowIndex]
      if (!Array.isArray(row) || row.length !== twaAxis.length) {
        throw new Error('boatSpeedMatrix column count must match axes.twa length')
      }

      for (let colIndex = 0; colIndex < twaAxis.length; colIndex++) {
        const angle = twaAxis[colIndex]
        const tbs = row[colIndex]
        if (!Number.isFinite(angle) || angle < 0 || angle > Math.PI) {
          throw new Error('Invalid TWA axis value in canonical resource')
        }
        if (!Number.isFinite(tbs) || tbs <= 0) continue
        const vmg = tbs * Math.abs(Math.cos(angle))
        this._addSpeedData(polar[rowIndex], angle, tbs, vmg, null, null, null)
      }

      const derivedRow = derivedTargets[rowIndex]

      if (derivedRow?.beat && Number.isFinite(derivedRow.beat.twa) && Number.isFinite(derivedRow.beat.tbs)) {
        const beatVmg = Number.isFinite(derivedRow.beat.vmg)
          ? derivedRow.beat.vmg
          : derivedRow.beat.tbs * Math.abs(Math.cos(derivedRow.beat.twa))
        this._addSpeedData(
          polar[rowIndex],
          derivedRow.beat.twa,
          derivedRow.beat.tbs,
          beatVmg,
          'Beat angle',
          'Beat VMG',
          null
        )
      }

      if (derivedRow?.run && Number.isFinite(derivedRow.run.twa) && Number.isFinite(derivedRow.run.tbs)) {
        const runVmg = Number.isFinite(derivedRow.run.vmg)
          ? derivedRow.run.vmg
          : derivedRow.run.tbs * Math.abs(Math.cos(derivedRow.run.twa))
        this._addSpeedData(
          polar[rowIndex],
          derivedRow.run.twa,
          derivedRow.run.tbs,
          runVmg,
          'Run angle',
          'Run VMG',
          null
        )
      }

      if (polar[rowIndex].twa.length === 0) {
        throw new Error('Each canonical TWS row must contain at least one positive boat speed')
      }
    }

    this._sortAndOptimizePolar(polar, null)
    // Padding must be in place before coefficients are computed so the zero-wind
    // entry gets zero-valued _beatExtrap/_runExtrap models; without them, any
    // low-wind lookup in the pinch or run-extrapolation zone returns null
    // instead of interpolating smoothly toward zero.
    this._addPolarPadding(polar, null)
    this._computeExtrapolationCoefficients(polar, null)
    this.table = polar
    return this
  }
}

/**
 * Internal structure of this.table after loading polar data:
 * 
 * @typedef {Object} PolarEntry
 * @property {number} tws - True Wind Speed in m/s (converted from knots)
 * @property {number} Beat angle - Optimal beating angle in radians
 * @property {number} Beat VMG - Velocity Made Good when beating in m/s
 * @property {number} Run angle - Optimal running angle in radians  
 * @property {number} Run VMG - Velocity Made Good when running in m/s
 * @property {number} Max speed - Maximum boat speed for this TWS in m/s
 * @property {number} Max speed angle - Angle at which max speed occurs in radians
 * @property {Array<Object>} twa - Array of True Wind Angle data points
 * @property {number} twa[].twa - True wind angle in radians
 * @property {number} twa[].tbs - True boat speed in m/s
 * @property {number} twa[].vmg - Velocity made good in m/s
 * 
 * @example
 * // Structure example:
 * this.table = [
 *   {
 *     tws: 2.57,  // True Wind Speed in m/s (converted from knots)
 *     'Beat angle': 0.785,  // Optimal beating angle in radians
 *     'Beat VMG': 1.2,      // Velocity Made Good when beating
 *     'Run angle': 2.356,   // Optimal running angle in radians  
 *     'Run VMG': 1.8,       // Velocity Made Good when running
 *     'Max speed': 3.5,     // Maximum boat speed for this TWS
 *     'Max speed angle': 1.57,  // Angle at which max speed occurs
 *     twa: [  // Array of True Wind Angle data points
 *       { twa: 0, tbs: 0, vmg: 0 },           // Padded start values
 *       { twa: 0.087, tbs: 0.5, vmg: 0.49 }, // Angle in rad, boat speed, VMG
 *       { twa: 0.174, tbs: 1.2, vmg: 1.18 },
 *       // ... more data points covering 0 to π radians
 *       { twa: 3.14, tbs: 2.1, vmg: -2.1 }   // Padded end values
 *     ]
 *   },
 *   // ... more TWS objects for different wind speeds
 * ]
 */

module.exports = { PolarTable };
