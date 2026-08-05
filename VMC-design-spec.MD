# VMC Design Specification

Date: 2026-08-04  
Scope: signalk-polar-performance-plugin  
Status: Design agreed, no implementation in this document.

## 1. Goal

Add VMC (Velocity Made good on Course) outputs that help navigation decisions.

The feature must:
- advise a sailor with target true heading (not only wind-relative angle)
- include water current effects in both advice and performance comparison
- compare actual progress against maximum achievable progress on course for each tack

## 2. Fixed Input Contract

Mandatory Signal K inputs:
- navigation.course.calcValues.bearingTrue
- environment.current.drift
- environment.current.setTrue
- navigation.speedOverGround
- navigation.courseOverGroundTrue
- environment.wind.directionTrue
- environment.wind.angleTrueWater
- environment.wind.speedTrue

Notes:
- environment.wind.angleTrueWater is used to derive current tack.
- No fallback input reconstruction is allowed.
- If any mandatory input for a computed output is missing or non-finite, that output is null.

## 3. Current Handling

Setting:
- ignoreCurrent (boolean)

Behavior:
- false: use environment.current.drift + environment.current.setTrue
- true: internally force current vector to zero

Important:
- This is a user-selected fallback mode.
- There is no automatic fallback to zero current.

## 4. Published Outputs (exactly six)

1. performance.velocityMadeGoodOnCourse
- Actual VMC over ground toward navigation.course.calcValues.bearingTrue

2. performance.targetVelocityMadeGoodOnCourse
- Best achievable VMC on current tack, from polar + current

3. performance.oppositeTackVelocityMadeGoodOnCourse
- Best achievable VMC on opposite tack, from polar + current

4. performance.velocityMadeGoodOnCourseRatio
- performance.velocityMadeGoodOnCourse / performance.targetVelocityMadeGoodOnCourse

5. performance.targetHeadingTrue
- Target true heading on current tack (heading that yields output 2)

6. performance.oppositeTackHeadingTrue
- Target true heading on opposite tack (heading that yields output 3)

## 5. Optimization Domain and Solver

Domain:
- Search only where polar speed is valid (inside supported polar range).
- Do not search outside valid polar range.

Solver:
- Sampled search over full valid domain.
- Resolution parameterized in code.
- Initial resolution: pi/90 (2 degrees).

Per-tack selection:
- Compute candidate samples across full valid domain.
- Partition candidates into port and starboard by tack sign.
- Select maximum VMC candidate in each partition.
- Current tack is derived from sign of environment.wind.angleTrueWater.

Failure behavior:
- If no valid maximum exists for a tack partition, publish null for that tack outputs.

## 6. Frames and Vector Definitions

Angles are true radians in [0, 2*pi) where needed.

Definitions:
- C: course bearing = navigation.course.calcValues.bearingTrue
- SOG: navigation.speedOverGround
- COG: navigation.courseOverGroundTrue
- TWD: environment.wind.directionTrue
- TWS: environment.wind.speedTrue
- drift: environment.current.drift
- set: environment.current.setTrue
- theta: candidate true heading
- alpha: candidate TWA where alpha = wrapPi(theta - TWD)

Vectors in east/north frame:
- Unit vector for angle x: u(x) = [cos(x), sin(x)]
- Course unit vector: uc = u(C)
- Actual ground vector: vg_actual = SOG * u(COG)
- Current vector:
  - vc = [0, 0] if ignoreCurrent is true
  - vc = drift * u(set) otherwise

Predicted boat-through-water vector for candidate heading:
- vbw(theta) = bsp_polar(TWS, |alpha|) * u(theta)

Predicted ground vector for candidate heading:
- vg_pred(theta) = vbw(theta) + vc

Course progress scalar (VMC on course):
- vmc(theta) = dot(vg_pred(theta), uc)

## 7. Output Formulas

## 7.1 Actual VMC

performance.velocityMadeGoodOnCourse = dot(vg_actual, uc)

Equivalent scalar form:
- SOG * cos(COG - C)

## 7.2 Target VMC and Heading per Tack

For each sampled candidate theta:
1. compute alpha = wrapPi(theta - TWD)
2. accept only if polar speed exists for (TWS, |alpha|)
3. compute vmc(theta)
4. classify tack from sign(alpha):
   - starboard if alpha >= 0
   - port if alpha < 0

For each tack partition:
- choose theta* = argmax vmc(theta)
- targetVmcTack = vmc(theta*)
- targetHeadingTack = theta*

Current tack is derived from sign of environment.wind.angleTrueWater:
- current tack starboard if TWA >= 0
- current tack port if TWA < 0

Published mapping:
- performance.targetVelocityMadeGoodOnCourse = targetVmcCurrentTack
- performance.oppositeTackVelocityMadeGoodOnCourse = targetVmcOppositeTack
- performance.targetHeadingTrue = targetHeadingCurrentTack
- performance.oppositeTackHeadingTrue = targetHeadingOppositeTack

## 7.3 Ratio

performance.velocityMadeGoodOnCourseRatio =
- performance.velocityMadeGoodOnCourse / performance.targetVelocityMadeGoodOnCourse

Ratio is:
- signed
- unclamped
- null when denominator is zero, negative-invalid by policy, or non-finite

## 8. Sign and Null Semantics

Signed semantics:
- Actual VMC: signed
- Target VMC values: signed
- Ratio: signed, unclamped

Null semantics:
- Missing required inputs -> null for dependent outputs
- Missing valid tack maximum -> null for that tack output pair
- Ratio null if target current-tack VMC is non-finite or near zero

## 9. Non-Goals for First Version

- No automatic fallback to zero current
- No additional outputs beyond the six agreed paths
- No continuous optimizer in v1 (sampled solver only)

## 10. Notes for Implementation Phase

- Keep output clear/null behavior consistent with existing plugin conventions.
- Reuse existing smoothing approach and stale-data guard behavior where applicable.
- Keep solver step configurable in code, defaulting to pi/90.
- Use the signalkutilities Polar class as the primary vector container for VMC math.
- Read/set vector deltas through Polar instances and perform vector operations with Polar helpers rather than ad-hoc scalar math where feasible.

## 11. OpenAPI Scope and New Query Endpoints

OpenAPI scope decision:
- Do not add runtime webapp endpoints to openApi.json.
- Specifically excluded from OpenAPI: /live, /status, /meta, /settings.

Current-input rule for VMC query endpoints:
- currentDrift and currentSetTrue are optional query parameters.
- If both are omitted, current is assumed zero.
- If one is provided without the other, return HTTP 400.
- Do not add ignoreCurrent as an OpenAPI query parameter.

### 11.1 GET /polars/{id}/queries/vmc-targets

Purpose:
- Solve VMC-optimal headings and target VMC values per tack for given environmental conditions.

Query parameters:
- required: tws, twd, course
- optional: step (default pi/90), currentDrift, currentSetTrue

Response shape (high level):
- port: headingTrue, vmc (nullable)
- starboard: headingTrue, vmc (nullable)

### 11.2 GET /polars/{id}/queries/vmc-performance

Purpose:
- Compute the six VMC runtime outputs from explicit query inputs.

Query parameters:
- required: tws, twd, course, sog, cog, currentTwaSigned
- optional: step (default pi/90), currentDrift, currentSetTrue

Response shape (high level):
- actualVmc
- targetVmc
- oppositeTackVmc
- ratio
- targetHeadingTrue
- oppositeTackHeadingTrue

### 11.3 GET /polars/{id}/queries/vmc-curve

Purpose:
- Curve-equivalent to /polars/{id}/queries/curve for VMC: return speed-to-waypoint (course projection) for each valid heading sample.

Query parameters:
- required: tws, twd, course
- optional: step (default pi/90), currentDrift, currentSetTrue

Response shape (high level):
- tws
- course
- points[] with: headingTrue, twaSigned, vmc, tack
- portBest: headingTrue, vmc (nullable)
- starboardBest: headingTrue, vmc (nullable)

## 12. WebApp End-State (Design)

This section defines the intended end-state for VMC-related presentation in the plugin webapp.

Primary webapp purpose:
- Inspect plugin operation (inputs, computed state, outputs).
- Show what data comes in and what data goes out.
- Modify plugin settings.

The webapp is not the primary decision-making tool for helming/navigation.

### 12.1 Page Structure

The webapp should have two distinct output pages:

1. Performance page
- Contains VMG-related outputs and existing performance-oriented polar information.

2. Navigation page
- Contains VMC-related outputs.

Rationale:
- VMG and VMC serve different decision contexts and should be visually and conceptually separated.

### 12.2 Overview Page Visuals

The Overview page should include a second graph in addition to the existing polar-style performance graph.

Second graph intent:
- Polar-style visualization
- Angular axis: true direction (heading/bearing frame)
- Radial axis: target speed to waypoint (course-progress speed / VMC magnitude)

Second graph markers:
- Target marker: target speed and target direction (current-tack solution)
- Actual marker: actual speed and actual direction over ground

Second graph line:
- A continuous line showing target VMC for every sampled heading in the valid domain.
- This line is derived from the heading sweep used for VMC curve computation (heading -> vmc).

Purpose:
- Provide visual inspection of course-progress model behavior versus actual achieved vector.

### 12.3 Navigation Page Settings

The Navigation page should house the setting:
- ignoreCurrent

Behavioral intent:
- The setting belongs with VMC/navigation outputs because it changes the navigation model used for VMC advice and ratios.

### 12.4 Bearing-To-Waypoint Soft Requirement

`navigation.course.calcValues.bearingTrue` remains mandatory for VMC computation semantics, but the webapp UX should treat its absence/staleness softly.

Design intent:
- Sailors may not always have an active destination/waypoint.
- Missing or stale bearing-to-waypoint is an expected operational state, not necessarily a fault condition.

Webapp behavior guidance:
- Show clear non-blocking state messaging when bearing-to-waypoint is missing or stale.
- Render VMC-dependent values as null/empty according to output null semantics.
- Avoid presenting this condition as a hard error in normal operation.
- Keep performance (VMG) views usable even when navigation (VMC) inputs are unavailable.
