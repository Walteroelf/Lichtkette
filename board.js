'use strict';

// Tafel (Beamer / Smartboard): zeigt die Lichtkette und lenkt das Spiel.
// Die Haupt-Tafel ("Host") entscheidet, wer das Licht bekommt. Eine zweite Tafel schaut nur mit.
(function (LK) {
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const PULSE_MS = 750;
  const FINALE_MS = 5200;
  const GONE_MS = 9000; // so lange ohne Lebenszeichen, dann fliegt ein Gerät aus dem Spiel

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
    let bag = [];
    let autoTimer = null;
    let finTimer = null;
    let decideTimer = null;
    let soundOn = LK.store.get('lk_board_snd', '1') === '1';
    let st = {
      epoch: Date.now(), seq: 0, holder: null, prev: null, chain: 0, goal: 8, round: 1,
      finale: false, players: {}, autoMs: 0, host: boardId, ts: 0,
    };

    const net = new LK.Net(room, startBroker, ['hb', 'act', 'host', 'state']);

    // ================= Spiellogik (nur Haupt-Tafel) =================
    const aliveIds = () => Object.keys(st.players);

    function freeSlot(id) {
      const used = new Set(Object.values(st.players));
      if (slotMem[id] !== undefined && !used.has(slotMem[id])) return slotMem[id];
      for (let i = 0; i < LK.MAX_PLAYERS; i++) if (!used.has(i)) return i;
      return -1;
    }

    function addPlayer(id) {
      if (st.players[id] !== undefined) return false;
      const s = freeSlot(id);
      if (s < 0) return false;
      st.players[id] = s;
      slotMem[id] = s;
      bag.push(id);
      return true;
    }

    function removePlayer(id) {
      delete st.players[id];
      bag = bag.filter((x) => x !== id);
    }

    // Zufällig, aber fair: jeder kommt einmal dran, bevor die Runde von vorn beginnt
    function pickNext() {
      const ids = aliveIds();
      if (!ids.length) return null;
      if (ids.length === 1) return ids[0];
      let c = bag.filter((x) => st.players[x] !== undefined && x !== st.holder);
      if (!c.length) {
        bag = ids.slice();
        c = bag.filter((x) => x !== st.holder);
      }
      const n = c[Math.floor(Math.random() * c.length)];
      bag = bag.filter((x) => x !== n);
      return n;
    }

    function setHolder(next) {
      st.prev = st.holder;
      st.holder = next;
      st.seq++;
      st.autoMs = 0;
      clearTimeout(autoTimer);
      if (next) {
        const w = (peers[next] && peers[next].w) || 0;
        if (w > 0) {
          st.autoMs = w * 1000;
          const seq = st.seq;
          autoTimer = setTimeout(() => { if (isHost && st.seq === seq && st.holder) pass(); }, st.autoMs);
        }
      }
    }

    function pass() {
      if (st.finale) return;
      st.chain++;
      if (st.chain >= st.goal) { startFinale(); return; }
      setHolder(pickNext());
      publish();
    }

    function startFinale() {
      st.finale = true;
      setHolder(null);
      publish();
      clearTimeout(finTimer);
      finTimer = setTimeout(() => {
        if (!isHost) return;
        st.finale = false;
        st.round++;
        st.chain = 0;
        st.goal = Math.max(8, aliveIds().length * 3);
        st.prev = null;
        st.holder = null;
        setHolder(pickNext());
        publish();
      }, FINALE_MS);
    }

    function tick() {
      if (!isHost) return;
      const now = Date.now();
      let changed = false;
      aliveIds().forEach((id) => {
        const p = peers[id];
        if (!p || now - p.last > GONE_MS) {
          removePlayer(id);
          changed = true;
          if (st.holder === id) {
            if (st.finale) st.holder = null; else setHolder(pickNext());
          }
        }
      });
      if (changed) publish();
    }

    function publish() {
      st.ts = Date.now();
      net.send('state', st);
      applyState(st);
    }

    function becomeHost() {
      isHost = true;
      st.host = boardId;
      st.epoch = Date.now();
      st.seq++;
      const now = Date.now();
      Object.keys(peers).forEach((id) => { if (now - peers[id].last < GONE_MS) addPlayer(id); });
      if (aliveIds().length) {
        st.goal = Math.max(8, aliveIds().length * 3);
        setHolder(pickNext());
      }
      publish();
      net.send('host', { id: boardId });
      setInterval(() => { if (isHost) net.send('host', { id: boardId }); }, 2000);
      setInterval(tick, 1000);
      setInterval(() => { if (isHost) publish(); }, 4000); // geht eine Nachricht verloren, holt das jedes Gerät nach
      setViewerBanner(false);
    }

    function setViewerBanner(on) {
      $('viewerTag').hidden = !on;
    }

    // ================= Nachrichten =================
    net.on('hb', (m) => {
      if (typeof m.id !== 'string' || m.id.length > 16) return;
      const now = Date.now();
      const prev = peers[m.id];
      peers[m.id] = { last: now, w: LK.WAIT_OPTIONS.includes(m.w) ? m.w : 0, m: m.m };
      if (isHost !== true) return;
      const added = addPlayer(m.id);
      if (added && !st.holder && !st.finale) setHolder(pickNext());
      if (added || !prev || now - prev.last > 6000) publish();
    });

    net.on('act', (m) => {
      if (isHost === true && !st.finale && m.id === st.holder && m.seq === st.seq && m.epoch === st.epoch) pass();
    });

    net.on('host', (m) => {
      if (m.id === boardId) return;
      if (isHost === null) { isHost = false; setViewerBanner(true); } else if (isHost === true && String(m.id) < boardId) {
        // zwei Haupt-Tafeln zugleich: die mit der kleineren Kennung bleibt
        isHost = false;
        clearTimeout(autoTimer);
        clearTimeout(finTimer);
        setViewerBanner(true);
      }
    });

    net.on('state', (m) => {
      if (isHost === false && m.host !== boardId && m.players) applyState(m);
    });

    net.onconnect = () => {
      setConn(true);
      if (!decideTimer) decideTimer = setTimeout(() => { if (isHost === null) becomeHost(); }, 3000);
      if (isHost) publish();
    };
    net.onstatus = setConn;

    function setConn(ok) {
      $('connDot').className = ok ? 'dot ok' : 'dot bad';
      $('connDot').title = ok ? `Verbunden (${net.brokerName})` : 'Keine Verbindung';
    }

    // ================= Darstellung =================
    let W = 0;
    let H = 0;
    let DPR = 1;
    const nodes = {};
    let edges = {};
    let pulse = null;
    let trail = [];
    let ripples = [];
    const view = {
      seq: -1, round: -1, holder: null, holderVis: null, chain: 0, goal: 8, prog: 0,
      finale: false, fin: null, autoMs: 0, autoSince: 0, init: false,
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
      const ids = Object.keys(nodes).filter((id) => !nodes[id].dying).sort((a, b) => nodes[a].slot - nodes[b].slot);
      const n = ids.length;
      const cx = W / 2;
      const cy = H / 2;
      const rx = W * 0.36;
      const ry = H * 0.33;
      ids.forEach((id, i) => {
        if (n === 1) { nodes[id].tx = cx; nodes[id].ty = cy - ry * 0.55; return; }
        const a = (i / n) * TAU - Math.PI / 2;
        nodes[id].tx = cx + Math.cos(a) * rx;
        nodes[id].ty = cy + Math.sin(a) * ry;
      });
    }

    function syncNodes(players) {
      const now = performance.now();
      let changed = false;
      Object.keys(players).forEach((id) => {
        if (!nodes[id] || nodes[id].dying) {
          nodes[id] = { slot: players[id], x: W / 2, y: H / 2, tx: W / 2, ty: H / 2, born: now, pop: 0, dying: 0 };
          changed = true;
        } else if (nodes[id].slot !== players[id]) { nodes[id].slot = players[id]; changed = true; }
      });
      Object.keys(nodes).forEach((id) => {
        if (players[id] === undefined && !nodes[id].dying) { nodes[id].dying = now; changed = true; }
      });
      if (changed) layout();
      const count = Object.keys(players).length;
      $('count').textContent = count === 1 ? '1 Gerät' : `${count} Geräte`;
      if (count > 0 && !view.qrAutoSmall) { view.qrAutoSmall = true; $('qrBox').classList.remove('big'); }
      $('idle').hidden = count > 0;
    }

    const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

    function applyState(s) {
      syncNodes(s.players);
      if (s.round !== view.round) { edges = {}; view.round = s.round; }
      if (s.seq !== view.seq) {
        const first = !view.init;
        view.seq = s.seq;
        view.init = true;
        view.autoSince = performance.now();
        if (first) {
          view.holderVis = s.holder;
          view.fin = s.finale ? { t0: performance.now() } : null;
        } else if (s.finale && !view.finale) {
          startFinaleFx(s);
        } else if (s.holder) {
          startPulse(s.prev, s.holder);
        } else {
          view.holderVis = null;
        }
      }
      if (!s.finale) view.fin = null;
      view.finale = s.finale;
      view.chain = s.chain;
      view.goal = s.goal;
      view.autoMs = s.autoMs;
      view.holder = s.holder;
    }

    function startPulse(from, to) {
      const now = performance.now();
      view.holderVis = null;
      view.fin = null;
      if (!from || from === to || !nodes[from] || !nodes[to]) {
        arrive(to, null);
        return;
      }
      pulse = { a: from, b: to, t0: now };
    }

    function arrive(to, from) {
      const n = nodes[to];
      if (!n) return;
      const now = performance.now();
      n.pop = now;
      view.holderVis = to;
      ripples.push({ x: n.x, y: n.y, t0: now, color: LK.COLORS[n.slot] });
      if (from) {
        const k = edgeKey(from, to);
        if (!edges[k]) edges[k] = { a: from, b: to, k: 0 };
        edges[k].k = Math.min(edges[k].k + 1, 8);
      }
      if (soundOn) LK.audio.note(n.slot, 0.5, 1.5);
    }

    function startFinaleFx(s) {
      view.holderVis = null;
      view.fin = { t0: performance.now() };
      pulse = null;
      if (soundOn) LK.audio.finale(Object.values(s.players));
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
      const finT = fin ? (now - fin.t0) / FINALE_MS : 0;

      // Pulsbewegung
      if (pulse) {
        const a = nodes[pulse.a];
        const b = nodes[pulse.b];
        if (!a || !b) { pulse = null; } else {
          const k = Math.min(1, (now - pulse.t0) / PULSE_MS);
          const p = bez(a, b, ease(k));
          trail.push({ x: p.x, y: p.y, t: now, a: a.slot, b: b.slot, k });
          pulse.p = p;
          pulse.k = k;
          if (k >= 1) { const from = pulse.a; const to = pulse.b; pulse = null; arrive(to, from); }
        }
      }

      ctx.globalCompositeOperation = 'lighter';

      // Spuren aus früheren Weitergaben
      Object.values(edges).forEach((e) => {
        const a = nodes[e.a];
        const b = nodes[e.b];
        if (!a || !b) return;
        const boost = fin ? 0.35 : 0;
        const al = Math.min(0.14 + e.k * 0.07 + boost, 0.85);
        const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
        g.addColorStop(0, LK.rgba(LK.COLORS[a.slot], al));
        g.addColorStop(1, LK.rgba(LK.COLORS[b.slot], al));
        const p = bez(a, b, 0.5);
        ctx.strokeStyle = g;
        ctx.lineWidth = 1.5 + Math.min(e.k, 6) * 0.9;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(p.qx, p.qy, b.x, b.y);
        ctx.stroke();
      });

      // Knoten
      Object.keys(nodes).forEach((id) => {
        const n = nodes[id];
        const col = LK.COLORS[n.slot];
        const born = Math.min(1, (now - n.born) / 500);
        const fade = n.dying ? Math.max(0, 1 - (now - n.dying) / 600) : 1;
        const lit = id === view.holderVis || (fin && finT < 0.9);
        const ps = n.pop ? Math.max(0, 1 - (now - n.pop) / 600) : 0;
        const sc = (0.4 + 0.6 * ease(born)) * (1 + 0.35 * ps * ps) * (lit && !fin ? 1.12 : 1);
        const r = R * sc;
        const breath = lit ? 0.5 + 0.5 * Math.sin(now / 420) : 0;
        const glowA = (lit ? 0.5 + 0.18 * breath : 0.1) * fade;
        const gr = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.4);
        gr.addColorStop(0, LK.rgba(col, glowA));
        gr.addColorStop(1, LK.rgba(col, 0));
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(n.x, n.y, r * 3.4, 0, TAU);
        ctx.fill();
        LK.shapePath(ctx, n.slot, n.x, n.y, r);
        ctx.fillStyle = LK.rgba(col, (lit ? 0.95 : 0.22) * fade);
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = LK.rgba(col, (lit ? 1 : 0.7) * fade);
        ctx.stroke();
        // Ring: so lange noch Zeit bleibt, bis das Licht von allein weiterwandert
        if (id === view.holderVis && view.autoMs > 0 && !fin) {
          const left = Math.max(0, 1 - (now - view.autoSince) / view.autoMs);
          ctx.lineWidth = 4;
          ctx.strokeStyle = LK.rgba(col, 0.8);
          ctx.beginPath();
          ctx.arc(n.x, n.y, r * 1.55, -Math.PI / 2, -Math.PI / 2 + TAU * left);
          ctx.stroke();
        }
      });

      // Schweif und Lichtkugel
      trail = trail.filter((t) => now - t.t < 650);
      trail.forEach((t) => {
        const life = 1 - (now - t.t) / 650;
        ctx.fillStyle = LK.mixRgba(LK.COLORS[t.a], LK.COLORS[t.b], t.k, 0.55 * life);
        ctx.beginPath();
        ctx.arc(t.x, t.y, R * 0.34 * (0.4 + 0.6 * life), 0, TAU);
        ctx.fill();
      });
      if (pulse && pulse.p) {
        const a = nodes[pulse.a];
        const b = nodes[pulse.b];
        const orb = ctx.createRadialGradient(pulse.p.x, pulse.p.y, 0, pulse.p.x, pulse.p.y, R * 1.5);
        orb.addColorStop(0, 'rgba(255,255,255,0.95)');
        orb.addColorStop(0.25, LK.mixRgba(LK.COLORS[a.slot], LK.COLORS[b.slot], pulse.k, 0.85));
        orb.addColorStop(1, LK.mixRgba(LK.COLORS[a.slot], LK.COLORS[b.slot], pulse.k, 0));
        ctx.fillStyle = orb;
        ctx.beginPath();
        ctx.arc(pulse.p.x, pulse.p.y, R * 1.5, 0, TAU);
        ctx.fill();
      }

      // Wellen bei Ankunft
      ripples = ripples.filter((rp) => now - rp.t0 < 900);
      ripples.forEach((rp) => {
        const k = (now - rp.t0) / 900;
        ctx.lineWidth = 3 * (1 - k) + 0.5;
        ctx.strokeStyle = LK.rgba(rp.color, 0.7 * (1 - k));
        ctx.beginPath();
        ctx.arc(rp.x, rp.y, R * (1 + k * 3.2), 0, TAU);
        ctx.stroke();
      });

      // Finale: ruhige Ringe aus der Mitte, jeweils in den Farben der Mitspielenden (kein Blitzen)
      if (fin && !reduceMotion) {
        const cols = Object.values(st.players).sort((a, b) => a - b);
        for (let i = 0; i < 5; i++) {
          const k = ((now - fin.t0) / 2400 - i * 0.26);
          if (k <= 0 || k >= 1) continue;
          const col = LK.COLORS[cols[i % Math.max(1, cols.length)] || 0];
          ctx.lineWidth = 5 * (1 - k) + 1;
          ctx.strokeStyle = LK.rgba(col, 0.55 * (1 - k));
          ctx.beginPath();
          ctx.arc(W / 2, H / 2, k * Math.min(W, H) * 0.5, 0, TAU);
          ctx.stroke();
        }
      }

      // Mitte: Fortschritt der Runde
      ctx.globalCompositeOperation = 'source-over';
      const target = fin ? 1 : (view.goal ? view.chain / view.goal : 0);
      view.prog += (target - view.prog) * 0.08;
      const hr = Math.min(W, H) * 0.085;
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(180,190,255,0.12)';
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, hr, 0, TAU);
      ctx.stroke();
      if (view.prog > 0.004) {
        ctx.strokeStyle = 'rgba(190,200,255,0.65)';
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, hr, -Math.PI / 2, -Math.PI / 2 + TAU * Math.min(1, view.prog));
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(200,205,240,0.7)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (fin) {
        const a = Math.min(1, finT * 6) * (finT > 0.85 ? Math.max(0, (1 - finT) / 0.15) : 1);
        ctx.fillStyle = `rgba(235,238,255,${a})`;
        ctx.font = `600 ${Math.round(hr * 0.42)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.fillText('Runde geschafft', W / 2, H / 2);
      } else {
        ctx.font = `500 ${Math.round(hr * 0.3)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.fillText(`Runde ${view.round > 0 ? view.round : 1}`, W / 2, H / 2);
      }
    }

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

    $('gear').addEventListener('click', () => {
      $('roomInput').value = room;
      $('sndBtn').textContent = soundOn ? 'Ton: an' : 'Ton: aus';
      $('restartBtn').hidden = isHost !== true;
      $('dlg').showModal();
    });
    $('dlgClose').addEventListener('click', () => $('dlg').close());
    $('copyBtn').addEventListener('click', copyLink);
    $('sndBtn').addEventListener('click', () => {
      soundOn = !soundOn;
      LK.store.set('lk_board_snd', soundOn ? '1' : '0');
      if (soundOn) LK.audio.init();
      $('sndBtn').textContent = soundOn ? 'Ton: an' : 'Ton: aus';
    });
    $('fsBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    });
    $('restartBtn').addEventListener('click', () => {
      if (isHost !== true) return;
      clearTimeout(finTimer);
      st.finale = false;
      st.round++;
      st.chain = 0;
      st.goal = Math.max(8, aliveIds().length * 3);
      st.prev = null;
      st.holder = null;
      setHolder(pickNext());
      publish();
      $('dlg').close();
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
