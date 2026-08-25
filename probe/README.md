# probe/

Headless measurement scripts. There is no test runner and no assertion library —
each script drives the real modules under Node and prints numbers, because the
whole simulation is headless-capable and only rendering needs a GPU.

Nothing here is imported by the game.

```
npm run probe:deps      # three + rapier, not saved to package.json
npm run probe
```

| script | answers |
| --- | --- |
| `surface.mjs` | Is anything standing in the carriageway, or missing from under it? Casts down the drivable width along the whole route, against the window of chunks the GAME keeps alive. Exits non-zero on any step over 30 cm or any hole. Was `tunnel.mjs`. |
| `traffic.mjs` | Do cars appear in view, stop dead, or overlap? Drives a synthetic player for several minutes and reports spawn distance, stalls, overlaps, lane error, population and impact Δv. |
| `terrain.mjs` | How faceted is the ground? Angle between adjacent face normals, by distance band. |
| `props.mjs` | Do trees sit on the ground, and does the per-chunk budget hold? Rays against the real collider. **Skips** while `CHUNK.trees` is off. |
| `cliff.mjs` | Longitudinal steps in the terrain sheet — a seam the car can catch on and the eye reads as a tear. |
| `handling.mjs` | Usable steering angle by speed, whether a slide can be caught, whether a drift can be held, and rollover safety for the tall vehicles. |
| `xsec.mjs` | Prints terrain cross-sections across the corridor — the fastest way to read what an alignment is doing: on a shelf, in a cutting, on an embankment, or halfway up a hillside. |
| `score.mjs` | The near-miss mechanic: reward curve, oncoming bonus, chain build and decay, cooldown. |
| `ui.mjs` | Every DOM id a module reads exists in `index.html`, and every class it toggles is actually styled. With no browser, this is what stands between a typo and a dead button. |
| `smooth.mjs` | **Does the car move smoothly on screen?** The car's position in *camera space*, frame to frame, under scripted frame-time jitter and hitches. The only probe that measures what the player sees rather than what the simulation does. |
| `render.mjs` | **What the GAME looks like.** Boots the real thing through SwiftShader — a headless Chrome has no GPU but ANGLE has a software rasteriser — drives it, and screenshots the garage and the road. Not in `npm run probe`: needs a local Chrome and takes a minute. |
| `route.mjs` | **Does the road go anywhere on purpose?** Classifies the corridor cross-section — shelf / cutting / embankment / level — and reports earthwork, curvature and the self-clearance invariant. |
| `grass.mjs` | Ground cover: how many tufts, what the scatter costs, whether the density matches the config, and that none of it is on the carriageway. |
| `uishot.mjs` | **What the interface looks like.** Screenshots twelve real device viewports over CDP and reports any element overflowing its box. Not in `npm run probe` — it needs a local Chrome and writes images. `node probe/uishot.mjs`. |
| `paint.mjs` | Both paint slots and both lamp pairs actually got triangles, on every car. The split is discovered from the atlas at load rather than declared, so a car whose second colour does nothing would otherwise fail silently. |
| `drive.mjs` | End to end: real car, real physics, real engine_sim, real traffic, for a given number of seconds. |

Each takes an optional seed as the first argument.

## Two traps, both of which have produced convincing wrong answers

**A probe that fires rays must not sample on the mesh lattice.** A ray aimed
exactly down a shared triangle edge — every chunk seam is one, every 2.5 m row
is one — can miss both faces for floating-point reasons. That produced 141
phantom holes; offsetting the sample grid a few centimetres produced 0.

**Never check placement by going back through `(s, v)`.** The scatter runs its
lateral offset through `foldSafeOffset` before placing anything, so recovering
`v` from the finished world position and feeding it back applies the compression
a second time. That reported trees floating 3.97 m above the ground; measured
against the actual collider, the same trees are at 0 mm. If you want to know
where something is, ask the collider.

**A probe must build the world the GAME builds.** `surface.mjs` built every
chunk at once — thirty-five terrain sheets where the manager only ever holds
nine — and reported 33,110 steps on a carriageway that both the height function
and the drawn mesh agreed was perfectly flat. Every one of them was a collision
between two chunks that can never coexist. Each sheet reaches 700 m either side
of its own 120 m of road, so a chunk two kilometres away can lie across the
carriageway here.

**A probe that goes red because a feature is switched off is a probe nobody
reads.** `props.mjs` skips when `CHUNK.trees` is off. Red should mean something
broke, not that somebody made a decision; after a week of the latter the genuine
failures are invisible too.

**A steady frame rate hides every frame-rate bug there is.** The car sprang
visibly backwards at speed, and 144, 60, 45, 30, 24 and 20 fps *all* measured
perfectly clean at a fixed frame time — because both faults were driven by
frame time CHANGING, not by its value. `smooth.mjs` scripts jitter and hitches
for that reason, and a version of it without them would have reported the broken
build as fine.

**Measure what is drawn, not what is simulated.** World-space render
interpolation was exact: the car advanced `speed * dt` to six decimal places
every frame at every frame rate, and `drive.mjs` and `handling.mjs` — which both
ask where the car *is* — saw nothing wrong. The whole fault was in where it was
drawn relative to the camera.

**Placement being right proves nothing about the look.** Every headless measure
of the ground cover passed — right count, right density, none on the road, all
of it on the drawn surface — while the grass rendered as a dark stripe along the
verge, because two ambient-occlusion terms multiplied to 11%. Numbers cannot see
that. `render.mjs` can.

**A headless screenshot is not the viewport you asked for.** Chrome's
`--window-size` is clamped to a 500 px minimum, so `--screenshot` on a 375 px
phone lays the page out at 500 and crops the image to 375 — which looks exactly
like a layout that overflows, and is not. `uishot.mjs` drives
`Emulation.setDeviceMetricsOverride` over the DevTools protocol instead, which
is the only way to get a real small viewport.

**`handling.mjs` used to charge the car for the test's own cornering.** The
slide-recovery test holds full opposite lock and half throttle for four seconds.
A car that recovers early then spends the rest of that time obeying the input
and driving a circle the other way, and the probe integrated heading straight
through it — so a tune that caught the slide in 0.82 s after 62° was reported as
"240 deg, WENT ROUND" *because it recovered in time to start turning*. Heading
is now integrated only until the yaw is arrested.

**An autopilot is a controller and can be unstable on its own.** A bare
proportional term on lateral position — worse, one with the sign inverted —
drove the test car off the road four times in 90 s and made the whole build look
broken. `drive.mjs` uses a heading term plus a speed-scaled cross-track term for
that reason.
