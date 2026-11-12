'use strict';

// Lehrer-Ansicht (Spielleitung): Fernbedienung für die Tafel.
// - Der Schlüssel kommt aus dem Lehrer-QR (hinter dem # im Link) und bleibt auf diesem Gerät.
// - Befehle an die Tafel und die Geräteinfos von der Tafel sind mit diesem Schlüssel verschlüsselt (AES-GCM).
// - Namen der Geräte bleiben nur hier, sie gehen nie ins Netz und stehen nicht auf der Tafel.
(function (LK) {
  const $ = (id) => document.getElementById(id);
  const TITLES = { klassik: 'Lichtkette', staffel: 'Staffel', zieh: 'Tauziehen', dunkel: 'Die Dunkelheit', muster: 'Muster nachspielen', bild: 'Lichtbild', geheim: 'Geheime Reihenfolge', doppel: 'Doppelte Lichter', schatz: 'Schatz-Licht' };
  const GN_LABEL = {
    klassik: 'Weitergaben pro Runde',
    staffel: 'Weitergaben pro Team',
    doppel: 'Weitergaben insgesamt',
    schatz: 'Sterne pro Runde',
    zieh: 'Schritte Vorsprung zum Sieg',
    dunkel: 'Weitergaben bis zum Sieg',
    muster: 'Runden bis zum Sieg',
    bild: 'Weitergaben pro Bild',
    geheim: 'Stationen (höchstens so viele wie Geräte)',
  };
  const PHASE = { ready: 'wartet auf „Los“', count: 'Countdown läuft', play: 'läuft' };
  // Einstellungen pro Gerät: Schlüssel, Beschriftung, Werte (leer = das Gerät entscheidet selbst)
  const OPTS = [
    { key: 'rnd', label: 'Tippfläche', type: 'int', vals: [['0', 'fest'], ['1', 'springender Punkt']] },
    { key: 'sz', label: 'Größe des Punkts oder Kreises', type: 'float', vals: [['0.6', 'klein'], ['0.75', 'normal'], ['1', 'groß'], ['1.4', 'sehr groß']] },
    { key: 'sa', label: 'Stern einsammeln (Schatz-Licht): Taster = zweimal drücken (erst Stern, dann Licht), Blick = zweites Ziel', type: 'int', vals: [['1', 'ein Tipp reicht'], ['0', 'Stern extra antippen']] },
    { key: 'pn', label: 'Fehltipps (Staffel)', type: 'int', vals: [['0', 'ohne Strafe'], ['1', 'mit Strafe']] },
    { key: 'nt', label: 'Zeit dieses Geräts (Zeitspiel, Staffel)', type: 'int', vals: [['0', 'zählt'], ['1', 'zählt nicht']] },
    { key: 'w', label: 'Licht wandert weiter nach', type: 'int', vals: [['0', 'nie'], ['10', '10 s'], ['30', '30 s']] },
    { key: 'tt', label: 'Team (Staffel, wirkt vor dem Start einer Runde)', type: 'str', vals: [['x', 'automatisch'], ['a', 'Blau'], ['b', 'Pink']] },
  ];

  LK.startTeacher = async function (room, startBroker) {
    $('scr-teacher').hidden = false;
    const setStatus = (text, cls) => { $('tStatus').textContent = text; $('tConn').className = `dot ${cls}`; };

    if (!LK.tcrypto.available) {
      setStatus('Verschlüsselung nicht verfügbar. Die Seite muss über https geöffnet sein.', 'bad');
      return;
    }

    // Schlüssel aus dem Link (#k=…) oder vom letzten Mal. Danach verschwindet er aus der Adresszeile.
    const keyStore = `lk_tk_${room}`;
    let secret = '';
    const fromLink = /(?:^|[#&])k=([a-z0-9]{24})(?:&|$)/.exec(location.hash);
    if (fromLink) {
      secret = fromLink[1];
      LK.store.set(keyStore, secret);
      history.replaceState(null, '', location.pathname + location.search);
    } else {
      secret = LK.store.get(keyStore, '');
    }
    if (!secret) {
      setStatus('Kein Schlüssel. Auf der Tafel: ⚙ → Lehrer-QR anzeigen und mit diesem Gerät scannen.', 'bad');
      return;
    }
    const key = await LK.tcrypto.derive(secret);

    // Namen: nur auf diesem Gerät
    const nameStore = `lk_tnames_${room}`;
    let names = {};
    try { names = JSON.parse(LK.store.get(nameStore, '{}')) || {}; } catch (e) { names = {}; }

    const net = new LK.Net(room, startBroker, ['tpriv']);
    let priv = null;
    let lastOkAt = 0;
    let sawBadKey = false;

    net.on('tpriv', async (box) => {
      const p = await LK.tcrypto.open(key, box);
      if (!p) { sawBadKey = true; return; }
      sawBadKey = false;
      priv = p;
      lastOkAt = Date.now();
      render(p);
    });

    async function send(cmd) {
      cmd.ts = Date.now();
      cmd.cid = LK.rid(12);
      net.send('tcmd', await LK.tcrypto.seal(key, cmd));
      return cmd.cid;
    }

    LK.keepAwake(); // das Lehrer-Gerät soll nicht einschlafen

    // Verbindung testen: Befehl hin, Antwort im nächsten Stand zurück, Zeit dazwischen messen
    let echo = null;
    $('tEcho').addEventListener('click', async () => {
      $('tEchoRes').textContent = 'Teste …';
      const t0 = performance.now();
      const cid = await send({ c: 'echo' });
      echo = { cid, t0 };
      setTimeout(() => { if (echo && echo.cid === cid) { $('tEchoRes').textContent = 'Keine Antwort von der Tafel. Prüfe die Verbindung.'; echo = null; } }, 8000);
    });
    $('tSound').addEventListener('click', () => { if (priv && priv.diag) send({ c: 'sound', on: !priv.diag.soundOn }); });

    function renderDiag(p) {
      const d = p.diag || {};
      const lines = [];
      const add = (cls, text, hint) => lines.push({ cls, text, hint });

      // Verbindung dieses Geräts
      const up = net.upCount;
      const tot = net.total;
      if (up === tot) add('ok', `Dieses Gerät: Verbindung zu beiden Servern (${net.brokerName})`);
      else if (up > 0) add('warn', `Dieses Gerät: nur ${net.brokerName} erreichbar`, 'Das Spiel läuft, es fehlt nur die Reserve.');
      else add('bad', 'Dieses Gerät: keine Verbindung zu den Servern', 'WLAN prüfen.');

      // Verbindung der Tafel
      const servers = d.servers || [];
      const sup = servers.filter((s) => s.ok).length;
      if (servers.length && sup === servers.length) add('ok', `Tafel: Verbindung zu beiden Servern (${servers.map((s) => s.name).join(' + ')})`);
      else if (sup > 0) add('warn', `Tafel: nur ${servers.filter((s) => s.ok).map((s) => s.name).join(' + ')} erreichbar`, 'Das Spiel läuft, es fehlt nur die Reserve.');
      else add('bad', 'Tafel: keine Verbindung zu den Servern');

      // Ton
      if (d.soundOn && d.soundReady) add('ok', 'Ton der Tafel: an und freigeschaltet');
      else if (d.soundOn) add('warn', 'Ton der Tafel: noch nicht freigeschaltet', 'Auf der Tafel einmal „Tafel starten“ antippen.');
      else add('warn', 'Ton der Tafel: aus', 'Mit „Ton der Tafel an/aus“ einschalten.');

      // Bildschirm der Tafel
      if (d.awake) add('ok', 'Tafel-Bildschirm bleibt an');
      else add('warn', 'Tafel-Bildschirm: nicht sicher, dass er anbleibt', 'Am Tafel-Rechner Energiesparen und Bildschirmschoner ausschalten. „Tafel starten“ antippen aktiviert die Sperre.');

      // Dieses Gerät
      if (LK.isAwake()) add('ok', 'Dieses Gerät bleibt wach');
      else add('warn', 'Dieses Gerät könnte einschlafen', 'Das stört das Spiel nicht, nur die Anzeige hier.');

      // Geräte
      const online = p.devices.filter((x) => !(x.age !== null && x.age > 8000));
      const lost = p.devices.length - online.length;
      if (!p.devices.length) add('warn', 'Noch keine Spielgeräte verbunden');
      else if (lost) add('warn', `Spielgeräte: ${online.length} verbunden, ${lost} ohne Verbindung`, 'Im Abschnitt „Geräte“ sieht man, welche. Auf dem Gerät den Link neu öffnen.');
      else add('ok', `Spielgeräte: ${online.length} verbunden`);

      // Versionen
      const stale = p.devices.filter((x) => x.bv && d.build && x.bv !== d.build).length;
      if (d.build && d.build !== LK.BUILD) add('warn', 'Lehrer-Ansicht und Tafel haben verschiedene Versionen', 'Diese Seite neu laden.');
      else if (stale) add('warn', `${stale} Spielgerät${stale === 1 ? '' : 'e'} mit alter Version`, 'Auf dem Gerät die Seite neu laden, am besten den Link neu öffnen.');
      else add('ok', `Alle Seiten haben dieselbe Version (${d.build || '?'})`);

      $('tDiag').innerHTML = '';
      lines.forEach((l) => {
        const li = document.createElement('li');
        li.className = l.cls;
        const span = document.createElement('span');
        span.textContent = l.text;
        if (l.hint) {
          const small = document.createElement('small');
          small.textContent = l.hint;
          span.appendChild(small);
        }
        li.appendChild(span);
        $('tDiag').appendChild(li);
      });

      if (echo && d.echo === echo.cid) {
        $('tEchoRes').textContent = `Antwort der Tafel nach ${Math.round(performance.now() - echo.t0)} ms${performance.now() - echo.t0 > 1500 ? ' (langsam)' : ''}`;
        echo = null;
      }
    }

    setInterval(() => {
      const age = Date.now() - lastOkAt;
      if (!net.connected) setStatus('Keine Verbindung …', 'bad');
      else if (lastOkAt && age < 9000) setStatus('Verbunden mit der Tafel', 'ok');
      else if (sawBadKey) setStatus('Der Schlüssel passt nicht. Lehrer-QR auf der Tafel neu scannen.', 'bad');
      else setStatus('Warte auf die Tafel …', 'warn');
    }, 1000);
    setStatus('Verbinde …', 'warn');

    // ---------- Steuerung ----------
    $('tPause').addEventListener('click', () => { if (priv) send({ c: 'pause', on: !priv.paused }); });
    $('tGo').addEventListener('click', () => send({ c: 'go' }));
    $('tRestart').addEventListener('click', () => { if (window.confirm('Die laufende Runde abbrechen und neu starten?')) send({ c: 'restart' }); });

    const setting = (attr, key, parse) => document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
      send({ c: 'settings', patch: { [key]: parse(b.dataset[attr === 'tgm' ? 'tgm' : attr]) } });
    }));
    setting('tgm', 'gm', (v) => v);
    setting('ttm', 'tm', (v) => parseInt(v, 10));
    setting('tgn', 'gn', (v) => parseInt(v, 10));
    setting('tnl', 'nl', (v) => parseInt(v, 10));
    setting('tpen', 'pen', (v) => parseInt(v, 10));
    setting('tnr', 'nr', (v) => parseInt(v, 10));
    setting('tsp', 'sp', (v) => parseInt(v, 10));
    setting('tsj', 'sj', (v) => parseInt(v, 10));
    setting('tser', 'ser', (v) => parseInt(v, 10));
    setting('tdkv', 'dkv', (v) => parseInt(v, 10));
    // Ziel pro Runde: Auto oder in 5er-Schritten von 5 bis 100
    document.querySelectorAll('[data-tgnstep]').forEach((b) => b.addEventListener('click', () => {
      if (!priv) return;
      const base = priv.gn || priv.goal || 10;
      send({ c: 'settings', patch: { gn: Math.min(100, Math.max(5, Math.round((base + parseInt(b.dataset.tgnstep, 10)) / 5) * 5)) } });
    }));
    $('tGnAuto').addEventListener('click', () => send({ c: 'settings', patch: { gn: 0 } }));
    setting('ttsel', 'tsel', (v) => parseInt(v, 10));
    $('tShake').addEventListener('click', () => send({ c: 'shake' }));

    // ---------- Anzeige ----------
    const cards = {};

    function buildCard(id) {
      const el = document.createElement('div');
      el.className = 't-dev';
      el.innerHTML = `
        <div class="t-dev-head">
          <span class="t-shape"></span>
          <input class="t-name" maxlength="20" placeholder="Name oder Kürzel" autocomplete="off" autocapitalize="words" spellcheck="false">
          <span class="t-chip"></span>
        </div>
        <div class="t-dev-actions">
          <button class="btn ghost t-blink" type="button">Aufblinken</button>
          <button class="btn ghost t-reset" type="button">Zurücksetzen</button>
        </div>
        <div class="t-opts"></div>`;
      const refs = {
        el,
        shape: el.querySelector('.t-shape'),
        chip: el.querySelector('.t-chip'),
        name: el.querySelector('.t-name'),
        segs: {},
      };
      refs.name.value = names[id] || '';
      refs.name.addEventListener('input', () => {
        const v = refs.name.value.trim().slice(0, 20);
        if (v) names[id] = v; else delete names[id];
        LK.store.set(nameStore, JSON.stringify(names));
      });
      el.querySelector('.t-blink').addEventListener('click', () => send({ c: 'blink', id }));
      el.querySelector('.t-reset').addEventListener('click', () => send({ c: 'cfgreset', id }));
      const box = el.querySelector('.t-opts');
      OPTS.forEach((o) => {
        const wrap = document.createElement('div');
        const label = document.createElement('label');
        label.textContent = o.label;
        const seg = document.createElement('div');
        seg.className = 'seg wide';
        o.vals.forEach(([v, text]) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.v = v;
          b.textContent = text;
          b.addEventListener('click', () => {
            let value = null;
            if (v !== '') value = o.type === 'float' ? parseFloat(v) : (o.type === 'int' ? parseInt(v, 10) : v);
            send({ c: 'cfg', id, key: o.key, value });
          });
          seg.appendChild(b);
        });
        wrap.append(label, seg);
        box.appendChild(wrap);
        refs.segs[o.key] = seg;
      });
      cards[id] = refs;
      return refs;
    }

    function render(p) {
      renderDiag(p);
      // Zusammenfassung und Knöpfe
      const phase = p.finale ? 'Finale' : (p.paused ? 'pausiert' : (PHASE[p.ph] || ''));
      const serie = LK.isTeamGm(p.gm) && p.ser && p.sw ? ` · Serie ${p.sw[0]} : ${p.sw[1]}` : '';
      $('tSummary').textContent = `${TITLES[p.gm] || ''}${p.gm === 'klassik' && p.tm ? ' (Zeitspiel)' : ''}${serie} · Runde ${p.round} · ${phase} · ${p.n} ${p.n === 1 ? 'Gerät' : 'Geräte'}`;
      $('tGo').hidden = !(p.ph === 'ready' && p.n > 0);
      const canPause = p.ph === 'play' && !p.finale;
      $('tPause').disabled = !canPause;
      $('tPause').textContent = p.paused ? '▶ Weiter' : '⏸ Pause';

      // Spielart und Optionen
      const mark = (attr, value) => document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.setAttribute('aria-pressed', String(parseInt(b.dataset[attr], 10) === value)));
      document.querySelectorAll('[data-tgm]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tgm === p.gm)));
      mark('ttm', p.tm);
      mark('tgn', p.gn);
      mark('tnl', p.nl);
      mark('tpen', p.pen);
      mark('tnr', p.nr);
      mark('tsp', p.sp);
      mark('tsj', p.sj);
      mark('tser', p.ser);
      mark('tdkv', p.dkv);
      $('tGnVal').textContent = p.gn ? String(p.gn) : `Auto (${p.goal})`;
      mark('ttsel', p.tsel);
      $('tShake').hidden = !(LK.isTeamGm(p.gm) && p.ph === 'ready' && p.n > 0);
      $('tGo').textContent = p.round > 1 ? 'Neue Runde ▶' : 'Los ▶';
      document.querySelectorAll('[data-tfor]').forEach((el) => { el.hidden = !el.dataset.tfor.split(' ').includes(p.gm); });
      $('tGnLabel').textContent = GN_LABEL[p.gm] || '';

      // Geräte
      const list = p.devices.slice().sort((a, b) => a.slot - b.slot);
      $('tCount').textContent = `(${list.length})`;
      $('tNone').hidden = list.length > 0;
      const ids = new Set(list.map((d) => d.id));
      Object.keys(cards).forEach((id) => { if (!ids.has(id)) { cards[id].el.remove(); delete cards[id]; } });
      list.forEach((d) => {
        const c = cards[d.id] || buildCard(d.id);
        const col = LK.isTeamGm(p.gm) && d.team !== undefined ? LK.TEAM_COLORS[d.team] : LK.COLORS[d.slot];
        if (c.shape.dataset.s !== `${d.slot}|${col}`) {
          c.shape.dataset.s = `${d.slot}|${col}`;
          c.shape.style.color = col;
          c.shape.innerHTML = LK.shapeSvg(d.slot);
        }
        const lost = d.age !== null && d.age > 8000;
        const old = !lost && d.bv && p.diag && p.diag.build && d.bv !== p.diag.build;
        c.chip.textContent = lost ? 'Verbindung weg' : (old ? 'alte Version, neu laden' : (d.holds ? 'hat das Licht' : 'bereit'));
        c.chip.className = `t-chip ${lost || old ? 'off' : (d.holds ? 'on' : '')}`;
        c.el.classList.toggle('holds', d.holds);
        OPTS.forEach((o) => {
          const cur = String(d.eff && d.eff[o.key] !== undefined ? d.eff[o.key] : (d.cfg[o.key] === undefined ? '' : d.cfg[o.key]));
          c.segs[o.key].querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === cur)));
        });
        $('tDevices').appendChild(c.el); // hält die Reihenfolge nach Form und Farbe
      });
    }
    // Vor dem ersten Stand der Tafel nur eine leere Anzeige
    $('tNone').hidden = false;

    net.start();
  };
})(window.LK);
