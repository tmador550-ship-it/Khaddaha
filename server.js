// خدّعها - خادم بدون أي مكتبات خارجية. شغّله بـ: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const ROUNDS = 5;

const BANK = require('./questions.js');

const rooms = new Map();
const norm = s => s.replace(/[\u064B-\u0652ـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/^ال/, '').replace(/\s+/g, ' ').trim().toLowerCase();
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const uid = () => crypto.randomBytes(8).toString('hex');

function newCode() { let c; do { c = String(1000 + Math.floor(Math.random() * 9000)); } while (rooms.has(c)); return c; }
function addPlayer(room, name) {
  const id = uid();
  room.players[id] = { id, name: name.slice(0, 14), score: 0, ans: null, vote: null, res: null, on: false };
  return id;
}
const active = room => Object.values(room.players).filter(p => p.on || room.ph === 'lobby');

function viewFor(room, id) {
  const me = room.players[id], list = Object.values(room.players);
  const v = {
    ph: room.ph, code: room.code, r: room.r, total: ROUNDS, isHost: room.host === id,
    players: list.map(p => ({ name: p.name, score: p.score, done: room.ph === 'write' ? p.ans !== null : room.ph === 'vote' ? p.vote !== null : false, me: p.id === id })),
  };
  if (room.ph !== 'lobby' && room.ph !== 'end') v.q = BANK[room.qs[room.r]][0];
  if (room.ph === 'write') v.mine = me.ans !== null;
  if (room.ph === 'vote') {
    v.mine = me.vote !== null;
    v.o = room.o.map((o, k) => ({ t: o.t, k })).filter((_, k) => room.o[k].by !== id);
  }
  if (room.ph === 'reveal') {
    v.o = room.o.map((o, k) => ({
      t: o.t, truth: o.by === 'T', author: o.by === 'T' ? null : room.players[o.by]?.name,
      voters: list.filter(p => p.vote === k).map(p => p.name),
    }));
  }
  return v;
}
function broadcast(room) {
  room.touched = Date.now();
  for (const p of Object.values(room.players)) if (p.res) p.res.write('data: ' + JSON.stringify(viewFor(room, p.id)) + '\n\n');
}

function toVote(room) {
  const o = [];
  for (const p of Object.values(room.players)) if (p.ans) o.push({ t: p.ans, by: p.id });
  o.push({ t: BANK[room.qs[room.r]][1], by: 'T' });
  room.o = shuffle(o); room.ph = 'vote';
  for (const p of Object.values(room.players)) p.vote = null;
}
function toReveal(room) {
  for (const p of Object.values(room.players)) {
    if (p.vote === null || !room.o[p.vote]) continue;
    const o = room.o[p.vote];
    if (o.by === 'T') p.score += 2; else if (room.players[o.by]) room.players[o.by].score += 1;
  }
  room.ph = 'reveal';
}
function checkAdvance(room) {
  const ps = active(room);
  if (room.ph === 'write' && ps.every(p => p.ans !== null || !p.on) && ps.some(p => p.ans)) toVote(room);
  else if (room.ph === 'vote' && ps.every(p => p.vote !== null || !p.on)) toReveal(room);
}

function act(room, id, b) {
  const me = room.players[id], host = room.host === id;
  switch (b.type) {
    case 'start':
      if (!host || room.ph !== 'lobby' || Object.keys(room.players).length < 2) return 'لا يمكن البدء';
      room.qs = shuffle(BANK.map((_, i) => i)).slice(0, ROUNDS); room.r = 0; room.ph = 'write';
      for (const p of Object.values(room.players)) { p.score = 0; p.ans = null; p.vote = null; }
      break;
    case 'answer': {
      if (room.ph !== 'write' || me.ans !== null) return 'غير متاح';
      const t = String(b.text || '').trim().slice(0, 30);
      if (!t) return 'اكتب إجابة أولًا.';
      if (norm(t) === norm(BANK[room.qs[room.r]][1])) return 'هذه هي الحقيقة! جرّب كذبة غيرها.';
      if (Object.values(room.players).some(p => p.ans && norm(p.ans) === norm(t))) return 'سبقك أحد بنفس الكذبة، غيّرها.';
      me.ans = t; checkAdvance(room); break;
    }
    case 'vote': {
      const k = Number(b.k);
      if (room.ph !== 'vote' || me.vote !== null || !room.o[k] || room.o[k].by === id) return 'غير متاح';
      me.vote = k; checkAdvance(room); break;
    }
    case 'skip':
      if (!host) return 'للمضيف فقط';
      if (room.ph === 'write' && Object.values(room.players).some(p => p.ans)) toVote(room);
      else if (room.ph === 'vote') toReveal(room);
      break;
    case 'next':
      if (!host || room.ph !== 'reveal') return 'غير متاح';
      room.r++;
      if (room.r >= ROUNDS) { room.r = ROUNDS - 1; room.ph = 'end'; }
      else { room.ph = 'write'; for (const p of Object.values(room.players)) { p.ans = null; p.vote = null; } }
      break;
    case 'again':
      if (!host || room.ph !== 'end') return 'غير متاح';
      room.ph = 'lobby'; room.r = 0;
      for (const p of Object.values(room.players)) { p.ans = null; p.vote = null; }
      break;
    default: return 'طلب غير معروف';
  }
  return null;
}

function body(req) {
  return new Promise(res => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 5000) req.destroy(); });
    req.on('end', () => { try { res(JSON.parse(d || '{}')); } catch { res({}); } });
  });
}
const json = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/api/events') {
    const room = rooms.get(url.searchParams.get('code')), id = url.searchParams.get('id');
    if (!room || !room.players[id]) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const p = room.players[id]; p.res = res; p.on = true;
    const hb = setInterval(() => res.write(': hb\n\n'), 20000);
    broadcast(room);
    req.on('close', () => {
      clearInterval(hb); if (p.res === res) { p.res = null; p.on = false; }
      if (room.ph === 'lobby') {
        setTimeout(() => {
          if (!p.on && room.ph === 'lobby' && room.players[id]) {
            delete room.players[id];
            if (room.host === id) room.host = Object.keys(room.players)[0];
            if (!room.host) rooms.delete(room.code); else broadcast(room);
          }
        }, 8000);
      } else {
        if (room.host === id) { const n = Object.values(room.players).find(x => x.on); if (n) room.host = n.id; }
        checkAdvance(room); broadcast(room);
      }
    });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const b = await body(req);
    if (url.pathname === '/api/create') {
      const name = String(b.name || '').trim(); if (!name) return json(res, 400, { error: 'اكتب اسمك أولًا.' });
      const room = { code: newCode(), ph: 'lobby', r: 0, players: {}, host: null, touched: Date.now() };
      const id = addPlayer(room, name); room.host = id; rooms.set(room.code, room);
      return json(res, 200, { code: room.code, id });
    }
    if (url.pathname === '/api/join') {
      const name = String(b.name || '').trim(), room = rooms.get(String(b.code || ''));
      if (!name) return json(res, 400, { error: 'اكتب اسمك أولًا.' });
      if (!room) return json(res, 404, { error: 'لا توجد غرفة بهذا الرمز.' });
      if (room.ph !== 'lobby') return json(res, 400, { error: 'اللعبة بدأت بالفعل، انتظر حتى تنتهي.' });
      if (Object.keys(room.players).length >= 8) return json(res, 400, { error: 'الغرفة ممتلئة (8 لاعبين).' });
      return json(res, 200, { code: room.code, id: addPlayer(room, name) });
    }
    if (url.pathname === '/api/act') {
      const room = rooms.get(String(b.code || ''));
      if (!room || !room.players[b.id]) return json(res, 404, { error: 'انتهت الجلسة.' });
      const err = act(room, b.id, b);
      if (err) return json(res, 400, { error: err });
      broadcast(room); return json(res, 200, {});
    }
    return json(res, 404, { error: 'not found' });
  }
  if (url.pathname !== '/' && url.pathname !== '/index.html') { res.writeHead(404); return res.end('Not found'); }
  const file = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(f => fs.existsSync(f)) || '';
  fs.readFile(file, (e, d) => {
    if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d);
  });
}).listen(PORT, () => console.log('خدّعها يعمل على المنفذ ' + PORT));

setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.touched > 2 * 3600e3) rooms.delete(c); }, 600e3);
