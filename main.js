'use strict';

// Einstieg: je nach Link wird die Tafel, die Spieler-Ansicht oder die Startseite geöffnet.
//   ?tafel=1[&r=CODE]   Tafel (Beamer). Der Raumcode wird auf diesem Gerät gemerkt.
//   ?r=CODE             Spieler. Das ist der Link, der per Mail ans GridPad geht.
//   &b=1                (optional) zweiten MQTT-Server zuerst probieren
//   &id=abc123          (optional, zum Testen) feste Gerätekennung
(function (LK) {
  const q = new URLSearchParams(location.search);
  let room = (q.get('r') || '').toLowerCase();
  if (!LK.validRoom(room)) room = '';
  const startBroker = parseInt(q.get('b') || '0', 10) || 0;
  const base = location.href.split('?')[0].split('#')[0];

  if (q.has('tafel')) {
    if (!room) {
      room = LK.store.get('lk_board_room', '');
      if (!LK.validRoom(room)) room = LK.rid(10);
    }
    LK.store.set('lk_board_room', room);
    history.replaceState(null, '', `${base}?tafel=1&r=${room}`);
    LK.startBoard(room, startBroker);
    return;
  }

  if (room) {
    LK.startPlayer(room, startBroker, q.get('id'));
    return;
  }

  document.getElementById('scr-home').hidden = false;
  document.getElementById('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = document.getElementById('joinCode').value.trim().toLowerCase();
    if (!LK.validRoom(v)) { document.getElementById('joinErr').hidden = false; return; }
    location.href = `${base}?r=${v}`;
  });
})(window.LK);
