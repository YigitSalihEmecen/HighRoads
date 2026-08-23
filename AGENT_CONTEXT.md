# FASTROADS — complete project context

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
not just its soundtrack. Everything — road, terrain, trees, tunnels, traffic —
streams in and out in chunks as you drive, forever, seeded from a string you can
type in the menu.

No build step. No bundler. ES modules and an import map, served statically.

---

## 1. Workspace layout

```
fastroads/
├── index.html            shell, import map, garage UI, HUD, touch controls
├── package.json          scripts only; the game itself has no dependencies
├── README.md             architecture essay
├── AGENT_CONTEXT.md      this file
├── src/                  18 modules
├── probe/                headless measurement scripts (see §10)
├── assets/               user-supplied art (NOT generated, do not regenerate)
│   ├── car_models/Fbx/   10 FBX; the roster uses 9, the 10th is an aeroplane
│   └── Forest_Assets/    Quaternius Ultimate Nature Pack, 300 OBJ
└── engine_sim/           vendored sibling project — DO NOT EDIT
```

### `src/` module map, largest first

| File | Owns |
|---|---|
| `chunks.js` | Terrain/road/tunnel/tree mesh generation, colliders, streaming |
| `vehicle.js` | Raycast vehicle: suspension, tyres, aero, stability, visuals |
| `main.js` | Boot, `Game` class, fixed-step loop, garage wiring, recovery |
| `assets.js` | OBJ parser, FBX loading, car mesh normalisation, metric extraction |
| `config.js` | **All** tunables, in 8 exported blocks |
| `traffic.js` | Other cars: spline riders, AI, lane changes, analytic impacts |
| `cars.js` | 9-car roster, colours, engine options, physics synthesis |
| `path.js` | Road centreline spline, Frenet frames, arc-length projection |
| `noise.js` | Gradient noise, fBm, erosion, warping, landform archetypes, LOD |
| `powertrain.js` | Bridge between the game and `engine_sim` |
| `scene.js` | Renderer, lights, sky, fog, post-processing chain |
| `foliage.js` | Tree species table, ecology rules |
| `score.js` | Near-miss scoring for Traffic mode — pure logic, no DOM |
| `input.js` | Keyboard, gamepad, touch; one-shot vs held keys |
| `settings.js` | The collapsible left drawer |
| `camera.js` | Three chase modes, FOV-by-speed |
| `hud.js` | Speed, tach, gear, trip |
| `util.js` | clamp/lerp/damp, PRNGs, `smin`/`smax`, string hash |

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
   `AudioContext` touch and **must** be inside the user gesture), begin `loop()`.

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
 ├── chunks.update(carS)                    stream in/out, 1 chunk per frame
 ├── traffic.update(dt, {s, v, speed, flashing, vehicle})
 ├── camera.update(dt, vehicle)
 ├── hud.update(...)
 └── render
```

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

### The fold guard (`chunks.js:foldSafeOffset`)

Rows of vertices radiate perpendicular from the centreline. On a tight curve the
rows on the inside converge and eventually cross, folding the mesh inside out.
The rows meet at the centre of rotation, at radius `R = 1/|curvature|`.

The fix compresses the inside asymptotically so it can never reach `R`:

```
v' = L · (1 − e^(−|v|/L)),   L = 0.7 · R
```

Outside offsets are left alone. This is why terrain far to the inside of a tight
corner is slightly compressed — that is intentional, not a bug. It is also the
reason for the one remaining faceting artefact: the mapping depends on the local
curvature, which differs between adjacent rows, so a cell 600 m out is a skewed
parallelogram and its normal is unreliable. Measured, **every** terrain cell in
the corridor whose faces meet at more than 60° is on the inside of a bend.

---

## 4. Subsystem detail

### 4.1 Noise chain (`noise.js`)

`createTerrain(seed)` returns `base`, `height`, `roadElevation`, `region`,
`forestDensity`, `mask`, and three scalar accessors. The chain, in order:

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
   2D archetype space. Centres sit on a circle of radius 0.52; `SIGMA2 =
   2·0.30²`.

**Octave budget (LOD).** `base(x, z, octaves)` sets a closure variable that every
fBm variant reads, fading its last octave in and out rather than dropping it.
`height(x, z, lateral)` derives the budget from the mesh's own lateral
resolution — 8 octaves on the road, 3.2 at the corridor edge — because the
columns out there are 55 m apart and the base field's finest wavelength is ~7 m.
Sampling a 7 m feature every 55 m is aliasing, and aliased gradient noise reads
as spikes, not as distant detail.

`plateauH` builds its terraces from a smoothstep rather than `floor()`, so the
staircase is C1; `canyonH`'s wall was widened from `0.32..0.60` to `0.26..0.68`
for the same reason.

### 4.2 Road path (`path.js`)

A `CatmullRomCurve3` through control points generated one at a time
(`_addControlPoint`), constrained by `ROAD.maxCurvature`, `maxGrade`, and
`maxGradeChange`. Elevation follows `terrain.roadElevation` smoothed by
`elevationSmoothing`, so the road *sits in* the landscape.

Key methods:
- `frameAt(s, out)` → position, tangent, normal, right, curvature, bank, cover,
  tunnel. **Pass `out`** — it allocates a frame otherwise, and it is called
  several times per car per frame.
- `projectPoint(pos, sHint)` → arc length, searched in a window around the hint.
- `lateralOffset(pos, s)` → signed `v`.
- `_markTunnels()` → decides where the road passes *through* rock, based on how
  much cover is overhead (`ROAD.tunnelCover`), gated by `ROAD.tunnels`.

`ensureLength(sTarget)` extends the spline lazily as you drive.

### 4.3 Chunks (`chunks.js`) — the biggest file

One chunk = `CHUNK.length` (120 m) of road plus terrain out to
`CHUNK.halfExtent` (700 m) each side. `update(carS)` keeps `CHUNK.behind` (2)
and `CHUNK.ahead` (6) alive and builds at most `buildPerFrame` (1) per frame.

Build order inside a chunk:
1. `_buildTerrain` — the ground mesh, with `mouth[]` flags marking vertices cut
   away for a tunnel portal.
2. `_buildRoad` — the ribbon and its painted lines. Lane markings are a lateral
   profile of coloured bands, not a texture — that is why they never stretch.
3. `_buildTunnels` — inner lining (collidable), outer shell and end caps
   (visual only). See §4.4.
4. `_buildProps` — trees. Cluster-seeded, not Poisson.
5. `_seamNormals` — averages normals across chunk boundaries.

Two functions deserve special attention:

- **`sampleGround(frame, rightFlat, v, out)`** — the cut-and-fill clamp. The
  shoulder ramp is `t²/(t + shoulderRound)`, which starts with *zero* slope at
  the verge. The smooth clamp's blend width is
  `k = min(slopeBlend, (ceiling − floorY)·0.25)` — **tied to the gap it is
  blending**, so on the carriageway (where ceiling and floor are the same plane)
  it degrades to an exact clamp. Bug #17 is what happens when it does not.
- **`meshGroundPoint(s, s0, s1, v, out)`** — interpolates the whole position
  across the actual rendered triangle. Props placed with this sit exactly on the
  visible surface; props placed with `sampleGround` float or sink.

`groundAt(s, v)` is the cheap query used by traffic, respawn and the recovery
check. Inside a bore it returns the **bore floor**, not the terrain.

### 4.4 Tunnels — the current scheme

Everything is decided in **road space**. Nothing depends on where a vertex
happened to land relative to a height threshold; that was the old design and it
could not bound its own error.

One shared constant, `chunks.js:TUNNEL_EPS = 1e-4`, answers "is there a bore
here". Four consumers read it and they must never diverge (bug #19).

- **Clearance, not cutting.** `boreClearance(v)` gives the height above the road
  plane that terrain is held clear of — the arch plus `tunnelRoof`, tapering to
  zero across the sill. `sampleGround` applies it with a `max`. The mountain
  therefore *cannot* reach into the bore, whatever the rock cover does. This
  replaced removing roof quads on a height test, which was only as reliable as
  the grid.
- **The mouth is a rectangle.** A terrain vertex is a mouth iff
  `TUNNEL_EPS < tunnel < 1 − TUNNEL_EPS` and `|v| ≤ tunnelHalfWidth`. Those are
  exactly the rows over which the surface climbs from cut-and-fill level to the
  mountain — the rock *face* — and that face is what stands across the bore.
- **Marking is a stateless morphological filter.** `path.js:_markTunnels` runs
  threshold → close (`tunnelBridge`) → open (`tunnelMinLength`) → distance
  transform for the portal ramp. The previous version grew runs incrementally
  and committed one only when it looked "settled" relative to the generation
  frontier, which made the answer depend on the order samples were framed in.
  It froze runs mid-mountain: 32 m of road where the rock was 11–14 m deep but
  no bore was marked, and outside a bore the cut-and-fill clamp flattens the
  corridor to road level — so those 32 m were a **15 m vertical cliff** across
  the carriageway at the tunnel exit. That was the "roof does not integrate
  with the terrain" artefact: not a seam, a missing tunnel. Results are written
  only where they are final, and `ensureLength` waits on `markedLength` so no
  chunk is ever built against a flag that might still change.
- **The portal is short on purpose.** `ROAD.tunnelPortal = 6` m, about two rows.
  At the old 18 m the terrain climbed the full depth of the mountain (up to
  60 m) inside the ramp, so the vertex left standing beside the hole sat 35 m
  above the arch while the shell reached 8. Bug #18.
- **The shell** sweeps a second profile `tunnelRoof + tunnelShellExtra` radially
  outward, so any gap shows rock rather than sky. It is **not** collision
  geometry — only the inner lining is (see bug #10's note). Every point is
  offset, **including the floor**: leaving the floor where it was swept it a
  second time in the same place, and since the lining material is double-sided
  both copies drew and fought for the depth buffer. That was 11.4% of every
  bore's triangles (bug #35).
- **End caps only at a real end.** A span clipped by a chunk boundary is not a
  portal, and capping it put a ring of rock around the bore in the middle of the
  tunnel every 120 m (bug #36). Spans also snap to a global station grid, so two
  chunks meeting at a boundary generate bit-identical vertices there.

Both the clamp release and the headroom come in on the *same* eased ramp — a
step on either put a riser the height of the arch between one row and the next.
The headroom decays laterally over `tunnelBerm` (45 m) on a smoothstep, so the
bore sits in a hill rather than under a creased 62° berm.

Verified: 0 vertices cut in a sealed bore and 0 left standing in a mouth across
six seeds; **0 sky leaks in 211k rays** fired up and outward from inside sealed
bores against terrain *and* shell; worst terrain step away from a portal
**1.4 m** across seven seeds, against 28.8 m before.

`ROAD.tunnels = false` turns the whole thing off; deep cuttings are what the
cut-and-fill clamp produces instead, and they look fine.

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
  `driftAngle` (23°) and `spinAngle` (49°) of chassis slip. Below the first it
  does nothing at all, so ordinary cornering and a held drift are untouched;
  past the second a spin decays instead of being unrecoverable.
- **`syncVisuals(alpha)`** — interpolates pose between the last two physics
  states. Took render jitter from 146 mm to 0.3 mm.
- **`beginStep()`** — snapshots the previous pose *and* clamps chassis velocity
  to `VEHICLE.maxChassisSpeed` (100 m/s) and angular velocity to 12 rad/s.

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
`van`, `military`, `monster`. 10 colours. 12 engine options.

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

### 4.10 The garage

The title screen leaves the middle of the screen transparent and orbits the real
vehicle on the real road. Three things make it behave:

- **The car is pinned.** `vehicle.setParked(true)` cancels horizontal velocity
  *and* rewrites horizontal position every step, leaving height free so the
  suspension still settles. Velocity alone is not enough — the drift that
  accumulates inside a step was 11 cm in five seconds on a 4.7% grade (bug #37).
- **Framing.** `CAMERA.garage.aim` is negative: the look-at point sits *below*
  the car, which lifts the car up the frame and clear of the dock of buttons.
- **Leaving is a sweep, not a cut.** `setGarage(false)` keeps the rig where it
  is and stiffens the damping for `CAMERA.snapTime`, so it swings round behind
  the car instead of teleporting at the moment the player takes control.

The overlay is hidden (`visibility`), never removed — a Traffic run has to be
able to send the player back to it.

### 4.11 Foliage (`foliage.js` + `chunks.js`)

**Trees only.** Rocks, bushes, plants, flowers, logs and the whole grass pass
are switched off pending a proper scatter design. Six canopy species remain, in
one group, 3 picks per chunk, cap 52.

`suitability(kind, {altitude, slope, lateral, region})` scores each species
against the site. Placement is **clustered, not Poisson** — real forests grow in
stands.

### 4.12 Scene, camera, input, HUD

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
- **The garage is the real car.** The title screen leaves the middle of the
  screen transparent and orbits the actual vehicle, on the actual road, in the
  actual scene. Paint is a live material property, so a colour click is
  immediate; picking a car or an engine also blips the throttle, with the
  gearbox forced to neutral so it revs freely instead of bogging against a
  stopped driveline. The first click is what starts Web Audio — it is the user
  gesture the API requires.
- `input.js` — keyboard, gamepad, and touch (`bindTouch`). Distinguishes held
  keys from one-shot presses; `flashHeld` drives headlight flash-to-pass.
- `hud.js` / `settings.js` — HUD readouts and the collapsible left drawer. The
  drawer is a deliberate **keyboard trap**: a focused `<input type=range>`
  responds to arrow keys and would steer the car.

---

## 5. The config contract, and the trap that has cost the most time

`config.js` exports 8 blocks: `WORLD`, `ROAD`, `CHUNK`, `VEHICLE`, `TRAFFIC`,
`CAMERA`, `ATMOSPHERE`, `TERRAIN_COLORS`.

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
for(const f of fs.readdirSync('src')){ if(!f.endsWith('.js'))continue;
  const t=fs.readFileSync('src/'+f,'utf8');
  for(const m of t.matchAll(/\b(WORLD|ROAD|CHUNK|VEHICLE|TRAFFIC|CAMERA|ATMOSPHERE)\.(\w+)/g)){
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
| `WORLD.maxSubSteps` | 5 | Spiral guard |
| `VEHICLE.maxChassisSpeed` | 100 m/s | Guardrail, not a speed limit |
| Player ray membership | `0x0001`, mask `0xfffd` | belt and braces; see §4.5 |
| Rapier `linearDamping` | **0** | see bug #4 |
| `TRAFFIC.maxImpactDv` | 11 m/s | ceiling on Δv from one impact |
| `chunks.TUNNEL_EPS` | 1e-4 | the *only* "is there a bore" threshold |

**The player's car is the only rigid body in the world besides static terrain
and tunnel colliders.** Nothing else is dynamic.

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

### Test-harness bugs that masqueraded as game bugs

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

**No browser has ever rendered this.** The Chrome connector reports no browsers
(`list_connected_browsers` → `[]`). Every claim about behaviour comes from
headless measurement. Nothing here has been visually confirmed: colour grading,
sky gradient, bloom, depth of field, tunnel interiors as they *look*, tree
density, HUD layout, the garage screen, touch controls.

In particular the tunnel rework is verified **geometrically** — no terrain in the
bore, no open sky, no gap the shell cannot cover, no step or hole in the
collision surface — but nobody has looked at a portal.

### Known rough

- **Faceting at the corridor edge.** 3 cells per seed out of 7560 in the
  420–700 m band meet at over 60°, worst 97°. All are on the inside of a bend
  and are the fold guard's skew (§3), not noise. Fog leaves ~1% of the colour
  out there. Fixing it properly means making the fold mapping independent of
  per-row curvature.
- **`_separate` runs one relaxation pass** over a list sorted before positions
  were adjusted. It has never failed a soak test, but it is not a proof.
- **Impacts are box-vs-box in road space**, so a car struck at a sharp angle
  resolves along the road axes rather than the true contact normal. It reads
  fine at speed; it would not survive slow-speed nudging scrutiny.
- The `engine_sim` submodule, §1.

### Verified good (headless, this pass)

- Carriageway surface: **0 steps over 30 cm and 0 holes in ~500k ray probes**
  across three seeds and 3 km each, tunnels included.
- Carriageway height equals the exact cut/fill clamp to **0.000000 m**.
- Tunnels across six seeds: 0 vertices cut in a sealed bore, 0 standing in a
  mouth, surviving edge on the clearance line.
- Terrain faceting, adjacent-face angle, old → new:

  | band | mean | p99 |
  |---|---|---|
  | 0–80 m | 2.69° → **1.95°** | 17.19° → **10.43°** |
  | 80–200 m | 6.07° → **4.48°** | 29.62° → **17.79°** |
  | 200–420 m | 9.01° → **6.34°** | 39.42° → **24.12°** |
  | 420–700 m | 13.94° → **7.06°** | 56.25° → **27.72°** |

- Traffic, 4 minutes at 150 km/h, four seeds: nearest spawn 460 m, longest stall
  **0.00 s**, car-frames below 1 m/s **0.00%**, same-lane overlaps **0**, settled
  lane error 0.076 m, population 9/9.
- End-to-end drive, 90 s flat out, four seeds: 0 non-finite states, **0.00%**
  airborne, 0 hard hits away from traffic, 0 recoveries, deepest below the road
  0.15–0.25 m (suspension travel).
- Impact Δv peaks at exactly the 11 m/s cap; measured 658 m/s² against the
  660 m/s² the cap implies at 60 Hz.
- Tree grounding **0 mm** mean and p99 against the terrain collider; per-chunk
  budget holds at 52 with 1.8–2.6 draw batches.
- Tunnels: **0 sky leaks in 211k rays** from inside sealed bores; worst terrain
  step away from a portal **1.4 m** across seven seeds; portal faces 6–9 m,
  which is the intended rock face.
- Handling: spin recovery **0.68 s** (was 3.96 s and went round); steering
  headroom at 200 km/h **4.6×** the tightest corner (was 1.85×); speed retained
  through a drift **51 km/h** (was 15); no rollover regression on monster / van
  / military / pickup in a 6 s slalom at 90 km/h.
- Garage: engine blips 904 → 7819 rpm in neutral, selects first gear on Drive,
  and the parked car moves **0.0 cm in five seconds** on a 4.7% grade.
- Tunnel meshes: **0 coincident triangles** across four seeds (was 11.4%).
- Traffic mode: 43 near misses detected in a 3-minute run (37 oncoming), closest
  1.07 m; scoring curve, oncoming bonus, chain build/decay/refill and cooldown
  all verified.
- **39 DOM ids and 13 toggled classes** resolve against `index.html` — the only
  guard there is against a typo silently killing a button.
- All 18 modules parse; config audit clean.
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
| `probe/tunnel.mjs` | Anything standing in the carriageway, or missing from under it? Exits non-zero on any step over 30 cm or any hole. |
| `probe/roof.mjs` | Is the rock over a bore unbroken, and is the mouth open? |
| `probe/traffic.mjs` | Spawn distance, stalls, overlaps, lane error, population, impact Δv. |
| `probe/terrain.mjs` | Faceting, by distance band. |
| `probe/props.mjs` | Do trees sit on the ground? Rays against the real collider. |
| `probe/skyleak.mjs` | Can you see daylight from inside a bore? |
| `probe/cliff.mjs` | Longitudinal terrain steps, portal faces counted separately. |
| `probe/handling.mjs` | Steering by speed, slide recovery, drift, rollover safety. |
| `probe/tunmesh.mjs` | Coincident faces and spurious portal rings. |
| `probe/score.mjs` | The near-miss mechanic, without physics. |
| `probe/ui.mjs` | Every DOM id a module reads exists; every class it toggles is styled. |
| `probe/drive.mjs` | End-to-end: real car, real physics, real engine_sim, real traffic. |

Each takes an optional seed as the first argument. `drive.mjs` also takes a
duration in seconds.

Syntax check across all modules:

```bash
mkdir -p /tmp/frc
for f in src/*.js; do cp "$f" "/tmp/frc/$(basename ${f%.js}).mjs"; \
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
different port for fastroads so both can run side by side.
