# `src/env/` — procedural environment assets

Everything the world is dressed with is **generated from code at boot**. There
are no meshes, no textures and no material files in this directory, and that is
the point: an asset that is generated is an asset that can be re-tuned by
changing a number, seeded so that two players see the same world, and shipped
for free.

## The contract

A generator module exports **one factory** that takes options and returns a
bundle. It owns *what a thing is*; it does not own *where the things go*.

```js
export function createXAssets({ anisotropy, quality } = {}) {
  return {
    geometry,        // or `geometries`, or `variants` — shared, built once
    material,        // shared, built once
    setTime?(t),     // if anything in it animates
    dispose(),       // releases every GPU resource the factory made
  };
}
```

Placement lives in `chunks.js`, because placement is the only part that needs
the road, the terrain sheet and the streaming window. This is the same split
`foliage.js` has always used, and it is what keeps a generator testable without
a world: `probe/grass.mjs` exercises the whole scatter with no canvas and no GL.

## Rules that have already cost time

1. **Everything is deterministic.** Generators seed their own PRNG from a
   constant, not from `Math.random`, so the same card, the same boulder and the
   same texture come back every session. Anything that varies per world takes
   the seed as an argument.
2. **Return something usable with no canvas.** The headless probes run the real
   placement path in Node. `document.createElement('canvas')` is stubbed there
   and `getContext` returns null, so a texture builder must return `null` rather
   than throw, and everything downstream must treat a missing map as
   "untextured" rather than as an error.
3. **Share the geometry and the material.** One `InstancedMesh` per chunk per
   asset type pointing at module-level singletons. A generator that hands out a
   fresh material per call is a generator that costs a draw call per call.
4. **Count the triangles before the polish.** The Quaternius tree pack was
   1,030,000 triangles for 468 instances — 90% of the geometry on screen for
   10 trees a hectare. Every module here states its per-instance triangle count
   in its header, so the budget is visible where the decision is made.
5. **Luminance in the texture, hue on the instance.** Ground cover takes its
   colour from the terrain vertex it stands on, so it can never disagree with
   the ground. Baking a green into a texture means maintaining that agreement by
   hand.

## What is here

| module | builds | tris/instance |
|---|---|---|
| `textures.js` | shared procedural canvas helpers — value noise, fBm, mottle | — |
| `grass.js` | crossed-card grass tufts, in a near and a far tier | 4 |
| `rocks.js` | convex boulders, slabs and scree, three size classes | 44–120 |
| `ground.js` | the terrain's detail texture and its material patch | — |

## What is not here yet

`trees.js` and `bushes.js`. The tree scatter, its species table and its ecology
rules are all intact in `foliage.js` and `chunks.js`; what is switched off is
the *models*, because the ones available are solid meshes at 1,700–2,900
triangles each. A procedural canopy belongs here, built as a trunk plus a small
number of billboard-shell layers with a level of detail worth spending the
budget on. `CHUNK.trees` is the switch, and nothing about the scatter has to
change when it flips.
