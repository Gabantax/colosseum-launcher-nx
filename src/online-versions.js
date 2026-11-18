'use strict';

// Whether this player can battle in a room, and if not, who is behind and what to do. The room server lets a player
// in only with the room's very build (src/online.js buildId, or crossBuildId for a room for both games) and the room's
// protocol (src/online.js PROTOCOL, which changes with the launcher). A game that declares its battle version
// (host/battleversion.h in the game) has a build of that number, "colosseum-battle-3", so games of different versions
// battle until a battle changes; an older game's build is its commits. Each room says its host's game version,
// launcher version and protocol, so the Online page and Join by code can say which side needs to update.
//
// `mine`: { build, crossBuild, version, launcher, protocol, battle, waiting: { launcher, game } } — this launcher's
// builds, its game's version ("2026.11.17.1", "XD 2026.11.17.xd1") and battle version, its own version, and whether
// the launcher has an update waiting for it (src/update-status.js).
(function (root) {
  // A game's version, as the launcher names it (main.js gameBuild): a release's "2026.11.17.1" (XD's "XD 2026.11.17.xd1"),
  // or Beta's "2026.11.17-beta.37c245b" (XD's "XD 2026.11.17-beta.37c245b.xd", .github/workflows/build.yml) ->
  // { date: [2026, 11, 17], number, beta }: beta is the game commit Beta built. null for a version that is neither
  // (a game source's), which can't be put in order.
  function parse(version) {
    const text = String(version || '').replace(/^XD\s+/, '');
    const beta = text.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})-beta\.([0-9a-f]{7,40})(?:\.xd)?$/);
    if (beta) return { date: beta.slice(1, 4).map(Number), number: 0, beta: beta[4] };
    const release = text.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(?:xd)?(\d+))?$/);
    return release ? { date: release.slice(1, 4).map(Number), number: Number(release[4] || 0), beta: null } : null;
  }
  const isBeta = version => Boolean(parse(version)?.beta);

  // 1 when a is newer, -1 when older, 0 the same, null when that can't be told: a version that isn't a release's or
  // Beta's, or a Beta game of the same day as another game.
  function order(a, b) {
    const left = parse(a), right = parse(b);
    if (!left || !right) return null;
    for (let i = 0; i < 3; i++) if (left.date[i] !== right.date[i]) return Math.sign(left.date[i] - right.date[i]);
    if (left.beta || right.beta) return left.beta === right.beta ? 0 : null;
    return Math.sign(left.number - right.number);
  }

  const gameName = version => String(version || '').startsWith('XD ') ? 'XD' : 'Colosseum';
  // a build's battle version (src/online.js buildId), or null for a game from before them
  const battleOf = build => { const match = /-battle-(\d+)$/.exec(String(build || '')); return match ? Number(match[1]) : null; };
  const shown = version => version ? String(version).replace(/^XD\s+/, '') : 'unknown';

  // What to tell the player who is behind, when that is this player.
  function yourFix(waiting, part) {
    if ((part === 'game' && waiting?.game) || waiting?.launcher) return 'Your update is ready: press Update to join, or Update ready in the top bar.';
    return 'No update has reached you yet: press ↻ beside the update message at the bottom of the window to check now.';
  }

  function compare(room, mine) {
    const name = room?.name || 'That player';
    const cross = String(room?.build || '').startsWith('cross-');
    const myBuild = cross ? mine?.crossBuild : mine?.build;
    const theirs = room?.version, yours = mine?.version;
    if (!mine?.build) return { ok: false, part: 'game', direction: null, short: 'set up your game to join',
      detail: 'Set up the game on the Play page to battle online.', fix: null };
    // A room for both games needs a game that can play them: newer than this one.
    if (cross && !mine.crossBuild) return { ok: false, part: 'game', direction: 'newer', short: 'newer game: update to join',
      summary: `${name}'s room is for Colosseum and XD players together, which needs a newer game than yours (${shown(yours)}).`,
      detail: `${name}'s room is for Colosseum and XD players together, which needs a newer game than yours (${shown(yours)}). ${yourFix(mine.waiting, 'game')}`,
      fix: mine.waiting?.game || mine.waiting?.launcher ? 'updates' : null };
    // A room for the other game only: its host chose players of their own game.
    if (!cross && theirs && yours && gameName(theirs) !== gameName(yours)) return { ok: false, part: 'game', direction: 'game',
      short: `for ${gameName(theirs)} players only`,
      detail: `${name}'s room is for ${gameName(theirs)} players only. Ask them to tick Colosseum and XD players can join when they open their room.`, fix: null };
    // Launchers that battle another way: the newer one has to reach both, and it brings its own game.
    const protocol = Number(room.protocol), mineProtocol = Number(mine.protocol);
    if (Number.isFinite(protocol) && Number.isFinite(mineProtocol) && protocol !== mineProtocol) {
      const versions = `v${room.launcher || '?'}; you have v${mine.launcher || '?'}`;
      if (protocol > mineProtocol) return { ok: false, part: 'launcher', direction: 'newer', short: 'newer launcher: update to join',
        summary: `${name} has a newer launcher (${versions}).`,
        detail: `${name} has a newer launcher (${versions}). ${yourFix(mine.waiting, 'launcher')}`, fix: mine.waiting?.launcher ? 'updates' : null };
      return { ok: false, part: 'launcher', direction: 'older', short: 'older launcher: they need to update',
        detail: `${name} has an older launcher (${versions}). They need to update it before you can battle.`, fix: null };
    }
    const theirBattle = battleOf(room.build), myBattle = battleOf(myBuild);
    const battleText = battle => battle ? `, battle version ${battle}` : '';
    if (room.build !== myBuild) {
      // Stable and Beta players: each launcher brings its channel's game, so updating doesn't bring them together.
      const changed = theirBattle && myBattle ? ', and Beta\'s battles have changed since' : '';
      if (isBeta(theirs) !== isBeta(yours)) return { ok: false, part: 'game', direction: 'channel',
        short: isBeta(theirs) ? 'on Beta: you are on Stable' : 'on Stable: you are on Beta',
        detail: isBeta(theirs)
          ? `${name} is on Beta (game ${shown(theirs)}${battleText(theirBattle)}) and you're on Stable (${shown(yours)}${battleText(myBattle)})${changed}. To battle, join the Beta under Settings → Launcher, or ask them to open their room from Stable.`
          : `You're on Beta (game ${shown(yours)}${battleText(myBattle)}) and ${name} is on Stable (${shown(theirs)}${battleText(theirBattle)})${changed}. To battle, switch to Stable under Settings → Launcher, or ask them to join the Beta.`,
        fix: null };
      // Which battles the later: the battle versions when both have one, a game with one over a game from before them,
      // or else the versions' dates.
      const direction = theirBattle && myBattle ? Math.sign(theirBattle - myBattle) : theirBattle || myBattle ? (theirBattle ? 1 : -1) : order(theirs, yours);
      const versions = `${cross ? `${gameName(theirs)} ` : ''}${shown(theirs)}${battleText(theirBattle)}; you have ${shown(yours)}${battleText(myBattle)}`;
      if (direction > 0) return { ok: false, part: 'game', direction: 'newer', short: 'newer game: update to join',
        summary: `${name} has a newer game (${versions}).`,
        detail: `${name} has a newer game (${versions}). ${yourFix(mine.waiting, 'game')}`,
        fix: mine.waiting?.game || mine.waiting?.launcher ? 'updates' : null };
      if (direction < 0) return { ok: false, part: 'game', direction: 'older', short: 'older game: they need to update',
        detail: `${name} has an older game (${versions}). They need to update before you can battle: Update ready in their launcher's top bar.`, fix: null };
      return { ok: false, part: 'game', direction: 'other', short: 'another build of the game',
        detail: isBeta(theirs)
          ? `${name} is on another Beta (${versions}). Both of you need the newest Beta: press ↻ at the bottom of the window to check for it.`
          : `${name} has another build of the game (${versions}): one of you builds from a custom game source. Both players need the very same build.`, fix: null };
    }
    return { ok: true, part: null, direction: null, short: '',
      detail: theirs && theirs !== yours ? `Game ${shown(theirs)}, which battles the same as yours (${shown(yours)}${battleText(myBattle)}).` : `Same game as yours (${shown(yours)}).`, fix: null };
  }

  const api = { parse, order, compare, battleOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.coloOnlineVersions = api;
})(typeof globalThis === 'object' ? globalThis : this);
