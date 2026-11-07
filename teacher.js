'use strict';

// Lehrer-Ansicht (Spielleitung): Fernbedienung für die Tafel.
// - Der Schlüssel kommt aus dem Lehrer-QR (hinter dem # im Link) und bleibt auf diesem Gerät.
// - Befehle an die Tafel und die Geräteinfos von der Tafel sind mit diesem Schlüssel verschlüsselt (AES-GCM).
// - Namen der Geräte bleiben nur hier, sie gehen nie ins Netz und stehen nicht auf der Tafel.
(function (LK) {
  const $ = (id) => document.getElementById(id);
  const TITLES = { klassik: 'Lichtkette', rhythmus: 'Rhythmus', staffel: 'Staffel', doppel: 'Doppelte Lichter', schatz: 'Schatz-Licht' };
  const GN_LABEL = {
    klassik: 'Weitergaben pro Runde',
    rhythmus: 'Weitergaben pro Runde',
    staffel: 'Weitergaben pro Team',
    doppel: 'Weitergaben insgesamt',
    schatz: 'Sterne pro Runde',
  };
  const PHASE = { ready: 'wartet auf „Los“', count: 'Countdown läuft', play: 'läuft' };
  // Einstellungen pro Gerät: Schlüssel, Beschriftung, Werte (leer = das Gerät entscheidet selbst)
  const OPTS = [
    { key: 'rnd', label: 'Tippfläche', type: 'int', vals: [['', 'wie am Gerät'], ['0', 'fest'], ['1', 'springender Punkt']] },
    { key: 'sz', label: 'Größe des Punkts oder Kreises', type: 'float', vals: [['', 'wie am Gerät'], ['0.75', 'klein'], ['1', 'normal'], ['1.4', 'groß']] },
    { key: 'pn', label: 'Fehltipps (Staffel)', type: 'int', vals: [['', 'wie am Gerät'], ['0', 'ohne Strafe'], ['1', 'mit Strafe']] },
    { key: 'nt', label: 'Zeit dieses Geräts (Zeitspiel, Staffel)', type: 'int', vals: [['', 'wie am Gerät'], ['0', 'zählt'], ['1', 'zählt nicht']] },
    { key: 'w', label: 'Licht wandert weiter nach', type: 'int', vals: [['', 'wie am Gerät'], ['0', 'nie'], ['10', '10 s'], ['30', '30 s']] },
    { key: 'tt', label: 'Team (Staffel, wirkt vor dem Start einer Runde)', type: 'str', vals: [['', 'wie am Gerät'], ['x', 'automatisch'], ['a', 'Blau'], ['b', 'Pink']] },
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
    $('tRestart').addEventListener('click', () => { if (window.confirm('Die Runde wirklich neu starten?')) send({ c: 'restart' }); });

    const setting = (attr, key, parse) => document.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
      send({ c: 'settings', patch: { [key]: parse(b.dataset[attr === 'tgm' ? 'tgm' : attr]) } });
    }));
    setting('tgm', 'gm', (v) => v);
    setting('ttm', 'tm', (v) => parseInt(v, 10));
    setting('tgn', 'gn', (v) => parseInt(v, 10));
    setting('tnl', 'nl', (v) => parseInt(v, 10));
    setting('tbpm', 'bpm', (v) => parseInt(v, 10));
    setting('tpen', 'pen', (v) => parseInt(v, 10));

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
      // Zusammenfassung und Knöpfe
      const phase = p.finale ? 'Finale' : (p.paused ? 'pausiert' : (PHASE[p.ph] || ''));
      $('tSummary').textContent = `${TITLES[p.gm] || ''}${p.gm === 'klassik' && p.tm ? ' (Zeitspiel)' : ''} · Runde ${p.round} · ${phase} · ${p.n} ${p.n === 1 ? 'Gerät' : 'Geräte'}`;
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
      mark('tbpm', p.bpm);
      mark('tpen', p.pen);
      document.querySelectorAll('[data-tfor]').forEach((el) => { el.hidden = el.dataset.tfor !== p.gm; });
      $('tGnLabel').textContent = GN_LABEL[p.gm] || '';

      // Geräte
      const list = p.devices.slice().sort((a, b) => a.slot - b.slot);
      $('tCount').textContent = `(${list.length})`;
      $('tNone').hidden = list.length > 0;
      const ids = new Set(list.map((d) => d.id));
      Object.keys(cards).forEach((id) => { if (!ids.has(id)) { cards[id].el.remove(); delete cards[id]; } });
      list.forEach((d) => {
        const c = cards[d.id] || buildCard(d.id);
        const col = p.gm === 'staffel' && d.team !== undefined ? LK.TEAM_COLORS[d.team] : LK.COLORS[d.slot];
        if (c.shape.dataset.s !== `${d.slot}|${col}`) {
          c.shape.dataset.s = `${d.slot}|${col}`;
          c.shape.style.color = col;
          c.shape.innerHTML = LK.shapeSvg(d.slot);
        }
        const lost = d.age !== null && d.age > 8000;
        c.chip.textContent = lost ? 'Verbindung weg' : (d.holds ? 'hat das Licht' : 'bereit');
        c.chip.className = `t-chip ${lost ? 'off' : (d.holds ? 'on' : '')}`;
        c.el.classList.toggle('holds', d.holds);
        OPTS.forEach((o) => {
          const cur = d.cfg[o.key] === undefined ? '' : String(d.cfg[o.key]);
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
