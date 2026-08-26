# HIGHROADS — complete project context

Written for an agent picking this project up cold. It assumes you can read the
code; what it gives you is the shape of the thing, the reasons behind decisions
that look arbitrary, and the list of traps that have already cost real time.

Companion documents:
- `README.md` — architecture prose, the *why* of each system, tuning guide.
- `probe/README.md` — the measurement scripts and how to read them.
- `engine_sim/AGENT_CONTEXT.md` — the sound engine, which is a **separate
  project vendored in unmodified**. Read it before touching audio.

This file is the map. The README is the essay.

---

## 0. What this is, in one paragraph

An infinite procedural driving game in the browser, inspired by slowroads.io.
Three.js renders, Rapier3D (WASM) does rigid-body physics for the player's car
only, and a hand-written gradient-noise chain generates terrain. The car is a
**raycast vehicle** — a single rigid body with four downward suspension rays,
not four wheel colliders. The engine note comes from `engine_sim/`, a separate
physically-modelled engine simulator that is also the car's actual drivetrain,
not just its soundtrack. Everything — road, terrain, ground cover, stone,
traffic — streams in and out in chunks as you drive, forever, seeded from a string you can
type in the menu.

**Nothing you can see is an asset.** The terrain, the road, the grass, the stone,
every texture on the ground, the tyre smoke and the sound of the air over the
body are all generated from code at boot — `src/env/` is where the generators
live and `src/env/README.md` is their contract. The only art in the repository is
the nine car models.

No build step. No bundler. ES modules and an import map, served statically.

---

## 1. Workspace layout

```
highroads/
├── index.html            shell, import map, garage UI, HUD, touch controls
├── package.json          scripts only; the game itself has no dependencies
├── README.md             architecture essay
├── AGENT_CONTEXT.md      this file
├── src/                  21 modules + src/env/
│   └── env/              procedurally generated scenery — see its own README
├── probe/                headless measurement scripts (see §10)
├── assets/               user-supplied art (NOT generated, do not regenerate)
│   └── car_models/Fbx/   11 FBX; the roster uses 9. THE ONLY ART THAT IS LOADED —
│                         everything else in the world is generated in src/env/
└── engine_sim/           vendored sibling project — DO NOT EDIT
```

### `src/` module map, largest first

| File | Owns |
|---|---|
| `chunks.js` | Terrain/road mesh generation, colliders, streaming, every scatter |
| `config.js` | **All** tunables, in 18 exported blocks |
| `vehicle.js` | Raycast vehicle: suspension, tyres, aero, stability, visuals |
| `main.js` | Boot, `Game` class, fixed-step loop, garage wiring, recovery |
| `path.js` | Road centreline spline, Frenet frames, arc-length projection |
| `assets.js` | FBX car loading, mesh normalisation, metric extraction. **Cars only** — the OBJ parser and its palette went with the foliage pack |
| `traffic.js` | Other cars: spline riders, AI, lane changes, analytic impacts |
| `powertrain.js` | Bridge between the game and `engine_sim` |
| `noise.js` | Gradient noise, fBm, erosion, warping, landforms, continental term |
| `fx.js` | Tyre smoke and rubber — a GPU particle pool and a ring of quads |
| `cars.js` | 9-car roster, colours, engine options, physics synthesis |
| `scene.js` | Renderer, lights, sky, fog, post-processing chain |
| `wind.js` | Air noise over the body, synthesised, speed-driven |
| `settings.js` | The settings panel — a node, re-parented between the title drawer and the pause menu |
| `input.js` | Keyboard, gamepad, touch, **tilt**; one-shot vs held keys |
| `hud.js` | Speed, tach, gear, trip |
| `foliage.js` | Species vocabulary — the FORM of every tree and shrub and the habitat it wants — plus `vegetation()`, the one field the canopy, the understorey and the ground cover all read |
| `util.js` | clamp/lerp/damp, PRNGs, `smin`/`smax`, string hash |
| `score.js` | Near-miss scoring for Traffic mode — pure logic, no DOM |
| `camera.js` | Three chase modes, FOV-by-speed |

### `src/env/` — everything the world is dressed with

Generated from code at boot. No meshes, no textures, no material files. Read
`src/env/README.md` before adding to it; the contract is one factory per module
returning shared geometry and one shared material, with PLACEMENT left to
`chunks.js` because placement is the only part that needs the road, the terrain
sheet and the streaming window.

| File | Builds | Triangles per instance |
|---|---|---|
| `textures.js` | Canvas helpers: soft-failing canvas, seeded PRNG, TILEABLE value noise, fBm, ridged fBm, a whole-image `paint()` | — |
| `grass.js` | Crossed-card tufts, in a near tier and a far tier | 4 |
| `trees.js` | Grown branch skeletons with leaf-card crowns, **and** the painted four-triangle impostors that replace them past 95 m | 432–656, 563 mean / **4** |
| `bushes.js` | Four shrub forms — three of them pure cards, one a multi-stem | 4–24, 11 mean |
| `rocks.js` | Fractured convex boulders, slabs and scree in three size classes | 20–80, 59 mean |
| `ground.js` | The terrain's three-channel detail texture and its material patch | — |

`trees.js` and `bushes.js` used to be listed here as "the obvious next two, and
they do not exist yet", with `CHUNK.trees` switched off because the Quaternius
models were 1,700–2,900 triangles each. Both now exist, both are grown from
code, and the switches (`TREES.enabled`, `BUSHES.enabled`) are on. See §4.11.

### ⚠ `engine_sim/` is a broken submodule — read this before cloning

The parent repo tracks `engine_sim` as a **gitlink** (mode `160000`, commit
`461ad03`) but **there is no `.gitmodules` file**. A fresh clone therefore gets
an empty `engine_sim/` directory with no URL to fetch from, and
`powertrain.js`'s `import ... from '../engine_sim/src/engine-sim.js'` 404s. The
game does not boot from a clean checkout.

Three-way drift, all of it unresolved:

| | state |
|---|---|
| Parent repo pins | `461ad03` |
| Upstream `main` (github.com/YigitSalihEmecen/Engine_Sim) | `188c19a`, two commits ahead |
| Local working tree | `461ad03` + uncommitted local edits |

Upstream is API-compatible with the bridge **except** two things, both of which
fail silently rather than loudly:
- `powertrain.js` reads `this.sim.comp` to set the compressor. Upstream replaced
  it with a three-band `sim.dynamics`. The access is guarded, so on upgrade the
  high-rpm harshness taming simply stops applying.
- `cars.js:ENGINE_OPTIONS` is missing the five engines upstream added:
  `vtwin`, `rotary2`, `i6diesel`, `v6tt`, `v8tt`.

Fixing the submodule needs a decision about the uncommitted local edits, so it
has deliberately been left alone.

---

## 2. Boot and frame flow

### Boot (`main.js:boot()`)

1. `createScene(container)` — renderer, camera, lights, post chain.
2. `RAPIER.init()`, then a world at `WORLD.gravity` with `timestep = 1/120`.
3. `createTerrain(seed)` → the noise chain. `new RoadPath(terrain, seed)`.
4. `new ChunkManager(...)`, then `preload(START_S)` and one `world.step()` so
   colliders exist before the car is placed.
5. Load tree OBJs and the 9 car FBXs (progress bar on `#boot`).
6. Build the garage UI (`buildGarage`) and seed box (`buildSeedBox`).
7. On "Drive": construct `RaycastVehicle`, start `Powertrain` (this is the first
   `AudioContext` touch and **must** be inside the user gesture), hand that same
   context to `Wind`, wipe the tyre marks, begin `loop()`.

### Frame (`main.js:loop()`)

```
rAF
 ├── input.update(dt)
 ├── _handleActions()        one-shot keys — gear, camera, headlights, recovery
 ├── powertrain.update(...)  → drive force at the contact patch
 ├── accumulator += dt
 ├── while (accumulator >= h && steps < maxSubSteps)   h = 1/120
 │      vehicle.beginStep()      snapshot prev pose; clamp runaway velocity
 │      vehicle.update(h, input) suspension + tyre impulses applied HERE
 │      world.step()
 │      accumulator -= h
 ├── vehicle.syncVisuals(accumulator / h)   render interpolation
 ├── carS = path.projectPoint(...)          arc-length position
 ├── chunks.advanceTime(dt)                 the wind in the grass
 ├── chunks.update(carS)                    stream in/out, 1 chunk per frame
 ├── fx.update(dt, vehicle)                 tyre smoke and rubber
 ├── wind.update(dt, forwardSpeed)          air noise over the body
 ├── traffic.update(dt, {s, v, speed, flashing, vehicle})
 ├── camera.update(dt, vehicle)
 ├── hud.update(...)
 └── render
```

`fx.update` reads the wheel state the substeps just wrote, so it has to come
after the loop and before anything renders. Both it and `wind.update` are inert
on the title screen — the car is parked and nothing is slipping — so neither is
gated on `active`, which is one less state to keep in step.

**The ordering is load-bearing.** Vehicle forces are integrated *inside* the
substep loop, immediately before each `world.step()`. Applying them once per
rendered frame instead produces a car that behaves differently at 60 Hz and
144 Hz. `input.endFrame()` runs last — see the bug ledger for why.

`traffic.update` receives the whole `vehicle`, because impact resolution applies
an impulse to its body directly.

---

## 3. The single most important idea: road space

Terrain is **not** generated in world space and then had a road draped over it.
It is generated in road space and then mapped out to the world.

Every terrain sample is parameterised as:

- `u` — arc length along the road centreline (metres travelled)
- `v` — signed lateral offset from the centreline (metres left/right)

This makes carving trivial. "Flatten near the road" becomes a 1D blend on `|v|`,
which is a function of one variable instead of a distance-to-spline query. Cut
and fill become a single clamp:

```
y = clamp(natural, roadY − fillSlope·d, roadY + cutSlope·d)
```

implemented in `chunks.js:sampleGround()` with `smin`/`smax` instead of hard
`min`/`max` — see bug #17, and note that **the blend width is not a constant**.

### The fold guard (`chunks.js:foldSafeOffset`) — REWRITTEN, and it was broken

Rows of vertices radiate perpendicular from the centreline. On a bend the rows
on the inside converge and eventually cross, folding the mesh inside out. They
meet at the centre of rotation, at radius `R = 1/|curvature|`.

The guard compresses the inside so it can never reach `R`. Two things about it
changed, and both were load-bearing.

**1. The mapping.** It was `v' = L·(1 − e^(−|v|/L))`, `L = 0.7·R`. An exponential
starts bending *immediately*: at `|v| = 0.35·L` it has already taken 16% off. So
a road that is all but straight still had its far corridor squeezed — and since
`L` is inversely proportional to curvature and a straight has curvature wandering
through zero, two rows 2.5 m apart could carry a 2.8 km radius each way, both
"straight" by any reading, and the guard would leave a far column alone on one
row and pull it **87 metres** inboard on the next. That is a sheared sheet, and
what it looks like on screen is chunks that do not line up.

It is now a soft minimum instead of an exponential approach:

```
v' = |v| / (1 + (|v|/L)^p)^(1/p),   p = 6
```

Same guarantees — strictly increasing, strictly below `L`, C-infinity — but the
correction is O((|v|/L)^p), so it is numerically invisible until `|v|` is a real
fraction of the radius, and its sensitivity to curvature falls with the *fifth*
power of it instead of the first. The same pair of rows now disagree by 0.1 m.

**2. The curvature it is given.** `frame.curv` is measured over ±10 m, which is
right for banking and wrong here: the quantity that decides whether the mesh
folds is the rate at which one row's frame rotates into the NEXT row's, and
nothing else. A smoothed estimate under-reports it, which relaxes exactly the
limit the guard exists to enforce. Measured across five seeds, the far corridor
had been folding through itself in **1,240 to 4,353 cells per seed**, with the
worst row spacing at **minus 54%** of nominal — a sheet turned inside out, drawn
back-to-front, with garbage normals. It had been doing that since the guard was
written.

`path.js:_buildFoldLimits` now derives `frame.foldL` and `frame.foldR` from the
actual frame-to-frame rotation, as a **running maximum over ±25 m, split by
sign**. Running-max because the frame-to-frame rate is the noisiest estimate
there is and its output is a lateral position hundreds of metres out, so noise
becomes shear; a sliding-window maximum is conservative, continuous, and holds
its value across the window so spikes become plateaux. Split by sign because the
guard is ONE-SIDED and must stay that way — only the inside of a bend folds, and
compressing both sides would end the world 115 m away on the outside of a
hairpin.

Measured after: **0 inverted cells** on five seeds, minimum row spacing exactly
29% of nominal, which is the 0.7 margin by construction.

### The foreign-road clamp — bug #55, fixed properly this time

A chunk carries terrain to `CHUNK.halfExtent` (700 m) either side while being
`CHUNK.length` (120 m) long. Where the route doubles back inside 700 m — which a
router that follows contours does readily — one chunk's sheet covers another
chunk's road, and over there it is uncarved hillside standing on a carriageway.
`ROUTE.selfClear` cannot fix this: it keeps the two carriageways 300 m apart and
the sheets are 700 m wide.

`sampleGround` therefore also clamps against **other passes of the road**:
`path.foreignSegments(s, x, z, range, out)` returns control-point segments whose
arc length is more than `ROUTE.selfNear + 120` away, the minimum over them of a
gentle cut plane is taken, and the sheet is pushed under it.

Three details, each of which was a wrong answer first:

- **Segments, not points.** Control points are 46 m apart, so a place standing on
  the foreign carriageway can be 23 m from the nearest of them, and at the road's
  own 62% cut slope that is 2.7 m of terrain left over the road — exactly the
  step this was written to remove.
- **A 10% slope and a 4 m sink** (`CHUNK.foreignSlope`, `foreignSink`), not the
  road's own 62%. The sheet doing the cutting has 34 m columns out there, and the
  mesh draws the CHORD across a V-shaped clamp: chord error is roughly
  slope × spacing / 2, which at 62% is 17 m of terrain still standing.
- **One smooth minimum, with `k` tied to the gap.** Smoothing inside the loop
  compounds — thirty segments each conceding k/4 is nine metres quietly removed —
  and a `if (lower) blend` guard steps by k/4 the moment it engages. Worse, a
  FIXED blend width concedes k/4 unconditionally on the carriageway, where
  ceiling, floor and result are all the same plane: measured, **0.875 m of trench
  down the middle of the road**, met at 175 km/h as a 1361 m/s² hit with all four
  wheels on the ground. That is trap #6 for the second time.

Measured after: **0 steps over 30 cm across seven seeds**, where the default seed
had 779.

## 4. Subsystem detail

### 4.1 Noise chain (`noise.js`)

`createTerrain(seed)` returns `base`, `height`, `roadElevation`, `region`,
`forestDensity`, `mask`, `continent`, and three scalar accessors. The chain, in
order:

1. **`makeGradNoise`** — gradient noise returning value *and* both analytic
   derivatives, quintic interpolation. The derivatives are the point.
2. **`fbm`** — standard octave sum.
3. **`erodedFbm`** — Quilez's `morenoise`: each octave's contribution is damped
   by the accumulated gradient, `a += amp·n / (1 + k|Σd|²)`.
4. **`ridgedFbm`** — the fold is **softened**: `r = 1 − √(n² + 0.004)`, not
   `1 − |n|`. See bug #24; the hard fold is a C1 discontinuity per octave and it
   is where knife-edged ridges came from.
5. **`domainWarp`** — samples the field at a position displaced by another field.
6. **`archetypes`** — six landform generators (`plainsH`, `hillsH`, `valleyH`,
   `mountainH`, `canyonH`, `plateauH`) blended by an exponential kernel over a
   2D archetype space. Centres sit on a circle of radius 0.52.
7. **`continent`** — the surface all six of them sit on. New; see below.

**THE CONTINENTAL TERM is what stops the world averaging to zero.** Every
archetype is a field with a mean, so blending six of them gives a field with a
mean: however dramatic the local shape, drive far enough and the ground comes
back to where it started. A climb is always paid for by a descent, and the road,
which follows the ground, inherits exactly that — it can never simply go up for
five minutes. Real topography has two scales of relief: landforms sit on a
continental surface whose wavelength is longer than anything visible from the
ground, and you do not perceive it as a hill, you perceive it as having spent
twenty minutes climbing.

So: two octaves at 11 km and 5.5 km, ±340 m, added underneath everything.

- The **wavelength** is measured against how far the road TRAVELS, not how far it
  drives. A routed alignment covers roughly 0.4 m of ground per metre of tarmac,
  so 18 km of driving is about 7 km of map. At the 19 km this started at, a whole
  session barely turned the field over: 106 m of total elevation change over 18 km
  of road. At 11 km the same drive gives 123–348 m, with sustained climbs of
  2.6–3.4 km gaining 66–111 m and giving none of it back.
- The **amplitude** is bounded by `ROAD.maxGrade`. 340 m over a 5.5 km half-cycle
  is a mean gradient near 6% against a 9.5% limit, which leaves the alignment room
  to traverse instead of being pinned to the clamp. Past that the router
  saturates and the extra height buys earthwork rather than scenery.
- It is evaluated at **full octave depth, always** — `lodOct` is saved and
  restored around it. Everything else fades its finest octaves with the mesh's
  lateral resolution, which is right for detail and catastrophic here: at this
  amplitude a 20% change in an octave's weight between one column and the next is
  metres of height, and the columns out there are 34 m apart.

**Landform amplitudes were roughly tripled** with it. `mountainH` is now 620 m of
ridge over a 150 m bulk, with the ridged field pushed through a smoothstep before
scaling so most of a mountain region is flank and valley and only the crests
reach the top of the range — a linear map spends its height budget on the middle,
which is what made a "mountain" look like a plateau with texture on it. `hillsH`
went 66 → 105, `valleyH`'s trough 62 → 128.

**The archetype kernel was tightened**, `SIGMA2 = 2·0.245²` from `2·0.30²`. At the
old width the winning archetype held about 0.66 of the blend and its two
neighbours a fifth each, so a mountain region was two-thirds mountain and a third
something flatter — an averaging that acts exactly like turning the amplitude
down, and a large part of why the world read as "everything, mildly".

**Octave budget (LOD).** `base(x, z, octaves)` sets a closure variable that every
fBm variant reads, fading its last octave in and out rather than dropping it.
`height(x, z, lateral)` derives the budget from the mesh's own lateral
resolution — 8 octaves on the road, 3.2 at the corridor edge — because the
columns out there are far apart and the base field's finest wavelength is short.
Sampling a 7 m feature every 34 m is aliasing, and aliased gradient noise reads
as spikes, not as distant detail.

Measured route character, before → after (four seeds, `probe/route.mjs`):

| | before | after |
|---|---|---|
| sidehill share | 29% | 51% |
| corridor drops over 12 m | 1–14% | 30–46% |
| earthwork | 3.9 m | 9.4 m |
| grade p95 | 5.5% | 5.7% |

`ROUTE.wEarthwork` went 2.4 → 6.0 to pay for it. The budget (`earthFree`) is
unchanged at 7 m; what changed is that in country with 600 m of local relief the
router now MEETS it everywhere, so the slope of the penalty past it is what
decides whether it traverses a hillside or bulldozes across it. At 2.4 it
bulldozed — 11.2 m mean earthwork, a motorway cutting for most of the drive.

### 4.2 Road path (`path.js`) — the alignment is ROUTED, not wandered

A `CatmullRomCurve3` through control points generated one at a time
(`_addControlPoint`), constrained by `ROAD.maxCurvature`, `maxGrade` and
`maxGradeChange`.

**Each point is CHOSEN.** The generator fans out `ROUTE.candidates` legal
headings, scores the span each would create, and commits to the cheapest — the
approach in Galin et al., *Procedural Generation of Roads* (CGF 2010), reduced
from a global anisotropic A* to a greedy lookahead because this world is
infinite, streams, and has no destination to route to. O(1) per control point.

Elevation is an **output**, not an input: the router aims at the natural surface
(the balanced cut-and-fill line on a hillside) and clamps to a legal profile.
The old generator chased `terrain.roadElevation`, a 30 m disc average, which
oversmooths — it floats the road over dips and buries it in rises, and both are
earthwork.

Three things about the cost function are worth knowing before touching it:

- **Earthwork is a BUDGET, not an objective** (`ROUTE.earthFree`). Minimising it
  outright works exactly as advertised and finds the boring routes: measured, it
  cut earthwork 6.4 → 4.9 m *and* cut sidehill cross-sections 12% → 8%, because
  the cheapest place for a road is a flat field. It now costs nothing up to a
  threshold and bites hard past it, which leaves the interest terms free to
  decide.
- **`wBearing` is what stops it spiralling.** A contour line around a hill is a
  circle. Without a slowly drifting compass to follow, a router that likes
  contours goes round and round. Swept: 5 took one seed's net progress to 0.07.
- **`selfNear`/`selfFar`/`selfClear` are STRUCTURAL, not stylistic.** See bug
  #55 — every chunk carries terrain 700 m either side while being 120 m long, so
  two stretches of road passing near each other have sheets that disagree about
  whose ground it is. They no longer have to be a complete defence: the terrain
  now clamps against foreign road as well (§3), so a doubling-back is a cosmetic
  problem rather than a wall across the carriageway.

`probe/route.mjs` measures all of it: shelf share, earthwork, curvature, and the
self-clearance invariant.

**THREE WINDOWS, NOT ONE.** `_buildFrames` measures over `CURV_WINDOW` = ±10 m
and `_buildFoldLimits` over `FOLD_WINDOW` = ±25 m, and mixing them up costs real
things in both directions:

- `tan`, `right`, `up`, `bank` and `curv` all come off the SHORT window.
  Widening it was tried and reverted: banking is `curv · bankGain`, and a bank
  that lags the corner is worse than no bank at all — through an S-bend the
  smoothed curvature still says "left" while the road has gone right, and the
  cross-slope throws the car off the outside. Measured, it took one seed's worst
  lane error from 5.8 m to **16.8 m**.
- `foldL` / `foldR` come off the LONG window, as a running maximum of the
  frame-to-frame rotation, split by sign. Only the terrain fold guard reads them,
  nothing the player can feel is derived from them, and a guard lagging a corner
  by 25 m costs nothing. See §3.

Key methods:
- `frameAt(s, out)` → position, tangent, normal, right, curvature, `foldL`,
  `foldR`, bank, cover, and `s`. **Pass `out`** — it allocates a frame otherwise,
  and it is called several times per car per frame.
- `foreignSegments(s, x, z, range, out)` → control-point pairs belonging to a
  different pass of the road. Backs the terrain's foreign clamp; see §3.
- `projectPoint(pos, sHint)` → arc length, searched in a window around the hint.
- `lateralOffset(pos, s)` → signed `v`.

`ensureLength(sTarget)` extends the spline lazily as you drive.

### 4.3 Chunks (`chunks.js`) — the biggest file

One chunk = `CHUNK.length` (120 m) of road plus terrain out to
`CHUNK.halfExtent` (700 m) each side. `update(carS)` keeps `CHUNK.behind` (2)
and `CHUNK.ahead` (6) alive and builds at most `buildPerFrame` (1) per frame.
Measured build cost **20 ms** per chunk, down from 34–58 ms.

Build order inside a chunk:
1. `path.ensureLength(s1 + ROUTE.selfFar)` — the foreign clamp asks about road
   1600 m AHEAD, and an answer that depends on how much of the route has been
   generated is not a pure function of position (trap #10). Routing is greedy and
   deterministic, so extending it early changes nothing about where it goes; it
   only makes the question answerable.
2. `_buildTerrain` — the ground mesh.
3. `_buildRoad` — the ribbon and its painted lines. Lane markings are a lateral
   profile of coloured bands, not a texture — that is why they never stretch.
4. `_buildProps` — trees (currently off). Cluster-seeded, not Poisson.

Ground cover and stone are NOT part of the build. They have a shorter lifetime
than the chunk that holds them, so they are streamed separately — see §4.14.

**GHOST ROWS.** `_buildTerrain` samples one row past each end of the chunk,
computes normals over the extended mesh, and keeps only the interior. This
replaced `_seamNormals`, which re-derived the boundary normal analytically from
central differences of `sampleGround` — and the two are not the same answer.
Every interior vertex gets the area-weighted average of its six adjacent
triangles; an analytic tangent plane agrees with that only where the surface is
locally flat, and out where a cell is 34 m across the ground is not. So the seam
row was shaded differently from its own neighbours, on both sides, and the world
grew a subtly mismatched line across it every 120 m. It fed `_colorTerrain` too,
so the seam was a colour boundary as well as a shading one. With ghost rows both
chunks agree because both evaluate the same function of position, not because two
derivations were tuned to match.

**The far column spacing cap went 55 m → 34 m.** 55 m was right for a world whose
mountains topped out at 300 m; they now reach past a kilometre, and a hillside
three times as steep sampled at the same spacing is three times the angle between
neighbouring faces. Eleven percent more terrain vertices.

Three functions deserve special attention:

- **`sampleGround(frame, rightFlat, v, out)`** — the cut-and-fill clamp, plus the
  foreign-road clamp (§3). The shoulder ramp is `t²/(t + shoulderRound)`, which
  starts with *zero* slope at the verge. **Both** smooth clamps take
  `k = min(slopeBlend, (ceiling − floorY)·0.25)` — tied to the gap they are
  blending, so on the carriageway (where ceiling and floor are the same plane)
  they degrade to exact min/max. Bug #17 is what happens when the first one does
  not; bug #57 is what happens when the second one does not.
- **`meshGroundPoint(s, s0, s1, v, out)`** — interpolates the whole position
  across the actual rendered triangle. Props placed with this sit exactly on the
  visible surface; props placed with `sampleGround` float or sink.
- **`_gatherForeign(frame)`** — refreshes the foreign-segment list for the row at
  `frame.s`. It is a CACHE keyed on `s`, not state: anything sampling out of row
  order pays for a re-gather and gets the identical answer, which is what keeps
  chunk seams exact.

`groundAt(s, v)` is the cheap query used by traffic, respawn and the recovery
check.

**Colour** (`_groundColor`) is now nine palette entries, not five, and the
altitude cue is height above `terrain.continent(x, z)` rather than above zero —
the map itself rises and falls by hundreds of metres, so an absolute ramp painted
whole regions at the top of it. Two mottles at different scales (≈70 m and
≈350 m) put patches inside regions rather than grading across them; dry
sun-bleached ground is weighted toward higher, flatter sites; scrub takes over
where grass cannot hold; snow needs both altitude AND a flat enough face, because
snow on a vertical wall is the giveaway that a palette is keyed to height alone.
The grass takes its instance colour from this same function, so it can never
disagree with the ground it stands in.

### 4.4 Tunnels — REMOVED

Gone, deliberately and completely. `chunks.js` lost ~400 lines (1755 → 1362),
`path.js` ~80 (410 → 331), `config.js` eleven keys, and four probes were deleted
outright (`roof`, `skyleak`, `tunmesh`, `marks`).

What survived, because the questions were never really about tunnels:

- `probe/surface.mjs` (was `tunnel.mjs`) — is the carriageway drivable end to
  end? Still the guard against a terrain change burying the road.
- `probe/cliff.mjs` — longitudinal steps in the terrain sheet.
- `probe/xsec.mjs` — cross-sections, now the fastest way to read what an
  alignment is doing.

Deep cuttings are what the cut-and-fill clamp produces where a tunnel would have
been, and they look fine. Bugs #10, #18, #19, #20, #27, #28, #29, #35 and #36
were all tunnel bugs; they are history, not live traps.

### 4.5 Vehicle (`vehicle.js`)

One dynamic rigid body. Four rays cast straight down from anchor points.

- **`_suspension`** — Hooke plus damping, per wheel, damping computed from the
  compression *rate* between substeps.
- **`_antiRoll`** — couples left/right wheel loads per axle; `cars.js` derives
  the bar rate needed to hit a target roll angle.
- **`_tyres`** — slip-angle Magic Formula, `Fy = D·sin(C·atan(B·α))`, with a
  friction circle limiting combined force and a low-speed blend to plain
  velocity-cancelling.
- **`_updateSteering`** — steering is limited by grip *and* by rollover:
  `δ_max = atan(L·a_max/v²)` where `a_max = min(μ·(g + downforce·v²/m), SSF·g)`.
  This is why the Monster Truck understeers and the Sport does not. **But that
  derivation assumes a steady-state turn**, and once the car is sideways it does
  not hold: the front wheels are being pointed down the velocity vector, not
  used to make more lateral force. Enforcing it anyway capped the lock at
  4.3° at 108 km/h, so a slide could not be caught — measured, countersteer took
  3.96 s to arrest a spin and the car went round. The lock now opens toward full
  as the chassis slip angle grows (`slideOpenFrom`/`slideOpenTo`); recovery is
  **0.68 s**, and the tall vehicles are unaffected because a saturated tyre does
  not make more lateral force just because the wheel is turned further.
- **`_stability` slide containment** — a yaw damper faded in between
  `driftAngle` (29°) and `spinAngle` (60°) of chassis slip. Below the first it
  does nothing at all, and the tyres peak around 7° of slip, so ordinary
  cornering and a held drift are untouched; past the second a spin decays
  instead of being unrecoverable. It is now a small part of the recovery — see
  bug #41.
- **Yaw inertia is inflated 1.6×** in `_buildBody`, the same way roll already
  was. A solid box implies a yaw radius of gyration of 0.29·length; real cars
  measure 0.35–0.40 because the mass is at the ends. This is the largest single
  contributor to the car feeling like it has weight.
- **`syncVisuals(alpha)`** — interpolates pose between the last two physics
  states. Took render jitter from 146 mm to 0.3 mm.
- **`beginStep()`** — snapshots the previous pose *and* clamps chassis velocity
  to `VEHICLE.maxChassisSpeed` (100 m/s) and angular velocity to 12 rad/s.
- **`steerLimit` is published.** `_updateSteering` writes the lock actually
  available this frame, because `input.steer` is a NORMALISED command — full
  stick is full available lock, which is right for a human and a factor of six
  out for anything computing an angle. See §7's harness note; getting this wrong
  looked exactly like the world being broken.

**Ray filtering.** `EXCLUDE_SENSORS` plus a group mask
(`(0x0001 << 16) | 0xfffd`). Both are now belt-and-braces: with traffic carrying
no colliders at all there is nothing for a suspension ray to find but terrain.
They are kept because they cost nothing and the bug they prevent has arrived
twice by different routes.

### 4.6 Cars (`cars.js` + `assets.js`)

Nothing about a car is hand-tuned. `assets.js:buildCarFromObject()` measures the
loaded FBX — wheelbase, track, wheel radius, body height, CoM height — and
`cars.js:buildCarParams(spec, metrics, base, gravity)` synthesises spring rates,
damping, anti-roll bar rate, and steering limits from those measurements plus a
handful of character values in the roster (`grip`, `mass`, `power`).

Roster (9): `sport`, `muscle`, `classic`, `hatchback`, `police`, `pickup`,
`van`, `military`, `monster`. 10 body colours, 13 second colours, 17 engines.

**Two paint slots, both discovered rather than declared.**
`assets.js:rankPaintCells` orders the atlas cells the bodywork uses by surface
area. The largest is the paint; the second largest is the car's other colour,
which is the thing that used to be stuck at whatever the artist chose (bug #44).
Its default is sampled straight out of the atlas image through a 2D canvas, so
`CAR_TRIM_COLORS[0]` — `stock`, `hex: null` — leaves each model looking exactly
as it did. `probe/paint.mjs` counts what lands in each slot.

**Traffic clones share the roster's materials** (`traffic.js:_instance`), and
always has. Painting the player's Sport therefore repaints every Sport in
traffic. Pre-existing, not a regression, and it has not been treated as one.

**There is no torque tuning here.** `engine_sim` owns the curve, the clutch and
the shift logic; the roster's old `peakTorque` / `peakTorqueRpm` and the derived
`idleRpm` / `shiftUpRpm` / `shiftDownRpm` had been dead since the simulator took
over and are gone.

### 4.7 Powertrain (`powertrain.js`) — the engine_sim bridge

`engine_sim` is **used unmodified**. The bridge works by overriding one method
per instance:

```js
dt._stepVehicle = () => { dt.ww = this._ww; };
```

The game feeds it wheel omega; it returns propshaft torque `Tp`, which becomes
force at the contact patch. So the engine is not a sound effect layered on top
of a separate physics model — it *is* the drivetrain. Gearing, clutch slip,
and engine braking all fall out of it for free.

**Two things the bridge has to correct, both consequences of that override.**

- `_launchFloor` — because `_stepVehicle` is overridden, the drivetrain never
  sees the load on the wheels, only that wheel speed is not rising. Its launch
  controller regulates on road speed, so a car that cannot get going leaves the
  clutch half open forever. Below 7 m/s, in first, the host asserts a floor of
  `0.72 × peakTorque × throttle` through the gear. See bug #42.
- `_retuneLaunch` — engine_sim computes `launchRate` once in its constructor
  from whichever preset it was built with and neither `setVehicle` nor
  `setEngine` revisits it. Both it and `launchFlareRpm` are read live, so the
  bridge writes them per car. Bug #43.

**`mix.mechanical` is 0.** That layer is band-passed pink noise standing in for
valvetrain clatter and block resonance; at driving volume it is broadband hiss.
Clunks and lash live on `transients`, which stays. The slider is gone from the
drawer too — see settings.js.

### 4.8 Traffic (`traffic.js`) — rewritten; read the file header

**There are no traffic rigid bodies and no traffic colliders anywhere.** A car
is `(s, v)` on the spline, a speed, and a mesh. This is the whole design and it
is a deliberate reversal of everything the file used to do.

Why: a body driven by writing its velocity has effectively infinite mass, so the
solver's contact impulse is never consumed and compounds. The measured history
is in the ledger — 6920 km/h, a 35 m vertical ejection, several-hundred-m/s
wrecks, and after each patch, cars that simply stopped and sat there. Each fix
bounded the damage without curing it, because the object still had two masters.

States: **cruising** (`spun === 0`), **spun out** (`spun > 0`, scripted), and
**dead** (`spun < 0`, despawned next pass).

- `_targetSpeed` — car-following with a time headway, corner speed from
  `√(a/κ)`, and awareness of the player behind (yields when flashed, speeds up a
  little when tailgated).
- `_separate` — asserts minimum spacing directly. Because nothing is simulated,
  overlap can be made *impossible* rather than unlikely.
- `_resolvePlayer` — two boxes in road space; response is the closed-form
  impulse `j = −(1+e)·(v_rel·n)·m₁m₂/(m₁+m₂)`, applied to the player and nowhere
  else, capped at `TRAFFIC.maxImpactDv` (11 m/s). Energy cannot be injected: the
  impulse always opposes the approach, by construction.
- `_spinOut` / `_advanceSpun` — the struck car slews toward the verge, rotating
  and slowing, then leaves. It never stops in a live lane and never needs a
  velocity clamp.
- Spawning happens beyond `TRAFFIC.spawnMin` (460 m), where fog and depth of
  field have taken the car. Nothing spawns behind.

### 4.9 Modes and scoring (`score.js`)

Two modes, chosen on the title screen. **Zen** disables traffic entirely
(`traffic.setEnabled(false)` despawns everything and the update early-returns).
**Traffic** scores near misses and ends the run on the first collision.

`traffic.js:_trackPasses` watches each car through its whole encounter and
reports the *minimum* clearance once the car is astern, rather than sampling
whatever gap happened to exist on the frame the two were level — at 250 km/h
against oncoming traffic two cars can go from ten metres apart to ten metres
past inside a single frame, so a per-frame sample would make the reward depend
on frame rate.

`ScoreRun` turns those into points: closer pays more, oncoming pays
`SCORE.oncomingBonus` (2.4×) because it arrives at the sum of both speeds, and
consecutive passes build a multiplier that decays unless refreshed. The chain is
*refilled*, not extended, so a late pass is worth as much as an early one and
there is never a reason to hold back. A cooldown stops two cars abreast paying
twice for a single decision.

The module owns no DOM and no game state beyond the run, which is why
`probe/score.mjs` can exercise the whole mechanic without physics.

### 4.10 The title screen is the ROAD, and the camera is solved against the DOM

There is no `showroom.js` any more. The title screen orbits **the real vehicle,
parked on the real road at `START_S`, in the real scene** — so what you choose is
exactly what you drive, paint and all, because paint is a live material property
and there is no second copy of the model anywhere to disagree with it.

This has now been answered both ways and it is worth recording why it landed
here. The road WAS the wrong backdrop once: the orbit faced the anti-sun side of
the sky dome and the whole title screen came out navy, which is what a separate
studio scene was built to fix. The studio fixed the light and lost the point.
What actually fixes the light is standing somewhere the light already is:

- **`_seedOrbit` picks the lit side.** `TITLE.angles` is the four three-quarter
  views a car is photographed from; the rig starts on whichever of them faces
  `ATMOSPHERE.sunDir`. That is a two-line replacement for a whole scene.
- **The framing is measured, not tuned.** `#stage` is an empty measured
  rectangle in a CSS grid — a hole in the interface — and `camera.frameTitle`
  is handed its `getBoundingClientRect` every frame. `_updateTitle` solves the
  distance that fits the car's own DIAGONAL into it (three-quarter on is where a
  silhouette is widest; fitting the length alone frames it beautifully side-on
  and runs it off both edges a second later) and the aim that centres it there.
  Add a drawer, rotate the device, open it on a tablet: the framing follows the
  thing that changed. A hand-tuned distance did not, and bug #53 is what that
  looked like.
- **It corrects on BOTH axes**, along the CAMERA's right and up vectors rather
  than the world's, because the rig orbits. Aiming one way moves the subject the
  other, which is why the horizontal term is negated and the vertical one is not
  — screen Y counts downward while world Y counts up.
- **The aim offset is NOT the damper's state.** `this.lookAt` is what the damper
  reads back; adding a per-frame offset to it multiplies that offset by
  `1/(1 - e^(-k·dt))` — 3.4x at 20 fps and 9x at 60 — and puts the car off
  screen entirely. `this._aim` is the offset copy, and `camera.lookAt(_aim)` is
  the only thing that ever sees it.
- **Leaving is a FLY-IN, not a cut and not a damp.** `beginIntro` interpolates
  from the orbit pose into the chase pose over `TITLE.introTime` (1.35 s) while
  the overlay fades out underneath, so the transition reads as one move rather
  than as a menu closing and a camera starting. Damping cannot do this: its rate
  is tuned for a camera already roughly where it belongs, and asked to cross
  fifteen metres it either takes several seconds or arrives with a snap. A
  fixed-duration double smoothstep leaves at rest and arrives at rest.
  **Controls are live from frame one** — a second of a car that will not respond
  is a second of a game that looks broken, and the chase goal is recomputed every
  frame, so pulling away during the fly-in just moves where the camera is flying
  to.
- The fly-in belongs to the Drive button and to nothing else. See bug #65 and
  `camera.snap()`.

The simulation keeps running underneath: the car still settles, the engine still
idles for the throttle blip, chunks still stream. Only the presentation changes.

### 4.11 Foliage (`foliage.js` + `env/trees.js` + `env/bushes.js` + `chunks.js`)

**ON.** This section used to open with "`CHUNK.trees` is OFF" and a paragraph
explaining that 468 Quaternius instances cost **1,030,000 triangles** — 90% of
the geometry on screen against 109,000 for the terrain sheet — to buy 10.3 trees
a hectare where real woodland carries 200 to 1,000. It said the way out was
"impostors for distant trees, rendered once per species at boot, which is what
makes thousands affordable where hundreds were not". That is what is here now.

**Measured: 232,000 triangles of canopy and understorey alive at once**, against
109,000 of terrain sheet — a bit over twice it, and about a fifth of what the
models cost for a tenth of the trees.

#### The three files

| file | owns |
|---|---|
| `foliage.js` | what a species IS: its form parameters, its habitat, and `vegetation()` |
| `env/trees.js` | turning form parameters into triangles; the atlases; the material |
| `env/bushes.js` | the same for four shrub forms; it borrows the tree material |
| `chunks.js` | where things go — the only part that needs the road and the streaming |

#### Two tiers, and two lifetimes

Trees are drawn twice and the shader picks:

- **near** is grown geometry — a queue-based branch recursion swept into
  tapering tubes, leaf mass hung on the tips as crossed cards. 432–656
  triangles, 563 mean.
- **far** is a four-triangle impostor carrying a painted silhouette of the
  species.

They cross-fade **by scale**, in the vertex shader, over `TREES.lodFade`
[55, 95] against `TREES.farFadeIn` [45, 80] — the windows overlap so a tree is
never both gone as geometry and not yet there as a card. Identical mechanism to
the two ground-cover tiers (§4.14), and the same program cache key.

The two also have different LIFETIMES, which is separate from the fade and just
as important. A near tree is resolvable to 95 m; its chunk reaches 720 m ahead.
Building both with the chunk submitted **520,000 triangles to draw 110,000 of
them**, the rest scaled to nothing and still costing a vertex each. So
`_buildProps` runs the scatter once, builds the impostors and the shrubs
immediately, and caches the near tier's matrices on the chunk as
`chunk.canopySpec`; `_updateCanopy` turns that into InstancedMeshes over
`TREES.behind`/`ahead` (one either side) as the car arrives. **The recipe is
computed once on purpose** — two tiers from two runs of a seeded scatter would
agree until the first time anything about the sampling changed, and then a tree
would stand in a different place from its own impostor.

#### Nine species, and why nine

Chosen to be distinguishable **at distance**, which is a stronger requirement
than being different close up: a narrow spire, a skirted cone, a broad dome, a
warm round head, a weeping curtain, a column, a tall pale egg, a bare armature.

| species | form | habitat |
|---|---|---|
| `pine` | clear stem, crown in the top two thirds | high, dry, gregarious |
| `spruce` | branches to the ground, dense cone | higher, rugged |
| `oak` | short thick stem, hard fork, wide dome | lowland, solitary |
| `maple` | dense round crown, warm red-orange leaf | settled mid ground |
| `birch` | slender, pale bark, high crown | anywhere mid — the pale mass |
| `willow` | `growth.dir.y` NEGATIVE — the whole difference | damp, low, gentle |
| `poplar` | children at 0.42 rad; a column | lowland, damp |
| `aspen` | tall pale egg of gold, high and dry | higher, drier mid slope |
| `dead` | bare, gnarly, twig cards only | above the tree line |

Four shrubs: `bramble`, `hazel` (fringe species), `gorse`, `heather` (open
ground). `SHRUBS` and not `BUSHES` in `foliage.js`, because `BUSHES` is the
config block.

#### `vegetation()` — one field, three densities

This is the centre of the file and the answer to "intentional placement". It
returns `{canopy, understorey, ground, edge, moisture, rugged, stand}` from one
evaluation, so the three scatters **cannot disagree**: grass thins where the
canopy closes because it is told to by the same number that put the canopy
there. Before it, trees were placed on a stand mask and grass was placed over
every square metre the slope test allowed, and a clearing and a thicket carried
identical sward.

Signals: `terrain.forestDensity` (stands with clearings), a moisture field
biased wet in the hollows, RELIEF above the local continental surface (not
absolute height — 400 m is a summit in one place and a valley floor in another),
slope, and `terrain.region`.

And one derived signal that earns its own name:

> **EDGE** = `4c(1 - c)` on the canopy density. It peaks where the canopy is
> half closed — the woodland fringe, which in real ecology is where the scrub
> is. Hanging the bushes on it means a wood grows its own fringe, and a fringe
> is most of what stops a tree line reading as a wall.

#### Placement

Clustered, not Poisson — and three things make a stand a stand:

1. `TREES.clusterShare` of everything is drawn near one of `clusterCount` seeds,
   Gaussian about it rather than in a flat disc.
2. **A cluster commits to ONE species** (`clusterSpecies` 0.8). Real copses are
   monocultures at that scale; a clump of six different trees is a clump.
3. A seed is REJECTED if the canopy density there is weak, rather than moved.
   The clearings are the point.

`probe/props.mjs` checks the result is lumpy (coefficient of variation > 25%);
a uniform scatter means the field and the clusters stopped doing anything.

#### The cost lesson, twice

The scatter reads the chunk's own terrain sheet — same cell, same diagonal, same
winding as `_buildGrass` — rather than calling `meshGroundPoint`. Asked the
honest way it measured **62 ms per chunk**; reading the buffer it is **3.5 ms**,
and the result is more correct, because a tree is on the surface the renderer
draws by construction. The ground cover's field lookup is memoised on a
10 m × 6 m grid for the same reason: the field's finest feature is 70 m across,
and sampling it per 2.4 m cell cost 14 ms a chunk for resolution it does not
have.

### 4.12 Scene, camera, input, HUD, audio

- `scene.js` — `FogExp2`, a gradient sky, directional sun + hemisphere fill, and
  a post chain: `RenderPass` → `UnrealBloomPass` → radial speed blur → vignette
  → `OutputPass`. **There is no depth of field, deliberately**: it focuses at one
  distance, and with focus pulled toward the horizon at speed the car — five
  metres from the camera — became the most out-of-focus thing on screen. Radial
  blur is the right tool: the centre stays sharp, the periphery streaks.
- `camera.js` — three driving modes (`chase`, `close`, `hood`) plus a `garage`
  orbit for the title screen. `CAMERA.speedRef` was 165 m/s — 594 km/h, past
  anything in the roster — so every speed-dependent term was inert; at 68 m/s
  the field of view now opens by a useful 12° instead of 1.5°.
- **The garage is the real car, in a studio of its own** — §4.10. It is the
  actual vehicle's own `body` and `wheels` groups, re-parented rather than
  cloned, so paint is a live material property and a colour click is immediate;
  picking a car or an engine also blips the throttle, with the gearbox forced to
  neutral so it revs freely instead of bogging against a stopped driveline. The
  first click is what starts Web Audio — it is the user gesture the API
  requires, and it is where the wind starts too.
- `input.js` — keyboard, gamepad, touch (`bindTouch`) and **tilt**. Distinguishes
  held keys from one-shot presses; `flashHeld` drives headlight flash-to-pass.
  It reads `.tbtn` and the `data-hold` / `data-tap` attributes and nothing else,
  so the touch layout can be rearranged in `index.html` without touching it.
- **Tilt steering** (`TiltSteering`) is the phone's own analogue axis, and it
  OVERRIDES the ramp rather than blending with it — the same way the gamepad
  stick does, and for the same reason: an analogue source already carries the
  player's intent every instant, and mixing a ramp into it can only add lag.
  Three parts of it are not obvious and all three have to be right:
  - **which axis** depends on how the phone is held. `gamma` rolls about the
    screen's long edge and `beta` pitches about its short one, and which of them
    means "steer" swaps as the device rotates — so the axis AND ITS SIGN come
    from `screen.orientation.angle`, never from an assumption about landscape.
  - **the zero is wherever the player is holding it.** Nobody holds a phone
    flat. Neutral is captured on the first sample after enabling, and `KeyT` (or
    the ⌾ tap, shown only in tilt mode) recaptures it.
  - **iOS needs permission, from inside a tap.** Safari has gated this behind
    `DeviceOrientationEvent.requestPermission()` since iOS 13; it needs transient
    activation and HTTPS. Same constraint as the audio (trap #12), which is why
    the Settings toggle is the gesture — a first-time player should not meet an
    OS permission dialog on the way into the game. The choice is remembered in
    `localStorage` and re-granted on the next Drive click, which is also a
    gesture. A refusal, a missing sensor and a plain-HTTP page all come back as
    the same `false`; none of them is an error.
  - Dead band 1.5°, full lock at 22° — a wrist, not an arm — with a 1.7 expo so
    the middle of the travel stays fine for lane corrections. A stale sample
    (0.5 s) releases the wheel, and a held arrow button still overrides.
- `hud.js` / `settings.js` — HUD readouts and the settings panel. The panel is
  a NODE, not a place: it is re-parented between the title screen's Settings
  drawer and the pause menu (`Game.mountSettings`). It is a deliberate
  **keyboard trap**: a focused `<input type=range>`
  responds to arrow keys and would steer the car. It carries the engine's six
  voice buses, the two tone controls, the gearbox and camera toggles, and a
  **Wind** slider — which is not one of the engine's buses and gets its own
  control rather than sitting under a heading that says "voice mix" and meaning
  combustion.
- `wind.js` — see §4.18. Shares the powertrain's `AudioContext`, follows the
  global mute, and is the only audio in the project that `engine_sim` does not
  make.

### 4.13 The stylesheet — one scale, no width breakpoints

`index.html` is the whole interface, and its rule is worth stating because it is
easy to undo by accident: **every size is a `clamp()` against `vmin`**, the short
edge of the viewport. A control at 14vmin is a thumb's width on a 390 px phone
and still a thumb's width on a 1024 px tablet, because a thumb is the same size
on both; a pixel breakpoint cannot express that, which is why the file used to
carry three overlapping sets of rules each restating sizes the others had set
(bug #45). `vmin` and not `vw`, so rotating the device moves things without
resizing them.

The only media queries left ask about **orientation**, **pointer** and available
**height** — real facts about how the thing is being held and how much room there
is. There are no width breakpoints.

**THE TITLE SCREEN IS HALF CAR AND HALF CONTROLS, AT EVERY SIZE.** It used to be
a column with the panel pinned to the bottom and the car showing through
whatever was left. That works on a tall screen and fails completely on a short
one: with 390 px of height the dock is 80% of it and the car it exists to help
you choose is behind the panel. Every fix for that is a different layout for a
different screen, which is the road back to bug #45.

So the screen splits in two, and **the split runs across the long axis**.
Portrait puts the car above the controls; landscape — a phone on its side, and
also every desktop monitor — puts them side by side. One rule, stated once: half
the screen is the subject and half is the interface, so the car is never behind
the panel and the panel never has to be told how tall it may be. `#stage` is the
free half, and it exists so `camera.frameTitle` has a rectangle to MEASURE
rather than a gap inferred from where two other things happened to land.

Two cascade details that were each wrong once:

- In a row the flex basis is a WIDTH, so `#dock` is not height-constrained by
  it at all. `max-height: 100%` with `align-self: center` is the cap that was
  missing: the panel is as tall as it needs to be and never taller than its half,
  so a desktop gets a compact card and a phone on its side gets a full-height one
  that scrolls inside. `align-self: stretch` instead gives the desktop a panel
  with 400 px of empty floor under the keys.
- The landscape override has to come **after** `#dock`'s own block or it loses
  the cascade to it — same specificity, later wins. Putting it up beside the
  `#overlay` rule looked tidier and did nothing at all.

Two tokens do the load-bearing work:

- `--ctl-zone` is 0 by default and becomes the height of a pedal under
  `body.touch`. The HUD offsets itself by it, so the instruments clear the
  driving controls without either layout knowing the other exists.
- `--edge-*` fold the safe-area insets into the ordinary gutters, so nothing
  else in the file has to `max()` against a notch.

Driving controls are circles (`border-radius: 50%`, `aspect-ratio: 1`): a thumb's
contact patch is round, and a circle is unambiguous about its own centre, which
is what you aim at when you re-find a pedal without looking. `.tbtn-lg` /
`.tbtn-sm` / `.tbtn-go` are the only variants.

`probe/ui.mjs` is the only guard on any of this — 40 ids and 14 toggled classes.

---

### 4.14 Ground cover — TWO TIERS (`env/grass.js` + `chunks.js`)

The near field wants tufts you can resolve: 0.55–1.4 m, dense enough that crossed
cards close into a continuous surface. Extending that outward fails twice over —
the instance count goes up with the area, and at 200 m a 1 m card is four pixels
tall, so the count buys a faint dusting rather than a field. Rendered, the old
single tier was a ribbon hugging the tarmac with bare ground beyond it.

What reads at 200 m is a **layer**: something with a broken top edge standing
proud of the ground, catching light differently from the sheet under it. That
needs area, not count.

| | near | far |
|---|---|---|
| chunks | ±1 (3 chunks, 360 m) | −1/+5 (7 chunks) — the view is in front |
| lateral band | 62 m | 185 m |
| card size | 0.55–1.4 m | ×1.55 tall, **×4.2 wide** |
| density | 2.9/m² asked | area-preserving × 0.26 |
| alive | ~99,000 instances, 396k tris | ~39,000 instances, 154k tris |
| fade | out at 62→95 m | **in** at 55→110 m, out at 330→470 m |

**Wide, not big.** Scaling a card uniformly by 4 makes it five metres tall, and
five metres of grass is a tree: the first render of the far tier was a field of
dark spines standing off the slope. `widthScale` and `heightScale` are separate
for that reason, and the instance count divides by their product.

**The tiers cross-fade by SCALE, not opacity.** The material is an alpha-test
cutout, so there is no opacity to fade; a tuft shrinks about its own base, which
sinks it into the ground rather than dissolving it. The far tier's fade-in
window (55–110 m) deliberately overlaps the near tier's fade-out (62–95 m), so
there is never a band with nothing in it and never a card that is both close and
large.

Both tiers are one `_buildGrass` and one geometry. A tier is a plain descriptor
in `ChunkManager.grassTiers`; everything that differs is a number in it. The near
tier is served first from a shared per-frame budget, because it is the one whose
absence is visible.

**`GRASS.density` is an ASK, not a count.** Samples landing on ground too steep
for grass are dropped, so what is placed is always less — and how much less
depends on the terrain. At 3.6 against the old, gentler ground a third were
rejected and ~30,000 survived per chunk; against terrain with more flat shelf in
it only a tenth are, and the same 3.6 delivered 41,000.

### 4.15 The terrain's own detail (`env/ground.js`)

Grass geometry fixes the first forty metres and nothing beyond it. The ground was
one flat wash of green not because the palette was wrong but because a vertex
colour was the only thing it had to say, and the vertices past the verge are
metres apart — between them the interpolator draws a perfectly smooth ramp, and a
perfectly smooth ramp over an area the size of a field is what "flat green"
looks like.

One tiling RGB map, all three channels LUMINANCE, multiplied into `diffuseColor`
*after* the vertex colour. R is sward (clumps with 5:1 stretched streaks over
them, because grass lies down in a direction and isotropic noise reads as
gravel). G is rock (ridged, so the creases are lines rather than blobs). B is
soil and gravel, with grain at the texel scale so mipmapping takes it away with
distance — which is exactly the wanted behaviour.

- **Slope picks between them**, by the same normal the palette uses, so the
  texture can never disagree with the colour.
- **Two scales, 5.5 m and 28 m.** Not a round ratio: two samples of one tiling
  map at frequencies that do not divide beat against each other with a period of
  their product, ~154 m, for one extra fetch. The near tile fades out over
  45–130 m, because a 5.5 m tile at 120 m is under a pixel and a sub-pixel
  pattern is not detail, it is a crawling shimmer.
- **Planar in world XZ, not UV.** The sheet is parameterised in ROAD space, where
  columns are 2.4 m on the carriageway and 34 m at the corridor edge, so a
  UV-mapped texture would be stretched thirty-fold across one hillside. World XZ
  costs two multiplies and lines up across chunk seams by construction.
- **`NoColorSpace`, not sRGB.** It is a modulation mask, not a colour; decoding
  it as sRGB bends the midpoint and the overlay darkens everything.

Everything is centred on 1.0 and modulates by `GROUND.contrast*`, so switching
the block off must not change how bright the world is.

### 4.16 Stone (`env/rocks.js` + `chunks.js`)

Not scenery — **texture**. A cut face is a smooth green ramp until there is
broken rock spilling out of it, and a verge is a mown edge until there is gravel
on it. Chips along the shoulder, scree out of a cutting, the occasional boulder
in the grass; nothing you would call a landmark.

A rock is a subdivided icosahedron, displaced by two octaves of value noise,
squashed non-uniformly, then **clipped against a handful of random half-space
planes** — which is what a fracture is, and without it the result is a potato.
Normals are FLAT: a fractured solid whose faces all shade alike is a pebble made
of clay. 20 triangles for scree, 80 for the rest, 59 mean across the library.

One placement rule does all the work: **the steeper the ground, the more likely
stone is, and the more of it is scree rather than boulders.** That single
`smoothstep` produces talus under a cutting, chips along a bank and the occasional
stone in a flat field without any of those being a separate case.

Two budget details that are easy to undo:

- **A chunk uses a WINDOW into the variant library, not all of it**
  (`ROCKS.variantsPerChunk` = 2 per class, rotated per chunk). Every distinct
  geometry in a chunk is another `InstancedMesh` and another draw call; with the
  full library a chunk touched eleven of them for a hundred-odd rocks, which is
  the cost model of not instancing at all. Now 5.8 batches per chunk.
- **Scree never casts a shadow.** The sun's cascade is 78 m across 2048 px —
  4 cm a texel — so a 15 cm chip is three texels and its shadow is noise, and
  there are more chips than everything else put together.

Measured: ~87 rocks and 3,985 triangles per chunk, ~16,000 alive against ~109,000
for the whole terrain sheet.

### 4.17 Tyre smoke and rubber (`fx.js`)

Both are driven by ONE quantity, `wheel.slipAmount` — how far past its peak a
tyre is, the same number the skid audio uses. There is deliberately no second
opinion about whether a tyre is sliding; a visual effect that disagrees with the
sound is worse than no visual effect.

**Smoke is a pool integrated on the GPU.** 260 particles allocated once and
recycled oldest-first, so a thirty-second burnout costs what a one-second one
does and there is no allocation in the frame loop. Each instance carries an
origin, a velocity and a birth time; the vertex shader solves the closed form of
`x(t) = x0 + v0(1 − e^(−kt))/k + rise·t`, so the CPU writes to a particle exactly
once — when it is born. They are billboards built in VIEW space, offset after the
origin has been transformed, so the card faces the camera without anything on the
CPU knowing where the camera is.

**Rubber is a ring buffer of quads.** 3,000 of them, written round; the oldest is
a couple of hundred metres behind by the time it is overwritten. Each quad
bridges where a wheel was and where it is, at the tyre's own width, built from
the direction BETWEEN those two points rather than the wheel's heading — a
sliding tyre is not pointing where it is going, and a mark drawn across its own
path is the giveaway. Age is a vertex attribute and the fade is in the shader.
They are coplanar with the ground by construction, which is the one thing a depth
buffer cannot resolve, so `polygonOffset` biases them forward and `depthWrite` is
off.

**`FX.smoke.minSlip` is 0.22, and that number is not a matter of taste.** The
tyre model resolves an over-driven wheel by clamping the combined impulse to the
friction circle, and `slipAmount` is how much it had to take away. A full-throttle
standing start in the Sport measures **0.39–0.46** on the driven wheels — that is
a car lighting up its rear tyres, and it is nowhere near 1. A threshold set by
imagining what "full slip" ought to mean lands above everything the model ever
produces, and the effect then silently never happens.

Smoke also fades out over 14–34 m/s (`speedFade`). Tyre smoke is rubber being
erased, and at 200 km/h a sliding tyre is doing the same thing per second but
leaving the smoke a hundred metres behind, so there is never a cloud to see —
which is also exactly the behaviour asked for: smoke when the revs are up and the
car is not. Rubber has no such gate; a high-speed slide still marks.

### 4.18 Wind (`wind.js`)

The one sound the engine simulator cannot make, and the cheapest immersion in the
project: at 200 km/h a car is loud in a way that has nothing to do with
combustion.

Synthesised, not sampled — a loop is a file, a file has a length, and a length is
a period the ear finds. Brown-ish noise (a one-pole integration of white, which
tilts it ~−6 dB/octave and puts the weight where air actually is) through two
bands:

- **RUSH**, low-passed, sweeping 260→1500 Hz. The body of the sound, present from
  walking pace.
- **WHISTLE**, a narrow band that arrives at 45% of the speed range and climbs
  900→2600 Hz quadratically from there. That lateness is the whole effect — it is
  what makes 200 km/h sound different from 120 km/h rather than simply louder.

`WIND.exponent` is 2.2. Aeroacoustic POWER goes as roughly the sixth power of
velocity, which is true and useless: it puts everything under 150 km/h at silence
and everything over it at one level. This is an amplitude curve with a tilt.

**It does not create an AudioContext.** It is handed the one `engine_sim` already
made, so there is one clock and one output bus in the process — and it therefore
starts inside the same user gesture, on the Drive click. Parameters move with
`setTargetAtTime`, never `.value =`: a write lands at a block boundary and steps,
which on a parameter this broadband is an audible edge. It has its own slider in
the drawer, and follows the global mute.

## 5. The config contract, and the trap that has cost the most time

`config.js` exports **18** blocks: `WORLD`, `ROAD`, `ROUTE`, `CHUNK`, `TREES`,
`BUSHES`, `GRASS`, `GROUND`, `ROCKS`, `WIND`, `FX`, `VEHICLE`, `TRAFFIC`,
`CAMERA`, `TITLE`, `ATMOSPHERE`, `SCORE`, `TERRAIN_COLORS`.

**THE TRAP.** Put a key in the wrong block and it reads as `undefined`. Then:

```
undefined * 0        →  NaN
clamp(v, NaN, NaN)   →  v        // returns the input unchanged, silently
```

So the terrain passes straight through the carving step with no error, no
warning, and no visual clue beyond "the world looks wrong somehow". **This has
happened twice.** Audit before trusting any terrain change:

```bash
node -e "
const fs=require('fs');
const s=fs.readFileSync('src/config.js','utf8');
const blocks={}; let cur=null;
for(const line of s.split('\n')){
  const m=line.match(/^export const (\w+) = \{/); if(m){cur=m[1];blocks[cur]=new Set();continue;}
  if(cur&&/^\};/.test(line)){cur=null;continue;}
  if(cur){const k=line.match(/^\s{2}(\w+):/); if(k)blocks[cur].add(k[1]);}}
let bad=0;
const files=[...fs.readdirSync('src').map(f=>'src/'+f),
             ...fs.readdirSync('src/env').map(f=>'src/env/'+f)];
for(const f of files){ if(!f.endsWith('.js'))continue;
  const t=fs.readFileSync(f,'utf8');
  for(const m of t.matchAll(/\b(WORLD|ROAD|ROUTE|CHUNK|TREES|BUSHES|GRASS|GROUND|ROCKS|VEHICLE|TRAFFIC|CAMERA|TITLE|ATMOSPHERE|SCORE)\.(\w+)/g)){
    if(blocks[m[1]]&&!blocks[m[1]].has(m[2])){console.log('MISSING '+m[0]+' in '+f);bad++;}}}
console.log(bad?bad+' missing':'config audit clean');"
```

Currently: **clean**. The dead-key list that used to live here is gone — those
keys have been deleted. Note that `VEHICLE.*` reads as `V.*` inside the vehicle
(the block is spread into every car's params), so a naive "unused key" scan will
report the whole block as dead. It is not.

---

## 6. Physics invariants

| Constant | Value | Note |
|---|---|---|
| `WORLD.gravity` | −16.0 | Deliberately stronger than 9.81; arcade weight |
| `WORLD.fixedStep` | 1/120 | Physics rate |
| `WORLD.maxSubSteps` | 6 | Spiral guard **and** the frame-time ceiling — `main.js` derives its `dt` clamp from `maxSubSteps * fixedStep`, never from its own number. Bug #51 |
| `VEHICLE.maxChassisSpeed` | 100 m/s | Guardrail, not a speed limit |
| Player ray membership | `0x0001`, mask `0xfffd` | belt and braces; see §4.5 |
| Rapier `linearDamping` | **0** | see bug #4 |
| `TRAFFIC.maxImpactDv` | 11 m/s | ceiling on Δv from one impact |

**The player's car is the only rigid body in the world besides the static
terrain trimeshes.** Nothing else is dynamic.

---

## 7. Bug ledger

Every one of these was real, was diagnosed by measurement, and cost time. They
are recorded because most of them are re-introducible.

| # | Symptom | Actual cause | Fix |
|---|---|---|---|
| 1 | Everything inside-out, half transparent | Triangle winding order wrong throughout | index order `(a,b,c)`/`(b,d,c)` |
| 2 | Car accelerated absurdly | `driveBias` summed to 2.0 | Sum to 1.0 |
| 3 | Wheels orbiting on a circular path | Three composes T·R·S, so a node with both offset and yaw lands at `R·centre − centre` | Nested nodes; bake world matrices before re-parenting |
| 4 | Hidden ~1300 N drag | Rapier `linearDamping` left non-zero | Set to 0; all drag explicit in `_aero` |
| 5 | Terrain silently unchanged | Config key in the wrong block → `NaN` → `clamp` passes value through | Audit script (§5). Happened twice |
| 6 | One-shot keys never fired | `pressed.clear()` ran before `_handleActions()` read them | Added `endFrame()`, called last |
| 7 | Car hits an invisible wall off-road | Cut/fill ramp had *zero width* at the verge: 3° → 40° in one step = **1389 m/s²** at 30 m/s | `t²/(t+R)` ramp + `smin`/`smax`. 1389 → 64 m/s² |
| 8 | Black screen on Drive | GLSL ES 3.00 const array inside a GLSL ES 1.00 `ShaderPass` | Reverted to three's `BokehPass` |
| 9 | Traffic launched the player | Suspension rays hit sensor colliders | `QueryFilterFlags.EXCLUDE_SENSORS` |
| 10 | Tunnel roofs full of holes | The fix was inverted — cutting the max instead of the min | Cut the *minimum*; portal rings excluded from the collider |
| 11 | Ram traffic → player flies away | Traffic were `kinematicPositionBased` = infinite mass | (superseded by #22) |
| 12 | Struck car reached **6920 km/h** | `setLinvel` written every frame *while a contact was resolving* | (superseded by #22) |
| 13 | Every traffic car knocked instantly | `contactPairsWith` reports **broad-phase** neighbours, not touching ones | Removed contact gating |
| 14 | Traffic spawned at 630 m/s | Dynamic bodies ignore `setNextKinematicTranslation` | (superseded by #22) |
| 15 | Player ejected 35 m vertically | One frame of infinite mass at 100 km/h = 0.25 m penetration | (superseded by #22) |
| 16 | Suspension rode on traffic roofs | Once traffic became solid, rays hit them | `_rayGroups` mask |
| 17 | **Road buried in the ground; car stopped dead at a tunnel mouth** | `smin`/`smax` with a fixed `k = 3.5` were smoothing a gap of *zero* width on the carriageway, where ceiling and floor are the same plane. Each contributes up to `k/4`; compounded, **+0.875 m of terrain standing on the road** wherever the natural surface passed near road level — which is exactly what a portal is | `k = min(slopeBlend, (ceiling − floorY)·0.25)`. Measured: 0.000000 m deviation from an exact clamp on the carriageway, 0 steps over 30 cm in 220k probes |
| 18 | **Mesh gaps ringing every tunnel mouth** | 18 m portal ramp over up to 60 m of mountain rise, so the terrain vertex beside the hole sat **35 m** above the arch while the shell reached 8.2 m | 6 m portal (a rock *face*, not a ramp) + road-space mouth + `boreClearance` lift. Surviving edge now exactly on the clearance line, 6 seeds |
| 19 | **8.8 m wall across the road approaching a portal** | Three different "is there a tunnel" thresholds (`0.0005`, `0.01`, `0.5`) in four places. In the band between them the terrain was lifted clear of the arch but *not* removed — 8.8 m is `tunnelCrown + tunnelRoof` exactly | One shared `TUNNEL_EPS` |
| 20 | Respawn / traffic placed on the tunnel roof | `groundAt` returned the bore floor only above `tunnel > 0.5`, so near a portal it handed back the lifted terrain | Same `TUNNEL_EPS` |
| 21 | **Traffic spawned 40 m ahead, in plain sight** | `_maintainPopulation`'s window started at 40 m | `TRAFFIC.spawnMin = 460` |
| 22 | **Traffic stopped dead / piled up / flew away** | Every variant of "drive a rigid body by writing its velocity". Root cause, not a symptom | No traffic bodies at all; analytic impacts (§4.8) |
| 23 | Road half empty despite a population target | Spawn clash test ignored `lane`, so a car in the *other* lane rejected the candidate; 12 attempts then gave up | Test `lane` too; 40 attempts. Population 5..9 → 9..9 |
| 24 | Faceted, knife-edged terrain | (a) `1 − \|n\|` in `ridgedFbm` is a C1 discontinuity per octave, at every scale; (b) `base` had no LOD, so 7 m features were sampled on 55 m columns | Soft fold `1 − √(n²+e)`; octave budget from lateral resolution. Adjacent-face angle p99 down 39–51% in every band |
| 25 | Traffic identical in every world | `rng` seeded from a literal constant | Seeded from the world seed. Found because a soak test across three seeds returned byte-identical numbers |
| 26 | `ATMOSPHERE.vignette` did nothing | The key was never read; the shader used its own default | Wired in `scene.js` |
| 27 | **15 m cliff across the road at a tunnel exit** | `_markTunnels` grew runs incrementally and committed them only when "settled" relative to the generation frontier, so the answer depended on framing order and froze runs mid-mountain — 32 m of 11–14 m-deep rock with no bore, which the cut-and-fill clamp then flattened to road level | Stateless morphological open/close + a settled write window; `ensureLength` waits on `markedLength`. Worst step away from a portal 28.8 m → **1.4 m** over seven seeds |
| 28 | 8.8 m riser at every portal | The bore headroom switched on as a step with `tunnel > EPS`; 8.8 m is `tunnelCrown + tunnelRoof` exactly | Headroom and clamp release share one eased ramp |
| 29 | Creased berm running the length of every bore | Headroom decayed over the 2.5 m sill — a 62° shoulder | Smoothstep decay over `tunnelBerm` = 45 m |
| 30 | **A slide could not be caught** | The rollover/grip steering limit is derived for a *steady-state* turn and was applied in a slide too, capping the lock at 4.3° at 108 km/h. Countersteer took 3.96 s and the car went round | Lock opens toward full with chassis slip angle, plus a yaw damper past 23°. **0.68 s**, 158° total rotation |
| 31 | Steering felt locked out at speed | `minSteer` 0.030 rad and `steerGripMargin` 1.05 left 1.85× the angle the tightest corner needs at 200 km/h | 0.075 and 1.6 → **4.6×** |
| 32 | A slide scrubbed all the speed off and stopped | Magic Formula `C = 1.45` keeps only 76% of peak grip past the peak, so the tyre fell off a cliff | `C = 1.25` keeps 92%. Speed through a drift 15 → **51 km/h** |
| 33 | **The car itself went blurry at speed** | A depth-of-field pass focusing at one distance, pulled toward the horizon with speed, while the car sits 5 m from the camera | Removed; radial speed blur instead — sharp centre, streaked periphery |
| 34 | Camera speed terms did nothing | `CAMERA.speedRef` 165 m/s = 594 km/h, so the speed factor never rose above ~0.4 | 68 m/s; FOV gain 4° → 12° |
| 35 | **Tunnel floor shimmered** | The shell left its floor points unoffset, so the floor was swept twice in the same place — and the lining material is `DoubleSide`, so both copies drew. **11.4% of every bore's triangles were coincident** | Offset every shell point radially, floor included. 0.0% |
| 36 | A ring of rock around the bore every 120 m | End caps were emitted at both ends of every span, including where a span was merely clipped by a chunk boundary | Caps only where the bore really ends; spans snap to a global station grid |
| 37 | Car rolled away while you were choosing it | Nothing held it, and any seed with a gradient under the spawn sent it down the road | `setParked` pins position *and* velocity; height stays free so it still settles. 15 cm → **0.0 cm** |
| 38 | **The slide assist was obvious** | The yaw damper engaged at 23° of chassis slip at strength 3.0 — an ordinary slide — so the car was being straightened out from under the driver. The lock also jumped straight to full, which read as the steering ratio changing | Damper 36°–72° at 1.3; lock opening proportional, capped at 4× the steady-state limit. Recovery 0.68 s → **2.54 s**, of which the assist accounts for 0.9 s |
| 39 | Camera cut hard when the run started | `setGarage(false)` reset `initialised`, so the rig teleported from the orbit to the bumper | Keeps its position and sweeps, damping stiffened for `snapTime` |
| 40 | Car hidden behind the buttons | The garage rig aimed *above* the car, pushing it down the frame | `CAMERA.garage.aim` is negative |
| 41 | **The car was too easy to lose** | Four things at once: `tyreShape` 1.32 dropped 11% of grip the moment the tyre went past its peak, and the rear axle reaches its peak first under power; front/rear cornering stiffness 14/11.5 let the car keep rotating before the rear built force to stop it; a solid-box yaw tensor (radius of gyration 0.29·L against a real car's 0.35–0.40) meant the body could be rotated for free; and 6.2 rad/s put full lock 94 ms from a keypress | 1.22 / 15 / 13, `Iy × 1.6`, `steerRate` 5.0, grip +12% with CoM two points lower to pay for it. Handbrake-turn yaw 3.22 → **2.27 rad/s**; catch 2.54 s and 169° → **0.82 s and 62°**; speed left after the catch 5 → **41 km/h**; drift exit 26 → **56 km/h**. With the assist off the catch is 0.98 s, so it is the tyres and the inertia doing it, not the damper |
| 42 | **First gear had no torque; a slope was impassable** | `_stepVehicle` is overridden, so engine_sim's launch controller never sees the load on the wheels — only that wheel speed is not rising. It regulates on ROAD SPEED, so a stationary car pins `geared` at 0, the demanded rpm never moves, and the clutch sits half open transmitting a fraction of the engine forever. Measured against a pinned wheel: manual/DCT cars 5.0–8.4 m/s² at full throttle against 12–17 for the converter autos, and a flat 1.3–2.8 m/s² at a third throttle. Gravity is 16 m/s², so a 10% grade costs 1.6 | `powertrain._launchFloor`: below 7 m/s, in first, take the max of the drivetrain's force and `0.72 × peakTorque × throttle` through the gear. A floor, not a replacement; fades to nothing by 7 m/s; still goes through the friction circle and traction control, so it cannot invent grip. Sport 5.2 → **9.9 m/s²** in the first frame, 1.8 → **3.5** at a third throttle. Top speeds unchanged |
| 43 | Every car launched to the wrong schedule | engine_sim derives `launchRate` once, in its constructor, from whichever preset it was built with; neither `setVehicle` nor `setEngine` revisits it. Across the roster it was out by up to 2× in both directions — the Muscle car wound up at twice the rate it can pull, the Hatchback at three quarters | `_retuneLaunch()` recomputes it, and `launchFlareRpm`, per car on `setCar`. Both are read live inside engine_sim, so nothing there is edited |
| 44 | **Paint sections that no colour could change** | `findPaintCell` took the single largest atlas cell. Every model's *second* largest is a big flat block too — the Hatchback's upper body, the Van's roof, the Interceptor's panels — and it kept the shared texture, so it stayed put whatever the player chose | `rankPaintCells` returns the ordering; the top two get their own materials. Second colour defaults to the swatch sampled from the atlas, so nothing looks different until asked. 8–34% of each car's triangles land in the new slot |
| 45 | The interface was three designs | Three overlapping width breakpoints (`max-width: 640px`, `max-height: 520px`, and the base) each restated sizes the others had already set, so the desktop dock was a bare column and the mobile one a blurred card, chips were defined four ways, and the HUD dodged the touch controls with hard-coded pixel offsets | Every size is a `clamp()` against `vmin`; the only media queries left ask about orientation and pointer. `--ctl-zone` lets the HUD clear the driving controls without either layout knowing the other exists. §4.13 |
| 46 | Handbrake button through the middle of the tachometer | `--ctl-zone`, the strip the HUD keeps clear for the driving controls, was measured as one pedal — but the right pad is a *stack*, handbrake above brake | Zone = `ctl + ctl-sm + gap + gutter`. Found by `probe/uishot.mjs`; invisible to every other check |
| 47 | Score squeezed against the auxiliary buttons | Six aux controls in a 3-wide grid left 67 px in the middle of a 375 px phone for a five-figure score | 2 columns × 3 rows, and `#run` reserves that width on both sides so the score centres in the free strip |
| 48 | **Car blurb drawn straight through the paint swatches** | Garage rows are flex items in a height-constrained column, so the default `flex-shrink: 1` squeezed each one proportionally — and a row squeezed below its content does not scroll, it overflows | `#garage > * { flex: 0 0 auto }`; the garage overflows as a whole and scrolls |
| 52 | **Grass read as a dark stripe along the verge** | Two ambient-occlusion terms multiplied: the card texture's root gradient at 0.26 and the tuft geometry's own root vertex colour at 0.42, leaving the bottom of every blade at 11% of the ground colour — and a short tuft is mostly bottom | 0.55 and 0.78. Found by `probe/render.mjs` on its first run; invisible to every headless measurement, all of which said the grass was exactly where it should be |
| 53 | Car hidden entirely behind the garage dock | `CAMERA.garage.aim` is negative to lift the car up the frame, and was tuned against a shorter dock. Adding the second paint row pushed the panel over the car | `aim` -0.55 → -2.2, dock 66dvh → 58dvh. Also only visible in a render |
| 54 | **Grass was a ribbon hugging the tarmac** | Nothing wrong with the placement — the middle distance had tufts in it. A low camera compresses forty metres of verge into a few dozen pixels, and cards sized for the near verge are gaps with grass between them at that scale. Then the density taper and the size boost were applied over the *same* range and compounded, emptying it again | `GRASS.farScale`: cards grow toward the band edge, count per unit area falls as the square, so coverage extends and the triangle budget does not. Taper confined to the outer quarter |
| 49 | Wordmark running under the panel on a landscape phone | The brand was moved to the corner under `orientation: landscape`, which is also every desktop monitor; and at full size it did not clear the dock on a 393 px-tall screen | The query is `max-height: 620px` — height was always the actual constraint — and the title drops a size with the tagline hidden there |
| 50 | **The car sprang backwards at speed, worse the lower the frame rate** | Exponential damping toward a *moving* goal settles at a lag of `v·dt·e^(-k·dt)/(1 − e^(-k·dt))`, which contains `dt`. The chase rig therefore sat 3.98 m behind at 60 fps and 3.51 m at 30 fps and slid between them whenever frame time wobbled — and since the car's own render interpolation is exact, what moved on screen was the CAR | `util.dampTrack`: closed-form solution of `ẋ = k(g − x)` over one frame with the goal treated as the ramp it is. Settled lag becomes exactly `v/k`, with `dt` gone from the answer. Springing at 30 fps with 30% jitter **273 mm → 2 mm** |
| 55 | **A hillside lying across the carriageway** | Every chunk carries terrain to `CHUNK.halfExtent` (700 m) either side while being `CHUNK.length` (120 m) long, so a chunk's sheet covers an enormous area — and each one is carved for ITS road and is natural ground over anyone else's. The old noise generator wandered too incoherently to double back within 700 m; a router that follows contours does it readily, because going round a hill is what following a contour means | `ROUTE.selfNear/selfFar/selfClear`: candidates coming back within 300 m of road laid between 260 m and 1600 m ago are penalised quadratically. Measured self-clearance 191–198 m across four seeds against a 160 m floor |
| 56 | Title screen rendered in near-darkness | The garage orbited the real car on the real road, so it inherited the world — including facing the anti-sun side of the sky dome, on a seed that is bright and pleasant from the chase camera | Its own scene: cyclorama, turntable, three fixed lights (§4.10) |
| 51 | **A frame-rate hitch yanked the car backwards** | `maxSubSteps · fixedStep` was 41.7 ms while `main.js` clamped the frame to a separate literal 50 ms. Every frame between the two ran the physics short and discarded the remainder, while the camera, traffic and trip meter were handed the full `dt` and acted on time the car never got. A 90 ms hitch advanced the world **46%** of its own frame; sustained 20 fps ran the whole game at **83% speed** | One number: the clamp is `WORLD.maxSubSteps * WORLD.fixedStep`, and `maxSubSteps` went 5 → 6 so the accumulator always drains. Advance/expected **0.848 → 1.000** across a hitch, **0.833 → 0.999** at 20 fps |
| 57 | **A 1361 m/s² hit on a flat, straight carriageway with all four wheels down** | The new foreign-road clamp used a FIXED smooth-min width. On the carriageway `ceiling`, `floorY` and the result are all the same plane, so `smin(y, y, 3.5)` concedes k/4 unconditionally — a 0.875 m trench down the middle of the road, wherever a foreign road segment was within range. Trap #6, for the second time in this file | `k` tied to the gap, exactly as the cut/fill clamp already was. On the carriageway both operations degrade to exact min/max and the surface is the road plane to the bit |
| 58 | **The far terrain sheared between adjacent rows; chunks "did not line up"** | `foldSafeOffset`'s exponential mapping starts bending immediately, so a road with curvature wandering through zero — i.e. a straight — had its far corridor squeezed by a different amount on every row. Two rows 2.5 m apart, both at a 2.8 km radius, moved a far column **87 m** | A soft minimum with p = 6 instead of an exponential approach. Correction is O((v/L)^6), so it is invisible until v is a real fraction of R, and its sensitivity to curvature falls with the fifth power. The same rows now disagree by 0.1 m |
| 59 | **The terrain sheet was folding through itself — 1,240 to 4,353 cells per seed, worst row spacing MINUS 54% of nominal** | The fold guard was fed `frame.curv`, measured over ±10 m. The quantity that decides whether the mesh folds is the rate one row's frame rotates into the NEXT row's, and a smoothed estimate under-reports it — which relaxes precisely the limit the guard exists to enforce. It had been doing this since the guard was written | `path.js:_buildFoldLimits`: per-side running maximum of the actual frame-to-frame rotation over ±25 m. Conservative, continuous, and spikes become plateaux instead of shear. **0 inverted cells**, minimum spacing exactly 29% |
| 60 | **A hillside standing 2.6 m across the carriageway** | Bug #55 again, and `ROUTE.selfClear` was never going to fix it: it keeps two carriageways 300 m apart and the sheets are 700 m wide. Chunk 29's sheet was drawing uncarved ground over chunk 23's road, which is in a cutting | `sampleGround` clamps against foreign road segments too (§3). First attempt used control POINTS — 46 m apart, so 23 m of error at a 62% cut slope leaves 2.7 m standing. Second used the road's own cut slope — the far sheet's 34 m columns draw the CHORD across the V, which is 17 m of error. Segments, a 10% slope and a 4 m sink: **0 steps over 30 cm on seven seeds** |
| 61 | Chunk seams were a shading AND colour boundary every 120 m | `_seamNormals` re-derived the boundary normal analytically while every interior vertex got `computeVertexNormals`' area-weighted average. The two agree only where the surface is locally flat, and out where a cell is 34 m across it is not — and the normal feeds `_colorTerrain` as well | Ghost rows: sample one row past each end, compute normals over the extended mesh, keep the interior. Both chunks agree because both evaluate the same function |
| 62 | **The far grass tier was a field of dark spines** | Scaling a grass card uniformly by 3.6 makes it five metres tall, and five metres of grass is a tree | `widthScale` and `heightScale` separately: ×4.2 wide, ×1.55 tall. Coverage is what the middle distance needs, not height |
| 63 | Tyre smoke never appeared | `FX.smoke.minSlip` was set to 0.35 by imagining what "full slip" ought to mean. The tyre model's `slipAmount` is how much the friction circle had to take away, and a full-throttle standing start in the Sport measures **0.39–0.46** — a car lighting up its rears, nowhere near 1 | 0.22, and the number is now written down next to the measurement. `probe/env.mjs` drives the emission path against a stub carrying exactly that value, because a screenshot of no smoke looks like a screenshot taken at the wrong moment |
| 64 | **Holes in the terrain off the road — the car drove into one and fell** | Not the streaming, not the colliders: the mesh and its trimesh are built from the same buffer in the same call and cannot disagree. The sheet genuinely ENDED. `foldSafeOffset` asymptotes every lateral offset toward `ROUTE.foldMargin / kappa`, and `kappa` was a one-step difference of a spline through 46 m control points — it reached 1/81 rad/m against a road whose design limit is 1/165, so the corridor stopped **57 m** from the centreline where the alignment guarantees 115. The outer columns piled into a skirt, `CHUNK.horizonDrop` tipped that skirt downward, and on screen it read as a distant hillside rather than as the edge of the world. Meanwhile `CHUNK.recoverLateral` assumed a flat 300 m of ground, so the car had to fall **90 m** before anything caught it. Measured: **16–19% of ray probes within 290 m of the road hit nothing** | Two halves. `ROUTE.foldSmooth` averages the turn rate over ±6 samples before the running maximum — exact for a circular arc, so it costs no peak curvature and removes only the spline's roughness: worst corridor **57 → 73 m**, and *fewer* folded cells than before on every seed. And `path.corridorAt` inverts the guard so `_checkRecovery` can ask the road how wide it actually is here instead of assuming. `probe/offroad.mjs`: **0 holes in 43,000 probes**, five seeds. A hard FLOOR on the guard was tried and rejected — it takes one seed from 580 folded cells to 1,217, because where a Catmull-Rom overshoots the road really does turn tighter than it was designed to |
| 65 | **The title screen's fly-in played every time the player pressed R** | `Game.respawn` never touched the camera, and it did not have to: the chase rig damps, and `dampTrack` reads the goal's own travel as a velocity to lead. A 12 m teleport inside a 16 ms frame is a goal moving at 750 m/s, so the damper computed **79 m** of lead and then spent the best part of a second crawling back from it — visually the same move as the 1.35 s fly-in | `camera.snap()`, called from `respawn`. A teleport has no travel to follow, so stop following. `startRun` now respawns BEFORE `beginIntro`, because `update` tests `initialised` ahead of the fly-in and a snap requested afterwards would eat the first frame of the shot |
| 66 | Every procedural tree came out an aerial — four leaf clusters where sixteen were intended | Children inherited the parent's TIP radius, which already has the taper in it, so a child was a quarter of its parent instead of six tenths. Two levels down everything was under `minRadius` and the recursion stopped early | The parent's radius **where the child leaves it**: `br.radius * (1 - t*(1 - taper))`. Close to da Vinci's rule, which is what the 0.5–0.62 ratios in the species table already were. Leaf clusters per tree 4 → 50–80 |
| 67 | Impostors were a third the width of the trees they replaced — a wood turned into lollipops at exactly the distance the LOD swapped | Two independent scalings multiplied. The painted silhouette's `profile()` is a shape written by eye — one peaks at 0.34, another at 0.77 — and the card was separately sized to the tree's own crown radius | `profileMax()` normalises the profile so the crown fills `IMPOSTOR_FILL` of the card, and `impostorWidth()` gives `chunks.js` the matching card width. A second bug in the same function had the crown measured DOWN from the top of the card instead of up from the ground, which put every species' foliage in its top fifth |

### Test-harness bugs that masqueraded as game bugs

**The worst one yet, and it was pre-existing.** `probe/drive.mjs`'s autopilot
computes a steering ANGLE and converted it to a command by dividing by
`V.maxSteer`. But `input.steer` is NORMALISED — the vehicle multiplies it by
whatever lock the grip and rollover limits leave at this speed, which is the
right contract for a human holding a stick and is **a sixth** of `V.maxSteer` at
160 km/h. The car therefore tracked a wider radius than the road, drifted out at
about a millimetre a metre with **zero tyre slip** and a third of the lock it
thought it was using, and reported the verge it eventually found as a fault in
the world.

It got worse as the alignment got more interesting, which is exactly the
correlation that makes such a thing convincing: worst lane error went 1.77 m →
16.77 m on one seed when the terrain grew, and every instinct said the road was
now undrivable. Two red herrings were chased first — raising the cross-track gain
(3.6 and 5.0 took the worst seed to 14.9 and 15.1 as the loop went unstable) and
slowing the corner-entry model (no effect at all, because the car was never
sliding).

`vehicle.steerLimit` is now published for exactly this, and dividing by it took
the lane error to **0.46–0.58 m across five seeds** — better than the numbers the
project shipped with on a far gentler road.

Two smaller ones fixed in the same pass: the autopilot read curvature at ONE
lookahead station, so it held full throttle into a 270 m corner while looking at
an 828 m radius 73 m up the road (it now scans the window and takes the worst);
and it had no feed-forward term, so it carried the steady-state offset every
purely proportional path tracker has against a constant-curvature path.


Worth its own list, because measurement has been wrong more often than the game.

- `mock.audit()` needs the destination node passed — without it, 42 false orphan
  nodes were reported.
- The jitter metric measured deviation from the mean instead of `speed × dt`.
- A lane-centring term with too much gain drove the test car into a field.
- **A probe firing rays on the mesh lattice reported 141 holes that do not
  exist.** A ray aimed exactly down a shared triangle edge — every chunk seam is
  one, every 2.5 m row is one — can miss both faces on floating-point grounds.
  Offsetting the sample grid a few centimetres gives 0.
- **An autopilot with an inverted cross-track sign** steered the test car off the
  road four times in 90 s and made the whole build look broken. It covered 79 m;
  with the sign fixed and a heading term added, 4736 m.
- **Every steady frame rate measured clean while the game was visibly broken.**
  144, 60, 45, 30, 24 and 20 fps all reported zero springing, because bugs #50
  and #51 are both driven by frame time *changing* rather than by its value.
  `probe/smooth.mjs` scripts jitter and hitches for exactly this reason.
- **World-space smoothness was already perfect and proved nothing.** Render
  interpolation advanced the car `speed × dt` to six decimals at every frame
  rate, and both `drive.mjs` and `handling.mjs` ask where the car *is*. The
  entire fault was in where it was *drawn* relative to the camera, which only a
  camera-space metric can see.
- **`handling.mjs` charged the car for the test's own cornering.** The slide
  recovery test holds full opposite lock and half throttle for four seconds,
  which is what a driver catching a slide does — but a car that recovers early
  then spends the rest of that time obeying the input and driving a steady
  circle the other way, and the probe integrated heading straight through it. A
  tune that caught the slide in 0.82 s after 62° was reported as "240 deg, WENT
  ROUND" *because it recovered in time to start turning*. Heading is now
  integrated only until the yaw is arrested.
- **Checking prop placement by going back through `(s, v)`** reported trees
  floating 3.97 m. The scatter runs the offset through `foldSafeOffset` before
  placing, so recovering `v` from the finished world position applies the
  compression twice. Measured against the collider instead: **0 mm**.

**Do not trust a harness result that contradicts the code until you have read
the harness.**

---

## 8. What is NOT verified, and what is still broken

Be honest about this section. It is the most useful part of the file.

### Never seen running

**The game has now been rendered — through SwiftShader.** This section used to
say no browser had ever drawn a frame of it. A headless Chrome has no GPU, but
it does have ANGLE's software rasteriser: `--use-angle=swiftshader` plus
`--enable-unsafe-swiftshader` gives a correct GL implementation at roughly
20 fps, and `probe/render.mjs` drives the real game through it, boots it, starts
a run and screenshots the result. Two bugs fell out on the first run that
nothing else could see (#52, #53).

`probe/render.mjs` also takes a **teleport** as its third argument — SwiftShader
covers a couple of hundred metres in a minute, so without one every shot is of
the same kilometre — and a `SKID=1` flag that stops the car and floors it.

What that still does NOT cover: the frame rate it reports is meaningless, MSAA
and anisotropy behave differently from a GPU (so `alphaToCoverage` on the grass
is unverified), and nobody has driven it far. Colour grading and bloom have been
*glanced at*, not judged.

**The tyre effects have never been seen rendered, and `SKID=1` cannot show
them.** At 20 fps the powertrain is stepped with `dt` = 50 ms, an order of
magnitude outside what engine_sim's launch controller regulates at, and the
engine never comes off idle: measured, 1,650 rpm and 8 kN at the contact patch
where a real launch makes 25 kN. Eight kilonewtons does not overwhelm a 1.45
friction coefficient, so no tyre slips and there is nothing to draw. Nothing is
wrong with the effects; the car is not doing the thing. `probe/env.mjs` verifies
the emission path directly instead, against a stub carrying the slip value the
real car measures — which is deterministic, and can tell the difference between
"no smoke" and "the screenshot was taken at the wrong moment".

**The interface, separately, HAS now been rendered.** `probe/uishot.mjs`
screenshots twelve real device viewports over the DevTools protocol against
`probe/uiview.html` — the live stylesheet, with the module boot removed and the
garage, HUD and drawer filled by hand, so there is no WebGL to die on. It found
four layout bugs on its first run (#46–#49) that `probe/ui.mjs` could not see,
because "every id resolves" and "no two controls overlap" are different
questions. Phone, tablet and desktop, portrait and landscape, all report no
overflow.

What that still does not cover:

- The interface has been seen over the real scene only in the GARAGE, at one
  viewport (1280x720) and one seed. `probe/uishot.mjs` renders it over a flat
  background at twelve viewports; the two have never been combined.
- **The garage is much darker than driving.** Rendered, the orbit looks toward
  the anti-sun side of the sky dome and the whole title screen comes out navy,
  while the same world at the same moment is bright and pleasant from the chase
  camera. Nothing is wrong with the exposure — it is the sky gradient plus a
  fixed sun — but it is the first thing anyone sees and it does not look
  deliberate.
- **Which swatch the second paint colour actually moves.** `probe/paint.mjs`
  proves the slot owns triangles; it cannot tell you they are the roof rather
  than the windscreen. The z-buffer check in §4.6 says the second cell is a body
  panel on seven cars of nine — the Sport and the Classic are the two where it
  may well be glass. First thing to do with a real browser: open the garage,
  cycle all nine cars, and watch what the Trim swatches change.

- **What the new scenery looks like on a real GPU.** The far grass tier, the
  ground detail texture, the stone and now the whole canopy have been rendered
  through SwiftShader and they read correctly, but MSAA, anisotropy and mip
  selection are all different there. `GROUND`'s near tile in particular is
  fading out at 45–130 m against an aliasing threshold that was reasoned about,
  not measured. The tree/impostor cross-fade is the same kind of judgement: the
  windows were chosen against apparent size on screen and confirmed by eye at
  1280x720, not measured.
- **Tilt steering has never been held.** Every number in `TiltSteering` — the
  22° range, the 1.5° dead band, the 1.7 expo — was reasoned about against how
  far a wrist rolls, and the axis/sign table for `screen.orientation.angle` is
  from the specification rather than from a phone. There is no probe for it and
  no obvious one: it needs a real device, a real sensor, and HTTPS.
- **The wind on the trees.** Trunks are pinned and canopies swing by an `aSway`
  attribute at `TREES.windStrength` 0.55 m of tip travel. Rendered at roughly
  one frame per second through SwiftShader, that is a still image.
- **The wind has never been heard.** The graph builds without error in a headless
  context; every number in `WIND` was chosen by ear against expectation, which is
  not the same as against a speaker.

### Known rough

- **Faceting at the corridor edge.** The p99 in the 200–700 m bands is 27–31°
  and the worst cell reaches ~100°. The sheet no longer folds and no longer
  shears (§3), so what is left is a real one: the ground now turns faster than a
  34 m column can follow. Fog leaves ~1% of the colour past 500 m. The honest
  fixes are more columns or fewer octaves out there, and both are budget
  decisions nobody has taken.
- **`GRASS.density` interacts with the terrain.** It is an ask; how many samples
  survive the slope test depends on the landforms, so changing the terrain
  changes the instance count by tens of percent without anything in `GRASS`
  moving. Re-run `probe/grass.mjs` after any terrain change.
- **Stone is only in the near four chunks** (`ROCKS.behind`/`ahead`), and the
  grown canopy only in three (`TREES.behind`/`ahead`). A cut face five hundred
  metres ahead has no scree on it and gains some as you arrive; a tree arrives
  as an impostor and becomes a mesh. Neither has been looked at in motion at a
  real frame rate.
- **The sheet still folds a little at its very edge** — 204 to 459 cells of
  117,120 per seed, against 239 to 580 before `ROUTE.foldSmooth`. `frameAt`
  interpolates the fold limits between road samples, so a row can sit between
  two frames whose running maxima both under-read the rotation across it. It is
  hundreds of metres out, under heavy fog, and `probe/offroad.mjs` holds the bar
  at the old worst case so it cannot quietly get worse.
- **`_separate` runs one relaxation pass** over a list sorted before positions
  were adjusted. It has never failed a soak test, but it is not a proof.
- **Impacts are box-vs-box in road space**, so a car struck at a sharp angle
  resolves along the road axes rather than the true contact normal. It reads
  fine at speed; it would not survive slow-speed nudging scrutiny.
- The `engine_sim` submodule, §1.

### Verified good (headless, this pass)

- Carriageway surface: **0 steps over 30 cm and 0 holes in ~220k ray probes per
  seed** across **seven** seeds and 4 km each. The default seed had **779** of
  them before the foreign-road clamp; every other seed that has one has it near
  where the route doubles back.
- Carriageway height equals the exact cut/fill clamp to **0.000000 m**, and the
  foreign clamp is floored at this road's own fill line so it cannot touch it.
- **The terrain sheet essentially no longer folds.** 204–459 inverted cells of
  117,120 per seed across five seeds — from **1,240–4,353 per seed** with a worst
  row spacing of minus 54% before the guard was rebuilt, and from 239–580 before
  `ROUTE.foldSmooth`. What is left is at the extreme edge of the corridor; see
  "Known rough".
- **There is ground everywhere the player is allowed to drive.** 0 holes in
  ~43,000 off-road ray probes per seed across five seeds, over the whole area
  the recovery bound permits. It was **16–19%** (bug #64). Worst corridor width
  73–94 m, from 57–80.
- **The canopy and the understorey.** 7 tree species x 3 variants at 432–656
  triangles each (563 mean) plus a 4-triangle impostor per species, and 4 shrubs
  at 4–24. Per chunk: 61,000 near + 1,500 impostor + 3,800 shrub triangles;
  **232,000 alive at once** against ~109,000 of terrain sheet, over two lifetimes
  (3 chunks for the grown canopy, 9 for the rest). Scatter **3.5 ms** per chunk,
  7.8 draw batches of a budget of 8, nothing closer than 15.1 m to the
  centreline against an 11 m clearance, mean float off the collider 26 mm, and
  the per-chunk count varies by 38% of its mean — i.e. the stands are stands.
  The library is bit-identical between two builds.
- Terrain faceting, adjacent-face angle. The middle column is this project as
  shipped; the right is now, on terrain whose vertical scale is roughly **three
  times** larger. The p99 rising in the far bands is the ground genuinely turning
  faster than a 34 m column can follow, not noise — the mean falling everywhere
  is the fold guard and the seam normals:

  | band | shipped mean | now | shipped p99 | now |
  |---|---|---|---|---|
  | 0–80 m | 1.74° | **1.72°** | 9.65° | **9.85°** |
  | 80–200 m | 3.88° | **3.51°** | 18.39° | **21.05°** |
  | 200–420 m | 7.91° | **4.07°** | 46.44° | **30.55°** |
  | 420–700 m | 8.87° | **3.40°** | 54.07° | **26.89°** |

- Longitudinal terrain steps (`probe/cliff.mjs`): worst 0.4–2.1 m across five
  seeds, none over 8 m.
- Route character over 6 km, four seeds: sidehill **51%** (was 29%), corridor
  drops over 12 m **30–46%** (was 1–14%), earthwork 9.4 m, grade p95 5.7%,
  worst self-clearance 190 m against a 160 m floor.
- Sustained elevation: road elevation range over 18 km of driving **129–249 m**
  (was 106–214), longest climb with nothing given back **2.6–3.4 km for
  +66 to +111 m**.
- Chunk build cost **20 ms** (was 34–58). Grass scatter 4.7 ms mean per chunk for
  the near tier, 3.2 ms for the far one, stone 0.8 ms.
- Ground cover: near tier ~99,000 instances alive (396k triangles), far tier
  ~39,000 (154k), **0 on the carriageway**, closest 9.06 m against a 7.4 m road
  half-width, none beyond its band, and the two tiers' fade windows overlap.
- Stone: 87 per chunk, ~16,000 triangles alive against ~109,000 of terrain,
  **5.8 draw batches** per chunk, none inside the paved edge, every variant
  normalised to unit width and standing exactly on y = 0.
- Tyre effects, driven directly against a stub carrying the slip the real car
  measures (0.44): 48 puffs and 22 mark quads after two seconds of burnout, **0**
  puffs from a gripping tyre, **0** puffs at 180 km/h but rubber still laid.
- Traffic, 4 minutes at 150 km/h, four seeds: nearest spawn 460 m, longest stall
  **0.00 s**, car-frames below 1 m/s **0.00%**, same-lane overlaps **0**, settled
  lane error 0.076 m, population 9/9.
- End-to-end drive, 90 s flat out, four seeds: 0 non-finite states, **0.00%**
  airborne, **0** hard hits away from traffic, 0 recoveries, worst lane error
  **0.46–0.58 m**, worst yaw rate 0.74 rad/s, deepest below the road 0.23 m.
- Impact Δv peaks at exactly the 11 m/s cap; measured 661 m/s² against the
  660 m/s² the cap implies at 60 Hz.
- Handling, measured before and after on the same test: handbrake-turn yaw
  **3.22 → 2.27 rad/s**, catch **2.54 s / 169° → 0.82 s / 62°**, speed left after
  the catch **5 → 41 km/h**, drift exit **26 → 56 km/h**, unassisted catch
  **3.45 s → 0.98 s**. No rollover regression on monster / van / military /
  pickup in a 6 s slalom at 90 km/h.
- Launch: Sport **5.2 → 9.9 m/s²** in the first frame from rest at full throttle
  and **1.8 → 3.5** at a third throttle.
- Garage: engine blips 904 → 7819 rpm in neutral, selects first gear on Drive,
  and the parked car moves **0.0 cm in five seconds** on a grade.
- Traffic mode: 43 near misses detected in a 3-minute run (37 oncoming), closest
  1.07 m; scoring curve, oncoming bonus, chain build/decay/refill and cooldown
  all verified.
- **44 DOM ids and 16 toggled classes** resolve against `index.html`.
- Both paint slots and both lamp pairs populated on all 9 cars.
- Render smoothness, camera space, ten frame-rate patterns from 144 fps to
  20 fps including 30% jitter, 90 ms hitches and cornering: worst springing
  **9 mm**, world advance within 0.2% of `speed × dt` everywhere.
- The interface at **seventeen device viewports**, portrait and landscape, phone
  to desktop, including the drawers open, the pause menu and tilt mode: no
  overflow anywhere, and "Drive" visible without scrolling at every one of them.
- Every module parses; config audit clean across `src/` and `src/env/`.
- `engine_sim`'s own suites still pass (166 checks + the driving suite).

---

## 9. Traps — read before editing

1. **`engine_sim/` is not ours.** Do not edit it. The bridge overrides
   `_stepVehicle` *per instance* specifically so the vendored source stays
   pristine. If you need different behaviour, override more; do not patch.
2. **Config block placement** — §5. Highest-cost mistake in the project.
3. **Three composes T·R·S.** Bug #3.
4. **Winding order.** `(a,b,c)` / `(b,d,c)`.
5. **`ShaderPass` is GLSL ES 1.00.** No `const` arrays, no `in`/`out`. Bug #8.
6. **A smooth clamp is not a clamp.** `smin`/`smax` disagree with `min`/`max` by
   up to `k/4` each *near the crossover* — that is what they are for. Never give
   one a blend width wider than the gap it is blending. Bug #17.
7. **One threshold per concept.** Bug #19 was four places testing the same idea
   with three different numbers.
8. **Anything derived for a steady state stops being true in a transient.** The
   steering limit is correct physics and was still wrong to enforce mid-slide.
   Bug #30.
9. **A double-sided material makes coincident faces visible.** Anything swept
   twice will shimmer. Bug #35.
10. **Terrain marking must be a pure function of position.** Anything that
   depends on how far generation has got will freeze differently depending on
   where the player drove. Bug #27.
11. **Do not give traffic a rigid body.** Bugs #11, #12, #14, #15, #22 are all the
   same mistake. If traffic needs to interact with something new, compute the
   interaction; do not hand it to the solver.
12. **Audio must start inside a user gesture.** `Powertrain.start()` is called on
   the Drive click, not at boot.
13. **The settings drawer is a keyboard trap on purpose.** Do not "fix" the
    blur-on-release handlers.
14. `assets/` is **user-supplied**. Never regenerate, never overwrite.
15. **Never ray-probe on the mesh lattice.** §7, harness bugs.
16. **Overriding `_stepVehicle` blinds engine_sim's clutch to load.** Anything
    in that project which regulates on road speed is reasoning about a car it
    cannot see. Bug #42 is the first case; assume it is not the last.
17. **No width breakpoints in `index.html`.** §4.13. Adding one puts the file
    back on the road to bug #45.
18. **`damp()` is only correct for a goal that is standing still.** Anything
    following the car — a camera, a light, a reticle — is following a ramp, and
    plain exponential smoothing gives it a lag that varies with frame time. Use
    `util.dampTrack` and hand it both ends of the goal's travel. Bug #50.
19. **The terrain sheet is stored ORIGIN-RELATIVE.** `_setMatrix` subtracts the
    chunk origin because it takes a world position; handing it a point read
    straight out of `chunk.sheet.positions` subtracts it twice and puts the
    instance a chunk-length away. `_setLocalMatrix` is the one for sheet points.
20. **The frame-time clamp is not a free parameter.** It is
    `maxSubSteps * fixedStep` and nothing else. Loosening it does not buy
    smoothness, it buys a frame whose physics is shorter than the `dt` every
    other system is told about. Bug #51.
21. **The road ROUTES; do not make it wander again.** §4.2. In particular,
    earthwork is a budget and not an objective — minimising it finds flat ground
    and flat ground is boring. And `wBearing` is load-bearing: without a compass
    to follow, a contour-following router spirals.
22. **A chunk's terrain sheet is 700 m wide and 120 m long.** Anything that lets
    the road come back near itself puts one chunk's hillside across another's
    carriageway. Bug #55.
23. **Probes must build the window the GAME builds.** `surface.mjs` built every
    chunk at once and reported 33,110 steps on a carriageway that the height
    function and the drawn mesh both agreed was flat — all of them collisions
    between chunks that can never coexist.
24. **`config.js` exports EIGHTEEN blocks.** `TREES` and `BUSHES` joined
    `GROUND`, `ROCKS`, `WIND`, `FX`, `GRASS`, `ROUTE`, `TITLE` and `SCORE` — add
    any new block to the audit regex in §5, and remember it walks `src/env/` too,
    or it checks nothing. The audit reads prose as well as code: write
    `GROUND.contrastNear` in a comment, not the shorthand.
25. **The fold guard's curvature is NOT `frame.curv`.** It is `foldL`/`foldR`,
    and the difference is bugs #58 and #59. Anything that "simplifies" the guard
    back onto the smoothed curvature re-folds the sheet, silently, in the far
    field where nobody looks.
26. **Anything that samples ground must be a pure function of `s`.** The
    foreign-segment cache is keyed on `frame.s` for that reason, and `_build`
    calls `path.ensureLength(s1 + ROUTE.selfFar)` so the answer cannot depend on
    how far generation has got. Trap #10 with a new instance.
27. **A tier is a descriptor, not a second code path.** Near and far ground cover
    share one `_buildGrass`, one geometry and one shader program. Forking either
    is how the two stop agreeing about where the ground is.
28. **`input.steer` is normalised, not an angle.** Full stick is full *available*
    lock, which at 160 km/h is a sixth of `V.maxSteer`. Anything computing a
    steering angle must divide by `vehicle.steerLimit`. See §7's harness note —
    this one cost a long detour spent blaming the terrain.
29. **`slipAmount` does not reach 1.** A car lighting up its rear tyres measures
    0.39–0.46. Any threshold on it belongs next to a measurement, not next to an
    intuition. Bug #63.
30. **The title screen's split is one rule.** Half the screen is the car, half is
    the interface, along the long axis. `#stage` exists so the camera can measure
    the free half; do not go back to inferring it from where two panels landed.
31. **`src/env/` generators must survive having no canvas.** The probes stub
    `document.createElement` and `getContext` returns null. Return `null`, do not
    throw, and treat a missing map as "untextured" downstream.
32. **Anything scattering per-sample must read the terrain SHEET, not re-derive
    the ground.** `meshGroundPoint` is the honest answer and it is four road
    frames and four fBm evaluations. The ground cover learned this at 591 ms per
    chunk; the tree scatter learned it again at 62 ms. Read
    `chunk.sheet.positions`, interpolate the same quad over the same diagonal
    with the same winding, and take the slope from the corner heights. Sheet
    points are ORIGIN-RELATIVE — trap #19, and `_setLocalMatrix` is the one that
    takes them.
33. **`vegetation()` is one field for three scatters, on purpose.** Canopy,
    understorey and ground cover come out of a single evaluation so they cannot
    disagree. Giving any of them its own density rule is how a clearing goes
    back to carrying the same sward as a thicket.
34. **The grown canopy has a shorter lifetime than its chunk**, and the recipe
    for it is computed ONCE by `_buildProps` and cached. Re-running the seeded
    scatter to rebuild a tier would agree until the first time the sampling
    changed, and then a tree and its own impostor would stand apart.
35. **A limit built from a noisy estimate is a limit that lies in both
    directions.** The fold guard read twice the road's design curvature off
    spline roughness and ate half the world (#64); smoothing the estimate is
    safe, putting a FLOOR under the result is not, because sometimes the road
    really is that tight. Measure inverted cells before and after — that is what
    `probe/offroad.mjs` is for.
36. **Tilt steering's axis depends on `screen.orientation.angle`.** `gamma` and
    `beta` swap roles as the device rotates, and the sign flips again between
    the two landscape orientations. Never assume landscape. And the permission
    call needs a tap — trap #12's rule, a second time.

---

## 10. Testing

There is no test runner and no assertion library. `probe/` holds scripts that
drive the real modules under Node and print numbers; the whole simulation is
headless-capable and only rendering needs a GPU.

```bash
npm run probe:deps      # three + rapier, --no-save
npm run probe
```

| script | answers |
|---|---|
| `probe/ui.mjs` | Every DOM id a module reads exists; every class it toggles is styled. |
| `probe/paint.mjs` | Both paint slots and both lamp pairs got triangles, on every car. |
| `probe/grass.mjs` | Near-tier ground cover: count, scatter cost, density, and that none of it is on the carriageway. |
| `probe/env.mjs` | **Everything in `src/env/`, plus `fx.js`.** Far-tier grass budget and band; rock geometry (normalised width, standing on y = 0), scatter, draw batches; and the tyre effects driven directly against a stub carrying the slip the real car measures. |
| `probe/engine.mjs` | Does the bridge still match `engine_sim`'s API, and does every engine spin up? |
| `probe/surface.mjs` | Is the carriageway drivable end to end? Exits non-zero on any step over 30 cm or any hole. The guard against a terrain change burying the road. |
| `probe/cliff.mjs` | Longitudinal terrain steps. |
| `probe/traffic.mjs` | Spawn distance, stalls, overlaps, lane error, population, impact Δv. |
| `probe/score.mjs` | The near-miss mechanic, without physics. |
| `probe/props.mjs` | **The canopy and the understorey.** Per-species triangle counts, determinism of the library, per-chunk caps and draw batches, scatter cost, clearance from the carriageway, float off the collider, and — the new one — that the scatter is LUMPY rather than uniform. |
| `probe/offroad.mjs` | **Is there ground everywhere the player may drive?** Rays a grid over the whole area `_checkRecovery` allows, reports the corridor width the fold guard is delivering, and counts folded cells. Bug #64's regression test. |
| `probe/handling.mjs` | Steering by speed, slide recovery, drift, rollover safety. |
| `probe/smooth.mjs` | Is the car smooth **on screen** under frame-time jitter and hitches? Camera-space metric. |
| `probe/terrain.mjs` | Faceting, by distance band. |
| `probe/route.mjs` | Shelf share, earthwork, curvature, grade, corridor relief, self-clearance. Not in `npm run probe`. |
| `probe/xsec.mjs` | Cross-sections — the fastest way to read what an alignment is doing. |
| `probe/drive.mjs` | End-to-end: real car, real physics, real `engine_sim`, real traffic. |
| `probe/uishot.mjs` | **What the interface looks like**, at seventeen real device viewports, plus an overflow report. Not in `npm run probe` — needs a local Chrome. |
| `probe/render.mjs` | **What the GAME looks like.** Boots the real thing through SwiftShader, drives it, screenshots the garage and the road. Not in `npm run probe` — needs a local Chrome and takes a minute. |

`probe/render.mjs` takes `[seed] [seconds] [teleport]`; the third jumps the car
to an arc length, because at 20 fps a minute of driving covers two hundred
metres and every shot is otherwise of the same kilometre. `SKID=1` stops the car
and floors it — see §8 for why that does not actually produce smoke here.

**There is no probe for the wind**, and there is no obvious one: it has no
geometry and no measurable output short of rendering audio. The graph builds
without error in `engine_sim`'s Web Audio mock, and that is all that is checked.

Each takes an optional seed as the first argument. `drive.mjs` also takes a
duration in seconds.

Syntax check across all modules:

```bash
mkdir -p /tmp/frc
for f in src/*.js src/env/*.js; do cp "$f" "/tmp/frc/$(basename ${f%.js}).mjs"; \
  node --check "/tmp/frc/$(basename ${f%.js}).mjs" || echo "FAIL $f"; done
rm -rf /tmp/frc
```

`node_modules/` is gitignored and only exists for probes.

---

## 11. Running the game

```bash
python3 -m http.server 8080
# → http://localhost:8080
```

Any static server works. It must be served over HTTP, not opened as a `file://`
URL, because of ES module and WASM loading rules.

Note: port **8000 is usually taken by `engine_sim`'s own dev server**. Use a
different port for highroads so both can run side by side.
