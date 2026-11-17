// The Pokémon page: the party and PC boxes of the chosen game's save, from the card, or live from the game while it
// runs (main.js pokemonPage). A Shadow Pokémon can go to Shadowtrade from here: it leaves the save and another
// player's Shadow Pokémon comes back (src/shadowtrade.js). The Online Trade panel is the trade window
// (src/online-trades.js): a trade code made or joined, each player's offer picked from this grid, and Ready.

const $ = id => document.getElementById(id);
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let data = null, tab = 'party', box = 0, selected = null, visible = false, loading = null, dex = null, dexFor = null, waitingGame = false;
let tradeView = null, names = null, tradeHistorySeen = null;
const NATURES = ['Hardy', 'Lonely', 'Brave', 'Adamant', 'Naughty', 'Bold', 'Docile', 'Relaxed', 'Impish', 'Lax', 'Timid', 'Hasty', 'Serious',
  'Jolly', 'Naive', 'Modest', 'Mild', 'Quiet', 'Bashful', 'Rash', 'Calm', 'Gentle', 'Sassy', 'Careful', 'Quirky'];
const TRADE_STAGE = {
  taking: 'Your Pokémon is leaving your save…', taken: 'Sent: waiting for the other player\'s Pokémon',
  received: 'Arrived: going into your save', giving: 'Going into your save…', given: 'In your save', evolving: 'Evolving…'
};
const STAGE = {
  taking: 'Leaving your save…', taken: 'Waiting to reach the Shadowtrade server', waiting: 'In the pool: a Shadow Pokémon comes back when another player trades one your save can take',
  received: 'Received: going into your save', giving: 'Going into your save…', given: 'In your save'
};

// The Pokédex's names and sprites, by the game's species number, read once for each game (null: none, the page shows numbers).
async function species(game) {
  if (dexFor === game) return dex;
  dexFor = game;
  try {
    const list = await window.colo.pokedex();
    dex = new Map(list.species.map(entry => [entry.id, entry]));
  } catch (_) { dex = null; }
  return dex;
}

const speciesName = pokemon => dex?.get(pokemon.species)?.name || `Pokémon #${pokemon.species}`;
const shown = pokemon => (pokemon.nickname && pokemon.nickname !== speciesName(pokemon).toUpperCase() ? pokemon.nickname : speciesName(pokemon));

function sprite(pokemon, size) {
  const entry = dex?.get(pokemon.species);
  if (entry?.sprite) return Object.assign(document.createElement('img'), { src: entry.sprite, alt: '', width: size, height: size, loading: 'lazy' });
  return Object.assign(document.createElement('span'), { className: 'pokedex-no-sprite', textContent: '?' });
}

function slots() {
  if (!data?.model) return [];
  return tab === 'party' ? data.model.party : data.model.boxes[box]?.pokemon || [];
}

function renderGrid() {
  const grid = $('pokemon-grid');
  grid.replaceChildren();
  grid.classList.toggle('party', tab === 'party');
  const list = slots();
  list.forEach((pokemon, slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pokemon-slot';
    button.setAttribute('role', 'option');
    if (!pokemon) {
      button.classList.add('empty');
      button.disabled = true;
      button.setAttribute('aria-label', 'Empty');
      grid.append(button);
      return;
    }
    const isSelected = selected && selected.area === pokemon.area && selected.box === pokemon.box && selected.slot === pokemon.slot;
    button.classList.toggle('selected', Boolean(isSelected));
    button.classList.toggle('shadow', pokemon.shadow);
    button.setAttribute('aria-selected', String(Boolean(isSelected)));
    button.title = `${shown(pokemon)}, level ${pokemon.level}${pokemon.shadow ? ', Shadow Pokémon' : ''}${pokemon.traded ? ', from Shadowtrade' : ''}`;
    button.append(sprite(pokemon, tab === 'party' ? 56 : 44));
    const label = document.createElement('span');
    label.className = 'pokemon-slot-label';
    label.append(Object.assign(document.createElement('strong'), { textContent: shown(pokemon) }),
      Object.assign(document.createElement('small'), { textContent: pokemon.egg ? 'Egg' : `Lv. ${pokemon.level}` }));
    button.append(label);
    if (pokemon.shadow) button.append(Object.assign(document.createElement('span'), { className: 'pokemon-shadow-mark', textContent: 'Shadow' }));
    if (pokemon.shiny) button.append(Object.assign(document.createElement('span'), { className: 'pokemon-shiny-mark', textContent: '★', title: 'Shiny' }));
    button.addEventListener('click', () => { selected = { area: pokemon.area, box: pokemon.box, slot: pokemon.slot }; renderGrid(); renderDetail(); });
    grid.append(button);
  });
  const count = list.filter(Boolean).length;
  $('pokemon-empty').hidden = Boolean(count) || !data?.model;
  $('pokemon-empty').textContent = tab === 'party' ? 'Your party is empty.' : 'This box is empty.';
}

function current() {
  if (!selected || !data?.model) return null;
  const list = selected.area === 'party' ? data.model.party : data.model.boxes[selected.box]?.pokemon;
  return list?.[selected.slot] || null;
}

function renderDetail() {
  const pokemon = current();
  $('pokemon-detail').hidden = !pokemon;
  renderOfferButton(pokemon);
  if (!pokemon) return;
  $('pokemon-detail-sprite').replaceChildren(sprite(pokemon, 96));
  $('pokemon-detail-name').textContent = shown(pokemon);
  const where = pokemon.area === 'party' ? `Party, slot ${pokemon.slot + 1}` : `${data.model.boxes[pokemon.box].name}, slot ${pokemon.slot + 1}`;
  $('pokemon-detail-meta').textContent = `${speciesName(pokemon)} · Lv. ${pokemon.level} · ${where}`;
  const badges = $('pokemon-detail-badges');
  badges.replaceChildren();
  if (pokemon.shadow) badges.append(Object.assign(document.createElement('span'), { className: 'badge shadow-badge', textContent: 'Shadow Pokémon' }));
  if (pokemon.shiny) badges.append(Object.assign(document.createElement('span'), { className: 'badge warn', textContent: 'Shiny' }));
  if (pokemon.traded) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'From Shadowtrade', title: 'It has a Shadow of its own in your save, apart from the story\'s' }));
  if (pokemon.egg) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: 'Egg' }));
  if (!pokemon.egg) badges.append(Object.assign(document.createElement('span'), { className: 'badge', textContent: `HP ${pokemon.hp}/${pokemon.maxHp}` }));
  const heart = $('pokemon-heart');
  heart.hidden = !pokemon.shadow || pokemon.heartPercent === undefined;
  if (!heart.hidden) {
    $('pokemon-heart-fill').style.width = `${pokemon.heartPercent}%`;
    $('pokemon-heart-text').textContent = pokemon.heartPercent ? `Heart gauge ${pokemon.heartPercent}% closed` : 'Its heart is open: ready to purify';
  }
  const problem = pokemon.tradeProblem || (!data.canTrade ? data.notice || 'Trading isn\'t possible right now.' : null);
  $('pokemon-trade').hidden = !pokemon.shadow;
  $('pokemon-trade').disabled = Boolean(problem) || Boolean(data.trades?.busy);
  $('pokemon-trade-note').textContent = pokemon.shadow ? (problem || 'It leaves your save, and a Shadow Pokémon another player sent comes back.') : 'Only Shadow Pokémon can go to Shadowtrade.';
}

function describeTrade(trade) {
  const row = document.createElement('div');
  row.className = 'shadowtrade-row';
  const text = document.createElement('div');
  const sent = `${trade.sent.nickname || `#${trade.sent.species}`} (Lv. ${trade.sent.level})`;
  text.append(Object.assign(document.createElement('strong'), { textContent: trade.received?.returned ? `${sent} is coming back` : `Sent ${sent}` }));
  let line = STAGE[trade.stage] || trade.stage;
  if (trade.received && !trade.received.returned) line = `${STAGE[trade.stage]}: ${trade.received.nickname || `#${trade.received.species}`} from ${trade.received.from || 'another player'}`;
  if (trade.message) line = trade.message;
  if (waitingGame && ['taking', 'giving'].includes(trade.stage)) line = 'Waiting for the game: walk around in the field, outside menus and battles.';
  text.append(Object.assign(document.createElement('small'), { textContent: line }));
  row.append(text);
  if (['taken', 'waiting'].includes(trade.stage)) {
    const cancel = Object.assign(document.createElement('button'), { className: 'subtle', type: 'button', textContent: 'Cancel', title: 'Take it back out of the pool, if no one has it yet' });
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try { await window.colo.shadowtradeCancel(trade.tradeId); setStatus(''); } catch (error) { setStatus(message(error)); }
      refresh();
    });
    row.append(cancel);
  }
  return row;
}

function renderTrades() {
  const view = data?.trades || { trades: [], history: [] };
  const list = $('shadowtrade-trades');
  list.replaceChildren(...view.trades.filter(trade => trade.game === data.game).map(describeTrade));
  $('shadowtrade-none').hidden = view.trades.some(trade => trade.game === data.game);
  const history = $('shadowtrade-history');
  const mine = view.history.filter(item => item.game === data.game).slice(0, 8);
  history.replaceChildren(...mine.map(item => {
    const li = document.createElement('li');
    li.textContent = item.returned ? `${item.sent.nickname} came back to you` : `${item.sent.nickname} for ${item.received.nickname} (Lv. ${item.received.level}) from ${item.from || 'another player'}`;
    return li;
  }));
  $('shadowtrade-history-title').hidden = !mine.length;
}

function renderBoxes() {
  const select = $('pokemon-box');
  const boxes = data?.model?.boxes || [];
  if (box >= boxes.length) box = 0;
  select.replaceChildren(...boxes.map((each, i) => Object.assign(document.createElement('option'), { value: String(i),
    textContent: `${each.name} (${each.pokemon.filter(Boolean).length}/${each.pokemon.length})` })));
  select.value = String(box);
  $('pokemon-box-bar').hidden = tab !== 'boxes' || !boxes.length;
}

function setStatus(text) {
  $('pokemon-status').textContent = text;
  $('pokemon-status').hidden = !text;
}

function render() {
  const model = data?.model;
  const gameName = data?.game === 'xd' ? 'XD' : 'Colosseum';
  $('pokemon-summary').textContent = model ? `${model.trainer || 'Your'}'s party and PC boxes, in your ${gameName} save.` : `No ${gameName} save yet: play and save, and your Pokémon show here.`;
  $('pokemon-source').hidden = !data?.source;
  $('pokemon-source').textContent = data?.source === 'live' ? 'Live from the game' : 'From your save';
  $('pokemon-source').classList.toggle('good', data?.source === 'live');
  $('pokemon-notice').hidden = !data?.notice;
  $('pokemon-notice').textContent = data?.notice || '';
  for (const name of ['party', 'boxes']) $(`pokemon-tab-${name}`).setAttribute('aria-selected', String(tab === name));
  renderBoxes();
  if (selected && !current()) selected = null;
  renderGrid();
  renderDetail();
  renderTrades();
  if (tradeView) renderTradePanel();
}

async function refresh() {
  if (loading) return loading;
  loading = (async () => {
    try {
      const next = await window.colo.pokemonPage();
      await species(next.game);
      if (next.game !== data?.game) { selected = null; box = 0; }
      data = next;
      render();
    } catch (error) { setStatus(message(error)); } finally { loading = null; }
  })();
  return loading;
}

async function trade() {
  const pokemon = current();
  if (!pokemon) return;
  $('shadowtrade-confirm-name').textContent = shown(pokemon);
  $('shadowtrade-confirm-sprite').replaceChildren(sprite(pokemon, 72));
  $('shadowtrade-confirm-live').hidden = data.source !== 'live';
  $('shadowtrade-confirm').showModal();
}

async function confirmTrade() {
  const pokemon = current();
  $('shadowtrade-confirm').close();
  if (!pokemon) return;
  $('pokemon-trade').disabled = true;
  setStatus(data.source === 'live' ? `Sending ${shown(pokemon)}: the game saves once it's out of your save…` : `Sending ${shown(pokemon)}…`);
  try {
    const view = await window.colo.shadowtradeOffer({ area: pokemon.area, box: pokemon.box, slot: pokemon.slot });
    const done = view.history.find(item => item.sent.nickname === pokemon.nickname && Date.now() - item.at < 60000);
    setStatus(done ? `Traded! ${done.received.nickname} from ${done.from || 'another player'} is in your save.` : `${shown(pokemon)} is in the Shadowtrade pool. A Shadow Pokémon comes back when another player trades.`);
    selected = null;
  } catch (error) { setStatus(message(error)); }
  waitingGame = false;
  await refresh();
}

// ---- Online Trade: the trade window ----

// Move and item names (the team builder's), read once; numbers when the game data isn't there.
async function tradeNames() {
  if (names) return names;
  names = { moves: new Map(), items: new Map(), moveData: new Map(), itemData: new Map(), species: {} };
  try {
    const battle = await window.colo.battleData();
    for (const move of battle.moves || []) { names.moves.set(move.id, move.name); names.moveData.set(move.id, move); }
    for (const item of battle.items || []) { names.items.set(item.id, item.name); names.itemData.set(item.id, item); }
    for (const each of Object.values(battle.generations || {})) {
      for (const item of each.items || []) if (!names.items.has(item.id)) { names.items.set(item.id, item.name); names.itemData.set(item.id, item); }
      for (const move of each.moves || []) if (!names.moves.has(move.id)) { names.moves.set(move.id, move.name); names.moveData.set(move.id, move); }
      Object.assign(names.species, Object.fromEntries(Object.entries(each.species || {}).filter(([id]) => !battle.species?.[id])));
    }
    Object.assign(names.species, battle.species || {});
  } catch (_) { /* numbers */ }
  return names;
}

function offerProblem(pokemon) {
  if (pokemon.egg) return 'Eggs can\'t be traded.';
  if (pokemon.shadow) return 'Purify it first: Shadow Pokémon go to Shadowtrade instead.';
  if (pokemon.area === 'party' && !data.model.party.some(each => each && each.key !== pokemon.key && !each.egg && each.hp > 0))
    return 'You can\'t trade your last Pokémon that can battle.';
  return null;
}

function renderOfferButton(pokemon) {
  const button = $('pokemon-offer'), room = tradeView?.room;
  button.hidden = !room || !pokemon;
  if (button.hidden) return;
  const busy = Boolean(room.trade), problem = offerProblem(pokemon);
  const offered = room.you?.offer?.place;
  const same = offered && offered.area === pokemon.area && offered.box === pokemon.box && offered.slot === pokemon.slot;
  button.disabled = busy || Boolean(problem) || same;
  button.textContent = same ? 'Offered for trade' : 'Offer for trade';
  if (!pokemon.shadow) $('pokemon-trade-note').textContent = problem || (same ? 'The other player sees it in the trade window.' : busy ? 'A trade is under way.' : 'Offer it to the other player in the trade window.');
}

// A Pokémon's card in the trade window: what the other player sees of it, and you of theirs.
function tradeCard(summary, { problems = [], evolvesInto = 0, empty = '' } = {}) {
  const card = document.createElement('div');
  if (!summary) { card.className = 'trade-card-empty helper'; card.textContent = empty; return card; }
  card.className = 'trade-card-body';
  const head = document.createElement('div');
  head.className = 'trade-card-head';
  head.append(sprite(summary, 48));
  const title = document.createElement('div');
  title.append(Object.assign(document.createElement('strong'), { textContent: `${shown(summary)}${summary.shiny ? ' ★' : ''}` }),
    Object.assign(document.createElement('small'), { textContent: `${speciesName(summary)} · Lv. ${summary.level} · ${NATURES[summary.nature] || ''}` }),
    Object.assign(document.createElement('small'), { textContent: `OT ${summary.otName || '?'} (${String(summary.otId).padStart(5, '0')})${summary.game ? ` · from ${summary.game === 'xd' ? 'XD' : 'Colosseum'}` : ''}` }));
  head.append(title);
  card.append(head);
  const item = summary.item ? (names?.items.get(summary.item) || `Item #${summary.item}`) : 'Nothing';
  card.append(Object.assign(document.createElement('small'), { className: 'trade-card-line', textContent: `Holds: ${item}` }));
  const moves = summary.moves.map(move => names?.moves.get(move.id) || `Move #${move.id}`).join(', ');
  card.append(Object.assign(document.createElement('small'), { className: 'trade-card-line', textContent: `Moves: ${moves || 'none'}` }));
  const ts = TS(), species = names?.species?.[summary.species];
  const abilities = species?.abilities || [], ability = abilities.find(a => a.slot === summary.abilitySlot) || abilities[0];
  const line = text => card.append(Object.assign(document.createElement('small'), { className: 'trade-card-line', textContent: text }));
  line(`${ts ? ts.natureLabel(summary.nature) : ''}${ability ? ` · ${ability.name}` : ''}`);
  const short = ['HP', 'Atk', 'Def', 'SpA', 'SpD', 'Spe'];
  line(`Stats ${short.map((name, i) => `${name} ${i === 0 ? `${summary.hp}/${summary.stats[0]}` : summary.stats[i]}`).join(' · ')}`);
  line(`IVs ${summary.ivs.join('/')} · EVs ${summary.evs.join('/')}`);
  const ribbons = summary.ribbons.filter(Boolean).length;
  if (ribbons) line(`${ribbons} ribbon${ribbons > 1 ? 's' : ''}`);
  card.append(Object.assign(document.createElement('span'), { className: 'trade-card-more', textContent: 'Every stat ›' }));
  if (evolvesInto) card.append(Object.assign(document.createElement('p'), { className: 'trade-evolves', textContent: `Evolves into ${dex?.get(evolvesInto)?.name || `#${evolvesInto}`} when it arrives.` }));
  for (const problem of problems) card.append(Object.assign(document.createElement('p'), { className: 'trade-problem', textContent: problem.text || problem }));
  card.classList.add('trade-card-open');
  card.title = 'Every stat';
  card.tabIndex = 0;
  card.addEventListener('click', openStats);
  card.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openStats(); } });
  return card;
}

// ---- every stat: the two offers side by side (the trade window's Compare every stat) ----
const TS = () => window.coloTeamSets;
const BALLS = ['', 'Master Ball', 'Ultra Ball', 'Great Ball', 'Poké Ball', 'Safari Ball', 'Net Ball', 'Dive Ball', 'Nest Ball', 'Repeat Ball', 'Timer Ball', 'Luxury Ball', 'Premier Ball'];
const RIBBONS = ['Champion', 'Winning', 'Victory', 'Artist', 'Effort', 'Marine', 'Land', 'Sky', 'Country', 'National', 'Earth', 'World'];
const CONTEST = ['Cool', 'Beauty', 'Cute', 'Smart', 'Tough'];
const RANKS = ['', 'Normal', 'Super', 'Hyper', 'Master'];
const ORIGINS = { 1: 'FireRed', 2: 'LeafGreen', 8: 'Sapphire', 9: 'Ruby', 10: 'Emerald', 11: 'Colosseum or XD' };
const LANGUAGES = { 1: 'Japanese', 2: 'English', 3: 'German', 4: 'French', 5: 'Italian', 6: 'Spanish' };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child !== null && child !== undefined) node.append(child);
  return node;
}

function statSheet(summary, heading, { problems = [], evolvesInto = 0 } = {}) {
  const sheet = el('section', { className: 'trade-sheet' }, el('h2', { textContent: heading }));
  if (!summary) { sheet.append(el('p', { className: 'helper', textContent: 'No Pokémon offered yet.' })); return sheet; }
  const ts = TS(), species = names?.species?.[summary.species] || null, entry = dex?.get(summary.species);
  const gender = ts && species ? ts.genderOf(summary.personality >>> 0, species.gender) : '';
  const abilities = species?.abilities || [];
  const ability = abilities.find(a => a.slot === summary.abilitySlot) || abilities[0] || null;
  const effect = ts?.natureEffect(summary.nature);
  const head = el('div', { className: 'trade-sheet-head' }, sprite(summary, 72),
    el('div', {}, el('strong', { textContent: `${shown(summary)}${gender === 'M' ? ' ♂' : gender === 'F' ? ' ♀' : ''}${summary.shiny ? ' ★' : ''}` }),
      el('small', { textContent: `${speciesName(summary)} · Lv. ${summary.level}${entry?.types?.length ? ` · ${entry.types.join('/')}` : ''}` }),
      el('small', { textContent: `From ${summary.game === 'xd' ? 'XD' : 'Colosseum'}${summary.shiny ? ' · Shiny' : ''}` })));
  sheet.append(head);
  // the six stats: value, base, IV, EV, and the nature's tenth up or down
  const base = entry?.stats || [];
  const table = el('table', { className: 'trade-sheet-stats' });
  table.append(el('thead', {}, el('tr', {}, ...['Stat', 'Value', 'Base', 'IV', 'EV'].map(text => el('th', { textContent: text })))));
  const body = el('tbody');
  (ts?.STAT_NAMES || ['HP', 'Attack', 'Defense', 'Sp. Atk', 'Sp. Def', 'Speed']).forEach((statName, i) => {
    const mark = effect?.up === i ? ' ↑' : effect?.down === i ? ' ↓' : '';
    body.append(el('tr', { className: effect?.up === i ? 'up' : effect?.down === i ? 'down' : '' },
      el('th', { textContent: statName + mark }), el('td', { textContent: i === 0 ? `${summary.hp}/${summary.stats[0]}` : String(summary.stats[i]) }),
      el('td', { textContent: base[i] ?? '?' }), el('td', { textContent: String(summary.ivs[i]) }), el('td', { textContent: String(summary.evs[i]) })));
  });
  const sum = list => list.reduce((a, v) => a + (Number(v) || 0), 0);
  body.append(el('tr', { className: 'total' }, el('th', { textContent: 'Total' }), el('td', { textContent: String(sum(summary.stats)) }),
    el('td', { textContent: base.length ? String(sum(base)) : '?' }), el('td', { textContent: `${sum(summary.ivs)}/186` }), el('td', { textContent: `${sum(summary.evs)}/510` })));
  table.append(body);
  sheet.append(table);
  // moves
  const moves = el('table', { className: 'trade-sheet-moves' });
  moves.append(el('thead', {}, el('tr', {}, ...['Move', 'Type', 'Kind', 'Power', 'Acc.', 'PP', 'PP Ups'].map(text => el('th', { textContent: text })))));
  const moveBody = el('tbody');
  for (const move of summary.moves) {
    const data = names?.moveData.get(move.id);
    const most = data?.pp ? Math.floor(data.pp * (5 + move.ppUps) / 5) : null;
    moveBody.append(el('tr', {}, el('th', { textContent: data?.name || `Move #${move.id}` }), el('td', { textContent: data?.type || '?' }),
      el('td', { textContent: data?.category || '' }), el('td', { textContent: data?.power ? String(data.power) : '—' }),
      el('td', { textContent: data?.accuracy ? String(data.accuracy) : '—' }), el('td', { textContent: most !== null ? `${move.pp}/${most}` : String(move.pp) }),
      el('td', { textContent: String(move.ppUps) })));
  }
  moves.append(moveBody);
  sheet.append(moves);
  // everything else it has
  const hidden = ts?.hiddenPower(summary.ivs);
  const item = summary.heldKeyItem ? 'A key item (it can\'t travel)' : summary.item ? (names?.items.get(summary.item) || `Item #${summary.item}`) : 'Nothing';
  const pokerus = !summary.pokerus ? 'Never had it' : summary.pokerus & 0xf ? 'Has Pokérus' : 'Cured of Pokérus';
  const marks = ['●', '■', '▲', '♥'].filter((_, i) => summary.markings & (1 << i)).join(' ') || 'None';
  const facts = [
    ['Nature', ts ? ts.natureLabel(summary.nature) : String(summary.nature)],
    ['Ability', ability ? ability.name : '?', ability?.doc],
    ['Held item', item, summary.item ? names?.itemData.get(summary.item)?.doc : null],
    ['Hidden Power', hidden ? `${hidden.type}, power ${hidden.power}` : '?'],
    ['Friendship', `${summary.friendship}/255`],
    ['Experience', `${summary.exp.toLocaleString()} points`],
    ['Pokérus', pokerus],
    ['Ball', BALLS[summary.ball] || `Ball #${summary.ball}`],
    ['Met', `at level ${summary.metLevel || '?'}`],
    ['Original trainer', `${summary.otName || '?'}${summary.otGender === 1 ? ' ♀' : summary.otGender === 0 ? ' ♂' : ''}, ID ${String(summary.otId).padStart(5, '0')}`],
    ['From game', `${ORIGINS[summary.origin] || `#${summary.origin}`}${LANGUAGES[summary.language] ? `, ${LANGUAGES[summary.language]}` : ''}`],
    ['Markings', marks]
  ];
  const list = el('dl', { className: 'trade-sheet-facts' });
  for (const [term, value, doc] of facts) list.append(el('dt', { textContent: term }), el('dd', {}, value, doc ? el('small', { textContent: doc }) : null));
  sheet.append(list);
  // contest and ribbons
  const contest = el('dl', { className: 'trade-sheet-facts' });
  CONTEST.forEach((stat, i) => contest.append(el('dt', { textContent: stat }), el('dd', { textContent: `${summary.contest[i]}${summary.contestRanks[i] ? ` · ${RANKS[summary.contestRanks[i]]} rank ribbon` : ''}` })));
  contest.append(el('dt', { textContent: 'Sheen' }), el('dd', { textContent: `${summary.sheen}/255` }));
  sheet.append(el('h3', { textContent: 'Contest' }), contest);
  const earned = RIBBONS.filter((_, i) => summary.ribbons[i]);
  sheet.append(el('h3', { textContent: 'Ribbons' }), el('p', { className: 'trade-sheet-ribbons', textContent: earned.length ? earned.map(name => `${name} Ribbon`).join(', ') : 'None' }));
  if (evolvesInto) sheet.append(el('p', { className: 'trade-evolves', textContent: `Evolves into ${dex?.get(evolvesInto)?.name || `#${evolvesInto}`} when it arrives.` }));
  for (const problem of problems) sheet.append(el('p', { className: 'trade-problem', textContent: problem.text || problem }));
  return sheet;
}

function renderStats() {
  const room = tradeView?.room;
  if (!room) { if ($('trade-stats').open) $('trade-stats').close(); return; }
  const theirs = room.peer?.offer;
  $('trade-stats-sheets').replaceChildren(statSheet(room.you?.offer?.summary, 'You offer'),
    statSheet(theirs?.summary, `${room.peer?.name || 'They'} offer${room.peer?.name ? 's' : ''}`, { problems: theirs?.problems || [], evolvesInto: theirs?.evolvesInto || 0 }));
}

function openStats() {
  renderStats();
  if (!$('trade-stats').open) $('trade-stats').showModal();
}

function tradeProgress(room) {
  const trade = room.trade;
  if (!trade) {
    if (room.last?.outcome === 'traded') return 'Traded! Pick another Pokémon to trade again.';
    if (room.last?.outcome === 'aborted') return `The trade was called off${room.last.reason && room.last.reason !== 'cancelled' ? ` (${room.last.reason === 'timeout' ? 'a game took too long' : room.last.reason})` : ''}. Your Pokémon stays yours.`;
    return '';
  }
  if (trade.message) return trade.message;
  if (trade.mine && TRADE_STAGE[trade.mine]) return TRADE_STAGE[trade.mine] + (data?.source === 'live' && ['taking', 'giving', 'evolving'].includes(trade.mine) ? ' The game does it at a quiet moment in the field and saves.' : '');
  if (trade.stage === 'committed') return 'Both ready: trading…';
  return 'Trading…';
}

function renderTradePanel() {
  const view = tradeView, room = view?.room;
  $('trade-start').hidden = Boolean(room);
  $('trade-room').hidden = !room;
  $('trade-notice').hidden = !view?.notice;
  $('trade-notice').textContent = view?.notice || '';
  if (room) {
    $('trade-code').textContent = room.code || '…';
    const peer = room.peer;
    $('trade-peer').textContent = room.connection === 'reconnecting' ? 'Reconnecting to the trade room…'
      : !peer?.here ? 'Share this code with the other player. Waiting for them to join…'
      : !peer.present ? `${peer.name || 'The other player'} lost their connection: waiting for them to come back…`
      : `${peer.name || 'The other player'} (${peer.game === 'xd' ? 'XD' : 'Colosseum'}) is here.${peer.ready ? ' They\'re ready.' : ''}`;
    $('trade-theirs-title').textContent = `${peer?.name || 'They'} offer${peer?.name ? 's' : ''}`;
    const you = room.you;
    $('trade-mine').replaceChildren(tradeCard(you?.offer?.summary, { problems: you?.refusedBecause ? [`Their game can't take it: ${you.refusedBecause}`] : [],
      empty: 'Pick a Pokémon from your party or boxes, then press Offer for trade.' }));
    const theirs = peer?.offer;
    $('trade-theirs').replaceChildren(tradeCard(theirs?.summary, { problems: theirs?.problems || [], evolvesInto: theirs?.evolvesInto || 0,
      empty: peer?.here ? 'They haven\'t picked yet.' : '' }));
    const ready = $('trade-ready');
    ready.textContent = you?.ready ? (peer?.ready ? 'Trading…' : 'Ready: waiting for them') : 'Ready';
    ready.disabled = Boolean(room.trade) || (!you?.ready && !room.canReady);
    ready.classList.toggle('pressed', Boolean(you?.ready));
    $('trade-withdraw').hidden = !you?.offer || Boolean(room.trade);
    $('trade-compare').hidden = !you?.offer && !theirs;
    $('trade-leave').disabled = Boolean(room.trade);
    const progress = tradeProgress(room);
    $('trade-progress').hidden = !progress;
    $('trade-progress').textContent = progress;
  }
  // trades still on their way (from a room that has closed, or the game closed)
  const pending = (view?.journal || []).filter(entry => entry.game === data?.game && (!room?.trade || entry.tradeId !== tradeView.room.trade?.tradeId));
  $('trade-journal').replaceChildren(...pending.map(entry => {
    const row = document.createElement('div');
    row.className = 'shadowtrade-row';
    const text = document.createElement('div');
    text.append(Object.assign(document.createElement('strong'), { textContent: entry.received && !entry.returned ? `${entry.sent.nickname} for ${entry.received.nickname}` : `Trading ${entry.sent.nickname}` }),
      Object.assign(document.createElement('small'), { textContent: entry.message || TRADE_STAGE[entry.stage] || entry.stage }));
    row.append(text);
    return row;
  }));
  const history = (view?.history || []).filter(item => item.game === data?.game).slice(0, 6);
  $('trade-history').replaceChildren(...history.map(item => {
    const li = document.createElement('li');
    li.textContent = item.returned ? `${item.sent.nickname} came back (the trade was called off)`
      : `${item.sent.nickname} for ${item.received?.nickname || '?'} from ${item.from || 'another player'}${item.evolvedInto ? `, which evolved` : ''}`;
    return li;
  }));
  $('trade-history-title').hidden = !history.length;
  renderOfferButton(current());
  if ($('trade-stats').open) renderStats();
}

async function tradeAction(action, value) {
  try {
    tradeView = await window.colo.onlineTrade(action, value);
    setStatus('');
  } catch (error) { setStatus(message(error)); }
  renderTradePanel();
}

function show() {
  visible = true;
  refresh();
  window.colo.shadowtradeSync().then(refresh).catch(() => {});
  tradeNames().then(() => window.colo.onlineTrade('view')).then(view => { tradeView = view; renderTradePanel(); }).catch(() => {});
}
function hide() { visible = false; }

$('pokemon-tab-party').addEventListener('click', () => { tab = 'party'; render(); });
$('pokemon-tab-boxes').addEventListener('click', () => { tab = 'boxes'; render(); });
$('pokemon-box').addEventListener('change', event => { box = Number(event.target.value); render(); });
$('pokemon-box-prev').addEventListener('click', () => { const n = data?.model?.boxes.length || 1; box = (box + n - 1) % n; render(); });
$('pokemon-box-next').addEventListener('click', () => { const n = data?.model?.boxes.length || 1; box = (box + 1) % n; render(); });
$('pokemon-refresh').addEventListener('click', () => { setStatus(''); refresh(); window.colo.shadowtradeSync().then(refresh).catch(error => setStatus(message(error))); });
$('pokemon-trade').addEventListener('click', trade);
$('shadowtrade-confirm-send').addEventListener('click', confirmTrade);
window.colo.onPokemonChanged(() => { if (visible) refresh(); });
window.colo.onShadowtrade(view => { if (data) { data.trades = view; if (visible) { renderTrades(); renderDetail(); } } });
window.colo.onShadowtradeWaiting(() => { waitingGame = true; if (visible) renderTrades(); });
$('trade-host').addEventListener('click', () => tradeAction('open'));
$('trade-join-form').addEventListener('submit', event => { event.preventDefault(); tradeAction('open', $('trade-join-code').value); });
$('trade-copy').addEventListener('click', () => { navigator.clipboard?.writeText(tradeView?.room?.code || '').catch(() => {}); });
$('trade-ready').addEventListener('click', () => tradeAction(tradeView?.room?.you?.ready ? 'unready' : 'ready'));
$('trade-withdraw').addEventListener('click', () => tradeAction('offer', null));
$('trade-leave').addEventListener('click', () => tradeAction('leave'));
$('trade-compare').addEventListener('click', openStats);
$('pokemon-offer').addEventListener('click', () => { const pokemon = current(); if (pokemon) tradeAction('offer', { area: pokemon.area, box: pokemon.box, slot: pokemon.slot }); });
window.colo.onOnlineTrades(view => {
  tradeView = view;
  // a trade moved on (a Pokémon left the save, or came into it): the save changed
  const progress = JSON.stringify([view.journal.map(entry => `${entry.tradeId}:${entry.stage}`), view.history[0]?.tradeId || null]);
  if (tradeHistorySeen !== null && progress !== tradeHistorySeen && visible) refresh();
  tradeHistorySeen = progress;
  if (visible) renderTradePanel();
});

window.coloPokemon = { show, hide, refresh };
