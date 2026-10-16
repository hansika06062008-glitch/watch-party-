'use strict';
/**
 * Watch Party server
 * Express serves the frontend, Socket.IO carries all real-time events.
 * The server is the single source of truth for playback state, so concurrent
 * actions are serialized here and every client converges to the same state.
 */
const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = 50;              // requirement says >= 10; we allow 50
const HOST_GRACE_MS = 15000;         // host can reconnect within this window and stay host
const EMPTY_ROOM_TTL_MS = 10 * 60 * 1000;
const CHAT_LIMIT = 200;
const CONFLICT_WINDOW_MS = 300;      // two different users acting within 300 ms = conflict
const SNACKS = new Set(['popcorn', 'pizza', 'fries', 'samosa', 'soda', 'chai', 'donut', 'icecream', 'candy', 'nachos']);
const REACTIONS = new Set(['😂', '😱', '😍', '🔥', '👏', '😭', '🎉', '💀']);
const COLORS = ['#FF3E9A', '#FFD23F', '#3DDCFF', '#9DFF6B', '#FF8A3D', '#C08BFF', '#FF6B6B', '#5CFFC8', '#FFB3E6', '#7DA8FF'];

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingInterval: 5000, pingTimeout: 8000, cors: { origin: '*' } });
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));
app.get('/r/:code', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));
app.get('/api/metrics/:code', (req, res) => {
  const room = rooms.get(String(req.params.code).toUpperCase());
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room: room.code, propagationMs: stats(room.latency) });
});

/* ---------- helpers ---------- */
const now = () => Date.now();
const uid = () => crypto.randomBytes(6).toString('hex');
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, n);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function makeCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do c = Array.from({ length: 6 }, () => A[crypto.randomInt(A.length)]).join('');
  while (rooms.has(c));
  return c;
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
function pwOk(room, pw) {
  if (!room.pwHash) return true;
  const a = Buffer.from(hashPw(String(pw || ''), room.salt), 'hex');
  return crypto.timingSafeEqual(a, Buffer.from(room.pwHash, 'hex'));
}
function stats(arr) {
  if (!arr.length) return { count: 0 };
  const s = [...arr].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { count: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
}
const position = (pb, t = now()) => (pb.playing ? pb.pos + ((t - pb.at) / 1000) * pb.rate : pb.pos);
function validUrl(u) {
  try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; }
}
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/;
function detectKind(url) {
  if (YT_RE.test(url)) return 'youtube';
  if (/\.m3u8(\?|$)/i.test(url)) return 'hls';
  return 'file';
}
function titleFromUrl(url) {
  if (YT_RE.test(url)) return 'YouTube video';
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').pop() || '');
    return clean(last.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' '), 80) || 'Video';
  } catch { return 'Video'; }
}
function limited(socket, key, max, winMs) {
  const b = (socket.data.rl ||= {});
  const arr = (b[key] ||= []);
  const t = now();
  while (arr.length && t - arr[0] > winMs) arr.shift();
  if (arr.length >= max) return true;
  arr.push(t);
  return false;
}

/* ---------- views & broadcasts ---------- */
const pbView = room => {
  const { src, kind, title, pos, playing, rate, at, seq, by, byName, action, originTs } = room.playback;
  return { src, kind, title, pos, playing, rate, at, seq, by, byName, action, originTs };
};
const memberList = room => [...room.members.values()]
  .sort((a, b) => a.joinedAt - b.joinedAt)
  .map(m => ({ id: m.id, name: m.name, color: m.color, online: m.online, isHost: m.id === room.hostId, snacks: m.snacks, munching: m.munching || null }));
function pollView(p) {
  const counts = p.options.map(() => 0);
  Object.values(p.voters).forEach(i => counts[i]++);
  return { id: p.id, question: p.question, options: p.options.map((text, i) => ({ text, votes: counts[i] })), voters: p.voters, byId: p.byId, byName: p.byName, closed: p.closed, total: Object.keys(p.voters).length };
}
const snapshot = room => ({
  code: room.code, name: room.name, hasPassword: !!room.pwHash, hostId: room.hostId, controlMode: room.controlMode,
  members: memberList(room), playback: pbView(room), playlist: room.playlist, chat: room.chat.slice(-60),
  polls: room.polls.map(pollView), snackBreak: room.snackBreak,
});
const emitRoom = (room, ev, data) => io.to(room.code).emit(ev, data);
const emitMembers = room => emitRoom(room, 'members', { members: memberList(room), hostId: room.hostId, controlMode: room.controlMode });
const emitPolls = room => emitRoom(room, 'polls', room.polls.map(pollView));
function pushChat(room, msg) {
  room.chat.push(msg);
  if (room.chat.length > CHAT_LIMIT) room.chat.splice(0, room.chat.length - CHAT_LIMIT);
  emitRoom(room, 'chat', msg);
}
const systemMsg = (room, text) => pushChat(room, { id: uid(), system: true, text, ts: now() });
const canControl = (room, id) => room.controlMode === 'all' || room.hostId === id;

/** Commit a playback change: new sequence number + broadcast. */
function bump(room, m, action, originTs) {
  const pb = room.playback, t = now();
  Object.assign(pb, { at: t, seq: pb.seq + 1, by: m ? m.id : null, byName: m ? m.name : 'Party', action, changedAt: t, originTs: originTs || t });
  emitRoom(room, 'playback', pbView(room));
}
function setVideo(room, item, m) {
  Object.assign(room.playback, { src: item.url, kind: detectKind(item.url), title: item.title || titleFromUrl(item.url), pos: 0, playing: false, rate: 1 });
  bump(room, m, 'load');
  systemMsg(room, `🎬 ${m ? m.name : 'Playlist'} put on "${room.playback.title}". Press play when everyone is ready.`);
}
function endBreak(room, resume) {
  clearTimeout(room.breakTimer);
  room.breakTimer = null;
  if (!room.snackBreak) return;
  room.snackBreak = null;
  emitRoom(room, 'snackbreak', null);
  if (resume && room.playback.src) { room.playback.playing = true; bump(room, null, 'play'); }
  systemMsg(room, '🍿 Snack break is over. Back to the movie!');
}
const oldestOnline = room => [...room.members.values()].filter(x => x.online).sort((a, b) => a.joinedAt - b.joinedAt)[0];

function attach(socket, room, cid, name, existing) {
  const m = existing || { id: cid, color: COLORS[room.members.size % COLORS.length], snacks: 0, joinedAt: now(), token: uid() + uid() };
  const wasOnline = existing && existing.online;
  m.name = name;
  m.online = true;
  m.socketId = socket.id;
  room.members.set(cid, m);
  socket.join(room.code);
  socket.data.code = room.code;
  socket.data.cid = cid;
  if (room.emptyTimer) { clearTimeout(room.emptyTimer); room.emptyTimer = null; }
  if (room.hostId === cid && room.hostTimer) { clearTimeout(room.hostTimer); room.hostTimer = null; }
  if (!room.hostId || (!room.members.get(room.hostId)?.online && !room.hostTimer)) room.hostId = cid;
  if (!wasOnline) systemMsg(room, existing ? `${name} reconnected` : `🎉 ${name} joined the party`);
  emitMembers(room);
  return m;
}
function departed(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return;
  const m = room.members.get(socket.data.cid);
  socket.leave(room.code);
  socket.data.code = null;
  if (!m || m.socketId !== socket.id) return;   // an older tab of the same user closed
  m.online = false;
  systemMsg(room, `${m.name} left`);
  if (room.hostId === m.id) {
    clearTimeout(room.hostTimer);
    room.hostTimer = setTimeout(() => {
      room.hostTimer = null;
      if (room.members.get(room.hostId)?.online) return;
      const next = oldestOnline(room);
      if (next) { room.hostId = next.id; systemMsg(room, `👑 ${next.name} is now the host`); emitMembers(room); }
    }, HOST_GRACE_MS);
  }
  emitMembers(room);
  if (![...room.members.values()].some(x => x.online)) {
    room.emptyTimer = setTimeout(() => {
      clearTimeout(room.hostTimer); clearTimeout(room.breakTimer);
      rooms.delete(room.code);
    }, EMPTY_ROOM_TTL_MS);
  }
}

/* ---------- socket events ---------- */
io.on('connection', socket => {
  const ctx = () => {
    const room = rooms.get(socket.data.code);
    const m = room && room.members.get(socket.data.cid);
    return room && m ? { room, m } : null;
  };
  const on = (ev, fn) => socket.on(ev, (data, cb) => {
    const reply = typeof cb === 'function' ? cb : () => {};
    try { fn(data && typeof data === 'object' ? data : {}, reply); }
    catch (err) { console.error(ev, err); reply({ error: 'Something went wrong on the server.' }); }
  });
  const inRoom = (fn) => (data, cb) => { const c = ctx(); if (!c) return cb({ error: 'You are not in a room. Rejoin with the room code.' }); fn(data, cb, c.room, c.m); };

  socket.on('time:ping', (_d, cb) => typeof cb === 'function' && cb(now()));

  on('room:info', ({ code }, cb) => {
    const room = rooms.get(clean(code, 6).toUpperCase());
    if (!room) return cb({ exists: false });
    cb({ exists: true, name: room.name, hasPassword: !!room.pwHash, online: [...room.members.values()].filter(x => x.online).length });
  });

  on('room:create', ({ roomName, name, password, controlMode, clientId }, cb) => {
    const pw = String(password || '');
    if (pw && pw.length < 4) return cb({ error: 'Use at least 4 characters for the password, or leave it empty.' });
    if (limited(socket, 'create', 5, 60000)) return cb({ error: 'Too many rooms created. Wait a minute and try again.' });
    const userName = clean(name, 24) || 'Host';
    const code = makeCode(), salt = uid();
    const room = {
      code, name: clean(roomName, 40) || `${userName}'s party`, salt, pwHash: pw ? hashPw(pw, salt) : null,
      controlMode: controlMode === 'all' ? 'all' : 'host', hostId: null, members: new Map(),
      playback: { src: null, kind: null, title: '', pos: 0, playing: false, rate: 1, at: now(), seq: 0, changedAt: 0 },
      playlist: [], chat: [], polls: [], snackBreak: null, latency: [], createdAt: now(),
    };
    rooms.set(code, room);
    const cid = /^[\w-]{1,40}$/.test(clientId) ? clientId : uid();
    const m = attach(socket, room, cid, userName, null);
    room.hostId = cid;
    emitMembers(room);
    cb({ ok: true, token: m.token, room: snapshot(room) });
  });

  on('room:join', ({ code, name, password, clientId, token }, cb) => {
    const room = rooms.get(clean(code, 6).toUpperCase());
    if (!room) return cb({ error: 'No room with that code. Check the code or start a new party.' });
    const cid = /^[\w-]{1,40}$/.test(clientId) ? clientId : uid();
    const existing = room.members.get(cid);
    const tokenOk = !!(existing && token && existing.token === token);
    if (!tokenOk) {
      if (socket.data.lockUntil > now()) return cb({ error: 'Too many wrong passwords. Wait 30 seconds.', needPassword: true });
      if (!pwOk(room, password)) {
        socket.data.fails = (socket.data.fails || 0) + 1;
        if (socket.data.fails >= 5) { socket.data.lockUntil = now() + 30000; socket.data.fails = 0; }
        return cb({ needPassword: true, error: password ? 'Wrong password. Ask the host for it.' : 'This room is locked. Enter the password.' });
      }
    }
    const online = [...room.members.values()].filter(x => x.online).length;
    if (!(existing && existing.online) && online >= MAX_MEMBERS) return cb({ error: `This room is full (${MAX_MEMBERS} people).` });
    const m = attach(socket, room, cid, clean(name, 24) || existing?.name || 'Guest', existing);
    cb({ ok: true, token: m.token, room: snapshot(room) });   // full snapshot = late join support
  });

  on('room:leave', (_d, cb) => { departed(socket); cb({ ok: true }); });
  socket.on('disconnect', () => departed(socket));

  on('room:settings', inRoom(({ controlMode }, cb, room, m) => {
    if (room.hostId !== m.id) return cb({ error: 'Only the host can change room settings.' });
    room.controlMode = controlMode === 'all' ? 'all' : 'host';
    emitMembers(room);
    systemMsg(room, room.controlMode === 'all' ? 'Everyone can now control playback' : 'Only the host controls playback now');
    cb({ ok: true });
  }));

  on('host:transfer', inRoom(({ to }, cb, room, m) => {
    if (room.hostId !== m.id) return cb({ error: 'Only the host can hand over the crown.' });
    const target = room.members.get(to);
    if (!target || !target.online) return cb({ error: 'That person is not online.' });
    room.hostId = target.id;
    emitMembers(room);
    systemMsg(room, `👑 ${m.name} made ${target.name} the host`);
    cb({ ok: true });
  }));

  /* playback */
  on('control', inRoom((msg, cb, room, m) => {
    if (!canControl(room, m.id)) return cb({ error: 'Only the host controls playback in this room.' });
    const pb = room.playback, t = now();
    if (!pb.src) return cb({ error: 'Load a video first.' });
    // Concurrency: if someone else changed state in the last 300 ms and this client
    // had not seen that change yet, reject so everyone converges on one action.
    if (typeof msg.seq === 'number' && msg.seq < pb.seq && pb.by !== m.id && t - pb.changedAt < CONFLICT_WINDOW_MS) {
      return cb({ conflict: true, playback: pbView(room) });
    }
    const cur = position(pb, t);
    switch (msg.action) {
      case 'play': pb.pos = cur; pb.playing = true; if (room.snackBreak) endBreak(room, false); break;
      case 'pause': { const p = num(msg.pos, cur); pb.pos = Math.abs(p - cur) < 2 ? p : cur; pb.playing = false; break; }
      case 'seek': pb.pos = Math.max(0, num(msg.pos, cur)); break;
      case 'rate': pb.pos = cur; pb.rate = clamp(num(msg.rate, 1), 0.25, 2); break;
      default: return cb({ error: 'Unknown action.' });
    }
    bump(room, m, msg.action, num(msg.originTs, t));
    cb({ ok: true, seq: pb.seq });
  }));

  on('video:load', inRoom(({ url, title }, cb, room, m) => {
    if (!canControl(room, m.id)) return cb({ error: 'Only the host can change the video. Add it to the playlist instead.' });
    url = clean(url, 2000);
    if (!validUrl(url)) return cb({ error: 'That is not a valid link. It should start with http:// or https://' });
    setVideo(room, { url, title: clean(title, 80) }, m);
    cb({ ok: true });
  }));

  on('video:ended', inRoom(({ src }, cb, room, m) => {
    const pb = room.playback;
    if (!canControl(room, m.id) || src !== pb.src || !pb.playing) return cb({ ok: false });
    const next = room.playlist.shift();
    if (next) { emitRoom(room, 'playlist', room.playlist); setVideo(room, next, null); }
    else { pb.pos = position(pb); pb.playing = false; bump(room, null, 'pause'); }
    cb({ ok: true });
  }));

  /* playlist */
  on('playlist:add', inRoom(({ url, title }, cb, room, m) => {
    url = clean(url, 2000);
    if (!validUrl(url)) return cb({ error: 'That is not a valid link. It should start with http:// or https://' });
    if (room.playlist.length >= 50) return cb({ error: 'The playlist is full (50 videos).' });
    if (limited(socket, 'pl', 5, 5000)) return cb({ error: 'Slow down a little.' });
    const item = { id: uid(), url, kind: detectKind(url), title: clean(title, 80) || titleFromUrl(url), byId: m.id, byName: m.name };
    room.playlist.push(item);
    emitRoom(room, 'playlist', room.playlist);
    systemMsg(room, `➕ ${m.name} added "${item.title}" to the playlist`);
    cb({ ok: true });
  }));
  on('playlist:remove', inRoom(({ id }, cb, room, m) => {
    const i = room.playlist.findIndex(x => x.id === id);
    if (i < 0) return cb({ error: 'That video is no longer in the playlist.' });
    if (room.playlist[i].byId !== m.id && !canControl(room, m.id)) return cb({ error: 'You can only remove videos you added.' });
    room.playlist.splice(i, 1);
    emitRoom(room, 'playlist', room.playlist);
    cb({ ok: true });
  }));
  on('playlist:move', inRoom(({ id, dir }, cb, room, m) => {
    if (!canControl(room, m.id)) return cb({ error: 'Only the host can reorder the playlist.' });
    const i = room.playlist.findIndex(x => x.id === id), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= room.playlist.length) return cb({ ok: false });
    [room.playlist[i], room.playlist[j]] = [room.playlist[j], room.playlist[i]];
    emitRoom(room, 'playlist', room.playlist);
    cb({ ok: true });
  }));
  on('playlist:play', inRoom(({ id }, cb, room, m) => {
    if (!canControl(room, m.id)) return cb({ error: 'Only the host can start a video.' });
    const i = room.playlist.findIndex(x => x.id === id);
    if (i < 0) return cb({ error: 'That video is no longer in the playlist.' });
    const [item] = room.playlist.splice(i, 1);
    emitRoom(room, 'playlist', room.playlist);
    setVideo(room, item, m);
    cb({ ok: true });
  }));

  /* chat & reactions */
  on('chat:send', inRoom(({ text }, cb, room, m) => {
    text = clean(text, 500);
    if (!text) return cb({ ok: false });
    if (limited(socket, 'chat', 6, 4000)) return cb({ error: 'You are sending messages too fast.' });
    pushChat(room, { id: uid(), from: m.id, name: m.name, color: m.color, text, ts: now() });
    cb({ ok: true });
  }));
  on('react', inRoom(({ emoji }, cb, room, m) => {
    if (!REACTIONS.has(emoji) || limited(socket, 'react', 12, 3000)) return cb({ ok: false });
    emitRoom(room, 'reaction', { emoji, name: m.name, color: m.color });
    cb({ ok: true });
  }));

  /* snacks */
  on('snack:send', inRoom(({ snack, to }, cb, room, m) => {
    if (!SNACKS.has(snack)) return cb({ error: 'That snack is not on the menu.' });
    if (limited(socket, 'snack', 4, 3000)) return cb({ error: 'Easy there! Wait a second before passing more snacks.' });
    let target = null;
    if (to && to !== 'all') {
      target = room.members.get(to);
      if (!target || !target.online) return cb({ error: 'That person is not in the room right now.' });
      target.munching = snack;
    } else {
      room.members.forEach(x => { if (x.online && x.id !== m.id) x.munching = snack; });
    }
    m.snacks = (m.snacks || 0) + 1;
    emitRoom(room, 'snack', { snack, from: m.id, fromName: m.name, fromColor: m.color, to: target ? target.id : 'all', toName: target ? target.name : 'everyone' });
    emitMembers(room);
    cb({ ok: true });
  }));
  on('snack:break', inRoom(({ minutes }, cb, room, m) => {
    if (!canControl(room, m.id)) return cb({ error: 'Only the host can call a snack break.' });
    const mins = clamp(Math.round(num(minutes, 2)), 1, 10);
    const pb = room.playback;
    if (pb.src && pb.playing) { pb.pos = position(pb); pb.playing = false; bump(room, m, 'pause'); }
    room.snackBreak = { until: now() + mins * 60000, byName: m.name, minutes: mins };
    clearTimeout(room.breakTimer);
    room.breakTimer = setTimeout(() => endBreak(room, true), mins * 60000);
    emitRoom(room, 'snackbreak', room.snackBreak);
    systemMsg(room, `🍿 ${m.name} called a ${mins}-minute snack break`);
    cb({ ok: true });
  }));
  on('snack:break:end', inRoom((_d, cb, room, m) => {
    if (!canControl(room, m.id)) return cb({ error: 'Only the host can end the snack break.' });
    endBreak(room, true);
    cb({ ok: true });
  }));

  /* polls */
  on('poll:create', inRoom(({ question, options }, cb, room, m) => {
    const q = clean(question, 120);
    const opts = [...new Set((Array.isArray(options) ? options : []).map(o => clean(o, 80)).filter(Boolean))];
    if (!q) return cb({ error: 'Write a question for the poll.' });
    if (opts.length < 2 || opts.length > 6) return cb({ error: 'Add between 2 and 6 different options.' });
    if (limited(socket, 'poll', 3, 20000)) return cb({ error: 'Wait a bit before starting another poll.' });
    room.polls.unshift({ id: uid(), question: q, options: opts, voters: {}, byId: m.id, byName: m.name, closed: false });
    room.polls = room.polls.slice(0, 10);
    emitPolls(room);
    systemMsg(room, `📊 ${m.name} started a poll: ${q}`);
    cb({ ok: true });
  }));
  on('poll:vote', inRoom(({ pollId, idx }, cb, room, m) => {
    const p = room.polls.find(x => x.id === pollId);
    if (!p || p.closed) return cb({ error: 'This poll is closed.' });
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.options.length) return cb({ ok: false });
    if (p.voters[m.id] === idx) delete p.voters[m.id]; else p.voters[m.id] = idx;
    emitPolls(room);
    cb({ ok: true });
  }));
  on('poll:close', inRoom(({ pollId }, cb, room, m) => {
    const p = room.polls.find(x => x.id === pollId);
    if (!p) return cb({ ok: false });
    if (p.byId !== m.id && room.hostId !== m.id) return cb({ error: 'Only the poll creator or host can close it.' });
    p.closed = true;
    const v = pollView(p), top = Math.max(...v.options.map(o => o.votes));
    const winners = v.options.filter(o => o.votes === top && top > 0).map(o => o.text);
    emitPolls(room);
    systemMsg(room, winners.length ? `📊 Poll closed: "${winners.join('" and "')}" won` : '📊 Poll closed with no votes');
    cb({ ok: true });
  }));

  /* latency metrics reported by clients */
  on('metrics:report', inRoom(({ samples }, cb, room) => {
    if (Array.isArray(samples)) {
      samples.slice(0, 100).forEach(s => { if (typeof s === 'number' && s >= 0 && s < 10000) room.latency.push(Math.round(s)); });
      if (room.latency.length > 5000) room.latency.splice(0, room.latency.length - 5000);
    }
    cb({ ok: true });
  }));
});

server.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  const lan = Object.values(nets).flat().find(n => n && n.family === 'IPv4' && !n.internal);
  console.log(`🎉 Watch Party running at http://localhost:${PORT}`);
  if (lan) console.log(`   Other devices on your Wi-Fi: http://${lan.address}:${PORT}`);
});
