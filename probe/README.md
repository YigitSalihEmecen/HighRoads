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
| `tunnel.mjs` | Is anything standing in the carriageway, or missing from under it? Casts down the drivable width along the whole route. Exits non-zero on any step over 30 cm or any hole. |
| `roof.mjs` | Is the rock over a bore unbroken, and is the mouth actually open? Counts vertices cut in the sealed middle (must be 0) and left standing in the portal (must be 0). |
| `traffic.mjs` | Do cars appear in view, stop dead, or overlap? Drives a synthetic player for several minutes and reports spawn distance, stalls, overlaps, lane error, population and impact Δv. |
| `terrain.mjs` | How faceted is the ground? Angle between adjacent face normals, by distance band. |
| `props.mjs` | Do trees sit on the ground, and does the per-chunk budget hold? Rays against the real collider. |
| `skyleak.mjs` | Can you see daylight from inside a bore? Rays fired up and outward against terrain *and* the tunnel shell. |
| `cliff.mjs` | Longitudinal steps in the terrain sheet, portal faces counted separately from everything else. |
| `handling.mjs` | Usable steering angle by speed, whether a slide can be caught, whether a drift can be held, and rollover safety for the tall vehicles. |
| `marks.mjs` | Is any stretch of deep rock missing its bore? Diagnostic for the tunnel marking. |
| `xsec.mjs` | Prints terrain cross-sections through a tunnel — the fastest way to see what the ground is actually doing. |
| `tunmesh.mjs` | Coincident faces (z-fighting) and portal rings emitted where a bore was merely clipped by a chunk boundary. |
| `score.mjs` | The near-miss mechanic: reward curve, oncoming bonus, chain build and decay, cooldown. |
| `ui.mjs` | Every DOM id a module reads exists in `index.html`, and every class it toggles is actually styled. With no browser, this is what stands between a typo and a dead button. |
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

**An autopilot is a controller and can be unstable on its own.** A bare
proportional term on lateral position — worse, one with the sign inverted —
drove the test car off the road four times in 90 s and made the whole build look
broken. `drive.mjs` uses a heading term plus a speed-scaled cross-track term for
that reason.
