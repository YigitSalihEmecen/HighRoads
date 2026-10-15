/**
 * env/treegen.worker.js — TreeGen's geometry, off the main thread.
 *
 * Generates one tree, meshes every level (tree_gen/src/lod.js:buildLods) and
 * paints its card atlases on an OffscreenCanvas, then hands the buffers and
 * bitmaps back as transferables. Materials and the billboard bake need the
 * page's renderer and stay on the main thread (env/treegen.js).
 *
 * Module workers do not see the page's import map, so TreeGen is loaded
 * through a small loader: its relative imports become blob URLs of rewritten
 * sources, and its bare ones ('three', meshoptimizer) the URLs the page
 * resolved and sent in `init`.
 */
let api = null;
const blobs = new Map();
const FROM = /\bfrom\s*(['"])([^'"]+)\1/g;

function load(url, bare) {
  if (!blobs.has(url)) {
    blobs.set(url, (async () => {
      const src = await (await fetch(url)).text();
      const to = {};
      for (const [, , spec] of src.matchAll(FROM)) {
        if (spec in to) continue;
        to[spec] = bare[spec] || (spec.startsWith('.') ? await load(new URL(spec, url).href, bare) : spec);
      }
      const out = src.replace(FROM, (m, q, spec) => `from ${q}${to[spec]}${q}`);
      return URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
    })());
  }
  return blobs.get(url);
}

function pack(g, transfer) {
  if (!g) return null;
  const attrs = {};
  for (const [k, a] of Object.entries(g.attributes)) {
    attrs[k] = { array: a.array, itemSize: a.itemSize, normalized: a.normalized };
    transfer.add(a.array.buffer);
  }
  transfer.add(g.index.array.buffer);
  return { attrs, index: g.index.array };
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    const [tree, lod] = await Promise.all([
      import(await load(data.base + 'tree.js', data.bare)),
      import(await load(data.base + 'lod.js', data.bare)),
    ]);
    api = { tree, lod };
    self.postMessage({ type: 'ready' });
    return;
  }
  const { id, params, specs, detail, leaves, growth } = data;
  try {
    const tree = api.tree.generateTree(api.tree.mergeParams(params));
    const geos = api.lod.buildLods(tree, specs, { detail, leaves, growth });
    const transfer = new Set();
    const levels = [];
    for (const g of geos) {
      if (!g) { levels.push(null); continue; }
      let cards = null;
      if (g.cards) {
        const cv = new OffscreenCanvas(g.cards.size, g.cards.size);
        api.lod.paintCards(cv.getContext('2d'), g.cards);
        // Flipped, so row 0 is v = 0: an ImageBitmap ignores flipY on upload.
        // Premultiplied: see kit.js:cardMaterial.
        const image = await createImageBitmap(cv, { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply' });
        transfer.add(image);
        cards = { size: g.cards.size, image };
      }
      levels.push({
        bark: pack(g.bark, transfer), leaves: pack(g.leaves, transfer),
        moss: pack(g.moss, transfer), fungus: pack(g.fungus, transfer),
        counts: g.counts, cards,
      });
    }
    self.postMessage({ id, center: tree.bounds.center, levels }, [...transfer]);
  } catch (err) {
    self.postMessage({ id, error: String(err && err.stack || err) });
  }
};
