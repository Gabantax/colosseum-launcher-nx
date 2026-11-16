// The Pokémon page: the party and PC boxes of the chosen game's save, from the card, or live from the game while it
// runs (main.js pokemonPage). A Shadow Pokémon can go to Shadowtrade from here: it leaves the save and another
// player's Shadow Pokémon comes back (src/shadowtrade.js).

const $ = id => document.getElementById(id);
const message = error => String(error?.message || error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

let data = null, tab = 'party', box = 0, selected = null, visible = false, loading = null, dex = null, dexFor = null, waitingGame = false;
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
    button.title = `${shown(pokemon)}, level ${pokemon.level}${pokemon.shadow ? ', Shadow Pokémon' : ''}`;
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
  if (!pokemon) return;
  $('pokemon-detail-sprite').replaceChildren(sprite(pokemon, 96));
  $('pokemon-detail-name').textContent = shown(pokemon);
  const where = pokemon.area === 'party' ? `Party, slot ${pokemon.slot + 1}` : `${data.model.boxes[pokemon.box].name}, slot ${pokemon.slot + 1}`;
  $('pokemon-detail-meta').textContent = `${speciesName(pokemon)} · Lv. ${pokemon.level} · ${where}`;
  const badges = $('pokemon-detail-badges');
  badges.replaceChildren();
  if (pokemon.shadow) badges.append(Object.assign(document.createElement('span'), { className: 'badge shadow-badge', textContent: 'Shadow Pokémon' }));
  if (pokemon.shiny) badges.append(Object.assign(document.createElement('span'), { className: 'badge warn', textContent: 'Shiny' }));
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

function show() { visible = true; refresh(); window.colo.shadowtradeSync().then(refresh).catch(() => {}); }
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

window.coloPokemon = { show, hide, refresh };
