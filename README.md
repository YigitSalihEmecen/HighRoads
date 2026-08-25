# HighRoads

An infinite procedural driving experience in the browser built with **Three.js**, **Rapier3D physics (WASM)**, and a physically modelled **engine and drivetrain simulator**.

No build step, no bundlers, no dependencies — pure modern ES modules running statically in the browser.

### 🎮 [Play HighRoads in your Browser](https://yigitsalihemecen.github.io/HighRoads/)

---

## ✨ Features & What's Implemented

- 🛣️ **Infinite Procedural World** — Seamless road and terrain generation in road space with cut-and-fill carving, dynamic tunnels, and 6 blended biomes (plains, hills, valleys, mountains, canyons, and plateaus) seeded from any string.
- 🏎️ **Raycast Vehicle Physics** — Rigid-body dynamics powered by Rapier3D (WebAssembly) with 4-wheel independent raycast suspension, Magic Formula tyre friction, anti-roll coupling, downforce, aerodynamic drag, and counter-steer assists.
- 🔊 **Physical Engine Simulation & Acoustics** — Directly bridged with [`Engine_Sim`](https://github.com/YigitSalihEmecen/Engine_Sim); the engine simulator *is* the actual drivetrain calculating propshaft torque, clutch slip, gearing, and procedural sound synthesis across 16 engine configurations.
- 🚘 **Vehicle Roster & Swaps** — 9 vehicle types (Sport, Muscle, Classic, Hatchback, Police, Pickup, Van, Military, Monster Truck) with custom paint swatches, engine swaps, and automatic/manual transmissions.
- 🌲 **Procedural Environment** — Multi-tier ground cover, rock scatter, and biome-aware foliage generation.
- 🚦 **Traffic & Game Modes** — Choose between a relaxing **Zen** cruise or high-stakes **Traffic** mode with near-miss scoring, multiplier chains, and impact physics.
- 📱 **Desktop & Mobile Optimized** — Responsive layouts supporting keyboard, gamepad, and touch controls with safe-area support for mobile portrait and landscape.
- 🌅 **Atmospheric Visuals** — Procedural sky with animated clouds, golden-hour lighting, exponential fog, bloom, and speed blur.

---

## 🕹️ Controls

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
| `R` | Respawn / Reset |
| `M` | Mute Audio |

*Also supports standard gamepads (left stick steering, triggers for throttle/brake) and touch controls on mobile.*

---

## 🚀 Running Locally

Because ES modules and WebAssembly require a standard HTTP origin, serve the folder with any static web server:

```bash
# Clone the repository with submodules
git clone --recurse-submodules https://github.com/YigitSalihEmecen/HighRoads.git
cd HighRoads

# Start a local static server (any of the following):
npx serve .
# or
python3 -m http.server 8080
```

Open `http://localhost:8080` in your browser.
