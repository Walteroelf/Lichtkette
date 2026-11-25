'use strict';

// Spieler-Ansicht (iPad, Taster, Augensteuerung/Maus).
// Beim Start wählt jedes Gerät seine Eingabeart. Wer das Licht hat, gibt es mit einer einzigen Aktion weiter.
(function (LK) {
  const $ = (id) => document.getElementById(id);
  const MODES = {
    touch: { hint: 'Tippe irgendwo auf den Bildschirm', lock: 700 },
    taster: { hint: 'Drücke den Taster', lock: 700 },
    blick: { hint: 'Schau auf den Kreis', lock: 1000 },
  };
  const HB_MS = 2500;
  const RESEND_MS = 1500;

  LK.startPlayer = function (room, startBroker, idOverride) {
    const ID = (idOverride && /^[a-z0-9]{3,16}$/.test(idOverride)) ? idOverride : (() => {
      let v = LK.store.get('lk_id', '');
      if (!/^[a-z0-9]{6,16}$/.test(v)) { v = LK.rid(8); LK.store.set('lk_id', v); }
      return v;
    })();

    let mode = LK.store.get('lk_mode', '');
    if (!MODES[mode]) mode = '';
    let wait = parseInt(LK.store.get('lk_wait', '0'), 10);
    if (!LK.WAIT_OPTIONS.includes(wait)) wait = 0;
    let sound = LK.store.get('lk_snd', '1') === '1';
    // Tippfläche: '' = automatisch (Tippen: springender Punkt, Blick/Maus: fester Kreis), 'rnd' springend, 'full' fest
    let target = ['rnd', 'full'].includes(LK.store.get('lk_tg', '')) ? LK.store.get('lk_tg', '') : '';
    let noTime = LK.store.get('lk_nt', '0') === '1';                      // Zeitspiel: Zeit dieses Geräts zählt nicht
    let team = ['a', 'b'].includes(LK.store.get('lk_team', '')) ? LK.store.get('lk_team', '') : ''; // Wunschteam für die Staffel
    let missOn = LK.store.get('lk_miss', '0') === '1'; // Staffel: Fehltipps dieses Geräts können eine Strafpause auslösen
    let lastPos = null;
    let lastMiss = 0;
    let lastConfirm = 0;
    // Nach dem Weitergeben wartet das Gerät kurz auf die Tafel. Solange dieses Licht noch im Stand steht, wird nicht neu scharf gestellt.
    let passedToken = null;
    let passedAt = 0;
    const WAIT_TAFEL_MS = 2500;
    let missUntil = 0;
    // Schatz-Licht: Liegt bei diesem Gerät ein Schatz, müssen erst alle Sterne angetippt werden (immer einer sichtbar,
    // der nächste erscheint an anderer Stelle), zum Schluss gibt man das Licht weiter. Bei nur einem Stern darf das Licht auch zuerst kommen.
    let starCount = 0;       // so viele Sterne wurden bei diesem Licht schon angetippt
    let lightTapped = false; // nur bei einem einzelnen Stern: Licht wurde vor dem Stern getippt
    let starTimer = null;    // lässt den Stern weiterspringen, wenn die Tafel das eingestellt hat
    let lastStarPos = null;
    let flashMsg = '';
    let flashUntil = 0;
    let lastTapAt = 0;
    // '' = je nach Eingabeart (Tippen: antippen, Taster und Blick: automatisch), 'auto' oder 'tap'
    let starPref = ['auto', 'tap'].includes(LK.store.get('lk_sa', '')) ? LK.store.get('lk_sa', '') : '';

    let active = false;   // Eingabeart gewählt, Spiel läuft
    let st = null;          // letzter Spielstand
    let lastStateAt = 0;
    let holding = false;
    let lockUntil = 0;
    let resendTimer = null;
    let slot = -1;

    // Vorgaben der Tafel für dieses Gerät (st.cfg) gehen vor, was am Gerät eingestellt ist
    const cfg = () => (st && st.cfg && st.cfg[ID]) || {};
    const eTarget = () => {
      const c = cfg();
      if (c.rnd === 1) return 'rnd';
      if (c.rnd === 0) return 'full';
      if (st && st.gm === 'basal') return 'full'; // Basal: immer eine feste Fläche
      return target || (mode === 'blick' ? 'full' : 'rnd');
    };
    const eWait = () => (cfg().w !== undefined ? cfg().w : wait);
    const eNoTime = () => (cfg().nt !== undefined ? cfg().nt === 1 : noTime);
    const eMiss = () => (cfg().pn !== undefined ? cfg().pn === 1 : missOn);
    const eTeam = () => { const t = cfg().tt; if (t === 'a' || t === 'b') return t; return t === 'x' ? '' : team; };
    // Größe: Bei Tippen (springender Punkt) ist der Standard kleiner, sonst normal
    const eSize = () => cfg().sz || (st && st.gm === 'basal' ? 1.4 : (useRandom() ? 0.75 : 1));
    // Sperre nach Ankunft des Lichts: bei Basal kurz, sonst je nach Eingabeart
    // Basal und Dunkelheit: kurze Sperre, damit nichts verzögert (die Dunkelheit läuft ja gegen die Zeit)
    const lockMs = () => (st && (st.gm === 'basal' || st.gm === 'dunkel') && mode !== 'blick' ? 250 : MODES[mode].lock);
    // Staffel: Die Schüler wählen ihr Team selbst (wenn die Tafel das eingestellt hat)
    let pickTeam = '';   // 'a' | 'b' | ''
    let seenSk = -1;     // Zähler von "Teams neu würfeln": ändert er sich, ist die eigene Wahl hinfällig
    const pickActive = () => !!(st && Date.now() - lastStateAt < 16000 && LK.isTeamGm(st.gm) && st.tsel === 1 && st.ph === 'ready'
      && st.players[ID] !== undefined && cfg().tt === undefined && !st.finale);
    const curPick = () => pickTeam || (st && st.team && st.team[ID] === 1 ? 'b' : 'a');
    const starHere = () => !!(st && st.gm === 'schatz' && st.stars && st.stars.includes(ID));
    // Der Stern wird automatisch eingesammelt, wenn das Gerät es so eingestellt hat (die Tafel kann das vorgeben)
    // Sternenregen und Sterne gegeneinander: eigene Sterne (Päckchen) bei jedem Gerät, unabhängig vom Licht
    const freeStars = () => !!(st && (st.gm === 'regen' || st.gm === 'sduell'));
    const myBatch = () => { if (!freeStars() || !st.sr) return null; const b = st.sr[ID]; return b && b.n > 0 && (b.c || 0) < b.n ? b : null; };
    let fsK = -1;
    const starAuto = () => {
      if (freeStars()) return false;
      const c = cfg();
      if (c.sa !== undefined) return c.sa === 1;
      if (starPref) return starPref === 'auto';
      return mode !== 'touch';
    };
    const myLight = () => (st ? st.lights.find((l) => l.h === ID) : null);
    // Liegt bei diesem Gerät gerade ein Schatz, und aus wie vielen Sternen besteht er? (Die Tafel legt das beim Eintreffen des Lichts fest.)
    const treasureHere = () => { if (freeStars()) return !!myBatch(); const l = myLight(); return !!(l && st.gm === 'schatz' && l.n > 0); };
    const starTotal = () => { if (freeStars()) { const b = myBatch(); return b ? b.n : 1; } const l = myLight(); return l && l.n > 0 ? l.n : 1; };
    const starsDone = () => (freeStars() ? (!myBatch() || starCount >= myBatch().n) : starCount >= starTotal());
    const starTapNeeded = () => treasureHere() && !starAuto();
    // Schatz-Licht, schwerer: Am Touch-Gerät muss der Stern in einen Korb gezogen werden, der den Platz wechselt
    const dragMode = () => !!(st && st.sb === 1 && mode === 'touch' && (st.gm === 'schatz' || freeStars()) && starTapNeeded());

    const scrMode = $('scr-mode');
    const scrPlay = $('scr-play');
    const net = new LK.Net(room, startBroker, ['state', 'ping']);

    // Die Tafel will wissen, welches Gerät das ist: Form und Farbe groß zeigen, auch auf dem Startbildschirm
    let blinkTimer = null;
    function hideBlink() { clearTimeout(blinkTimer); $('blink').hidden = true; }
    net.on('ping', (m) => {
      if (m.id !== ID) return;
      const s = st && st.players ? st.players[ID] : undefined;
      let col = s !== undefined ? LK.COLORS[s] : '#8b90b0';
      if (s !== undefined && LK.isTeamGm(st.gm) && st.team && st.team[ID] !== undefined) col = LK.TEAM_COLORS[st.team[ID]];
      $('blink').style.setProperty('--bc', col);
      $('blinkShape').innerHTML = LK.shapeSvg(s !== undefined ? s : 0);
      $('blink').hidden = false;
      if (navigator.vibrate) navigator.vibrate(60);
      clearTimeout(blinkTimer);
      blinkTimer = setTimeout(hideBlink, 6000);
    });
    $('blink').addEventListener('click', hideBlink);

    // ---------- Startbildschirm: Eingabeart wählen ----------
    function showMode() {
      active = false;
      holding = false;
      clearTimeout(resendTimer);
      scrPlay.hidden = true;
      if ($('scr-switch')) $('scr-switch').hidden = true;
      scrMode.hidden = false;
      document.querySelectorAll('.card').forEach((c) => c.classList.toggle('last', c.dataset.mode === mode));
      document.querySelectorAll('[data-w]').forEach((b) => b.setAttribute('aria-pressed', String(parseInt(b.dataset.w, 10) === wait)));
      document.querySelectorAll('[data-snd]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.snd === '1') === sound)));
      document.querySelectorAll('[data-tg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tg === target)));
      document.querySelectorAll('[data-nt]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.nt === '1') === noTime)));
      document.querySelectorAll('[data-team]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.team === team)));
      document.querySelectorAll('[data-miss]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.miss === '1') === missOn)));
      document.querySelectorAll('[data-sapref]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.sapref === starPref)));
      $('cfgNote').hidden = !Object.keys(cfg()).length;
    }

    // Ein springender Punkt gilt für Tippen und Maus, nicht für den Taster
    const trOn = () => !!(st && st.gm === 'extrem' && mode === 'touch');
    const useRandom = () => trOn() || eTarget() === 'rnd' && (mode !== 'taster' || cfg().rnd === 1) && !(st && (st.gm === 'muster' || st.gm === 'geheim')); // dort bleibt das eigene Symbol in der Mitte
    const hintText = () => {
      if (useRandom()) return mode === 'blick' ? 'Klicke auf den leuchtenden Punkt' : 'Tippe auf den leuchtenden Punkt';
      return MODES[mode].hint;
    };
    // Schatz-Licht, "ein Tipp reicht": Hinweis, dass der Stern von selbst mitkommt
    const autoStarMsg = (light) => `${hintText()} · ★${light && light.n > 1 ? ` ×${light.n}` : ''} wird automatisch eingesammelt`;
    // Schatz-Licht: Was muss gerade noch passieren?
    const starMsg = () => {
      const total = starTotal();
      const nth = `Stern ${starCount + 1} von ${total}`;
      if (!starsDone()) {
        if (mode === 'taster') return total === 1 ? 'Erst den Stern ★, dann das Licht: zweimal drücken' : `Taster: ${nth} ★`;
        if (total === 1) return lightTapped ? 'Tippe auch den Stern ★' : `${hintText()} und den Stern ★`;
        return `${mode === 'blick' ? 'Schau auf' : 'Tippe'} ${nth} ★`;
      }
      if (mode === 'taster') return 'Jetzt noch einmal für das Licht';
      return mode === 'blick' ? 'Jetzt auf den Kreis schauen' : 'Jetzt das Licht weitergeben';
    };

    document.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
      mode = c.dataset.mode;
      LK.store.set('lk_mode', mode);
      LK.audio.init();
      LK.keepAwake();
      if (mode === 'taster') showSwitchSetup(); // erst den Taster einrichten
      else begin();
    }));

    // ---------- Taster einrichten: Taste anlernen oder aus einer Liste wählen ----------
    // Viele Taster (zum Beispiel iSwitch oder Bluetooth-Schalter) senden die Leertaste, andere Enter, Pfeiltasten oder Ziffern.
    // Die iPad-Schaltersteuerung (Bedienungshilfen) sendet dagegen Tipps statt Tasten: dafür gibt es "Nur Bildschirm".
    const SW_KEYS = {
      Space: 'Leertaste', Enter: 'Enter', NumpadEnter: 'Enter (Ziffernblock)', ArrowRight: 'Pfeil rechts', ArrowLeft: 'Pfeil links',
      ArrowUp: 'Pfeil hoch', ArrowDown: 'Pfeil runter', Escape: 'Esc', Backspace: 'Rücktaste', Tab: 'Tab',
    };
    const IGNORE_KEYS = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead', 'Unidentified'];
    function keyLabel(e) {
      if (SW_KEYS[e.code]) return SW_KEYS[e.code];
      if (/^Digit\d$/.test(e.code)) return `Taste ${e.code.slice(5)}`;
      if (/^Numpad\d$/.test(e.code)) return `Ziffernblock ${e.code.slice(6)}`;
      if (/^Key[A-Z]$/.test(e.code)) return `Taste ${e.code.slice(3)}`;
      if (e.key && e.key.length <= 12) return `Taste „${e.key}“`;
      return e.code || 'unbekannte Taste';
    }
    function loadSwitch() {
      try {
        const o = JSON.parse(LK.store.get('lk_switch', 'null'));
        if (o && ['key', 'any', 'tap'].includes(o.kind)) return o;
      } catch (e) { /* kaputter Eintrag */ }
      return { kind: 'default' };
    }
    let sw = loadSwitch();
    function switchLabel(s) {
      if (s.kind === 'key') return s.label || 'eine Taste';
      if (s.kind === 'any') return 'jede Taste';
      if (s.kind === 'tap') return 'nur Bildschirm (Tippen, Schaltersteuerung)';
      return 'Leertaste oder Enter';
    }
    // Gehört dieser Tastendruck zum Taster dieses Geräts?
    function switchMatches(e) {
      switch (sw.kind) {
        case 'key': return (sw.code && e.code === sw.code) || (!sw.code && !!sw.key && e.key === sw.key);
        case 'any': return !IGNORE_KEYS.includes(e.key) && e.key !== 'Tab';
        case 'tap': return false;
        default: return e.key === ' ' || e.key === 'Enter' || e.code === 'Space';
      }
    }

    const scrSwitch = $('scr-switch');
    let swLearnedAt = 0; // Zeitpunkt, zu dem die Taste angelernt wurde (ein zweiter Druck startet das Spiel)

    function renderSwitch() {
      document.querySelectorAll('[data-swstar]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.swstar === (starPref === 'tap' ? 'tap' : 'auto'))));
      $('swResult').textContent = sw.kind === 'default' ? 'Noch keine Taste gewählt. Es gelten Leertaste und Enter.' : `Erkannt: ${switchLabel(sw)}`;
      $('swResult').classList.toggle('ok', sw.kind !== 'default');
      $('swHint').textContent = sw.kind === 'key' ? 'Drücke den Taster noch einmal zum Starten, oder tippe auf „Weiter“.' : '';
      document.querySelectorAll('[data-swk]').forEach((b) => {
        const v = b.dataset.swk;
        const on = (v === 'any' && sw.kind === 'any') || (v === 'tap' && sw.kind === 'tap') || (sw.kind === 'key' && sw.code === v);
        b.setAttribute('aria-pressed', String(on));
      });
    }

    let swHintTimer = null;
    function showSwitchSetup() {
      active = false;
      holding = false;
      clearTimeout(resendTimer);
      scrMode.hidden = true;
      scrPlay.hidden = true;
      scrSwitch.hidden = false;
      // Ist schon eine Taste eingestellt, startet ein Druck darauf sofort
      swLearnedAt = sw.kind === 'key' ? performance.now() - 1000 : 0;
      renderSwitch();
      // Kommt keine Taste an, arbeitet der Taster vermutlich über die iPad-Schaltersteuerung (zum Beispiel der iSwitch): Hilfe zeigen
      clearTimeout(swHintTimer);
      swHintTimer = setTimeout(() => {
        if (!scrSwitch.hidden && sw.kind === 'default') {
          $('swHint').textContent = 'Noch keine Taste erkannt. Arbeitet dein Taster mit der iPad-Schaltersteuerung? Dann unten „Nur Bildschirm“ wählen. Mehr in der Hilfe.';
          $('swHelp').open = true;
        }
      }, 6000);
      try { $('swTitle').focus({ preventScroll: true }); } catch (e) { /* ältere Browser */ }
    }

    function startFromSwitch() {
      LK.store.set('lk_switch', JSON.stringify(sw));
      scrSwitch.hidden = true;
      begin();
    }

    document.addEventListener('keydown', (e) => {
      if (scrSwitch.hidden) return;
      if (IGNORE_KEYS.includes(e.key) || e.key === 'Tab') return;
      e.preventDefault();
      if (e.repeat) return;
      const now = performance.now();
      const same = sw.kind === 'key' && ((sw.code && e.code === sw.code) || (!sw.code && e.key === sw.key));
      if (same && swLearnedAt && now - swLearnedAt > 500) { startFromSwitch(); return; } // zweiter Druck: los
      sw = { kind: 'key', code: e.code || '', key: e.key || '', label: keyLabel(e) };
      swLearnedAt = now;
      renderSwitch();
    });
    document.addEventListener('keyup', (e) => { if (!scrSwitch.hidden) e.preventDefault(); });

    document.querySelectorAll('[data-swk]').forEach((b) => b.addEventListener('click', () => {
      const v = b.dataset.swk;
      if (v === 'any') sw = { kind: 'any' };
      else if (v === 'tap') sw = { kind: 'tap' };
      else sw = { kind: 'key', code: v, key: '', label: b.textContent.trim() };
      swLearnedAt = 0;
      renderSwitch();
    }));
    // Taster: Ein Druck für alle Sterne oder ein Druck pro Stern (die Spielleitung kann das pro Gerät überschreiben)
    document.querySelectorAll('[data-swstar]').forEach((b) => b.addEventListener('click', () => {
      starPref = b.dataset.swstar;
      LK.store.set('lk_sa', starPref);
      renderSwitch();
    }));
    $('swGo').addEventListener('click', startFromSwitch);
    $('swBack').addEventListener('click', () => { scrSwitch.hidden = true; showMode(); });
    document.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
      wait = parseInt(b.dataset.w, 10);
      LK.store.set('lk_wait', String(wait));
      showMode();
    }));
    document.querySelectorAll('[data-snd]').forEach((b) => b.addEventListener('click', () => {
      sound = b.dataset.snd === '1';
      LK.store.set('lk_snd', sound ? '1' : '0');
      showMode();
    }));

    document.querySelectorAll('[data-tg]').forEach((b) => b.addEventListener('click', () => {
      target = b.dataset.tg;
      LK.store.set('lk_tg', target);
      showMode();
    }));
    document.querySelectorAll('[data-nt]').forEach((b) => b.addEventListener('click', () => {
      noTime = b.dataset.nt === '1';
      LK.store.set('lk_nt', noTime ? '1' : '0');
      showMode();
    }));
    document.querySelectorAll('[data-sapref]').forEach((b) => b.addEventListener('click', () => {
      starPref = b.dataset.sapref;
      LK.store.set('lk_sa', starPref);
      showMode();
    }));
    document.querySelectorAll('[data-miss]').forEach((b) => b.addEventListener('click', () => {
      missOn = b.dataset.miss === '1';
      LK.store.set('lk_miss', missOn ? '1' : '0');
      showMode();
    }));
    document.querySelectorAll('[data-team]').forEach((b) => b.addEventListener('click', () => {
      team = b.dataset.team;
      LK.store.set('lk_team', team);
      showMode();
    }));

    // Vollbild (wo der Browser es erlaubt, auf dem iPhone nicht). Tipp: Auf dem iPad hilft auch "Zum Home-Bildschirm".
    const rootEl = document.documentElement;
    const fsOk = !!(rootEl.requestFullscreen || rootEl.webkitRequestFullscreen);
    function toggleFullscreen() {
      const d = document;
      try {
        if (d.fullscreenElement || d.webkitFullscreenElement) {
          (d.exitFullscreen || d.webkitExitFullscreen).call(d);
        } else {
          const p = (rootEl.requestFullscreen || rootEl.webkitRequestFullscreen).call(rootEl);
          if (p && p.catch) p.catch(() => {});
        }
      } catch (e) { /* nicht erlaubt */ }
    }
    document.querySelectorAll('.fsbtn').forEach((b) => {
      b.hidden = !fsOk || b.id === 'fsPlay';
      b.addEventListener('click', () => { toggleFullscreen(); b.blur(); });
    });

    // Zufällige Stelle für den Punkt: nicht in der Mitte, nicht am Rand, nicht wieder an der letzten Stelle
    // Muster auf dem Gerät spiegeln: Die Reihenfolge erscheint Symbol für Symbol und bleibt als Reihe stehen
    let muFk = -1;
    function muStrip(tapGm) {
      const el = $('muStrip');
      const mu = st && st.gm === 'muster' ? st.mu : null;
      const ph = mu ? mu.ph : '';
      const showIt = tapGm && mu && st.ph === 'play' && !st.finale && mu.sq.length && ['show', 'shown', 'go', 'again', 'next'].includes(ph);
      el.hidden = !showIt;
      if (!showIt) { muFk = -1; return; }
      const upto = ph === 'show' ? (mu.si === undefined ? -1 : mu.si) : mu.sq.length - 1;
      el.innerHTML = mu.sq.map((id, k) => {
        const sl = st.players[id];
        if (sl === undefined || k > upto) return '<i class="mu-empty"></i>';
        const cls = ['mu-s'];
        if (ph === 'show' && mu.cur === id && k === mu.si) cls.push('now');
        if ((ph === 'go' && k < mu.i) || ph === 'next') cls.push('done');
        else if (ph === 'go' && k === mu.i) cls.push('next');
        return `<i class="${cls.join(' ')}" style="color:${LK.COLORS[sl % LK.COLORS.length]}">${LK.shapeSvg(sl)}</i>`;
      }).join('');
      // Wer gerade gezeigt wird, spielt den eigenen Ton auf seinem Gerät
      if (ph === 'show' && mu.cur === ID && mu.fk !== muFk) { muFk = mu.fk; if (sound && slot >= 0) LK.audio.note(slot, 0.4, 1.0); }
    }

    // Dunkelheit: Stand der Gruppe und des Schattens auch auf dem Gerät
    function dkUpdate() {
      const el = $('dkBars');
      const fresh = st && Date.now() - lastStateAt < 16000;
      const on = !!(fresh && st.gm === 'dunkel' && st.ph === 'play' && !st.finale && slot >= 0);
      el.hidden = !on;
      if (!on) return;
      const lvl = Math.max(0, Math.min(1, (st.dk || 0) + (st.dkr || 0) * ((Date.now() - lastStateAt) / 1000)));
      const prog = Math.min(1, (st.chain || 0) / Math.max(1, st.goal || 1));
      $('dkLt').textContent = `${st.chain || 0} / ${st.goal || 0}`;
      $('dkLf').style.width = `${Math.round(prog * 100)}%`;
      $('dkDv').textContent = `${Math.round(lvl * 100)} %`;
      $('dkDf').style.width = `${Math.round(lvl * 100)}%`;
      const danger = lvl > 0.75;
      el.classList.toggle('danger', danger);
      $('dkDl').textContent = danger ? 'Dunkelheit: gleich zu spät!' : (!st.dkr ? 'Dunkelheit steht still' : 'Dunkelheit');
    }
    setInterval(dkUpdate, 300);

    // Countdown 3, 2, 1 auf allen Geräten (ab dem Moment, in dem das Gerät "count" sieht)
    let cdAt = 0;
    let cdTick = null;
    function cdShow() {
      const left = Math.max(0, (st.cd || 3000) - (performance.now() - cdAt));
      const n = Math.max(1, Math.ceil(left / 1000));
      if ($('cdNum').textContent !== String(n)) { $('cdNum').textContent = String(n); try { navigator.vibrate && navigator.vibrate(30); } catch (e) { /* egal */ } }
    }
    function cdSync(fresh) {
      const on = fresh && st.ph === 'count' && !st.finale;
      if (on && !cdAt) { cdAt = performance.now(); $('cdNum').textContent = ''; cdTick = setInterval(cdShow, 100); cdShow(); }
      if (!on && cdAt) { cdAt = 0; clearInterval(cdTick); }
      $('cdOv').hidden = !on || performance.now() - cdAt > (st.cd || 3000) + 600;
    }
    // ---------- Lichtkette extrem: erst eine Spur nachziehen, dann geht das Licht von selbst weiter ----------
    // Stufen 1 bis 6: mehr Kurven, schmalere Spur. Ab Stufe 5 mehrere Spuren: nebeneinander (gleichzeitig mit mehreren Fingern)
    // oder übereinander (kreuz und quer, jede muss erst von einer anderen freigeschaltet werden). Die Stufe passt sich jedem Gerät an.
    const X_BEND = [1, 2, 3, 3, 4, 4];
    const X_WIDTH = [0.17, 0.15, 0.13, 0.115, 0.11, 0.105];
    const X_FING = [1, 1, 1, 1, 2, 3];
    const X_TIME = [3, 3.6, 7, 9, 11, 14]; // so viele Sekunden gelten als "genau richtig"
    const X_COL = ['#7dd3fc', '#f9a8d4', '#fde047'];
    const R_COL = ['#f07a6a', '#f1cd6e', '#f2e8a6', '#a5d6ae'];
    const X_SHAPES = [['free', 'free', 'free', 'sine', 'arc'], ['free', 'free', 'free', 'sine', 'arc', 'tri'], ['free', 'free', 'free', 'free', 'sine', 'tri', 'grow'], ['free', 'free', 'free', 'free', 'tri', 'grow', 'stairs', 'arc'], ['free', 'free', 'free', 'free', 'tri', 'grow', 'stairs'], ['free', 'free', 'free', 'free', 'free', 'tri', 'grow', 'stairs']];
    const X_PLAIN = ['sine', 'arc', 'tri', 'grow', 'stairs'];
    let tr = null;
    let xLvl = 0;
    let xStreak = 0;
    const xLevel = () => { if (!xLvl) xLvl = (st && st.xl) || 2; return Math.max(1, Math.min(6, xLvl)); };
    const trCv = () => $('traceCv');
    const smooth = (u) => u * u * (3 - 2 * u);
    // Form der Auslenkung (-1 bis 1) entlang der Spur, t von 0 bis 1
    function shapeFn(kind, bends) {
      switch (kind) {
        case 'arc': return (t) => Math.sin(Math.PI * t);
        case 'tri': return (t) => (2 / Math.PI) * Math.asin(Math.sin(bends * Math.PI * t));
        case 'grow': return (t) => Math.sin(bends * Math.PI * t) * (0.3 + 0.9 * t);
        case 'stairs': return (t) => { const u = t * (bends + 1); const f = Math.floor(u); return ((f + smooth(u - f)) / (bends + 1)) * 2 - 1; };
        default: return (t) => Math.sin(bends * Math.PI * t);
      }
    }
    // Eine Spur von einer Seite zur anderen, auch diagonal. Sie liegt immer ganz auf dem Bildschirm.
    // Freie Kurve: ein glatter Verlauf durch zufällige Punkte. Start und Ziel liegen irgendwo, je höher die Stufe, desto mehr Windungen.
    function freePath(lvl, w) {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const vm = Math.min(W, H);
      const pad = w * 0.5 + 10 + vm * 0.03;
      const x0 = pad; const x1 = W - pad; const y0 = pad; const y1 = H * 0.8 - pad;
      const R = Math.hypot(x1 - x0, y1 - y0);
      const rnd = (a, b) => a + Math.random() * (b - a);
      const clampPt = (q) => [Math.max(x0, Math.min(x1, q[0])), Math.max(y0, Math.min(y1, q[1]))];
      for (let att = 0; att < 50; att++) {
        const ease = att > 30 ? 0.55 : 1;
        let S; let E; let g = 0;
        do { S = [rnd(x0, x1), rnd(y0, y1)]; E = [rnd(x0, x1), rnd(y0, y1)]; g++; } while (Math.hypot(E[0] - S[0], E[1] - S[1]) < R * (0.45 - Math.min(0.2, g * 0.01)) && g < 40);
        const dx = E[0] - S[0]; const dy = E[1] - S[1];
        const len = Math.hypot(dx, dy) || 1;
        const px = -dy / len; const py = dx / len;
        const kmid = lvl + 1 + (Math.random() < 0.5 ? 0 : 1);
        const ctrl = [S];
        let side = Math.random() < 0.5 ? 1 : -1;
        for (let i = 1; i <= kmid; i++) {
          const t = Math.min(0.96, Math.max(0.04, i / (kmid + 1) + rnd(-0.35, 0.35) / (kmid + 1)));
          const off = side * rnd(0.35, 1) * Math.min(len * 0.4, vm * 0.32) * ease * (0.6 + 0.1 * lvl);
          ctrl.push(clampPt([S[0] + dx * t + px * off, S[1] + dy * t + py * off]));
          side = Math.random() < 0.75 ? -side : side;
        }
        ctrl.push(E);
        // Catmull-Rom, danach in gleichmäßige Schritte zerlegt
        const dense = [];
        const P = [ctrl[0], ...ctrl, ctrl[ctrl.length - 1]];
        for (let i = 1; i < P.length - 2; i++) {
          for (let k = 0; k < 14; k++) {
            const t = k / 14; const t2 = t * t; const t3 = t2 * t;
            const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
            dense.push([f(P[i - 1][0], P[i][0], P[i + 1][0], P[i + 2][0]), f(P[i - 1][1], P[i][1], P[i + 1][1], P[i + 2][1])]);
          }
        }
        dense.push(E);
        const cum = [0];
        for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]));
        const total = cum[cum.length - 1];
        const pts = [];
        let j = 0;
        for (let i = 0; i <= 72; i++) {
          const target = (total * i) / 72;
          while (j < cum.length - 2 && cum[j + 1] < target) j++;
          const seg = cum[j + 1] - cum[j] || 1;
          const u = (target - cum[j]) / seg;
          pts.push(clampPt([dense[j][0] + (dense[j + 1][0] - dense[j][0]) * u, dense[j][1] + (dense[j + 1][1] - dense[j][1]) * u]));
        }
        // nicht zu eng, nicht mit sich selbst verwechselbar
        let ok = true;
        const gapIdx = Math.ceil((w * 3.2) / (total / 72));
        for (let a = 0; a < pts.length && ok; a++) {
          for (let b = a + gapIdx; b < pts.length; b++) {
            if (Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]) < w * 1.25) { ok = false; break; }
          }
        }
        if (ok) return pts;
      }
      return null;
    }
    function makePath(lvl, w, kind, orient) {
      if (kind === 'free') {
        const fp = freePath(lvl, w);
        if (fp) return fp;
        kind = 'sine';
      }
      const W = window.innerWidth;
      const H = window.innerHeight;
      const vm = Math.min(W, H);
      const pad = w * 0.5 + 10;
      const top = pad + vm * 0.04;
      const bot = H * 0.8 - pad;
      const left = pad + vm * 0.04;
      const right = W - pad - vm * 0.04;
      const o = orient !== undefined ? orient : Math.floor(Math.random() * 6);
      const flip = Math.random() < 0.5;
      let sx; let sy; let ex; let ey;
      const hi = bot - (bot - top) * 0.08;
      const lo = top + (bot - top) * 0.08;
      if (o === 0) { sx = left; ex = right; sy = flip ? hi : lo; ey = flip ? lo : hi; }
      else if (o === 1) { sx = right; ex = left; sy = flip ? hi : lo; ey = flip ? lo : hi; }
      else if (o === 2) { sy = hi; ey = lo; sx = flip ? left : right; ex = flip ? right : left; }
      else if (o === 3) { sy = lo; ey = hi; sx = flip ? left : right; ex = flip ? right : left; }
      else if (o === 4) { sx = left; sy = hi; ex = right; ey = lo; if (flip) { [sx, ex] = [ex, sx]; [sy, ey] = [ey, sy]; } }
      else { sx = left; sy = lo; ex = right; ey = hi; if (flip) { [sx, ex] = [ex, sx]; [sy, ey] = [ey, sy]; } }
      const dx = ex - sx; const dy = ey - sy;
      const len = Math.hypot(dx, dy);
      const ux = dx / len; const uy = dy / len;
      const px = -uy; const py = ux;
      const bends = X_BEND[lvl - 1];
      const fn = shapeFn(kind, bends);
      const sign = Math.random() < 0.5 ? 1 : -1;
      let amp = Math.min(len * 0.22, vm * 0.24) * (0.55 + 0.08 * lvl);
      let pts = [];
      for (let attempt = 0; attempt < 8; attempt++) {
        pts = [];
        for (let i = 0; i <= 72; i++) {
          const t = i / 72;
          const a2 = amp * fn(t) * sign;
          pts.push([sx + dx * t + px * a2, sy + dy * t + py * a2]);
        }
        const ok = pts.every((q) => q[0] >= pad && q[0] <= W - pad && q[1] >= pad && q[1] <= H * 0.84);
        if (ok) break;
        amp *= 0.85;
      }
      pts.forEach((q) => { q[0] = Math.max(pad, Math.min(W - pad, q[0])); q[1] = Math.max(pad, Math.min(H * 0.84, q[1])); });
      return pts;
    }
    // Bänder (mehrere Spuren, wie bei "Slide to unlock"): dicke Bänder liegen kreuz und quer übereinander. Man zieht an jedem Band den Knopf
    // vom Anfang zum Ende. Das Band zieht sich dabei zurück. Wo ein anderes Band oben liegt, kommt man erst durch, wenn dieses Band dort weg ist.
    // Mehrere Bänder liegen kreuz und quer übereinander. Nur das oberste ist frei, die anderen werden nacheinander frei, sobald das davor am Ziel ist.
    const rLocked = (p) => p.lock >= 0 && !tr.paths[p.lock].done;
    function traceBegin() {
      const W = window.innerWidth;
      const H = window.innerHeight;
      const vm = Math.min(W, H);
      const lvl = xLevel();
      const n = [1, 1, 2, Math.random() < 0.5 ? 2 : 3, 3, Math.random() < 0.8 ? 3 : 4][lvl - 1];
      let paths = [];
      let w = vm * X_WIDTH[lvl - 1];
      if (n === 1) {
        const kinds = X_SHAPES[lvl - 1];
        paths = [{ pts: makePath(lvl, w, kinds[Math.floor(Math.random() * kinds.length)]), prog: 0, done: false, lock: -1 }];
      } else {
        w = vm * [0.15, 0.15, 0.125, 0.115, 0.105, 0.1][lvl - 1];
        const order = [...Array(n).keys()].sort(() => Math.random() - 0.5); // order[0] ist frei, der Rest wird nacheinander frei
        for (let tries = 0; tries < 40; tries++) {
          paths = [];
          for (let i = 0; i < n; i++) paths.push({ pts: makePath(lvl, w, 'free'), prog: 0, done: false, lock: -1, col: R_COL[i % R_COL.length] });
          // Startknöpfe und Zielknöpfe dürfen sich nicht überdecken
          const ends = [];
          paths.forEach((q) => { ends.push(q.pts[0]); ends.push(q.pts[72]); });
          let clash = false;
          for (let i = 0; i < ends.length && !clash; i++) for (let j = i + 1; j < ends.length; j++) if (Math.hypot(ends[i][0] - ends[j][0], ends[i][1] - ends[j][1]) < w * 1.2) { clash = true; break; }
          if (!clash) break;
        }
        if (n === 3 && Math.random() < 0.4) {
          // gemischt: Ein Band schaltet gleich zwei andere frei
          paths[order[1]].lock = order[0];
          paths[order[2]].lock = order[0];
        } else {
          for (let k = 1; k < n; k++) paths[order[k]].lock = order[k - 1];
        }
        tr = { order };
      }
      const order = tr && tr.order ? tr.order : null;
      tr = { paths, w, t0: performance.now(), lvl, resets: 0, done: false, fingers: {}, ribbon: n > 1, order };
      const last = n > 1 ? paths[order[order.length - 1]] : paths[0];
      const hold = $('hold');
      const ex0 = last.pts[72][0];
      const ey0 = last.pts[72][1];
      hold.style.left = `${ex0}px`;
      hold.style.top = `${ey0}px`;
      scrPlay.style.setProperty('--gx', `${(ex0 / W) * 100}%`);
      scrPlay.style.setProperty('--gy', `${(ey0 / H) * 100}%`);
      const cv = trCv();
      cv.width = W * 2; cv.height = H * 2;
      cv.hidden = false;
      requestAnimationFrame(traceDraw);
    }
    function traceEnd() {
      tr = null;
      trCv().hidden = true;
    }
    function ribbonDraw(g, now) {
      const w = tr.w;
      g.lineCap = 'round'; g.lineJoin = 'round';
      const strokeSeg = (pts, from, to, width, style) => {
        if (to <= from) return;
        g.beginPath();
        for (let k = from; k <= to; k++) { if (k === from) g.moveTo(pts[k][0], pts[k][1]); else g.lineTo(pts[k][0], pts[k][1]); }
        g.lineWidth = width; g.strokeStyle = style; g.stroke();
      };
      const shade = (c, f) => { const n = parseInt(c.slice(1), 16); return `rgb(${Math.round((n >> 16) * f)},${Math.round(((n >> 8) & 255) * f)},${Math.round((n & 255) * f)})`; };
      const hide = tr.lvl >= 6; // ab Stufe 6 sieht man den Bändern nicht an, welches noch gesperrt ist
      const locked = (p) => rLocked(p);
      // gesperrte Bänder liegen unten, freie oben
      const order = tr.paths.map((p, i) => i).sort((x, y) => (locked(tr.paths[y]) ? 1 : 0) - (locked(tr.paths[x]) ? 1 : 0));
      order.forEach((i) => {
        const p = tr.paths[i];
        const dim = locked(p) && !hide;
        g.globalAlpha = dim ? 0.55 : 1;
        // Zielknopf
        g.beginPath(); g.arc(p.pts[72][0], p.pts[72][1], w * 0.5, 0, Math.PI * 2); g.fillStyle = shade(p.col, 0.7); g.fill();
        // Band: vom Knopf bis zum Ziel, wird beim Ziehen kürzer
        strokeSeg(p.pts, p.prog, 72, w, p.col);
        // Knopf
        const q = p.pts[Math.min(72, p.prog)];
        g.beginPath(); g.arc(q[0], q[1], w * 0.5, 0, Math.PI * 2); g.fillStyle = shade(p.col, 0.7); g.fill();
        if (!p.done && !dim) {
          const k = 0.5 + 0.5 * Math.sin(now / 300);
          g.beginPath(); g.arc(q[0], q[1], w * (0.5 + 0.06 * k), 0, Math.PI * 2); g.lineWidth = 4; g.strokeStyle = 'rgba(255,255,255,0.55)'; g.stroke();
        }
        if (dim) {
          // Schloss: kleiner Ring in der Farbe des Bandes, das dieses öffnet
          const kc = tr.paths[p.lock].col;
          g.beginPath(); g.arc(q[0], q[1], w * 0.2, 0, Math.PI * 2); g.lineWidth = 5; g.strokeStyle = kc; g.stroke();
          g.fillStyle = kc; g.fillRect(q[0] - w * 0.12, q[1] - w * 0.02, w * 0.24, w * 0.16);
        }
        g.globalAlpha = 1;
      });
    }
    function traceDraw(now) {
      if (!tr) return;
      const cv = trCv();
      const g = cv.getContext('2d');
      g.setTransform(2, 0, 0, 2, 0, 0);
      g.clearRect(0, 0, window.innerWidth, window.innerHeight);
      if (tr.ribbon) {
        ribbonDraw(g, now);
      } else {
        const col = getComputedStyle(scrPlay).getPropertyValue('--c').trim() || '#7dd3fc';
        tr.paths.forEach((p) => {
          const pts = p.pts;
          g.lineCap = 'round'; g.lineJoin = 'round';
          const stroke = (from, to, width, style, blur) => {
            g.beginPath();
            for (let k = from; k <= to; k++) { if (k === from) g.moveTo(pts[k][0], pts[k][1]); else g.lineTo(pts[k][0], pts[k][1]); }
            g.lineWidth = width; g.strokeStyle = style; g.shadowColor = col; g.shadowBlur = blur; g.stroke();
            g.shadowBlur = 0;
          };
          stroke(0, pts.length - 1, tr.w, 'rgba(255,255,255,0.10)', 0);
          stroke(0, pts.length - 1, 3, 'rgba(255,255,255,0.4)', 0);
          if (p.prog > 0) stroke(0, p.prog, tr.w * 0.55, col, 24);
          if (!p.done) {
            const k = 0.5 + 0.5 * Math.sin(now / 260);
            g.beginPath(); g.arc(pts[0][0], pts[0][1], tr.w * (0.42 + 0.1 * k), 0, Math.PI * 2);
            g.fillStyle = col; g.globalAlpha = 0.95; g.fill(); g.globalAlpha = 1;
          }
        });
      }
      Object.values(tr.fingers).forEach((f) => {
        g.beginPath(); g.arc(f.x, f.y, tr.w * 0.18, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,0.9)'; g.fill();
      });
      requestAnimationFrame(traceDraw);
    }
    function traceFinished() {
      if (!tr || tr.done) return;
      tr.done = true;
      const secs = (performance.now() - tr.t0) / 1000;
      const T = X_TIME[tr.lvl - 1];
      if (st && st.xa === 1) {
        const ratio = secs / T;
        if (ratio < 0.65 && tr.resets === 0) { xStreak++; if (xStreak >= 2 && xLvl < 6) { xLvl = Math.min(6, xLevel() + 1); xStreak = 0; } }
        else if (ratio > 1.7 || tr.resets >= 3) { xLvl = Math.max(1, xLevel() - 1); xStreak = 0; }
        else xStreak = 0;
      }
      if (sound && slot >= 0) LK.audio.note(slot, 0.35, 1.0, 0, 1);
      if (navigator.vibrate) { try { navigator.vibrate(25); } catch (e) { /* egal */ } }
      lockUntil = 0;
      sendHb();
      render();
      // Am Ende geht das Licht gleich weiter, ohne noch einmal zu tippen
      const light = myLight();
      if (light && !light.z && !st.paused && holding) setTimeout(() => { if (holding && tr && tr.done) finishPass(myLight() || light, false); }, 180);
    }
    function traceMove(e) {
      const f = tr && tr.fingers[e.pointerId];
      if (!f) return;
      f.x = e.clientX; f.y = e.clientY;
      const i = f.i;
      const p = tr.paths[i];
      if (p.done) return;
      const lo = Math.max(0, p.prog - 2);
      const hi = Math.min(p.pts.length - 1, p.prog + 24);
      let best = -1; let bd = Infinity;
      for (let k = lo; k <= hi; k++) {
        const d = Math.hypot(p.pts[k][0] - e.clientX, p.pts[k][1] - e.clientY);
        if (d < bd) { bd = d; best = k; }
      }
      if (tr.ribbon) {
        // Band: Der Knopf folgt dem Finger entlang des Bandes. Wer abrutscht, behält den Fortschritt, das Band wird nie wieder länger.
        if (bd <= tr.w * 1.4 && best > p.prog) {
          p.prog = best;
          if (p.prog >= p.pts.length - 3) {
            p.prog = 72;
            p.done = true;
            if (sound && slot >= 0) LK.audio.note(slot, 0.2, 0.7, 0, 2); // ein Band ist weg, das nächste wird frei
            if (tr.paths.every((q) => q.done)) traceFinished();
          }
        }
        return;
      }
      if (bd <= tr.w * 0.62) {
        if (best > p.prog) p.prog = best;
        if (p.prog >= p.pts.length - 3) {
          p.done = true;
          if (tr.paths.every((q) => q.done)) traceFinished();
        }
      } else if (bd > tr.w * 1.1 && p.prog > 0) {
        p.prog = 0;
        tr.resets++;
        if (navigator.vibrate) { try { navigator.vibrate(10); } catch (err) { /* egal */ } }
      }
    }
    trCv().addEventListener('pointerdown', (e) => {
      if (!tr || tr.done || st.paused) return;
      e.preventDefault();
      let bi = -1; let bd = Infinity;
      tr.paths.forEach((p, i) => {
        if (p.done || (tr.ribbon && rLocked(p)) || Object.values(tr.fingers).some((f) => f.i === i)) return;
        const q = p.pts[tr.ribbon ? Math.min(72, p.prog) : 0];
        const d = Math.hypot(q[0] - e.clientX, q[1] - e.clientY);
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi < 0 || bd > tr.w * 1.3) {
        if (tr.ribbon && navigator.vibrate && tr.paths.some((p) => !p.done && rLocked(p) && Math.hypot(p.pts[Math.min(72, p.prog)][0] - e.clientX, p.pts[Math.min(72, p.prog)][1] - e.clientY) < tr.w * 0.8)) { try { navigator.vibrate(20); } catch (err) { /* egal */ } }
        return;
      }
      tr.fingers[e.pointerId] = { i: bi, x: e.clientX, y: e.clientY };
      try { trCv().setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
    });
    trCv().addEventListener('pointermove', traceMove);
    const traceUp = (e) => {
      if (!tr) return;
      const f = tr.fingers[e.pointerId];
      if (!f) return;
      const p = tr.paths[f.i];
      if (!tr.ribbon && !p.done) { if (p.prog > 0) tr.resets++; p.prog = 0; }
      delete tr.fingers[e.pointerId];
    };
    trCv().addEventListener('pointerup', traceUp);
    trCv().addEventListener('pointercancel', traceUp);

    // Staffel/Tauziehen, Schwierigkeit: mehrere Treffer pro Weitergabe (nur Touch). Das Symbol springt nach jedem Treffer.
    let mtHit = 0;
    let holdGated = false;
    // Die Einstellung des Spiels gilt für Touch. Taster und Blick-Maus machen nur mit, wenn die Tafel es für dieses Gerät eingestellt hat.
    const mtNeed = () => { if (!st || !LK.isTeamGm(st.gm) || st.gm === 'extrem') return 1; const n = cfg().mt !== undefined ? cfg().mt : (mode === 'touch' ? st.mt : 1); return n > 1 ? n : 1; };
    function placeTarget() {
      const hold = $('hold');
      const w = window.innerWidth;
      const h = window.innerHeight;
      const d = Math.min(Math.max(100, Math.min(Math.min(w, h) * 0.2, 200)) * eSize(), Math.min(w, h) * 0.5);
      const m = d / 2 + 18;
      const top = m;
      const bottom = h * 0.80 - d / 2;
      let x = w / 2;
      let y = h / 2;
      for (let i = 0; i < 40; i++) {
        x = m + Math.random() * Math.max(1, w - 2 * m);
        y = top + Math.random() * Math.max(1, bottom - top);
        const farFromCenter = Math.hypot(x - w / 2, y - h * 0.46) > Math.min(w, h) * 0.24 + d / 2;
        const farFromLast = !lastPos || Math.hypot(x - lastPos.x, y - lastPos.y) > d * 1.2;
        if (farFromCenter && farFromLast) break;
      }
      lastPos = { x, y };
      hold.style.width = `${d}px`;
      hold.style.height = `${d}px`;
      hold.style.left = `${x}px`;
      hold.style.top = `${y}px`;
      scrPlay.style.setProperty('--gx', `${(x / w) * 100}%`);
      scrPlay.style.setProperty('--gy', `${(y / h) * 100}%`);
    }

    function clearTarget() {
      const hold = $('hold');
      ['width', 'height', 'left', 'top'].forEach((p) => hold.style.removeProperty(p));
      scrPlay.style.removeProperty('--gx');
      scrPlay.style.removeProperty('--gy');
    }

    function begin() {
      active = true;
      scrMode.hidden = true;
      scrPlay.hidden = false;
      scrPlay.className = `scr mode-${mode}${useRandom() ? ' rnd' : ''}`;
      $('hold').innerHTML = ''; // das Symbol im Punkt gehört nur zum springenden Punkt, sonst wird es riesig und schwarz
      if (!useRandom()) clearTarget();
      $('hint').textContent = hintText();
      const swCtl = mode === 'taster' && sw.kind === 'tap'; // iPad-Schaltersteuerung läuft: sie würde sonst auch die kleinen Knöpfe abtasten
      $('fsPlay').hidden = !fsOk || mode === 'blick' || swCtl; // bei Augensteuerung kein Knopf, der aus Versehen ausgelöst wird
      $('change').hidden = mode === 'blick' || swCtl; // bei Augensteuerung kein kleiner Knopf, der aus Versehen ausgelöst wird
      sendHb();
      render();
    }

    // ---------- Verbindung ----------
    function sendHb() {
      if (!active) return;
      net.send('hb', { id: ID, w: eWait(), m: mode.charAt(0), nt: eNoTime() ? 1 : 0, tt: eTeam(), tp: pickTeam, tk: seenSk, md: mode, xl: trOn() && slot >= 0 ? xLevel() : 0, pn: eMiss() && mode !== 'taster' ? 1 : 0, bv: LK.BUILD, t: Date.now() });
    }
    setInterval(sendHb, HB_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sendHb(); });

    net.onconnect = () => { sendHb(); render(); };
    net.onstatus = () => render();

    net.on('state', (s) => {
      if (!s.players || typeof s.seq !== 'number' || !Array.isArray(s.lights)) return;
      st = s;
      lastStateAt = Date.now();
      if ((s.sk || 0) !== seenSk) { seenSk = s.sk || 0; if (pickTeam) { pickTeam = ''; } sendHb(); }
      render();
    });
    setInterval(() => { if (active) render(); }, 1500);

    // ---------- Anzeige ----------
    function render() {
      if (!active) return;
      const fresh = st && Date.now() - lastStateAt < 16000;
      const mySlot = fresh && st.players[ID] !== undefined ? st.players[ID] : -1;
      if (mySlot !== slot) {
        slot = mySlot;
        $('shape').innerHTML = slot >= 0 ? LK.shapeSvg(slot) : '';
      }
      const li = fresh ? st.lights.findIndex((l) => l.h === ID) : -1;
      const light = li >= 0 ? st.lights[li] : null;
      // Muster nachspielen und Geheime Reihenfolge: Tippen ohne Licht (das Licht ist dort nur ein Teil des Spiels)
      const tapGm = !!(fresh && slot >= 0 && (st.gm === 'muster' || st.gm === 'geheim'));
      const tg = tapGame(tapGm);
      // Gerade weitergegeben, die Tafel hat es aber noch nicht übernommen: nicht neu scharf stellen (sonst zählt der nächste Druck doppelt
      // oder geht in der Sperre verloren). Kam nach 2,5 s nichts, ist die Meldung vermutlich verloren: dann gleich wieder bereit.
      const waitingTafel = !!(light && light.s === passedToken && performance.now() - passedAt < WAIT_TAFEL_MS);
      const retryHold = !!(light && light.s === passedToken && !waitingTafel);
      const iHold = !tapGm && !waitingTafel && !!(fresh && slot >= 0 && light && !st.finale && st.ph === 'play');
      const isFin = !!(fresh && st.finale && slot >= 0);
      const paused = !!(iHold && (light.z || st.paused)); // Staffel: das andere Team hat Vorrang. Oder die Lehrkraft hat pausiert.
      const myTeam = fresh && st.team ? st.team[ID] : undefined;

      // Farbe: in der Staffel die des Teams, bei Doppelten Lichtern die des Lichts, sonst die eigene
      let col = slot >= 0 ? LK.COLORS[slot] : '#8b90b0';
      if (slot >= 0 && LK.isTeamGm(st.gm) && myTeam !== undefined) col = LK.TEAM_COLORS[myTeam];
      else if (iHold && st.gm === 'doppel') col = LK.LIGHT_COLORS[light.k % 3];
      scrPlay.style.setProperty('--c', col);
      // Vorgaben der Tafel können sich ändern: springender Punkt an/aus, Größe
      scrPlay.classList.toggle('rnd', useRandom() && !tapGm);
      scrPlay.style.setProperty('--sz', String(eSize()));
      if ((!useRandom() || tapGm) && !holding && $('hold').style.left) clearTarget();
      // Wechselt die Tippfläche von "springend" auf "fest" (zum Beispiel durch die Tafel), darf kein Symbol im Knopf zurückbleiben
      if ((!useRandom() || tapGm) && $('hold').firstChild) $('hold').innerHTML = '';

      if (iHold && !holding) {
        holding = true;
        lightTapped = false;
        if (!freeStars()) { starCount = 0; clearTimeout(starTimer); lastStarPos = null; $('star').dataset.placed = ''; }
        mtHit = 0;
        holdGated = false;
        updateTapVisuals();
        lockUntil = performance.now() + (retryHold ? 0 : lockMs());
        const hold = $('hold');
        if (useRandom()) {
          placeTarget();
          hold.innerHTML = slot >= 0 ? LK.shapeSvg(slot) : '';
          if (trOn()) traceBegin();
        }
        hold.hidden = false;
        try { hold.focus({ preventScroll: true }); } catch (e) { /* ältere Browser */ }
        setTimeout(render, lockMs() + 30);
      } else if (!iHold && holding) {
        holding = false;
        traceEnd();
        lightTapped = false;
        if (!freeStars()) { starCount = 0; clearTimeout(starTimer); }
        updateTapVisuals();
      }
      // Mit der iPad-Schaltersteuerung bleibt das große Ziel immer stehen (unsichtbar), damit die Abtastung dort ruht und nicht ins Leere läuft
      const swCtlNow = mode === 'taster' && sw.kind === 'tap' && !!fresh && slot >= 0 && !st.finale;
      if (!iHold) $('hold').hidden = !(tg.target || swCtlNow);
      $('hold').setAttribute('aria-label', iHold ? 'Licht weitergeben' : 'Wartet auf das Licht');

      // Sternenregen / Sterne gegeneinander: neues Päckchen, neuer Zähler
      if (freeStars() && st.sr && st.sr[ID]) {
        const bb = st.sr[ID];
        if (bb.k !== fsK) { fsK = bb.k; starCount = bb.c || 0; $('star').dataset.placed = ''; lastStarPos = null; }
        else if ((bb.c || 0) > starCount) starCount = bb.c;
      }
      const freeOn = !!(freeStars() && fresh && slot >= 0 && st.ph === 'play' && !st.finale && !st.paused && myBatch() && !starsDone());
      // Schatz-Licht: Liegt bei diesem Gerät ein Schatz, erscheint ein gelber Stern zum Antippen (immer nur einer)
      const showStar = freeStars() ? freeOn : !!(iHold && holding && starTapNeeded() && !starsDone());
      // "Ein Tipp reicht": Der Stern wird mit eingesammelt. Damit man sieht, dass bei diesem Gerät ein Schatz liegt,
      // erscheint trotzdem ein gelber Stern, aber ohne Funktion (er reagiert nicht auf Tippen und löst nichts aus).
      const showStarAuto = !freeStars() && !!(iHold && holding && treasureHere() && starAuto());
      $('star').hidden = !(showStar || showStarAuto);
      if (!showStar || !dragMode()) $('basket').hidden = true;
      else if ($('basket').hidden) { $('star').dataset.placed = ''; }
      $('star').classList.toggle('auto', showStarAuto);
      // Schatz-Licht: Das Symbol zum Weitergeben erscheint erst, wenn alle Sterne dieses Geräts eingesammelt sind
      const gate = !!(!freeStars() && iHold && holding && mode !== 'taster' && starTapNeeded() && !starsDone());
      if (iHold && holding) {
        $('hold').hidden = gate;
        if (gate) holdGated = true;
        else if (holdGated) { holdGated = false; if (useRandom()) placeTarget(); }
      }
      if (showStar && !$('star').dataset.placed) { placeStar(); armStarJump(); }
      else if (showStarAuto && !$('star').dataset.placed) placeStar();
      // Wird der Stern jetzt automatisch eingesammelt (Einstellung geändert) und das Licht war schon getippt: weitergeben
      if (!freeStars() && iHold && holding && lightTapped && treasureHere() && starAuto() && light && !light.z && !st.paused) finishPass(light, true);

      const pa = pickActive();
      $('teamPick').hidden = !pa;
      if (pa) {
        const cp = curPick();
        document.querySelectorAll('[data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === cp)));
        $('pickHint').textContent = mode === 'taster' ? 'Jeder Druck wechselt das Team.' : 'Tippe auf dein Team.';
      }
      scrPlay.classList.toggle('on', iHold || tg.on);
      scrPlay.classList.toggle('mine', tapGm); // Muster/Geheim: eigenes Symbol bleibt gut sichtbar in der Mitte
      muStrip(tapGm);
      scrPlay.classList.toggle('fin', isFin);
      $('hold').classList.toggle('locked', (iHold && (performance.now() < lockUntil || paused || (tr && !tr.done))) || (tg.target && tg.locked));

      const online = net.connected;
      $('conn').className = `dot ${online ? (fresh ? 'ok' : 'warn') : 'bad'}`;
      const clockGame = fresh && st.tm && st.gm === 'klassik';
      let msg = '';
      if (!online) msg = 'Keine Verbindung …';
      else if (!fresh) msg = 'Warte auf die Tafel …';
      else if (slot < 0) msg = 'Verbinde …';
      else if (isFin) msg = (LK.isTeamGm(st.gm) && st.win >= 0 && myTeam !== undefined) ? (st.win === myTeam ? (st.sd ? 'Dein Team gewinnt die Serie!' : 'Dein Team gewinnt!') : 'Geschafft! Gut gespielt') : (st.lost ? 'Fast geschafft! Gleich noch einmal' : 'Geschafft!');
      else if (st.paused) msg = 'Pause';
      else if (performance.now() < flashUntil) msg = flashMsg;
      else if (performance.now() < missUntil) msg = 'Daneben! Strafpause';
      else if (paused) msg = light.pn ? 'Strafpause …' : 'Kurze Pause …';
      else if (tg.msg) msg = tg.msg;
      else if (iHold && tr && !tr.done) msg = tr.ribbon ? (tr.lvl >= 6 ? 'Finde die richtige Reihenfolge' : 'Welches Band ist zuerst dran?') : 'Zieh den Punkt die Spur entlang';
      else if (iHold && tr && tr.done) msg = 'Geschafft!';
      else if (iHold) msg = starTapNeeded() ? starMsg() : (treasureHere() ? autoStarMsg(light) : ((clockGame && eNoTime()) ? 'Die Uhr steht. Du hast Zeit.' : hintText()));
      else if (freeStars() && myBatch() && !iHold) msg = `Sammle deine Sterne ★ (${Math.min(starCount + 1, starTotal())} von ${starTotal()})`;
      else if (freeStars() && !iHold && st.ph === 'play') msg = st.gm === 'sduell' ? 'Gleich kommen neue Sterne' : 'Gleich kommen neue Sterne, achte auf das Licht';
      else if (st.ph === 'ready') msg = 'Gleich geht’s los';
      else if (st.ph === 'count') msg = 'Mach dich bereit';
      else msg = 'Gleich bist du dran';
      $('msg').textContent = msg;
      cdSync(fresh);
      $('msg').classList.toggle('quiet', !iHold && !isFin);

      // Kleine Zeile oben: Team, Licht-Nummer, Stern
      const bits = [];
      if (fresh && LK.isTeamGm(st.gm) && myTeam !== undefined) bits.push(`Team ${LK.TEAM_NAMES[myTeam]}`);
      if (iHold && st.gm === 'doppel') bits.push(`Licht ${light.k + 1}`);
      if (fresh && trOn() && slot >= 0) bits.push(`Stufe ${xLevel()}`);
      if (iHold && mtNeed() > 1) bits.push(`Tipp ${Math.min(mtHit + 1, mtNeed())} von ${mtNeed()}`);
      if (fresh && st.gm === 'schatz' && st.stars && st.stars.includes(ID)) bits.push('★ Hier liegt ein Stern');
      $('tag').textContent = bits.join(' · ');

      let frac = 0;
      if (fresh && st.goal) {
        if (st.gm === 'zieh') frac = myTeam !== undefined ? Math.max(0, Math.min(1, 0.5 + ((st.tc[myTeam] || 0) - (st.tc[1 - myTeam] || 0)) / (2 * st.goal))) : 0;
        else if (LK.isTeamGm(st.gm)) frac = myTeam !== undefined ? (st.tc[myTeam] || 0) / st.goal : 0;
        else if (st.gm === 'schatz') frac = (st.sc || 0) / st.goal;
        else frac = st.chain / st.goal;
      }
      $('prog').firstElementChild.style.width = `${Math.min(100, frac * 100)}%`;
    }

    // ---------- Team wählen (Staffel) ----------
    function choose(t) {
      if (!pickActive() || (t !== 'a' && t !== 'b')) return;
      pickTeam = t;
      sendHb();
      render();
    }
    document.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => choose(b.dataset.pick)));

    // ---------- Das Licht weitergeben ----------
    // Licht-Fläche getippt (oder Taster gedrückt, oder Kreis angeschaut)
    // Was ein Gerät in Muster nachspielen und Geheime Reihenfolge sieht und tun kann
    function tapGame(tapGm) {
      const r = { on: false, target: false, msg: '', locked: false };
      if (!tapGm || !st || st.finale || st.ph !== 'play' || st.paused) return r;
      if (st.gm === 'muster') {
        const mu = st.mu;
        if (!mu) return r;
        const inSq = mu.sq.includes(ID);
        if (mu.ph === 'wait') r.msg = 'Es braucht mindestens zwei Geräte';
        else if (mu.ph === 'ready') r.msg = 'Gleich zeigt die Tafel eine Reihenfolge';
        else if (mu.ph === 'shown') r.msg = 'Habt ihr sie euch gemerkt? Gleich seid ihr dran';
        else if (mu.ph === 'show') { r.on = mu.cur === ID; r.msg = r.on ? 'Das bist du!' : 'Schau auf die Tafel und merk dir die Reihenfolge'; }
        else if (mu.ph === 'go') { r.target = inSq; r.msg = inSq ? 'Tippe, wenn du dran bist' : 'Diesmal bist du nicht dabei'; }
        else if (mu.ph === 'next') r.msg = 'Richtig!';
        else if (mu.ph === 'again') r.msg = 'Nicht ganz. Gleich noch einmal';
      } else {
        const ge = st.ge;
        const l = st.lights[0];
        if (ge && ge.rp) { r.on = ge.cur === ID; r.msg = r.on ? 'Das bist du!' : 'Schau auf die Tafel: die ganze Reihe'; return r; }
        if (!ge || !l || !l.h) return r;
        if (l.h === ID) { r.on = true; r.msg = 'Du hast das Licht. Die anderen suchen den Nächsten.'; }
        else if (ge.ex && ge.ex.includes(ID)) r.msg = 'Du bist es nicht. Warte auf den nächsten Schritt.';
        else { r.target = true; r.locked = !!ge.lk; r.msg = ge.lk ? 'Warte kurz …' : 'Bist du der Nächste? Dann tippe!'; }
      }
      return r;
    }

    let lastTapSent = 0;
    function tapAnywhere() {
      if (!st || Date.now() - lastStateAt > 16000) return;
      const tg = tapGame(slot >= 0);
      if (!tg.target || tg.locked || performance.now() - lastTapSent < 400) return;
      lastTapSent = performance.now();
      net.send('tap', { id: ID, epoch: st.epoch });
      if (sound && slot >= 0) LK.audio.note(slot, 0.3, 0.9); // der feste Ton dieses Symbols
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* nicht überall erlaubt */ } }
      flashMsg = 'Getippt ✓';
      flashUntil = performance.now() + 700;
      render();
      setTimeout(render, 760);
    }

    function confirm() {
      if (st && (st.gm === 'muster' || st.gm === 'geheim')) { tapAnywhere(); return; }
      if (freeStars() && mode === 'taster' && !myLight()) { tapStar(); return; } // ohne Licht sammelt der Taster einen Stern
      if (holding && mode === 'taster' && st && performance.now() < lockUntil) {
        // Dunkelheit: Ein Druck kurz vor Ende der Sperre geht nicht verloren, er wird gleich danach ausgeführt
        if (st.gm === 'dunkel' && lockUntil - performance.now() < 400) {
          setTimeout(() => { if (holding && st && performance.now() >= lockUntil) confirm(); }, Math.max(0, lockUntil - performance.now()) + 15);
          return;
        }
        // Zu früh gedrückt: kurz sagen, dass der Druck noch nicht zählt
        flashMsg = 'Einen Moment …';
        flashUntil = performance.now() + 500;
        render();
        setTimeout(render, 550);
        return;
      }
      if (holding && tr && !tr.done) { flashMsg = 'Erst die Spur nachziehen'; flashUntil = performance.now() + 900; render(); setTimeout(render, 950); return; }
      if (!holding || performance.now() < lockUntil || !st) return;
      const light = st.lights.find((l) => l.h === ID);
      if (!light || light.z || st.paused) return; // Pause (Staffel: das andere Team ist dran, oder die Lehrkraft hat pausiert)
      if (starTapNeeded() && !freeStars()) {
        // Schatz-Licht: erst alle Sterne, dann das Licht. Nur bei einem einzelnen Stern darf das Licht auch zuerst kommen.
        const now = performance.now();
        if (mode === 'taster') {
          // Ein Knopf: Die ersten Drücke sind die Sterne, der letzte gibt das Licht weiter. Prellen und Dauerdruck zählen nicht doppelt.
          if (now - lastTapAt < 300) return;
          lastTapAt = now;
          if (!starsDone()) { starStep(light); return; }
          finishPass(light, false);
          return;
        }
        if (!starsDone()) {
          if (starTotal() === 1) {
            lightTapped = true;
            updateTapVisuals();
            render();
          } else {
            flashMsg = `Erst die Sterne ★ (${starCount + 1} von ${starTotal()})`;
            flashUntil = performance.now() + 1300;
            render();
            setTimeout(render, 1350);
          }
          return;
        }
        finishPass(light, false);
        return;
      }
      // Kein Schatz bei diesem Gerät, oder "ein Tipp reicht": Beim Weitergeben werden alle Sterne dieses Geräts eingesammelt
      if (mtNeed() > 1) {
        mtHit++;
        if (mtHit < mtNeed()) {
          if (sound && slot >= 0) LK.audio.note(slot, 0.25, 0.8, 0, 2);
          if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* egal */ } }
          lockUntil = performance.now() + (mode === 'touch' ? 250 : Math.max(400, lockMs()));
          if (useRandom()) placeTarget();
          flashMsg = `${mtHit} von ${mtNeed()} ✓`;
          flashUntil = performance.now() + 900;
          render();
          setTimeout(render, 950);
          return;
        }
      }
      finishPass(light, treasureHere() && !freeStars());
    }

    // Gelben Stern getippt
    function tapStar() {
      if (freeStars()) {
        if (!st || st.ph !== 'play' || st.finale || st.paused || !myBatch() || starsDone()) return;
        starStep(null);
        return;
      }
      if (!holding || performance.now() < lockUntil || !st || !starTapNeeded() || starsDone()) return;
      const light = myLight();
      if (!light || light.z || st.paused) return;
      starStep(light);
    }

    // Ein Stern ist eingesammelt: der Tafel melden, den nächsten Stern an anderer Stelle zeigen
    function starStep(light) {
      starCount++;
      if (sound && slot >= 0) LK.audio.note(slot, 0.3, 0.8, 0, 2);
      if (navigator.vibrate) { try { navigator.vibrate(15); } catch (e) { /* egal */ } }
      reportStars(light);
      if (!freeStars() && starTotal() === 1 && lightTapped) { finishPass(light, false); return; } // ein Stern, Licht war schon dran
      if (!starsDone()) {
        $('star').dataset.placed = '';
        placeStar();
        armStarJump();
      } else {
        clearTimeout(starTimer);
        $('star').hidden = true;
      }
      updateTapVisuals();
      render();
    }

    // Meldet der Tafel die Gesamtzahl der angetippten Sterne. Geht eine Meldung verloren, wird sie wiederholt.
    function reportStars(light) {
      if (freeStars()) {
        const b = myBatch();
        if (!b) return;
        const k = b.k;
        const epoch = st.epoch;
        net.send('star', { id: ID, epoch, g: 1, b: k, c: starCount });
        let t = 0;
        const again = () => {
          const cur = st && st.sr && st.sr[ID];
          if (!cur || cur.k !== k || cur.n === 0 || (cur.c || 0) >= starCount || t >= 4) return;
          t++;
          net.send('star', { id: ID, epoch, g: 1, b: k, c: starCount });
          setTimeout(again, 1200);
        };
        setTimeout(again, 1200);
        return;
      }
      const s = light.s;
      const epoch = st.epoch;
      net.send('star', { id: ID, s, epoch, c: starCount });
      let tries = 0;
      const again = () => {
        const cur = st && st.lights.find((l) => l.h === ID && l.s === s);
        if (!cur || cur.r <= cur.n - starCount || tries >= 3) return;
        tries++;
        net.send('star', { id: ID, s, epoch, c: starCount });
        setTimeout(again, 1200);
      };
      setTimeout(again, 1200);
    }

    // Springt der Stern weiter (Einstellung der Tafel), wenn man zu lange braucht? Er wird nicht bestraft, er wandert nur.
    function armStarJump() {
      clearTimeout(starTimer);
      const sj = st && st.sj ? st.sj : 0;
      if (!sj) return;
      starTimer = setTimeout(() => {
        if (holding && starTapNeeded() && !starsDone() && !starDrag) { placeStar(); armStarJump(); }
      }, sj * 1000);
    }

    function finishPass(light, collect) {
      mtHit = 0;
      traceEnd();
      holding = false;
      lightTapped = false;
      clearTimeout(starTimer);
      const done = freeStars() ? 0 : starCount;
      if (!freeStars()) starCount = 0;
      lastConfirm = performance.now();
      passedToken = light.s;
      passedAt = performance.now();
      setTimeout(render, WAIT_TAFEL_MS + 60); // danach prüfen, ob die Tafel das Licht übernommen hat
      const s = light.s;
      const epoch = st.epoch;
      const k = collect ? 1 : 0;
      sendAct(s, epoch, k, done);
      // Ging die Nachricht verloren, wird sie wiederholt, bis die Tafel das Licht weitergegeben hat
      let tries = 0;
      const again = () => {
        if (!st || !st.lights.some((l) => l.h === ID && l.s === s) || tries >= 4) return;
        tries++;
        sendAct(s, epoch, k, done);
        resendTimer = setTimeout(again, RESEND_MS);
      };
      clearTimeout(resendTimer);
      resendTimer = setTimeout(again, RESEND_MS);

      if (sound && slot >= 0) LK.audio.note(slot, 0.28, 0.9);
      if (navigator.vibrate) navigator.vibrate(25);
      sent();
      $('hold').hidden = true;
      $('star').hidden = true;
      updateTapVisuals();
      scrPlay.classList.remove('on');
      flashMsg = (collect || done > 0) ? 'Stern eingesammelt ★' : 'Weitergegeben ✓';
      flashUntil = performance.now() + 1200;
      $('msg').textContent = flashMsg;
    }

    // c = so viele Sterne wurden angetippt (die Tafel zählt sie nach, falls eine einzelne Meldung verloren ging)
    function sendAct(s, epoch, k, c) { net.send('act', { id: ID, s, epoch, k: k ? 1 : 0, c: c || 0 }); }

    function updateTapVisuals() {
      $('hold').classList.toggle('done', lightTapped);
      $('star').classList.remove('done');
    }

    // Zufällige Stelle für den Stern: nicht auf dem Punkt oder Kreis, nicht am Rand
    function placeBasket(sx, sy, d, ox, oy, or, fullScreen) {
      const b = $('basket');
      if (!dragMode()) { b.hidden = true; return; }
      const w = window.innerWidth;
      const h = window.innerHeight;
      const bw = d * 1.6;
      const bh = bw * 0.8;
      let x = w / 2;
      let y = h * 0.4;
      for (let i = 0; i < 150; i++) {
        const cx = bw / 2 + 12 + Math.random() * Math.max(1, w - bw - 24);
        const cy = bh / 2 + 12 + Math.random() * Math.max(1, h * 0.78 - bh - 24);
        const farStar = Math.hypot(cx - sx, cy - sy) > Math.max(w, h) * 0.3 || i > 120;
        const free = fullScreen || Math.hypot(cx - ox, cy - oy) > or + bw / 2 + 12 || i > 130;
        if (farStar && free) { x = cx; y = cy; break; }
      }
      b.style.width = `${bw}px`;
      b.style.height = `${bh}px`;
      b.style.left = `${x}px`;
      b.style.top = `${y}px`;
      b.hidden = false;
    }
    function placeStar() {
      const star = $('star');
      const w = window.innerWidth;
      const h = window.innerHeight;
      const d = Math.min(Math.max(90, Math.min(Math.min(w, h) * 0.17, 160)) * eSize(), Math.min(w, h) * 0.4);
      const m = d / 2 + 18;
      const hr = $('hold').getBoundingClientRect();
      const fullScreen = hr.width > w * 0.9 && hr.height > h * 0.9; // Tippen auf den ganzen Bildschirm: kein Hindernis
      const ox = hr.left + hr.width / 2;
      const oy = hr.top + hr.height / 2;
      const or = Math.max(hr.width, hr.height) / 2;
      let x = m;
      let y = h * 0.8 - m;
      for (let i = 0; i < 120; i++) {
        const cx = m + Math.random() * Math.max(1, w - 2 * m);
        const cy = m + Math.random() * Math.max(1, h * 0.8 - 2 * m);
        const free = fullScreen || Math.hypot(cx - ox, cy - oy) > or + d / 2 + 16;
        // Der nächste Stern soll deutlich woanders erscheinen als der vorige
        const farFromLast = !lastStarPos || Math.hypot(cx - lastStarPos.x, cy - lastStarPos.y) > d * 1.6 || i > 100;
        if (free && farFromLast) { x = cx; y = cy; break; }
      }
      lastStarPos = { x, y };
      placeBasket(x, y, d, ox, oy, or, fullScreen);
      star.style.width = `${d}px`;
      star.style.height = `${d}px`;
      star.style.left = `${x}px`;
      star.style.top = `${y}px`;
      star.dataset.placed = '1';
    }

    function sent() {
      const r = $('ripple');
      r.classList.remove('go');
      void r.offsetWidth;
      r.classList.add('go');
    }

    const hold = $('hold');
    // Touch: sofort beim Berühren. Taster und Blick senden einen Klick bzw. eine Taste.
    hold.addEventListener('pointerdown', (e) => { if (mode === 'touch' && e.pointerType === 'touch') { e.preventDefault(); confirm(); } });
    // Taster mit Tastatur: Der Browser löst nach dem Loslassen der Taste zusätzlich einen Klick auf dem Knopf aus (detail 0).
    // Der zählte sonst als zweiter Druck, vor allem bei längerem Drücken. Nur der Tastendruck selbst zählt.
    // Ein Klick kurz nach einer Taste stammt von dieser Taste (die Tastatur löst auf dem fokussierten Knopf einen Klick aus) und zählt nicht doppelt.
    // Ein Klick OHNE Taste davor kommt von der iPad-Schaltersteuerung oder einer Maus und gilt.
    let lastKeyAt = 0;
    document.addEventListener('keydown', () => { lastKeyAt = performance.now(); }, true);
    document.addEventListener('keyup', () => { lastKeyAt = performance.now(); }, true);
    const keyClick = (e) => mode === 'taster' && e.detail === 0 && sw.kind !== 'tap' && performance.now() - lastKeyAt < 500;
    hold.addEventListener('click', (e) => { if (keyClick(e)) return; confirm(); });
    document.addEventListener('keydown', (e) => {
      if (mode !== 'taster' || !active) return;
      if (switchMatches(e)) { e.preventDefault(); if (!e.repeat) { if (pickActive()) choose(curPick() === 'a' ? 'b' : 'a'); else confirm(); } }
    });
    // Der gelbe Stern ist ein eigenes Ziel (liegt über dem Licht-Ziel, löst das Licht nicht aus)
    let starDrag = null;
    const starBtn = $('star');
    starBtn.innerHTML = LK.shapeSvg(6);
    starBtn.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (dragMode()) {
        if ((!freeStars() && (!holding || performance.now() < lockUntil)) || starsDone()) return;
        e.preventDefault();
        starDrag = { x0: starBtn.style.left, y0: starBtn.style.top };
        starBtn.classList.add('drag');
        try { starBtn.setPointerCapture(e.pointerId); } catch (err) { /* egal */ }
        return;
      }
      if (e.pointerType === 'touch') { e.preventDefault(); tapStar(); }
    });
    starBtn.addEventListener('pointermove', (e) => {
      if (!starDrag) return;
      starBtn.style.left = `${e.clientX}px`;
      starBtn.style.top = `${e.clientY}px`;
    });
    const endDrag = (e) => {
      if (!starDrag) return;
      const b = $('basket').getBoundingClientRect();
      const hit = Math.abs(e.clientX - (b.left + b.width / 2)) < b.width * 0.5 && Math.abs(e.clientY - (b.top + b.height / 2)) < b.height * 0.55;
      const d0 = starDrag;
      starDrag = null;
      starBtn.classList.remove('drag');
      if (hit && e.type === 'pointerup') {
        const light = myLight();
        if (freeStars() || (light && !light.z && !st.paused)) { tapStar(); return; }
      }
      starBtn.style.left = d0.x0;
      starBtn.style.top = d0.y0;
    };
    starBtn.addEventListener('pointerup', endDrag);
    starBtn.addEventListener('pointercancel', endDrag);
    starBtn.addEventListener('click', (e) => { e.stopPropagation(); if (dragMode()) return; if (keyClick(e)) return; tapStar(); });

    // Fehltipp (nur Staffel, nur wenn die Tafel Strafpause eingeschaltet hat und dieses Gerät mitmacht):
    // ein Tipp im falschen Moment (kein Licht da) oder neben den Punkt bzw. Kreis
    scrPlay.addEventListener('pointerdown', (e) => {
      // Schwierigkeit "fängt von vorn an": ein Tipp neben das Symbol setzt die Treffer zurück
      if (active && st && mode !== 'blick' && mtNeed() > 1 && st.mf && holding && mtHit > 0 && !e.target.closest('button') && performance.now() >= lockUntil && st.ph === 'play' && !st.finale && !st.paused) {
        mtHit = 0;
        lockUntil = performance.now() + 400;
        if (useRandom()) placeTarget();
        flashMsg = 'Daneben! Von vorn';
        flashUntil = performance.now() + 1100;
        scrPlay.classList.remove('miss'); void scrPlay.offsetWidth; scrPlay.classList.add('miss');
        render();
        setTimeout(render, 1150);
        return;
      }
      if (!active || !eMiss() || mode === 'taster' || mode === 'blick' || !st || tr) return; // Augensteuerung: nie Fehltipps oder Strafe
      if (!LK.isTeamGm(st.gm) || st.ph !== 'play' || st.finale || st.paused || !st.pen) return;
      if (e.target.closest('button')) return; // Treffer oder Bedienknopf
      const now = performance.now();
      if (holding && now < lockUntil) return;  // gerade erst Licht bekommen
      if (now - lastConfirm < 900) return;     // Doppeltipp nach dem Weitergeben
      if (now - lastMiss < 1500) return;       // nicht mehrfach hintereinander bestrafen
      lastMiss = now;
      net.send('miss', { id: ID, epoch: st.epoch });
      missUntil = now + 1400;
      scrPlay.classList.remove('miss');
      void scrPlay.offsetWidth;
      scrPlay.classList.add('miss');
      render();
      setTimeout(render, 1450);
    });

    $('change').addEventListener('click', showMode);

    // ---------- Start ----------
    $('roomInfo').textContent = `Raum: ${room}`;
    $('asBoard').href = `${location.href.split('?')[0]}?tafel=1&r=${room}`;
    // Die Einstellungen am Gerät sind für Schüler versteckt: Sonst suchen sie sich die einfachsten heraus.
    // Alles wird von der Lehrkraft vorgegeben (Lehrer-Ansicht oder Gerät auf der Tafel antippen).
    // Aufschließen mit dem Link ...&opt=1 (bleibt auf diesem Gerät gemerkt), wieder zu mit &opt=0.
    const optParam = new URLSearchParams(location.search).get('opt');
    if (optParam === '1') LK.store.set('lk_opts', '1');
    else if (optParam === '0') LK.store.set('lk_opts', '0');
    const optsOpen = LK.store.get('lk_opts', '0') === '1';
    $('optsBox').hidden = !optsOpen;
    $('asBoardWrap').hidden = !optsOpen;
    showMode();
    net.start();
  };
})(window.LK);
