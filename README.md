# FASTROADS

An infinite procedural driving game — Three.js rendering, Rapier (WebAssembly)
physics, Simplex-noise terrain, and a hand-written raycast vehicle controller.

No build step and no install. Code dependencies load from a CDN through an
import map; art loads from `assets/` at runtime. Nine drivable vehicles, each
with physics derived from its own model, and a Quaternius forest placed by
altitude, slope and biome.

## Running

ES modules and WebAssembly both require a real HTTP origin — opening
`index.html` from the filesystem will not work.

```sh
npm start                 # -> http://localhost:8137
# or anything equivalent:
python3 -m http.server 8137
npx serve -l 8137 .
```

## Assets

- **Vehicles** — `assets/car_models/Fbx`. Every model is one body mesh plus four
  tyres named `*_FL_Tire` … `*_BR_Tire`, sharing a 512×512 palette atlas. The
  tyres are detached at load so the controller can steer and spin them, and the
  atlas is sampled with `NearestFilter`: it packs flat swatches edge to edge, so
  any filtering bleeds neighbouring colours along every UV seam.
  `Air Plane_1.fbx` is not in the roster — it has three wheels and a propeller,
  and a four-corner raycast vehicle has nothing sensible to do with it.
- **Foliage** — Quaternius Ultimate Nature Pack, `OBJ` variant. The pack ships an
  `.mtl` beside each of its 150 models, but those carry nothing except a flat
  diffuse colour drawn from a palette of ~18 names. Fetching 150 files to
  recover 18 colours is pure latency, so the palette is inlined in `assets.js`
  and a small dedicated OBJ parser bakes `usemtl` straight into a vertex-colour
  attribute. The result: one geometry and **one material for the entire forest**,
  trunks through berries, ready to instance.

## Controls

| | |
|---|---|
| `W` / `↑` | throttle |
| `S` / `↓` | brake, then reverse from a standstill |
| `A` `D` / `←` `→` | steer |
| `Space` | handbrake |
| `E` / `Q` | shift up / down (either drops the gearbox into manual) |
| `G` | auto / manual gearbox |
| `L` | headlights |
| `F` | flash (hold) — traffic ahead pulls aside |
| `C` | cycle camera (chase / close / hood) |
| `R` | respawn |
| `M` | mute |

A standard-mapping gamepad works too: left stick to steer, triggers for the pedals.

## Architecture

```
index.html      import map, HUD markup, boot
src/config.js   every tunable, in SI units
src/assets.js   OBJ parser (bakes usemtl to vertex colour), FBX car loader
src/cars.js     vehicle roster + mass/geometry-derived parameter synthesis
src/foliage.js  species catalogue and the placement ecology
src/util.js     math helpers, seeded PRNGs (alea, mulberry32)
src/noise.js    fbm heightfield + the low-pass field the road follows
src/path.js     infinite Catmull-Rom spline, arc-length table, banking
src/chunks.js   road-space terrain, carving, colliders, instanced props
src/vehicle.js  raycast suspension, tyre model, powertrain
src/scene.js    renderer, golden-hour rig, sky shader, post stack
src/camera.js   damped chase rig
src/powertrain.js  engine_sim wired in as the car's drivetrain (torque + sound)
engine_sim/     procedural engine sound simulator (separate project, unmodified)
src/input.js    keyboard + gamepad
src/hud.js      instrument cluster
src/settings.js collapsible drawer: volume, 7-bus mix, tone, gearbox mode
src/main.js     fixed-step loop and streaming
```

### The generation chain

Each stage exists because the one before it has a characteristic failure.

1. **Gradient noise with analytic derivatives.** Everything downstream needs the
   slope of the field, not just its value, so the noise returns
   `(value, d/dx, d/dy)` from one evaluation. Quintic interpolation, because the
   next stage differentiates the field and cubic would leave a crease on every
   lattice line.
2. **Derivative-damped fBm** ([Quilez](https://iquilezles.org/articles/morenoise/)).
   Plain fBm is isotropic mush. Dividing each octave by `1 + k|Σd|²` suppresses
   detail where the accumulated slope is already steep, leaving smooth valley
   floors and sharp ridges — the signature of erosion without simulating any.
3. **Domain warping** ([Quilez](https://iquilezles.org/articles/warp/)).
   Displacing the sample point by another fBm bends round, blobby contours into
   winding ridge lines and sinuous valleys.
4. **Six archetypes** — plains, hills, valleys, mountains, canyon, plateau —
   blended by two very low frequency fields indexing a 2D archetype space, with
   weights summing to one. Two fields rather than one scalar, because a single
   dial can only ever produce one ordering of biomes, so every journey would
   climb the same ladder from plains to mountains.

Measured over 18 × 18 km: coverage 13–24% per archetype, mountains reaching
147 m with 7° mean slope against 3° on the plains.

### Cut and fill — one clamp, every road form

The old smoothstep carve produced a soft trough whatever the terrain did. The
ground is now the natural surface clamped between two planes:

```
y = clamp(natural,  roadY − fillSlope·d,  roadY + cutSlope·d)
```

That single expression is what real alignments are designed to, and every road
form falls out of it: both sides cut through a valley, one cut and one filled
along a mountainside, both filled across a hollow, and a rock cutting where the
road punches through a ridge. Steeper cut than fill, because rock stands where
loose fill will not.

### Tunnels

Real bores through the rock, on by default (`ROAD.tunnels`). Where cover stays
deep enough for long enough to be worth boring, the mountain is left solid right
across the corridor so the terrain sheet becomes the lid, and a swept arch
supplies floor, walls and roof.

**Where a bore goes is decided by a stateless filter.** The marking used to grow
runs incrementally and commit one only when it looked "settled" relative to how
far generation had got, which made the answer depend on the order samples were
framed in. It froze runs mid-mountain: measured, 32 m of road carrying 11–14 m
of rock with no bore marked. Outside a bore the cut-and-fill clamp flattens the
corridor to road level, so that became a **15 m vertical cliff straight across
the carriageway** at the tunnel exit — which is what "the roof doesn't integrate
with the terrain" actually was. Not a seam: a missing tunnel.

It is now four standard 1-D morphological steps on the rock-cover signal —
threshold, close short shallow spots, open away short runs, then a distance
transform for the portal ramp — so a sample's answer depends only on the cover
within a bounded window around it. Results are written only where they are
final, and the spline will not report a length as ready until the flags there
have settled, so no chunk is ever built against one that might still change.

Two mesh faults are worth recording because neither shows up in any ray test.
The shell used to leave its floor points where they were, on the reasoning that
it should sit flush on the slab — what that actually did was sweep the floor a
second time in the same place, and since the lining is double-sided both copies
drew and fought for the depth buffer. **11.4% of every bore's triangles were
coincident**, which is the shimmer along the floor. And end caps were emitted at
both ends of every span, including where a span had merely been clipped by a
chunk boundary, so a ring of rock appeared around the bore in the middle of the
tunnel once every 120 m. Caps now go only where the bore really ends, and spans
snap to a global station grid so two chunks meeting at a boundary generate
bit-identical vertices there.

**Everything else about a tunnel is decided in road space.** The previous scheme
asked a height question — "is this terrain vertex below the arch?" — and it
could not bound its own error. Two rules replace it:

*Clearance, not cutting.* `boreClearance(v)` is the height above the road plane
that terrain is held clear of, applied with a `max`. The mountain therefore
*cannot* reach into the bore, whatever the rock cover does, so no roof quad ever
has to be removed to keep the carriageway open. Cutting on a height test was
only ever as reliable as where the grid's vertices happened to land.

*The mouth is a rectangle.* A vertex is a mouth if the tunnel factor is in
transition and `|v|` is inside the bore — which is exactly the two rows over
which the surface climbs from cut-and-fill level to the mountain. That climb is
the rock face, and the face is the only thing that stands across the bore.

The portal transition is deliberately **short** — 6 m, about two rows. At the
old 18 m the terrain climbed the full depth of the mountain inside the ramp, up
to 60 m of rise, so the vertex left standing beside the hole sat **35 m** above
the arch while the shell reached only 8.2 m. That ring of nothing around every
mouth was the visible "gap around the tunnel". Making the transition a face
instead bounds the surviving edge to one cell of cut slope, which the shell
covers by construction rather than by luck.

Both the clamp release and the headroom arrive on the *same* eased ramp — a step
on either put a riser the height of the arch between one row and the next — and
the headroom decays sideways over 45 m rather than over the 2.5 m sill, so the
bore sits inside a hill instead of under a creased 62° berm.

Measured: **0** vertices cut away inside a sealed bore (each would be open sky
over the road) and **0** left standing in a mouth, across six seeds. **0** sky
leaks in 211 000 rays fired up and outward from inside sealed bores, against the
terrain *and* the shell. Worst terrain step away from a portal **1.4 m** across
seven seeds, against 28.8 m before; portal faces are 6–9 m, which is what a
portal is.

Three things learned the hard way and worth keeping:

- Releasing the cut clamp across the full width — the obvious reading of "leave
  the terrain alone here" — raises the carriageway with it and builds a ramp out
  of the portal, so the car drives up over the mountain rather than into it.
- The portal rings must not be collision geometry. A span is clipped to its
  chunk, so a tunnel crossing a chunk boundary grows a pair of them back to back
  mid-bore, which as collision geometry is a bulkhead across the road.
- One threshold per concept. Four places tested "is there a tunnel here" with
  three different numbers, and in the band between them the terrain was lifted
  clear of the arch but not removed — an 8.8 m wall across the approach, which
  is `tunnelCrown + tunnelRoof` exactly.

Without tunnels the cut-and-fill clamp produces deep cuttings instead — 13 m to
77 m depending on seed — and they look fine.

### Terrain is generated in road space, not world space

This is the load-bearing decision in the project. A chunk is a strip of the
spline parameterised by `(u, v)` — arc length along the road, lateral offset
across it — and each vertex row sits on the spline frame at its own `u`.

Three things fall out for free:

- **Carving is a 1D blend on `|v|`** rather than a mesh boolean against a curve.
  On the centreline the height *is* the road height; past `blendOuter` it is
  pure noise; the smoothstep between them produces the cut-and-fill slopes.
- **Seams are exact.** Adjacent chunks share the same `u` at the boundary, so
  their boundary rows are bit-identical. Measured discontinuity: **6.9 × 10⁻⁶ m**.
- **Resolution follows the player** — 2 m lateral spacing on the asphalt,
  tens of metres out at the fog line.

The cost is that the parameterisation folds where the road curves tighter than
the corridor is wide — the corridor runs to 700 m against a measured minimum
turn radius of 430 m, so this is not hypothetical. It is handled explicitly
below.

### Guarding the parameterisation against folding

Rows fan out sideways from the spline, so on a bend they radiate from the
curve's centre of rotation, a lateral distance `R = 1/|curvature|` away on the
inside. A vertex past that point has gone *through* the centre and comes back
out the other side — the mesh folds through itself.

The inside of each row is therefore compressed asymptotically,
`v' = L·(1 − e^(−|v|/L))` with `L = 0.7·R`, mapping `[0, ∞)` onto `[0, L)`. The
0.7 margin is not decoration: rows sit `Δs·(1 + v·κ)` apart, so a column exactly
at `R` would have *zero* longitudinal extent and the resulting slivers produce
garbage normals long before anything technically inverts. Near the road the
correction is under 1% at the kerb (road width measures 8.397 m against a
nominal 8.400 m) and it vanishes on straights. Curvature depends only on arc
length, so neighbouring chunks compute an identical correction and seams stay
exact.

### Raycast vehicle

Rapier supplies exactly three things: a rigid body with a mass/inertia tensor,
an impulse API, and ray queries. The chassis collider exists only so a real
crash has something to hit — it is excluded from every suspension ray. All
vehicle dynamics are hand-rolled, per wheel, per 120 Hz substep:

1. **Suspension.** A ray down the chassis' local −Y gives compression
   `x = (restLength + radius) − hitDistance`, and the spring is Hooke plus a
   viscous damper, `F = k·x + c·ẋ`, with stiffer rebound than bump and a force
   ceiling so hard landings can't launch the chassis.
2. **Anti-roll.** Per axle, the normalised travel difference lifts the
   compressed corner and pushes the extended one down — applied to the stored
   wheel *load*, so lateral grip responds to weight transfer rather than merely
   hiding body roll. The bars are rear-biased, because a stiff bar moves load
   transfer onto its own axle and tyre grip is sub-linear in load, so the stiff
   end is the end that lets go first.
3. **Tyre forces.** An Ackermann-steered wheel frame resolves the contact-point
   velocity into a slip angle, and lateral force follows a stripped-down Pacejka
   Magic Formula, `Fy = D·sin(C·atan(B·α))` — building with slip angle, peaking
   near 8°, then easing off. That falloff *is* the feel of the front axle going
   light. Longitudinal force is engine torque through the gearbox minus braking,
   with traction control capping drive at the friction left after cornering.
   Both are then clipped to a friction circle of radius `μ·Fz·dt`.

Forces are applied slightly *above* the contact patch: weight transfer survives,
the roll moment that would otherwise trip the car does not.

Suspension travel drives the wheel meshes directly — they are children of the
chassis group, so compression is a local −Y offset and steer/spin are local
rotations, using the same Ackermann angle the physics uses.

### Every car is derived, not hand-tuned

`cars.js` holds nine roster entries carrying only character — mass, torque,
gearing, drive layout, grip, CoM height. Everything geometric is measured from
the FBX at load, and the rates are synthesised so the whole roster behaves
consistently across a 2.4× mass range and 1.7× wheel-size range:

| derived | from | so that |
|---|---|---|
| `springK` | `m·g / 4·sag` | static sag is the same fraction of travel on a 1.1 t hatchback and a 2.6 t truck |
| damping | `ζ·√(k·m)` | a fixed fraction of critical, per direction |
| travel | rolling radius × character | big-wheeled trucks get the long soft suspension their proportions imply |
| anti-roll | roll moment ÷ target lean | see below |
| clearance | `max(1.6·sag, 0.55·r)` | the floor pan never rests on the road |
| brakes, handbrake | fractions of weight | stopping power scales with the vehicle |

Two of those need explaining, because the obvious versions are both wrong.

**Anti-roll cannot be a fraction of spring rate.** That is what it was, and it
fails at the extremes: the monster truck's springs are soft *because* its travel
is huge, so a proportional bar left a 2.9 m-tall body with almost no roll
stiffness and it lay down in the first corner. It is now sized from the roll
moment the vehicle will actually see — `K = m·a_limit·arm / θ`, with the springs'
own `k·track²/2` subtracted and the bars making up the shortfall. Every car now
leans 3.4–5.3° at its own limit.

**A collider spanning the full body height rests on the road.** These models
include a floor pan reaching down to y = 0, which is also the contact plane, so
wrapping the box around the whole body left it scraping. Rapier's contact
friction then fought the tyres, and the two heaviest bodies — van and monster
truck — simply never moved.

### Steering is limited by grip and by rollover — until the car is sideways

In a steady-state turn `v²/R = a_max` and Ackermann gives `R = L/tan(δ)`, so the
largest angle the car can actually follow is `δ_max = atan(L·a_max/v²)`, with
`a_max` the lesser of what the tyres will hold and what the vehicle will stand
up to (`SSF·g`, half-track over centre-of-mass height). Let the player exceed it
and the front tyres are asked for more than they have: the wheel turns, the car
plows on, and it feels completely disconnected from its front axle. That is why
the Monster Truck understeers and the Sport does not.

**But it is a steady-state derivation, and a slide is not a steady state.** Once
the car is sideways the front wheels are being pointed down the velocity vector,
not used to generate more lateral force, so neither ceiling applies to them.
Enforcing it anyway is what made a slide unrecoverable: measured at 108 km/h,
the rollover limit capped the lock at **4.3°**, so a driver trying to catch a
190°/s spin had essentially no countersteer and none of it was their fault.
Countersteer took 3.96 s to arrest and the car went right round.

The lock now opens as the chassis slip angle grows — **proportionally**, to a
fixed multiple of whatever the limit already was, never a jump to full lock.
Going straight to 33° the moment the car moved around read as the steering ratio
changing underneath you. It costs nothing when straight, because the term is
zero there, and it does not make the tall vehicles roll: a saturated tyre does
not produce more lateral force just because the wheel is turned further, and a
slalom at 90 km/h in the monster truck, van, military and pickup stays level.

Two smaller changes carry the rest of the feel:

- The Magic Formula shape factor was 1.45, which keeps only `sin(C·π/2)` = 76%
  of peak grip once the slip angle is large — the tyre falls off a cliff the
  moment it lets go. At 1.25 it keeps 92%, and a slide becomes something you
  steer rather than something that happens to you. Speed retained through a
  drift went from 15 to **51 km/h**.
- A yaw damper fades in between 36° and 72° of chassis slip. Below 36° it does
  literally nothing. It was tried at 23° and a strength of 3.0, which caught a
  spin in 0.68 s — excellent, and completely obvious: 23° is an ordinary slide,
  so the car was being straightened out from under the driver every time they
  provoked one. Late and gentle, it is a net that catches a genuine spin rather
  than a hand on the wheel.

Measured end to end: a handbrake turn at 108 km/h leaves the car yawing at
3.2 rad/s. Untouched it takes 3.45 s to arrest and rotates 286° — very nearly
all the way round. With the assist it is 2.54 s and 135°. The assist is doing
real work without doing the driving.

### Depth of field was the wrong tool

Depth of field focuses at *one* distance. With focus pulled toward the horizon
as speed rose, the car — five metres from the camera — became the most
out-of-focus thing on screen, which in a driving game is nonsense.

Radial blur is the effect that belongs here: the centre of the screen, where the
car and the road ahead are, stays perfectly sharp, and samples are smeared along
the direction away from the centre so the periphery streaks past. It reads as
speed because that is what speed looks like, and it never touches the thing you
are steering. The field of view opens 12° across the speed range as well —
`CAMERA.speedRef` used to be 165 m/s, which is 594 km/h, so every speed-dependent
camera term had been effectively inert.

### Two modes, and a reason to take a risk

**Zen** is the original brief: an empty road, no traffic, nowhere to be.
**Traffic** turns the same road into a game — the other cars are the obstacle
and the reward at once, because the points are for threading past them, and the
run ends the moment you actually hit one.

The scoring is the familiar shape and the shape is the point: closer pays more,
and consecutive passes build a multiplier that bleeds away unless it is
refreshed. What makes that a decision rather than a readout is that the chain is
worth more than any single pass, so the player keeps hunting for one more gap
instead of backing off — which is exactly the behaviour that gets them hit.

Three details are load-bearing:

- **Oncoming traffic pays 2.4×.** It arrives at the sum of both speeds, so the
  same lateral gap is a fraction of the time to judge and react to. Paying the
  same for it would make the safe half of the road the optimal one.
- **The chain is refilled, not extended.** A late pass is worth exactly as much
  as an early one, so there is never a reason to hold back and wait for the bar.
- **There is a cooldown.** Without one, threading between two cars abreast scores
  twice in the same instant, and a queue in both lanes is a jackpot for a single
  decision. One decision, one payment.

A pass is measured over the whole encounter, not sampled: `_trackPasses` keeps a
running minimum of the clearance and reports it once the car is astern. At
250 km/h against oncoming traffic two cars can go from ten metres apart to ten
metres past inside one frame, so a per-frame sample would make the reward depend
on frame rate.

### The garage is the real car

The title screen leaves the middle of the screen transparent and orbits the
actual vehicle, sitting on the actual road, in the actual scene. Nothing is a
preview: paint is a live material property, so a colour click is immediate, and
switching car rebuilds the same vehicle the player is about to drive.

Picking a car or an engine also blips the throttle, with the gearbox forced to
neutral so the engine revs freely instead of bogging against a stopped
driveline. That first click is what starts Web Audio — it is the user gesture
the API requires, and taking it there means the player hears an engine before
committing to it rather than discovering it a kilometre down the road.

The car is **pinned** while it is being chosen. Cancelling its velocity is not
enough: the drift that accumulates inside a physics step was 11 cm in five
seconds on a 4.7% grade, so any seed with a gradient under the spawn had the
player picking a paint colour for something rolling away down the road. Position
is rewritten too, with height left free so the suspension still settles.
Leaving the garage sweeps the camera round behind the car rather than cutting to
it, which matters at the exact moment the player takes control.

### Rendered motion is interpolated between physics steps

Physics advances in fixed 8.33 ms steps; frames arrive on the display's clock.
At the moment of drawing, the simulation is somewhere *between* two steps.
Drawing the raw body state snaps the car to whichever step happened last, which
at 60 m/s is a jump of up to half a metre every frame — this is what read as the
car stuttering and teleporting. The previous step's transform is now kept and
blended by the leftover accumulator, and the camera tracks the interpolated
transform rather than the physics one (tracking the raw state would reintroduce
exactly the judder the interpolation removes).

Measured against `speed × dt`, over 600 frames of simulated vsync jitter at
198 km/h:

| | jitter rms | p99 | worst |
|---|---|---|---|
| raw physics state | 146.2 mm | 457.0 mm | 467.9 mm |
| interpolated | **0.3 mm** | **0.5 mm** | **0.6 mm** |

### The engine simulator is the drivetrain

Audio comes from `engine_sim/`, a procedural engine sound simulator that
synthesises from firing geometry — no samples. It is used **unmodified**; its own
166-check suite and 55-combination driving suite still pass.

The integration deliberately goes further than playing its output. A sound
simulator running its own drivetrain *alongside* the game produces an engine note
for a car that isn't the one you're driving: its rpm, its gear and its shifts all
drift away from what the wheels are doing. So the simulator owns the powertrain
outright, and the two halves are coupled in both directions:

```
   game (raycast vehicle)                  engine_sim (Drivetrain)
   ──────────────────────                  ───────────────────────
   forward speed  ─────────────────────▶   wheel omega  ω_w
                                                │ clutch, torsional
                                                │ spring, backlash
                                                ▼
   drive force    ◀─────────────────────   propshaft torque  Tp
```

Each frame the real wheel speed — from Rapier, over actual terrain, including
wheelspin and airtime — is written into the drivetrain, and the torque the
driveline transmits back becomes the tyre model's drive force. The old torque
curve, gearbox and rpm model in `vehicle.js` are gone; what remains there is
everything from the tyre outwards.

The one thing left to the host is the contact patch. The simulator's
`_stepVehicle` integrates a point-mass car with lumped drag and braking, all of
which we already model per wheel inside a friction circle, so that single method
is overridden **per instance** — engine_sim's source is untouched, and its tests
keep passing.

Each car supplies its own drivetrain profile (mass, wheel radius, ratios, final
drive, derived tooth counts) and an engine: flat-plane V8 for the Sport, a
cross-plane V8 for the Muscle, Pick-Up and Monster Truck (uneven bank firing puts
31% of its energy in the half-orders — the burble), inline sixes, an i4, a V6 and
a turbo i5.

Three things fall out of the coupling rather than being scripted:

- **Gear shifts are a real torque interruption.** Traced on the Muscle car, an
  upshift drops drive force to **0 N** through the `sync` phase — the car
  genuinely decelerates at −0.67 m/s² — then twist winds up 0.19 rad and force
  ramps to 13.7 kN through `lash`. The previous version faked this with a
  scripted impulse; that code is deleted.
- **Engine braking.** Drive force now goes negative on the overrun (measured
  −9.7 kN peak). The old model could only ever push.
- **Automatics creep, manuals don't.** Measured at rest with no pedals: 3.4–6.8
  km/h of torque-converter creep on the `auto` cars, exactly 0.00 on the manual
  and DCT ones. Nobody wrote that behaviour; it is the clutch model.

Reverse is the one place the simulator has no answer — it has no reverse gear —
so the gearbox goes to neutral (the engine idles and revs against no load, which
is honest) and the host supplies its own reversing force.

### Traffic

**Traffic owns no physics objects.** There are no traffic rigid bodies and no
traffic colliders anywhere in the world. A car is a position on the spline,
`(s, v)`, a speed, and a mesh.

This is a deliberate reversal. Every previous version tried to make traffic real
bodies so collisions would "just work", and each failed the same way: a body
driven by writing its velocity has effectively infinite mass, so the solver's
contact impulse is never consumed and compounds frame over frame. Measured
outcomes along the way — a struck car reaching 6920 km/h, the player ejected
35 m vertically, wrecks handed back several hundred metres per second, and after
each patch, cars that simply stopped and sat in the road. Releasing control just
before contact bounded the damage without curing it, because the object still
had two masters.

Giving it one master makes a whole class of bugs unrepresentable. Traffic cannot
be launched, cannot gain energy, and cannot come to rest in a live lane. The
player's suspension rays cannot find "ground" on a roof — the bug that arrived
twice by different routes. And nine cars cost nine matrices a frame instead of
nine rigid bodies.

Hitting one still has to feel like hitting something. The overlap test is two
boxes in road space, which is cheap and stable in a way a world-space test on a
curved road is not. The response is the closed-form impulse for two masses
meeting at a closing speed:

```
j = −(1 + e) · (v_rel · n) · m₁m₂/(m₁ + m₂)
```

applied to the player's body and to nothing else, resolved along the shallower
overlap axis so a rear-end shunt is told from a side-swipe. Energy cannot be
injected: the impulse always opposes the approach, by construction. It is capped
at 11 m/s of Δv — not a fudge, but the difference between a shunt and being
deleted from the world by a glancing blow at 300 km/h.

The struck car takes its half as a scripted spin-out: it slews toward the verge,
rotating and slowing, and leaves after a few seconds. Because that is scripted
it can move out of the way immediately, so no penetration ever persists and
there is nothing for a solver to recover from.

What *is* simulated is behaviour, because that is the part you feel: a
car-following model with a time headway, corner speed from `√(a/κ)`, awareness
of the player behind, and lane changes both to overtake and to yield when
flashed. Separation is *asserted* rather than converged on — with nothing
simulated, overlap can be made impossible instead of unlikely.

Cars appear beyond 460 m, where fog and depth of field have taken them. The old
window started 40 m ahead, which put cars into existence in plain sight in the
middle of the carriageway.

Measured, four minutes at 150 km/h across four seeds: nearest spawn 460 m,
longest a healthy car sat still **0.00 s**, car-frames below 1 m/s **0.00%**,
same-lane overlaps **0**, settled lane error 0.076 m, population 9 of 9.

### Depth, not fog

Exponential fog was carrying the entire distance cue on its own, and the way it
does that is by washing everything toward one colour — which collapses the whole
landscape into a single flat plane before you can see any of it. Three changes
share the work out:

- **Far-only distance blur.** A depth-gated pass that leaves everything nearer
  than `blurStart` perfectly sharp and ramps to full blur by `blurEnd`, with the
  sharp zone pushed from 110 m to 320 m as speed rises. A conventional
  depth-of-field focuses at one distance and defocuses either side of it, which
  on a chase camera is exactly wrong — pull focus down the road and the car,
  five metres away, goes soft. Blurring only beyond a threshold keeps the car
  and the road ahead crisp. Taps are weighted by their own depth so a sharp
  foreground cannot bleed outward and halo around the car.
- **Fog density cut from 0.0030 to 0.0016**, which is what the DoF buys: 66% of
  the terrain colour survives at 400 m now, against 24% before.
- **A three-stop sky with clouds.** A two-stop gradient is the single biggest
  reason a scene reads as flat — real sky darkens and saturates toward the
  zenith while staying pale at the horizon, and that falloff is most of the
  depth cue. Clouds are projected onto the dome divided by height, so they
  stretch toward the horizon the way perspective actually does, and pick up a
  silver lining facing the sun.
- **Split-tone grade.** Warm highlights against cool shadows, plus a gentle
  midtone S-curve. A single global tint just shifts everything and still reads
  flat; opposing the two ends is what gives an image depth without touching
  contrast.

### Smooth shading

Flat shading was what made the landscape read as faceted and cartoonish: it
draws every triangle of a 2.4 m mesh as a distinct plate, so a hillside becomes
a mosaic however good the underlying field is. Terrain and foliage are now
smooth-shaded.

That exposes a second problem. `computeVertexNormals` only sees one chunk, so
boundary vertices average the triangles on their own side and come out tilted —
invisible under flat shading, but a hard crease across the world every 120 m
once it is off. Boundary normals are re-derived from the analytic surface either
side of the seam, so both chunks agree: worst mismatch **0.00°** over 128
samples.

### Vegetation grows in stands, not scatter

Half of every draw is taken near one of a handful of cluster seeds rather than
independently. Independent draws give a Poisson field — statistically even, and
it reads exactly as "scattered to fill space". Clumping produces thickets and
copses with open ground between them. Canopy is additionally gated on the
squared forest-density field so stands have edges and a clearing has nothing in
it.

Measured nearest-neighbour clustering index: **0.59**, where 1.0 is an evenly
scattered field and below 1 is clumped.

### Scenery is trees only, for now

Rocks, bushes, plants, flowers, logs and the whole grass pass are switched off.
They were placed by the same weighted-suitability draw as the trees, and a
half-populated understorey reads worse than none — the scatter needs designing
rather than tuning. `foliage.js` is the entire vocabulary; putting a group back
means adding it there and to `FOLIAGE_GROUPS`, and nothing else changes.

### Props sit on the mesh, not on the maths

`sampleGround` returns the *analytic* height. What you see, and what a
suspension ray hits, is the mesh — a chord across each quad. Between vertices
the two disagree by the sagitta of the terrain, and anything placed with the
analytic value floats or sinks.

Props therefore interpolate across the same triangle the renderer draws: same
four corner samples, same diagonal, same winding. And the *whole position* is
interpolated, not just the height — taking y from the mesh while placing x and z
analytically leaves the point off the triangle whose height was read, which on a
curve or in the coarse far field is worth most of a metre.

Measured, per batch: every tree batch lands at **0 mm**, and reflectors 860 mm up their posts.

### Foliage ecology

Species are chosen per sample by weighted suitability against altitude, slope,
distance from the road and the biome mask, so a hillside runs from willows in
the valley through mixed broadleaf to pines and finally bare rock at the
treeline, rather than one uniform forest everywhere.

Two constraints shape the implementation, and both are about batching rather
than looks. An `InstancedMesh` exists per (chunk, model), so letting all twelve
species appear everywhere cost 130+ draw calls before a single tree was shaded —
each chunk therefore commits to a couple of species per group, seeded from its
own index, so neighbouring chunks differ while the batch count stays near seven.
And the per-group caps are a triangle budget: canopy models are 1700–2900
triangles each, two orders of magnitude more than a rock, so they are what
actually needs limiting. Rock also needs an unusually low weight — it has no
slope or altitude limit, passes every suitability test, and will otherwise win
half the draws and turn the world into a quarry.

### The off-road ride, and a fix that made things worse first

Driving off the asphalt was catching on edges that were not there. The obvious
cause was geometry: lateral columns had grown to 12–16 m against 2.5 m rows, and
triangles that long and thin read as random ridges to a suspension ray. Making
the drivable band uniform at 2.4 m took the worst near-band triangle from 5.0:1
to 0.96:1.

That made it **worse** — wheels-off went from 9% to 71%. The coarse mesh had
been acting as an accidental low-pass filter, and resolving it faithfully simply
resolved how choppy the underlying noise was. The real fault was amplitude, not
sampling: at full strength the detail octaves put a 15° face every 30 m.

Both halves were needed. The verge is now graded — the two highest-frequency
octaves are suppressed close to the road and ramp up beyond it, which is also
what a real roadside looks like:

| lateral offset | max gradient | max curvature |
|---|---|---|
| 0–25 m | 6–7° | 0.005–0.017 /m |
| 40 m | 16° | 0.048 /m |
| 70–120 m | 25–28° | 0.11–0.12 /m |

Worst vertical acceleration off-road fell from 273–398 m/s² to 55–83 m/s².

### Chunk building is split across frames

Densifying the terrain and adding ground cover pushed chunk construction to
~15 ms, which at one chunk per frame is a spike — the same class of problem as
the render-interpolation stutter. Terrain and its collider must exist the
instant a chunk is needed, because the car can drive onto it; the scenery need
not. Scattering is deferred to a frame where no ground is being generated:

| phase | mean | worst |
|---|---|---|
| ground (terrain + road + collider) | 6.4 ms | 7.0 ms |
| props (tree scatter) | 3.4 ms | 4.3 ms |

Worst single frame: **7.0 ms**, down from ~15 ms.

### Measured behaviour

Vehicle dynamics measured on a flat plane, which isolates the car from terrain;
streaming and durability measured on the real generated world.

Every car, settled and driven from its own FBX:

| car | mass | 0–100 | top | brakes | roll at limit | SSF | limited by |
|---|---|---|---|---|---|---|---|
| Sport | 1180 kg | 4.1 s | 242 km/h | 133 m | 3.4° | 1.60 | grip |
| Muscle | 1520 kg | 5.3 s | 229 km/h | 120 m | 3.9° | 1.27 | roll |
| Interceptor | 1650 kg | 6.0 s | 212 km/h | 104 m | 4.1° | 1.13 | roll |
| Hatchback | 1090 kg | 7.1 s | 182 km/h | 78 m | 4.0° | 1.08 | roll |
| Pick-Up | 1950 kg | 7.3 s | 183 km/h | 81 m | 4.1° | 1.03 | roll |
| Military | 2600 kg | 8.2 s | 165 km/h | 71 m | 4.8° | 0.89 | roll |
| Classic | 1240 kg | 9.5 s | 160 km/h | 62 m | 3.8° | 1.11 | roll |
| Van | 1820 kg | 12.4 s | 140 km/h | 51 m | 4.5° | 0.80 | roll |
| Monster Truck | 2400 kg | 6.3 s | 189 km/h | 92 m | 5.3° | 0.86 | roll |

All nine settle 4/4 wheels with under 10 mm of sag error against the analytic
`m·g/4k`, at a ride height within 7 mm of the model's own design pose.

| | |
|---|---|
| Static ride height / sag | 0.765 m, sag 0.111–0.119 m vs. 0.119 m analytic (`mg/4k`) |
| Static corner loads | 4820/4820/5180/5180 N, summing to 20000 N = exact vehicle weight |
| 0–100 km/h | 4.44 s |
| Top speed | 229 km/h, at genuine aero equilibrium (drive 2691 N vs. drag 2240 N + rolling 320 N) |
| Braking | 164 → 0 km/h in 51.2 m, 1.27 × vehicle weight |
| Steady cornering | 84–94% of geometric yaw rate; front slip 4.5–8.0° vs. rear 3.8–5.8° (front-led = safe understeer) |
| Body roll | 2.1–3.1° at the limit |
| Step-steer | 90% of peak yaw in 0.24 s |
| Power-on with TC | 2.7° peak body slip — flooring it mid-corner will not spin the car |
| Handbrake | drift to ~88° body slip with all four wheels still planted |
| 5 min autopilot on terrain | 15.9 km, 0 respawns, 0.08% airborne, 10.2 m max lateral |
| Road banking | 3.2% mean, 7.5% peak cross-slope |
| Terrain relief | −58 to +101 m over 25 km of road |
| Seam discontinuity | 6.9 × 10⁻⁶ m |
| Chunk cost | 2501 terrain verts / 4800 tris + ~125 props / 101k instanced tris, ~9 ms to build, 1 per frame |
| Streaming | 9 live chunks, 7 prop batches each, flat heap over 10 km |
| Foliage | 6 canopy species, 26 models, one shared material |
| Terrain relief | mountains to 147 m, 7° mean slope; plains 3° |
| Seeds | `?seed=` in the URL; identical seed reproduces the road exactly |
| Tunnels | 0–18% of route by seed; 0 steps and 0 holes in ~500k carriageway ray probes |
| Carriageway | 4 lanes of 3.7 m, two each way, solid double centre line |
| Canopy clustering index | 0.59 (1.0 = evenly scattered) |
| 4 min drive | 13.7 km at 209 km/h, 0.5 m max lateral, 0.00% airborne, 0 respawns |
| Scene cost | ~151k instanced triangles and 9 batches per chunk; ~1.5 M triangles live |
| Prop grounding | 0 mm for every batch except two deliberate offsets |
| Centre line | 98% of dash transitions land on zero-length rows |
| Audio graph | 278 nodes, 0 unstarted, 0 orphaned, 0 violations, sealed (zero per-frame allocation over 10 800 frames) |
| rpm vs. road speed | exact (0.0% error) on manual/DCT cars; 4.8–12.8% on autos, which is converter slip |
| Idle | within 5% of each engine profile's idle rpm, no stalling after a full stop |

### Notes on the details that bite

- **Three composes a local matrix as T·R·S, so rotation is applied before
  translation.** A single node carrying both a centring offset and the models'
  180° yaw maps a point to `R·p + T`, leaving each wheel hub at `R·centre −
  centre` instead of at the origin — the wheel then *orbits* that leftover
  offset rather than spinning in place. The centring translation and the yaw
  need separate nodes.
- **Re-parenting an FBX mesh silently drops every transform above it.**
  Exporters routinely put a scale on the root. Each part's world matrix is baked
  into its geometry before the hierarchy is taken apart, so the groups the game
  builds are the only transforms left in play.
- **Face winding decides whether the world is visible at all.** With `+row` as
  the tangent and `+column` as `right`, `up = right × tangent`, so triangles
  must be wound `(a, b, c)`. Wound the other way, every surface is backface-
  culled and lit from beneath — the terrain disappears and the car renders
  inside-out and half transparent.
- **`driveBias` entries scale the total drive force and must sum to 1.** A set
  summing to 2 does not split torque between axles, it doubles the car's
  acceleration.
- **`linearDamping` is not free.** Rapier applies `damping·m·v`, which at
  190 km/h was ~1300 N — comparable to the whole aero drag term, and it made
  `dragCoefficient` meaningless. It is zero here; all longitudinal resistance is
  modelled explicitly, so top speed is a property of the car.
- **Detail octaves must fade with distance.** Lateral sample spacing reaches
  55 m in the far field, so a 13 m wavelength cannot be represented there and
  aliases into random near-vertical spikes. `noise.js` drops the octaves the
  mesh can no longer carry — a hand-rolled mip.
- **Fog depth and corridor width are one decision.** At 170 m the exponential
  fog still left ~80% of the terrain colour, so the edge of the world was
  plainly visible off to the sides. The corridor now runs to 700 m, where fog
  leaves 1.2%.
- **Config keys silently resolving to `undefined` produce `NaN`, not an error.**
  Twice, constants were added to the wrong exported block — `ROAD.cutSlope` sat
  in `CHUNK`. `undefined * 0` is `NaN`, and `clamp(v, NaN, NaN)` returns `v`, so
  the cut-and-fill clamp quietly passed the raw terrain height straight through
  and the road ran 8 m underground. There is now an audit that checks every
  `BLOCK.key` reference in `src/` against the block it actually lives in.
- **A road profile needs a vertical-curve limit, not just a gradient limit.**
  Clamping gradient alone still let it swing from +9.5% to −9.5% across one 46 m
  span. Vertical acceleration is `v²·curvature`, so at 160 km/h that threw the
  car 16 m into the air. `maxGradeChange` bounds how fast the gradient itself
  may change.
- **One-shot keys were being thrown away before anything read them.**
  `input.update()` cleared the pressed set at its end, and the loop calls it
  *before* reading actions — so R, C and M never fired. Clearing now happens at
  the end of the frame instead.
- **Vertex colours interpolate across a quad.** Centre-line dashes whose ends
  fell mid-row faded in and out over that whole row. Both the painted edge lines
  and the dashes now emit a *duplicated row or column* at each boundary: the
  pair has zero length, so there is nothing to smear across.
- **`mock.audit()` needs the destination node passed to it.** Called bare it
  reports every source as orphaned — 42 false positives, on the one check
  engine_sim's own notes single out as the most important in the project.
- **Rapier only refreshes its query pipeline inside `step()`**, so ray casts
  against freshly created colliders return `null` until one has run. `boot()`
  steps the world once before the first vehicle update.
- **Chunk indices are clamped to ≥ 0.** `frameAt` clamps `s`, so a negative
  chunk would collapse every row onto `s = 0` and generate a degenerate mesh
  with no collidable surface. The car starts at `s = 90` for the same reason.
- **Physics runs on a fixed 120 Hz accumulator.** Feeding a hand-written
  suspension a variable frame delta makes damping frame-rate dependent and it
  will oscillate. Backgrounding the tab drops the accumulator rather than
  simulating the backlog in one bite.
- **Chunk geometry is origin-relative**, with Rapier owning the collider
  transform, so float precision holds up hundreds of kilometres out.
- Prop geometries and all materials are shared globally; only terrain and road
  geometry are disposed per chunk (`userData.ownsGeometry`).

### Known limitation

Out past 420 m lateral, about three terrain cells per seed still have faces
meeting at more than 60°. **Every one of them is on the inside of a bend**, and
the cause is the fold guard: it maps lateral offsets through the *local*
curvature, which differs from row to row, so a cell 600 m out is a skewed
parallelogram and its normal is unreliable. That is inherent to road-space
terrain, not to the noise. Colouring takes `|n.y|` so a sliver can never paint a
slope as a cliff, and at that distance fog leaves almost none of the colour.
Fixing it properly means making the fold mapping independent of per-row
curvature.

## Tuning

Everything lives in `src/config.js`. The interesting knobs:

- `WORLD.seed` — change it for an entirely different world.
- `VEHICLE.springK` / `damperBump` / `damperRebound` — ride quality. Critical
  damping for the corner mass is `2·√(k·m/4)` ≈ 7250; the defaults sit at
  0.46/0.61 of that.
- `CARS[].mass / grip / comHeight / travelScale` — vehicle character. Geometry is
  measured and engine_sim owns the torque curve, so these are the only numbers
  worth touching.
- `FOLIAGE_GROUPS.canopy.cap` / `.picks` — the triangle budget for scenery, at
  roughly 2200 triangles a tree and one draw call per model per chunk.
- `CHUNK.nearStep` / `nearBand` — how finely the drivable band is meshed. See
  the off-road note above before raising the amplitude of the detail octaves in
  `noise.js` to match.
- `CAMERA.chase.height / aimHeight` — how high the chase camera rides and where
  it aims. The rig also scales with `bodyHeight`, so a monster truck is framed
  like a sports car rather than from roof level.
- `CAMERA.speedRef / speedLag / distGain` — how far and how eagerly the chase
  rig opens out with speed.
- `VEHICLE.tyreFriction` — the friction ceiling, and via the steering law also
  the usable steering angle at every speed.
- `VEHICLE.corneringStiffnessFront/Rear`, `rearGripBias` — the handling balance.
  Front stiffer = crisper turn-in; rear peak grip higher = safer understeer.
- `VEHICLE.tractionControl` — 1.0 is a perfect nanny, 1.4 still allows wheelspin
  and power-on rotation.
- `ROAD.maxCurvature` — see the folding constraint above before raising it.
- `CHUNK.ahead` / `ATMOSPHERE.fogDensity` — draw distance. Keep them in step, or
  you will either see chunks pop in or pay for geometry the fog hides.
