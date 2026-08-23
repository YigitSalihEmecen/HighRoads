/**
 * DOM wiring check.
 *
 * Nothing here renders, so a mistyped element id fails silently at runtime —
 * `getElementById` returns null and the feature simply does nothing. With no
 * browser to look at, this is the only thing standing between a typo and a dead
 * button. It reads index.html for the ids it defines and every module for the
 * ids they reach for, and compares the two.
 */
import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');
const defined = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const classes = new Set([...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
// Classes only ever created in JS still have to be styled to do anything.
const styled = new Set([...html.matchAll(/[.#]([A-Za-z][-\w]*)\s*[,{: ]/g)].map((m) => m[1]));

let bad = 0;
const wanted = new Map();

for (const file of fs.readdirSync('src')) {
  if (!file.endsWith('.js')) continue;
  const src = fs.readFileSync('src/' + file, 'utf8');
  for (const m of src.matchAll(/getElementById\(\s*'([^']+)'\s*\)/g)) {
    wanted.set(m[1], file);
  }
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*'#([-\w]+)([^']*)'\s*\)/g)) {
    wanted.set(m[1], file);
  }
}

for (const [id, file] of wanted) {
  if (!defined.has(id)) {
    console.log(`  MISSING  #${id}  — ${file} reads it, index.html does not define it`);
    bad++;
  }
}

// Class names the code toggles must exist in the stylesheet, or the toggle is
// a no-op that looks like it worked.
const toggled = new Set();
for (const file of fs.readdirSync('src')) {
  if (!file.endsWith('.js')) continue;
  const src = fs.readFileSync('src/' + file, 'utf8');
  for (const m of src.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([-\w]+)'/g)) toggled.add(m[1]);
}
for (const c of toggled) {
  if (!styled.has(c) && !classes.has(c)) {
    console.log(`  UNSTYLED .${c}  — toggled by a module but never styled`);
    bad++;
  }
}

console.log(`  [${bad ? 'FAIL' : ' ok '}] ${wanted.size} element ids and ${toggled.size} toggled classes checked` +
  (bad ? `  — ${bad} problem(s)` : ''));
process.exit(bad ? 1 : 0);
