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
      return target || (mode === 'blick' ? 'full' : 'rnd');
    };
    const eWait = () => (cfg().w !== undefined ? cfg().w : wait);
    const eNoTime = () => (cfg().nt !== undefined ? cfg().nt === 1 : noTime);
    const eMiss = () => (cfg().pn !== undefined ? cfg().pn === 1 : missOn);
    const eTeam = () => { const t = cfg().tt; if (t === 'a' || t === 'b') return t; return t === 'x' ? '' : team; };
    const eSize = () => cfg().sz || 1;

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
      if (s !== undefined && st.gm === 'staffel' && st.team && st.team[ID] !== undefined) col = LK.TEAM_COLORS[st.team[ID]];
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
      scrMode.hidden = false;
      document.querySelectorAll('.card').forEach((c) => c.classList.toggle('last', c.dataset.mode === mode));
      document.querySelectorAll('[data-w]').forEach((b) => b.setAttribute('aria-pressed', String(parseInt(b.dataset.w, 10) === wait)));
      document.querySelectorAll('[data-snd]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.snd === '1') === sound)));
      document.querySelectorAll('[data-tg]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tg === target)));
      document.querySelectorAll('[data-nt]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.nt === '1') === noTime)));
      document.querySelectorAll('[data-team]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.team === team)));
      document.querySelectorAll('[data-miss]').forEach((b) => b.setAttribute('aria-pressed', String((b.dataset.miss === '1') === missOn)));
      $('cfgNote').hidden = !Object.keys(cfg()).length;
    }

    // Ein springender Punkt gilt für Tippen und Maus, nicht für den Taster
    const useRandom = () => eTarget() === 'rnd' && mode !== 'taster';
    const hintText = () => {
      if (useRandom()) return mode === 'blick' ? 'Klicke auf den leuchtenden Punkt' : 'Tippe auf den leuchtenden Punkt';
      return MODES[mode].hint;
    };

    document.querySelectorAll('.card').forEach((c) => c.addEventListener('click', () => {
      mode = c.dataset.mode;
      LK.store.set('lk_mode', mode);
      LK.audio.init();
      LK.keepAwake();
      begin();
    }));
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
      if (useRandom()) $('hold').innerHTML = ''; else clearTarget();
      $('hint').textContent = hintText();
      $('change').hidden = mode === 'blick'; // bei Augensteuerung kein kleiner Knopf, der aus Versehen ausgelöst wird
      sendHb();
      render();
    }

    // ---------- Verbindung ----------
    function sendHb() {
      if (!active) return;
      net.send('hb', { id: ID, w: eWait(), m: mode.charAt(0), nt: eNoTime() ? 1 : 0, tt: eTeam(), pn: eMiss() && mode !== 'taster' ? 1 : 0, t: Date.now() });
    }
    setInterval(sendHb, HB_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sendHb(); });

    net.onconnect = () => { sendHb(); render(); };
    net.onstatus = () => render();

    net.on('state', (s) => {
      if (!s.players || typeof s.seq !== 'number' || !Array.isArray(s.lights)) return;
      st = s;
      lastStateAt = Date.now();
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
      const iHold = !!(fresh && slot >= 0 && light && !st.finale && st.ph === 'play');
      const isFin = !!(fresh && st.finale && slot >= 0);
      const paused = !!(iHold && light.z); // Staffel: das andere Team hat gerade Vorrang
      const myTeam = fresh && st.team ? st.team[ID] : undefined;

      // Farbe: in der Staffel die des Teams, bei Doppelten Lichtern die des Lichts, sonst die eigene
      let col = slot >= 0 ? LK.COLORS[slot] : '#8b90b0';
      if (slot >= 0 && st.gm === 'staffel' && myTeam !== undefined) col = LK.TEAM_COLORS[myTeam];
      else if (iHold && st.gm === 'doppel') col = LK.LIGHT_COLORS[light.k % 3];
      scrPlay.style.setProperty('--c', col);
      // Vorgaben der Tafel können sich ändern: springender Punkt an/aus, Größe
      scrPlay.classList.toggle('rnd', useRandom());
      scrPlay.style.setProperty('--sz', String(eSize()));
      if (!useRandom() && !holding && $('hold').style.left) clearTarget();

      if (iHold && !holding) {
        holding = true;
        lockUntil = performance.now() + MODES[mode].lock;
        const hold = $('hold');
        if (useRandom()) {
          placeTarget();
          hold.innerHTML = slot >= 0 ? LK.shapeSvg(slot) : '';
        }
        hold.hidden = false;
        try { hold.focus({ preventScroll: true }); } catch (e) { /* ältere Browser */ }
        setTimeout(render, MODES[mode].lock + 30);
      } else if (!iHold && holding) {
        holding = false;
      }
      if (!iHold) $('hold').hidden = true;

      scrPlay.classList.toggle('on', iHold);
      scrPlay.classList.toggle('fin', isFin);
      $('hold').classList.toggle('locked', iHold && (performance.now() < lockUntil || paused));

      const online = net.connected;
      $('conn').className = `dot ${online ? (fresh ? 'ok' : 'warn') : 'bad'}`;
      const clockGame = fresh && st.tm && st.gm === 'klassik';
      let msg = '';
      if (!online) msg = 'Keine Verbindung …';
      else if (!fresh) msg = 'Warte auf die Tafel …';
      else if (slot < 0) msg = 'Verbinde …';
      else if (isFin) msg = (st.gm === 'staffel' && st.win >= 0 && myTeam !== undefined) ? (st.win === myTeam ? 'Dein Team gewinnt!' : 'Geschafft! Gut gespielt') : 'Geschafft!';
      else if (performance.now() < missUntil) msg = 'Daneben! Strafpause';
      else if (paused) msg = light.pn ? 'Strafpause …' : 'Kurze Pause …';
      else if (iHold) msg = (clockGame && eNoTime()) ? 'Die Uhr steht. Du hast Zeit.' : hintText();
      else if (st.ph === 'ready') msg = 'Gleich geht’s los';
      else if (st.ph === 'count') msg = 'Mach dich bereit';
      else msg = 'Gleich bist du dran';
      $('msg').textContent = msg;
      $('msg').classList.toggle('quiet', !iHold && !isFin);

      // Kleine Zeile oben: Team, Licht-Nummer, Stern
      const bits = [];
      if (fresh && st.gm === 'staffel' && myTeam !== undefined) bits.push(`Team ${LK.TEAM_NAMES[myTeam]}`);
      if (iHold && st.gm === 'doppel') bits.push(`Licht ${light.k + 1}`);
      if (fresh && st.gm === 'schatz' && st.stars && st.stars.includes(ID)) bits.push('★ Hier liegt ein Stern');
      $('tag').textContent = bits.join(' · ');

      let frac = 0;
      if (fresh && st.goal) {
        if (st.gm === 'staffel') frac = myTeam !== undefined ? (st.tc[myTeam] || 0) / st.goal : 0;
        else if (st.gm === 'schatz') frac = (st.sc || 0) / st.goal;
        else frac = st.chain / st.goal;
      }
      $('prog').firstElementChild.style.width = `${Math.min(100, frac * 100)}%`;
    }

    // ---------- Das Licht weitergeben ----------
    function confirm() {
      if (!holding || performance.now() < lockUntil || !st) return;
      const light = st.lights.find((l) => l.h === ID);
      if (!light || light.z) return; // in der Staffel: Pause, das andere Team ist gerade dran
      holding = false;
      lastConfirm = performance.now();
      const s = light.s;
      const epoch = st.epoch;
      sendAct(s, epoch);
      // Ging die Nachricht verloren, wird sie wiederholt, bis die Tafel das Licht weitergegeben hat
      let tries = 0;
      const again = () => {
        if (!st || !st.lights.some((l) => l.h === ID && l.s === s) || tries >= 4) return;
        tries++;
        sendAct(s, epoch);
        resendTimer = setTimeout(again, RESEND_MS);
      };
      clearTimeout(resendTimer);
      resendTimer = setTimeout(again, RESEND_MS);

      if (sound && slot >= 0) LK.audio.note(slot, 0.28, 0.9);
      if (navigator.vibrate) navigator.vibrate(25);
      sent();
      $('hold').hidden = true;
      scrPlay.classList.remove('on');
      $('msg').textContent = 'Weitergegeben ✓';
    }

    function sendAct(s, epoch) { net.send('act', { id: ID, s, epoch }); }

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
      if (e.key === ' ' || e.key === 'Enter' || e.code === 'Space') { e.preventDefault(); confirm(); }
    });

    // Fehltipp (nur Staffel, nur wenn die Tafel Strafpause eingeschaltet hat und dieses Gerät mitmacht):
    // ein Tipp im falschen Moment (kein Licht da) oder neben den Punkt bzw. Kreis
    scrPlay.addEventListener('pointerdown', (e) => {
      if (!active || !eMiss() || mode === 'taster' || !st) return;
      if (st.gm !== 'staffel' || st.ph !== 'play' || st.finale || !st.pen) return;
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
    showMode();
    net.start();
  };
})(window.LK);
