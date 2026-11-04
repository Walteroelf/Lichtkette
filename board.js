'use strict';

// Tafel (Beamer / Smartboard): zeigt das Spiel und lenkt es.
// Die Haupt-Tafel ("Host") entscheidet, wer das Licht bekommt. Eine zweite Tafel schaut nur mit.
//
// Spielarten (gm):
//   klassik   ein Licht, zufällig von Gerät zu Gerät, optional als Zeitspiel mit Bestzeit
//   rhythmus  ein Licht, Weitergaben passieren im Takt, dazu baut sich ein Track auf
//   staffel   zwei Teams, jedes mit eigenem Licht, wer zuerst die Weitergaben schafft, gewinnt
//   doppel    zwei oder drei Lichter gleichzeitig
//   schatz    ein Licht sammelt Sterne ein, die bei einzelnen Geräten liegen
(function (LK) {
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const FINALE_MS = 5200;
  const GONE_MS = 9000; // so lange ohne Lebenszeichen, dann fliegt ein Gerät aus dem Spiel
  const GN_OPTIONS = [0, 10, 15, 20]; // 0 = automatisch
  const NL_OPTIONS = [2, 3];
  const BPM_OPTIONS = [70, 90, 110];
  const PEN_OPTIONS = [0, 2, 4]; // Strafpause in Sekunden bei einem Fehltipp (0 = aus)
  const GAMES = ['klassik', 'rhythmus', 'staffel', 'doppel', 'schatz'];
  const TITLES = { klassik: 'Lichtkette', rhythmus: 'Rhythmus', staffel: 'Staffel', doppel: 'Doppelte Lichter', schatz: 'Schatz-Licht' };
  const INFO = {
    klassik: 'Ein Licht wandert zufällig von Gerät zu Gerät. Wahlweise als Zeitspiel mit Bestzeit.',
    rhythmus: 'Das Licht springt im Takt weiter. Mit jeder Weitergabe kommt mehr Musik dazu.',
    staffel: 'Zwei Teams, jedes mit eigenem Licht. Wer zuerst die Weitergaben schafft, gewinnt.',
    doppel: 'Zwei oder drei Lichter gleichzeitig. Jedes Gerät hat höchstens ein Licht.',
    schatz: 'Das Licht sammelt Sterne ein, die bei einzelnen Geräten liegen.',
  };
  const GN_LABEL = {
    klassik: 'Weitergaben pro Runde',
    rhythmus: 'Weitergaben pro Runde',
    staffel: 'Weitergaben pro Team',
    doppel: 'Weitergaben insgesamt',
    schatz: 'Sterne pro Runde',
  };
  const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  LK.startBoard = function (room, startBroker) {
    $('scr-board').hidden = false;
    const cv = $('cv');
    const ctx = cv.getContext('2d');
    const boardId = LK.rid(8);
    const link = `${location.href.split('?')[0].split('#')[0]}?r=${room}`;
    const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

    let isHost = null; // null = wird entschieden, true = Haupt-Tafel, false = Mitschau
    const peers = {};
    const slotMem = {};
    const teamMem = {};
    let bags = {};
    const autoTimers = [];
    let pendingPass = {};
    let finishing = false;
    let finTimer = null;
    let cdTimer = null;
    let decideTimer = null;
    let beatTimer = null;
    let beatAt = 0;
    let beatCount = 0;
    let token = 0;
    const penUntil = [0, 0]; // Staffel: bis wann das Licht des Teams wegen eines Fehltipps pausiert
    // Vorgaben der Tafel pro Gerät (überstimmen die Einstellung am Gerät). Fehlt ein Wert, entscheidet das Gerät selbst.
    // pn Strafe bei Fehltipps 0/1, sz Größe des Punkts 0.7/1/1.4, rnd springender Punkt 0/1,
    // nt Zeit zählt nicht 0/1, w Weiterwandern 0/10/30 s, tt Team a/b/x (x = automatisch)
    let cfgAll = {};
    try { cfgAll = JSON.parse(LK.store.get('lk_cfg', '{}')) || {}; } catch (e) { cfgAll = {}; }
    const saveCfg = () => LK.store.set('lk_cfg', JSON.stringify(cfgAll));
    let soundOn = LK.store.get('lk_board_snd', '1') === '1';
    let since = Date.now(); // Zeitspiel: Beginn des gerade laufenden Zeitabschnitts

    const readNum = (key, opts, d) => { const v = parseInt(LK.store.get(key, String(d)), 10); return opts.includes(v) ? v : d; };
    const gmStored = LK.store.get('lk_gm', 'klassik');
    let st = {
      epoch: Date.now(), seq: 0, gm: GAMES.includes(gmStored) ? gmStored : 'klassik',
      lights: [], // { h: Halter, p: vorheriger Halter, k: Nr., s: Kennung, a: Auto-ms, z: Pause }
      chain: 0, goal: 8, round: 1, finale: false, players: {}, team: {}, tc: [0, 0], win: -1,
      stars: [], sc: 0,
      tm: LK.store.get('lk_tm', '0') === '1' ? 1 : 0,
      gn: readNum('lk_gn', GN_OPTIONS, 0), nl: readNum('lk_nl', NL_OPTIONS, 2), bpm: readNum('lk_bpm', BPM_OPTIONS, 90),
      pen: readNum('lk_pen', PEN_OPTIONS, 0), cfg: {},
      // Zeitspiel: ph = ready | count | play, acc = gezählte Zeit in ms, run = Uhr läuft,
      // ft = Endzeit, rec = 1 neue Bestzeit / 2 erste Zeit, n = Geräteanzahl für die Bestzeit
      ph: 'play', acc: 0, run: false, ft: 0, rec: 0, best: 0, n: 0, cd: 0,
      host: boardId, ts: 0,
    };
    // Bestzeit gilt nur für gleich viele Weitergaben UND gleich viele Geräte, sonst ist sie nicht vergleichbar
    const bestFor = (goal, n) => parseInt(LK.store.get(`lk_best_${goal}_${n}`, '0'), 10) || 0;

    const net = new LK.Net(room, startBroker, ['hb', 'act', 'miss', 'host', 'state']);

    // ================= Spiellogik (nur Haupt-Tafel) =================
    const aliveIds = () => Object.keys(st.players);
    const isTm = () => st.tm === 1 && st.gm === 'klassik';
    const needsStart = () => isTm() || st.gm === 'staffel' || st.gm === 'rhythmus';
    const isNt = (id) => !!(peers[id] && peers[id].nt);

    function freeSlot(id) {
      const used = new Set(Object.values(st.players));
      if (slotMem[id] !== undefined && !used.has(slotMem[id])) return slotMem[id];
      for (let i = 0; i < LK.MAX_PLAYERS; i++) if (!used.has(i)) return i;
      return -1;
    }

    // Staffel: Wunschteam des Geräts (a/b) oder das kleinere Team
    const teamPref = (id) => { const p = peers[id] && peers[id].tt; return p === 'a' ? 0 : (p === 'b' ? 1 : -1); };
    function assignTeam(id) {
      let t = teamPref(id);
      if (t < 0) {
        const cnt = [0, 0];
        Object.keys(st.team).forEach((k) => { if (st.players[k] !== undefined && k !== id) cnt[st.team[k]]++; });
        t = cnt[0] === cnt[1] ? (teamMem[id] !== undefined ? teamMem[id] : 0) : (cnt[0] < cnt[1] ? 0 : 1);
      }
      st.team[id] = t;
      teamMem[id] = t;
    }
    function assignAllTeams() {
      st.team = {};
      aliveIds().forEach((id) => { const t = teamPref(id); if (t >= 0) { st.team[id] = t; teamMem[id] = t; } });
      aliveIds().filter((id) => st.team[id] === undefined).forEach(assignTeam);
    }

    function addPlayer(id) {
      if (st.players[id] !== undefined) return false;
      const s = freeSlot(id);
      if (s < 0) return false;
      st.players[id] = s;
      slotMem[id] = s;
      if (st.gm === 'staffel') assignTeam(id);
      return true;
    }

    function removePlayer(id) {
      delete st.players[id];
      delete st.team[id];
      Object.keys(bags).forEach((k) => { bags[k] = bags[k].filter((x) => x !== id); });
      st.stars = st.stars.filter((x) => x !== id);
    }

    function poolIds(li) {
      return st.gm === 'staffel' ? aliveIds().filter((id) => st.team[id] === li) : aliveIds();
    }

    // Wer bekommt Licht li als Nächstes? Zufällig, aber fair: jeder kommt einmal dran, bevor die Reihe von vorn beginnt.
    function pickFor(li) {
      const l = st.lights[li];
      const pool = poolIds(li);
      if (!pool.length) return null;
      const busy = new Set(st.lights.filter((x, i) => i !== li).map((x) => x.h).filter(Boolean));
      const free = pool.filter((id) => !busy.has(id));
      let cand = free.filter((id) => id !== l.h);
      if (!cand.length) cand = free.length ? free : pool; // allein im Team oder Spiel: das Licht bleibt beim selben Gerät
      const key = st.gm === 'staffel' ? `t${li}` : 'all';
      let bag = (bags[key] || []).filter((id) => pool.includes(id));
      let c = bag.filter((id) => cand.includes(id));
      if (!c.length) { bag = pool.slice(); c = bag.filter((id) => cand.includes(id)); if (!c.length) c = cand; }
      if (st.gm === 'schatz' && st.stars.length && Math.random() < 0.7) {
        const sc = cand.filter((id) => st.stars.includes(id));
        if (sc.length) c = sc;
      }
      const n = c[Math.floor(Math.random() * c.length)];
      bags[key] = bag.filter((id) => id !== n);
      return n;
    }

    // Zeitspiel: Zeit bis jetzt festhalten. Die Uhr steht, solange ein Gerät mit "Zeit zählt nicht" das Licht hat.
    function rollClock() {
      const now = Date.now();
      if (st.run) st.acc += now - since;
      since = now;
    }
    function updateClockRun() {
      const l = st.lights[0];
      st.run = !!(isTm() && st.ph === 'play' && !st.finale && l && l.h && !isNt(l.h));
    }

    function desiredLights() {
      if (st.gm === 'staffel') return 2;
      if (st.gm === 'doppel') return Math.max(1, Math.min(st.nl, aliveIds().length - 1));
      return 1;
    }

    function setLight(li, next) {
      rollClock();
      const l = st.lights[li];
      l.p = l.h;
      l.h = next;
      l.a = 0;
      l.z = false;
      l.s = ++token;
      clearTimeout(autoTimers[li]);
      delete pendingPass[li];
      if (next && !isTm() && st.gm !== 'staffel') {
        const w = (peers[next] && peers[next].w) || 0;
        if (w > 0) {
          l.a = w * 1000;
          autoTimers[li] = setTimeout(() => {
            if (isHost === true && st.lights[li] && st.lights[li].h === next) reqPass(li);
          }, l.a);
        }
      }
      st.seq++;
      updateClockRun();
    }

    // Lichter anlegen und freie Lichter vergeben (zum Beispiel wenn ein Gerät dazukommt oder geht)
    function ensureLights() {
      if (st.ph !== 'play' || st.finale || finishing) return;
      const D = desiredLights();
      while (st.lights.length > D) { const i = st.lights.length - 1; clearTimeout(autoTimers[i]); st.lights.pop(); }
      while (st.lights.length < D) st.lights.push({ h: null, p: null, k: st.lights.length, s: ++token, a: 0, z: false });
      st.lights.forEach((l, i) => {
        if (l.h && st.players[l.h] === undefined) { l.p = l.h; l.h = null; }
        if (!l.h) { const n = pickFor(i); if (n) setLight(i, n); }
      });
      st.seq++;
      updateClockRun();
    }

    // Sterne liegen bei etwa jedem zweiten Gerät (höchstens 3), damit nicht fast jede Weitergabe trifft
    function starCount() { return Math.min(3, Math.max(1, Math.floor(aliveIds().length / 2))); }
    function ensureStars() {
      if (st.gm !== 'schatz') { st.stars = []; return; }
      const holders = new Set(st.lights.map((l) => l.h).filter(Boolean));
      while (st.stars.length < starCount()) {
        const cand = aliveIds().filter((id) => !st.stars.includes(id) && !holders.has(id));
        if (!cand.length) break;
        st.stars.push(cand[Math.floor(Math.random() * cand.length)]);
      }
    }

    function collectStar(id) {
      const i = st.stars.indexOf(id);
      if (i < 0) return;
      st.stars.splice(i, 1);
      st.sc++;
      ensureStars();
    }

    function reqPass(li) {
      if (st.gm === 'rhythmus') { pendingPass[li] = true; return; } // wird beim nächsten Schlag ausgeführt
      passLight(li);
    }

    function passLight(li) {
      if (st.finale || st.ph !== 'play' || finishing) return;
      const l = st.lights[li];
      if (!l || !l.h || l.z) return;
      st.chain++;
      if (st.gm === 'staffel') st.tc[li]++;
      if (st.gm === 'staffel' ? st.tc[li] >= st.goal : (st.gm !== 'schatz' && st.chain >= st.goal)) { startFinale(li); return; }
      const next = pickFor(li);
      setLight(li, next);
      if (st.gm === 'schatz' && next) collectStar(next);
      if (st.gm === 'schatz' && st.sc >= st.goal) {
        // der letzte Stern bleibt kurz sichtbar, dann kommt das Finale
        finishing = true;
        publish();
        clearTimeout(finTimer);
        finTimer = setTimeout(() => { if (isHost === true) startFinale(li); }, 1100);
        return;
      }
      publish();
    }

    function computeGoal() {
      if (st.gn > 0) return st.gn;
      switch (st.gm) {
        case 'klassik': return isTm() ? 10 : Math.max(8, aliveIds().length * 3);
        case 'doppel': return 12;
        case 'staffel': return 12;
        case 'rhythmus': return 16;
        default: return 8; // schatz: Sterne
      }
    }

    function stopBeat() { clearTimeout(beatTimer); beatTimer = null; }

    // Rhythmus: Weitergaben passieren nur auf dem Schlag. So klingt jede Eingabe im Takt, egal wann sie kommt.
    function startBeat() {
      stopBeat();
      const ms = 60000 / st.bpm;
      beatCount = 0;
      beatAt = performance.now() + ms;
      const loop = () => {
        onBeat(ms);
        beatAt += ms;
        beatTimer = setTimeout(loop, Math.max(0, beatAt - performance.now()));
      };
      beatTimer = setTimeout(loop, ms);
    }

    function onBeat(ms) {
      if (isHost !== true || st.gm !== 'rhythmus' || st.ph !== 'play' || st.finale) return;
      beatCount++;
      view.beatT = performance.now();
      if (soundOn && LK.audio.ready) {
        const layer = Math.min(4, Math.floor(st.chain / 3)); // alle 3 Weitergaben kommt eine Schicht dazu
        LK.audio.kick();
        if (layer >= 1) setTimeout(() => LK.audio.hat(), ms / 2);
        if (layer >= 2 && beatCount % 2 === 0) LK.audio.clap();
        if (layer >= 3 && beatCount % 4 === 1) {
          const l = st.lights[0];
          LK.audio.bass(l && l.h && st.players[l.h] !== undefined ? st.players[l.h] : 0);
        }
      }
      Object.keys(pendingPass).forEach((k) => { delete pendingPass[k]; passLight(parseInt(k, 10)); });
    }

    // Neue Runde. Wo es nötig ist, wartet sie auf "Los", sonst geht das Spiel gleich los.
    function resetRound(bump) {
      clearTimeout(finTimer);
      clearTimeout(cdTimer);
      stopBeat();
      st.lights.forEach((l, i) => clearTimeout(autoTimers[i]));
      pendingPass = {};
      finishing = false;
      penUntil[0] = 0;
      penUntil[1] = 0;
      if (bump) st.round++;
      st.finale = false;
      st.chain = 0;
      st.tc = [0, 0];
      st.win = -1;
      st.sc = 0;
      st.stars = [];
      st.lights = [];
      st.goal = computeGoal();
      st.acc = 0;
      st.run = false;
      st.ft = 0;
      st.rec = 0;
      st.cd = 0;
      bags = {};
      if (st.gm === 'staffel') assignAllTeams(); else st.team = {};
      st.ph = needsStart() ? 'ready' : 'play';
      st.n = aliveIds().length;
      st.best = isTm() ? bestFor(st.goal, st.n) : 0;
      since = Date.now();
      st.seq++;
      if (st.ph === 'play') beginPlay();
    }

    function beginPlay() {
      st.lights = [];
      ensureLights();
      ensureStars();
      if (st.gm === 'rhythmus') startBeat();
      updateClockRun();
    }

    function startCountdown() {
      if (isHost !== true || st.ph !== 'ready' || !aliveIds().length) return;
      if (st.gm === 'staffel') assignAllTeams();
      st.ph = 'count';
      st.cd = 3000;
      st.n = aliveIds().length; // ab jetzt zählt diese Geräteanzahl für die Bestzeit
      st.best = isTm() ? bestFor(st.goal, st.n) : 0;
      publish();
      clearTimeout(cdTimer);
      cdTimer = setTimeout(() => {
        if (isHost !== true) return;
        st.cd = 0;
        if (!aliveIds().length) { st.ph = 'ready'; publish(); return; }
        st.ph = 'play';
        st.acc = 0;
        since = Date.now();
        beginPlay();
        publish();
      }, 3000);
    }

    function applySettings(patch) {
      Object.assign(st, patch);
      LK.store.set('lk_gm', st.gm);
      LK.store.set('lk_tm', String(st.tm));
      LK.store.set('lk_gn', String(st.gn));
      LK.store.set('lk_nl', String(st.nl));
      LK.store.set('lk_bpm', String(st.bpm));
      LK.store.set('lk_pen', String(st.pen));
      resetRound(true);
      publish();
    }

    function startFinale(win) {
      rollClock();
      clearTimeout(finTimer);
      stopBeat();
      finishing = false;
      st.finale = true;
      st.win = st.gm === 'staffel' ? win : -1;
      if (isTm()) {
        st.ft = st.acc;
        const prevBest = bestFor(st.goal, st.n);
        st.rec = prevBest === 0 ? 2 : (st.ft < prevBest ? 1 : 0);
        if (prevBest === 0 || st.ft < prevBest) LK.store.set(`lk_best_${st.goal}_${st.n}`, String(st.ft));
        st.best = bestFor(st.goal, st.n);
      }
      pendingPass = {};
      st.lights.forEach((l, i) => { clearTimeout(autoTimers[i]); l.p = l.h; l.h = null; l.a = 0; l.z = false; l.s = ++token; });
      st.seq++;
      st.run = false;
      publish();
      finTimer = setTimeout(() => {
        if (isHost !== true) return;
        resetRound(true);
        publish();
      }, (isTm() || st.gm === 'staffel') ? 8000 : FINALE_MS);
    }

    // Staffel: Hat ein Gerät mit "Zeit zählt nicht" das Licht, wartet das andere Team, bis es weitergegeben hat.
    function calcFrozen() {
      const now = Date.now();
      st.lights.forEach((l, i) => {
        const o = st.lights[1 - i];
        const wait = !!(st.gm === 'staffel' && st.lights.length === 2 && l.h && o && o.h && isNt(o.h) && !isNt(l.h));
        l.pn = !!(st.gm === 'staffel' && l.h && penUntil[i] > now); // Strafpause nach einem Fehltipp im eigenen Team
        l.z = wait || l.pn;
      });
    }

    // Fehltipp eines Geräts (nur Staffel, nur wenn die Tafel Strafzeit eingeschaltet hat und das Gerät mitmacht)
    function onMiss(id) {
      if (st.gm !== 'staffel' || st.ph !== 'play' || st.finale || finishing || !st.pen) return;
      if (!peers[id] || !peers[id].pn) return;
      const team = st.team[id];
      if (team === undefined || penUntil[team] > Date.now()) return;
      penUntil[team] = Date.now() + st.pen * 1000;
      publish();
      setTimeout(() => { if (isHost === true) publish(); }, st.pen * 1000 + 60);
    }

    function tick() {
      if (isHost !== true) return;
      const now = Date.now();
      let changed = false;
      aliveIds().forEach((id) => {
        const p = peers[id];
        if (!p || now - p.last > GONE_MS) { removePlayer(id); changed = true; }
      });
      if (changed) {
        ensureLights();
        ensureStars();
        publish();
      }
    }

    // Vorgaben der Tafel für ein Gerät auf das anwenden, was das Gerät selbst gemeldet hat
    function applyPeerCfg(id) {
      const p = peers[id];
      const c = cfgAll[id];
      if (!p || !c) return;
      if (c.nt !== undefined) p.nt = c.nt === 1;
      if (c.w !== undefined && LK.WAIT_OPTIONS.includes(c.w)) p.w = c.w;
      if (c.pn !== undefined) p.pn = c.pn === 1;
      if (c.tt !== undefined) p.tt = c.tt === 'a' || c.tt === 'b' ? c.tt : '';
    }

    // Einstellung eines Geräts ändern (value null = Gerät entscheidet wieder selbst)
    function setDeviceCfg(id, key, value) {
      if (isHost !== true || st.players[id] === undefined) return;
      const c = cfgAll[id] || {};
      if (value === null || value === undefined) delete c[key]; else c[key] = value;
      if (Object.keys(c).length) cfgAll[id] = c; else delete cfgAll[id];
      saveCfg();
      if (key === 'tt' && st.gm === 'staffel' && st.ph !== 'play' && peers[id]) {
        // Teamwechsel nur vor dem Start einer Runde
        if (value === null) peers[id].tt = '';
        applyPeerCfg(id);
        const pt = teamPref(id);
        if (pt >= 0) { st.team[id] = pt; teamMem[id] = pt; } else assignTeam(id);
      } else {
        applyPeerCfg(id);
      }
      publish();
    }

    function publish() {
      rollClock();
      calcFrozen();
      st.cfg = {};
      aliveIds().forEach((id) => { if (cfgAll[id]) st.cfg[id] = cfgAll[id]; });
      // Vor dem Start passt sich die angezeigte Bestzeit an die Zahl der Geräte an, die gerade da sind
      if (isTm() && st.ph === 'ready') {
        st.n = aliveIds().length;
        st.best = bestFor(st.goal, st.n);
      }
      st.ts = Date.now();
      net.send('state', st);
      applyState(st);
    }

    function becomeHost() {
      isHost = true;
      st.host = boardId;
      st.epoch = Date.now();
      st.seq++;
      const now = Date.now();
      Object.keys(peers).forEach((id) => { if (now - peers[id].last < GONE_MS) addPlayer(id); });
      resetRound(false);
      publish();
      net.send('host', { id: boardId });
      setInterval(() => { if (isHost === true) net.send('host', { id: boardId }); }, 2000);
      setInterval(tick, 1000);
      setInterval(() => { if (isHost === true) publish(); }, 4000); // geht eine Nachricht verloren, holt das jedes Gerät nach
      setViewerBanner(false);
    }

    function setViewerBanner(on) { $('viewerTag').hidden = !on; }

    // ================= Nachrichten =================
    net.on('hb', (m) => {
      if (typeof m.id !== 'string' || m.id.length > 16) return;
      const now = Date.now();
      const prev = peers[m.id];
      peers[m.id] = {
        last: now, w: LK.WAIT_OPTIONS.includes(m.w) ? m.w : 0, m: m.m, nt: m.nt === 1, pn: m.pn === 1,
        tt: m.tt === 'a' || m.tt === 'b' ? m.tt : '',
      };
      applyPeerCfg(m.id); // Vorgaben der Tafel gehen vor
      if (isHost !== true) return;
      const added = addPlayer(m.id);
      let changed = added;
      if (st.gm === 'staffel' && !added && st.players[m.id] !== undefined && st.ph !== 'play') {
        const pt = teamPref(m.id);
        if (pt >= 0 && st.team[m.id] !== pt) { st.team[m.id] = pt; teamMem[m.id] = pt; changed = true; }
      }
      if (added) { ensureLights(); ensureStars(); }
      if (changed || !prev || now - prev.last > 6000) publish();
    });

    net.on('act', (m) => {
      if (isHost !== true || st.finale || st.ph !== 'play' || finishing) return;
      const li = st.lights.findIndex((l) => l.h === m.id);
      if (li < 0 || m.epoch !== st.epoch || m.s !== st.lights[li].s) return;
      reqPass(li);
    });

    net.on('miss', (m) => {
      if (isHost === true && typeof m.id === 'string' && m.epoch === st.epoch) onMiss(m.id);
    });

    net.on('host', (m) => {
      if (m.id === boardId) return;
      if (isHost === null) { isHost = false; setViewerBanner(true); } else if (isHost === true && String(m.id) < boardId) {
        // zwei Haupt-Tafeln zugleich: die mit der kleineren Kennung bleibt
        isHost = false;
        st.lights.forEach((l, i) => clearTimeout(autoTimers[i]));
        clearTimeout(finTimer);
        clearTimeout(cdTimer);
        stopBeat();
        setViewerBanner(true);
      }
    });

    net.on('state', (m) => {
      if (isHost === false && m.host !== boardId && m.players && Array.isArray(m.lights)) applyState(m);
    });

    net.onconnect = () => {
      setConn(true);
      if (!decideTimer) decideTimer = setTimeout(() => { if (isHost === null) becomeHost(); }, 3000);
      if (isHost) publish();
    };
    net.onstatus = setConn;

    function setConn(ok) {
      $('connDot').className = ok ? 'dot ok' : 'dot bad';
      $('connDot').title = ok ? `Verbunden (${net.brokerName})` : 'Keine Verbindung';
    }

    // ================= Darstellung =================
    let W = 0;
    let H = 0;
    let DPR = 1;
    const nodes = {};
    let edges = {};
    let pulses = [];
    let trail = [];
    let ripples = [];
    const view = {
      gm: 'klassik', lights: [], vis: [], autoSince: [], round: -1, chain: 0, goal: 8, prog: 0,
      finale: false, fin: null, init: false, tm: false, ph: 'play', phAt: 0, acc: 0, run: false, accAt: 0,
      ft: 0, rec: 0, best: 0, n: 0, cd: 0, finDur: FINALE_MS, pulseMs: 750, tc: [0, 0], win: -1,
      stars: [], sc: 0, starFx: {}, beatT: 0, team: {},
    };
    const stars = Array.from({ length: 70 }, () => ({ x: Math.random(), y: Math.random(), r: Math.random() * 1.3 + 0.3, p: Math.random() * TAU }));

    function resize() {
      DPR = Math.min(window.devicePixelRatio || 1, 2);
      W = window.innerWidth;
      H = window.innerHeight;
      cv.width = Math.round(W * DPR);
      cv.height = Math.round(H * DPR);
      cv.style.width = `${W}px`;
      cv.style.height = `${H}px`;
      layout();
    }
    window.addEventListener('resize', resize);

    function layout() {
      const ids = Object.keys(nodes).filter((id) => !nodes[id].dying);
      const cx = W / 2;
      const cy = H / 2;
      const rx = W * 0.36;
      const ry = H * (view.tm || view.gm === 'staffel' ? 0.3 : 0.33); // Platz für Uhr bzw. Fortschrittsbalken oben
      if (view.gm === 'staffel') {
        // Team Blau links, Team Pink rechts
        const teams = [[], []];
        ids.forEach((id) => teams[nodes[id].team || 0].push(id));
        teams.forEach((arr, t) => {
          arr.sort((a, b) => nodes[a].slot - nodes[b].slot);
          arr.forEach((id, i) => {
            const frac = arr.length === 1 ? 0.5 : 0.2 + (0.6 * i) / (arr.length - 1);
            const ang = -Math.PI / 2 + (t === 0 ? -1 : 1) * frac * Math.PI;
            nodes[id].tx = cx + Math.cos(ang) * rx * 0.92;
            nodes[id].ty = cy + Math.sin(ang) * ry;
          });
        });
        return;
      }
      const sorted = ids.sort((a, b) => nodes[a].slot - nodes[b].slot);
      const n = sorted.length;
      sorted.forEach((id, i) => {
        if (n === 1) { nodes[id].tx = cx; nodes[id].ty = cy - ry * 0.55; return; }
        const a = (i / n) * TAU - Math.PI / 2;
        nodes[id].tx = cx + Math.cos(a) * rx;
        nodes[id].ty = cy + Math.sin(a) * ry;
      });
    }

    const nodeColor = (id, slot, team) => (view.gm === 'staffel' ? LK.TEAM_COLORS[team[id] || 0] : LK.COLORS[slot]);

    function syncNodes(players, team) {
      const now = performance.now();
      let changed = false;
      Object.keys(players).forEach((id) => {
        const col = nodeColor(id, players[id], team);
        const t = team[id] || 0;
        if (!nodes[id] || nodes[id].dying) {
          nodes[id] = { slot: players[id], col, team: t, x: W / 2, y: H / 2, tx: W / 2, ty: H / 2, born: now, pop: 0, dying: 0 };
          changed = true;
        } else if (nodes[id].slot !== players[id] || nodes[id].col !== col || nodes[id].team !== t) {
          Object.assign(nodes[id], { slot: players[id], col, team: t });
          changed = true;
        }
      });
      Object.keys(nodes).forEach((id) => {
        if (players[id] === undefined && !nodes[id].dying) { nodes[id].dying = now; changed = true; }
      });
      if (changed) layout();
      const count = Object.keys(players).length;
      $('count').textContent = count === 1 ? '1 Gerät' : `${count} Geräte`;
      if (count > 0 && !view.qrAutoSmall) { view.qrAutoSmall = true; $('qrBox').classList.remove('big'); }
      $('idle').hidden = count > 0;
    }

    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    function applyState(s) {
      const now = performance.now();
      const prevLights = view.lights;
      const gmChanged = s.gm !== view.gm;
      const tmChanged = (!!s.tm && s.gm === 'klassik') !== view.tm;
      view.gm = s.gm;
      view.tm = !!s.tm && s.gm === 'klassik';
      view.team = s.team || {};
      syncNodes(s.players, view.team);
      if (gmChanged || tmChanged) layout();
      if (s.round !== view.round) { edges = {}; pulses = []; view.vis = []; view.round = s.round; }
      const first = !view.init;
      view.init = true;
      view.pulseMs = s.gm === 'rhythmus' ? 60000 / (s.bpm || 90) : 750;
      view.lights = s.lights || [];
      view.vis.length = view.lights.length;
      if (s.finale && !view.finale) {
        startFinaleFx(s);
      } else if (!s.finale) {
        view.fin = null;
        view.lights.forEach((l, i) => {
          const pl = prevLights[i];
          if (pl && pl.s === l.s) return;
          view.autoSince[i] = now;
          if (first) { view.vis[i] = l.h; return; }
          if (l.h) startPulse(i, pl ? l.p : null, l.h); else view.vis[i] = null;
        });
      } else if (first) {
        view.fin = { t0: now };
      }
      view.finale = s.finale;
      view.chain = s.chain;
      view.goal = s.goal;
      view.tc = s.tc || [0, 0];
      view.win = s.win;
      view.stars = s.stars || [];
      if (s.sc > view.sc && !first) {
        // Stern eingesammelt: die Wirkung zeigt sich, sobald das Licht dort ankommt
        const l = view.lights[0];
        if (l && l.h) view.starFx[l.h] = true;
      }
      view.sc = s.sc || 0;
      if ((s.ph || 'play') !== view.ph) view.phAt = now;
      view.ph = s.ph || 'play';
      view.acc = s.acc || 0;
      view.run = !!s.run;
      view.accAt = now;
      view.ft = s.ft || 0;
      view.rec = s.rec || 0;
      view.best = s.best || 0;
      view.n = s.n || 0;
      view.cd = s.cd || 0;
      view.goalN = s.goal;
      view.finDur = (s.tm && s.gm === 'klassik') || s.gm === 'staffel' ? 8000 : FINALE_MS;
      refreshUi();
    }

    function refreshUi() {
      $('goBtn').hidden = !(isHost === true && view.ph === 'ready' && Object.keys(st.players).length > 0);
    }

    const fmtTime = (ms) => {
      const t = Math.max(0, Math.floor(ms / 100));
      const m = Math.floor(t / 600);
      const s = Math.floor((t % 600) / 10);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t % 10}`;
    };

    function startPulse(li, from, to) {
      view.vis[li] = null;
      view.fin = null;
      pulses = pulses.filter((p) => p.li !== li);
      if (!from || from === to || !nodes[from] || !nodes[to]) { arrive(li, to, null); return; }
      pulses.push({ li, a: from, b: to, t0: performance.now() });
    }

    function arrive(li, to, from) {
      const n = nodes[to];
      if (!n) return;
      const now = performance.now();
      n.pop = now;
      view.vis[li] = to;
      ripples.push({ x: n.x, y: n.y, t0: now, color: n.col });
      if (from) {
        const k = edgeKey(from, to);
        if (!edges[k]) edges[k] = { a: from, b: to, k: 0 };
        edges[k].k = Math.min(edges[k].k + 1, 8);
      }
      if (view.starFx[to]) {
        delete view.starFx[to];
        ripples.push({ x: n.x, y: n.y, t0: now + 120, color: '#fde047' });
        if (soundOn) { LK.audio.note(n.slot, 0.4, 1.4, 0, 1); LK.audio.note(n.slot, 0.25, 1.6, 0.12, 2); }
      } else if (soundOn) {
        LK.audio.note(n.slot, view.gm === 'rhythmus' ? 0.42 : 0.5, 1.5);
      }
    }

    function startFinaleFx(s) {
      view.vis = [];
      view.fin = { t0: performance.now() };
      pulses = [];
      if (soundOn) LK.audio.finale(Object.values(s.players));
    }

    function bez(a, b, t) {
      const cx = W / 2;
      const cy = H / 2;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const qx = mx + (cx - mx) * 0.5;
      const qy = my + (cy - my) * 0.5;
      const u = 1 - t;
      return { x: u * u * a.x + 2 * u * t * qx + t * t * b.x, y: u * u * a.y + 2 * u * t * qy + t * t * b.y, qx, qy };
    }

    function baseR() {
      const n = Object.keys(nodes).length;
      return Math.min(W, H) * 0.052 * (n > 8 ? 0.85 : 1);
    }

    // Farbe des Lichts: bei Doppelten Lichtern und in der Staffel eigene Farben, sonst der Verlauf zwischen den Geräten
    function lightCol(li, c1, c2, k, a) {
      if (view.gm === 'doppel') return LK.rgba(LK.LIGHT_COLORS[li % 3], a);
      if (view.gm === 'staffel') return LK.rgba(LK.TEAM_COLORS[li % 2], a);
      return LK.mixRgba(c1, c2, k, a);
    }

    function starPath(x, y, r) {
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const rr = i % 2 ? r * 0.45 : r;
        const a = (i * Math.PI) / 5 - Math.PI / 2;
        if (i) ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        else ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
      ctx.closePath();
    }

    function draw(now) {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#06070d';
      ctx.fillRect(0, 0, W, H);
      const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) * 0.7);
      bg.addColorStop(0, 'rgba(60,40,120,0.28)');
      bg.addColorStop(1, 'rgba(6,7,13,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);
      stars.forEach((s) => {
        ctx.fillStyle = `rgba(200,210,255,${0.12 + 0.18 * (0.5 + 0.5 * Math.sin(now / 2400 + s.p))})`;
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r, 0, TAU);
        ctx.fill();
      });

      // Knoten bewegen, verschwundene entfernen
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        n.x += (n.tx - n.x) * 0.1;
        n.y += (n.ty - n.y) * 0.1;
        if (n.dying && now - n.dying > 700) delete nodes[id];
      });

      const R = baseR();
      const fin = view.fin;
      const finT = fin ? (now - fin.t0) / view.finDur : 0;
      const winCol = view.gm === 'staffel' && view.win >= 0 ? LK.TEAM_COLORS[view.win] : null;

      // Lichtkugeln unterwegs
      pulses = pulses.filter((p) => {
        const a = nodes[p.a];
        const b = nodes[p.b];
        if (!a || !b) return false;
        const k = Math.min(1, (now - p.t0) / view.pulseMs);
        const pt = bez(a, b, ease(k));
        trail.push({ x: pt.x, y: pt.y, t: now, c1: a.col, c2: b.col, k, li: p.li });
        p.p = pt;
        p.k = k;
        if (k >= 1) { arrive(p.li, p.b, p.a); return false; }
        return true;
      });

      ctx.globalCompositeOperation = 'lighter';

      // Spuren aus früheren Weitergaben
      Object.values(edges).forEach((e) => {
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (!a || !b) return;
        const boost = fin ? 0.35 : 0;
        const al = Math.min(0.14 + e.k * 0.07 + boost, 0.85);
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, LK.rgba(a.col, al));
        g.addColorStop(1, LK.rgba(b.col, al));
        const p = bez(a, b, 0.5);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.5 + Math.min(e.k, 6) * 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(p.qx, p.qy, b.x, b.y);
        ctx.stroke();
      });

      // Knoten
      const litBy = {}; // Gerät -> Nummer des Lichts
      view.vis.forEach((id, li) => { if (id) litBy[id] = li; });
      const beatK = view.gm === 'rhythmus' && view.beatT ? Math.max(0, 1 - (now - view.beatT) / 260) : 0;
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        const col = n.col;
        const born = Math.min(1, (now - n.born) / 500);
        const fade = n.dying ? Math.max(0, 1 - (now - n.dying) / 600) : 1;
        const li = litBy[id];
        const lit = li !== undefined || (fin && finT < 0.9);
        const ps = n.pop ? Math.max(0, 1 - (now - n.pop) / 600) : 0;
        const sc = (0.4 + 0.6 * ease(born)) * (1 + 0.35 * ps * ps + (lit ? 0.14 * beatK : 0)) * (lit && !fin ? 1.12 : 1);
        const r = R * sc;
        const breath = lit ? 0.5 + 0.5 * Math.sin(now / 420) : 0;
        const glowA = (lit ? 0.5 + 0.18 * breath : 0.1) * fade;
        const gr = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.4);
        gr.addColorStop(0, LK.rgba(col, glowA));
        gr.addColorStop(1, LK.rgba(col, 0));
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 3.4, 0, TAU);
        ctx.fill();
        LK.shapePath(ctx, n.slot, n.x, n.y, r);
        ctx.fillStyle = LK.rgba(col, (lit ? 0.95 : 0.22) * fade);
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = LK.rgba(col, (lit ? 1 : 0.7) * fade);
        ctx.stroke();
        // Ring: so lange noch Zeit bleibt, bis das Licht von allein weiterwandert
        const L = li !== undefined ? view.lights[li] : null;
        if (L && L.a > 0 && !fin) {
          const left = Math.max(0, 1 - (now - (view.autoSince[li] || now)) / L.a);
          ctx.lineWidth = 4;
          ctx.strokeStyle = LK.rgba(col, 0.8);
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 1.55, -Math.PI / 2, -Math.PI / 2 + TAU * left);
          ctx.stroke();
        }
        // Stern, der bei diesem Gerät liegt
        if (view.gm === 'schatz' && view.stars.includes(id)) {
          const bob = Math.sin(now / 500 + n.slot) * 3;
          ctx.fillStyle = `rgba(253,224,71,${0.9 * fade})`;
          starPath(n.x + r * 1.5, n.y - r * 1.5 + bob, r * 0.6);
          ctx.fill();
        }
      });

      // Schweif und Lichtkugeln
      trail = trail.filter((t) => now - t.t < 650);
      trail.forEach((t) => {
        const life = 1 - (now - t.t) / 650;
        ctx.fillStyle = lightCol(t.li, t.c1, t.c2, t.k, 0.55 * life);
        ctx.beginPath();
        ctx.arc(t.x, t.y, R * 0.34 * (0.4 + 0.6 * life), 0, TAU);
        ctx.fill();
      });
      pulses.forEach((p) => {
        if (!p.p) return;
        const a = nodes[p.a];
        const b = nodes[p.b];
        const orb = ctx.createRadialGradient(p.p.x, p.p.y, 0, p.p.x, p.p.y, R * 1.5);
        orb.addColorStop(0, 'rgba(255,255,255,0.95)');
        orb.addColorStop(0.25, lightCol(p.li, a.col, b.col, p.k, 0.85));
        orb.addColorStop(1, lightCol(p.li, a.col, b.col, p.k, 0));
        ctx.fillStyle = orb;
        ctx.beginPath();
        ctx.arc(p.p.x, p.p.y, R * 1.5, 0, TAU);
        ctx.fill();
      });

      // Wellen bei Ankunft
      ripples = ripples.filter((rp) => now - rp.t0 < 900);
      ripples.forEach((rp) => {
        const k = (now - rp.t0) / 900;
        if (k < 0) return;
        ctx.lineWidth = 3 * (1 - k) + 0.5;
        ctx.strokeStyle = LK.rgba(rp.color, 0.7 * (1 - k));
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, R * (1 + k * 3.2), 0, TAU);
        ctx.stroke();
      });

      // Finale: ruhige Ringe aus der Mitte, in den Farben der Mitspielenden (kein Blitzen)
      if (fin && !reduceMotion) {
        const cols = Object.keys(nodes).map((id) => nodes[id].col);
        for (let i = 0; i < 5; i++) {
          let k = (now - fin.t0) / 2400 - i * 0.26;
          if (k <= 0) continue;
          k %= 1.5;
          if (k >= 1) continue;
          const col = winCol || cols[i % Math.max(1, cols.length)] || '#a78bfa';
          ctx.lineWidth = 5 * (1 - k) + 1;
          ctx.strokeStyle = LK.rgba(col, 0.55 * (1 - k));
          ctx.beginPath();
          ctx.arc(W / 2, H / 2, k * Math.min(W, H) * 0.5, 0, TAU);
          ctx.stroke();
        }
      }

      // Pause-Zeichen, wenn das andere Team gerade wartet (Staffel)
      ctx.globalCompositeOperation = 'source-over';
      view.lights.forEach((l, li) => {
        if (!l.z || !l.h || view.vis[li] !== l.h || !nodes[l.h]) return;
        const n = nodes[l.h];
        ctx.fillStyle = l.pn ? 'rgba(251,113,133,0.95)' : 'rgba(6,7,13,0.85)';
        ctx.fillRect(n.x - R * 0.32, n.y - R * 0.38, R * 0.22, R * 0.76);
        ctx.fillRect(n.x + R * 0.1, n.y - R * 0.38, R * 0.22, R * 0.76);
        if (l.pn) {
          ctx.font = `600 ${Math.round(R * 0.5)}px ${SANS}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Strafpause', n.x, n.y + R * 1.9);
        }
      });
      // Nummer des Lichts (Doppelte Lichter)
      if (view.gm === 'doppel') {
        ctx.fillStyle = 'rgba(6,7,13,0.85)';
        ctx.font = `700 ${Math.round(R * 0.9)}px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        view.vis.forEach((id, li) => { if (id && nodes[id]) ctx.fillText(String(li + 1), nodes[id].x, nodes[id].y + 1); });
      }

      drawHud(now, finT, fin);
    }

    // Mitte und Ränder: Fortschritt, Uhr, Countdown, Ergebnis
    function drawHud(now, finT, fin) {
      const tm = view.tm;
      const gm = view.gm;
      const hr = Math.min(W, H) * 0.085;
      const cx = W / 2;
      const cy = H / 2;
      const playersHere = Object.keys(nodes).filter((id) => !nodes[id].dying).length;
      const timeMs = fin ? view.ft : Math.max(0, view.acc + (view.run ? now - view.accAt : 0));
      const finA = fin ? Math.min(1, finT * 6) * (finT > 0.88 ? Math.max(0, (1 - finT) / 0.12) : 1) : 0;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const progTarget = fin ? 1 : (view.goal ? (gm === 'schatz' ? view.sc : view.chain) / view.goal : 0);
      view.prog += (progTarget - view.prog) * 0.08;
      const ringHidden = (fin && (tm || gm === 'staffel')) || gm === 'staffel';
      if (!ringHidden) {
        ctx.lineWidth = 6;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'rgba(180,190,255,0.12)';
        ctx.beginPath();
        ctx.arc(cx, cy, hr, 0, TAU);
        ctx.stroke();
        if (view.prog > 0.004) {
          ctx.strokeStyle = gm === 'schatz' ? 'rgba(253,224,71,0.8)' : 'rgba(190,200,255,0.65)';
          ctx.beginPath();
          ctx.arc(cx, cy, hr, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, view.prog));
          ctx.stroke();
        }
      }

      if (fin && tm) {
        ctx.fillStyle = `rgba(200,205,240,${finA * 0.8})`;
        ctx.font = `500 ${Math.round(hr * 0.34)}px ${SANS}`;
        ctx.fillText('Geschafft in', cx, cy - hr * 1.0);
        ctx.fillStyle = `rgba(240,242,255,${finA})`;
        ctx.font = `600 ${Math.round(hr * 0.95)}px ${MONO}`;
        ctx.fillText(fmtTime(timeMs), cx, cy);
        ctx.fillStyle = view.rec > 0 ? `rgba(110,231,183,${finA})` : `rgba(200,205,240,${finA * 0.8})`;
        ctx.font = `600 ${Math.round(hr * 0.4)}px ${SANS}`;
        const devDat = `${view.n} ${view.n === 1 ? 'Gerät' : 'Geräten'}`;
        const sub = view.rec === 1 ? 'Neue Bestzeit!' : (view.rec === 2 ? 'Erste Bestzeit gesetzt' : `Bestzeit ${fmtTime(view.best)}`);
        ctx.fillText(sub, cx, cy + hr * 0.95);
        ctx.fillStyle = `rgba(160,168,210,${finA * 0.8})`;
        ctx.font = `500 ${Math.round(hr * 0.28)}px ${SANS}`;
        ctx.fillText(`bei ${devDat} und ${view.goalN} Weitergaben`, cx, cy + hr * 1.5);
      } else if (fin && gm === 'staffel') {
        const w = view.win;
        const c = w >= 0 ? LK.TEAM_COLORS[w] : '#ffffff';
        ctx.fillStyle = LK.rgba(c, finA);
        ctx.font = `700 ${Math.round(hr * 0.8)}px ${SANS}`;
        ctx.fillText(w >= 0 ? `Team ${LK.TEAM_NAMES[w]} gewinnt!` : 'Geschafft!', cx, cy - hr * 0.2);
        ctx.fillStyle = `rgba(200,205,240,${finA * 0.85})`;
        ctx.font = `500 ${Math.round(hr * 0.36)}px ${SANS}`;
        ctx.fillText(`${view.tc[0]} : ${view.tc[1]} Weitergaben`, cx, cy + hr * 0.7);
      } else if (fin) {
        ctx.fillStyle = `rgba(235,238,255,${finA})`;
        ctx.font = `600 ${Math.round(hr * 0.42)}px ${SANS}`;
        ctx.fillText(gm === 'schatz' ? 'Alle Sterne gesammelt' : 'Runde geschafft', cx, cy);
      } else if (needsStartView() && view.ph === 'count') {
        const left = Math.max(0, view.cd - (now - view.phAt));
        const nn = Math.max(1, Math.ceil(left / 1000));
        const frac = (left % 1000) / 1000;
        ctx.fillStyle = `rgba(240,242,255,${0.55 + 0.45 * frac})`;
        ctx.font = `700 ${Math.round(hr * 1.5 * (0.9 + 0.1 * frac))}px ${SANS}`;
        ctx.fillText(String(nn), cx, cy);
        ctx.fillStyle = 'rgba(200,205,240,0.75)';
        ctx.font = `500 ${Math.round(hr * 0.3)}px ${SANS}`;
        ctx.fillText('Mach dich bereit', cx, cy + hr * 1.35);
      } else if (needsStartView() && view.ph === 'ready') {
        ctx.fillStyle = 'rgba(235,238,255,0.9)';
        ctx.font = `600 ${Math.round(hr * (gm === 'staffel' ? 0.5 : 0.4))}px ${SANS}`;
        ctx.fillText(tm ? 'Zeitspiel' : TITLES[gm], cx, cy - hr * 0.12);
        ctx.fillStyle = 'rgba(200,205,240,0.7)';
        ctx.font = `500 ${Math.round(hr * 0.28)}px ${SANS}`;
        ctx.fillText(`${view.goalN || ''} Weitergaben${gm === 'staffel' ? ' pro Team' : ''}`, cx, cy + hr * 0.3);
      } else if (gm === 'schatz') {
        ctx.fillStyle = 'rgba(253,224,71,0.9)';
        ctx.font = `600 ${Math.round(hr * 0.34)}px ${SANS}`;
        ctx.fillText(`★ ${view.sc} / ${view.goal}`, cx, cy);
      } else if (gm !== 'staffel') {
        ctx.fillStyle = 'rgba(200,205,240,0.7)';
        ctx.font = `500 ${Math.round(hr * 0.3)}px ${SANS}`;
        ctx.fillText(`Runde ${view.round > 0 ? view.round : 1}`, cx, cy);
      }

      // Staffel: Fortschritt beider Teams oben
      if (gm === 'staffel' && playersHere > 0 && !fin) {
        const bw = W * 0.34;
        const bh = Math.max(10, H * 0.022);
        const y = H * 0.06;
        [0, 1].forEach((t) => {
          const x0 = t === 0 ? W * 0.5 - bw - W * 0.03 : W * 0.5 + W * 0.03;
          const frac = Math.min(1, (view.tc[t] || 0) / Math.max(1, view.goal));
          ctx.fillStyle = 'rgba(180,190,255,0.12)';
          ctx.fillRect(x0, y, bw, bh);
          ctx.fillStyle = LK.rgba(LK.TEAM_COLORS[t], 0.85);
          ctx.fillRect(t === 0 ? x0 + bw * (1 - frac) : x0, y, bw * frac, bh);
          ctx.fillStyle = LK.rgba(LK.TEAM_COLORS[t], 0.95);
          ctx.font = `600 ${Math.round(Math.min(W, H) * 0.028)}px ${SANS}`;
          ctx.textAlign = t === 0 ? 'right' : 'left';
          ctx.fillText(`Team ${LK.TEAM_NAMES[t]}  ${view.tc[t] || 0}/${view.goal}`, t === 0 ? x0 + bw : x0, y + bh + Math.min(W, H) * 0.035);
        });
        ctx.textAlign = 'center';
      }

      // Uhr oben (nur Zeitspiel, nicht während des Finales, da steht die Zeit in der Mitte)
      if (tm && playersHere > 0 && !fin) {
        const fs = Math.round(Math.min(W, H) * 0.075);
        ctx.fillStyle = 'rgba(240,242,255,0.92)';
        ctx.font = `600 ${fs}px ${MONO}`;
        ctx.fillText(fmtTime(timeMs), cx, H * 0.075);
        const dev = `${view.n} ${view.n === 1 ? 'Gerät' : 'Geräte'}`;
        ctx.fillStyle = 'rgba(160,168,210,0.8)';
        ctx.font = `500 ${Math.round(fs * 0.36)}px ${SANS}`;
        ctx.fillText(view.best ? `Bestzeit ${fmtTime(view.best)} · ${dev}` : `Noch keine Bestzeit für ${dev}`, cx, H * 0.075 + fs * 0.78);
      }
    }

    const needsStartView = () => view.tm || view.gm === 'staffel' || view.gm === 'rhythmus';

    function frame(now) {
      draw(now);
      requestAnimationFrame(frame);
    }

    // ================= Bedienung =================
    function buildQr() {
      const qr = qrcode(0, 'M');
      qr.addData(link);
      qr.make();
      $('qrImg').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
      $('qrLink').textContent = link.replace(/^https?:\/\//, '');
    }

    $('qrBox').addEventListener('click', () => $('qrBox').classList.toggle('big'));

    async function copyLink() {
      try { await navigator.clipboard.writeText(link); $('copyBtn').textContent = 'Kopiert ✓'; } catch (e) { window.prompt('Spieler-Link:', link); }
      setTimeout(() => { $('copyBtn').textContent = 'Spieler-Link kopieren'; }, 2000);
    }

    function markSettings() {
      const mark = (attr, value) => document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(parseInt(b.dataset[attr], 10) === value)));
      document.querySelectorAll('[data-gm]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.gm === st.gm)));
      mark('tm', st.tm);
      mark('gn', st.gn);
      mark('nl', st.nl);
      mark('bpm', st.bpm);
      mark('pen', st.pen);
      document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== st.gm; });
      $('gmInfo').textContent = INFO[st.gm];
      $('gnLabel').textContent = GN_LABEL[st.gm];
    }

    $('gear').addEventListener('click', () => {
      $('roomInput').value = room;
      $('sndBtn').textContent = soundOn ? 'Ton: an' : 'Ton: aus';
      $('restartBtn').hidden = isHost !== true;
      $('modeBox').hidden = isHost !== true;
      markSettings();
      $('dlg').showModal();
    });
    $('dlgClose').addEventListener('click', () => $('dlg').close());
    $('copyBtn').addEventListener('click', copyLink);
    $('sndBtn').addEventListener('click', () => {
      soundOn = !soundOn;
      LK.store.set('lk_board_snd', soundOn ? '1' : '0');
      if (soundOn) LK.audio.init();
      $('sndBtn').textContent = soundOn ? 'Ton: an' : 'Ton: aus';
    });
    $('fsBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    });
    $('restartBtn').addEventListener('click', () => {
      if (isHost !== true) return;
      resetRound(true);
      publish();
      $('dlg').close();
    });

    function onSetting(attr, key, parse) {
      document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
        if (isHost !== true) return;
        applySettings({ [key]: parse(b.dataset[attr]) });
        markSettings();
      }));
    }
    onSetting('gm', 'gm', (v) => v);
    onSetting('tm', 'tm', (v) => parseInt(v, 10));
    onSetting('gn', 'gn', (v) => parseInt(v, 10));
    onSetting('nl', 'nl', (v) => parseInt(v, 10));
    onSetting('bpm', 'bpm', (v) => parseInt(v, 10));
    onSetting('pen', 'pen', (v) => parseInt(v, 10));

    // Gerät auf der Tafel antippen: Einstellungen nur für dieses Gerät
    let devId = null;
    function markDev() {
      const c = cfgAll[devId] || {};
      document.querySelectorAll('#devDlg [data-cfg]').forEach((seg) => {
        const cur = c[seg.dataset.cfg] === undefined ? '' : String(c[seg.dataset.cfg]);
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cur)));
      });
    }
    function openDev(id) {
      devId = id;
      const n = nodes[id];
      $('devTitle').innerHTML = `<span class="devshape" style="color:${n.col}">${LK.shapeSvg(n.slot)}</span> Gerät`;
      markDev();
      $('devDlg').showModal();
    }
    cv.addEventListener('click', (e) => {
      if (isHost !== true || $('dlg').open || $('devDlg').open || !$('startOv').hidden) return;
      const R = baseR();
      let best = null;
      let bd = Infinity;
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        if (n.dying) return;
        const d = Math.hypot(n.x - e.clientX, n.y - e.clientY);
        if (d < R * 2.2 && d < bd) { bd = d; best = id; }
      });
      if (best) openDev(best);
    });
    document.querySelectorAll('#devDlg [data-cfg]').forEach((seg) => seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || devId === null) return;
      const type = seg.dataset.type;
      const v = b.dataset.v;
      let value = null;
      if (v !== '') value = type === 'float' ? parseFloat(v) : (type === 'int' ? parseInt(v, 10) : v);
      setDeviceCfg(devId, seg.dataset.cfg, value);
      markDev();
    }));
    $('devReset').addEventListener('click', () => {
      if (devId === null) return;
      delete cfgAll[devId];
      saveCfg();
      if (peers[devId]) { peers[devId].nt = false; peers[devId].pn = false; }
      publish();
      markDev();
    });
    $('devClose').addEventListener('click', () => $('devDlg').close());

    $('goBtn').addEventListener('click', startCountdown);
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !$('goBtn').hidden && !$('dlg').open && document.activeElement === document.body) {
        e.preventDefault();
        startCountdown();
      }
    });

    $('roomForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const v = $('roomInput').value.trim().toLowerCase();
      if (!LK.validRoom(v)) { $('roomErr').hidden = false; return; }
      LK.store.set('lk_board_room', v);
      location.href = `${location.href.split('?')[0]}?tafel=1&r=${v}`;
    });
    $('newRoomBtn').addEventListener('click', () => {
      const v = LK.rid(10);
      LK.store.set('lk_board_room', v);
      location.href = `${location.href.split('?')[0]}?tafel=1&r=${v}`;
    });

    $('startBtn').addEventListener('click', () => {
      LK.audio.init();
      LK.keepAwake();
      $('startOv').hidden = true;
    });

    buildQr();
    resize();
    setConn(false);
    requestAnimationFrame(frame);
    net.start();
  };
})(window.LK);
