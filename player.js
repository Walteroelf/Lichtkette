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
    let target = LK.store.get('lk_tg', 'full') === 'rnd' ? 'rnd' : 'full'; // springender Punkt
    let noTime = LK.store.get('lk_nt', '0') === '1';                      // Zeitspiel: Zeit dieses Geräts zählt nicht
    let team = ['a', 'b'].includes(LK.store.get('lk_team', '')) ? LK.store.get('lk_team', '') : ''; // Wunschteam für die Staffel
    let lastPos = null;

    let active = false;    // Eingabeart gewählt, Spiel läuft
    let st = null;          // letzter Spielstand
    let lastStateAt = 0;
    let holding = false;
    let lockUntil = 0;
    let resendTimer = null;
    let slot = -1;

    const scrMode = $('scr-mode');
    const scrPlay = $('scr-play');
    const net = new LK.Net(room, startBroker, ['state']);

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
    }

    // Ein springender Punkt gilt für Tippen und Maus, nicht für den Taster
    const useRandom = () => target === 'rnd' && mode !== 'taster';
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
      const d = Math.max(130, Math.min(Math.min(w, h) * 0.26, 260));
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
      net.send('hb', { id: ID, w: wait, m: mode.charAt(0), nt: noTime ? 1 : 0, tt: team, t: Date.now() });
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
      else if (paused) msg = 'Kurze Pause …';
      else if (iHold) msg = (clockGame && noTime) ? 'Die Uhr steht. Du hast Zeit.' : hintText();
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

    $('change').addEventListener('click', showMode);

    // ---------- Start ----------
    $('roomInfo').textContent = `Raum: ${room}`;
    $('asBoard').href = `${location.href.split('?')[0]}?tafel=1&r=${room}`;
    showMode();
    net.start();
  };
})(window.LK);
