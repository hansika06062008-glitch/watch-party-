/**
 * Load + reliability test for Watch Party.
 * Start the server first (npm start), then run:  npm test
 * Options:  node test/load-test.js [serverUrl] [users] [actions]
 *
 * Checks: 10+ users in one room, password protection, play/pause/seek
 * propagation latency (p50/p95), concurrent actions, late join,
 * reconnection with token, and host transfer.
 */
const { io } = require('socket.io-client');

const URL = process.argv[2] || 'http://localhost:3000';
const USERS = Number(process.argv[3]) || 10;
const ACTIONS = Number(process.argv[4]) || 90;
const VIDEO = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const call = (s, ev, data) => new Promise(r => s.emit(ev, data, r));
const connect = () => new Promise((res, rej) => {
  const s = io(URL, { transports: ['websocket'], forceNew: true, reconnection: false });
  s.once('connect', () => res(s));
  s.once('connect_error', rej);
});
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

(async () => {
  console.log(`Testing ${URL} with ${USERS} users and ${ACTIONS} playback actions\n`);

  // 1. host creates a password-protected room
  const host = await connect();
  const created = await call(host, 'room:create', { roomName: 'Load test', name: 'Host', password: 'party123', clientId: 'host-bot' });
  const code = created.room.code;
  check('Room created', !!code, 'code ' + code);

  // 2. wrong / missing password is rejected
  const intruder = await connect();
  const noPw = await call(intruder, 'room:join', { code, name: 'Intruder', clientId: 'intruder' });
  const badPw = await call(intruder, 'room:join', { code, name: 'Intruder', password: 'nope', clientId: 'intruder' });
  check('Missing and wrong password rejected', !!(noPw.needPassword && badPw.error));
  intruder.close();

  // 3. other users join with the right password
  const bots = [];
  const tokens = {};
  for (let i = 1; i < USERS; i++) {
    const s = await connect();
    const r = await call(s, 'room:join', { code, name: 'Bot ' + i, password: 'party123', clientId: 'bot-' + i });
    if (r.error) throw new Error(r.error);
    tokens['bot-' + i] = r.token;
    s.last = null;
    s.on('playback', pb => { s.last = pb; });
    bots.push(s);
  }
  check(`${USERS} users in one room`, bots.length + 1 === USERS);

  // 4. latency: host sends actions, every bot measures click -> receive time
  await call(host, 'video:load', { url: VIDEO, title: 'Big Buck Bunny' });
  await sleep(300);
  const lat = [];
  bots.forEach(b => b.on('playback', pb => { if (pb.by === 'host-bot' && pb.action !== 'load') lat.push(Date.now() - pb.originTs); }));
  const acts = ['play', 'seek', 'pause'];
  for (let i = 0; i < ACTIONS; i++) {
    await call(host, 'control', { action: acts[i % 3], pos: i * 2, seq: 1e9, originTs: Date.now() });
    await sleep(60);
  }
  await sleep(500);
  const p50 = pct(lat, 0.5), p95 = pct(lat, 0.95), max = Math.max(...lat);
  check('Playback propagation p95 <= 250 ms', p95 <= 250, `${lat.length} samples, p50 ${p50} ms, p95 ${p95} ms, max ${max} ms`);

  // 5. everyone converged on the same state
  const seqs = new Set(bots.map(b => b.last && b.last.seq));
  check('All clients have the same state', seqs.size === 1, 'seq ' + [...seqs].join(','));

  // 6. concurrent actions: 5 users seek at the same instant
  await call(host, 'room:settings', { controlMode: 'all' });
  const base = bots[0].last.seq;
  const replies = await Promise.all(bots.slice(0, 5).map((b, i) => call(b, 'control', { action: 'seek', pos: 100 + i * 10, seq: base, originTs: Date.now() })));
  await sleep(400);
  const accepted = replies.filter(r => r.ok).length, conflicts = replies.filter(r => r.conflict).length;
  const finalPos = new Set(bots.map(b => b.last.pos));
  check('Concurrent seeks resolve to one winner', accepted === 1 && finalPos.size === 1, `${accepted} accepted, ${conflicts} rejected as conflicts, everyone at ${[...finalPos][0]}s`);

  // 7. late joiner gets the current state immediately
  const late = await connect();
  const lj = await call(late, 'room:join', { code, name: 'Late', password: 'party123', clientId: 'late-bot' });
  check('Late joiner receives current state', lj.room.playback.seq === bots[0].last.seq && lj.room.playback.src === VIDEO);

  // 8. reconnect with token (no password needed), keeps identity
  bots[0].close();
  await sleep(200);
  const again = await connect();
  const rj = await call(again, 'room:join', { code, name: 'Bot 1', clientId: 'bot-1', token: tokens['bot-1'] });
  check('Reconnect with session token', !!rj.ok && rj.room.members.some(m => m.id === 'bot-1' && m.online));

  // 9. host transfer
  const t = await call(host, 'host:transfer', { to: 'bot-2' });
  const after = await new Promise(r => late.once('members', r));
  check('Host transfer', !!t.ok && after.hostId === 'bot-2');

  // 10. room-wide metrics endpoint
  const res = await fetch(`${URL}/api/metrics/${code}`).then(r => r.json()).catch(() => null);
  check('Metrics endpoint responds', !!res && res.room === code);

  [host, again, late, ...bots.slice(1)].forEach(s => s.close());
  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch(err => { console.error('Test crashed:', err.message, '\nIs the server running? Start it with: npm start'); process.exit(1); });
