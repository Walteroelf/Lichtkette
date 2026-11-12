'use strict';

// Gemeinsame Bausteine: Konstanten, Formen, Töne, kleine Helfer.
window.LK = window.LK || {};

(function (LK) {
  LK.PREFIX = 'lichtkette-walteroelf/v1/';
  LK.BROKERS = [
    { name: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { name: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  ];
  LK.MAX_PLAYERS = 12;
  LK.WAIT_OPTIONS = [0, 10, 30]; // Sekunden, nach denen das Licht von allein weiterwandert (0 = nie)

  // Neonfarben, dazu je eine eigene Form (für Farbenschwäche und zum Merken)
  LK.COLORS = [
    '#22d3ee', '#f472b6', '#a3e635', '#fbbf24', '#a78bfa', '#fb7185',
    '#34d399', '#60a5fa', '#fb923c', '#e879f9', '#facc15', '#2dd4bf',
  ];

  // Staffel: zwei Teams. Doppelte Lichter: jedes Licht hat seine eigene Farbe.
  LK.TEAM_COLORS = ['#22d3ee', '#f472b6'];
  LK.TEAM_NAMES = ['Blau', 'Pink'];
  // Spielarten mit zwei Teams (Staffel, Tauziehen)
  LK.isTeamGm = (g) => g === 'staffel' || g === 'zieh';
  LK.LIGHT_COLORS = ['#fde68a', '#7dd3fc', '#fbcfe8'];

  const TAU = Math.PI * 2;
  const poly =(n, rot = 0) => Array.from({ length: n }, (_, i) => {
    const a = rot + (i * TAU) / n - Math.PI / 2;
    return [Math.cos(a) * 0.94, Math.sin(a) * 0.94];
  });
  const star = (n, inner, rot = 0) => Array.from({ length: n * 2 }, (_, i) => {
    const r = i % 2 ? inner : 1;
    const a = rot + (i * Math.PI) / n - Math.PI / 2;
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const cross = [[-0.34, -1], [0.34, -1], [0.34, -0.34], [1, -0.34], [1, 0.34], [0.34, 0.34],
    [0.34, 1], [-0.34, 1], [-0.34, 0.34], [-1, 0.34], [-1, -0.34], [-0.34, -0.34]];

  // null = Kreis
  LK.SHAPES = [
    null, poly(3), poly(4, Math.PI / 4), poly(4), poly(5), poly(6),
    star(5, 0.46), cross, star(4, 0.42), star(6, 0.56), poly(3, Math.PI), poly(8, Math.PI / 8),
  ];

  LK.shapePath = function (ctx, slot, x, y, r) {
    const p = LK.SHAPES[slot % LK.SHAPES.length];
    ctx.beginPath();
    if (!p) { ctx.arc(x, y, r * 0.94, 0, TAU); return; }
    p.forEach(([px, py], i) => (i ? ctx.lineTo(x + px * r, y + py * r) : ctx.moveTo(x + px * r, y + py * r)));
    ctx.closePath();
  };

  LK.shapeSvg = function (slot) {
    const p = LK.SHAPES[slot % LK.SHAPES.length];
    const inner = p
      ? `<polygon points="${p.map(([x, y]) => `${(50 + x * 46).toFixed(1)},${(50 + y * 46).toFixed(1)}`).join(' ')}" stroke-linejoin="round"/>`
      : '<circle cx="50" cy="50" r="44"/>';
    return `<svg viewBox="0 0 100 100" aria-hidden="true">${inner}</svg>`;
  };

  LK.rgb = (hex) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  LK.rgba = (hex, a) => { const c = LK.rgb(hex); return `rgba(${c[0]},${c[1]},${c[2]},${a})`; };
  LK.mixRgba = (h1, h2, t, a) => {
    const c1 = LK.rgb(h1), c2 = LK.rgb(h2);
    return `rgba(${Math.round(c1[0] + (c2[0] - c1[0]) * t)},${Math.round(c1[1] + (c2[1] - c1[1]) * t)},${Math.round(c1[2] + (c2[2] - c1[2]) * t)},${a})`;
  };

  LK.rid = function (n) {
    const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
    const buf = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    return Array.from(buf, (b) => chars[b % chars.length]).join('');
  };

  LK.store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* privater Modus */ } },
  };

  LK.validRoom = (s) => /^[a-z0-9-]{4,24}$/.test(s || '');

  // ---- Verschlüsselung zwischen Tafel und Lehrer-Gerät (AES-GCM) ----
  // Der geheime Schlüssel steht nur im Lehrer-Link (nach dem #) und wird nie gesendet.
  // AES-GCM verschlüsselt und prüft zugleich, dass die Nachricht nicht verändert wurde.
  const b64 = (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s); };
  const unb64 = (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  LK.tcrypto = {
    available: !!(window.crypto && window.crypto.subtle),
    async derive(secret) {
      const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`lichtkette-v1|${secret}`));
      return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
    async seal(key, obj) {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
      return { iv: b64(iv), ct: b64(new Uint8Array(ct)) };
    },
    // null, wenn der Schlüssel nicht passt oder die Nachricht verändert wurde
    async open(key, box) {
      try {
        if (!box || typeof box.iv !== 'string' || typeof box.ct !== 'string') return null;
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
        return JSON.parse(new TextDecoder().decode(plain));
      } catch (e) { return null; }
    },
  };

  // Version dieser Seite (steht im <meta name="build"> und wird von stamp.sh gesetzt). Hilft, alte Seiten zu erkennen.
  LK.BUILD = (() => { const m = document.querySelector('meta[name="build"]'); return m ? m.content : '?'; })();

  // Bildschirm anlassen
  let awakeWanted = false;
  let lock = null;
  LK.isAwake = () => !!lock;
  LK.keepAwake = async function () {
    awakeWanted = true;
    try {
      if ('wakeLock' in navigator && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      }
    } catch (e) { lock = null; }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && awakeWanted) LK.keepAwake();
  });

  // ---- Töne: Pentatonik, damit alles zusammen gut klingt ----
  LK.audio = (function () {
    let ctx = null;
    let master = null;
    const DEG = [0, 3, 5, 7, 10]; // Moll-Pentatonik

    function init() {
      if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.8;
      const comp = ctx.createDynamicsCompressor();
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.31;
      const fb = ctx.createGain();
      fb.gain.value = 0.34;
      const wet = ctx.createGain();
      wet.gain.value = 0.32;
      master.connect(comp);
      comp.connect(ctx.destination);
      master.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      delay.connect(wet);
      wet.connect(comp);
    }

    function freq(slot, oct) {
      const s = slot % LK.MAX_PLAYERS;
      const semis = DEG[s % 5] + 12 * Math.floor(s / 5) + 12 * (oct || 0);
      return 220 * Math.pow(2, semis / 12);
    }

    function note(slot, vol, dur, when, oct) {
      if (!ctx) return;
      const t = ctx.currentTime + (when || 0);
      const f = freq(slot, oct);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.4, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 1.3));
      g.connect(master);
      [['triangle', f, 1], ['sine', f * 2, 0.25]].forEach(([type, fr, gain]) => {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        og.gain.value = gain;
        o.type = type;
        o.frequency.value = fr;
        o.connect(og);
        og.connect(g);
        o.start(t);
        o.stop(t + (dur || 1.3) + 0.05);
      });
    }

    // Zum Abschluss einer Runde: alle Töne der Reihe nach, dazu ein weicher Akkord
    function finale(slots) {
      if (!ctx) return;
      const sorted = slots.slice().sort((a, b) => a - b);
      sorted.forEach((s, i) => note(s, 0.32, 1.8, i * 0.13));
      const t = ctx.currentTime + 0.1;
      [0, 3, 7].forEach((semi) => {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 110 * Math.pow(2, semi / 12);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.14, t + 0.9);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 4.2);
        o.connect(g);
        g.connect(master);
        o.start(t);
        o.stop(t + 4.3);
      });
    }

    // ---- Töne für die Spielarten: Sie verraten etwas über den Spielverlauf ----
    const pitch = (semis) => 220 * Math.pow(2, semis / 12);
    function tone(f, vol, dur, when, type) {
      if (!ctx) return;
      const t = ctx.currentTime + (when || 0);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type || 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol || 0.3, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (dur || 0.6));
      o.connect(g);
      g.connect(master);
      o.start(t);
      o.stop(t + (dur || 0.6) + 0.05);
    }
    // Hell und steigend: Schritt für Schritt näher am Ziel
    function chime(step) {
      if (!ctx) return;
      const i = Math.max(0, step);
      const semis = DEG[i % 5] + 12 * Math.floor(i / 5) + 12;
      tone(pitch(semis), 0.3, 0.9, 0, 'triangle');
      tone(pitch(semis + 12), 0.1, 1.1, 0.05);
    }
    // Aufsteigender Lauf: etwas wurde geschafft
    function arp() {
      for (let i = 0; i < 4; i++) tone(pitch(DEG[i % 5] + 12 + (i >= 4 ? 12 : 0)), 0.26, 1.0, i * 0.09, 'triangle');
      tone(pitch(24), 0.2, 1.4, 0.4);
    }
    // Zwei weiche, tiefe Töne: nicht ganz richtig (kein Schreck, keine Strafe)
    function thud() {
      tone(130, 0.24, 0.35, 0, 'sine');
      tone(98, 0.22, 0.45, 0.16, 'sine');
    }
    // Absteigend: Die Runde ist nicht gelungen, aber ohne Härte
    function lose() {
      tone(pitch(7), 0.28, 1.2, 0, 'triangle');
      tone(pitch(3), 0.28, 1.4, 0.35, 'triangle');
      tone(pitch(-2), 0.28, 2.2, 0.75, 'triangle');
      tone(pitch(-12), 0.2, 2.6, 0.75);
    }
    // Tauziehen: Wer vorn liegt, klingt höher, wer zurückliegt, tiefer. Teams haben ihre eigene Lage.
    function pull(team, diff) {
      const semis = (team ? 7 : 0) + 2 * Math.max(-5, Math.min(5, diff));
      tone(pitch(semis), 0.34, 1.0, 0, 'triangle');
      tone(pitch(semis + 12), 0.1, 1.2, 0.04);
    }
    // Dunkelheit: ein tiefer Ton, der mit dem Schatten lauter, höher und unruhiger wird. null = still
    let dr = null;
    function drone(level) {
      if (!ctx) return;
      const t = ctx.currentTime;
      if (level === null || level === undefined) {
        if (dr && dr.on) { dr.g2.gain.setTargetAtTime(0, t, 0.25); dr.on = false; }
        return;
      }
      if (!dr) {
        const o = ctx.createOscillator();
        const lfo = ctx.createOscillator();
        const lg = ctx.createGain();
        const g1 = ctx.createGain();
        const g2 = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = 52;
        lfo.frequency.value = 1.2;
        lg.gain.value = 0.45;
        g1.gain.value = 0.55;
        g2.gain.value = 0;
        lfo.connect(lg);
        lg.connect(g1.gain);
        o.connect(g1);
        g1.connect(g2);
        g2.connect(master);
        o.start();
        lfo.start();
        dr = { o, lfo, g2, on: false };
      }
      dr.on = true;
      dr.g2.gain.setTargetAtTime(0.01 + 0.11 * level, t, 0.4);
      dr.lfo.frequency.setTargetAtTime(1.2 + 5 * level, t, 0.4);
      dr.o.frequency.setTargetAtTime(52 + 24 * level, t, 0.4);
    }

    return { init, note, finale, tone, chime, arp, thud, lose, pull, drone, get ready() { return !!ctx; } };
  })();
})(window.LK);
