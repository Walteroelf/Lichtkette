'use strict';

// Verbindung über einen öffentlichen MQTT-Server (wie beim MatheBingo).
// Themen:  <Prefix><Raum>/hb     Spieler -> Tafel   "Ich bin da" (alle paar Sekunden)
//          <Prefix><Raum>/act    Spieler -> Tafel   "Ich gebe das Licht weiter"
//          <Prefix><Raum>/state  Tafel   -> alle    Spielstand (wer hat das Licht usw.)
//          <Prefix><Raum>/host   Tafel   -> Tafeln  "Ich bin die Haupt-Tafel"
// Übertragen werden nur zufällige Gerätekennungen, Formen und Tipps, keine Namen.
(function (LK) {
  const CONNECT_TRY_MS = 8000;

  LK.Net = class {
    constructor(room, startBroker, subs) {
      this.room = room;
      this.bi = startBroker || 0;
      this.subs = subs;
      this.client = null;
      this.connected = false;
      this.everConnected = false;
      this.handlers = {};
      this.onconnect = null;
      this.onstatus = null;
      this.brokerName = '';
    }

    topic(name) { return `${LK.PREFIX}${this.room}/${name}`; }

    on(type, fn) { this.handlers[type] = fn; }

    start() { this._open(); }

    _status() { if (this.onstatus) this.onstatus(this.connected); }

    _open() {
      const broker = LK.BROKERS[this.bi % LK.BROKERS.length];
      this.brokerName = broker.name;
      const c = mqtt.connect(broker.url, {
        clientId: `lk_${LK.rid(12)}`,
        clean: true,
        reconnectPeriod: 2000,
        connectTimeout: 6000,
        keepalive: 20,
      });
      this.client = c;
      // Klappt der erste Server nicht, wird der zweite probiert (nur vor der ersten Verbindung)
      const giveUp = setTimeout(() => {
        if (!this.everConnected && this.client === c && !c.connected) {
          c.end(true);
          this.bi++;
          this._open();
        }
      }, CONNECT_TRY_MS);

      c.on('connect', () => {
        clearTimeout(giveUp);
        this.everConnected = true;
        this.connected = true;
        c.subscribe(this.subs.map((s) => this.topic(s)), { qos: 0 });
        this._status();
        if (this.onconnect) this.onconnect();
      });
      c.on('close', () => { this.connected = false; this._status(); });
      c.on('offline', () => { this.connected = false; this._status(); });
      c.on('error', () => { /* mqtt.js versucht es selbst erneut */ });
      c.on('message', (t, buf) => {
        const name = t.slice(this.topic('').length);
        const fn = this.handlers[name];
        if (!fn) return;
        let msg = null;
        try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
        if (msg && typeof msg === 'object') fn(msg);
      });
    }

    send(name, obj) {
      if (!this.client || !this.connected) return;
      this.client.publish(this.topic(name), JSON.stringify(obj), { qos: 0 });
    }
  };
})(window.LK);
