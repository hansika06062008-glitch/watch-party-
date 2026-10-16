(() => {
'use strict';

/* ================= helpers ================= */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = t => {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
};
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const SNACKS = [['popcorn', '🍿', 'Popcorn'], ['pizza', '🍕', 'Pizza'], ['fries', '🍟', 'Fries'], ['samosa', '🥟', 'Samosa'], ['soda', '🥤', 'Soda'],
  ['chai', '☕', 'Chai'], ['donut', '🍩', 'Donut'], ['icecream', '🍦', 'Ice cream'], ['candy', '🍬', 'Candy'], ['nachos', '🌮', 'Nachos']];
const snackEmoji = k => (SNACKS.find(s => s[0] === k) || [, ''])[1];
const REACTIONS = ['😂', '😱', '😍', '🔥', '👏', '😭', '🎉', '💀'];
const GENRE_ICON = { Animation: '🎨', Comedy: '😂', Drama: '🎭', 'Sci-Fi': '🚀', Action: '💥', Thriller: '🔪', Horror: '👻', Romance: '💘', Fantasy: '🐉',
  Adventure: '🧭', Mystery: '🕵️', Musical: '🎵', Music: '🎸', Family: '🧸', Sports: '🏆', Short: '⚡', Cars: '🏎️', History: '📜', Crime: '🚨', Documentary: '🎥' };

const cid = localStorage.getItem('wp:cid') || ('c' + Math.random().toString(36).slice(2) + Date.now().toString(36));
localStorage.setItem('wp:cid', cid);

const S = {
  code: null, myName: '', offset: 0, rtt: 0, lastSeq: -1, playback: null, members: [], hostId: null,
  controlMode: 'host', playlist: [], polls: [], snackBreak: null, samples: [], pending: [], drift: 0,
  unlocked: false, seeking: false, tab: 'chat', unread: 0, watched: [],
};

let toastT;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('show'), 3400);
}
const ack = (err, res) => { if (err) toast('The server did not answer. Check your connection.'); else if (res && res.error) toast(res.error); };

/* ================= socket & clock sync ================= */
const socket = io({ reconnectionDelayMax: 3000 });
const emit = (ev, data, cb = ack) => socket.timeout(5000).emit(ev, data, cb);

// NTP-style clock offset: keep the sample with the lowest round trip.
const clockSamples = [];
function pingOnce() {
  return new Promise(res => {
    const t0 = performance.now(), w0 = Date.now();
    socket.timeout(2000).emit('time:ping', null, (err, ts) => {
      if (err) return res(null);
      const rtt = performance.now() - t0;
      res({ rtt, off: ts - (w0 + rtt / 2) });
    });
  });
}
async function syncClock(n = 1) {
  for (let i = 0; i < n; i++) {
    const s = await pingOnce();
    if (s) { clockSamples.push(s); if (clockSamples.length > 12) clockSamples.shift(); }
  }
  if (!clockSamples.length) return;
  const best = clockSamples.reduce((a, b) => (a.rtt < b.rtt ? a : b));
  S.offset = best.off;
  S.rtt = clockSamples[clockSamples.length - 1].rtt;
}
const serverNow = () => Date.now() + S.offset;
setInterval(() => socket.connected && syncClock(1), 5000);

function setNet(on, text) {
  $('#netDot').classList.toggle('on', on);
  $('#netText').textContent = text || (on ? 'Connected' : 'Reconnecting…');
}

socket.on('connect', async () => {
  setNet(true);
  await syncClock(5);
  if (S.code) return rejoin();
  const code = pathCode();
  if (code && sessionStorage.getItem('wp:tok:' + code)) silentJoin(code);
  else if (code) peek(code);
});
socket.on('disconnect', () => setNet(false));

/* ================= landing ================= */
const pathCode = () => ((location.pathname.match(/^\/r\/([A-Za-z0-9]{6})$/) || [])[1] || '').toUpperCase();
$$('input[name=name]').forEach(i => (i.value = localStorage.getItem('wp:name') || ''));
if (pathCode()) $('#joinCode').value = pathCode();

function formError(form, msg) { $('.form-error', form).textContent = msg || ''; }
function busy(form, on) { $('button[type=submit]', form).disabled = on; }

$('#createForm').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target, f = new FormData(form);
  const name = f.get('name').trim();
  localStorage.setItem('wp:name', name);
  formError(form); busy(form, true);
  emit('room:create', { roomName: f.get('roomName'), name, password: f.get('password'), controlMode: f.get('controlMode'), clientId: cid }, (err, res) => {
    busy(form, false);
    if (err) return formError(form, 'The server did not answer. Is it running?');
    if (res.error) return formError(form, res.error);
    S.myName = name;
    enterRoom(res, true);
  });
});

let peekT;
$('#joinCode').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  clearTimeout(peekT);
  $('#roomPeek').textContent = '';
  if (e.target.value.length === 6) peekT = setTimeout(() => peek(e.target.value), 200);
});
function peek(code) {
  emit('room:info', { code }, (err, res) => {
    if (err) return;
    if (!res.exists) { $('#roomPeek').textContent = 'No room with this code yet.'; $('#joinPwWrap').hidden = true; return; }
    $('#roomPeek').textContent = `"${res.name}" has ${res.online} ${res.online === 1 ? 'person' : 'people'} in it.`;
    $('#joinPwWrap').hidden = !res.hasPassword;
  });
}

$('#joinForm').addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target, f = new FormData(form);
  const name = f.get('name').trim(), code = String(f.get('code')).toUpperCase();
  localStorage.setItem('wp:name', name);
  formError(form); busy(form, true);
  emit('room:join', { code, name, password: f.get('password') || '', clientId: cid, token: sessionStorage.getItem('wp:tok:' + code) }, (err, res) => {
    busy(form, false);
    if (err) return formError(form, 'The server did not answer. Is it running?');
    if (res.needPassword) { $('#joinPwWrap').hidden = false; $('#joinPw').focus(); }
    if (res.error) return formError(form, res.error);
    S.myName = name;
    enterRoom(res, true);
  });
});

function silentJoin(code) {
  const name = localStorage.getItem('wp:name') || 'Guest';
  emit('room:join', { code, name, clientId: cid, token: sessionStorage.getItem('wp:tok:' + code) }, (err, res) => {
    if (err || res.error) { sessionStorage.removeItem('wp:tok:' + code); peek(code); return; }
    S.myName = name;
    enterRoom(res, false);
  });
}
function rejoin() {
  emit('room:join', { code: S.code, name: S.myName, clientId: cid, token: sessionStorage.getItem('wp:tok:' + S.code) }, (err, res) => {
    if (err) return;
    if (res.error) { toast('The room closed while you were away (the server may have restarted).'); return leaveRoom(); }
    enterRoom(res, false);
    toast('Reconnected and back in sync.');
  });
}

/* ================= entering & leaving ================= */
function enterRoom(res, celebrate) {
  const r = res.room;
  S.code = r.code;
  sessionStorage.setItem('wp:tok:' + r.code, res.token);
  if (location.pathname !== '/r/' + r.code) history.replaceState(null, '', '/r/' + r.code);
  $('#landing').hidden = true;
  $('#room').hidden = false;
  document.title = r.name + ' | Watch Party';
  $('#roomName').textContent = r.name;
  $('#roomCode').textContent = r.code;
  $('#lockBadge').hidden = !r.hasPassword;
  onMembers({ members: r.members, hostId: r.hostId, controlMode: r.controlMode });
  $('#chatList').replaceChildren();
  r.chat.forEach(addChat);
  S.playlist = r.playlist; renderPlaylist();
  S.polls = r.polls; renderPolls();
  onSnackBreak(r.snackBreak);
  S.lastSeq = -1;
  applyPlayback(r.playback);
  renderDiscover();
  if (celebrate) { S.unlocked = true; confetti(); }
}
function leaveRoom() {
  if (S.code) { socket.emit('room:leave'); sessionStorage.removeItem('wp:tok:' + S.code); }
  S.code = null; S.playback = null; curSrc = null;
  teardown();
  history.replaceState(null, '', '/');
  document.title = 'Watch Party';
  $('#room').hidden = true;
  $('#landing').hidden = false;
}
$('#leaveBtn').onclick = leaveRoom;
$('#copyLink').onclick = () => {
  navigator.clipboard?.writeText(location.origin + '/r/' + S.code);
  toast($('#lockBadge').hidden ? 'Invite link copied!' : 'Invite link copied! Share the password separately.');
};
$('#copyCode').onclick = () => { navigator.clipboard?.writeText(S.code); toast('Room code copied: ' + S.code); };

/* ================= player abstraction ================= */
const video = $('#video');
let hls = null, yt = null, ytReady = false, ytApi = null, kind = null, curSrc = null, lastRate = null;
const YT_RE = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/;

const P = {
  ready: () => (kind === 'youtube' ? ytReady : video.readyState >= 1),
  time: () => (kind === 'youtube' ? (ytReady ? yt.getCurrentTime() : 0) : video.currentTime),
  duration: () => (kind === 'youtube' ? (ytReady ? yt.getDuration() : 0) : (isFinite(video.duration) ? video.duration : 0)),
  playing: () => (kind === 'youtube' ? ytReady && [1, 3].includes(yt.getPlayerState()) : !video.paused),
  play() {
    if (kind === 'youtube') { if (ytReady) yt.playVideo(); return; }
    const p = video.play();
    if (p) p.catch(err => { if (err.name === 'NotAllowedError') { S.unlocked = false; $('#unlock').hidden = false; } });
  },
  pause: () => (kind === 'youtube' ? ytReady && yt.pauseVideo() : video.pause()),
  seek: t => (kind === 'youtube' ? ytReady && yt.seekTo(t, true) : (video.currentTime = t)),
  rate(r) {
    if (lastRate !== null && Math.abs(r - lastRate) < 0.001) return;
    lastRate = r;
    if (kind === 'youtube') { if (ytReady) yt.setPlaybackRate(r); } else video.playbackRate = r;
  },
};

function loadYT() {
  if (window.YT && window.YT.Player) return Promise.resolve();
  if (ytApi) return ytApi;
  ytApi = new Promise(res => {
    window.onYouTubeIframeAPIReady = res;
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(s);
  });
  return ytApi;
}
function teardown() {
  if (hls) { hls.destroy(); hls = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  if (yt) { try { yt.destroy(); } catch {} yt = null; ytReady = false; }
  $('#ytWrap').replaceChildren();
  lastRate = null;
}
async function loadSource(pb) {
  if (pb.src === curSrc) return;
  curSrc = pb.src;
  kind = pb.kind;
  teardown();
  $('#emptyScreen').hidden = !!pb.src;
  video.hidden = !pb.src || kind === 'youtube';
  if (!pb.src) return;
  if (kind === 'youtube') {
    await loadYT();
    if (curSrc !== pb.src) return;
    const host = document.createElement('div');
    $('#ytWrap').appendChild(host);
    yt = new YT.Player(host, {
      videoId: (pb.src.match(YT_RE) || [])[1],
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, modestbranding: 1, origin: location.origin },
      events: {
        onReady: () => { ytReady = true; applyVolume(); reconcile(true); },
        onStateChange: e => { if (e.data === 0) onEnded(); },
        onError: () => toast("This YouTube video can't be played inside other sites. Try a different link."),
      },
    });
  } else if (kind === 'hls' && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls && Hls.isSupported()) {
    hls = new Hls();
    hls.loadSource(pb.src);
    hls.attachMedia(video);
    hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && toast("This stream didn't load. Check the .m3u8 link."));
  } else {
    video.src = pb.src;
  }
}
video.addEventListener('loadedmetadata', () => reconcile(true));
video.addEventListener('ended', onEnded);
video.addEventListener('error', () => {
  if (curSrc && kind !== 'youtube' && video.error) toast("This link didn't play. Use a direct video link (.mp4, .webm, .m3u8) or a YouTube link.");
});
function onEnded() { if (canControl() && S.playback?.playing) emit('video:ended', { src: curSrc }, () => {}); }

/* ================= sync: apply state + drift correction ================= */
const expected = pb => (pb.playing ? pb.pos + ((serverNow() - pb.at) / 1000) * pb.rate : pb.pos);

socket.on('playback', applyPlayback);
function applyPlayback(pb) {
  if (!pb || pb.seq <= S.lastSeq) return;           // ignore late / out-of-order events
  S.lastSeq = pb.seq;
  S.playback = pb;
  // Propagation latency: time from the other person's click to us receiving it.
  if (pb.by && pb.by !== cid && pb.originTs && ['play', 'pause', 'seek'].includes(pb.action)) {
    const lat = serverNow() - pb.originTs;
    if (lat >= 0 && lat < 10000) { S.samples.push(lat); S.pending.push(Math.round(lat)); if (S.samples.length > 300) S.samples.shift(); }
  }
  if (pb.action === 'load' && pb.title && !S.watched.includes(pb.title)) S.watched.push(pb.title);
  loadSource(pb).then(() => reconcile(true));
  renderNowPlaying();
  if (pb.by && pb.by !== cid && ['play', 'pause', 'seek'].includes(pb.action)) {
    const verb = { play: 'pressed play', pause: 'paused', seek: 'jumped to ' + fmt(pb.pos) }[pb.action];
    toast(`${pb.byName} ${verb}`);
  }
}

function reconcile(force = false) {
  const pb = S.playback;
  if (!pb || !pb.src || !P.ready()) return;
  const dur = P.duration();
  const target = dur ? Math.min(expected(pb), Math.max(0, dur - 0.05)) : expected(pb);
  if (pb.playing && !P.playing()) {
    if (Math.abs(P.time() - target) > 0.3) P.seek(target);
    if (S.unlocked) P.play(); else $('#unlock').hidden = false;
  } else if (!pb.playing && P.playing()) {
    P.pause();
  }
  const drift = P.time() - target;
  const abs = Math.abs(drift);
  S.drift = pb.playing ? drift : 0;
  if (!pb.playing) {
    if (abs > 0.25) P.seek(pb.pos);
    P.rate(pb.rate);
  } else if (force || abs > 0.5) {
    if (abs > 0.08) P.seek(target);          // hard correction
    P.rate(pb.rate);
  } else if (kind === 'youtube') {
    if (abs > 0.3) P.seek(target);           // YouTube only supports fixed speeds
    else P.rate(pb.rate);
  } else if (abs > 0.12) {
    P.rate(pb.rate * (drift > 0 ? 0.95 : 1.05)); // soft correction: catch up / slow down
  } else {
    P.rate(pb.rate);
  }
}
setInterval(() => reconcile(false), 1000);

// unlock autoplay: browsers block sound until the user interacts
const unlockOnce = () => { S.unlocked = true; };
addEventListener('pointerdown', unlockOnce, { capture: true });
addEventListener('keydown', unlockOnce, { capture: true });
$('#unlock').onclick = () => { S.unlocked = true; $('#unlock').hidden = true; video.muted = false; reconcile(true); P.play(); };

// report latency samples so /api/metrics/:code can show room-wide p95
setInterval(() => { if (S.code && S.pending.length) emit('metrics:report', { samples: S.pending.splice(0, 100) }, () => {}); }, 10000);

/* ================= controls ================= */
const canControl = () => S.controlMode === 'all' || S.hostId === cid;
const isHost = () => S.hostId === cid;

function control(action, extra = {}) {
  if (!S.playback || !S.playback.src) return toast('Load a video first: paste a link below or open Discover.');
  if (!canControl()) return toast('Only the host controls playback in this room.');
  // optimistic local update so it feels instant
  if (action === 'play') P.play();
  if (action === 'pause') P.pause();
  if (action === 'seek') P.seek(extra.pos);
  emit('control', { action, seq: S.lastSeq, originTs: serverNow(), pos: P.time(), ...extra }, (err, res) => {
    if (err) return toast('The server did not answer. Your action may not have reached others.');
    if (res.conflict) { toast('Someone else did something at the same moment. Synced to their action.'); reconcile(true); }
    else if (res.error) { toast(res.error); reconcile(true); }
  });
}
$('#playBtn').onclick = () => control(S.playback?.playing ? 'pause' : 'play');
$('#seek').addEventListener('input', () => {
  S.seeking = true;
  $('#timeCur').textContent = fmt(($('#seek').value / 1000) * P.duration());
});
$('#seek').addEventListener('change', () => {
  S.seeking = false;
  const d = P.duration();
  if (d) control('seek', { pos: ($('#seek').value / 1000) * d });
});
$('#rateSel').onchange = e => control('rate', { rate: +e.target.value });
function applyVolume() {
  const v = +$('#vol').value, muted = video.muted;
  video.volume = v;
  if (yt && ytReady) { yt.setVolume(v * 100); muted ? yt.mute() : yt.unMute(); }
  $('#muteBtn').textContent = muted || v === 0 ? '🔇' : '🔊';
}
$('#vol').oninput = () => { video.muted = false; applyVolume(); };
$('#muteBtn').onclick = () => { video.muted = !video.muted; applyVolume(); };
$('#fsBtn').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : $('#frame').requestFullscreen?.());
document.addEventListener('keydown', e => {
  if ($('#room').hidden || e.target.closest('input, textarea, select')) return;
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); $('#playBtn').click(); }
  if (e.key === 'ArrowRight') control('seek', { pos: P.time() + 5 });
  if (e.key === 'ArrowLeft') control('seek', { pos: Math.max(0, P.time() - 5) });
});

$('#linkForm').addEventListener('submit', e => {
  e.preventDefault();
  emit('video:load', { url: $('#linkInput').value.trim(), title: $('#linkTitle').value.trim() }, (err, res) => {
    ack(err, res);
    if (res && res.ok) { $('#linkInput').value = ''; $('#linkTitle').value = ''; }
  });
});
$('#queueBtn').onclick = () => {
  const url = $('#linkInput').value.trim();
  if (!url) return toast('Paste a link first.');
  emit('playlist:add', { url, title: $('#linkTitle').value.trim() }, (err, res) => {
    ack(err, res);
    if (res && res.ok) { $('#linkInput').value = ''; $('#linkTitle').value = ''; toast('Added to the playlist.'); }
  });
};

function renderNowPlaying() {
  const pb = S.playback;
  $('#nowPlaying').innerHTML = pb && pb.src ? `${esc(pb.title)} <small>put on by ${esc(pb.byName || 'the playlist')}</small>` : '';
}
setInterval(() => {
  if ($('#room').hidden) return;
  const pb = S.playback, d = P.duration(), t = pb && pb.src && P.ready() ? P.time() : 0;
  $('#playBtn').textContent = pb?.playing ? '❚❚' : '▶';
  $('#playBtn').setAttribute('aria-label', pb?.playing ? 'Pause' : 'Play');
  $('#timeDur').textContent = fmt(d);
  if (!S.seeking) { $('#timeCur').textContent = fmt(t); $('#seek').value = d ? Math.round((t / d) * 1000) : 0; }
  $('#statRtt').textContent = `RTT ${Math.round(S.rtt)} ms`;
  $('#statDrift').textContent = `Drift ${Math.round(S.drift * 1000)} ms`;
  const s = [...S.samples].sort((a, b) => a - b);
  $('#statP95').textContent = s.length ? `p95 ${Math.round(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))])} ms` : 'p95 n/a';
}, 250);

/* ================= members & permissions ================= */
socket.on('members', onMembers);
function onMembers({ members, hostId, controlMode }) {
  const wasHost = isHost();
  S.members = members; S.hostId = hostId; S.controlMode = controlMode;
  if (!wasHost && isHost() && S.code) toast('👑 You are now the host.');
  renderPeople();
  $('#stage').classList.toggle('locked', !canControl());
  $('#controlNote').textContent = canControl() ? '' : 'Only the host controls play and pause. You can still add to the playlist, chat and pass snacks.';
  $$('[data-control-only]').forEach(el => (el.hidden = !canControl()));
  $$('[data-host-only]').forEach(el => (el.hidden = !isHost()));
  $('#controlMode').value = controlMode;
  const sel = $('#snackTo'), keep = sel.value;
  sel.innerHTML = '<option value="all">Everyone</option>' + members.filter(m => m.online && m.id !== cid)
    .map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  const board = [...members].filter(m => m.snacks).sort((a, b) => b.snacks - a.snacks).slice(0, 5);
  $('#snackBoard').innerHTML = board.length ? board.map(m => `<li>${esc(m.name)}: ${m.snacks} passed</li>`).join('') : '<li class="empty">Nobody yet.</li>';
  renderPlaylist();
  renderDiscover();
}
function renderPeople() {
  $('#peopleCount').textContent = S.members.filter(m => m.online).length;
  $('#peopleList').innerHTML = S.members.map(m => `
    <li class="person ${m.online ? '' : 'off'}">
      <span class="av" style="--c:${esc(m.color)}">${esc((m.name[0] || '?').toUpperCase())}</span>
      <span class="pname">${esc(m.name)}${m.id === cid ? ' <em>(you)</em>' : ''}${m.isHost ? ' <span title="Host">👑</span>' : ''}</span>
      <span class="munch" title="Snacking on">${m.munching ? snackEmoji(m.munching) : ''}</span>
      ${!m.online ? '<span class="offtag">away</span>' : ''}
      ${isHost() && m.id !== cid && m.online ? `<button class="mini" data-make-host="${esc(m.id)}">Make host</button>` : ''}
    </li>`).join('');
}
$('#peopleList').addEventListener('click', e => {
  const b = e.target.closest('[data-make-host]');
  if (b) emit('host:transfer', { to: b.dataset.makeHost });
});
$('#controlMode').onchange = e => emit('room:settings', { controlMode: e.target.value });

/* ================= tabs ================= */
$$('.tabs [role=tab]').forEach(btn => btn.addEventListener('click', () => {
  S.tab = btn.dataset.tab;
  $$('.tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
  $$('.panel').forEach(p => (p.hidden = p.dataset.panel !== S.tab));
  if (S.tab === 'chat') { S.unread = 0; $('#chatBadge').hidden = true; }
}));

/* ================= chat ================= */
socket.on('chat', m => {
  addChat(m);
  if (S.tab !== 'chat' && !m.system) { S.unread++; $('#chatBadge').textContent = S.unread; $('#chatBadge').hidden = false; }
});
function addChat(m) {
  const list = $('#chatList');
  const near = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const li = document.createElement('li');
  if (m.system) { li.className = 'sys'; li.textContent = m.text; }
  else li.innerHTML = `<span class="who" style="color:${esc(m.color)}">${esc(m.name)}</span> ${esc(m.text)}`;
  list.append(li);
  while (list.children.length > 200) list.firstChild.remove();
  if (near) list.scrollTop = list.scrollHeight;
}
$('#chatForm').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#chatInput').value.trim();
  if (!text) return;
  emit('chat:send', { text });
  $('#chatInput').value = '';
});

/* ================= reactions ================= */
$('#reactBar').innerHTML = REACTIONS.map(r => `<button type="button" data-react="${r}" aria-label="React ${r}">${r}</button>`).join('');
$('#reactBar').addEventListener('click', e => {
  const b = e.target.closest('[data-react]');
  if (b) emit('react', { emoji: b.dataset.react }, () => {});
});
socket.on('reaction', ({ emoji, name, color }) => {
  const el = document.createElement('div');
  el.className = 'float';
  el.style.left = 8 + Math.random() * 80 + '%';
  el.style.setProperty('--sway', (Math.random() * 80 - 40) + 'px');
  el.style.setProperty('--c', color);
  el.innerHTML = `<span class="e">${esc(emoji)}</span><span class="n">${esc(name)}</span>`;
  $('#reactLayer').append(el);
  setTimeout(() => el.remove(), 2700);
});

/* ================= snacks ================= */
$('#snackGrid').innerHTML = SNACKS.map(([k, e, n]) => `<button type="button" data-snack="${k}" title="Pass ${n}"><span>${e}</span>${n}</button>`).join('');
$('#snackGrid').addEventListener('click', e => {
  const b = e.target.closest('[data-snack]');
  if (b) emit('snack:send', { snack: b.dataset.snack, to: $('#snackTo').value });
});
socket.on('snack', ev => {
  const e = snackEmoji(ev.snack);
  const el = document.createElement('div');
  el.className = 'fly';
  el.textContent = e;
  el.style.left = 20 + Math.random() * 60 + '%';
  el.style.setProperty('--from', (Math.random() < 0.5 ? -1 : 1) * 300 + 'px');
  $('#snackLayer').append(el);
  setTimeout(() => el.remove(), 1700);
  const feed = $('#snackFeed');
  $('.empty', feed)?.remove();
  const li = document.createElement('li');
  li.innerHTML = `${e} <b style="color:${esc(ev.fromColor)}">${esc(ev.fromName)}</b> passed ${ev.to === cid ? '<b>you</b>' : esc(ev.toName)} some ${esc(SNACKS.find(s => s[0] === ev.snack)[2].toLowerCase())}`;
  feed.prepend(li);
  while (feed.children.length > 30) feed.lastChild.remove();
  if (ev.to === cid) toast(`${ev.fromName} passed you ${e}`);
});
$('#breakBtn').onclick = () => emit('snack:break', { minutes: +$('#breakMin').value });
$('#endBreak').onclick = () => emit('snack:break:end', null);
socket.on('snackbreak', onSnackBreak);
let breakTick;
function onSnackBreak(b) {
  S.snackBreak = b;
  clearInterval(breakTick);
  $('#breakOverlay').hidden = !b;
  if (!b) return;
  $('#breakBy').textContent = `${b.byName} called it. The video resumes for everyone when the timer ends.`;
  const tick = () => ($('#breakTimer').textContent = fmt(Math.max(0, (b.until - serverNow()) / 1000)));
  tick();
  breakTick = setInterval(tick, 500);
}

/* ================= playlist ================= */
socket.on('playlist', pl => { S.playlist = pl; renderPlaylist(); renderDiscover(); });
function renderPlaylist() {
  $('#plCount').textContent = S.playlist.length || '';
  const ctl = canControl();
  $('#playlist').innerHTML = S.playlist.length ? S.playlist.map((it, i) => `
    <li>
      <span class="pl-title">${esc(it.title)}<span class="pl-by">${it.kind === 'youtube' ? 'YouTube' : 'Video link'}, added by ${esc(it.byName)}</span></span>
      <span class="pl-actions">
        ${ctl ? `<button class="mini" data-pl="play" data-id="${it.id}" title="Play now">▶</button>` : ''}
        ${ctl && i > 0 ? `<button class="mini" data-pl="up" data-id="${it.id}" title="Move up">↑</button>` : ''}
        ${ctl && i < S.playlist.length - 1 ? `<button class="mini" data-pl="down" data-id="${it.id}" title="Move down">↓</button>` : ''}
        ${ctl || it.byId === cid ? `<button class="mini" data-pl="remove" data-id="${it.id}" title="Remove">✕</button>` : ''}
      </span>
    </li>`).join('')
    : '<li class="empty">Nothing queued. Paste a link and choose "Add to playlist", or add films from Discover.</li>';
}
$('#playlist').addEventListener('click', e => {
  const b = e.target.closest('[data-pl]');
  if (!b) return;
  const id = b.dataset.id, a = b.dataset.pl;
  if (a === 'play') emit('playlist:play', { id });
  if (a === 'up') emit('playlist:move', { id, dir: -1 });
  if (a === 'down') emit('playlist:move', { id, dir: 1 });
  if (a === 'remove') emit('playlist:remove', { id });
});

/* ================= polls ================= */
socket.on('polls', p => { S.polls = p; renderPolls(); renderDiscover(); });
function renderPolls() {
  $('#pollList').innerHTML = S.polls.length ? S.polls.map(p => {
    const mine = p.voters[cid];
    return `<li class="poll">
      <span class="poll-q">${esc(p.question)}</span>
      ${p.options.map((o, i) => `
        <button class="opt-btn ${mine === i ? 'mine' : ''}" data-poll="${p.id}" data-idx="${i}" ${p.closed ? 'disabled' : ''}>
          <span class="bar" style="width:${p.total ? (o.votes / p.total) * 100 : 0}%"></span>
          <span class="lbl"><span>${mine === i ? '✓ ' : ''}${esc(o.text)}</span><span>${o.votes}</span></span>
        </button>`).join('')}
      <span class="poll-meta"><span>${p.total} ${p.total === 1 ? 'vote' : 'votes'}, by ${esc(p.byName)}${p.closed ? '. Closed' : ''}</span>
        ${!p.closed && (p.byId === cid || isHost()) ? `<button class="mini" data-close="${p.id}">Close poll</button>` : ''}</span>
    </li>`;
  }).join('') : '<li class="empty">No polls yet. Ask the room what to watch next!</li>';
}
$('#pollList').addEventListener('click', e => {
  const v = e.target.closest('[data-poll]'), c = e.target.closest('[data-close]');
  if (v) emit('poll:vote', { pollId: v.dataset.poll, idx: +v.dataset.idx });
  if (c) emit('poll:close', { pollId: c.dataset.close });
});
$('#pollForm').addEventListener('submit', e => {
  e.preventDefault();
  const options = $('#pollOpts').value.split('\n').map(s => s.trim()).filter(Boolean);
  emit('poll:create', { question: $('#pollQ').value, options }, (err, res) => {
    ack(err, res);
    if (res && res.ok) { $('#pollQ').value = ''; $('#pollOpts').value = ''; }
  });
});

/* ================= discover: filters, fuzzy search, recommendations ================= */
const CAT = window.WP_CATALOG || [];
const D = { genres: new Set() };
const GENRES = [...new Set(CAT.flatMap(m => m.g))].sort();
$('#genreChips').innerHTML = GENRES.map(g => `<button type="button" data-genre="${g}" aria-pressed="false">${GENRE_ICON[g] || ''} ${g}</button>`).join('');
[...new Set(CAT.map(m => Math.floor(m.y / 10) * 10))].sort().forEach(d => $('#fDecade').insertAdjacentHTML('beforeend', `<option value="${d}">${d}s</option>`));
[...new Set(CAT.map(m => m.m))].sort().forEach(m => $('#fMood').insertAdjacentHTML('beforeend', `<option>${m}</option>`));
$('#genreChips').addEventListener('click', e => {
  const b = e.target.closest('[data-genre]');
  if (!b) return;
  const g = b.dataset.genre;
  D.genres.has(g) ? D.genres.delete(g) : D.genres.add(g);
  b.setAttribute('aria-pressed', String(D.genres.has(g)));
  renderDiscover();
});
['#search', '#fDecade', '#fMood', '#fSort', '#fPlayable'].forEach(s => $(s).addEventListener('input', renderDiscover));

function lev(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
/** Fuzzy score: exact substring > in-order letters > words within 1-2 typos. 0 = no match. */
function fuzzy(q, text) {
  q = q.toLowerCase().trim(); text = text.toLowerCase();
  if (!q) return 1;
  if (text.includes(q)) return 100 - text.indexOf(q);
  let ti = 0, score = 0, streak = 0, ok = true;
  for (const ch of q.replace(/\s+/g, '')) {
    const i = text.indexOf(ch, ti);
    if (i < 0) { ok = false; break; }
    streak = i === ti ? streak + 1 : 0;
    score += 1 + streak * 2;
    ti = i + 1;
  }
  if (ok && score >= q.length * 2) return Math.min(60, score);
  const words = text.split(/[^a-z0-9]+/).filter(Boolean);
  let best = 0;
  for (const part of q.split(/\s+/)) {
    if (part.length < 3) continue;
    const tol = part.length >= 8 ? 3 : part.length > 5 ? 2 : 1;
    for (const w of words) {
      const d = Math.min(lev(part, w), lev(part, w.slice(0, part.length)));
      if (d <= tol) best = Math.max(best, 20 - d * 5);
    }
  }
  return best;
}
const titleKey = t => String(t || '').toLowerCase();
function roomTaste() {
  const taste = new Map(), add = (title, w) => {
    const m = CAT.find(x => titleKey(x.t) === titleKey(title));
    if (m) m.g.forEach(g => taste.set(g, (taste.get(g) || 0) + w));
  };
  S.watched.forEach(t => add(t, 3));
  S.playlist.forEach(it => add(it.title, 2));
  S.polls.forEach(p => p.options.forEach(o => add(o.text, 1 + o.votes)));
  D.genres.forEach(g => taste.set(g, (taste.get(g) || 0) + 2));
  return taste;
}
function filmCard(m) {
  const i = CAT.indexOf(m), hue = [...m.t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return `<li class="film">
    <div class="poster" style="--h:${hue}">${GENRE_ICON[m.g[0]] || '🎬'}</div>
    <div>
      <h4>${esc(m.t)} <span class="yr">${m.y}</span></h4>
      <p class="meta">${m.src ? '<span class="play-tag">Plays here.</span> ' : ''}${esc(m.g.join(', '))}. ${esc(m.m)}. ${esc(m.l)}</p>
      <p class="blurb">${esc(m.d)}</p>
      <div class="factions">
        ${m.src && canControl() ? `<button class="mini" data-film="play" data-i="${i}">▶ Play now</button>` : ''}
        ${m.src ? `<button class="mini" data-film="queue" data-i="${i}">Add to playlist</button>`
          : `<a href="https://www.youtube.com/results?search_query=${encodeURIComponent(m.t + ' ' + m.y + ' trailer')}" target="_blank" rel="noopener">Find trailer</a>`}
        <button class="mini" data-film="poll" data-i="${i}">Add to poll</button>
      </div>
    </div>
  </li>`;
}
function renderDiscover() {
  const q = $('#search').value, dec = $('#fDecade').value, mood = $('#fMood').value, sort = $('#fSort').value, playable = $('#fPlayable').checked;
  let list = CAT.map(m => ({ m, s: fuzzy(q, `${m.t} ${m.g.join(' ')} ${m.m} ${m.l}`) }))
    .filter(({ m, s }) => s > 0
      && (!D.genres.size || m.g.some(g => D.genres.has(g)))
      && (!dec || Math.floor(m.y / 10) * 10 === +dec)
      && (!mood || m.m === mood)
      && (!playable || m.src));
  const sorters = { match: (a, b) => b.s - a.s, new: (a, b) => b.m.y - a.m.y, old: (a, b) => a.m.y - b.m.y, az: (a, b) => a.m.t.localeCompare(b.m.t) };
  list.sort(sorters[sort] || sorters.match);
  $('#resTitle').textContent = q || D.genres.size || dec || mood || playable ? `Results (${list.length})` : 'All films';
  $('#filmList').innerHTML = list.length ? list.map(x => filmCard(x.m)).join('') : '<li class="empty">No films match. Try fewer filters or a different spelling.</li>';

  // recommendations based on what this room watched, queued, polled and filtered
  const taste = roomTaste(), seen = new Set([...S.watched, ...S.playlist.map(p => p.title)].map(titleKey));
  let recs;
  if (!taste.size) {
    recs = CAT.filter(m => m.crowd);
    $('#recTitle').textContent = 'Crowd pleasers to start with';
    $('#recWhy').textContent = 'Play, queue or vote on films and these picks will adapt to your room.';
  } else {
    const top = [...taste.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(e => e[0]);
    recs = CAT.filter(m => !seen.has(titleKey(m.t)))
      .map(m => ({ m, s: m.g.reduce((a, g) => a + (taste.get(g) || 0), 0) + (m.src ? 0.5 : 0) }))
      .filter(x => x.s > 0.5).sort((a, b) => b.s - a.s).map(x => x.m);
    $('#recTitle').textContent = 'Picked for this room';
    $('#recWhy').textContent = `Because your room is into ${top.join(' and ')}.`;
  }
  $('#recList').innerHTML = recs.slice(0, 4).map(filmCard).join('') || '<li class="empty">You have seen everything we would suggest!</li>';
}
$('[data-panel=discover]').addEventListener('click', e => {
  const b = e.target.closest('[data-film]');
  if (!b) return;
  const m = CAT[+b.dataset.i];
  if (b.dataset.film === 'play') emit('video:load', { url: m.src, title: m.t });
  if (b.dataset.film === 'queue') emit('playlist:add', { url: m.src, title: m.t }, (err, res) => { ack(err, res); if (res?.ok) toast(`Added "${m.t}" to the playlist.`); });
  if (b.dataset.film === 'poll') {
    const lines = $('#pollOpts').value.split('\n').map(s => s.trim()).filter(Boolean);
    if (!lines.includes(m.t)) lines.push(m.t);
    $('#pollOpts').value = lines.join('\n');
    if (!$('#pollQ').value) $('#pollQ').value = 'What should we watch next?';
    $('.tabs [data-tab=polls]').click();
    toast(lines.length < 2 ? 'Added. Pick at least one more film for the poll.' : `"${m.t}" added to the poll draft.`);
  }
});

/* ================= confetti (one celebratory moment on entry) ================= */
function confetti() {
  if (REDUCED) return;
  const box = $('#confetti'), colors = ['#FF3E9A', '#FFD23F', '#3DDCFF', '#9DFF6B', '#C08BFF'];
  for (let i = 0; i < 90; i++) {
    const p = document.createElement('i');
    p.style.left = Math.random() * 100 + 'vw';
    p.style.background = colors[i % colors.length];
    p.style.setProperty('--x', (Math.random() * 200 - 100) + 'px');
    p.style.setProperty('--r', Math.random() * 900 + 'deg');
    p.style.setProperty('--d', 1.8 + Math.random() * 1.6 + 's');
    p.style.animationDelay = Math.random() * 0.4 + 's';
    box.append(p);
  }
  setTimeout(() => box.replaceChildren(), 4000);
}

renderDiscover();
})();
