# HighRoads

An infinite procedural driving experience in the browser built with **Three.js**, **Rapier3D physics (WASM)**, and a physically modelled **engine and drivetrain simulator**.

No build step, no bundlers, no dependencies — pure modern ES modules running statically in the browser.

### [Play HighRoads in your Browser](https://yigitsalihemecen.github.io/HighRoads/)

---

## Features & What's Implemented

- **Infinite Procedural World** — A routed road carved into a single cohesive height field (no holes, no seams), drawn by world-space LOD tiles out to 2.6 km, with six blended landforms seeded from any string.
- **Biomes & Water** — Ten ecological biomes (meadow, broadleaf, autumn, boreal, birchwood, savanna, mediterranean, alpine, wetland, blossom) laid out by climate and warped Voronoi cells, with soft borders; occasional lakes in natural basins with a Fresnel water shader, shore foam and beaches.
- **Raycast Vehicle Physics** — Rigid-body dynamics powered by Rapier3D (WebAssembly) with 4-wheel independent raycast suspension, Magic Formula tyre friction, anti-roll coupling, downforce, aerodynamic drag, and counter-steer assists.
- **Physical Engine Simulation & Acoustics** — Directly bridged with [`Engine_Sim`](https://github.com/YigitSalihEmecen/Engine_Sim); the engine simulator *is* the actual drivetrain calculating propshaft torque, clutch slip, gearing, and procedural sound synthesis across 16 engine configurations.
- **Generated Cars & Garage** — every car is built from numbers by [`Car-gen`](https://github.com/YigitSalihEmecen/Car-gen) (submodule). A 3D garage studio to generate cars by body style, mutate them, edit every generator parameter, paint, swap engines, drivetrain and gearbox, and save builds. Mass, grip, drag, CoM and suspension are derived from the generated shape.
- **Procedural Trees** — every tree is grown by [`Tree-Gen`](https://github.com/YigitSalihEmecen/Tree-Gen) (submodule): 16 species (pine, spruce, oak, beech, fir, larch, cypress, acacia, willow, cherry, olive…) as Weber & Penn parametric trees with real bark and leaves, generated on worker threads at boot and drawn at four levels of detail — simplified bark with polygon leaves, two leaf-card levels and a lit billboard — chosen per tree per frame. The old faceted low-poly canopy is still there: Settings › Graphics › Trees, or `?trees=legacy`.
- **Procedural Environment** — 10 shrubs from ferns to lavender and reeds, grown by Tree-Gen's bush generator as multi-stemmed clumps, four kinds of grass and flowers, and triplanar ground with macro variation and bump.
- **Living Traffic & Game Modes** — every traffic car is a different generated model. Drivers follow with the Intelligent Driver Model, slow for corners, keep right and overtake with indicators, pull over when flashed, and brake, flash and swerve when you come at them head-on. Choose a relaxing **Zen** cruise or **Traffic** mode with near-miss scoring and multiplier chains.
- **Desktop & Mobile Optimized** — Responsive layouts supporting keyboard, gamepad, and touch controls with safe-area support for mobile portrait and landscape.
- **Atmospheric Visuals** — Five sky presets (day, golden hour, dawn, overcast, and a full-moon night with stars), each setting light, fog, grade and water reflections.

---

## Controls

| Key | Action |
|---|---|
| `W` / `↑` | Throttle |
| `S` / `↓` | Brake / Reverse |
| `A` `D` / `←` `→` | Steer |
| `Space` | Handbrake |
| `E` / `Q` | Shift Up / Down |
| `G` | Toggle Auto / Manual Gearbox |
| `L` | Headlights |
| `F` *(hold)* | Flash Headlights (Traffic yields) |
| `C` | Cycle Camera (Chase / Close / Hood) |
| `K` | Cycle Sky (Day / Golden / Dawn / Overcast / Night) |
| `R` | Respawn / Reset |
| `M` | Mute Audio |
| `Esc` | Pause |

**Garage:** `G` generate · `M` mutate · `Z` undo · drag to orbit.

*Also supports standard gamepads (left stick steering, triggers for throttle/brake) and touch controls on mobile.*

---

## Running Locally

Because ES modules and WebAssembly require a standard HTTP origin, serve the folder with any static web server:

```bash
# Clone the repository with submodules (engine_sim, car_gen and tree_gen)
git clone --recurse-submodules https://github.com/YigitSalihEmecen/HighRoads.git
cd HighRoads

# Start a local static server (any of the following):
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser. Add `?sky=night` (or `golden`, `dawn`, `overcast`) to start under a different sky.
