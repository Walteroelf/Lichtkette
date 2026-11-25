'use strict';

// Tafel (Beamer / Smartboard): zeigt das Spiel und lenkt es.
// Die Haupt-Tafel ("Host") entscheidet, wer das Licht bekommt. Eine zweite Tafel schaut nur mit.
//
// Spielarten (gm):
//   klassik   ein Licht, zufällig von Gerät zu Gerät, optional als Zeitspiel mit Bestzeit
//   staffel   zwei Teams, jedes mit eigenem Licht, wer zuerst die Weitergaben schafft, gewinnt
//   doppel    zwei oder drei Lichter gleichzeitig
//   schatz    ein Licht sammelt Sterne ein, die bei einzelnen Geräten liegen
(function (LK) {
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const FINALE_MS = 5200;
  const GONE_MS = 14000; // so lange ohne Lebenszeichen, dann fliegt ein Gerät aus dem Spiel
  // Ziel pro Runde: 0 = automatisch, sonst 5 bis 100 in 5er-Schritten
  const validGn = (v) => v === 0 || (Number.isInteger(v) && ((v >= 5 && v <= 100 && v % 5 === 0) || (v >= 1 && v <= 20)));
  // Tauziehen: 1 bis 20 in 1er-Schritten. Alle anderen Spiele: 5 bis 100 in 5er-Schritten.
  const gnFix = (gm, v) => (v === 0 ? 0 : gm === 'zieh' ? Math.min(20, Math.max(1, v)) : Math.min(100, Math.max(5, Math.round(v / 5) * 5)));
  const NL_OPTIONS = [2, 3];
  const PEN_OPTIONS = [0, 2, 4]; // Strafpause in Sekunden bei einem Fehltipp (0 = aus)
  const GAMES = ['klassik', 'basal', 'staffel', 'zieh', 'doppel', 'schatz', 'dunkel', 'muster', 'bild', 'geheim', 'extrem'];
  const TITLES = { klassik: 'Lichtkette', basal: 'Basal', staffel: 'Staffel', zieh: 'Tauziehen', dunkel: 'Die Dunkelheit', muster: 'Muster nachspielen', bild: 'Lichtbild', geheim: 'Geheime Reihenfolge', extrem: 'Lichtkette extrem', doppel: 'Doppelte Lichter', schatz: 'Schatz-Licht' };
  const INFO = {
    basal: 'Ganz einfach: Das Licht wandert ohne Zeitdruck und ohne Ziel von Gerät zu Gerät. Jede Weitergabe klingt. Große feste Tippfläche.',
    klassik: 'Ein Licht wandert zufällig von Gerät zu Gerät. Wahlweise als Zeitspiel mit Bestzeit.',
    staffel: 'Zwei Teams, jedes mit eigenem Licht. Wer zuerst die Weitergaben schafft, gewinnt.',
    doppel: 'Zwei oder drei Lichter gleichzeitig. Jedes Gerät hat höchstens ein Licht.',
    schatz: 'Das Licht sammelt Sterne ein, die bei einzelnen Geräten liegen.',
    zieh: 'Zwei Teams ziehen an einem Seil. Jede Weitergabe zieht den Punkt zur eigenen Seite.',
    dunkel: 'Ein Schatten wächst. Jede Weitergabe drängt ihn zurück. Alle zusammen gegen die Dunkelheit.',
    muster: 'Die Tafel zeigt eine Reihenfolge von Geräten. Die Gruppe spielt sie nach. Jede Runde wird sie länger.',
    bild: 'Jede Weitergabe zieht eine Lichtlinie. Am Ende steht ein gemeinsames Bild, das man speichern kann.',
    geheim: 'Das Licht geht in einer geheimen Reihenfolge weiter. Die Gruppe findet heraus, wer als Nächstes dran ist.',
    extrem: 'Staffel mit Spur: Wer das Licht hat, zieht erst einen Punkt eine Spur entlang. Dann leuchtet das Symbol auf und das Licht geht weiter. Die Stufe passt sich jedem Kind an.'
  };
  const GN_LABEL = {
    klassik: 'Weitergaben pro Runde',
    basal: '',
    staffel: 'Weitergaben pro Team',
    doppel: 'Weitergaben insgesamt',
    schatz: 'Sterne pro Runde',
    zieh: 'Schritte Vorsprung zum Sieg',
    dunkel: 'Weitergaben bis zum Sieg',
    muster: 'Runden bis zum Sieg',
    bild: 'Weitergaben pro Bild',
    geheim: 'Stationen (höchstens so viele wie Geräte)',
    extrem: 'Weitergaben pro Team',
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
    let finishing = false;
    let finTimer = null;
    let cdTimer = null;
    let decideTimer = null;
    // Neue Spielarten: Dunkelheit (dk*), Muster (mu*), Geheime Reihenfolge (ge*)
    // Dunkelheit wächst pro Sekunde. Stufe 1 braucht etwa 90 Sekunden bis ganz dunkel, Stufe 10 etwa 11 Sekunden (gleichmäßig abgestuft)
    const dkBase = (l) => 1 / (90 * Math.pow(11 / 90, (Math.max(1, Math.min(10, l)) - 1) / 9));
    const DK_PUSH = 0.035; // so viel drängt jede Weitergabe sie zurück
    let dkStamp = 0;
    let dkTimer = null;
    let muTimer = null;
    let muIdle = null;
    let geLockT = null;
    let geRoute = [];
    const lastTapAt = {};
    let token = 0;
    const penUntil = [0, 0]; // Staffel: bis wann das Licht des Teams wegen eines Fehltipps pausiert
    // Vorgaben der Tafel pro Gerät (überstimmen die Einstellung am Gerät). Fehlt ein Wert, entscheidet das Gerät selbst.
    // pn Strafe bei Fehltipps 0/1, sz Größe des Punkts 0.7/1/1.4, rnd springender Punkt 0/1,
    // nt Zeit zählt nicht 0/1, w Weiterwandern 0/10/30 s, tt Team a/b/x (x = automatisch)
    let cfgAll = {};
    try { cfgAll = JSON.parse(LK.store.get('lk_cfg', '{}')) || {}; } catch (e) { cfgAll = {}; }
    const saveCfg = () => LK.store.set('lk_cfg', JSON.stringify(cfgAll));
    // Lehrer-Gerät: Der geheime Schlüssel liegt nur auf diesem Tafel-Gerät und im Lehrer-QR.
    // Befehle des Lehrer-Geräts und die privaten Infos an das Lehrer-Gerät sind damit verschlüsselt.
    let tSecret = LK.store.get('lk_tkey', '');
    if (!/^[a-z0-9]{24}$/.test(tSecret)) { tSecret = LK.rid(24); LK.store.set('lk_tkey', tSecret); }
    let tKeyP = LK.tcrypto.available ? LK.tcrypto.derive(tSecret) : null;
    const seenCmds = [];
    let lastPrivAt = 0;
    let lastEcho = ''; // Kennung des letzten "Verbindung testen"-Befehls, die Antwort geht an das Lehrer-Gerät zurück
    let soundOn = LK.store.get('lk_board_snd', '1') === '1';
    let since = Date.now(); // Zeitspiel: Beginn des gerade laufenden Zeitabschnitts

    const readNum = (key, opts, d) => { const v = parseInt(LK.store.get(key, String(d)), 10); return opts.includes(v) ? v : d; };
    const gmStored = LK.store.get('lk_gm', 'klassik');
    let st = {
      epoch: Date.now(), seq: 0, gm: GAMES.includes(gmStored) ? gmStored : 'klassik',
      lights: [], // { h: Halter, p: vorheriger Halter, k: Nr., s: Kennung, a: Auto-ms, z: Pause }
      chain: 0, goal: 8, round: 1, finale: false, players: {}, team: {}, tc: [0, 0], win: -1,
      stars: [], sc: 0,
      // Staffel: ser = Siegpunkte bis zum Seriensieg (0 = keine Serie, 2 = Best of 3, 3 = Best of 5), sw = Siege je Team, sd = Serie entschieden
      // tsel = 1: Schüler wählen ihr Team selbst, sk = Zähler für "Teams neu würfeln"
      ser: readNum('lk_ser', [0, 2, 3], 0), sw: [0, 0], sd: 0, tsel: readNum('lk_ts', [0, 1], 0), sk: 0,
      tm: LK.store.get('lk_tm', '0') === '1' ? 1 : 0,
      gn: (() => { const v = parseInt(LK.store.get('lk_gn', '0'), 10); return validGn(v) ? v : 0; })(),
      dkv: readNum('lk_dkv2', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4), mt: readNum('lk_mt', [1, 2, 3], 1), xl: readNum('lk_xl', [1, 2, 3, 4, 5, 6], 2), xa: readNum('lk_xa', [0, 1], 1), sb: readNum('lk_sb', [0, 1], 0), mf: readNum('lk_mf', [0, 1], 0), dk: 0, dkr: 0, lost: 0, mu: null, ge: null, nl: readNum('lk_nl', NL_OPTIONS, 2),
      pen: readNum('lk_pen', PEN_OPTIONS, 0), cfg: {}, paused: false,
      // Nach einer Runde: 1 = wartet auf den Knopf "Neue Runde" (Standard), 0 = geht automatisch weiter
      nr: readNum('lk_nr', [0, 1], 1),
      // Schatz-Licht: sp = Sterne pro Schatz (1, 2, 3, 5 oder 0 = steigend), sj = Stern springt nach so vielen Sekunden weiter (0 = bleibt)
      sp: readNum('lk_sp2', [0, 1, 2, 3, 5], 1), // neuer Schlüssel: ein Stern pro Schatz ist die Standardeinstellung, auch wenn früher etwas anderes gespeichert war
      sj: readNum('lk_sj', [0, 3, 4, 6], 0),
      // Zeitspiel: ph = ready | count | play, acc = gezählte Zeit in ms, run = Uhr läuft,
      // ft = Endzeit, rec = 1 neue Bestzeit / 2 erste Zeit, n = Geräteanzahl für die Bestzeit
      ph: 'play', acc: 0, run: false, ft: 0, rec: 0, best: 0, n: 0, cd: 0,
      host: boardId, ts: 0,
    };
    // Bestzeit gilt nur für gleich viele Weitergaben UND gleich viele Geräte, sonst ist sie nicht vergleichbar
    const bestFor = (goal, n) => parseInt(LK.store.get(`lk_best_${goal}_${n}`, '0'), 10) || 0;

    const net = new LK.Net(room, startBroker, ['hb', 'act', 'miss', 'star', 'tap', 'host', 'state', 'tcmd']);

    // ================= Spiellogik (nur Haupt-Tafel) =================
    const aliveIds = () => Object.keys(st.players);
    const isTm = () => st.tm === 1 && st.gm === 'klassik';
    const needsStart = () => true; // jedes Spiel wartet auf "Spiel starten" und zählt dann 3, 2, 1
    const isNt = (id) => !!(peers[id] && peers[id].nt);

    function freeSlot(id) {
      const used = new Set(Object.values(st.players));
      if (slotMem[id] !== undefined && !used.has(slotMem[id])) return slotMem[id];
      for (let i = 0; i < LK.MAX_PLAYERS; i++) if (!used.has(i)) return i;
      return -1;
    }

    // Staffel: Wunschteam des Geräts (a/b) oder das kleinere Team
    const ttPref = (id) => { const p = peers[id] && peers[id].tt; return p === 'a' ? 0 : (p === 'b' ? 1 : -1); };
    // Festes Team (Tafel oder Gerät) geht vor, sonst die eigene Wahl des Schülers (nur wenn "Schüler wählen" an ist)
    const teamPref = (id) => {
      const t = ttPref(id);
      if (t >= 0) return t;
      const q = st.tsel === 1 && peers[id] ? peers[id].tp : '';
      return q === 'a' ? 0 : (q === 'b' ? 1 : -1);
    };
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
    // Teams bleiben von Runde zu Runde gleich. Neu verteilt wird nur, wenn jemand ein Team wählt oder "Teams neu würfeln" gedrückt wird.
    function assignAllTeams() {
      const old = st.team || {};
      st.team = {};
      aliveIds().forEach((id) => {
        const t = teamPref(id);
        if (t >= 0) { st.team[id] = t; teamMem[id] = t; } else if (old[id] === 0 || old[id] === 1) st.team[id] = old[id];
      });
      aliveIds().filter((id) => st.team[id] === undefined).forEach(assignTeam);
    }

    // Teams neu würfeln (nur vor dem Start): Geräte mit "Zeit zählt nicht" werden gleichmäßig verteilt, feste Teams bleiben
    function shakeTeams() {
      if (isHost !== true || !LK.isTeamGm(st.gm) || st.ph !== 'ready') return;
      st.sk = (st.sk || 0) + 1;
      Object.keys(peers).forEach((k) => { peers[k].tp = ''; });
      st.team = {};
      const cnt = [0, 0];
      const ntc = [0, 0];
      const ids = aliveIds();
      ids.forEach((id) => {
        const t = ttPref(id);
        if (t >= 0) { st.team[id] = t; cnt[t]++; if (isNt(id)) ntc[t]++; }
      });
      const free = ids.filter((id) => st.team[id] === undefined);
      for (let i = free.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [free[i], free[j]] = [free[j], free[i]]; }
      const order = free.filter(isNt).concat(free.filter((id) => !isNt(id)));
      const pick = (a, b) => (a === b ? -1 : (a < b ? 0 : 1));
      order.forEach((id) => {
        let t = isNt(id) ? pick(ntc[0], ntc[1]) : -1;
        if (t < 0) t = pick(cnt[0], cnt[1]);
        if (t < 0) t = Math.random() < 0.5 ? 0 : 1;
        st.team[id] = t;
        cnt[t]++;
        if (isNt(id)) ntc[t]++;
      });
      ids.forEach((id) => { teamMem[id] = st.team[id]; });
      st.seq++;
      publish();
    }

    function addPlayer(id) {
      if (st.players[id] !== undefined) return false;
      const s = freeSlot(id);
      if (s < 0) return false;
      st.players[id] = s;
      slotMem[id] = s;
      if (LK.isTeamGm(st.gm)) assignTeam(id);
      return true;
    }

    function removePlayer(id) {
      delete st.players[id];
      delete st.team[id];
      Object.keys(bags).forEach((k) => { bags[k] = bags[k].filter((x) => x !== id); });
      st.stars = st.stars.filter((x) => x !== id);
      if (st.ph === 'play' && !st.finale) {
        if (st.gm === 'muster' && st.mu && st.mu.sq.includes(id)) muStart(st.mu.lv, false);
        if (st.gm === 'geheim' && geRoute.includes(id)) geBegin();
      }
    }

    function poolIds(li) {
      return LK.isTeamGm(st.gm) ? aliveIds().filter((id) => st.team[id] === li) : aliveIds();
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
      const key = LK.isTeamGm(st.gm) ? `t${li}` : 'all';
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
      if (LK.isTeamGm(st.gm)) return 2;
      if (st.gm === 'muster') return 0;
      if (st.gm === 'doppel') return Math.max(1, Math.min(st.nl, aliveIds().length - 1));
      return 1;
    }

    // Zeit pro Weitergabe (nur auf der Tafel, zum Einstellen der Schwierigkeit pro Gerät)
    const holdSince = {};
    let passStats = {};
    function setLight(li, next) {
      rollClock();
      const l = st.lights[li];
      if (l.h && holdSince[l.h] && st.ph === 'play' && !st.paused && !st.finale) {
        const d = Date.now() - holdSince[l.h];
        if (d > 150 && d < 90000) { const q = passStats[l.h] || (passStats[l.h] = { n: 0, sum: 0 }); q.n++; q.sum += d; }
      }
      holdSince[l.h] = 0;
      if (next) holdSince[next] = Date.now();
      l.p = l.h;
      l.h = next;
      l.a = 0;
      l.z = false;
      l.s = ++token;
      // Schatz-Licht: Liegt bei diesem Gerät ein Schatz, steht fest, wie viele Sterne es einzusammeln hat
      l.n = 0;
      l.r = 0;
      if (st.gm === 'schatz' && next && st.stars.includes(next)) { l.n = starsPerTreasure(); l.r = l.n; }
      clearTimeout(autoTimers[li]);
      if (next && !isTm() && !LK.isTeamGm(st.gm) && st.gm !== 'geheim' && !st.paused) {
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
      while (st.lights.length < D) st.lights.push({ h: null, p: null, k: st.lights.length, s: ++token, a: 0, z: false, n: 0, r: 0 });
      st.lights.forEach((l, i) => {
        if (l.h && st.players[l.h] === undefined) { l.p = l.h; l.h = null; }
        if (!l.h && st.gm !== 'geheim') { const n = pickFor(i); if (n) setLight(i, n); }
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

    // Der Schatz bei diesem Gerät ist komplett eingesammelt: Er verschwindet, ein neuer liegt woanders
    function collectStar(id) {
      const i = st.stars.indexOf(id);
      if (i < 0) return;
      st.stars.splice(i, 1);
      ensureStars();
    }

    // Wie viele Sterne hat ein Schatz gerade? Fest 1, 2, 3, 5, oder steigend: alle 4 eingesammelten Sterne einer mehr (höchstens 5)
    function starsPerTreasure() {
      if (st.sp > 0) return st.sp;
      return Math.min(5, 1 + Math.floor(st.sc / 4));
    }

    // Ein Gerät meldet, wie viele Sterne es insgesamt angetippt hat. Jeder Stern zählt sofort zum Ziel.
    function starsTaken(li, count) {
      const l = st.lights[li];
      if (!l || !l.h || !(l.r > 0)) return false;
      const newR = Math.max(0, l.n - Math.min(Math.max(0, count), l.n));
      if (newR >= l.r) return false;
      st.sc += l.r - newR;
      l.r = newR;
      if (l.r === 0) collectStar(l.h);
      return true;
    }

    // collect: Das Gerät meldet, dass es auch den Stern angetippt hat (Schatz-Licht). Ohne Meldung bleibt der Stern liegen.
    function reqPass(li, collect) {
      passLight(li, !!collect);
    }

    function passLight(li, collect) {
      if (st.finale || st.ph !== 'play' || finishing || st.paused) return;
      const l = st.lights[li];
      if (!l || !l.h || l.z) return;
      st.chain++;
      if (LK.isTeamGm(st.gm)) st.tc[li]++;
      // Schatz-Licht, "ein Tipp reicht": Beim Weitergeben werden alle noch offenen Sterne dieses Geräts eingesammelt.
      // Wer die Sterne einzeln antippt, hat sie schon vorher gemeldet. Läuft nur die Zeit ab, bleibt der Rest liegen.
      if (st.gm === 'schatz' && collect && l.r > 0) {
        st.sc += l.r;
        l.r = 0;
        collectStar(l.h);
      }
      const done = st.gm === 'basal' ? false : st.gm === 'zieh' ? Math.abs(st.tc[0] - st.tc[1]) >= st.goal
        : (LK.isTeamGm(st.gm) ? st.tc[li] >= st.goal : (st.gm === 'schatz' ? st.sc >= st.goal : st.chain >= st.goal));
      if (done) { startFinale(li); return; }
      setLight(li, pickFor(li));
      if (st.gm === 'dunkel') dkSet(Math.max(0, dkLevel() - DK_PUSH), dkRate()); // jede Weitergabe drängt den Schatten zurück
      publish();
    }

    function computeGoal() {
      if (st.gm === 'basal') return 0; // endlos
      if (st.gn > 0) return st.gn;
      switch (st.gm) {
        case 'klassik': return isTm() ? 10 : Math.max(8, aliveIds().length * 3);
        case 'doppel': return 12;
        case 'staffel': return 12;
        case 'extrem': return 8;
        case 'zieh': return 10;
        case 'dunkel': return 20;
        case 'muster': return 6;
        case 'bild': return 25;
        case 'geheim': return Math.max(3, Math.min(aliveIds().length, 8));
        default: return 20; // schatz: Sterne
      }
    }

    // ================= Neue Spielarten =================
    // Die Dunkelheit: ein gemeinsamer Schatten, der langsam wächst. Er steht still, solange ein Gerät mit "Zeit zählt nicht" das Licht hat.
    function dkRate() {
      const l = st.lights[0];
      if (st.gm !== 'dunkel' || st.ph !== 'play' || st.finale || finishing || st.paused || !l || !l.h || l.z || isNt(l.h)) return 0;
      const ramp = 1 + 1.5 * Math.min(1, st.chain / Math.max(1, st.goal)); // wird zum Ende hin schneller
      return dkBase(st.dkv || 4) * ramp;
    }
    const dkLevel = () => Math.min(1, Math.max(0, st.dk + st.dkr * ((Date.now() - dkStamp) / 1000)));
    function dkSet(level, rate) { st.dk = level; st.dkr = rate; dkStamp = Date.now(); }
    function dkTick() {
      if (isHost !== true || st.gm !== 'dunkel' || st.ph !== 'play' || st.finale || finishing) return;
      const lvl = dkLevel();
      if (lvl >= 1) { dkSet(1, 0); startFinale(-1, true); return; }
      const r = dkRate();
      if (r !== st.dkr) { dkSet(lvl, r); publish(); }
    }

    // Muster nachspielen: Die Tafel lässt Geräte nacheinander aufleuchten, die Gruppe tippt sie in dieser Reihenfolge nach.
    function muBuild(lv) {
      const ids = aliveIds();
      const sq = [];
      for (let i = 0; i < Math.min(8, 2 + lv); i++) {
        const cand = ids.filter((id) => id !== sq[i - 1]);
        sq.push(cand[Math.floor(Math.random() * cand.length)]);
      }
      return sq;
    }
    function muStart(lv, again) {
      clearTimeout(muTimer);
      clearTimeout(muIdle);
      if (isHost !== true || st.gm !== 'muster') return;
      const old = st.mu || {};
      const keep = !!(again && old.sq && old.sq.length && old.sq.every((id) => st.players[id] !== undefined));
      if (aliveIds().length < 2) {
        st.mu = { ph: 'wait', sq: [], i: 0, cur: null, fk: old.fk || 0, tk: old.tk || 0, tl: null, bad: old.bad || 0, bl: null, lv, ag: 0 };
        publish();
        return;
      }
      // Die Spielleitung bestimmt den Ablauf: erst "Reihenfolge zeigen", dann "Jetzt nachspielen"
      st.mu = { ph: 'ready', sq: keep ? old.sq : muBuild(lv), i: 0, cur: null, fk: old.fk || 0, tk: old.tk || 0, tl: null, bad: old.bad || 0, bl: old.bl || null, lv, ag: keep ? 1 : 0 };
      st.seq++;
      publish();
    }
    // Spielleitung: Reihenfolge abspielen
    function muShowNow() {
      const mu = st.mu;
      if (isHost !== true || st.gm !== 'muster' || !mu || (mu.ph !== 'ready' && mu.ph !== 'shown') || st.finale || st.paused) return;
      clearTimeout(muTimer);
      mu.ph = 'show';
      mu.cur = null;
      mu.si = -1;
      mu.i = 0;
      publish();
      muTimer = setTimeout(() => muShow(0), 900);
    }
    // Spielleitung: Jetzt spielen die Schüler die Reihenfolge nach
    function muGoNow() {
      const mu = st.mu;
      if (isHost !== true || st.gm !== 'muster' || !mu || !(mu.ph === 'shown' || (mu.ph === 'ready' && mu.ag)) || st.finale || st.paused) return;
      mu.ph = 'go';
      mu.i = 0;
      mu.cur = null;
      publish();
    }
    function muAdvance() {
      if (!st.mu) return;
      if (st.mu.ph === 'ready') muShowNow();
      else if (st.mu.ph === 'shown') muGoNow();
    }
    function muShow(k) {
      const mu = st.mu;
      if (isHost !== true || st.gm !== 'muster' || !mu || st.finale) return;
      if (st.paused) { muTimer = setTimeout(() => muShow(k), 500); return; }
      if (k >= mu.sq.length) { mu.cur = null; mu.ph = 'shown'; mu.i = 0; publish(); return; }
      mu.cur = mu.sq[k];
      mu.si = k;
      mu.fk++;
      publish();
      muTimer = setTimeout(() => {
        if (st.mu !== mu) return;
        mu.cur = null;
        publish();
        muTimer = setTimeout(() => muShow(k + 1), 350);
      }, 850);
    }
    function muTap(id) {
      const mu = st.mu;
      if (!mu || mu.ph !== 'go') return;
      if (id === mu.sq[mu.i]) {
        mu.i++;
        mu.tk++;
        mu.tl = id;
        if (mu.i >= mu.sq.length) {
          mu.ph = 'next';
          st.chain++;
          clearTimeout(muIdle);
          if (st.chain >= st.goal) { startFinale(-1); return; }
          publish();
          muTimer = setTimeout(() => muStart(mu.lv + 1, false), 2000);
          return;
        }
        publish();
      } else {
        // Falsche Reihenfolge: ohne Strafe, die Folge läuft noch einmal ab
        mu.bad++;
        mu.bl = id;
        mu.ph = 'again';
        publish();
        muTimer = setTimeout(() => muStart(mu.lv, true), 1800);
      }
    }

    // Geheime Reihenfolge: Das Licht darf nur in einer verborgenen Reihenfolge weiter. Die anderen Geräte raten, wer als Nächstes dran ist.
    function geLock(ms) {
      const ge = st.ge;
      ge.lk = 1;
      clearTimeout(geLockT);
      geLockT = setTimeout(() => { if (st.ge === ge) { ge.lk = 0; publish(); } }, ms);
    }
    function geBegin() {
      clearTimeout(geLockT);
      const ids = aliveIds();
      st.chain = 0;
      const old = st.ge || {};
      if (ids.length < 2) { geRoute = []; st.ge = { i: 0, ex: [], lk: 0, bad: null, bk: old.bk || 0, n: 0 }; st.goal = 1; return; }
      const route = ids.slice();
      for (let i = route.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [route[i], route[j]] = [route[j], route[i]]; }
      geRoute = route.slice(0, Math.max(2, Math.min(st.gn || computeGoal(), ids.length, 10)));
      st.ge = { i: 0, ex: [], lk: 0, bad: null, bk: old.bk || 0, n: geRoute.length };
      st.goal = geRoute.length - 1;
      if (!st.lights.length) ensureLights();
      if (st.lights[0]) setLight(0, geRoute[0]);
    }
    // Zum Schluss wird die ganze Reihe noch einmal vorgespielt, Gerät für Gerät, mit Verbindungslinien
    function geReplay(k) {
      const ge = st.ge;
      if (isHost !== true || st.gm !== 'geheim' || !ge || st.finale) return;
      clearTimeout(geLockT);
      if (k === 0) { ge.rp = 1; ge.rt = geRoute.slice(); ge.fk = (ge.fk || 0); ge.lk = 1; }
      if (st.paused) { geLockT = setTimeout(() => geReplay(k), 500); return; }
      if (k >= geRoute.length) {
        ge.cur = null;
        publish();
        geLockT = setTimeout(() => startFinale(-1), 1200);
        return;
      }
      ge.cur = geRoute[k];
      ge.ri = k;
      ge.fk++;
      publish();
      geLockT = setTimeout(() => geReplay(k + 1), 900);
    }
    function geTap(id) {
      const ge = st.ge;
      const l = st.lights[0];
      if (!ge || ge.rp || !l || !l.h || ge.lk || id === l.h || ge.ex.includes(id) || geRoute.length < 2) return;
      if (id === geRoute[ge.i + 1]) {
        ge.i++;
        ge.ex = [];
        st.chain++;
        setLight(0, id);
        if (ge.i >= geRoute.length - 1) { geReplay(0); return; }
        geLock(1000);
      } else {
        ge.ex.push(id);
        ge.bad = id;
        ge.bk++;
        geLock(1800);
      }
      publish();
    }

    // Ein Gerät tippt (Muster nachspielen, Geheime Reihenfolge)
    function onTap(m) {
      if (isHost !== true || typeof m.id !== 'string' || st.ph !== 'play' || st.finale || finishing || st.paused) return;
      if (m.epoch !== st.epoch || st.players[m.id] === undefined) return;
      const now = Date.now();
      if (lastTapAt[m.id] && now - lastTapAt[m.id] < 500) return; // Prellen und Doppeltipp zählen nicht
      lastTapAt[m.id] = now;
      if (st.gm === 'muster') muTap(m.id);
      else if (st.gm === 'geheim') geTap(m.id);
    }
    function gameEnsure() {
      if (st.ph !== 'play' || st.finale) return;
      if (st.gm === 'muster' && (!st.mu || st.mu.ph === 'wait')) muStart(st.mu ? st.mu.lv : 1, false);
      if (st.gm === 'geheim' && geRoute.length < 2) geBegin();
    }

    // Neue Runde. Wo es nötig ist, wartet sie auf "Los", sonst geht das Spiel gleich los.
    // afterFinale: Die Runde ging gerade zu Ende. Je nach Einstellung wartet die nächste dann auf den Knopf "Neue Runde".
    function resetRound(bump, afterFinale, keepSeries) {
      clearTimeout(finTimer);
      clearTimeout(cdTimer);
      if (!afterFinale) passStats = {};
      st.lights.forEach((l, i) => clearTimeout(autoTimers[i]));
      finishing = false;
      penUntil[0] = 0;
      penUntil[1] = 0;
      st.paused = false;
      if (bump) st.round++;
      st.finale = false;
      st.chain = 0;
      st.tc = [0, 0];
      st.win = -1;
      st.lost = 0;
      clearInterval(dkTimer);
      clearTimeout(muTimer);
      clearTimeout(muIdle);
      clearTimeout(geLockT);
      st.dk = 0;
      st.dkr = 0;
      st.mu = null;
      st.ge = null;
      geRoute = [];
      if (st.sd || (!afterFinale && !keepSeries)) { st.sw = [0, 0]; st.sd = 0; }
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
      if (LK.isTeamGm(st.gm)) assignAllTeams(); else st.team = {};
      st.ph = (needsStart() || (afterFinale && st.nr === 1)) ? 'ready' : 'play';
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
      if (st.gm === 'dunkel') { dkSet(0.12, dkRate()); clearInterval(dkTimer); dkTimer = setInterval(dkTick, 250); }
      if (st.gm === 'muster') muStart(1, false);
      if (st.gm === 'geheim') geBegin();
      updateClockRun();
    }

    function startCountdown() {
      if (isHost !== true || st.ph !== 'ready' || !aliveIds().length) return;
      if (LK.isTeamGm(st.gm)) assignAllTeams();
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

    // Einstellungsfenster passen immer auf den Bildschirm: zu hoher Inhalt wird verkleinert statt gescrollt
    function fitDialogs() {
      document.querySelectorAll('dialog[open]').forEach((d) => {
        d.style.zoom = '1';
        d.style.setProperty('--z', '1');
        const need = d.scrollHeight;
        const avail = window.innerHeight * 0.94;
        const z = need > avail ? Math.max(0.4, avail / need) : 1;
        d.style.setProperty('--z', String(z));
        d.style.zoom = String(z);
      });
    }
    setInterval(fitDialogs, 300);
    window.addEventListener('resize', fitDialogs);

    function applySettings(patch) {
      Object.assign(st, patch);
      if (st.gn > 0 && (st.gm === 'zieh' ? st.gn > 20 : st.gn % 5 !== 0)) st.gn = st.gm === 'zieh' ? 0 : gnFix(st.gm, st.gn); // passt nicht zum Spiel: zurück auf Auto bzw. 5er-Wert
      LK.store.set('lk_gm', st.gm);
      LK.store.set('lk_tm', String(st.tm));
      LK.store.set('lk_gn', String(st.gn));
      LK.store.set('lk_dkv2', String(st.dkv));
      LK.store.set('lk_mt', String(st.mt));
      LK.store.set('lk_xl', String(st.xl));
      LK.store.set('lk_xa', String(st.xa));
      LK.store.set('lk_sb', String(st.sb));
      LK.store.set('lk_mf', String(st.mf));
      LK.store.set('lk_nl', String(st.nl));
      LK.store.set('lk_pen', String(st.pen));
      LK.store.set('lk_nr', String(st.nr));
      LK.store.set('lk_sp2', String(st.sp));
      LK.store.set('lk_sj', String(st.sj));
      LK.store.set('lk_ser', String(st.ser));
      LK.store.set('lk_ts', String(st.tsel));
      resetRound(true);
      publish();
    }

    function startFinale(win, lost) {
      rollClock();
      clearTimeout(finTimer);
      clearInterval(dkTimer);
      clearTimeout(muTimer);
      clearTimeout(muIdle);
      clearTimeout(geLockT);
      if (st.gm === 'dunkel') dkSet(dkLevel(), 0);
      st.lost = lost ? 1 : 0;
      finishing = false;
      st.finale = true;
      st.win = LK.isTeamGm(st.gm) ? win : -1;
      if (LK.isTeamGm(st.gm) && win >= 0 && st.ser > 0) {
        st.sw[win]++;
        if (st.sw[win] >= st.ser) st.sd = 1;
      }
      if (isTm()) {
        st.ft = st.acc;
        const prevBest = bestFor(st.goal, st.n);
        st.rec = prevBest === 0 ? 2 : (st.ft < prevBest ? 1 : 0);
        if (prevBest === 0 || st.ft < prevBest) LK.store.set(`lk_best_${st.goal}_${st.n}`, String(st.ft));
        st.best = bestFor(st.goal, st.n);
      }
      st.lights.forEach((l, i) => { clearTimeout(autoTimers[i]); l.p = l.h; l.h = null; l.a = 0; l.z = false; l.n = 0; l.r = 0; l.s = ++token; });
      st.seq++;
      st.run = false;
      publish();
      finTimer = setTimeout(() => {
        if (isHost !== true) return;
        resetRound(true, true);
        publish();
      }, st.gm === 'bild' ? 90000 : (st.sd ? 11000 : ((isTm() || LK.isTeamGm(st.gm)) ? 8000 : FINALE_MS)));
    }

    // Staffel: Hat ein Gerät mit "Zeit zählt nicht" das Licht, wartet das andere Team, bis es weitergegeben hat.
    function calcFrozen() {
      const now = Date.now();
      st.lights.forEach((l, i) => {
        const o = st.lights[1 - i];
        const wait = !!(LK.isTeamGm(st.gm) && st.lights.length === 2 && l.h && o && o.h && isNt(o.h) && !isNt(l.h));
        l.pn = !!(LK.isTeamGm(st.gm) && l.h && penUntil[i] > now); // Strafpause nach einem Fehltipp im eigenen Team
        l.z = wait || l.pn;
      });
    }

    // Fehltipp eines Geräts (nur Staffel, nur wenn die Tafel Strafzeit eingeschaltet hat und das Gerät mitmacht)
    function onMiss(id) {
      if (!LK.isTeamGm(st.gm) || st.ph !== 'play' || st.finale || finishing || !st.pen) return;
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
      if (key === 'tt' && LK.isTeamGm(st.gm) && st.ph !== 'play' && peers[id]) {
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

    // ---- Pause ----
    function rearmAuto(li) {
      const l = st.lights[li];
      if (!l || !l.h || isTm() || LK.isTeamGm(st.gm) || st.gm === 'geheim') return;
      const w = (peers[l.h] && peers[l.h].w) || 0;
      if (w <= 0) return;
      l.a = w * 1000;
      const holder = l.h;
      clearTimeout(autoTimers[li]);
      autoTimers[li] = setTimeout(() => {
        if (isHost === true && st.lights[li] && st.lights[li].h === holder) reqPass(li);
      }, l.a);
    }

    function pauseGame(on) {
      if (isHost !== true) return;
      if (on) {
        if (st.ph !== 'play' || st.finale || finishing || st.paused) return;
        rollClock();
        st.paused = true;
        st.run = false;
        st.lights.forEach((l, i) => { clearTimeout(autoTimers[i]); l.a = 0; });
      } else {
        if (!st.paused) return;
        st.paused = false;
        since = Date.now();
        updateClockRun();
        st.lights.forEach((l, i) => rearmAuto(i));
      }
      publish();
    }

    // ---- Lehrer-Gerät: private Infos (verschlüsselt) und Befehle (verschlüsselt, mit Schlüssel geprüft) ----
    function resetDeviceCfg(id) {
      if (cfgAll[id] === undefined) return;
      delete cfgAll[id];
      saveCfg();
      if (peers[id]) { peers[id].nt = false; peers[id].pn = false; }
      publish();
    }

    // Was für ein Gerät gerade gilt: Vorgabe der Tafel, sonst das, was das Gerät meldet, sonst der Standard
    function effCfg(id) {
      const p = peers[id] || {};
      const c = cfgAll[id] || {};
      const rnd = c.rnd !== undefined ? c.rnd : (p.md === 'blick' ? 0 : 1);
      return {
        rnd,
        sz: c.sz !== undefined ? c.sz : (rnd === 1 ? 0.75 : 1),
        sa: c.sa !== undefined ? c.sa : (p.md === 'touch' ? 0 : 1),
        pn: p.pn ? 1 : 0,
        nt: p.nt ? 1 : 0,
        w: p.w || 0,
        tt: c.tt !== undefined ? c.tt : (p.tt || 'x'),
        mt: c.mt !== undefined ? c.mt : '',
      };
    }

    function privSnapshot() {
      const now = Date.now();
      return {
        t: now, gm: st.gm, tm: st.tm, gn: st.gn, nl: st.nl, dkv: st.dkv, pen: st.pen, nr: st.nr, sp: st.sp, sj: st.sj,
        mup: st.mu ? st.mu.ph : '', mag: st.mu ? st.mu.ag : 0,
        ser: st.ser, tsel: st.tsel, sw: st.sw, sd: st.sd, mt: st.mt, mf: st.mf, sb: st.sb, xl: st.xl, xa: st.xa,
        ph: st.ph, round: st.round, finale: st.finale, paused: !!st.paused,
        chain: st.chain, goal: st.goal, tc: st.tc, sc: st.sc, n: aliveIds().length,
        devices: aliveIds().map((id) => ({
          id,
          slot: st.players[id],
          team: st.team[id],
          holds: st.lights.some((l) => l.h === id),
          age: peers[id] ? now - peers[id].last : null,
          m: peers[id] ? peers[id].m : '',
          bv: peers[id] ? peers[id].bv : '',
          cfg: cfgAll[id] || {},
          eff: effCfg(id),
        })),
        // Diagnose: Was die Tafel selbst über sich weiß
        diag: {
          build: LK.BUILD,
          host: isHost === true,
          servers: net.links.map((l) => ({ name: l.name, ok: l.ok })),
          soundReady: LK.audio.ready,
          soundOn,
          awake: LK.isAwake(),
          echo: lastEcho,
        },
      };
    }

    async function sendPriv() {
      if (isHost !== true || !tKeyP) return;
      try {
        const box = await LK.tcrypto.seal(await tKeyP, privSnapshot());
        net.send('tpriv', box);
        lastPrivAt = Date.now();
      } catch (e) { /* kein Lehrer-Gerät oder keine Verschlüsselung verfügbar */ }
    }

    const CFG_RULES = {
      rnd: (v) => v === 0 || v === 1,
      sa: (v) => v === 0 || v === 1,
      pn: (v) => v === 0 || v === 1,
      nt: (v) => v === 0 || v === 1,
      sz: (v) => v === 0.35 || v === 0.75 || v === 1 || v === 1.4,
      w: (v) => LK.WAIT_OPTIONS.includes(v),
      mt: (v) => v === 1 || v === 2 || v === 3,
      tt: (v) => v === 'a' || v === 'b' || v === 'x',
    };

    function execCmd(cmd) {
      switch (cmd.c) {
        case 'settings': {
          const p = cmd.patch || {};
          const patch = {};
          if (GAMES.includes(p.gm)) patch.gm = p.gm;
          if (p.tm === 0 || p.tm === 1) patch.tm = p.tm;
          if (validGn(p.gn)) patch.gn = p.gn;
          if (Number.isInteger(p.dkv) && p.dkv >= 1 && p.dkv <= 10) patch.dkv = p.dkv;
          if ([1, 2, 3].includes(p.mt)) patch.mt = p.mt;
          if ([0, 1].includes(p.mf)) patch.mf = p.mf;
          if ([0, 1].includes(p.sb)) patch.sb = p.sb;
          if ([1, 2, 3, 4, 5, 6].includes(p.xl)) patch.xl = p.xl;
          if ([0, 1].includes(p.xa)) patch.xa = p.xa;
          if (NL_OPTIONS.includes(p.nl)) patch.nl = p.nl;
          if (PEN_OPTIONS.includes(p.pen)) patch.pen = p.pen;
          if (p.nr === 0 || p.nr === 1) patch.nr = p.nr;
          if ([0, 1, 2, 3, 5].includes(p.sp)) patch.sp = p.sp;
          if ([0, 3, 4, 6].includes(p.sj)) patch.sj = p.sj;
          if ([0, 2, 3].includes(p.ser)) patch.ser = p.ser;
          if (p.tsel === 0 || p.tsel === 1) patch.tsel = p.tsel;
          if (Object.keys(patch).length) applySettings(patch);
          break;
        }
        case 'go': if (st.gm === 'muster' && st.ph === 'play') muAdvance(); else startCountdown(); break;
        case 'muagain': muShowNow(); break;
        case 'mugo': muGoNow(); break;
        case 'restart': resetRound(true, false, true); publish(); break;
        case 'shake': shakeTeams(); break;
        case 'pause': pauseGame(!!cmd.on); break;
        case 'cfg':
          if (typeof cmd.id === 'string' && CFG_RULES[cmd.key] && (cmd.value === null || CFG_RULES[cmd.key](cmd.value))) {
            setDeviceCfg(cmd.id, cmd.key, cmd.value);
          }
          break;
        case 'cfgreset': if (typeof cmd.id === 'string') resetDeviceCfg(cmd.id); break;
        case 'blink': if (typeof cmd.id === 'string' && st.players[cmd.id] !== undefined) net.send('ping', { id: cmd.id }); break;
        case 'echo': lastEcho = cmd.cid; break; // Verbindung testen: Die Antwort steht im nächsten Stand
        case 'sound': soundOn = !!cmd.on; LK.store.set('lk_board_snd', soundOn ? '1' : '0'); break;
        default: break;
      }
      sendPriv();
    }

    net.on('tcmd', async (m) => {
      if (isHost !== true || !tKeyP) return;
      try {
        const cmd = await LK.tcrypto.open(await tKeyP, m); // null = falscher Schlüssel oder verändert
        if (!cmd || typeof cmd.c !== 'string' || typeof cmd.cid !== 'string') return;
        if (typeof cmd.ts !== 'number' || Math.abs(Date.now() - cmd.ts) > 10 * 60 * 1000) return;
        if (seenCmds.includes(cmd.cid)) return; // Wiederholung eines alten Befehls
        seenCmds.push(cmd.cid);
        if (seenCmds.length > 80) seenCmds.shift();
        execCmd(cmd);
      } catch (e) { console.error('Lichtkette: Befehl', e); }
    });

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
      // Dunkelheit: Der gesendete Stand muss der von jetzt sein, sonst springt die Anzeige bei jeder Meldung zurück und der Schatten wirkt kleiner, als er ist
      if (st.gm === 'dunkel') dkSet(dkLevel(), st.dkr);
      st.ts = Date.now();
      net.send('state', st);
      applyState(st);
      sendPriv();
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
      setInterval(sendPriv, 3000); // das Lehrer-Gerät bekommt auch ohne Spielzug regelmäßig den Stand
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
        tp: (m.tk === st.sk && (m.tp === 'a' || m.tp === 'b')) ? m.tp : '', // eigene Teamwahl, gilt nur nach dem letzten Würfeln
        md: ['touch', 'taster', 'blick'].includes(m.md) ? m.md : '',
        bv: typeof m.bv === 'string' ? m.bv.slice(0, 20) : '',
        xl: Number.isInteger(m.xl) && m.xl >= 1 && m.xl <= 6 ? m.xl : 0,
      };
      applyPeerCfg(m.id); // Vorgaben der Tafel gehen vor
      if (isHost !== true) return;
      const added = addPlayer(m.id);
      let changed = added;
      if (LK.isTeamGm(st.gm) && !added && st.players[m.id] !== undefined && st.ph === 'ready') {
        const pt = teamPref(m.id);
        if (pt >= 0 && st.team[m.id] !== pt) { st.team[m.id] = pt; teamMem[m.id] = pt; changed = true; }
      }
      if (added) { ensureLights(); ensureStars(); gameEnsure(); }
      if (changed || !prev || now - prev.last > 6000) publish();
    });

    net.on('act', (m) => {
      if (isHost !== true || st.finale || st.ph !== 'play' || finishing || st.paused) return;
      const li = st.lights.findIndex((l) => l.h === m.id);
      if (li < 0 || m.epoch !== st.epoch || m.s !== st.lights[li].s) return;
      // Schatz-Licht: Sterne, die das Gerät angetippt hat, zählen auch dann, wenn eine einzelne Meldung verloren ging
      if (st.gm === 'schatz' && typeof m.c === 'number' && m.c > 0) {
        starsTaken(li, Math.floor(m.c));
        if (st.sc >= st.goal) { startFinale(li); return; }
      }
      reqPass(li, m.k === 1);
    });

    net.on('tap', onTap);

    net.on('miss', (m) => {
      if (isHost === true && typeof m.id === 'string' && m.epoch === st.epoch) onMiss(m.id);
    });

    // Schatz-Licht: Ein Gerät meldet, wie viele Sterne es bei diesem Licht schon angetippt hat (Gesamtzahl, darum sind
    // wiederholte oder verspätete Meldungen harmlos)
    net.on('star', (m) => {
      if (isHost !== true || st.finale || st.ph !== 'play' || finishing || st.paused || st.gm !== 'schatz') return;
      const li = st.lights.findIndex((l) => l.h === m.id);
      if (li < 0 || m.epoch !== st.epoch || m.s !== st.lights[li].s || typeof m.c !== 'number') return;
      if (!starsTaken(li, Math.floor(m.c))) return;
      if (st.sc >= st.goal) { startFinale(li); return; }
      publish();
    });

    net.on('host', (m) => {
      if (m.id === boardId) return;
      if (isHost === null) { isHost = false; setViewerBanner(true); } else if (isHost === true && String(m.id) < boardId) {
        // zwei Haupt-Tafeln zugleich: die mit der kleineren Kennung bleibt
        isHost = false;
        st.lights.forEach((l, i) => clearTimeout(autoTimers[i]));
        clearTimeout(finTimer);
        clearTimeout(cdTimer);
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

    // Beim Öffnen eines Fensters soll keine Bildschirmtastatur aufgehen: kein Eingabefeld darf den Fokus behalten
    function noKeyboard() {
      const a = document.activeElement;
      if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.blur) a.blur();
    }

    let warnTimer = null;
    function setConn(ok) {
      const partial = ok && net.upCount < net.total; // nur einer von zwei Servern erreichbar: läuft, aber ohne Reserve
      $('connDot').className = ok ? (partial ? 'dot warn' : 'dot ok') : 'dot bad';
      $('connDot').title = ok ? `Verbunden (${net.brokerName})${partial ? ', der andere Server ist gerade nicht erreichbar' : ''}` : 'Keine Verbindung';
      // Erst nach ein paar Sekunden ohne Verbindung warnen, damit kurze Aussetzer niemanden aufschrecken
      clearTimeout(warnTimer);
      if (ok) {
        $('netWarn').hidden = true;
      } else {
        warnTimer = setTimeout(() => { $('netWarn').hidden = false; }, 4000);
      }
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
    // Dunkelheit: Funken fliegen ins Gruppenlicht, Wellen drängen den Nebel zurück
    let sparks = [];
    let waves = [];
    let dkFlare = -9999;
    let dkBeatN = -1;
    const fogBlobs = Array.from({ length: 16 }, (_, i) => ({ a: (i / 16) * TAU + Math.random(), s: 0.00004 + Math.random() * 0.00005, r: 0.5 + Math.random() * 0.6, p: Math.random() * TAU }));
    const view = {
      gm: 'klassik', lights: [], vis: [], autoSince: [], round: -1, chain: 0, goal: 8, prog: 0,
      finale: false, fin: null, init: false, tm: false, ph: 'play', phAt: 0, acc: 0, run: false, accAt: 0,
      ft: 0, rec: 0, best: 0, n: 0, cd: 0, finDur: FINALE_MS, pulseMs: 750, tc: [0, 0], win: -1, ser: 0, sw: [0, 0], sd: 0, tsel: 0,
      stars: [], sc: 0, team: {}, paused: false,
      lost: 0, dk: 0, dkr: 0, dkAt: 0, dkShow: 0.12, mu: null, ge: null, zp: 0,
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
      const ry = H * (view.tm || LK.isTeamGm(view.gm) ? 0.3 : 0.33); // Platz für Uhr bzw. Fortschrittsbalken oben
      if (LK.isTeamGm(view.gm)) {
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

    const nodeColor = (id, slot, team) => (LK.isTeamGm(view.gm) ? LK.TEAM_COLORS[team[id] || 0] : LK.COLORS[slot]);

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
      if (s.round !== view.round) { edges = {}; pulses = []; view.vis = []; view.round = s.round; view.dkShow = s.dk || 0; sparks = []; waves = []; }
      const first = !view.init;
      view.init = true;
      view.pulseMs = 450; // kurzer Flug: Das Zielsymbol leuchtet schon ab dem Abflug
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
      view.ser = s.ser || 0;
      view.sw = s.sw || [0, 0];
      view.sd = s.sd || 0;
      view.tsel = s.tsel || 0;
      view.lost = s.lost || 0;
      view.dk = s.dk || 0;
      view.dkr = s.dkr || 0;
      view.dkAt = now;
      // Muster nachspielen und Geheime Reihenfolge: Aufleuchten, richtige und falsche Tipps zeigen
      const pmu = view.mu;
      const pge = view.ge;
      view.mu = s.mu || null;
      view.ge = s.ge || null;
      if (!first) {
        if (view.mu && pmu) {
          if (view.mu.cur && pmu.fk !== view.mu.fk) flashNode(view.mu.cur, false);
          if (view.mu.tl && pmu.tk !== view.mu.tk) {
            view.muTlAt = now;
            flashNode(view.mu.tl, false); // jedes Symbol hat seinen festen Ton, beim Zeigen und beim Nachspielen
          }
          if (view.mu.ph === 'next' && pmu.ph !== 'next' && soundOn) LK.audio.arp();
          if (view.mu.bl && pmu.bad !== view.mu.bad) { flashNode(view.mu.bl, true); view.muBlAt = now; }
        }
        if (view.ge && pge && view.ge.bad && pge.bk !== view.ge.bk) flashNode(view.ge.bad, true);
        if (view.ge && view.ge.rp && view.ge.cur && (!pge || pge.fk !== view.ge.fk)) flashNode(view.ge.cur, false);
      }
      view.stars = s.stars || [];
      if (s.sc > view.sc && !first) {
        // Stern eingesammelt: Funkeln bei dem Gerät, das ihn angetippt hat (das Licht war gerade dort)
        // Jeder Stern zählt: Funkeln bei dem Gerät, das ihn angetippt hat. Wurde dabei das Licht weitergegeben, war es das vorherige.
        const l = view.lights[0];
        const pl0 = prevLights[0];
        const passed = !!(pl0 && l && pl0.s !== l.s);
        const id = l ? (passed ? l.p : l.h) : null;
        if (id && nodes[id]) starBurst(id);
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
      view.paused = !!s.paused;
      view.finDur = (s.tm && s.gm === 'klassik') || LK.isTeamGm(s.gm) || s.gm === 'bild' ? 8000 : FINALE_MS;
      refreshUi();
    }

    function refreshUi() {
      const bildFin = view.gm === 'bild' && view.finale;
      // Muster nachspielen: Die Tafel ist die Spielleitung (erst zeigen, dann nachspielen lassen)
      const muPh = (view.gm === 'muster' && view.ph === 'play' && !view.finale && view.mu) ? view.mu.ph : '';
      const muBtn = muPh === 'ready' || muPh === 'shown';
      $('goBtn').hidden = !(isHost === true && (view.ph === 'ready' || bildFin || muBtn) && Object.keys(st.players).length > 0);
      $('muHelp').hidden = !(isHost === true && view.gm === 'muster' && view.ph === 'play' && !view.finale && view.mu && view.mu.sq.length > 0);
      $('muHelp').textContent = `Hilfslinien: ${view.muLines ? 'an' : 'aus'}`;
      $('muHelp').setAttribute('aria-pressed', String(!!view.muLines));
      $('saveBtn').hidden = !(view.gm === 'bild' && view.chain > 0);
      $('shakeBtn').hidden = !(isHost === true && ((view.ph === 'ready' && LK.isTeamGm(view.gm)) || muPh === 'shown' || (muPh === 'ready' && view.mu.ag)) && Object.keys(st.players).length > 0);
      $('shakeBtn').textContent = muPh === 'shown' ? 'Noch einmal zeigen' : (muPh === 'ready' ? 'Direkt noch einmal versuchen ▶' : '🎲 Teams neu würfeln');
      $('goBtn').textContent = muPh === 'ready' ? (view.mu.ag ? 'Reihenfolge noch einmal zeigen ▶' : 'Reihenfolge zeigen ▶') : (muPh === 'shown' ? 'Jetzt nachspielen ▶' : ((view.round > 1 || bildFin) ? 'Neue Runde starten ▶' : 'Spiel starten ▶'));
    }

    const fmtTime = (ms) => {
      const t = Math.max(0, Math.floor(ms / 100));
      const m = Math.floor(t / 600);
      const s = Math.floor((t % 600) / 10);
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${t % 10}`;
    };

    // Kurzes Aufleuchten bei einem Gerät. bad = falscher Tipp (rote Welle, kein Ton)
    // silent: nur das Bild, der Ton kommt von woanders
    function flashNode(id, bad, silent) {
      const n = nodes[id];
      if (!n) return;
      const now = performance.now();
      n.pop = now;
      ripples.push({ x: n.x, y: n.y, t0: now, color: bad ? '#fb7185' : n.col });
      if (!soundOn) return;
      if (bad) LK.audio.thud();
      else if (!silent) LK.audio.note(n.slot, 0.45, 1.2);
    }

    function startPulse(li, from, to) {
      // Wurde schon weitergegeben, bevor das Licht ankam: Die Ankunft nachholen, damit Ton, Spur und Welle nicht fehlen
      const old = pulses.find((p) => p.li === li);
      if (old && nodes[old.b]) arrive(li, old.b, old.a);
      view.vis[li] = null;
      view.fin = null;
      pulses = pulses.filter((p) => p.li !== li);
      if (!from || from === to || !nodes[from] || !nodes[to]) { arrive(li, to, null); return; }
      pulses.push({ li, a: from, b: to, t0: performance.now() });
    }

    function arrive(li, to, from) {
      view.vis[li] = to;
      const n = nodes[to];
      if (!n) return;
      const now = performance.now();
      n.pop = now;
      view.vis[li] = to;
      ripples.push({ x: n.x, y: n.y, t0: now, color: n.col });
      if (from) {
        const k = edgeKey(from, to);
        if (!edges[k]) edges[k] = { a: from, b: to, k: 0 };
        edges[k].k = Math.min(edges[k].k + 1, view.gm === 'bild' ? 16 : 8);
      }
      if (view.gm === 'dunkel') sparks.push({ x: n.x, y: n.y, t0: now });
      if (!soundOn) return;
      if (view.gm === 'zieh') {
        const o = 1 - (li % 2);
        LK.audio.pull(li % 2, (view.tc[li % 2] || 0) - (view.tc[o] || 0));
      } else if (view.gm === 'geheim') {
        LK.audio.note(n.slot, 0.3, 1.2);
        LK.audio.chime(view.ge ? view.ge.i - 1 : 0); // jeder gefundene Schritt klingt höher
      } else if (view.gm === 'bild') {
        LK.audio.note(n.slot, 0.5, 1.5);
        if (from && edges[edgeKey(from, to)] && edges[edgeKey(from, to)].k > 1) LK.audio.note(n.slot, 0.16, 2, 0.06, 1); // ein bekannter Weg klingt heller
      } else if (view.gm === 'basal') {
        // sanft: ein weicher Ton, alle 10 Weitergaben ein kleiner Lauf als Belohnung
        LK.audio.note(n.slot, 0.38, 1.8);
        LK.audio.note(n.slot, 0.1, 2.2, 0.05, 1);
        if (view.chain > 0 && view.chain % 10 === 0) LK.audio.arp();
      } else if (view.gm === 'dunkel') {
        LK.audio.bell(); // das Licht wird weitergegeben, der Nebel weicht
        LK.audio.whoosh();
      } else {
        LK.audio.note(n.slot, 0.5, 1.5);
      }
    }

    // Schatz-Licht: goldene Wellen und zwei helle Töne, wenn ein Stern eingesammelt wurde
    let starFly = [];
    let basketPop = 0;
    function starBurst(id) {
      const n = nodes[id];
      if (!n) return;
      const now = performance.now();
      starFly.push({ x: n.x, y: n.y, t0: now, ph: Math.random() * 2 - 1 });
      ripples.push({ x: n.x, y: n.y, t0: now, color: '#fde047' });
      ripples.push({ x: n.x, y: n.y, t0: now + 140, color: '#fde047' });
      if (soundOn) { LK.audio.note(n.slot, 0.4, 1.4, 0, 1); LK.audio.note(n.slot, 0.25, 1.6, 0.12, 2); }
    }

    function startFinaleFx(s) {
      view.vis = [];
      view.fin = { t0: performance.now() };
      pulses = [];
      if (soundOn) {
        if (s.lost) LK.audio.lose();
        else { LK.audio.finale(Object.values(s.players)); if (s.gm === 'dunkel') LK.audio.sunrise(); }
      }
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
      if (LK.isTeamGm(view.gm)) return LK.rgba(LK.TEAM_COLORS[li % 2], a);
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

    // Die Dunkelheit als Bild: Ein Nebel kriecht von den Rändern zur Mitte und frisst das Gruppenlicht an.
    // Jede Weitergabe schickt einen Funken ins Gruppenlicht. Es flammt auf und eine Welle drängt den Nebel zurück.
    function drawDarkBack(now, finT, fin) {
      let lvl = view.dkShow = view.dkShow + (Math.min(1, view.dk + view.dkr * ((now - view.dkAt) / 1000)) - view.dkShow) * 0.1;
      if (view.lost) lvl = Math.max(lvl, 0.98);
      if (fin && !view.lost) lvl *= Math.max(0, 1 - finT * 4);
      const mn = Math.min(W, H);
      const cx = W / 2;
      const cy = H / 2;
      const mx = Math.hypot(W, H) / 2;
      ctx.globalCompositeOperation = 'source-over';
      if (lvl > 0.01) {
        const inner = mx * (1 - 0.78 * lvl);
        const g = ctx.createRadialGradient(cx, cy, inner * 0.5, cx, cy, inner + mx * 0.35);
        g.addColorStop(0, 'rgba(8,5,22,0)');
        g.addColorStop(1, `rgba(8,5,22,${Math.min(0.92, 0.25 + 0.7 * lvl)})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        // Schwaden, die langsam um die Mitte ziehen
        fogBlobs.forEach((bl) => {
          const a = bl.a + now * bl.s;
          const d = inner * (0.95 + 0.12 * Math.sin(now / 1700 + bl.p));
          const x = cx + Math.cos(a) * d * (W / (2 * mx)) * 1.15;
          const y = cy + Math.sin(a) * d * (H / (2 * mx)) * 1.15;
          const rr = mn * (0.12 + 0.16 * lvl) * bl.r;
          const bg = ctx.createRadialGradient(x, y, 0, x, y, rr);
          bg.addColorStop(0, `rgba(40,22,80,${0.22 * Math.min(1, lvl * 1.6)})`);
          bg.addColorStop(1, 'rgba(40,22,80,0)');
          ctx.fillStyle = bg;
          ctx.beginPath();
          ctx.arc(x, y, rr, 0, TAU);
          ctx.fill();
        });
      }
      // Herzschlag: schneller und lauter, je weniger Licht übrig ist. Das Gruppenlicht pulst im selben Takt.
      const bpm = 50 + 70 * lvl;
      const ph = (now / 1000) * (bpm / 60);
      const beat = Math.floor(ph);
      const pulse = Math.exp(-(ph - beat) * 7);
      if (beat !== dkBeatN) {
        dkBeatN = beat;
        if (soundOn && view.ph === 'play' && !fin && !view.paused && Object.keys(nodes).length) {
          LK.audio.heart(lvl);
          if (lvl > 0.75 && beat % 4 === 0) LK.audio.warn(); // unter einem Viertel Licht: ein enger, unruhiger Ton
        }
      }
      // Das Gruppenlicht
      const flare = Math.max(0, 1 - (now - dkFlare) / 700);
      let sz = mn * 0.2 * (0.18 + 0.82 * (1 - lvl));
      sz *= 1 + 0.07 * pulse * (0.5 + lvl) + 0.25 * flare;
      if (lvl > 0.5) sz *= 1 + 0.05 * Math.sin(now / 53 + Math.sin(now / 131) * 3) * (lvl - 0.5) * 2; // es flackert
      if (fin && view.lost) sz *= Math.max(0, 1 - finT * 3);
      if (fin && !view.lost) sz *= 1.25;
      if (sz > 1) {
        ctx.globalAlpha = view.ph === 'play' || fin ? 1 : 0.4; // vor dem Start leiser, damit der Text lesbar bleibt
        ctx.globalCompositeOperation = 'lighter';
        const og = ctx.createRadialGradient(cx, cy, 0, cx, cy, sz * 2.4);
        og.addColorStop(0, 'rgba(255,244,200,0.8)');
        og.addColorStop(0.25, 'rgba(255,200,110,0.45)');
        og.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.fillStyle = og;
        ctx.beginPath();
        ctx.arc(cx, cy, sz * 2.4, 0, TAU);
        ctx.fill();
        const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, sz * 0.7);
        cg.addColorStop(0, 'rgba(255,252,235,0.95)');
        cg.addColorStop(0.5, 'rgba(255,235,170,0.5)');
        cg.addColorStop(1, 'rgba(255,210,120,0)');
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.arc(cx, cy, sz * 0.7, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    }

    function drawDarkFront(now) {
      const cx = W / 2;
      const cy = H / 2;
      const mx = Math.hypot(W, H) / 2;
      const R = baseR();
      ctx.globalCompositeOperation = 'lighter';
      // Funken: vom Gerät, das das Licht bekommen hat, ins Gruppenlicht
      sparks = sparks.filter((sp) => {
        const k = (now - sp.t0) / 450;
        if (k >= 1) { dkFlare = now; waves.push({ t0: now }); return false; }
        const e = ease(k);
        const x = sp.x + (cx - sp.x) * e;
        const y = sp.y + (cy - sp.y) * e;
        const gg = ctx.createRadialGradient(x, y, 0, x, y, R * 1.1);
        gg.addColorStop(0, 'rgba(255,250,225,0.95)');
        gg.addColorStop(1, 'rgba(255,190,100,0)');
        ctx.fillStyle = gg;
        ctx.beginPath();
        ctx.arc(x, y, R * 1.1, 0, TAU);
        ctx.fill();
        return true;
      });
      // Wellen: Das Licht drängt den Nebel zurück
      waves = waves.filter((w) => now - w.t0 < 1100);
      waves.forEach((w) => {
        const k = (now - w.t0) / 1100;
        ctx.lineWidth = 7 * (1 - k) + 1;
        ctx.strokeStyle = `rgba(255,225,160,${0.55 * (1 - k)})`;
        ctx.beginPath();
        ctx.arc(cx, cy, k * mx * 0.85, 0, TAU);
        ctx.stroke();
      });
    }

    // Schatz-Licht: Der Sammelkorb in der Mitte. Die Sterne fliegen von den Geräten hinein, der Haufen wächst.
    const frac = (x) => x - Math.floor(x);
    function drawBasket(cx, cy, hr, now) {
      ctx.globalCompositeOperation = 'source-over';
      const bx = cx;
      const by = cy + hr * 0.2;
      const mw = hr * 1.7; const bwid = hr * 1.15; const h = hr * 0.95;
      const top = by - h / 2;
      const pop = basketPop ? Math.max(0, 1 - (now - basketPop) / 350) : 0;
      ctx.save();
      ctx.translate(bx, by); ctx.scale(1 + 0.07 * pop, 1 - 0.05 * pop); ctx.translate(-bx, -by);
      // Innenraum
      ctx.fillStyle = 'rgba(40,30,10,0.9)';
      ctx.beginPath(); ctx.ellipse(bx, top, mw / 2, h * 0.16, 0, 0, TAU); ctx.fill();
      // Sternenhaufen (Sterne, die noch fliegen, zählen noch nicht)
      const air = starFly.length;
      const cnt = Math.max(0, Math.min(view.sc, 40) - air);
      for (let i = 0; i < cnt; i++) {
        const t = i / 40;
        const x = bx + (frac(Math.sin((i + 1) * 12.9898) * 43758.5453) - 0.5) * mw * 0.74 * (1 - 0.45 * t);
        const y = top + h * 0.05 - t * h * 0.55 + (frac(Math.sin((i + 7) * 78.233) * 12345.678) - 0.5) * h * 0.12;
        ctx.fillStyle = i % 3 === 0 ? 'rgba(255,240,150,1)' : 'rgba(253,224,71,0.95)';
        starPath(x, y, hr * 0.17);
        ctx.fill();
      }
      // Korbkörper
      ctx.fillStyle = '#a16a35';
      ctx.beginPath();
      ctx.moveTo(bx - mw / 2, top); ctx.lineTo(bx + mw / 2, top);
      ctx.lineTo(bx + bwid / 2, by + h / 2); ctx.lineTo(bx - bwid / 2, by + h / 2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(70,40,15,0.55)'; ctx.lineWidth = Math.max(2, hr * 0.03);
      for (let k = 1; k < 4; k++) {
        const yy = top + (h * k) / 4; const half = (mw / 2) - ((mw - bwid) / 2) * (k / 4);
        ctx.beginPath(); ctx.moveTo(bx - half, yy); ctx.lineTo(bx + half, yy); ctx.stroke();
      }
      for (let k = -2; k <= 2; k++) {
        ctx.beginPath(); ctx.moveTo(bx + (k * mw) / 6, top); ctx.lineTo(bx + (k * bwid) / 6, by + h / 2); ctx.stroke();
      }
      ctx.strokeStyle = '#d4a05a'; ctx.lineWidth = Math.max(4, hr * 0.07);
      ctx.beginPath(); ctx.ellipse(bx, top, mw / 2, h * 0.16, 0, 0, TAU); ctx.stroke();
      ctx.restore();
      // Fliegende Sterne
      starFly = starFly.filter((f) => {
        const k = (now - f.t0) / 800;
        if (k >= 1) { basketPop = now; return false; }
        const e = k * k * (3 - 2 * k);
        const tx = bx + f.ph * mw * 0.12; const ty = top;
        const mx = (f.x + tx) / 2 + f.ph * hr * 0.8; const my = Math.min(f.y, ty) - hr * 0.9;
        const u = 1 - e;
        const x = u * u * f.x + 2 * u * e * mx + e * e * tx;
        const y = u * u * f.y + 2 * u * e * my + e * e * ty;
        const g = ctx.createRadialGradient(x, y, 0, x, y, hr * 0.5);
        g.addColorStop(0, 'rgba(255,240,150,0.7)'); g.addColorStop(1, 'rgba(253,224,71,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, hr * 0.5, 0, TAU); ctx.fill();
        ctx.fillStyle = 'rgba(253,224,71,1)';
        starPath(x, y, hr * (0.24 - 0.07 * e));
        ctx.fill();
        return true;
      });
      ctx.fillStyle = 'rgba(253,224,71,0.95)';
      ctx.font = `700 ${Math.round(hr * 0.34)}px ${SANS}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(`★ ${view.sc} / ${view.goal}`, cx, by + h / 2 + hr * 0.4);
    }

    function drawLevels() {
      ctx.globalCompositeOperation = 'source-over';
      const r = baseR();
      ctx.font = `600 ${Math.round(Math.max(12, r * 0.5))}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        const l = peers[id] && peers[id].xl;
        if (n.dying || !l) return;
        const t = `Stufe ${l}`;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(6,7,13,0.85)'; ctx.strokeText(t, n.x, n.y + r * 1.35);
        ctx.fillStyle = 'rgba(255,225,160,0.95)'; ctx.fillText(t, n.x, n.y + r * 1.35);
      });
    }
    function drawTimes() {
      ctx.globalCompositeOperation = 'source-over';
      const r = baseR();
      ctx.font = `600 ${Math.round(Math.max(12, r * 0.5))}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        const t = n.dying ? '' : fmtT(id);
        if (!t) return;
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(6,7,13,0.85)'; ctx.strokeText(t, n.x, n.y + r * 1.35);
        ctx.fillStyle = 'rgba(220,225,255,0.9)'; ctx.fillText(t, n.x, n.y + r * 1.35);
      });
    }
    // Pfeile und Nummern entlang einer Reihenfolge (Geheime Reihenfolge am Ende)
    function drawRoute(seq, upto) {
      ctx.globalCompositeOperation = 'source-over';
      const r0 = baseR() * 1.15;
      for (let k = 0; k <= upto && k < seq.length; k++) {
        const b = nodes[seq[k]];
        if (!b) continue;
        const a = k > 0 ? nodes[seq[k - 1]] : null;
        if (a && a !== b) {
          const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
          const ux = dx / d; const uy = dy / d;
          const x2 = b.x - ux * r0; const y2 = b.y - uy * r0;
          ctx.save();
          ctx.strokeStyle = 'rgba(255,225,160,0.8)'; ctx.fillStyle = ctx.strokeStyle;
          ctx.lineWidth = Math.max(3, r0 * 0.12);
          ctx.beginPath(); ctx.moveTo(a.x + ux * r0, a.y + uy * r0); ctx.lineTo(x2, y2); ctx.stroke();
          const hs = r0 * 0.38;
          ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - ux * hs - uy * hs * 0.55, y2 - uy * hs + ux * hs * 0.55); ctx.lineTo(x2 - ux * hs + uy * hs * 0.55, y2 - uy * hs - ux * hs * 0.55); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        ctx.save();
        ctx.font = `800 ${Math.round(r0 * 0.7)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(6,7,13,0.85)';
        ctx.strokeText(String(k + 1), b.x - r0 * 0.95, b.y - r0 * 0.95);
        ctx.fillStyle = 'rgba(255,240,200,0.95)'; ctx.fillText(String(k + 1), b.x - r0 * 0.95, b.y - r0 * 0.95);
        ctx.restore();
      }
    }

    // Muster: Auf der Tafel sieht man, welches Gerät getippt hat (grün = richtig) und wer falsch war (rot), samt dem richtigen
    function drawMuMarks(now) {
      const mu = view.mu;
      ctx.globalCompositeOperation = 'source-over';
      const ring = (id, col, a, dash, sym) => {
        const n = nodes[id];
        if (!n || a <= 0) return;
        const r = baseR() * 1.55;
        ctx.save();
        ctx.globalAlpha = a;
        ctx.strokeStyle = col; ctx.fillStyle = col;
        ctx.lineWidth = Math.max(4, r * 0.1);
        ctx.setLineDash(dash ? [r * 0.25, r * 0.2] : []);
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
        ctx.font = `800 ${Math.round(r * 0.8)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(sym, n.x + r * 0.95, n.y - r * 0.95);
        ctx.restore();
      };
      // Hilfslinien: Pfeile zwischen den Geräten in der richtigen Reihenfolge (nur wenn die Spielleitung sie einblendet)
      if (view.muLines && ['show', 'shown', 'go', 'again'].includes(mu.ph)) {
        const upto = mu.ph === 'show' ? (mu.si === undefined ? -1 : mu.si) : mu.sq.length - 1;
        const r0 = baseR() * 1.15;
        for (let k = 0; k <= upto; k++) {
          const b = nodes[mu.sq[k]];
          if (!b) continue;
          const a = k > 0 ? nodes[mu.sq[k - 1]] : null;
          const done = mu.ph === 'go' && k <= mu.i - 1;
          const col = done ? '110,231,183' : '235,238,255';
          if (a && a !== b) {
            const dx = b.x - a.x; const dy = b.y - a.y; const d = Math.hypot(dx, dy) || 1;
            const ux = dx / d; const uy = dy / d;
            const x1 = a.x + ux * r0; const y1 = a.y + uy * r0; const x2 = b.x - ux * r0; const y2 = b.y - uy * r0;
            ctx.save();
            ctx.strokeStyle = `rgba(${col},${done ? 0.85 : 0.6})`; ctx.fillStyle = ctx.strokeStyle;
            ctx.lineWidth = Math.max(3, r0 * 0.12);
            ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
            const hs = r0 * 0.38;
            ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - ux * hs - uy * hs * 0.55, y2 - uy * hs + ux * hs * 0.55); ctx.lineTo(x2 - ux * hs + uy * hs * 0.55, y2 - uy * hs - ux * hs * 0.55); ctx.closePath(); ctx.fill();
            ctx.restore();
          }
          ctx.save();
          ctx.font = `800 ${Math.round(r0 * 0.7)}px system-ui, sans-serif`;
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(6,7,13,0.85)';
          const tx = b.x - r0 * 0.95; const ty = b.y - r0 * 0.95;
          ctx.strokeText(String(k + 1), tx, ty);
          ctx.fillStyle = `rgba(${col},0.95)`; ctx.fillText(String(k + 1), tx, ty);
          ctx.restore();
        }
      }
      if (mu.tl && view.muTlAt && mu.ph === 'go') ring(mu.tl, '#6ee7b7', Math.max(0, 1 - (now - view.muTlAt) / 1400), false, '✓');
      if (mu.bl && (mu.ph === 'again' || (mu.ph === 'ready' && mu.ag))) {
        const pulse = 0.75 + 0.25 * Math.sin(now / 180);
        ring(mu.bl, '#fb7185', pulse, false, '✕');
        if (mu.sq[mu.i]) ring(mu.sq[mu.i], '#6ee7b7', 0.9, true, '');
      }
    }

    // Zwei Balken unten: wie weit die Gruppe ist (Licht) und wie nah der Schatten (Dunkelheit)
    function drawDarkBars(now) {
      if (view.ph !== 'play') return;
      ctx.globalCompositeOperation = 'source-over';
      const bw = Math.min(W * 0.72, 760);
      const bh = Math.max(14, Math.min(26, H * 0.03));
      const x = (W - bw) / 2;
      const lvl = Math.min(1, view.dkShow);
      const prog = Math.min(1, (view.chain || 0) / Math.max(1, view.goal || 1));
      const danger = lvl > 0.75;
      const blink = danger ? 0.65 + 0.35 * Math.sin(now / (lvl > 0.9 ? 90 : 180)) : 1;
      const bar = (y, f, col, label, right) => {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath(); ctx.roundRect(x, y, bw, bh, bh / 2); ctx.fill();
        if (f > 0.005) {
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.roundRect(x, y, Math.max(bh, bw * f), bh, bh / 2); ctx.fill();
        }
        ctx.font = `600 ${Math.round(bh * 0.8)}px system-ui, sans-serif`;
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left'; ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.fillText(label, x + 4, y - 3);
        ctx.textAlign = 'right';
        ctx.fillText(right, x + bw - 4, y - 3);
      };
      const y2 = H - bh - 16;
      const y1 = y2 - bh - bh * 1.9;
      bar(y1, prog, 'rgba(255,214,120,0.95)', 'Licht der Gruppe', `${view.chain || 0} von ${view.goal || 0}`);
      bar(y2, lvl, danger ? `rgba(255,90,90,${blink})` : 'rgba(150,130,255,0.9)', danger ? 'Dunkelheit: gleich ist es zu spät!' : (view.dkr === 0 ? 'Dunkelheit steht still' : 'Dunkelheit'), `${Math.round(lvl * 100)} %`);
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
      const winCol = LK.isTeamGm(view.gm) && view.win >= 0 ? LK.TEAM_COLORS[view.win] : null;

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

      if (view.gm === 'dunkel') drawDarkBack(now, finT, fin);
      ctx.globalCompositeOperation = 'lighter';

      // Spuren aus früheren Weitergaben
      Object.values(edges).forEach((e) => {
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (!a || !b) return;
        if (view.gm === 'bild') {
          // Lichtbild: kräftige, leuchtende Linien, die bei jeder Weitergabe dicker werden und so Stück für Stück ein Bild ergeben
          const pb = bez(a, b, 0.5);
          const w = 3 + Math.min(e.k, 16) * 1.3;
          const gb = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
          gb.addColorStop(0, LK.rgba(a.col, 1));
          gb.addColorStop(1, LK.rgba(b.col, 1));
          ctx.lineCap = 'round';
          [[w * 3.2, 0.12], [w * 1.4, 0.42], [Math.max(2, w * 0.45), 0.75]].forEach(([lw, al2]) => {
            ctx.globalAlpha = Math.min(1, al2 + (fin ? 0.2 : 0));
            ctx.strokeStyle = lw === Math.max(2, w * 0.45) ? 'rgba(255,255,255,0.9)' : gb;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.quadraticCurveTo(pb.qx, pb.qy, b.x, b.y);
            ctx.stroke();
          });
          ctx.globalAlpha = 1;
          return;
        }
        const boost = fin ? 0.35 : 0;
        const al = Math.min(0.14 + e.k * 0.07 + boost, 0.85);
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, LK.rgba(a.col, al));
        g.addColorStop(1, LK.rgba(b.col, al));
        const p = bez(a, b, 0.5);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.5 + Math.min(e.k, view.gm === 'bild' ? 12 : 6) * 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(p.qx, p.qy, b.x, b.y);
        ctx.stroke();
      });

      // Knoten
      const litBy = {}; // Gerät -> Nummer des Lichts
      view.vis.forEach((id, li) => { if (id) litBy[id] = li; });
      // Das Gerät, zu dem das Licht gerade fliegt, leuchtet schon (es kann ja gleich weitergeben)
      pulses.forEach((p) => { if (litBy[p.b] === undefined) litBy[p.b] = p.li; });
      // Maßgeblich ist immer der aktuelle Stand: Wer das Licht hat, leuchtet. Wer es nicht mehr hat, nicht, egal was die Animation gerade macht.
      view.lights.forEach((l, li) => { if (l.h && nodes[l.h] && !nodes[l.h].dying) litBy[l.h] = li; });
      if (!fin) {
        const holders = new Set(view.lights.map((l) => l.h).filter(Boolean));
        Object.keys(litBy).forEach((id) => { if (!holders.has(id) && !(view.mu && view.mu.cur === id)) delete litBy[id]; });
      }
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        const col = n.col;
        const born = Math.min(1, (now - n.born) / 500);
        const fade = n.dying ? Math.max(0, 1 - (now - n.dying) / 600) : 1;
        const li = litBy[id];
        const lit = li !== undefined || (fin && finT < 0.9) || !!(view.mu && view.mu.cur === id);
        const ps = n.pop ? Math.max(0, 1 - (now - n.pop) / 600) : 0;
        const sc = (0.4 + 0.6 * ease(born)) * (1 + 0.35 * ps * ps) * (lit && !fin ? 1.12 : 1);
        const r = R * sc;
        const breath = lit ? 0.5 + 0.5 * Math.sin(now / 420) : 0;
        const glowA = (lit ? 0.62 + 0.2 * breath : 0.08) * fade;
        const gr = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * (lit ? 4 : 3.4));
        gr.addColorStop(0, LK.rgba(col, glowA));
        gr.addColorStop(1, LK.rgba(col, 0));
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * (lit ? 4 : 3.4), 0, TAU);
        ctx.fill();
        LK.shapePath(ctx, n.slot, n.x, n.y, r);
        ctx.fillStyle = LK.rgba(col, (lit ? 0.95 : 0.22) * fade);
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = LK.rgba(col, (lit ? 1 : 0.7) * fade);
        ctx.stroke();
        // Geheime Reihenfolge: Dieses Gerät war es in diesem Schritt nicht
        if (view.gm === 'geheim' && view.ge && view.ge.ex && view.ge.ex.includes(id)) {
          ctx.save();
          ctx.globalCompositeOperation = 'source-over';
          ctx.strokeStyle = `rgba(251,113,133,${0.95 * fade})`;
          ctx.lineWidth = 5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(n.x - r * 0.6, n.y - r * 0.6);
          ctx.lineTo(n.x + r * 0.6, n.y + r * 0.6);
          ctx.moveTo(n.x + r * 0.6, n.y - r * 0.6);
          ctx.lineTo(n.x - r * 0.6, n.y + r * 0.6);
          ctx.stroke();
          ctx.restore();
        }
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
          // Liegen bei diesem Gerät mehrere Sterne, steht die Zahl der noch offenen dabei
          const holder = view.lights.find((x) => x.h === id);
          if (holder && holder.r > 1) {
            ctx.save();
            ctx.globalCompositeOperation = 'source-over';
            ctx.fillStyle = `rgba(253,224,71,${fade})`;
            ctx.font = `700 ${Math.round(r * 0.8)}px ${SANS}`;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(`×${holder.r}`, n.x + r * 2.2, n.y - r * 1.5 + bob);
            ctx.restore();
          }
        }
      });

      if (view.gm === 'muster' && view.mu) drawMuMarks(now);
      if (view.zt && isHost === true) drawTimes();
      if (view.gm === 'extrem' && isHost === true) drawLevels();
      if (view.gm === 'geheim' && view.ge && view.ge.rp && view.ge.rt) drawRoute(view.ge.rt, view.ge.ri === undefined ? -1 : view.ge.ri);
      if (view.gm === 'dunkel') { drawDarkFront(now); if (!fin) drawDarkBars(now); }

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
          ctx.fillText('Strafpause', n.x, n.y + R * 2.7);
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

      if (view.gm !== 'dunkel') LK.audio.drone(null);

      drawHud(now, finT, fin);

      // Pause: Bildschirm abdunkeln, ein ruhiges Wort in der Mitte
      if (view.paused) {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(6,7,13,0.62)';
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(240,242,255,0.95)';
        ctx.font = `700 ${Math.round(Math.min(W, H) * 0.09)}px ${SANS}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Pause', W / 2, H / 2);
      }
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
      const ringHidden = (fin && (tm || LK.isTeamGm(gm))) || LK.isTeamGm(gm) || gm === 'dunkel';
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
      } else if (fin && LK.isTeamGm(gm)) {
        const w = view.win;
        const c = w >= 0 ? LK.TEAM_COLORS[w] : '#ffffff';
        ctx.fillStyle = LK.rgba(c, finA);
        ctx.font = `700 ${Math.round(hr * 0.8)}px ${SANS}`;
        ctx.fillText(w >= 0 ? `Team ${LK.TEAM_NAMES[w]} gewinnt${view.sd ? ' die Serie' : ''}!` : 'Geschafft!', cx, cy - hr * 0.2);
        ctx.fillStyle = `rgba(200,205,240,${finA * 0.85})`;
        ctx.font = `500 ${Math.round(hr * 0.36)}px ${SANS}`;
        ctx.fillText(`${view.tc[0]} : ${view.tc[1]} Weitergaben`, cx, cy + hr * 0.7);
        if (view.ser > 0) {
          ctx.fillStyle = `rgba(235,238,255,${finA * 0.9})`;
          ctx.font = `600 ${Math.round(hr * 0.36)}px ${SANS}`;
          ctx.fillText(`Serie ${view.sw[0]} : ${view.sw[1]}`, cx, cy + hr * 1.3);
        }
      } else if (fin && gm === 'dunkel' && view.lost) {
        ctx.fillStyle = `rgba(235,238,255,${finA})`;
        ctx.font = `600 ${Math.round(hr * 0.5)}px ${SANS}`;
        ctx.fillText('Die Dunkelheit war schneller', cx, cy - hr * 0.1);
        ctx.fillStyle = `rgba(200,205,240,${finA * 0.85})`;
        ctx.font = `500 ${Math.round(hr * 0.34)}px ${SANS}`;
        ctx.fillText(`${view.chain} von ${view.goal} geschafft. Noch einmal?`, cx, cy + hr * 0.6);
      } else if (fin && gm === 'bild') {
        ctx.fillStyle = 'rgba(235,238,255,0.85)';
        ctx.font = `600 ${Math.round(hr * 0.42)}px ${SANS}`;
        ctx.fillText('Euer Lichtbild', cx, H * 0.075);
      } else if (fin) {
        ctx.fillStyle = `rgba(235,238,255,${finA})`;
        ctx.font = `600 ${Math.round(hr * 0.42)}px ${SANS}`;
        ctx.fillText(gm === 'schatz' ? 'Alle Sterne gesammelt' : (gm === 'muster' ? 'Alle Muster geschafft' : (gm === 'geheim' ? 'Die Reihenfolge ist geknackt' : 'Runde geschafft')), cx, cy);
      } else if (view.ph === 'count') {
        const left = Math.max(0, view.cd - (now - view.phAt));
        const nn = Math.max(1, Math.ceil(left / 1000));
        const frac = (left % 1000) / 1000;
        ctx.fillStyle = `rgba(240,242,255,${0.55 + 0.45 * frac})`;
        ctx.font = `700 ${Math.round(hr * 1.5 * (0.9 + 0.1 * frac))}px ${SANS}`;
        ctx.fillText(String(nn), cx, cy);
        ctx.fillStyle = 'rgba(200,205,240,0.75)';
        ctx.font = `500 ${Math.round(hr * 0.3)}px ${SANS}`;
        ctx.fillText('Mach dich bereit', cx, cy + hr * 1.35);
      } else if (view.ph === 'ready') {
        ctx.fillStyle = 'rgba(235,238,255,0.9)';
        ctx.font = `600 ${Math.round(hr * (LK.isTeamGm(gm) ? 0.5 : 0.4))}px ${SANS}`;
        ctx.fillText(tm ? 'Zeitspiel' : TITLES[gm], cx, cy - hr * 0.12);
        ctx.fillStyle = 'rgba(200,205,240,0.7)';
        ctx.font = `500 ${Math.round(hr * 0.28)}px ${SANS}`;
        ctx.fillText(`${view.goalN || ''} ${({ staffel: 'Weitergaben pro Team', zieh: 'Schritte Vorsprung', extrem: 'Weitergaben pro Team', schatz: 'Sterne', muster: 'Runden', geheim: 'Stationen' })[gm] || 'Weitergaben'}`, cx, cy + hr * 0.3);
        if (LK.isTeamGm(gm)) {
          const cnt = [0, 0];
          Object.keys(view.team || {}).forEach((id) => { if (nodes[id] && !nodes[id].dying) cnt[view.team[id] ? 1 : 0]++; });
          const small = [0, 1].filter((t) => cnt[t] < 3);
          ctx.font = `500 ${Math.round(hr * 0.24)}px ${SANS}`;
          if (view.tsel === 1) {
            ctx.fillStyle = 'rgba(200,205,240,0.7)';
            ctx.fillText('Die Schüler wählen ihr Team selbst', cx, cy + hr * 0.7);
          }
          if (playersHere > 0 && small.length) {
            ctx.fillStyle = 'rgba(253,224,71,0.9)';
            ctx.fillText(`Team ${small.map((t) => `${LK.TEAM_NAMES[t]} (${cnt[t]})`).join(' und ')}: mindestens 3 Geräte sind besser`, cx, cy + hr * (view.tsel === 1 ? 1.05 : 0.7));
          }
        }
      } else if (gm === 'schatz') {
        drawBasket(cx, cy, hr, now);
      } else if (gm === 'basal') {
        if (view.chain > 0) {
          ctx.fillStyle = 'rgba(200,205,240,0.45)';
          ctx.font = `600 ${Math.round(hr * 0.6)}px ${SANS}`;
          ctx.fillText(String(view.chain), cx, cy);
        }
      } else if (gm === 'dunkel') {
        ctx.fillStyle = 'rgba(235,238,255,0.9)';
        ctx.font = `600 ${Math.round(hr * 0.5)}px ${SANS}`;
        ctx.fillText(`${view.chain} / ${view.goal}`, cx, H * 0.085);
      } else if (gm === 'muster' && view.mu) {
        const mu = view.mu;
        const txt = { wait: 'Es braucht mindestens zwei Geräte', ready: mu.ag ? 'Noch einmal ansehen?' : 'Bereit? Gleich kommt eine Reihenfolge', show: 'Merkt euch die Reihenfolge', shown: 'Habt ihr sie euch gemerkt?', go: 'Jetzt ihr! Wer war zuerst dran?', again: 'Nicht ganz. Gleich noch einmal', next: 'Richtig!' }[mu.ph] || '';
        ctx.fillStyle = mu.ph === 'next' ? 'rgba(110,231,183,0.95)' : 'rgba(235,238,255,0.9)';
        ctx.font = `600 ${Math.round(hr * 0.4)}px ${SANS}`;
        ctx.fillText(txt, cx, cy - hr * 0.2);
        ctx.fillStyle = 'rgba(200,205,240,0.7)';
        ctx.font = `500 ${Math.round(hr * 0.26)}px ${SANS}`;
        ctx.fillText(`Runde ${mu.lv} von ${view.goal}`, cx, cy + hr * 0.35);
        const L = mu.sq.length;
        const dr = hr * 0.11;
        for (let k = 0; k < L; k++) {
          const dx = cx + (k - (L - 1) / 2) * dr * 3;
          ctx.beginPath();
          ctx.arc(dx, cy + hr * 0.85, dr, 0, TAU);
          if (mu.ph === 'go' || mu.ph === 'next') {
            if (k < mu.i || mu.ph === 'next') { ctx.fillStyle = 'rgba(110,231,183,0.95)'; ctx.fill(); } else { ctx.strokeStyle = 'rgba(200,205,240,0.6)'; ctx.lineWidth = 2; ctx.stroke(); }
          } else { ctx.strokeStyle = 'rgba(200,205,240,0.35)'; ctx.lineWidth = 2; ctx.stroke(); }
        }
      } else if (gm === 'geheim' && view.ge) {
        ctx.fillStyle = 'rgba(235,238,255,0.9)';
        ctx.font = `600 ${Math.round(hr * 0.4)}px ${SANS}`;
        ctx.fillText(view.ge.rp ? 'Die ganze Reihe noch einmal' : (view.ge.lk ? 'Moment …' : 'Wer ist als Nächstes dran?'), cx, cy - hr * 0.15);
        ctx.fillStyle = 'rgba(200,205,240,0.7)';
        ctx.font = `500 ${Math.round(hr * 0.26)}px ${SANS}`;
        ctx.fillText(`Schritt ${Math.min(view.ge.i + 1, Math.max(1, view.ge.n - 1))} von ${Math.max(1, view.ge.n - 1)}`, cx, cy + hr * 0.4);
      } else if (!LK.isTeamGm(gm)) {
        ctx.fillStyle = 'rgba(200,205,240,0.7)';
        ctx.font = `500 ${Math.round(hr * 0.3)}px ${SANS}`;
        ctx.fillText(`Runde ${view.round > 0 ? view.round : 1}`, cx, cy);
      }

      // Tauziehen: Ein Seil, der Punkt wandert zu dem Team, das öfter weitergibt
      if (gm === 'zieh' && playersHere > 0 && !fin) {
        const bw = W * 0.6;
        const bh = Math.max(12, H * 0.026);
        const x0 = (W - bw) / 2;
        const y = H * 0.06;
        const target = ((view.tc[0] || 0) - (view.tc[1] || 0)) / Math.max(1, view.goal);
        view.zp += (target - view.zp) * 0.12;
        const px = x0 + bw * (0.5 - view.zp / 2);
        const g = ctx.createLinearGradient(x0, 0, x0 + bw, 0);
        g.addColorStop(0, LK.rgba(LK.TEAM_COLORS[0], 0.85));
        g.addColorStop(1, LK.rgba(LK.TEAM_COLORS[1], 0.85));
        ctx.fillStyle = g;
        ctx.fillRect(x0, y, bw, bh);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(cx - 1, y - 5, 2, bh + 10);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(px, y + bh / 2, bh * 0.95, 0, TAU);
        ctx.fill();
        ctx.font = `600 ${Math.round(Math.min(W, H) * 0.028)}px ${SANS}`;
        [0, 1].forEach((t) => {
          ctx.fillStyle = LK.rgba(LK.TEAM_COLORS[t], 0.95);
          ctx.textAlign = t === 0 ? 'left' : 'right';
          ctx.fillText(`Team ${LK.TEAM_NAMES[t]}`, t === 0 ? x0 : x0 + bw, y + bh + Math.min(W, H) * 0.035);
          if (view.ser > 0) {
            const dr = Math.min(W, H) * 0.012;
            const dy = y + bh + Math.min(W, H) * 0.035 + dr * 2.6;
            for (let k = 0; k < view.ser; k++) {
              const dx = t === 0 ? x0 + dr + k * dr * 3 : x0 + bw - dr - k * dr * 3;
              ctx.beginPath();
              ctx.arc(dx, dy, dr, 0, TAU);
              if ((view.sw[t] || 0) > k) { ctx.fillStyle = LK.rgba(LK.TEAM_COLORS[t], 0.95); ctx.fill(); } else { ctx.strokeStyle = LK.rgba(LK.TEAM_COLORS[t], 0.5); ctx.lineWidth = 2; ctx.stroke(); }
            }
          }
        });
        ctx.textAlign = 'center';
      }

      // Staffel: Fortschritt beider Teams oben
      if ((gm === 'staffel' || gm === 'extrem') && playersHere > 0 && !fin) {
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
          // Serie: Leuchtpunkte für gewonnene Runden
          if (view.ser > 0) {
            const dr = Math.min(W, H) * 0.012;
            const dy = y + bh + Math.min(W, H) * 0.035 + dr * 2.6;
            for (let k = 0; k < view.ser; k++) {
              const dx = t === 0 ? x0 + bw - dr - k * dr * 3 : x0 + dr + k * dr * 3;
              ctx.beginPath();
              ctx.arc(dx, dy, dr, 0, TAU);
              if ((view.sw[t] || 0) > k) { ctx.fillStyle = LK.rgba(LK.TEAM_COLORS[t], 0.95); ctx.fill(); } else { ctx.strokeStyle = LK.rgba(LK.TEAM_COLORS[t], 0.5); ctx.lineWidth = 2; ctx.stroke(); }
            }
          }
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

    const needsStartView = () => view.tm || LK.isTeamGm(view.gm) || ['dunkel', 'geheim'].includes(view.gm);

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
      mark('pen', st.pen);
      mark('ser', st.ser);
      mark('tsel', st.tsel);
      mark('nr', st.nr);
      mark('sp', st.sp);
      mark('sj', st.sj);
      document.querySelectorAll('[data-for]').forEach((el) => { el.hidden = !el.dataset.for.split(' ').includes(st.gm); });
      mark('dkv', st.dkv);
      mark('mt', st.mt);
      mark('mf', st.mf);
      mark('sb', st.sb);
      mark('xl', st.xl);
      mark('xa', st.xa);
      $('gnVal').textContent = st.gn ? String(st.gn) : `Auto (${st.goal})`;
      $('gmInfo').textContent = INFO[st.gm];
      $('gnLabel').textContent = GN_LABEL[st.gm];
      document.querySelectorAll('[data-gnstep]').forEach((b) => { const k = st.gm === 'zieh' ? 1 : 5; const up = parseInt(b.dataset.gnstep, 10) > 0; b.textContent = (up ? '+' : '−') + k; b.setAttribute('aria-label', `${k} ${up ? 'mehr' : 'weniger'}`); });
      $('gnLabel').hidden = st.gm === 'basal';
      $('gnLabel').nextElementSibling.hidden = st.gm === 'basal';
      $('gameTitle').textContent = TITLES[st.gm] || '';
      $('curGame').textContent = `Aktuelles Spiel: ${TITLES[st.gm] || ''} · Einstellungen ›`;
    }

    $('gear').addEventListener('click', () => {
      $('roomInput').value = room;
      $('sndBtn').textContent = soundOn ? 'Ton: an' : 'Ton: aus';
      $('restartBtn').hidden = isHost !== true;
      $('teacherQrBtn').hidden = isHost !== true;
      $('modeBox').hidden = isHost !== true;
      $('nrBox').hidden = isHost !== true;
      $('curGame').hidden = isHost !== true;
      markSettings();
      showViewGames();
      $('dlg').showModal();
      noKeyboard();
    });
    $('dlgClose').addEventListener('click', () => $('dlg').close());
    $('copyBtn').addEventListener('click', copyLink);
    view.zt = LK.store.get('lk_zt', '0') === '1';
    const markZt = () => { $('ztBtn').textContent = `Zeit pro Weitergabe: ${view.zt ? 'an' : 'aus'}`; };
    markZt();
    $('ztBtn').addEventListener('click', () => { view.zt = !view.zt; LK.store.set('lk_zt', view.zt ? '1' : '0'); markZt(); });
    $('sndBtn').addEventListener('click', () => {
      soundOn = !soundOn;
      LK.store.set('lk_board_snd', soundOn ? '1' : '0');
      if (soundOn) LK.audio.init();
      $('sndBtn').textContent = soundOn ? 'Ton: an' : 'Ton: aus';
    });
    // Lehrer-QR: ein eigener Code, nur für die Lehrkraft (der Schlüssel steht hinter dem # und geht nie an einen Server)
    let tHideTimer = null;
    const teacherLink = () => `${location.href.split('?')[0].split('#')[0]}?lehrer=1&r=${room}#k=${tSecret}`;
    function buildTeacherQr() {
      const qr = qrcode(0, 'M');
      qr.addData(teacherLink());
      qr.make();
      $('tQr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
    }
    $('teacherQrBtn').addEventListener('click', () => {
      if (!LK.tcrypto.available) {
        window.alert('Die Verschlüsselung steht in diesem Browser nicht zur Verfügung. Die Seite muss über https geöffnet sein.');
        return;
      }
      $('dlg').close();
      buildTeacherQr();
      $('tDlg').showModal();
      noKeyboard();
      clearTimeout(tHideTimer);
      tHideTimer = setTimeout(() => $('tDlg').close(), 90000);
    });
    $('tHide').addEventListener('click', () => $('tDlg').close());
    $('tDlg').addEventListener('close', () => { $('tQr').innerHTML = ''; clearTimeout(tHideTimer); });
    $('tNew').addEventListener('click', () => {
      tSecret = LK.rid(24);
      LK.store.set('lk_tkey', tSecret);
      tKeyP = LK.tcrypto.derive(tSecret);
      seenCmds.length = 0;
      buildTeacherQr();
    });

    $('fsBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    });
    // Derselbe Vollbild-Wechsel auch als kleiner Knopf im Spielbild
    $('fsTafel').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      $('fsTafel').blur();
    });
    $('restartBtn').addEventListener('click', () => {
      if (isHost !== true) return;
      resetRound(true, false, true);
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
    // Spielart wählen, dann erscheint das Untermenü mit den Einstellungen dieses Spiels
    function showViewGames() { showView('games'); }
    function showView(v) {
      $('viewGames').hidden = v !== 'games';
      $('viewGame').hidden = v !== 'game';
      $('viewBasics').hidden = v !== 'basics';
      try { $('dlg').scrollTop = 0; } catch (e) { /* egal */ }
    }
    document.querySelectorAll('.gcard[data-gm]').forEach((c) => c.addEventListener('click', () => {
      if (isHost !== true) return;
      if (c.dataset.gm !== st.gm) applySettings({ gm: c.dataset.gm });
      markSettings();
      showView('game');
    }));
    $('curGame').addEventListener('click', () => { markSettings(); showView('game'); });
    $('backToGames').addEventListener('click', () => showView('games'));
    $('basicsBtn').addEventListener('click', () => showView('basics'));
    $('backFromBasics').addEventListener('click', () => showView('games'));
    onSetting('tm', 'tm', (v) => parseInt(v, 10));
    onSetting('gn', 'gn', (v) => parseInt(v, 10));
    onSetting('nl', 'nl', (v) => parseInt(v, 10));
    onSetting('pen', 'pen', (v) => parseInt(v, 10));
    onSetting('nr', 'nr', (v) => parseInt(v, 10));
    onSetting('sp', 'sp', (v) => parseInt(v, 10));
    onSetting('sj', 'sj', (v) => parseInt(v, 10));
    onSetting('dkv', 'dkv', (v) => parseInt(v, 10));
    onSetting('mt', 'mt', (v) => parseInt(v, 10));
    onSetting('mf', 'mf', (v) => parseInt(v, 10));
    onSetting('sb', 'sb', (v) => parseInt(v, 10));
    onSetting('xl', 'xl', (v) => parseInt(v, 10));
    onSetting('xa', 'xa', (v) => parseInt(v, 10));
    // Ziel pro Runde: Auto oder in 5er-Schritten von 5 bis 100
    document.querySelectorAll('[data-gnstep]').forEach((b) => b.addEventListener('click', () => {
      if (isHost !== true) return;
      const base = st.gn || computeGoal();
      applySettings({ gn: gnFix(st.gm, base + (parseInt(b.dataset.gnstep, 10) > 0 ? 1 : -1) * (st.gm === 'zieh' ? 1 : 5)) });
      markSettings();
    }));
    $('gnAuto').addEventListener('click', () => { if (isHost === true) { applySettings({ gn: 0 }); markSettings(); } });
    onSetting('ser', 'ser', (v) => parseInt(v, 10));
    onSetting('tsel', 'tsel', (v) => parseInt(v, 10));

    // Gerät auf der Tafel antippen: Einstellungen nur für dieses Gerät
    let devId = null;
    function markDev() {
      const eff = effCfg(devId);
      document.querySelectorAll('#devDlg [data-cfg]').forEach((seg) => {
        const cur = String(eff[seg.dataset.cfg]);
        seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cur)));
      });
    }
    const fmtT = (id) => { const q = passStats[id]; return q && q.n ? `Ø ${(q.sum / q.n / 1000).toFixed(1).replace('.', ',')} s (${q.n}×)` : ''; };
    function markDevTime() {
      const t = devId !== null && view.zt ? fmtT(devId) : '';
      $('devTime').hidden = !(view.zt && devId !== null);
      $('devTime').textContent = t ? `Zeit pro Weitergabe: ${t}` : 'Zeit pro Weitergabe: noch keine Messung';
    }
    function openDev(id) {
      devId = id;
      const n = nodes[id];
      $('devTitle').innerHTML = `<span class="devshape" style="color:${n.col}">${LK.shapeSvg(n.slot)}</span> Gerät`;
      markDev();
      markDevTime();
      $('devDlg').showModal();
      noKeyboard();
    }
    $('devBlink').addEventListener('click', () => {
      if (devId === null) return;
      net.send('ping', { id: devId });
      $('devBlink').textContent = 'Signal gesendet ✓';
      setTimeout(() => { $('devBlink').textContent = 'Gerät aufblinken lassen'; }, 1800);
    });
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

    const goOrNext = () => {
      if (st.gm === 'muster' && st.ph === 'play' && !st.finale) { muAdvance(); return; }
      if (st.gm === 'bild' && st.finale) { if (isHost === true) { resetRound(true, true); publish(); } return; }
      startCountdown();
    };
    $('goBtn').addEventListener('click', goOrNext);
    view.muLines = LK.store.get('lk_mulines', '0') === '1';
    $('muHelp').addEventListener('click', () => { view.muLines = !view.muLines; LK.store.set('lk_mulines', view.muLines ? '1' : '0'); refreshUi(); });
    $('shakeBtn').addEventListener('click', () => { if (st.gm === 'muster') { if (st.mu && st.mu.ph === 'ready') muGoNow(); else muShowNow(); } else shakeTeams(); });
    // Lichtbild als Bild speichern
    $('saveBtn').addEventListener('click', () => {
      try {
        cv.toBlob((blob) => {
          if (!blob) return;
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `lichtbild-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`;
          document.body.appendChild(a);
          a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
        }, 'image/png');
      } catch (e) { console.error('Lichtkette: Bild speichern', e); }
    });
    document.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && !$('goBtn').hidden && !$('dlg').open && document.activeElement === document.body) {
        e.preventDefault();
        goOrNext();
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
