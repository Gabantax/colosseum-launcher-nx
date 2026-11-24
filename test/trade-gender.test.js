'use strict';
// A Pokémon's gender is its personality's low byte against its species' gender ratio (pokemonGetSex). Every trade path
// must carry the personality as it is, and anything showing the gender must read the ratio of the right species.
const test = require('node:test');
const assert = require('node:assert/strict');
const convert = require('../src/trade-convert');
const { shadowFor } = require('../src/shadow-convert');
const { summary } = require('../src/online-trades');
const { mergeXdRecord } = require('../src/save-pokemon');
const { genderOf } = require('../src/team-sets');
const { defaultSpeciesInfo } = require('../src/save-pokemon-edit');
const story = require('../src/generations/shadow-story.json');

const units = text => [...text].map(c => c.charCodeAt(0)).concat(Array(11).fill(0)).slice(0, 11);
// A Pokémon in trade-convert.js's form (Colosseum's numbers)
function form(species, rnd, level = 30) {
  return { species, rnd, attest: [11, 3, 2, 2], metLocation: 0x8f, metLevel: level, ball: 4, otGender: 0, otId: 0x12345678,
    otName: units('WES'), nickname: units('MON'), nicknameOrg: units('MON'), exp: 27000, level, conditionAmari: 0,
    moves: [{ id: 33, pp: 35, ppUps: 0 }], item: 0, hp: 90, stats: [90, 60, 40, 30, 40, 30], evs: [0, 0, 0, 0, 0, 0],
    ivs: [30, 18, 17, 18, 16, 11], friendship: 70, contest: [0, 0, 0, 0, 0], ranks: [0, 0, 0, 0, 0], sheen: 0,
    ribbons: Array(12).fill(false), ribbonSpare: 0, pokerus: 0, abilitySlot: 0, flagAmari: 0, markings: 0, para1Amari: 0, amari: 0, event: false };
}
const ratio = species => defaultSpeciesInfo(species).gender;   // by Colosseum's numbers
const genderIn = (game, bytes) => {
  const p = convert.read(game, bytes);
  return genderOf(p.rnd >>> 0, ratio(p.species));
};
const anyReceiver = game => ({ game, laterPokemon: true, laterMoves: true, laterItems: true });
const other = game => (game === 'xd' ? 'colosseum' : 'xd');

// Makuhita (75% male: ratio 63), Bonsly (Colosseum 464, XD 413; 50%: 127), Eevee (12.5% female: 31): a personality
// whose low byte is just under the ratio is female, just over it male.
const CASES = [335, 464, 133].flatMap(species => [
  { species, rnd: (0xa1b2c300 | (ratio(species) - 1)) >>> 0, want: 'F' },
  { species, rnd: (0xa1b2c300 | ratio(species)) >>> 0, want: 'M' }
]);

test('the test\'s Pokémon are female and male as the game would make them', () => {
  for (const { species, rnd, want } of CASES) assert.equal(genderOf(rnd, ratio(species)), want, `${species} ${rnd.toString(16)}`);
});

test('Online Trades and trades between your games keep gender, either way between the games', () => {
  for (const from of ['colosseum', 'xd']) {
    for (const { species, rnd, want } of CASES) {
      const sent = convert.write(from, form(species, rnd));
      for (const to of [from, other(from)]) {
        const made = convert.convert(from, sent, anyReceiver(to));
        assert.deepEqual(made.problems, []);
        assert.equal(convert.read(to, made.bytes).rnd, rnd, `${from} -> ${to}: personality`);
        assert.equal(genderIn(to, made.bytes), want, `${from} -> ${to}: species ${species}`);
      }
    }
  }
});

test('Shadowtrade keeps gender in the Pokémon and in XD\'s Shadow record, either way between the games', () => {
  const xdRecord = (species, rnd, id) => {
    const r = Buffer.alloc(0x48);
    r.writeUInt32BE((3 << 29 | 1 << 15) >>> 0, 0); r.writeUInt16BE(convert.speciesFromColosseum('xd', species), 0x1a);
    r.writeUInt32BE(rnd, 0x1c); r.writeInt32BE(story.xd[id].gauge, 0x24); r.writeUInt16BE(id, 0x3e);
    return r;
  };
  for (const { species, rnd, want } of CASES) {
    // a Colosseum Shadow (story id 1) and an XD one (story id 15)
    const colo = convert.write('colosseum', form(species, rnd));
    colo.writeUInt16BE(1, 0xd8); colo.writeInt32BE(story.colosseum[1].gauge, 0xdc);
    const xd = convert.write('xd', form(species, rnd));
    xd.writeUInt16BE(15, 0xba);
    const sent = { colosseum: { data: colo }, xd: { data: xd, record: xdRecord(species, rnd, 15) } };
    for (const from of ['colosseum', 'xd']) {
      for (const to of [from, other(from)]) {
        const made = from === to ? { data: sent[from].data, record: sent[from].record || null } : shadowFor(from, sent[from], to, { laterPokemon: true });
        assert.equal(genderIn(to, made.data), want, `${from} -> ${to}: species ${species}`);
        if (to !== 'xd') continue;
        // the record XD's save keeps for it (the game's darkPokemonBiosGetRnd): the same personality, merged into B's
        const bRecord = Buffer.alloc(0x48);
        bRecord.writeUInt16BE(0x118, 0x1a);
        const merged = mergeXdRecord(bRecord, made.record, 0x54, { area: 'box', box: 0, slot: 0 }, 0);
        assert.equal(merged.readUInt32BE(0x1c), rnd, `${from} -> xd: record personality`);
      }
    }
  }
});

test('the trade window reads the gender ratio of the species itself in XD\'s numbers too', () => {
  // the battle data the trade window reads is by Colosseum's numbers: XD's Bonsly (413) is Colosseum's Turtwig there
  const table = { 413: { gender: ratio(413) }, 464: { gender: ratio(464) } };
  assert.notEqual(ratio(413), ratio(464), 'Turtwig and Bonsly have different gender ratios');
  const bonsly = CASES.filter(each => each.species === 464);
  for (const { rnd, want } of bonsly) {
    for (const from of ['colosseum', 'xd']) {
      const shown = summary(from, convert.write(from, form(464, rnd)), 'xd');
      assert.equal(shown.species, 413, 'XD\'s own number for Bonsly');
      assert.equal(shown.dataSpecies, 464, 'the battle data\'s number for it');
      assert.equal(genderOf(shown.personality >>> 0, table[shown.dataSpecies].gender), want);
    }
  }
});
