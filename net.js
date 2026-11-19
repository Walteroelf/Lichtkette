'use strict';

// Verbindung über ZWEI öffentliche MQTT-Server gleichzeitig (HiveMQ und EMQX).
// Jede Nachricht geht über beide Server raus und kommt von beiden an. Doppelte werden erkannt und verworfen.
// Fällt ein Server aus, läuft das Spiel über den anderen weiter, ohne dass jemand etwas tun muss.
// Themen:  <Prefix><Raum>/hb     Spieler -> Tafel   "Ich bin da" (alle paar Sekunden)
//          <Prefix><Raum>/act    Spieler -> Tafel   "Ich gebe das Licht weiter"
//          <Prefix><Raum>/state  Tafel   -> alle    Spielstand (wer hat das Licht usw.)
//          <Prefix><Raum>/host   Tafel   -> Tafeln  "Ich bin die Haupt-Tafel"
// Übertragen werden nur zufällige Gerätekennungen, Formen und Tipps, keine Namen.
(function (LK) {
  const SEEN_MAX = 400;

  LK.Net = class {
    // mode: 0 = beide Server (Standard), 1 = nur der erste, 2 = nur der zweite (zum Testen: &b=1 oder &b=2)
    constructor(room, mode, subs) {
      this.room = room;
      this.mode = mode || 0;
      this.subs = subs;
      this.links = [];
      this.handlers = {};
      this.onconnect = null;
      this.onstatus = null;
      this.seen = new Set();
      this.seenOrder = [];
      this._last = null;
    }

    // Mindestens ein Server ist verbunden
    get connected() { return this.links.some((l) => l.ok); }

    get upCount() { return this.links.filter((l) => l.ok).length; }

    get total() { return this.links.length; }

    get brokerName() {
      const names = this.links.filter((l) => l.ok).map((l) => l.name);
      return names.length ? names.join(' + ') : '';
    }

    topic(name) { return `${LK.PREFIX}${this.room}/${name}`; }

    on(type, fn) { this.handlers[type] = fn; }

    start() {
      const idx = this.mode === 1 ? [0] : (this.mode === 2 ? [1] : [0, 1]);
      idx.forEach((i) => this._open(LK.BROKERS[i % LK.BROKERS.length]));
      // Wächter: erkennt tote Verbindungen, die niemand als "geschlossen" meldet (zum Beispiel nach dem Aufwachen eines iPads)
      this._wd = setInterval(() => this._watch(), 2000);
      let hiddenAt = 0;
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
        if (hiddenAt && Date.now() - hiddenAt > 6000) this.refresh(); // war länger im Hintergrund oder gesperrt: frisch verbinden
        hiddenAt = 0;
      });
      window.addEventListener('online', () => this.refresh());
    }

    // Alle Server neu verbinden (mit neuem Client, das geht schneller als das Warten auf die automatische Wiederholung)
    refresh() { this.links.forEach((l) => this._restart(l)); }

    _restart(link) {
      const now = Date.now();
      if (now - link.lastRestart < 8000) return;
      link.lastRestart = now;
      link.lastRx = now;
      const old = link.c;
      link.ok = false;
      this._status();
      try { old.removeAllListeners(); old.on('error', () => {}); old.end(true); } catch (e) { /* war schon weg */ }
      this._connect(link);
    }

    _watch() {
      const now = Date.now();
      this.links.forEach((l) => {
        if (!l.ok) return;
        const other = this.links.some((o) => o !== l && o.ok && now - o.lastRx < 4000);
        // Dieser Server liefert seit Sekunden nichts mehr, der andere schon: vermutlich eine tote Verbindung
        if (now - l.lastRx > 12000 && other) this._restart(l);
      });
      // Alle Server lange still und die Seite ist sichtbar: einmal frisch verbinden
      if (this.links.length && document.visibilityState === 'visible' && this.links.every((l) => now - l.lastRx > 45000)) this.refresh();
    }

    _status() {
      const state = `${this.upCount}/${this.total}`;
      if (state === this._last) return;
      this._last = state;
      if (this.onstatus) this.onstatus(this.connected, this.upCount, this.total);
    }

    _remember(id) {
      if (this.seen.has(id)) return false;
      this.seen.add(id);
      this.seenOrder.push(id);
      if (this.seenOrder.length > SEEN_MAX) this.seen.delete(this.seenOrder.shift());
      return true;
    }

    _open(broker) {
      const link = { name: broker.name, ok: false, c: null, broker, lastRx: Date.now(), lastRestart: 0 };
      this.links.push(link);
      this._connect(link);
    }

    _connect(link) {
      const c = mqtt.connect(link.broker.url, {
        clientId: `lk_${LK.rid(12)}`,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 6000,
        keepalive: 10,
      });
      link.c = c;

      c.on('connect', () => {
        if (link.c !== c) return;
        link.ok = true;
        link.lastRx = Date.now();
        c.subscribe(this.subs.map((s) => this.topic(s)), { qos: 0 });
        this._status();
        if (this.onconnect) this.onconnect();
      });
      const down = () => { if (link.c !== c) return; link.ok = false; this._status(); };
      c.on('close', down);
      c.on('offline', down);
      c.on('error', () => { /* mqtt.js versucht es selbst erneut */ });
      c.on('message', (t, buf) => {
        if (link.c !== c) return;
        link.lastRx = Date.now();
        const name = t.slice(this.topic('').length);
        const fn = this.handlers[name];
        if (!fn) return;
        let msg = null;
        try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
        if (!msg || typeof msg !== 'object') return;
        if (typeof msg._m === 'string') {
          if (!this._remember(msg._m)) return; // kam schon über den anderen Server an
          delete msg._m;
        }
        try { fn(msg); } catch (e) { console.error('Lichtkette:', name, e && e.stack ? e.stack : e); }
      });
    }

    send(name, obj) {
      if (!this.connected) return;
      const payload = JSON.stringify(Object.assign({}, obj, { _m: LK.rid(10) }));
      const topic = this.topic(name);
      this.links.forEach((l) => {
        if (l.ok) {
          try { l.c.publish(topic, payload, { qos: 0 }); } catch (e) { /* dieser Server ist gerade weg */ }
        }
      });
    }
  };
})(window.LK);
