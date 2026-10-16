# 🎉 Watch Party

A real-time watch-party app. Create a room (with an optional password), share the invite link, paste any video link, and everyone watches in sync with live chat, emoji reactions, snacks, polls, a shared playlist and movie discovery.

Built for the VinnovateIT Round 1 task.

## Features

**Rooms**
- Create a room with a name, an optional password, and a choice of who controls playback (only the host, or everyone).
- Join with a 6-letter room code or an invite link (`/r/CODE`). Locked rooms ask for the password.
- Passwords are hashed with scrypt and checked with a timing-safe compare. After 5 wrong attempts, joining is locked for 30 seconds.
- Host transfer: the host can hand the crown to anyone. If the host disconnects, they have 15 seconds to come back before the crown passes to the longest-present member.

**Video**
- Paste a YouTube link, a direct `.mp4` / `.webm` file link, or an `.m3u8` (HLS) stream.
- Synced play, pause, seek and speed for everyone.
- Shared playlist: anyone can add, the host can reorder, and the next video plays automatically when one ends.

**Party stuff**
- Live chat and floating emoji reactions over the video.
- **Snacks:** pass popcorn, samosas, chai and more to one person or the whole room. Snacks fly across the screen, show up next to each person's name, and feed a "Most generous" leaderboard.
- **Snack break:** the host pauses the movie for everyone with a countdown, and playback resumes automatically for the whole room when it ends.
- Group polls with live results, and you can add films from Discover straight into a poll.

**Movie discovery**
- Catalog of films with genre chips, decade, mood, "plays here" filter and sorting.
- Fuzzy search that tolerates typos ("incepshun" finds Inception).
- "Picked for this room" recommendations that adapt to what the room has watched, queued and voted for.
- Free open movies (Big Buck Bunny, Sintel, Tears of Steel…) play directly; others have a "Find trailer" link.

## How sync works

1. **The server is the source of truth.** It stores `{ position, playing, rate, at (server time), seq }`. Any client can compute where the video should be right now: `position + (serverNow − at) × rate`.
2. **Clock sync.** Each client pings the server (NTP style) and keeps the sample with the lowest round trip to estimate the offset between its clock and the server's.
3. **Drift correction** runs every second on every client:
   - drift > 500 ms: hard seek to the right spot
   - 120 to 500 ms: speed up or slow down by 5% until caught up (smooth, no jump)
   - YouTube only supports fixed speeds, so it hard-seeks above 300 ms
4. **Ordering.** Every change gets a sequence number. Clients ignore events older than the one they already have.
5. **Concurrent actions.** If two people act within 300 ms and the second person hadn't seen the first change yet, the second one is rejected as a conflict and their screen snaps to the winner. Everyone ends up in the same state.
6. **Late joins and reconnects.** Joining returns a full snapshot (video, position, playlist, chat history, polls, snack break). A session token lets you reconnect after a refresh or network drop without re-entering the password.

## Run it

Needs [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. The terminal also prints a Wi-Fi address (like `http://192.168.1.5:3000`) that phones and laptops on the same network can open.

## Test it

**Automated test** (server must be running in another terminal):

```bash
npm test                                   # 10 users, 90 actions
node test/load-test.js http://localhost:3000 30 60   # 30 users
```

It checks: password protection, 10+ users in one room, propagation p95 ≤ 250 ms, all clients converging on the same state, concurrent seeks, late join, reconnect with token, host transfer and the metrics endpoint.

**Manual test**
1. Open the app in two browser windows (one normal, one incognito, so they count as different people).
2. Window 1: create a room with a password. Click "Copy invite link".
3. Window 2: open the link, enter a name and the password.
4. Discover tab: press "Play now" on Big Buck Bunny. Play, pause and seek in one window and watch the other follow.
5. Try chat, reactions, passing snacks, a snack break, a poll, and adding to the playlist.
6. Refresh one window: it rejoins automatically and catches up.
7. Turn Wi-Fi off for a few seconds, then on: the dot in the top bar goes red, then green, and the video resyncs.
8. Open on a phone using the Wi-Fi address to test across devices.

**Live stats:** the top bar shows RTT, your current drift, and p95 propagation for other people's actions. Room-wide numbers: `http://localhost:3000/api/metrics/ROOMCODE`.

## Latency measurements

Propagation = time from one person pressing play/pause/seek to another person's client receiving it. Measured with `npm test`.

| Test conditions | Users | Samples | p50 | p95 | Max |
|---|---|---|---|---|---|
| Same machine (localhost), Node 22 | 10 | 810 | 2 ms | 5 ms | 10 ms |
| Same machine (localhost), Node 22 | 30 | 1740 | 3 ms | 6 ms | 152 ms |
| *Your LAN test: fill in from the stats bar or /api/metrics* | | | | | |

Target: p95 ≤ 250 ms on a local network. Drift after correction is held under 500 ms by the hard-seek threshold and usually stays under 120 ms thanks to rate correction.

## Failure handling

| Situation | What happens |
|---|---|
| Network drop | Socket.IO reconnects automatically. The client rejoins with its token, gets a fresh snapshot and resyncs. |
| Page refresh | The session token in `sessionStorage` rejoins the room without the password. |
| Host leaves | 15-second grace period, then the longest-present online member becomes host. |
| Two people act at once | Server serializes actions; conflicting ones are rejected and that client snaps to the winner. |
| Out-of-order events | Ignored using sequence numbers. |
| Browser blocks autoplay | A "Tap to join the show" button appears; one tap starts playback in sync. |
| Bad or unplayable link | Clear message telling the user which link types work. |
| YouTube video blocks embedding | Message asking for a different link. |
| Wrong password | Rejected; 5 wrong tries lock joining for 30 seconds. |
| Spam | Rate limits on chat, reactions, snacks, polls and room creation. |
| Room empty | Kept for 10 minutes, then deleted. |
| Server restart | Rooms live in memory, so they are lost. Clients are told the room closed. (A Redis store would fix this.) |

## Project structure

```
server.js            Express + Socket.IO server (rooms, sync, snacks, polls)
public/index.html    Page layout
public/style.css     Party theme
public/app.js        Client: player, sync and drift correction, UI
public/catalog.js    Movie catalog
test/load-test.js    Automated load and reliability test
```

## Tech

Node.js, Express, Socket.IO, YouTube IFrame API, hls.js. No build step.
