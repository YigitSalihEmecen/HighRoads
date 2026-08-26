# HIGHROADS — project context

For an agent picking this up cold. Assumes you can read the code; gives the
shape, the reasons behind decisions that look arbitrary, and the traps that have
cost time.

Companions: `README.md` (architecture essay), `probe/README.md` (measurement),
`src/env/README.md` (generator contract), `engine_sim/AGENT_CONTEXT.md` (**a
separate vendored project — read before touching audio**).

---

## 0. What it is

Infinite procedural driving in the browser. Three.js renders; Rapier3D does
rigid-body physics **for the player's car only**; a hand-written gradient-noise
chain makes terrain. The car is a **raycast vehicle** — one rigid body, four
downward suspension rays. `engine_sim/` is the car's actual drivetrain, not just
its soundtrack. Everything streams in chunks, forever, from a typed seed.

**Nothing visible is an asset** except the car models. Terrain, road, foliage,
grass, stone, textures, smoke and wind are generated at boot in `src/env/`.

No build step. ES modules + import map, served statically.

---

## 1. Layout

```
index.html      shell, import map, garage UI, HUD, touch controls, ALL CSS
src/            20 modules + src/env/ (8)
probe/          headless measurement (§10)
assets/         USER-SUPPLIED art. Never regenerate, never overwrite.
style_examples/ reference art the low-poly foliage was built against
engine_sim/     vendored sibling — DO NOT EDIT
```

| module | owns |
|---|---|
| `chunks.js` | terrain/road mesh, colliders, streaming, **every scatter** |
| `config.js` | all tunables, **19 blocks** + the graphics levels |
| `vehicle.js` | raycast vehicle: suspension, tyres, aero, stability |
| `main.js` | boot, `Game`, fixed-step loop, garage wiring, recovery |
| `path.js` | centreline spline, Frenet frames, arc-length projection |
| `foliage.js` | species vocabulary — form, habitat, guild — and `vegetation()` |
| `assets.js` | FBX car loading, mesh normalisation, metrics. **Cars only** |
| `traffic.js` | spline riders, AI, lane changes, analytic impacts |
| `powertrain.js` | the `engine_sim` bridge |
| `noise.js` | gradient noise, fBm, erosion, warping, landforms, continent |
| `fx.js` | tyre smoke (GPU pool) and rubber (quad ring) |
| `cars.js` | 9-car roster, colours, engines, physics synthesis |
| `scene.js` | renderer, lights, sky, fog, post chain |
| `camera.js` `input.js` `hud.js` `settings.js` `score.js` `wind.js` `util.js` | as named |

`src/env/` — one factory per module returning shared geometry + one shared
material; **placement lives in `chunks.js`** because only placement needs the
road, the sheet and the streaming window.

| module | builds | tris/instance |
|---|---|---|
| `textures.js` | canvas helpers, seeded PRNG, **tileable** noise/fBm/ridged, `paint()` | — |
| `lowpoly.js` | faceted-solid primitives: warped lumps, tapering tubes, conifer skirts | — |
| `trees.js` | faceted low-poly trees, near and far tiers from ONE builder | 93–334 / **39–88** |
| `bushes.js` | four shrub forms, clusters of faceted lumps | 75–115 |
| `grass.js` | crossed-card tufts: roadside, woodland-floor and far tiers | 4 |
| `rocks.js` | fractured convex boulders, slabs, scree | 20–80 |
| `ground.js` | terrain detail texture + material patch | — |
| `road.js` | asphalt mask + material patch | — |

### ⚠ `engine_sim/` is a broken submodule

Parent tracks a **gitlink** (`461ad03`) with **no `.gitmodules`**. A fresh clone
gets an empty directory and `powertrain.js`'s import 404s — the game does not
boot from a clean checkout. Three-way drift: parent pins `461ad03`, upstream
`main` is `188c19a` (2 ahead), local tree is `461ad03` + uncommitted edits.
Upstream is API-compatible **except**: `sim.comp` became `sim.dynamics` (guarded,
so the high-rpm taming silently stops applying), and `cars.js:ENGINE_OPTIONS`
lacks five new engines. Left alone deliberately — fixing it needs a decision
about the local edits.

---

## 2. Boot and frame

**Boot**: `createScene` → `RAPIER.init` + world at `WORLD.gravity`, `timestep
1/120` → `createTerrain(seed)`, `new RoadPath` → `ChunkManager`, `preload`, one
`world.step()` so colliders exist → load 9 car FBXs → garage UI → **on "Drive"**:
`RaycastVehicle`, `Powertrain.start()` (**first AudioContext touch, must be
inside the gesture**), `Wind`, `loop()`.

**Frame**: `input.update` → `_handleActions` (one-shot keys) → `powertrain.update`
→ `while (acc >= 1/120 && steps < maxSubSteps) { vehicle.beginStep();
vehicle.update(h, input); world.step(); }` → `vehicle.syncVisuals(acc/h)` →
`path.projectPoint` → `chunks.advanceTime` → `chunks.update(carS)` → `fx` →
`wind` → `traffic` → `camera` → `hud` → render. `input.endFrame()` **last**.

**The ordering is load-bearing.** Vehicle forces are integrated *inside* the
substep loop. Applying them per rendered frame gives a car that behaves
differently at 60 and 144 Hz.

---

## 3. Road space — the central idea

Terrain is generated in **road space** and mapped out, not draped over world
space. Every sample is `(u, v)` = arc length along the centreline, signed
lateral offset. Carving becomes a 1D blend on `|v|`; cut and fill become

```
y = clamp(natural, roadY − fillSlope·d, roadY + cutSlope·d)
```

in `chunks.js:sampleGround()`, with `smin`/`smax` — **and the blend width is not
a constant** (bug #17, #57).

### Parallel curves degenerate — three mechanisms guard it

Rows radiate perpendicular from the centreline and converge on the inside of a
bend, meeting at `R = 1/|curvature|`.

1. **`foldSafeOffset(v, k)`** — a soft minimum, `v' = |v| / (1 + (|v|/L)^p)^(1/p)`,
   `p = 6`, `L = ROUTE.foldMargin/k`. Not an exponential: an exponential bends
   immediately, so a *straight* (curvature wandering through zero) had its far
   corridor squeezed differently on every row — two rows 2.5 m apart moved a far
   column **87 m** (#58). O((v/L)^6) is invisible until `v` is a real fraction of
   `R`; the same rows now disagree by 0.1 m.
2. **Relaxed heading** — rotating the *lateral direction* instead of compressing
   `v`. `path.js:_buildRelaxed` stores `relaxDev` (a windowed mean heading over
   `ROUTE.relaxWindow`) and `relaxL`/`relaxR`; `chunks.js:lateralAt` blends by
   `b = smoothstep(CHUNK.relaxBand)`, giving effective curvature
   `(1−b)κ + b·κ̃`. **`b` must be a function of `|v|` ALONE** — anything with an
   `s` dependence makes `∂b/∂s·relaxDev` unbounded and folds the mesh. Corridor
   94 m → 412 m, inverted cells 204 → 4.
3. **The world-space apron** (`chunks.js:_updateApron`) — a car-following XZ
   heightfield under the road-space sheets, with a trimesh collider. It is the
   only parameterisation that cannot degenerate, and it is what makes "no holes"
   unconditional rather than probable. Clamped under the road via
   `path.roadNear` + `CHUNK.apronRoadSink`/`foreignSlope`, or in a cutting it
   sits above the carriageway (bug #55's structure on the road's own pass).

The guard's curvature is **`relaxL`/`relaxR`, never `frame.curv`** — see trap 25.

### The foreign-road clamp (#55, #60)

A chunk carries terrain 700 m either side while being 120 m long, so where the
route doubles back one chunk's sheet covers another's road as uncarved hillside.
`ROUTE.selfClear` cannot fix it (300 m apart, 700 m wide). `sampleGround` also
clamps against `path.foreignSegments(...)`. Three details, each a wrong answer
first: **segments not control points** (46 m apart → 23 m error → 2.7 m standing);
**a 10% slope and a 4 m sink**, not the road's own 62% (the far sheet's 34 m
columns draw the CHORD across the V — 17 m of error); **one smooth minimum with
`k` tied to the gap** (smoothing in the loop compounds; a fixed width concedes
k/4 on the carriageway = a 0.875 m trench, bug #57).

---

## 4. Subsystems

### 4.1 Noise (`noise.js`)

`createTerrain(seed)` → `base`, `height`, `roadElevation`, `region`,
`forestDensity`, `mask`, `continent`. Chain: gradient noise **with analytic
derivatives** → fBm → `erodedFbm` (Quilez `morenoise`, damped by accumulated
gradient) → `ridgedFbm` with a **softened** fold `1 − √(n²+0.004)` (the hard
`1−|n|` is a C1 discontinuity per octave — bug #24) → domain warp → six landform
archetypes blended by an exponential kernel (`SIGMA2 = 2·0.245²`) → **continent**.

**The continental term is what stops the world averaging to zero.** Two octaves
at 11 km and 5.5 km, ±340 m, under everything. Wavelength is measured against how
far the road **travels** (~0.4 m of map per metre of tarmac). Amplitude is bounded
by `ROAD.maxGrade`. Evaluated at **full octave depth always** — `lodOct` is saved
and restored around it, because at this amplitude a 20% octave-weight change
between 34 m columns is metres of height.

**Octave budget**: `height(x, z, lateral)` derives the budget from the mesh's own
lateral resolution — 8 octaves on the road, 3.2 at the corridor edge. Sampling a
7 m feature every 34 m is aliasing, and aliased gradient noise reads as spikes.

### 4.2 Route (`path.js`) — the alignment is ROUTED

Catmull-Rom through control points generated one at a time, each **chosen**: fan
out `ROUTE.candidates` legal headings, score, commit to the cheapest. Galin et
al. (CGF 2010) reduced from global A* to greedy lookahead, O(1) per point.
Elevation is an **output** — the router aims at the balanced cut-and-fill line
and clamps to a legal profile.

- **Earthwork is a BUDGET, not an objective.** Minimising it finds flat fields:
  measured, 6.4 → 4.9 m earthwork *and* sidehill 12% → 8%.
- **`wBearing` stops it spiralling.** A contour line around a hill is a circle.
- **`selfNear`/`selfFar`/`selfClear` are STRUCTURAL** — see #55.

**FOUR WINDOWS, NOT ONE**, and mixing them costs real things:
`CURV_WINDOW` ±10 m gives `tan`/`right`/`up`/`bank`/`curv` (widening it took one
seed's lane error 5.8 → **16.8 m**: a bank that lags an S-bend throws the car
off the outside); `FOLD_WINDOW` ±25 m gives `foldL`/`foldR`/`relaxL`/`relaxR` as
a per-side **running maximum** of frame-to-frame rotation; `ROUTE.foldSmooth` ±6
samples pre-averages the turn rate (exact for a circular arc); `ROUTE.relaxWindow`
800 m gives `relaxDev`.

Key methods: `frameAt(s, out)` (**pass `out`**), `foreignSegments`, `roadNear(x,
z, sHint, range, out)`, `corridorAt` (reads `relaxL`/`relaxR`), `projectPoint`,
`lateralOffset`, `ensureLength`.

### 4.3 Chunks (`chunks.js`) — the biggest file

One chunk = 120 m of road + terrain to 700 m each side. `update(carS)` keeps
`CHUNK.behind` (2) / `ahead` (6) alive, builds ≤1 per frame. **20 ms** per chunk.

Build order: `ensureLength(s1 + ROUTE.selfFar)` (the foreign clamp asks about
road 1600 m ahead; an answer that depends on how far generation has got is not a
pure function of position — trap #10) → `_buildTerrain` → `_buildRoad` (lane
markings are a **lateral profile of coloured bands**, not a texture — which is
why they never stretch) → `_buildProps`. Ground cover, stone and the near canopy
are **not** part of the build: shorter lifetimes, streamed separately.

- **Ghost rows.** `_buildTerrain` samples one row past each end and keeps the
  interior, so both chunks agree because both evaluate the same function. The
  analytic `_seamNormals` it replaced disagreed with `computeVertexNormals`'
  area-weighted average wherever the surface is not locally flat — a shading
  *and* colour seam every 120 m (#61).
- **`meshGroundPoint`** interpolates the rendered triangle. Props placed with it
  sit on the visible surface; props placed with `sampleGround` float.
- **`_gatherForeign`** is a CACHE keyed on `s`, not state.
- **Colour** (`_groundColor`): nine palette entries, altitude cue relative to
  `terrain.continent` (an absolute ramp paints whole regions), two mottles
  (~70 m, ~350 m), snow needs altitude **and** a flat face.

### 4.4 Tunnels — REMOVED

Gone completely. Deep cuttings are what the cut/fill clamp produces instead.
Bugs #10, #18–20, #27–29, #35, #36 were all tunnel bugs — history, not traps.

### 4.5 Vehicle (`vehicle.js`)

One dynamic body, four downward rays. `_suspension` (Hooke + damping from the
compression *rate*), `_antiRoll` (bar rate derived from a target roll angle),
`_tyres` (Pacejka `Fy = D·sin(C·atan(B·α))`, friction circle, low-speed blend).

- **`_updateSteering`**: `δ_max = atan(L·a_max/v²)`, `a_max = min(μ(g +
  downforce·v²/m), SSF·g)`. Correct physics — and **wrong to enforce in a
  transient** (#30): once sideways the front wheels are pointed down the velocity
  vector, not making more lateral force. Two openings now:
  `slideOpenFrom/To` on `|beta|`, and **directional countersteer authority** —
  when `input.steer * betaSigned < 0`, lock opens from 2° of slip to
  `V.maxSteer * counterLock` at full slew rate. Symmetric opening helps
  provoking a slide exactly as much as catching one, which is why it was not
  enough on its own.
- **`_stability`**: yaw damper faded in between `driftAngle` (29°) and
  `spinAngle` (60°). Below the first it does nothing and the tyres peak near 7°,
  so ordinary cornering and a held drift are untouched (#38).
- **Yaw inertia is inflated 1.6×**. A solid box implies a yaw radius of gyration
  of 0.29·L; real cars measure 0.35–0.40. Largest single contributor to the car
  feeling like it has weight.
- **`syncVisuals(alpha)`** interpolates pose between physics states: 146 mm → 0.3 mm.
- **`steerLimit` is published** — `input.steer` is NORMALISED, and anything
  computing an angle must divide by it (trap 28).

### 4.6 Cars (`cars.js` + `assets.js`)

Nothing is hand-tuned. `buildCarFromObject()` measures the FBX (wheelbase, track,
wheel radius, CoM height); `buildCarParams()` synthesises springs, damping, bar
rate and steering limits from those plus `grip`/`mass`/`power`.

**Two paint slots, both discovered not declared.** `rankPaintCells` orders atlas
cells by area; the top two get their own materials, the second defaulting to the
swatch sampled from the atlas (#44). Traffic clones **share the roster's
materials** — painting your Sport repaints every Sport. Pre-existing.

**No torque tuning here** — `engine_sim` owns the curve, clutch and shifts.

### 4.7 Powertrain (`powertrain.js`)

`engine_sim` is used **unmodified**; the bridge overrides one method per
instance: `dt._stepVehicle = () => { dt.ww = this._ww; }`. The game feeds wheel
omega, gets propshaft torque. Two corrections follow from that override:

- **`_launchFloor`** — the drivetrain never sees wheel load, only that wheel
  speed is not rising, and its launch controller regulates on *road speed*. Below
  7 m/s in first, assert `0.72 × peakTorque × throttle` through the gear (#42).
- **`_retuneLaunch`** — `launchRate` is computed once in engine_sim's constructor
  and neither `setVehicle` nor `setEngine` revisits it; out by up to 2× both ways
  across the roster (#43).

`mix.mechanical` is 0 — that layer is band-passed pink noise and reads as hiss.

### 4.8 Traffic (`traffic.js`)

**No traffic rigid bodies and no traffic colliders anywhere.** A car is `(s, v)`,
a speed and a mesh. A body driven by writing its velocity has infinite mass, so
the contact impulse is never consumed and compounds — measured history: 6920 km/h,
a 35 m ejection, then cars that stopped dead (#11–15, #22).

States: cruising / spun out (scripted) / dead. `_targetSpeed` (time headway,
corner speed `√(a/κ)`, yields when flashed). `_separate` asserts spacing
directly — with nothing simulated, overlap is *impossible* rather than unlikely.
`_resolvePlayer`: two boxes in road space, closed-form impulse
`j = −(1+e)(v_rel·n)m₁m₂/(m₁+m₂)`, applied to the player only, capped at
`TRAFFIC.maxImpactDv`. Energy cannot be injected. Spawns beyond 460 m, never behind.

### 4.9 Modes and scoring (`score.js`)

Zen disables traffic; Traffic scores near misses and ends on the first collision.
`_trackPasses` reports the **minimum** clearance once a car is astern — a
per-frame sample would make the reward frame-rate dependent (two cars can close
and pass inside one frame at 250 km/h closing). Chains are **refilled**, not
extended, so a late pass is worth as much as an early one. No DOM, no game state.

### 4.10 Title screen = the real road

No `showroom.js`. The rig orbits the real car on the real road at `START_S` in
the real scene, so what you choose is what you drive, paint included.

- **`_seedOrbit` picks the lit side** — starts on whichever of `TITLE.angles`
  faces `ATMOSPHERE.sunDir`. Two lines, replacing a whole studio scene (#56).
- **The framing is MEASURED.** `#stage` is an empty rectangle in a CSS grid;
  `camera.frameTitle` gets its `getBoundingClientRect` every frame and solves the
  distance that fits the car's **diagonal** into it (fitting length alone frames
  it beautifully side-on and runs it off both edges a second later).
- Corrects on **both axes along the CAMERA's** right/up, because the rig orbits.
- **The aim offset is NOT the damper's state.** Adding a per-frame offset to
  `this.lookAt` multiplies it by `1/(1−e^(−k·dt))` — 9× at 60 fps.
- **Leaving is a FLY-IN**, `TITLE.introTime` 1.35 s, double smoothstep. Damping
  cannot do it: asked to cross 15 m it either crawls or snaps. **Controls are
  live from frame one.** The fly-in belongs to the Drive button only (#65).

### 4.11 Foliage — faceted low-poly (`foliage.js`, `env/lowpoly.js`, `env/trees.js`, `env/bushes.js`, `chunks.js`)

Built against `style_examples/`. A tree is a **tapering faceted stem** carrying
either a cluster of warped lumps or a stack of jagged conical skirts;
flat-shaded, per-face coloured, **no texture, no UVs, no alpha test**.

#### What it replaced, and why

Grown branch skeletons with alpha-cutout leaf cards, and a four-triangle painted
billboard past 260 m. Right for a naturalistic canopy, wrong for this one: a
faceted canopy has no small leaves, so a card buys nothing and costs two
atlases, an `alphaTest`+`DoubleSide` material, and — the reason it had to go —
**two different pictures of one tree** that disagreed at the handover. Reported
symptom: distant trees out of place, shrinking as near ones grew.

#### One builder, two tiers

`growTree(form, seed, variant, far)`. The far tier is the **same call at a lower
subdivision** — same seed, same envelope, same palette. `matchWidth` then
squeezes it in X/Z until its crown radius equals the near tier's (**2%**), with
the normals transformed by the inverse transpose. Both tiers take the **same
instance matrix**, so the cross-fade is a change of face count and nothing else.

| | near | far |
|---|---|---|
| triangles | 93–334 (mean 223) | 39–88 (mean 53) |
| lifetime | `TREES.behind/ahead` = 7 chunks | with the chunk = 9 |
| fade | out 260→420 m | in 260→420, out 620→720 |

`TREES.loneFadeIn` [480, 660] is for far trees with **no** near mesh behind them:
`nearCap` 180 and `farCap` 760 are a 4:1 density difference, and with one window
for both the surplus shrank into the ground as the player drove at it.

#### Primitives (`env/lowpoly.js`)

`Facets` (non-indexed, per-face normal + colour + `aSway`), `blob` (warped
icosphere), `tube` (parallel-transported tapering n-gon, no caps), `tier`
(jagged conifer skirt; only the lowest gets a floor).

- **Interior culling** drops any face whose centroid is inside another lump —
  worth a third of the canopy. It evaluates the occluder's **own** warp, so the
  occluder records must be the `{c, r, warp}` plans the caller assembled. A shape
  mismatch fails **silently**: an oak was 576 triangles instead of 334 with no
  symptom but the budget.
- **`material.flatShading` is deliberately NOT set.** It would recompute normals
  the geometry already has and leave the colour smooth — and per-face colour is
  half the look.

#### Colour is BAKED, per variant

`TREE_FORMS[*].palettes` and `SHRUBS[*].palettes` are `[main, alt]` per variant,
mixed by height and facing. A chunk commits to one variant, so a copse is one
colour and the next is another — three seasons of maple for free. `chunks.js`
applies only a near-1.0 **modulation** (`TREES.groundTint` 0.16,
`instanceVary` 0.14). The old per-instance blend halfway toward the ground colour
desaturated every palette to the same olive.

#### `vegetation()` — one field, four densities, one guild

One evaluation returns `{canopy, understorey, ground, floor, edge, moisture,
rugged, stand, gConifer, gPale, gWarm}`, so the scatters **cannot disagree**.

- **EDGE** = `4c(1−c)` on canopy. Peaks at half-closed canopy — the woodland
  fringe, where the scrub is. A wood grows its own fringe.
- **FLOOR** rises *with* canopy — long shade grass. The opposite of `ground`,
  which is thinned by shade.
- **GUILD** — conifer / pale / warm, as three **non-overlapping bands with gaps**
  on one slow axis (`terrain.mask` at 0.0011, shifted by altitude, ruggedness and
  moisture). The gaps are where woods are genuinely mixed. **The mask is
  stretched against its measured range**: two octaves span 0.25–0.72 with half
  between 0.445 and 0.555, so used raw the whole world sat in the middle band —
  neighbouring trees agreed 83% against 79% by chance, i.e. the field did
  nothing. p05..p95 (0.367..0.631) maps to 0..1. Same trap as `TREES.barePatch`.
  Now **87–93% agreement against 39–48% by chance**.

`suitability()` multiplies by `0.04 + 0.96·guildAffinity`. A stand admits its own
species, a guild-mate at `TREES.clusterMix` (0.22), and **nothing else** —
`dead` has no guild and goes anywhere. The old rule left any off-species tree at
0.32, so one tree in six of a bright birch copse was a dark conifer.

#### Placement (`_buildProps`)

Cluster-seeded, not Poisson. Seven things make a stand a stand:

1. `TREES.clusterShare` (0.72) drawn near one of `clusterCount` seeds, Gaussian.
2. **Radius on a POWER LAW** — `lo·(hi/lo)^(u²)` over [11, 78] m: mostly thickets
   with the occasional real wood. A uniform draw gives nine copses the same size,
   which reads as a texture.
3. **A cluster is one species**, chosen against the guild field **at the seed**.
4. Seeds are **rejected**, not moved, where canopy is weak. The clearings are the point.
5. **Radial thinning** — acceptance `1 − (d/r)^clusterFalloff`, so a stand has a
   fringe of its own.
6. **Age structure** — `vigour` 0.42 lost at the rim (the middle grew first) and
   `saplings` 0.18 of the draw at a third height. A wood of one size reads as planted.
7. **Crown spacing on a hash grid** — two crowns may overlap by `crownGap` (0.5)
   of their combined radii. Two interpenetrating alpha cards were invisible; two
   interpenetrating faceted crowns are the most obvious artefact in the scene.
   Plus `coppice` (0.14): a second stem from the same stool, skipping the spacing
   check, because touching is the point.

The chunk's `TREES.picks` species are **guild-weighted**, not shuffled: a flat
shuffle spends six slots uniformly over eight species, so in conifer country half
go to broadleaves the field then rejects at every sample — the scatter ran three
times as many candidates for the same trees (11.5 → 3.8 ms/chunk).

**Two lifetimes.** `_buildProps` runs the scatter **once**, builds the far tier
and the shrubs, and caches the near tier's matrices as `chunk.canopySpec`;
`_updateCanopy` turns that into meshes as the car arrives. Two tiers from two
runs of a seeded scatter would agree until the sampling changed, and then a tree
and its own far stand-in would be in different places.

#### Species

| species | guild | form |
|---|---|---|
| `pine` | conifer | clear stem, 4 skirts on top |
| `spruce` | conifer | 6 skirts to the ground |
| `oak` | warm | short stem, hard fork, wide dome |
| `maple` | warm | round head; orange / red / gold variants |
| `birch` | pale | slender, white stem, yellow-green |
| `poplar` | pale | lumps in a vertical line |
| `aspen` | pale | pale stem, gold egg |
| `dead` | *none* | bare forked armature, above the treeline |

Shrubs: `bramble` (round), `hazel` (upright, multi-stem), `gorse` (crested dome),
`heather` (cushion). Named `SHRUBS` because `BUSHES` is the config block.

**Shrubs are rounded leafy domes, and the main lump must be `detail: 1`.** The
first version used `detail: 0` (20 faces to a sphere) with `warp` 0.26–0.34 and
five thin vertical lumps for gorse; photographed next to the trees they read as
broken rock. Halving the warp and subdividing the main mass is the whole
difference, and it costs ~30 triangles. Hazel needs **short stems and big heads**
or it is three lollipops on sticks.

### 4.12 Ground cover — THREE TIERS (`env/grass.js` + `chunks.js`)

A tuft is two crossed quads carrying a painted card of seven blades. The card is
**luminance only**; all hue comes from the per-instance colour sampled from the
terrain. A tier is a plain **descriptor** in `ChunkManager.grassTiers` — one
`_buildGrass`, one geometry, one shader program (trap 27).

| | roadside | woodland floor | far |
|---|---|---|---|
| gate | `field.ground` | **`field.floor`** | `field.ground` |
| chunks | ±1 | ±1 | −1/+6 |
| band | 62 m | 120 m | 185 m |
| height | 0.55–1.25 m | **1.1–2.4 m** | ×1 |
| card | 7 blades, short | 7 blades, long + wide | same as roadside |
| lift | 1.20–1.55 | 1.02–1.28 | 1.20–1.55 |
| fade | out 62→95 | out 78→118 | in 55→110, out 420→630 |
| placed | ~19,700/chunk | ~3,300/chunk | ~3,100/chunk |

**The tiers cross-fade by SCALE, not opacity** — the material is an alpha-test
cutout, so a tuft shrinks about its own base and sinks into the ground.

**`GRASS.density` is an ASK, not a count.** Samples on ground too steep are
dropped and every cell is scaled by `vegetation()`'s density, so the survivors
depend on the terrain: 1.27/m² placed against 3.60 asked. Re-run
`probe/grass.mjs` after any terrain change.

The field is **memoised on a coarse grid** (10 m × 6 m). Per cell it costs 14 ms
a chunk for resolution the field does not have — its finest feature is ~70 m.

Two mistakes the woodland tier made, both worth keeping written down:

- **Gated on the TEXTURE instead of the config.** `bladeTexture` returns null
  wherever there is no 2D canvas, so the whole tier was invisible to every
  headless probe while rendering fine in a browser. `src/env/README.md` rule 2.
- **Darkened twice.** A darker card *and* a `lift` below 1 *and* the geometry's
  own root shading multiplied to black. The shade is already in the ground
  colour the instance takes. That is bug #52, a second time.

### 4.13 Terrain detail (`env/ground.js`) and the road (`env/road.js`)

Grass geometry fixes the first forty metres. Beyond it the vertices are metres
apart and the interpolator draws a smooth ramp — which over a field is what
"flat green" looks like.

**`ground.js`**: one tiling RGB map, all three channels **luminance**, multiplied
into `diffuseColor` after the vertex colour. R sward (5:1 stretched streaks —
grass lies down in a direction), G rock (ridged, so creases are lines), B soil
(texel-scale grain so mipmapping removes it with distance). Slope picks between
them by the same normal the palette uses. **Two scales, 5.5 m and 28 m** — not a
round ratio, so they beat with a ~154 m period for one extra fetch.

**`road.js`**: `asphaltTexture` paints R aggregate (fBm bed + bimodal chip
lattice — the bimodal part is what reads as stones in bitumen), G wear, B cracks
(thresholded ridged noise, because a crack is a line). Two tile scales, the near
one faded out before it aliases. Roughness 0.95 with polished wheel paths — dry
asphalt is 0.92–0.98, and the old 0.68 put a sheen down the whole carriageway.
**Paint is detected by luminance**, no attribute needed: markings are geometry in
the same mesh at `0xe9e3d2` against asphalt that never modulates past ~0x4a. Paint
takes the wear and cracks but not the aggregate — paint is a film laid ON stones.

Both are **planar in world XZ, not UV** — the sheet is parameterised in road
space where columns run 2.4 m to 34 m, so a UV map would stretch thirty-fold
across one hillside. Planar lines up across seams by construction. Both are
`NoColorSpace`: they are modulation masks, not colours.

### 4.14 Stone (`env/rocks.js` + `chunks.js`)

Not scenery — **texture**. Chips along the shoulder, scree out of a cutting, the
occasional boulder. A rock is a subdivided icosahedron, displaced by two octaves,
squashed, then **clipped against random half-space planes** — which is what a
fracture is; without it the result is a potato. Normals FLAT.

One rule does the work: **the steeper the ground, the more likely stone is and
the more of it is scree** — that single smoothstep gives talus under a cutting,
chips along a bank and the odd stone in a field without any being a special case.

- **A chunk uses a WINDOW into the variant library** (`variantsPerChunk` 2 per
  class). Every distinct geometry is another draw call; the full library was
  eleven batches for a hundred rocks. Now 6.0.
- **Scree never casts a shadow** — the cascade is 4 cm a texel, so a 15 cm chip's
  shadow is noise, and there are more chips than everything else together.
- **Stone does NOT take the ground's colour.** It draws from `ROCKS.palette`, a
  fixed set of mineral greys and browns. This is the one documented exception to
  `src/env/`'s rule 5, and the reason is that the rule is about things that
  *grow*: sampling the verge gave every chip the grass's green, which reads as
  algae. The table lived inline in `_buildRocks` until it was the only colour
  decision in the project not in `config.js`.

### 4.15 Tyre effects (`fx.js`)

Both driven by ONE quantity, `wheel.slipAmount` — the same number the skid audio
uses. A visual effect that disagrees with the sound is worse than none.

**Smoke is a GPU pool**: 260 particles allocated once, recycled oldest-first. Each
carries origin, velocity and birth time; the vertex shader solves the closed form
`x(t) = x0 + v0(1−e^(−kt))/k + rise·t`, so the CPU writes a particle **once**.
Billboards built in VIEW space. **Rubber is a ring of 3,000 quads**, each bridging
where a wheel *was* and *is*, built from the direction BETWEEN those points — a
sliding tyre is not pointing where it is going. Coplanar with the ground by
construction, so `polygonOffset` and `depthWrite: false`.

**`FX.smoke.minSlip` is 0.22 and that is a measurement, not a taste.**
`slipAmount` is how much the friction circle had to take away; a full-throttle
start in the Sport measures **0.39–0.46**. A threshold set by imagining what
"full slip" ought to mean lands above everything the model produces (#63).

### 4.16 Wind (`wind.js`)

Synthesised, not sampled — a loop is a file, a file has a length, and a length is
a period the ear finds. Brown-ish noise through two bands: **RUSH** (low-passed,
260→1500 Hz, present from walking pace) and **WHISTLE** (narrow, arrives at 45% of
the speed range, 900→2600 Hz quadratic). **That lateness is the whole effect** —
it is what makes 200 km/h sound different from 120 rather than merely louder.
`WIND.exponent` 2.2: real aeroacoustic power goes as v⁶, which is true and
useless (silence below 150 km/h, one level above).

**It does not create an AudioContext** — it is handed `engine_sim`'s, so there is
one clock and one bus. Parameters move with `setTargetAtTime`, never `.value =`.

### 4.17 Input and tilt (`input.js`)

Keyboard, gamepad, touch, tilt. Reads `.tbtn` and `data-hold`/`data-tap` only, so
the touch layout can be rearranged in `index.html` without touching it.

**Tilt OVERRIDES the ramp** rather than blending — an analogue source already
carries intent every instant, and mixing a ramp in can only add lag. Three
non-obvious parts:

- **Which axis depends on how the phone is held.** `gamma` and `beta` swap roles
  as the device rotates, and the sign flips again between the two landscape
  orientations. Axis **and sign** come from `screen.orientation.angle`.
- **The zero is wherever the player is holding it** — captured on the first
  sample, re-captured by `KeyT` or the ⌾ tap.
- **iOS needs permission from inside a tap.** The Settings toggle is the gesture;
  a refusal, a missing sensor and plain HTTP all come back as the same `false`.

Dead band 1.2°, full lock at **15°**, 1.25 expo. A stale sample (0.5 s) releases
the wheel. `TiltSteering.inverted` is a saved escape hatch, because which way a
given phone reads as "tipped right" is not something the code can know.

### 4.18 Graphics levels (`config.js`)

Three levels, chosen on the title screen or in Settings. The override **rewrites
the config blocks before any asset is built** — materials bake fade windows and
libraries bake densities at boot, so a mid-run tweak would be half applied.
Changing the level saves it and reloads. `probe/props.mjs` runs at High (Node has
no storage).

| | High | Medium | Low |
|---|---|---|---|
| chunks ahead | 6 | 4 | 3 |
| near canopy | 180/chunk | 95 | **0** |
| far canopy | 760 | 380 | 300 |
| grass / shrubs / stone | on | thinned | **off** |
| worst-case foliage in view | 723k tris | 302k | 95k |

**Low is the far tier all the way in.** It used to mean "silhouette cards only",
which stopped being true when the canopy became solids — there are no billboards
left, so Low is now the same world at the subdivision the distance tier already
uses, rather than a different-looking one.

`graphicsLevel()` wraps `localStorage` in try/catch, not a `typeof` guard: Node
exposes a global that **throws** unless the process was started with a store.

### 4.19 The stylesheet — one scale, no width breakpoints

`index.html` is the whole interface. **Every size is a `clamp()` against `vmin`**
— a control at 14vmin is a thumb's width on a 390 px phone and on a 1024 px
tablet, because a thumb is the same size on both. `vmin` not `vw`, so rotating
moves things without resizing them. The only media queries ask about
**orientation**, **pointer** and **height**. No width breakpoints (#45).

**The title screen is half car and half controls at every size**, split across
the long axis: portrait stacks, landscape (and every desktop monitor) goes side
by side. `#stage` is the free half and exists so the camera can MEASURE it.

Two cascade details, each wrong once: in a row the flex basis is a WIDTH, so
`#dock` needs `max-height: 100%` + `align-self: center` (stretch gives the
desktop 400 px of empty floor); and the landscape override must come **after**
`#dock`'s own block or it loses the cascade at equal specificity.

`--ctl-zone` is 0 by default and becomes the height of the pedal **stack** under
`body.touch`; the HUD offsets by it, so instruments clear the driving controls
without either layout knowing the other exists. `--edge-*` folds the safe-area
insets into the ordinary gutters.

---

## 5. The config contract

`config.js` exports **19** blocks: `WORLD`, `ROAD`, `ROUTE`, `CHUNK`, `TREES`,
`BUSHES`, `GRASS`, `ROAD_SURFACE`, `GROUND`, `ROCKS`, `WIND`, `FX`, `VEHICLE`,
`TRAFFIC`, `CAMERA`, `TITLE`, `ATMOSPHERE`, `SCORE`, `TERRAIN_COLORS` — plus
`GRAPHICS_LEVELS` and `graphicsLevel`/`setGraphicsLevel`.

**THE TRAP.** A key in the wrong block reads `undefined`. Then `undefined * 0 →
NaN`, and `clamp(v, NaN, NaN) → v` — the input, unchanged, silently. The terrain
passes through the carving step with no error and no visual clue beyond "the
world looks wrong somehow". **This has happened twice.** Audit:

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
  for(const m of t.matchAll(/\b(WORLD|ROAD|ROUTE|CHUNK|TREES|BUSHES|GRASS|ROAD_SURFACE|GROUND|ROCKS|VEHICLE|TRAFFIC|CAMERA|TITLE|ATMOSPHERE|SCORE)\.(\w+)/g)){
    if(blocks[m[1]]&&!blocks[m[1]].has(m[2])){console.log('MISSING '+m[0]+' in '+f);bad++;}}}
console.log(bad?bad+' missing':'config audit clean');"
```

Currently **clean**. `VEHICLE.*` reads as `V.*` inside the vehicle (the block is
spread into every car's params), so a naive unused-key scan reports it all dead.

---

## 6. Physics invariants

| Constant | Value | Note |
|---|---|---|
| `WORLD.gravity` | −16.0 | deliberately stronger than 9.81; arcade weight |
| `WORLD.fixedStep` | 1/120 | |
| `WORLD.maxSubSteps` | 6 | spiral guard **and** the frame-time ceiling — `main.js` derives its `dt` clamp from `maxSubSteps * fixedStep`, never a literal (#51) |
| `VEHICLE.maxChassisSpeed` | 100 m/s | guardrail, not a speed limit |
| Rapier `linearDamping` | **0** | all drag explicit in `_aero` (#4) |
| `TRAFFIC.maxImpactDv` | 11 m/s | |

**The player's car is the only rigid body besides the static terrain trimeshes.**

---

## 7. Bug ledger

Every one was real, diagnosed by measurement, and is re-introducible.

| # | Symptom | Cause | Fix |
|---|---|---|---|
| 1 | Everything inside-out | winding order | index `(a,b,c)`/`(b,d,c)` |
| 2 | Absurd acceleration | `driveBias` summed to 2.0 | sum to 1.0 |
| 3 | Wheels orbiting | three composes T·R·S, so offset+yaw lands at `R·centre − centre` | nested nodes; bake world matrices before re-parenting |
| 4 | Hidden ~1300 N drag | Rapier `linearDamping` non-zero | 0 |
| 5 | Terrain silently unchanged | config key in the wrong block → NaN → clamp passes through | audit script (§5). **Twice** |
| 6 | One-shot keys never fired | `pressed.clear()` ran before `_handleActions` | `endFrame()`, called last |
| 7 | Invisible wall off-road | cut/fill ramp had ZERO width at the verge: 3°→40° in one step = **1389 m/s²** | `t²/(t+R)` ramp + `smin`/`smax` → 64 m/s² |
| 8 | Black screen on Drive | GLSL ES 3.00 const array in a 1.00 `ShaderPass` | three's `BokehPass` |
| 9 | Traffic launched the player | rays hit sensor colliders | `EXCLUDE_SENSORS` |
| 11–15, 22 | Traffic 6920 km/h / 35 m ejection / stopped dead | every variant of driving a rigid body by writing its velocity | **no traffic bodies at all**; analytic impacts (§4.8) |
| 13 | Every car knocked instantly | `contactPairsWith` reports **broad-phase** neighbours | removed contact gating |
| 17 | Road buried; car stopped at a portal | `smin`/`smax` with fixed `k = 3.5` smoothing a gap of ZERO width — each concedes k/4 → **+0.875 m on the road** | `k = min(slopeBlend, (ceiling−floorY)·0.25)` |
| 21 | Traffic spawned 40 m ahead in plain sight | the window started at 40 m | `spawnMin = 460` |
| 23 | Road half empty vs the population target | spawn clash test ignored `lane` | test it; 40 attempts |
| 24 | Faceted, knife-edged terrain | `1−\|n\|` is a C1 discontinuity per octave; `base` had no LOD so 7 m features were sampled on 55 m columns | soft fold; octave budget from lateral resolution. p99 −39–51% |
| 25 | Traffic identical in every world | `rng` seeded from a literal | seed from the world seed |
| 30 | **A slide could not be caught** | the steady-state rollover limit applied mid-slide capped lock at 4.3° at 108 km/h | lock opens with chassis slip + yaw damper. 3.96 s → 0.68 s |
| 31 | Steering locked out at speed | `minSteer` 0.030, `steerGripMargin` 1.05 | 0.095 / 1.6 → 4.6× |
| 32 | A slide scrubbed all the speed off | Pacejka `C` sets the tail: retained grip past the peak is `sin(C·π/2)`, and 1.45 keeps only 76% — the tyre fell off a cliff | `tyreShape` is now **1.15**, which keeps 97%. Drift speed 15 → 51 km/h, drift held 1.31 → 1.42 s |
| 33 | **The car itself went blurry** | depth of field focusing at one distance, pulled to the horizon, car 5 m away | removed; radial speed blur |
| 34 | Camera speed terms inert | `speedRef` 165 m/s = 594 km/h | 68 m/s; FOV gain 4° → 12° |
| 37 | Car rolled away in the garage | nothing held it | `setParked` pins position and velocity; height stays free |
| 38 | The slide assist was obvious | damper engaged at 23° at strength 3.0 — an ordinary slide | 36°–72° at 1.3; lock opening proportional |
| 41 | **Too easy to lose** | four at once: `tyreShape` 1.32 dropped 11% past peak (rear peaks first under power); stiffness 14/11.5; solid-box yaw tensor; 6.2 rad/s put full lock 94 ms from a keypress | 1.22/15/13, `Iy × 1.6`, `steerRate` 5.0. Catch 2.54 s/169° → 0.82 s/62° |
| 42 | First gear had no torque | `_stepVehicle` overridden → the launch controller never sees wheel load and regulates on ROAD SPEED, so the clutch sits half open forever | `_launchFloor`. Sport 5.2 → 9.9 m/s² |
| 43 | Every car launched to the wrong schedule | engine_sim derives `launchRate` once, in its constructor | `_retuneLaunch()` per car |
| 44 | Paint sections no colour could change | `findPaintCell` took only the largest atlas cell | `rankPaintCells`; top two get their own materials |
| 45 | The interface was three designs | three overlapping width breakpoints restating each other | `clamp()` against `vmin`; orientation/pointer queries only |
| 46 | Handbrake through the tachometer | `--ctl-zone` measured as one pedal; the right pad is a **stack** | `ctl + ctl-sm + gap + gutter` |
| 47 | Score squeezed against the aux buttons | 6 controls in a 3-wide grid left 67 px on a 375 px phone | 2×3, `#run` reserves the width |
| 48 | Car blurb through the paint swatches | garage rows are flex items; default `flex-shrink: 1` squeezed each below its content, and that overflows rather than scrolling | `#garage > * { flex: 0 0 auto }` |
| 49 | Wordmark under the panel | the query was `orientation: landscape`, which is also every desktop | `max-height: 620px` — height was always the constraint |
| 50 | **Car sprang backwards, worse at low fps** | exponential damping toward a MOVING goal settles at a lag containing `dt` | `util.dampTrack`: closed form with the goal treated as the ramp it is. 273 mm → 2 mm |
| 51 | A hitch yanked the car backwards | `maxSubSteps·fixedStep` was 41.7 ms while `main.js` clamped to a literal 50 | the clamp **is** `maxSubSteps * fixedStep`. Advance/expected 0.848 → 1.000 |
| 52 | **Grass read as a dark stripe** | two ambient-occlusion terms multiplied: card root 0.26 × geometry root 0.42 = 11% of the ground colour | 0.55 and 0.78. Found by `render.mjs` on its first run |
| 53 | Car hidden behind the garage dock | `garage.aim` tuned against a shorter dock | −0.55 → −2.2, dock 66 → 58dvh |
| 54 | Grass was a ribbon hugging the tarmac | density taper and size boost applied over the SAME range, compounding | `farScale`; taper confined to the outer quarter |
| 55, 60 | **A hillside across the carriageway** | every chunk carries terrain 700 m either side while being 120 m long, and a contour-following router doubles back readily | `selfNear/Far/Clear` **and** `sampleGround` clamps against foreign road segments (§3) |
| 57 | **1361 m/s² on a flat straight road** | the foreign clamp used a FIXED smooth-min width, conceding k/4 on the carriageway = a 0.875 m trench. Trap 6, second time | `k` tied to the gap |
| 58 | Far terrain sheared between adjacent rows | `foldSafeOffset`'s exponential bends immediately, so a straight had every row squeezed differently — 87 m | soft minimum, p = 6 |
| 59 | **The sheet folded through itself — up to 4,353 cells/seed, spacing −54%** | the guard was fed `frame.curv` (±10 m). The quantity that decides folding is the frame-to-frame rotation, and a smoothed estimate under-reports it | `_buildFoldLimits`: per-side running max over ±25 m. **0 inverted** |
| 61 | Shading AND colour seam every 120 m | `_seamNormals` derived boundary normals analytically while interiors got the area-weighted average | ghost rows |
| 62 | The far grass tier was dark spines | scaling a card uniformly by 3.6 makes it 5 m tall, and 5 m of grass is a tree | `widthScale` and `heightScale` separately |
| 63 | Tyre smoke never appeared | `minSlip` 0.35 set by imagining what "full slip" means; a burnout measures 0.39–0.46 | 0.22, next to the measurement |
| 64 | **Holes off the road — the car drove into one** | the sheet genuinely ENDED: `kappa` from a one-step difference of a 46 m spline reached 1/81 against a design limit of 1/165, so the corridor stopped 57 m out where 115 is guaranteed. 16–19% of probes hit nothing | `ROUTE.foldSmooth` pre-averages the turn rate; `corridorAt` lets `_checkRecovery` ask instead of assuming. A hard FLOOR was tried and rejected — it doubles folded cells, because a Catmull-Rom overshoot really does turn tighter |
| 65 | The title fly-in played on every respawn | `dampTrack` reads goal travel as velocity; a 12 m teleport in 16 ms is 750 m/s, so it computed 79 m of lead | `camera.snap()` from `respawn`; `startRun` respawns BEFORE `beginIntro` |
| 66 | Every tree came out an aerial | children inherited the parent's TIP radius, which already has the taper in it | radius **where the child leaves it** |
| 67 | Impostors a third the width of their trees | two independent scalings multiplied | (obsolete — billboards are gone) |
| 68 | Trees floating up to 58% of their height | the bounding box was aligned to y = 0, but the anchor is the TRUNK BASE, and drooping foliage reached below the root | ground guard in the sweep + clamp vertices to y ≥ 0, then read height from the top |
| 69 | Every conifer's card 30–45% too narrow | `computeBoundingBox` writes into the existing Box3 **in place**, so a reference taken before the call is the post-scale box — divided by `h` twice | copy the spans out as numbers |
| 70 | Void annulus off-road: 100% coverage to 100 m, **68% at 175–200 m**, 94% by 300 m | the gap between where a chunk's own sheet stops and where its neighbours reach. Road space fundamentally cannot cover the inside of a tight bend | relaxed heading + the world-space apron (§3). **0 void in 27,956 probes on six seeds to 600 m** |
| 71 | Distant trees "very out of place", shrinking as near ones grew | a painted billboard and a grown mesh are two different pictures of one tree | one builder, two subdivisions; `matchWidth` (§4.11) |
| 72 | An oak was 576 triangles instead of 334, silently | `blob`'s occluder test read `L.cx` against plans carrying `L.c[0]` — every comparison NaN, nothing culled | occluders are the `{c, r, warp}` plans; **a shape mismatch here has no symptom but the budget** |
| 73 | A dark conifer in every bright birch stand | species were drawn independently per point; the stand mask says how much canopy, not what kind. And the guild field, once added, sat inside `mask`'s unstretched middle band | guilds as bands on a slow axis, **stretched against the mask's measured p05–p95** (§4.11). Agreement 83% (79% by chance) → 87–93% (39–48%) |
| 74 | Shrubs photographed as broken rock | `detail: 0` (20 faces to a sphere) plus `warp` 0.26–0.34 is a crystal, not a leafy dome | main lump `detail: 1`, warp halved (§4.11) |
| 75 | The woodland grass tier was invisible to every probe | gated on the TEXTURE, which is null wherever there is no canvas | gate on the config; `src/env/README.md` rule 2 |

### Harness bugs that masqueraded as game bugs

**Measurement has been wrong more often than the game. Do not trust a harness
result that contradicts the code until you have read the harness.**

- **The worst one.** `drive.mjs`'s autopilot divided a steering ANGLE by
  `V.maxSteer`, but `input.steer` is NORMALISED — full stick is full *available*
  lock, **a sixth** of `V.maxSteer` at 160 km/h. The car tracked a wider radius
  than the road with **zero tyre slip** and reported the verge as a fault in the
  world. It got worse as the terrain got more interesting (1.77 → 16.77 m), which
  is exactly the correlation that makes such a thing convincing; two red herrings
  were chased first. Dividing by `vehicle.steerLimit` → **0.46–0.58 m**.
- **A probe firing rays on the mesh lattice** reported 141 holes that do not
  exist — a ray down a shared triangle edge can miss both faces. Offset the grid.
- **Checking placement by going back through `(s, v)`** reported trees floating
  3.97 m: the scatter runs the offset through `foldSafeOffset` before placing, so
  recovering `v` applies the compression twice. Against the collider: **0 mm**.
- **A probe must build the window the GAME builds.** `surface.mjs` built every
  chunk at once and reported 33,110 steps on a carriageway both the height
  function and the drawn mesh agreed was flat — all collisions between chunks
  that can never coexist.
- **Every steady frame rate measured clean** while the game was visibly broken:
  #50 and #51 are driven by frame time *changing*, not by its value.
- **World-space smoothness was perfect and proved nothing.** The fault was
  entirely in where the car was *drawn* relative to the camera.
- **`handling.mjs` charged the car for the test's own cornering** — it integrated
  heading through the recovery, so a catch in 0.82 s after 62° was reported as
  "240 deg, WENT ROUND" *because it recovered in time to start turning*.
- **An autopilot is a controller and can be unstable on its own.** An inverted
  cross-track sign drove the test car off the road four times in 90 s: 79 m
  covered. With the sign fixed and a heading term, 4736 m.
- **A screenshot probe must serve `cache-control: no-store`.** Chrome keeps its
  HTTP cache in the `--user-data-dir`, which persists between runs; three renders
  came back byte-identical and were read as "the change had no effect".
- **A probe whose bar is my own guess is not a check.** `props.mjs` briefly
  asserted the far tier was "an order of magnitude cheaper" than the near one,
  which failed at 1:4.2 — a ratio that is fine. The bar is now the absolute
  per-instance cost, which is what actually binds.

---

## 8. What is NOT verified

The most useful section. Be honest about it.

**The game HAS been rendered**, through SwiftShader — `--use-angle=swiftshader`
plus `--enable-unsafe-swiftshader` gives a correct GL implementation at ~20 fps,
and `probe/render.mjs` boots the real game, drives it and screenshots. Two bugs
fell out on its first run that nothing else could see (#52, #53).

Not covered: the frame rate it reports is meaningless; MSAA, anisotropy and mip
selection all behave differently from a GPU (so `alphaToCoverage` on the grass is
unverified, and `GROUND`'s near tile fades at 45–130 m against an aliasing
threshold that was reasoned about, not measured); nobody has driven it far.

**The canopy has been photographed** — `probe/canopy.mjs` renders the whole
library, every species, every variant, both tiers, with the distance fade
switched off so the tiers can be compared at true size. It found #74 and the
woodland grass's double-darkening. Not covered: the **handover in motion**. The
fade windows were chosen against apparent size on screen, and a tree crossing
260–420 m at 200 km/h has never been watched.

**The interface HAS been rendered** — `probe/uishot.mjs` screenshots 17 real
device viewports over CDP against `probe/uiview.html` (the live stylesheet with
the module boot removed, so there is no WebGL to die on). Found #46–#49. Not
covered: the interface over the real scene at more than one viewport and seed;
which swatch the second paint colour moves on the Sport and the Classic, where
the z-buffer check says it may be glass.

**The tyre effects have never been seen rendered** and `SKID=1` cannot show them:
at 20 fps the powertrain is stepped with `dt` = 50 ms, an order of magnitude
outside what engine_sim's launch controller regulates at, so the engine never
leaves idle — 8 kN at the contact patch where a real launch makes 25. Nothing is
wrong with the effects; the car is not doing the thing. `probe/env.mjs` drives
the emission path against a stub instead.

**Tilt steering has never been held.** Every number was reasoned about against
how far a wrist rolls, and the axis/sign table is from the specification rather
than from a phone. No probe is possible: it needs a device, a sensor and HTTPS.

**The wind has never been heard**, and the wind ON the trees has never been seen
moving — at one frame per second through SwiftShader it is a still image.

### Known rough

- **Faceting at the corridor edge.** p99 27–31° in the 200–700 m bands, worst
  cell ~100°. The sheet no longer folds or shears, so this is real: the ground
  turns faster than a 34 m column can follow. Fog leaves ~1% of the colour past
  500 m. The honest fixes are more columns or fewer octaves; both are budget
  decisions nobody has taken.
- **The roadside grass card does not match the low-poly style.** It is seven thin
  painted blades on a crossed card, which reads as dark bristles beside faceted
  solid foliage. It is *correct* — measured, it is brighter than the ground it
  stands on — and it is the one asset that has not been restyled.
- **`GRASS.density` interacts with the terrain**: it is an ask, and how many
  samples survive depends on the landforms. Re-run `probe/grass.mjs`.
- **Stone is only in the near 6 chunks**, the near canopy in 7 and the woodland
  grass in 3. A cut face 500 m ahead gains scree as you arrive. Not looked at in
  motion at a real frame rate.
- **The sheet still folds a little at its very edge** — `frameAt` interpolates the
  fold limits between road samples, so a row can sit between two frames whose
  running maxima both under-read. Hundreds of metres out, under heavy fog;
  `probe/offroad.mjs` holds the bar at the old worst case.
- **`_separate` runs one relaxation pass** over a list sorted before positions
  were adjusted. Never failed a soak test; not a proof.
- **Impacts are box-vs-box in road space**, so a car struck at a sharp angle
  resolves along the road axes rather than the true contact normal.
- The `engine_sim` submodule, §1.

### Verified good (headless, this pass)

- Carriageway: **0 steps over 30 cm and 0 holes** in ~220k probes/seed, seven
  seeds, 4 km each. Height equals the exact cut/fill clamp to **0.000000 m**.
- **Ground everywhere the player may drive**: 0 holes in 114,240 probes/seed
  across six seeds, including 57,600 beyond the recovery bound.
- **Foliage.** 8 species × 3 variants at 93–334 tris near (mean 223) and 39–88
  far (mean 53); 4 shrubs at 75–115 (mean 88). Per chunk: 29,776 near + 12,015
  far + 13,292 shrub; **436,000 alive at once** against ~109,000 of terrain
  sheet, over two lifetimes. Scatter **3.8 ms**/chunk, 12.1 draw batches of 14,
  nothing closer than 16.4 m to the centreline against an 11 m clearance, mean
  float off the collider **19.7 mm**, per-chunk count varies by 35% of its mean.
  Crown radii of the two tiers agree to **2%**. Library bit-identical between
  builds. Neighbouring trees share a guild **87–93%** of the time against
  39–48% by chance.
- Ground cover: ~19,700 roadside + ~3,300 woodland + ~3,100 far tufts per chunk,
  **0 on the carriageway**, none beyond its band, fade windows overlap.
- Stone: 6.0 draw batches/chunk, 5,790 tris/chunk, inside its band.
- Terrain faceting, adjacent-face angle, on terrain ~3× the old vertical scale:

  | band | shipped mean | now | shipped p99 | now |
  |---|---|---|---|---|
  | 0–80 m | 1.74° | **1.72°** | 9.65° | **9.85°** |
  | 80–200 m | 3.88° | **3.51°** | 18.39° | **21.05°** |
  | 200–420 m | 7.91° | **4.07°** | 46.44° | **30.55°** |
  | 420–700 m | 8.87° | **3.40°** | 54.07° | **26.89°** |

- Route over 6 km, four seeds: sidehill **51%** (was 29%), corridor drops over
  12 m **30–46%** (was 1–14%), earthwork 9.4 m, grade p95 5.7%, self-clearance
  190 m against a 160 m floor. Elevation range over 18 km **129–249 m**; longest
  climb giving nothing back **2.6–3.4 km for +66 to +111 m**.
- Chunk build **20 ms** (was 34–58).
- Traffic, 4 min at 150 km/h, four seeds: nearest spawn 460 m, longest stall
  **0.00 s**, same-lane overlaps **0**, population 9/9.
- End-to-end, 90 s flat out: 0 non-finite states, **0.00%** airborne, 0 hard hits
  away from traffic, 0 recoveries, worst lane error **0.48 m**, worst yaw rate
  0.58 rad/s.
- Handling: handbrake yaw **3.22 → 2.27 rad/s**, catch **2.54 s/169° → 0.82 s/62°**,
  speed after the catch **5 → 41 km/h**, drift held **1.31 → 1.42 s**, mean slip
  **0.32 → 0.36**, countersteer catch **0.91 s**. No rollover regression.
- Launch: Sport **5.2 → 9.9 m/s²** from rest at full throttle.
- **44 DOM ids and 16 toggled classes** resolve. 17 viewports, no overflow.
- Render smoothness, camera space, ten frame-rate patterns 144 → 20 fps with 30%
  jitter and 90 ms hitches: worst springing **9 mm**.
- Every module parses; config audit clean. `engine_sim`'s own suites pass.

---

## 9. Traps

1. **`engine_sim/` is not ours.** Do not edit it. The bridge overrides
   `_stepVehicle` **per instance** so the vendored source stays pristine.
2. **Config block placement** — §5. Highest-cost mistake in the project.
3. **Three composes T·R·S.** (#3)
4. **Winding order** `(a,b,c)`/`(b,d,c)`.
5. **`ShaderPass` is GLSL ES 1.00.** No `const` arrays, no `in`/`out`. (#8)
6. **A smooth clamp is not a clamp.** `smin`/`smax` disagree by up to `k/4`
   *near the crossover* — that is what they are for. **Never give one a blend
   width wider than the gap it is blending.** (#17, #57)
7. **One threshold per concept.** (#19)
8. **Anything derived for a steady state stops being true in a transient.** (#30)
9. **A double-sided material makes coincident faces visible.** (#35)
10. **Terrain marking must be a pure function of position.** (#27)
11. **Do not give traffic a rigid body.** Compute the interaction. (#22)
12. **Audio must start inside a user gesture.**
13. **The settings drawer is a keyboard trap on purpose** — a focused
    `<input type=range>` would steer the car. Do not "fix" the blur handlers.
14. **`assets/` is user-supplied.** Never regenerate, never overwrite.
15. **Never ray-probe on the mesh lattice.**
16. **Overriding `_stepVehicle` blinds engine_sim's clutch to load.** Anything in
    that project regulating on road speed is reasoning about a car it cannot
    see. (#42 is the first case; assume not the last.)
17. **No width breakpoints in `index.html`.** (#45)
18. **`damp()` is only correct for a goal standing still.** Anything following
    the car is following a ramp — use `util.dampTrack`. (#50)
19. **The terrain sheet is ORIGIN-RELATIVE.** `_setMatrix` subtracts the origin;
    a point read from `chunk.sheet.positions` has already had it removed.
    `_setLocalMatrix` is the one for sheet points.
20. **The frame-time clamp is `maxSubSteps * fixedStep` and nothing else.** (#51)
21. **The road ROUTES; do not make it wander.** Earthwork is a budget, not an
    objective, and `wBearing` is load-bearing.
22. **A chunk's sheet is 700 m wide and 120 m long.** (#55)
23. **Probes must build the window the GAME builds.**
24. **`config.js` exports NINETEEN blocks.** Add any new one to the audit regex
    in §5 — and it walks `src/env/` too. It reads prose as well as code, so write
    `GROUND.contrastNear` in comments, not the shorthand.
25. **The fold guard's curvature is NOT `frame.curv`.** It is
    `relaxL`/`relaxR`, and the difference is #58, #59 and #70. Anything that
    "simplifies" the guard back onto smoothed curvature re-folds the sheet,
    silently, where nobody looks.
26. **Anything sampling ground must be a pure function of `s`.**
27. **A tier is a descriptor, not a second code path.** All three ground-cover
    tiers and both canopy tiers share one builder, one geometry and one program.
28. **`input.steer` is normalised, not an angle.** Divide by
    `vehicle.steerLimit`. (§7 harness note)
29. **`slipAmount` does not reach 1.** A burnout measures 0.39–0.46. (#63)
30. **The title screen's split is one rule** — half car, half interface, along
    the long axis. `#stage` exists so the camera can measure it.
31. **`src/env/` generators must survive having no canvas.** Return `null`, do
    not throw, and **never gate a feature on whether a texture exists** (#75).
32. **Anything scattering per sample must read the terrain SHEET.** The ground
    cover learned this at 591 ms/chunk; the tree scatter again at 62 ms.
33. **`vegetation()` is one field for every scatter, on purpose.**
34. **The near canopy has a shorter lifetime than its chunk**, and its recipe is
    computed ONCE and cached. Re-running the scatter would put a tree and its
    own far stand-in in different places.
35. **A limit built from a noisy estimate lies in both directions.** Smoothing
    the estimate is safe; putting a FLOOR under the result is not, because
    sometimes the road really is that tight. (#64)
36. **Tilt's axis depends on `screen.orientation.angle`**, and the sign flips
    again between the two landscape orientations.
37. **Interior culling fails silently.** `lowpoly.js:blob`'s occluders must be
    the `{c, r, warp}` plans. A shape mismatch culls nothing and has no symptom
    but the triangle count. (#72)
38. **Foliage hue is BAKED, per variant; stone hue comes from `ROCKS.palette`.**
    Both are documented exceptions to "hue on the instance", which is a rule
    about things that grow. (§4.11, §4.14)
39. **A field's numbers must be against its MEASURED range.** `terrain.mask` is
    two octaves and spans 0.25–0.72, not 0–1. Getting this wrong makes a field
    that looks wired up and does nothing. (#73, and `TREES.barePatch`)

---

## 10. Testing

No test runner, no assertion library. `probe/` drives the real modules under Node
and prints numbers.

```bash
npm run probe:deps      # three + rapier, --no-save
npm run probe
```

| script | answers |
|---|---|
| `ui.mjs` | every DOM id a module reads exists; every class it toggles is styled |
| `paint.mjs` | both paint slots and both lamp pairs got triangles, on every car |
| `grass.mjs` | roadside ground cover: count, cost, density, none on the carriageway |
| `env.mjs` | everything else in `src/env/` plus `fx.js`: far grass, rock geometry and scatter, tyre effects against a stub |
| `engine.mjs` | does the bridge still match `engine_sim`'s API |
| `surface.mjs` | is the carriageway drivable end to end (non-zero on any step > 30 cm) |
| `offroad.mjs` | is there ground everywhere the player may drive? #64/#70's regression test |
| `cliff.mjs` | longitudinal terrain steps |
| `traffic.mjs` | spawn distance, stalls, overlaps, lane error, population, Δv |
| `score.mjs` | the near-miss mechanic, without physics |
| `props.mjs` | canopy and understorey: per-species counts both tiers, determinism, **whether the far tier is the same tree**, caps, batches, cost, clearance, float, and that the scatter is LUMPY |
| `handling.mjs` | steering by speed, slide recovery, drift, rollover safety |
| `smooth.mjs` | is the car smooth **on screen** under jitter and hitches |
| `terrain.mjs` | faceting by distance band |
| `drive.mjs` | end to end: real car, physics, `engine_sim`, traffic |
| `route.mjs` | shelf share, earthwork, curvature, grade, self-clearance |
| `xsec.mjs` | cross-sections — the fastest way to read an alignment |
| `canopy.mjs` | **what the canopy looks like** — contact sheet, both tiers at true size. Needs Chrome |
| `uishot.mjs` | **what the interface looks like**, 17 viewports + overflow report. Needs Chrome |
| `render.mjs` | **what the GAME looks like**, through SwiftShader. Needs Chrome |

The last three are not in `npm run probe`. `render.mjs` takes
`[seed] [seconds] [teleport]`; `SKID=1` stops the car and floors it (see §8 for
why that produces no smoke here). Each other script takes an optional seed.

**There is no probe for the wind** and no obvious one.

Syntax check:

```bash
mkdir -p /tmp/frc
for f in src/*.js src/env/*.js; do cp "$f" "/tmp/frc/$(basename ${f%.js}).mjs"; \
  node --check "/tmp/frc/$(basename ${f%.js}).mjs" || echo "FAIL $f"; done
rm -rf /tmp/frc
```

---

## 11. Running

```bash
python3 -m http.server 8080     # → http://localhost:8080
```

Any static server. Must be HTTP, not `file://` (ES module and WASM rules). Port
**8000 is usually taken by `engine_sim`'s dev server**.
