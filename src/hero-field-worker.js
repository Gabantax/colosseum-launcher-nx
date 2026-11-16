'use strict';
// Makes the five heroes' models for XD off the main thread, into `folder`, the game's COLO_HERO_FIELD
// (host/xd/player.c): <hero>.dat, the field model (hero-field.js buildFieldModel: each hero's battle model from XD's
// disc, with Michael's field clips moved onto it), and <hero>.pkx, the battle model with Michael's Snag Machine clips
// and Poké Ball throw (hero-snag.js buildSnagModel; a hero it can't be made for keeps the disc's, without them). Made
// once for a disc:
// made.json says for which. Answers { folder } or { error }.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
const { Disc } = require('./disc');
const fsys = require('./fsys');
const heroField = require('./hero-field');
const heroSnag = require('./hero-snag');
const colors = require('./hero-colors');

const MICHAEL_FIELD = 0x16c90400;   // rinto_0000 in people_archive.fsys

try {
  const { rom, root } = workerData;
  const disc = new Disc(rom);
  try {
    const heroes = colors.heroesFor('xd').filter(hero => hero.id !== 'michael');
    const files = new Map(heroes.map(hero => [hero.id, Buffer.from(fsys.entries(disc.file(hero.battle.file))[0].data())]));
    const michael = fsys.entries(disc.file('people_archive.fsys')).find(entry => entry.id === MICHAEL_FIELD);
    if (!michael) throw new Error('Michael\'s field model isn\'t on this disc.');
    const people = Buffer.from(michael.data()), snag = Buffer.from(fsys.entries(disc.file(heroSnag.MICHAEL_SNAG))[0].data());
    const throwXd = Buffer.from(fsys.entries(disc.file(heroSnag.MICHAEL_BATTLE))[0].data());
    const hash = crypto.createHash('sha256').update(`${heroField.VERSION}:${heroSnag.VERSION}`).update(people).update(snag).update(throwXd);
    for (const data of files.values()) hash.update(data);
    const key = hash.digest('hex').slice(0, 16), folder = path.join(root, key);
    if (!fs.existsSync(path.join(folder, 'made.json'))) {
      const temporary = `${folder}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      fs.mkdirSync(temporary, { recursive: true });
      const snags = [], failed = {};
      for (const [id, data] of files) {
        fs.writeFileSync(path.join(temporary, `${id}.dat`), heroField.buildFieldModel(data, people));
        try {
          fs.writeFileSync(path.join(temporary, `${id}.pkx`), heroSnag.buildSnagModel(data, snag, { throwXd, cameraScale: heroSnag.CAMERA_SCALE[id] }));
          snags.push(id);
        } catch (error) { failed[id] = String(error?.message || error); }
      }
      fs.writeFileSync(path.join(temporary, 'made.json'), JSON.stringify({ heroes: [...files.keys()], snags, failed }));
      fs.rmSync(folder, { recursive: true, force: true });
      fs.renameSync(temporary, folder);
      // only this disc's are kept
      for (const entry of fs.readdirSync(root)) if (entry !== key) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
    }
    parentPort.postMessage({ folder });
  } finally { disc.close(); }
} catch (error) {
  parentPort.postMessage({ error: String(error?.message || error) });
}
