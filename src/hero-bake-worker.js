'use strict';
// Makes an online battle's players' looks off the main thread (hero-bake.js: repainting a hero with the HD pack's images
// takes a second or two). Asked { rom, folder, folders, looks: [look or null, ...] }, answers { made: [{ file, hd } or
// null, ...] } in the same order, or { error }. One look the same as another is made once.
const { parentPort, workerData } = require('node:worker_threads');
const heroBake = require('./hero-bake');
const { readFile } = require('./hero-look');
const colors = require('./hero-colors');
const texturePackLookup = require('./texture-pack-lookup');

try {
  const { rom, folder, folders, looks } = workerData;
  const index = folders?.length ? texturePackLookup.indexFolders(folders) : null, files = new Map(), made = new Map();
  const result = looks.map(look => {
    if (!look) return null;
    const key = JSON.stringify(look);
    if (!made.has(key)) {
      const hero = colors.hero(look.hero);
      if (!files.has(hero.id)) files.set(hero.id, readFile(rom, hero.label, hero.battle));
      made.set(key, heroBake.makeLook(folder, look, files.get(hero.id), index));
    }
    return made.get(key);
  });
  parentPort.postMessage({ made: result });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
}
