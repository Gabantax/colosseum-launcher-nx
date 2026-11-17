// What the running game shows of a Pokémon that has just arrived from a trade (the game's "arrive" command, host/arrival.c):
// the P★DA-style notice, then the card with its stats, and what it looks like once it has evolved, as "show KEY VALUE"
// lines the game draws as they are. Pure: names and base stats come from `names`, so main.js gives it the Pokédex and the
// battle data, and the tests a few rows.
'use strict';

const teamSets = require('./team-sets');
const { NATURES, natureEffect } = teamSets;

const statsFor = (base, summary) => teamSets.stats(base, { nature: summary.nature, ivs: summary.ivs, evs: summary.evs, species: 0 }, summary.level);
const genderOf = (personality, ratio) => (ratio === undefined || ratio === null ? '-' : teamSets.genderOf(personality, ratio) || '-');

// A value as one line the game can read: no newlines, trimmed to a sensible length.
const clean = (value, max = 80) => String(value ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);

// summary: online-trades.js summary() of it, in this game's numbers. names: { species(id) -> { name, types, stats, gender,
// abilities }, move(id) -> { name, type, pp }, item(id) -> name }. Returns the lines (without a trailing newline).
function arrivalLines({ summary, names, kind = 'trade', from = '', evolvesInto = 0, placeHint = '', shadow = false }) {
  const species = names.species(summary.species) || {};
  const lines = [];
  const put = (key, value) => lines.push(`show ${key} ${clean(value)}`);
  const effect = natureEffect(summary.nature);
  put('kind', kind);
  put('from', from || (kind === 'shadowtrade' ? 'another player' : 'Trainer'));
  put('nickname', summary.nickname || species.name || `#${summary.species}`);
  put('species', species.name || `#${summary.species}`);
  put('level', summary.level);
  put('gender', genderOf(summary.personality >>> 0, species.gender));
  put('shiny', summary.shiny ? 1 : 0);
  if (shadow) put('shadow', 1);
  put('nature', NATURES[summary.nature] || '?');
  put('nature-effect', effect ? `${effect.up} ${effect.down}` : '0 0');
  const abilities = species.abilities || [];
  const ability = abilities.find(a => a.slot === summary.abilitySlot) || abilities[0];
  put('ability', ability?.name || '?');
  put('item', summary.heldKeyItem ? 'A key item' : summary.item ? (names.item(summary.item) || `Item #${summary.item}`) : 'Nothing');
  put('types', (species.types || []).join(' '));
  put('hp', summary.hp);
  put('stats', summary.stats.join(' '));
  put('ivs', summary.ivs.join(' '));
  put('evs', summary.evs.join(' '));
  put('ot', `${summary.otName || '?'} ${String(summary.otId).padStart(5, '0')}`);
  for (const move of summary.moves.slice(0, 4)) {
    const info = names.move(move.id) || {};
    const most = info.pp ? Math.floor(info.pp * (5 + move.ppUps) / 5) : move.pp;
    lines.push(`show move ${clean(info.name || `Move #${move.id}`, 24)}|${clean(info.type || 'Normal', 12)}|${move.pp}|${most}`);
  }
  if (placeHint) put('place', placeHint);
  if (evolvesInto) {
    const into = names.species(evolvesInto) || {};
    put('evolved-species', into.name || `#${evolvesInto}`);
    put('evolved-types', (into.types || species.types || []).join(' '));
    if (into.stats?.length === 6) {
      const stats = statsFor(into.stats, summary);
      put('evolved-stats', stats.join(' '));
      put('evolved-hp', Math.max(1, Math.min(stats[0], summary.hp + stats[0] - summary.stats[0])));
    }
    const intoAbilities = into.abilities || [];
    const intoAbility = intoAbilities.find(a => a.slot === summary.abilitySlot) || intoAbilities[0];
    if (intoAbility) put('evolved-ability', intoAbility.name);
  }
  return lines;
}

module.exports = { arrivalLines, statsFor, natureEffect, genderOf, NATURES };
