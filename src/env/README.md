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
5. **Luminance in the texture, hue on the instance — for things that GROW.**
   Ground cover takes its colour from the terrain vertex it stands on, so it can
   never disagree with the ground. Two documented exceptions:
   * `rocks.js` takes its hue from `ROCKS.palette`. Stone does not
     photosynthesise, and sampling the verge gave every chip on the shoulder the
     grass's green, which reads as algae.
   * `trees.js` and `bushes.js` bake the hue into the geometry, one palette per
     variant, and take a near-1.0 *modulation* per instance instead. A per-face
     coloured solid has its colour in the mesh; blending it halfway toward the
     ground desaturated every palette to the same olive.

## What is here

| module | builds | tris/instance |
|---|---|---|
| `textures.js` | shared procedural canvas helpers — value noise, fBm, mottle | — |
| `lowpoly.js` | faceted-solid primitives: warped lumps, tapering tubes, conifer skirts | — |
| `grass.js` | crossed-card grass tufts, in a near and a far tier | 4 |
| `trees.js` | faceted low-poly trees, near and far tiers from one builder | 93–334 / **39–72** |
| `bushes.js` | four shrub forms, clusters of faceted lumps | 29–100 |
| `rocks.js` | convex boulders, slabs and scree, three size classes | 44–120 |
| `road.js` | the carriageway's asphalt mask and its material patch | — |
| `ground.js` | the terrain's detail texture and its material patch | — |

## The canopy

`trees.js` and `bushes.js` are **faceted solids** — the low-poly look in
`style_examples/`. A tree is a tapering faceted stem carrying either a cluster
of warped lumps or a stack of jagged conical skirts, flat-shaded, per-face
coloured, with no texture, no UVs and no alpha test anywhere in it.

* both tiers come from **one builder** at different subdivisions: near 93–334
  triangles, far 39–72, same envelope, same palette, same seed;
* `trees.js:matchWidth` squeezes the far tier sideways until its crown is the
  near tier's width to within 2%, so the cross-fade is a change of face count
  and nothing else;
* the two cross-fade by scale, in the shader, exactly as the two grass tiers do.

Measured: **419,000 triangles** of canopy and understorey alive at once against
109,000 for the terrain sheet, for 180 near trees and ~200 far ones per chunk.

### What this replaced, and why

Alpha-cutout leaf cards with a four-triangle painted billboard past 260 m. That
is the cheapest way to draw a volume of small leaves and it was right for a
naturalistic canopy. A faceted canopy has no small leaves, so a card buys
nothing and costs an atlas, an `alphaTest` + `DoubleSide` material, and — the
reason it had to go — **two different pictures of the same tree**, which
disagreed at the handover. The reported symptom was distant trees looking out of
place and shrinking as near ones grew.

### Load-bearing, and easy to undo by accident

1. **Interior culling.** `lowpoly.js:blob` drops any face whose centroid is
   inside another lump of the same crown. It is worth a third of the canopy. It
   reads the occluder's own warp function, so the occluder records must be the
   `{ c, r, warp }` plans the caller assembled — a shape mismatch here fails
   *silently*, culls nothing, and only shows up in the triangle count.
2. **Per-face, non-indexed, baked normals and colours.** `material.flatShading`
   is deliberately NOT set: it would recompute normals the geometry already has
   while leaving the colour smooth, and per-face colour is half the look.
3. **The near canopy has a SHORTER LIFETIME than its chunk.** A near tree is
   resolvable to 420 m and its chunk reaches 720 m. The recipe is cached on the
   chunk by `chunks.js:_buildProps` and `_updateCanopy` turns it into meshes as
   the car arrives — the same split the ground cover uses.
4. **Hue is BAKED, per variant, not per instance.** Rule 5 above still holds for
   the ground cover; it does not hold here. A per-instance blend toward the
   ground colour desaturated every palette to the same olive. `chunks.js` now
   applies a near-1.0 modulation instead (`TREES.groundTint`, `instanceVary`).

`probe/canopy.mjs` photographs the whole library — every species, every variant,
both tiers — which is the only check that can see any of this.
