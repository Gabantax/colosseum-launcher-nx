'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const colors = require('../src/hero-colors');
const story = require('../src/hero-story');

test('every hero a game has is painted from the story\'s models of them', () => {
  for (const game of ['colosseum', 'xd']) for (const hero of colors.heroesFor(game)) {
    const models = story.STORY_MODELS[game][hero.id];
    assert.ok(models?.length, `${hero.id} has models in ${game}`);
    assert.ok(models.some(model => model.file === hero.battle.file), `${hero.id}'s battle model is one of them`);
  }
  assert.equal(story.STORY_MODELS.colosseum.michael, undefined);
});

test('only heroes with colours chosen, and in the game, are painted', () => {
  const looks = colors.normalizeLooks({ colors: { red: { vest: '#2f8a4a' }, michael: { jacket: '#b02a2a' } } });
  assert.deepEqual(story.paintedHeroes(looks, 'colosseum'), ['red']);
  assert.deepEqual(story.paintedHeroes(looks, 'xd'), ['red', 'michael']);
  assert.deepEqual(story.paintedHeroes(colors.normalizeLooks({}), 'xd'), []);
});

test('no colours chosen makes no folder, without reading the disc', () => {
  assert.equal(story.makeStoryPack('/no/such/disc.iso', 'colosseum', colors.normalizeLooks({}), '/no/such/folder'), null);
});
