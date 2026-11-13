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
    const lockMs = () => (st && st.gm === 'basal' && mode !== 'blick' ? 250 : MODES[mode].lock);
    // Staffel: Die Schüler wählen ihr Team selbst (wenn die Tafel das eingestellt hat)
    let pickTeam = '';   // 'a' | 'b' | ''
    let seenSk = -1;     // Zähler von "Teams neu würfeln": ändert er sich, ist die eigene Wahl hinfällig
    const pickActive = () => !!(st && Date.now() - lastStateAt < 12000 && LK.isTeamGm(st.gm) && st.tsel === 1 && st.ph === 'ready'
      && st.players[ID] !== undefined && cfg().tt === undefined && !st.finale);
    const curPick = () => pickTeam || (st && st.team && st.team[ID] === 1 ? 'b' : 'a');
    const starHere = () => !!(st && st.gm === 'schatz' && st.stars && st.stars.includes(ID));
    // Der Stern wird automatisch eingesammelt, wenn das Gerät es so eingestellt hat (die Tafel kann das vorgeben)
    const starAuto = () => {
      const c = cfg();
      if (c.sa !== undefined) return c.sa === 1;
      if (starPref) return starPref === 'auto';
      return mode !== 'touch';
    };
    const myLight = () => (st ? st.lights.find((l) => l.h === ID) : null);
    // Liegt bei diesem Gerät gerade ein Schatz, und aus wie vielen Sternen besteht er? (Die Tafel legt das beim Eintreffen des Lichts fest.)
    const treasureHere = () => { const l = myLight(); return !!(l && st.gm === 'schatz' && l.n > 0); };
    const starTotal = () => { const l = myLight(); return l && l.n > 0 ? l.n : 1; };
    const starsDone = () => starCount >= starTotal();
    const starTapNeeded = () => treasureHere() && !starAuto();

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
    const useRandom = () => eTarget() === 'rnd' && mode !== 'taster';
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

    // Zufällige Stelle für den Punkt: nicht in der Mitte, nicht am Rand, nicht wieder an der letzten Stelle
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
      $('change').hidden = mode === 'blick'; // bei Augensteuerung kein kleiner Knopf, der aus Versehen ausgelöst wird
      sendHb();
      render();
    }

    // ---------- Verbindung ----------
    function sendHb() {
      if (!active) return;
      net.send('hb', { id: ID, w: eWait(), m: mode.charAt(0), nt: eNoTime() ? 1 : 0, tt: eTeam(), tp: pickTeam, tk: seenSk, md: mode, pn: eMiss() && mode !== 'taster' ? 1 : 0, bv: LK.BUILD, t: Date.now() });
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
      const fresh = st && Date.now() - lastStateAt < 12000;
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
      const iHold = !tapGm && !!(fresh && slot >= 0 && light && !st.finale && st.ph === 'play');
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
        starCount = 0;
        clearTimeout(starTimer);
        lastStarPos = null;
        $('star').dataset.placed = '';
        updateTapVisuals();
        lockUntil = performance.now() + lockMs();
        const hold = $('hold');
        if (useRandom()) {
          placeTarget();
          hold.innerHTML = slot >= 0 ? LK.shapeSvg(slot) : '';
        }
        hold.hidden = false;
        try { hold.focus({ preventScroll: true }); } catch (e) { /* ältere Browser */ }
        setTimeout(render, lockMs() + 30);
      } else if (!iHold && holding) {
        holding = false;
        lightTapped = false;
        starCount = 0;
        clearTimeout(starTimer);
        updateTapVisuals();
      }
      if (!iHold) $('hold').hidden = !tg.target;

      // Schatz-Licht: Liegt bei diesem Gerät ein Schatz, erscheint ein gelber Stern zum Antippen (immer nur einer)
      const showStar = !!(iHold && holding && starTapNeeded() && !starsDone());
      // "Ein Tipp reicht": Der Stern wird mit eingesammelt. Damit man sieht, dass bei diesem Gerät ein Schatz liegt,
      // erscheint trotzdem ein gelber Stern, aber ohne Funktion (er reagiert nicht auf Tippen und löst nichts aus).
      const showStarAuto = !!(iHold && holding && treasureHere() && starAuto());
      $('star').hidden = !(showStar || showStarAuto);
      $('star').classList.toggle('auto', showStarAuto);
      if (showStar && !$('star').dataset.placed) { placeStar(); armStarJump(); }
      else if (showStarAuto && !$('star').dataset.placed) placeStar();
      // Wird der Stern jetzt automatisch eingesammelt (Einstellung geändert) und das Licht war schon getippt: weitergeben
      if (iHold && holding && lightTapped && treasureHere() && starAuto() && light && !light.z && !st.paused) finishPass(light, true);

      const pa = pickActive();
      $('teamPick').hidden = !pa;
      if (pa) {
        const cp = curPick();
        document.querySelectorAll('[data-pick]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pick === cp)));
        $('pickHint').textContent = mode === 'taster' ? 'Jeder Druck wechselt das Team.' : 'Tippe auf dein Team.';
      }
      scrPlay.classList.toggle('on', iHold || tg.on);
      scrPlay.classList.toggle('fin', isFin);
      $('hold').classList.toggle('locked', (iHold && (performance.now() < lockUntil || paused)) || (tg.target && tg.locked));

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
      else if (iHold) msg = starTapNeeded() ? starMsg() : (treasureHere() ? autoStarMsg(light) : ((clockGame && eNoTime()) ? 'Die Uhr steht. Du hast Zeit.' : hintText()));
      else if (st.ph === 'ready') msg = 'Gleich geht’s los';
      else if (st.ph === 'count') msg = 'Mach dich bereit';
      else msg = 'Gleich bist du dran';
      $('msg').textContent = msg;
      $('msg').classList.toggle('quiet', !iHold && !isFin);

      // Kleine Zeile oben: Team, Licht-Nummer, Stern
      const bits = [];
      if (fresh && LK.isTeamGm(st.gm) && myTeam !== undefined) bits.push(`Team ${LK.TEAM_NAMES[myTeam]}`);
      if (iHold && st.gm === 'doppel') bits.push(`Licht ${light.k + 1}`);
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
        else if (mu.ph === 'show') { r.on = mu.cur === ID; r.msg = r.on ? 'Das bist du!' : (mu.ag ? 'Noch mal ansehen' : 'Schau auf die Tafel und merk dir die Reihenfolge'); }
        else if (mu.ph === 'go') { r.target = inSq; r.msg = inSq ? 'Tippe, wenn du dran bist' : 'Diesmal bist du nicht dabei'; }
        else if (mu.ph === 'next') r.msg = 'Richtig!';
        else if (mu.ph === 'again') r.msg = 'Nicht ganz. Gleich noch einmal';
      } else {
        const ge = st.ge;
        const l = st.lights[0];
        if (!ge || !l || !l.h) return r;
        if (l.h === ID) { r.on = true; r.msg = 'Du hast das Licht. Die anderen suchen den Nächsten.'; }
        else if (ge.ex && ge.ex.includes(ID)) r.msg = 'Du bist es nicht. Warte auf den nächsten Schritt.';
        else { r.target = true; r.locked = !!ge.lk; r.msg = ge.lk ? 'Warte kurz …' : 'Bist du der Nächste? Dann tippe!'; }
      }
      return r;
    }

    let lastTapSent = 0;
    function tapAnywhere() {
      if (!st || Date.now() - lastStateAt > 12000) return;
      const tg = tapGame(slot >= 0);
      if (!tg.target || tg.locked || performance.now() - lastTapSent < 400) return;
      lastTapSent = performance.now();
      net.send('tap', { id: ID, epoch: st.epoch });
      if (navigator.vibrate) { try { navigator.vibrate(30); } catch (e) { /* nicht überall erlaubt */ } }
      flashMsg = 'Getippt ✓';
      flashUntil = performance.now() + 700;
      render();
      setTimeout(render, 760);
    }

    function confirm() {
      if (st && (st.gm === 'muster' || st.gm === 'geheim')) { tapAnywhere(); return; }
      if (!holding || performance.now() < lockUntil || !st) return;
      const light = st.lights.find((l) => l.h === ID);
      if (!light || light.z || st.paused) return; // Pause (Staffel: das andere Team ist dran, oder die Lehrkraft hat pausiert)
      if (starTapNeeded()) {
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
      finishPass(light, treasureHere());
    }

    // Gelben Stern getippt
    function tapStar() {
      if (!holding || performance.now() < lockUntil || !st || !starTapNeeded() || starsDone()) return;
      const light = myLight();
      if (!light || light.z || st.paused) return;
      starStep(light);
    }

    // Ein Stern ist eingesammelt: der Tafel melden, den nächsten Stern an anderer Stelle zeigen
    function starStep(light) {
      starCount++;
      if (sound && slot >= 0) LK.audio.note(slot, 0.3, 0.8, 0, 2);
      if (navigator.vibrate) navigator.vibrate(15);
      reportStars(light);
      if (starTotal() === 1 && lightTapped) { finishPass(light, false); return; } // ein Stern, Licht war schon dran
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
        if (holding && starTapNeeded() && !starsDone()) { placeStar(); armStarJump(); }
      }, sj * 1000);
    }

    function finishPass(light, collect) {
      holding = false;
      lightTapped = false;
      clearTimeout(starTimer);
      const done = starCount;
      starCount = 0;
      lastConfirm = performance.now();
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
      $('msg').textContent = (collect || done > 0) ? 'Stern eingesammelt ★' : 'Weitergegeben ✓';
    }

    // c = so viele Sterne wurden angetippt (die Tafel zählt sie nach, falls eine einzelne Meldung verloren ging)
    function sendAct(s, epoch, k, c) { net.send('act', { id: ID, s, epoch, k: k ? 1 : 0, c: c || 0 }); }

    function updateTapVisuals() {
      $('hold').classList.toggle('done', lightTapped);
      $('star').classList.remove('done');
    }

    // Zufällige Stelle für den Stern: nicht auf dem Punkt oder Kreis, nicht am Rand
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
    hold.addEventListener('click', confirm);
    document.addEventListener('keydown', (e) => {
      if (mode !== 'taster' || !active) return;
      if (switchMatches(e)) { e.preventDefault(); if (!e.repeat) { if (pickActive()) choose(curPick() === 'a' ? 'b' : 'a'); else confirm(); } }
    });
    // Der gelbe Stern ist ein eigenes Ziel (liegt über dem Licht-Ziel, löst das Licht nicht aus)
    const starBtn = $('star');
    starBtn.innerHTML = LK.shapeSvg(6);
    starBtn.addEventListener('pointerdown', (e) => { e.stopPropagation(); if (e.pointerType === 'touch') { e.preventDefault(); tapStar(); } });
    starBtn.addEventListener('click', (e) => { e.stopPropagation(); tapStar(); });

    // Fehltipp (nur Staffel, nur wenn die Tafel Strafpause eingeschaltet hat und dieses Gerät mitmacht):
    // ein Tipp im falschen Moment (kein Licht da) oder neben den Punkt bzw. Kreis
    scrPlay.addEventListener('pointerdown', (e) => {
      if (!active || !eMiss() || mode === 'taster' || !st) return;
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
