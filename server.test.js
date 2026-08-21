const assert = require('node:assert/strict');
const test = require('node:test');

process.env.NODE_ENV = 'test';
process.env.ADMIN_API_TOKEN = 'test-admin-token';

const { app, _internals } = require('./server');
const { createPostgresPoolOptions, MemoryStore, safePlayerName } = require('./database');

const HOST_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '22222222-2222-4222-8222-222222222222';
const OUTSIDER_ID = '33333333-3333-4333-8333-333333333333';
const CHALLENGER_ID = '44444444-4444-4444-8444-444444444444';
const TARGET_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_CHALLENGER_ID = '66666666-6666-4666-8666-666666666666';
const SECOND_TARGET_ID = '77777777-7777-4777-8777-777777777777';

let server;
let baseUrl;

test('Postgres connection verifies the Supabase CA and pooler hostname', () => {
    const options = createPostgresPoolOptions(
        'postgresql://postgres.project:password@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?sslmode=require'
    );
    assert.equal(options.ssl.rejectUnauthorized, true);
    assert.equal(options.ssl.servername, 'aws-0-ap-southeast-1.pooler.supabase.com');
    assert.match(options.ssl.ca, /BEGIN CERTIFICATE/);
    assert.equal(options.connectionString.includes('sslmode='), false);
});

test('legacy loading placeholders become stable account-specific nicknames', async () => {
    assert.equal(safePlayerName('로딩 중...', HOST_ID), '야구유저1111');
    const store = new MemoryStore();
    const player = await store.ensurePlayer(HOST_ID, '로딩 중...');
    assert.equal(player.name, '야구유저1111');
});

test('rankings use wins, win rate, and fewer losses without a score', async () => {
    const store = new MemoryStore();
    const match = (matchId, winnerId, loserId) => store.recordMatch({
        matchId,
        roomCode: matchId,
        winnerId,
        winnerName: winnerId,
        loserId,
        loserName: loserId,
        reason: 'win'
    });
    await match('m1', 'A', 'B');
    await match('m2', 'A', 'C');
    await match('m3', 'C', 'A');
    await match('m4', 'C', 'B');
    await match('m5', 'B', 'C');

    const rankings = await store.listRankings();
    assert.deepEqual(rankings.map(player => player.name), ['A', 'C', 'B']);
    assert.equal(rankings.some(player => Object.hasOwn(player, 'rating')), false);
});

test('deleting an anonymous player removes the profile and season record', async () => {
    const store = new MemoryStore();
    await store.ensurePlayer('delete-me', '삭제테스트');
    assert.equal((await store.getPlayer('delete-me')).name, '삭제테스트');
    await store.deletePlayer('delete-me');
    assert.equal(await store.getPlayer('delete-me'), null);
    assert.equal((await store.listRankings()).some(player => player.id === 'delete-me'), false);
});

test('expired direct challenges cannot be accepted', async () => {
    const store = new MemoryStore();
    const challengerId = '88888888-8888-4888-8888-888888888888';
    const targetId = '99999999-9999-4999-8999-999999999999';
    await store.ensurePlayer(challengerId, '만료신청자');
    await store.ensurePlayer(targetId, '만료수락자');
    await store.touchPresence(targetId, true);
    const challenge = await store.createChallenge(challengerId, targetId, Date.now() - 1);
    const lobby = await store.getLobbyState(targetId);
    assert.equal(lobby.challenge.status, 'expired');
    await assert.rejects(
        () => store.respondToChallenge(challenge.id, targetId, 'accept'),
        /만료된/
    );
});

async function request(route, options = {}, userId = HOST_ID) {
    const response = await fetch(`${baseUrl}${route}`, {
        ...options,
        headers: {
            'Content-Type': 'application/json',
            'X-Test-User-Id': userId,
            ...(options.headers || {})
        }
    });
    const body = await response.json();
    return { response, body };
}

async function api(route, options = {}, userId = HOST_ID) {
    const { response, body } = await request(route, options, userId);
    assert.equal(response.ok, true, `${route}: ${JSON.stringify(body)}`);
    return body;
}

test.before(async () => {
    await _internals.dataStoreReady;
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise(resolve => server.close(resolve));
});

test('privacy and account deletion pages are publicly available without legacy Firebase', async () => {
    const privacyResponse = await fetch(`${baseUrl}/privacy.html`);
    const privacyText = await privacyResponse.text();
    assert.equal(privacyResponse.ok, true);
    assert.match(privacyText, /ask\.homerungame@gmail\.com/);

    const deletionResponse = await fetch(`${baseUrl}/account-deletion.html`);
    const deletionText = await deletionResponse.text();
    assert.equal(deletionResponse.ok, true);
    assert.match(deletionText, /이메일로 계정 삭제 요청/);

    const indexResponse = await fetch(`${baseUrl}/index.html`);
    const indexText = await indexResponse.text();
    assert.equal(indexResponse.ok, true);
    assert.doesNotMatch(indexText, /firebase|gstatic\.com\/firebase/i);
});

test('authenticated match records both players exactly once', async () => {
    await api('/api/me/bootstrap', {
        method: 'POST', body: JSON.stringify({ name: '테스트홈' })
    }, HOST_ID);
    await api('/api/me/bootstrap', {
        method: 'POST', body: JSON.stringify({ name: '테스트원정' })
    }, GUEST_ID);

    const room = await api('/api/create', {
        method: 'POST', body: JSON.stringify({ hostName: '테스트홈', hostId: OUTSIDER_ID })
    }, HOST_ID);
    await api('/api/join', {
        method: 'POST', body: JSON.stringify({ room: room.code, guestName: '테스트원정', guestId: HOST_ID })
    }, GUEST_ID);
    await api('/api/ready', {
        method: 'POST', body: JSON.stringify({ room: room.code, role: 'host', secret: [1, 2, 3, 4] })
    }, HOST_ID);
    await api('/api/ready', {
        method: 'POST', body: JSON.stringify({ room: room.code, role: 'guest', secret: [5, 6, 7, 8] })
    }, GUEST_ID);

    const hostTurn = await api('/api/guess', {
        method: 'POST', body: JSON.stringify({ room: room.code, role: 'host', guess: [5, 6, 7, 0] })
    }, HOST_ID);
    assert.deepEqual(hostTurn.guesses.host[0], { guess: [5, 6, 7, 0], strikes: 3, balls: 0, attempt: 1 });

    const finished = await api('/api/guess', {
        method: 'POST', body: JSON.stringify({ room: room.code, role: 'guest', guess: [1, 2, 3, 4] })
    }, GUEST_ID);
    assert.equal(finished.status, 'finished');
    assert.equal(finished.winner, 'guest');
    assert.equal(finished.statsRecorded, true);
    assert.deepEqual([finished.playerStats.wins, finished.playerStats.losses], [1, 0]);
    assert.equal(Object.hasOwn(finished, 'ratingChange'), false);

    await api(`/api/poll?room=${room.code}&role=host`, {}, HOST_ID);
    await api(`/api/poll?room=${room.code}&role=guest`, {}, GUEST_ID);
    const rankings = await api('/api/rankings', {}, HOST_ID);
    const hostRecord = rankings.find(player => player.isMe);
    assert.deepEqual([hostRecord.wins, hostRecord.losses], [0, 1]);
    assert.equal(rankings.some(player => player.name === '테스트원정' && player.wins === 1), true);
});

test('private rooms stay hidden, restore for the host, and trigger a push event', async () => {
    const token = 'test-fcm-token-12345678901234567890';
    await api('/api/push/register', {
        method: 'POST', body: JSON.stringify({ token, name: '테스트홈' })
    }, HOST_ID);

    const sent = [];
    const originalSend = _internals.pushService.sendRoomJoined;
    _internals.pushService.sendRoomJoined = async (userId, payload) => {
        sent.push({ userId, payload });
        return { sent: 1 };
    };

    try {
        const room = await api('/api/create', {
            method: 'POST',
            body: JSON.stringify({ hostName: '테스트홈', roomTitle: '친구만 들어와', visibility: 'private' })
        }, HOST_ID);
        assert.equal(room.code.length, 6);
        assert.equal(room.roomTitle, '친구만 들어와');
        assert.equal(room.visibility, 'private');

        const publicRooms = await api('/api/rooms', {}, HOST_ID);
        assert.equal(publicRooms.some(item => item.code === room.code), false);

        await api('/api/join', {
            method: 'POST', body: JSON.stringify({ room: room.code, guestName: '테스트원정' })
        }, GUEST_ID);
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(sent, [{
            userId: HOST_ID,
            payload: {
                roomCode: room.code,
                roomTitle: '친구만 들어와',
                guestName: '테스트원정'
            }
        }]);

        const active = await api('/api/me/active-room', {}, HOST_ID);
        assert.equal(active.role, 'host');
        assert.equal(active.room.code, room.code);
        assert.equal(active.room.status, 'setup');
    } finally {
        _internals.pushService.sendRoomJoined = originalSend;
    }
});

test('public rooms expose their custom title and can replace an unfinished waiting room', async () => {
    const createdAfter = Date.now();
    const room = await api('/api/create', {
        method: 'POST',
        body: JSON.stringify({ hostName: '테스트홈', roomTitle: '1234567890123456789012345', visibility: 'public' })
    }, HOST_ID);
    assert.equal(room.code.length, 4);
    assert.equal(room.roomTitle.length, 20);
    assert.ok(room.expiresAt >= createdAfter + (60 * 60_000));
    assert.ok(room.expiresAt <= Date.now() + (60 * 60_000));
    const publicRooms = await api('/api/rooms', {}, GUEST_ID);
    const listed = publicRooms.find(item => item.code === room.code);
    assert.equal(listed.roomTitle, room.roomTitle);
});

test('battle waiting lists an available player and acceptance puts both users in one private room', async () => {
    await api('/api/me/bootstrap', {
        method: 'POST', body: JSON.stringify({ name: '신청자' })
    }, CHALLENGER_ID);
    await api('/api/me/bootstrap', {
        method: 'POST', body: JSON.stringify({ name: '수락자' })
    }, TARGET_ID);
    await api('/api/lobby/presence', {
        method: 'POST', body: JSON.stringify({ acceptingChallenges: true, name: '수락자' })
    }, TARGET_ID);

    const lobby = await api('/api/lobby', {}, CHALLENGER_ID);
    assert.equal(lobby.availablePlayers.some(player => player.id === TARGET_ID), true);
    assert.equal(lobby.counts.available >= 1, true);

    const challenge = await api('/api/challenges', {
        method: 'POST', body: JSON.stringify({ targetUserId: TARGET_ID, name: '신청자' })
    }, CHALLENGER_ID);
    assert.equal(challenge.status, 'pending');
    assert.equal(challenge.direction, 'outgoing');

    const targetLobby = await api('/api/lobby', {}, TARGET_ID);
    assert.equal(targetLobby.challenge.id, challenge.id);
    assert.equal(targetLobby.challenge.direction, 'incoming');
    assert.equal(targetLobby.challenge.challenger.name, '신청자');

    const accepted = await api(`/api/challenges/${challenge.id}/respond`, {
        method: 'POST', body: JSON.stringify({ action: 'accept' })
    }, TARGET_ID);
    assert.equal(accepted.role, 'guest');
    assert.equal(accepted.room.status, 'setup');
    assert.equal(accepted.room.visibility, 'private');
    assert.equal(accepted.room.code.length, 6);

    const hostActive = await api('/api/me/active-room', {}, CHALLENGER_ID);
    assert.equal(hostActive.role, 'host');
    assert.equal(hostActive.room.code, accepted.room.code);
    const hostLobby = await api('/api/lobby', {}, CHALLENGER_ID);
    assert.equal(hostLobby.challenge.status, 'accepted');
    assert.equal(hostLobby.challenge.roomCode, accepted.room.code);

    await api('/api/leave', {
        method: 'POST', body: JSON.stringify({ room: accepted.room.code, role: 'guest' })
    }, TARGET_ID);
});

test('a pending challenge blocks duplicate and crossed requests', async () => {
    await api('/api/me/bootstrap', {
        method: 'POST', body: JSON.stringify({ name: '두번째신청자' })
    }, SECOND_CHALLENGER_ID);
    await api('/api/me/bootstrap', {
        method: 'POST', body: JSON.stringify({ name: '두번째수락자' })
    }, SECOND_TARGET_ID);
    await api('/api/lobby/presence', {
        method: 'POST', body: JSON.stringify({ acceptingChallenges: true, name: '두번째수락자' })
    }, SECOND_TARGET_ID);
    await api('/api/lobby/presence', {
        method: 'POST', body: JSON.stringify({ acceptingChallenges: true, name: '두번째신청자' })
    }, SECOND_CHALLENGER_ID);
    const challenge = await api('/api/challenges', {
        method: 'POST', body: JSON.stringify({ targetUserId: SECOND_TARGET_ID, name: '두번째신청자' })
    }, SECOND_CHALLENGER_ID);

    const duplicate = await request('/api/challenges', {
        method: 'POST', body: JSON.stringify({ targetUserId: SECOND_TARGET_ID, name: '두번째신청자' })
    }, SECOND_CHALLENGER_ID);
    assert.equal(duplicate.response.status, 409);

    const crossed = await request('/api/challenges', {
        method: 'POST', body: JSON.stringify({ targetUserId: SECOND_CHALLENGER_ID, name: '두번째수락자' })
    }, SECOND_TARGET_ID);
    assert.equal(crossed.response.status, 409);

    const declined = await api(`/api/challenges/${challenge.id}/respond`, {
        method: 'POST', body: JSON.stringify({ action: 'decline' })
    }, SECOND_TARGET_ID);
    assert.equal(declined.challenge.status, 'declined');
});

test('an expired waiting room cannot be joined', async () => {
    const room = await api('/api/create', {
        method: 'POST',
        body: JSON.stringify({ hostName: '만료테스트', visibility: 'private' })
    }, OUTSIDER_ID);
    _internals.rooms[room.code].expiresAt = Date.now() - 1;

    const { response } = await request('/api/join', {
        method: 'POST', body: JSON.stringify({ room: room.code, guestName: '테스트원정' })
    }, GUEST_ID);
    assert.equal(response.status, 404);
    assert.equal(_internals.rooms[room.code], undefined);
});

test('a player cannot act as the opponent role', async () => {
    const room = Object.values(_internals.rooms).find(item => item.host.id === HOST_ID && item.guest);
    const { response, body } = await request(`/api/poll?room=${room.code}&role=guest`, {}, HOST_ID);
    assert.equal(response.status, 403);
    assert.match(body.error, /권한/);
});

test('the removed client-controlled ranking endpoint cannot change records', async () => {
    const { response } = await request('/api/ranking', {
        method: 'POST',
        body: JSON.stringify({ id: HOST_ID, wins: 999, losses: 0, rating: 9999 })
    }, HOST_ID);
    assert.equal(response.status, 410);
    const profile = await api('/api/me', {}, HOST_ID);
    assert.deepEqual([profile.player.wins, profile.player.losses], [0, 1]);
    assert.equal(Object.hasOwn(profile.player, 'rating'), false);
});

test('a player can reset only the current season record', async () => {
    const reset = await api('/api/me/record', {
        method: 'DELETE', body: JSON.stringify({ confirmation: 'RESET' })
    }, HOST_ID);
    assert.deepEqual([reset.player.wins, reset.player.losses], [0, 0]);
});

test('starting a new season preserves accounts and begins fresh rankings', async () => {
    const result = await api('/api/admin/seasons', {
        method: 'POST',
        headers: { 'X-Admin-Token': 'test-admin-token' },
        body: JSON.stringify({ name: '테스트 시즌 2' })
    }, HOST_ID);
    assert.equal(result.season.name, '테스트 시즌 2');
    const profile = await api('/api/me', {}, GUEST_ID);
    assert.deepEqual([profile.player.wins, profile.player.losses], [0, 0]);
});

test('disconnect forfeits only after a match has started and the grace period elapsed', async () => {
    const { HEARTBEAT_STALE_MS, DISCONNECT_GRACE_MS } = _internals.constants;
    const now = 1_000_000;
    const room = {
        code: '9999', status: 'playing',
        host: { id: HOST_ID, name: 'A', lastActive: now - HEARTBEAT_STALE_MS - 1, disconnectSince: null },
        guest: { id: GUEST_ID, name: 'B', lastActive: now, disconnectSince: null },
        startedAt: null, statsRecorded: false, winner: '', reason: ''
    };
    await _internals.monitorConnections(room, now);
    assert.equal(room.status, 'playing');
    assert.equal(room.host.disconnectSince, now);
    room.guest.lastActive = now + DISCONNECT_GRACE_MS;
    await _internals.monitorConnections(room, now + DISCONNECT_GRACE_MS);
    assert.equal(room.status, 'finished');
    assert.equal(room.winner, 'guest');
});

test('closing a waiting room does not cause a setup-stage forfeit', async () => {
    const now = 1_500_000;
    const room = {
        code: '7777', status: 'setup',
        host: { id: HOST_ID, name: 'A', lastActive: 0, disconnectSince: null },
        guest: { id: GUEST_ID, name: 'B', lastActive: now, disconnectSince: null },
        startedAt: null, statsRecorded: false, winner: '', reason: ''
    };
    await _internals.monitorConnections(room, now);
    assert.equal(room.status, 'setup');
    assert.equal(room.winner, '');
    assert.equal(room.host.disconnectSince, null);
});

test('a shared outage does not award a random forfeit win', async () => {
    const { HEARTBEAT_STALE_MS } = _internals.constants;
    const now = 2_000_000;
    const room = {
        code: '8888', status: 'playing',
        host: { id: HOST_ID, name: 'A', lastActive: now - HEARTBEAT_STALE_MS - 1, disconnectSince: now - 50_000 },
        guest: { id: GUEST_ID, name: 'B', lastActive: now - HEARTBEAT_STALE_MS - 1, disconnectSince: now - 50_000 },
        startedAt: now - 60_000, statsRecorded: false, winner: '', reason: ''
    };
    await _internals.monitorConnections(room, now);
    assert.equal(room.status, 'playing');
    assert.equal(room.host.disconnectSince, null);
    assert.equal(room.guest.disconnectSince, null);
});
