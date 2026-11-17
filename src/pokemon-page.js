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
  names = { moves: new Map(), items: new Map() };
  try {
    const battle = await window.colo.battleData();
    for (const move of battle.moves || []) names.moves.set(move.id, move.name);
    for (const item of battle.items || []) names.items.set(item.id, item.name);
    for (const each of Object.values(battle.generations || {})) for (const item of each.items || []) if (!names.items.has(item.id)) names.items.set(item.id, item.name);
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
  const moves = summary.moves.map(id => names?.moves.get(id) || `Move #${id}`).join(', ');
  card.append(Object.assign(document.createElement('small'), { className: 'trade-card-line', textContent: `Moves: ${moves || 'none'}` }));
  card.append(Object.assign(document.createElement('small'), { className: 'trade-card-line', textContent: `IVs ${summary.ivs.join('/')} · HP ${summary.hp}/${summary.maxHp}${summary.ribbons ? ` · ${summary.ribbons} ribbon${summary.ribbons > 1 ? 's' : ''}` : ''}` }));
  if (evolvesInto) card.append(Object.assign(document.createElement('p'), { className: 'trade-evolves', textContent: `Evolves into ${dex?.get(evolvesInto)?.name || `#${evolvesInto}`} when it arrives.` }));
  for (const problem of problems) card.append(Object.assign(document.createElement('p'), { className: 'trade-problem', textContent: problem.text || problem }));
  return card;
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
