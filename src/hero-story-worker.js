'use strict';
// Makes the story's repainted hero textures off the main thread (hero-story.js makeStoryPack). Asked { rom, game, looks,
// root, folders }, answers { folder } (null when no hero has colours) or { error }.
const { parentPort, workerData } = require('node:worker_threads');
const heroStory = require('./hero-story');

try {
  const { rom, game, looks, root, folders } = workerData;
  parentPort.postMessage({ folder: heroStory.makeStoryPack(rom, game, looks, root, folders) });
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
}
