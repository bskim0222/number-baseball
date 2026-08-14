const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const rankingsPath = path.join(os.tmpdir(), `homerun-rankings-${process.pid}.json`);
process.env.RANKINGS_FILE = rankingsPath;

const { app, _internals } = require('./server');

let server;
let baseUrl;

async function api(route, options = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const body = await response.json();
    assert.equal(response.ok, true, `${route}: ${JSON.stringify(body)}`);
    return body;
}

test.before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await _internals.flushRankingWrites();
    await fs.promises.rm(rankingsPath, { force: true });
});

test('a completed match records both players exactly once', async () => {
    const host = { id: 'TEST-HOST', name: '테스트홈' };
    const guest = { id: 'TEST-GUEST', name: '테스트원정' };

    const room = await api('/api/create', {
        method: 'POST',
        body: JSON.stringify({ hostId: host.id, hostName: host.name })
    });
    await api('/api/join', {
        method: 'POST',
        body: JSON.stringify({ room: room.code, guestId: guest.id, guestName: guest.name })
    });
    await api('/api/ready', {
        method: 'POST',
        body: JSON.stringify({ room: room.code, role: 'host', secret: [1, 2, 3, 4] })
    });
    await api('/api/ready', {
        method: 'POST',
        body: JSON.stringify({ room: room.code, role: 'guest', secret: [5, 6, 7, 8] })
    });

    const hostTurn = await api('/api/guess', {
        method: 'POST',
        body: JSON.stringify({ room: room.code, role: 'host', guess: [5, 6, 7, 0] })
    });
    assert.deepEqual(hostTurn.guesses.host[0], {
        guess: [5, 6, 7, 0], strikes: 3, balls: 0, attempt: 1
    });

    const finished = await api('/api/guess', {
        method: 'POST',
        body: JSON.stringify({ room: room.code, role: 'guest', guess: [1, 2, 3, 4] })
    });
    assert.equal(finished.status, 'finished');
    assert.equal(finished.winner, 'guest');
    assert.equal(finished.statsRecorded, true);
    assert.equal(finished.playerStats.wins, 1);
    assert.equal(finished.playerStats.losses, 0);
    assert.equal(finished.ratingChange, 16);

    await api(`/api/poll?room=${room.code}&role=host`);
    await api(`/api/poll?room=${room.code}&role=guest`);
    const rankings = await api('/api/rankings');
    const hostRecord = rankings.find(player => player.id === host.id);
    const guestRecord = rankings.find(player => player.id === guest.id);
    assert.deepEqual([hostRecord.wins, hostRecord.losses], [0, 1]);
    assert.deepEqual([guestRecord.wins, guestRecord.losses], [1, 0]);
});

test('an older device copy cannot erase server wins and losses', async () => {
    const synced = await api('/api/ranking', {
        method: 'POST',
        body: JSON.stringify({
            id: 'TEST-GUEST', name: '새닉네임', wins: 0, losses: 0, rating: 1000
        })
    });
    assert.equal(synced.player.name, '새닉네임');
    assert.deepEqual([synced.player.wins, synced.player.losses], [1, 0]);
    assert.equal(synced.player.rating, 1016);
});

test('disconnect requires an active opponent and the full reconnect grace period', () => {
    const { HEARTBEAT_STALE_MS, DISCONNECT_GRACE_MS } = _internals.constants;
    const now = 1_000_000;
    const room = {
        code: '9999',
        status: 'setup',
        host: { id: 'A', name: 'A', lastActive: now - HEARTBEAT_STALE_MS - 1, disconnectSince: null },
        guest: { id: 'B', name: 'B', lastActive: now, disconnectSince: null },
        guestReady: false,
        startedAt: null,
        statsRecorded: false,
        winner: '',
        reason: ''
    };

    _internals.monitorConnections(room, now);
    assert.equal(room.status, 'setup');
    assert.equal(room.host.disconnectSince, now);

    room.guest.lastActive = now + DISCONNECT_GRACE_MS - 1;
    _internals.monitorConnections(room, now + DISCONNECT_GRACE_MS - 1);
    assert.equal(room.status, 'setup');

    room.guest.lastActive = now + DISCONNECT_GRACE_MS;
    _internals.monitorConnections(room, now + DISCONNECT_GRACE_MS);
    assert.equal(room.status, 'finished');
    assert.equal(room.winner, 'guest');
    assert.equal(room.reason, 'disconnect');
});

test('a shared outage does not award a random forfeit win', () => {
    const { HEARTBEAT_STALE_MS } = _internals.constants;
    const now = 2_000_000;
    const room = {
        code: '8888',
        status: 'playing',
        host: { id: 'A2', name: 'A2', lastActive: now - HEARTBEAT_STALE_MS - 1, disconnectSince: now - 50_000 },
        guest: { id: 'B2', name: 'B2', lastActive: now - HEARTBEAT_STALE_MS - 1, disconnectSince: now - 50_000 },
        startedAt: now - 60_000,
        statsRecorded: false,
        winner: '',
        reason: ''
    };

    _internals.monitorConnections(room, now);
    assert.equal(room.status, 'playing');
    assert.equal(room.host.disconnectSince, null);
    assert.equal(room.guest.disconnectSince, null);
});
