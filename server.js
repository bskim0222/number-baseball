const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const { createAuth } = require('./auth');
const { createDataStore, safePlayerName } = require('./database');
const { createPushService } = require('./push-notifications');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors({ allowedHeaders: ['Content-Type', 'Authorization', 'X-Test-User-Id', 'X-Admin-Token'] }));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const DIGIT_COUNT = 4;
const TURN_TIMEOUT_MS = 60_000;
const HEARTBEAT_STALE_MS = 5_000;
const DISCONNECT_GRACE_MS = 25_000;
const WAITING_ROOM_TTL_MS = 60 * 60_000;
const SETUP_ROOM_TTL_MS = 2 * 60_000;
const ACTIVE_ROOM_TTL_MS = 2 * 60 * 60_000;
const FINISHED_ROOM_RETENTION_MS = 10 * 60_000;
const CHALLENGE_TTL_MS = 30_000;

const rooms = {};
const auth = createAuth();
let dataStore = null;
let dataStoreError = null;

try {
    dataStore = createDataStore();
} catch (error) {
    dataStoreError = error;
}

const dataStoreReady = dataStore
    ? dataStore.init().catch(error => {
        dataStoreError = error;
        console.error('Database initialization failed:', error.message);
    })
    : Promise.resolve();
const pushService = createPushService({ dataStore });

function safeRoomTitle(value, hostName) {
    const title = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 20) : '';
    return title || `${hostName}님의 방`;
}

async function generateRoomCode(codeLength) {
    const lowerBound = 10 ** (codeLength - 1);
    const upperRange = 9 * lowerBound;
    let roomCode;
    do roomCode = String(Math.floor(lowerBound + Math.random() * upperRange));
    while (await getRoom(roomCode));
    return roomCode;
}

function createRoomState({ roomCode, hostProfile, guestProfile = null, roomTitle, visibility = 'public' }) {
    const now = Date.now();
    return {
        matchId: crypto.randomUUID(),
        code: roomCode,
        roomTitle: safeRoomTitle(roomTitle, hostProfile.name),
        visibility,
        status: guestProfile ? 'setup' : 'waiting',
        host: {
            id: hostProfile.id,
            name: hostProfile.name,
            stats: hostProfile,
            status: 'waiting',
            lastActive: now,
            disconnectSince: null
        },
        guest: guestProfile ? {
            id: guestProfile.id,
            name: guestProfile.name,
            stats: guestProfile,
            status: 'waiting',
            lastActive: now,
            disconnectSince: null
        } : null,
        currentTurn: 'host',
        guesses: { host: [], guest: [] },
        secrets: { host: [], guest: [] },
        winner: '',
        reason: '',
        turnStartedAt: now,
        startedAt: null,
        finishedAt: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + (guestProfile ? SETUP_ROOM_TTL_MS : WAITING_ROOM_TTL_MS),
        statsRecorded: false,
        statsPromise: null
    };
}

async function persistRoom(room) {
    if (!room || !dataStore) return;
    room.updatedAt = Date.now();
    await dataStore.saveRoom(room);
}

async function removeRoom(code) {
    delete rooms[String(code)];
    if (dataStore) await dataStore.deleteRoom(String(code));
}

async function getRoom(code) {
    const roomCode = String(code || '');
    if (!roomCode) return null;
    const cached = rooms[roomCode];
    if (cached) {
        if (['waiting', 'setup'].includes(cached.status) && cached.expiresAt <= Date.now()) {
            await removeRoom(roomCode);
            return null;
        }
        return cached;
    }
    if (!dataStore) return null;

    const stored = await dataStore.getRoom(roomCode);
    if (!stored) return null;
    if (['waiting', 'setup'].includes(stored.status) && stored.expiresAt <= Date.now()) {
        await removeRoom(roomCode);
        return null;
    }
    stored.statsPromise = null;
    rooms[roomCode] = stored;
    return stored;
}

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

async function requireDataStore(req, res, next) {
    await dataStoreReady;
    if (!dataStore || dataStoreError) {
        return res.status(503).json({
            error: '전적 데이터베이스가 준비되지 않았습니다.',
            detail: dataStoreError ? dataStoreError.message : 'DATABASE_URL missing'
        });
    }
    return next();
}

function normalizeDigits(value) {
    if (!Array.isArray(value)) return [];
    return value.map(Number).filter(Number.isInteger);
}

function isValidDigits(value) {
    const digits = normalizeDigits(value);
    return digits.length === DIGIT_COUNT
        && new Set(digits).size === DIGIT_COUNT
        && digits.every(digit => digit >= 0 && digit <= 9);
}

function calculateScore(guess, secret) {
    const guessDigits = normalizeDigits(guess);
    const secretDigits = normalizeDigits(secret);
    let strikes = 0;
    let balls = 0;

    guessDigits.forEach((digit, index) => {
        if (digit === secretDigits[index]) strikes += 1;
        else if (secretDigits.includes(digit)) balls += 1;
    });
    return { strikes, balls };
}

function publicRoomPlayer(player) {
    if (!player) return null;
    return { name: player.name, status: player.status };
}

function buildPublicRoomState(room, role) {
    const filteredSecrets = {
        host: room.status === 'finished' || role === 'host' ? room.secrets.host : [],
        guest: room.status === 'finished' || role === 'guest' ? room.secrets.guest : []
    };
    const player = room[role];

    return {
        code: room.code,
        roomTitle: room.roomTitle,
        visibility: room.visibility,
        status: room.status,
        host: publicRoomPlayer(room.host),
        guest: publicRoomPlayer(room.guest),
        currentTurn: room.currentTurn,
        guesses: room.guesses,
        winner: room.winner,
        reason: room.reason,
        turnStartedAt: room.turnStartedAt,
        turnDurationMs: TURN_TIMEOUT_MS,
        disconnectGraceMs: HEARTBEAT_STALE_MS + DISCONNECT_GRACE_MS,
        expiresAt: room.expiresAt,
        statsRecorded: room.statsRecorded,
        playerStats: player ? player.stats || null : null,
        secrets: filteredSecrets
    };
}

function userOwnsRole(room, role, userId) {
    return ['host', 'guest'].includes(role) && room[role] && room[role].id === userId;
}

function touchPlayer(room, role, now = Date.now()) {
    if (!room || !['host', 'guest'].includes(role) || !room[role]) return false;

    if (room.guest) {
        const hostWasStale = now - room.host.lastActive > HEARTBEAT_STALE_MS;
        const guestWasStale = now - room.guest.lastActive > HEARTBEAT_STALE_MS;
        if (hostWasStale && guestWasStale) {
            room.host.lastActive = now;
            room.guest.lastActive = now;
            room.host.disconnectSince = null;
            room.guest.disconnectSince = null;
            if (room.status === 'playing') room.turnStartedAt = now;
        }
    }

    room[role].lastActive = now;
    room[role].disconnectSince = null;
    return true;
}

async function recordRankedMatch(room) {
    if (room.statsRecorded || !room.startedAt || !room.guest) return;
    const winnerRole = room.winner;
    const loserRole = winnerRole === 'host' ? 'guest' : 'host';
    if (!['host', 'guest'].includes(winnerRole)) return;

    const result = await dataStore.recordMatch({
        matchId: room.matchId,
        roomCode: room.code,
        winnerId: room[winnerRole].id,
        winnerName: room[winnerRole].name,
        loserId: room[loserRole].id,
        loserName: room[loserRole].name,
        reason: room.reason
    });

    room[winnerRole].stats = result.winner;
    room[loserRole].stats = result.loser;
    room.statsRecorded = true;
}

async function finishRoom(room, winner, reason) {
    if (!room) return;
    if (room.status !== 'finished') {
        room.status = 'finished';
        room.winner = winner;
        room.reason = reason;
        room.finishedAt = Date.now();
    }
    if (!room.statsPromise) {
        room.statsPromise = recordRankedMatch(room).catch(error => {
            room.statsError = error.message;
            console.error(`[RANKING] Room ${room.code} failed:`, error.message);
        });
    }
    await room.statsPromise;
    room.expiresAt = Date.now() + FINISHED_ROOM_RETENTION_MS;
    await persistRoom(room);
}

async function monitorConnections(room, now) {
    if (!room.guest || room.status !== 'playing') return;

    const hostStale = now - room.host.lastActive > HEARTBEAT_STALE_MS;
    const guestStale = now - room.guest.lastActive > HEARTBEAT_STALE_MS;
    if (hostStale && guestStale) {
        room.host.disconnectSince = null;
        room.guest.disconnectSince = null;
        return;
    }

    const checks = [
        { role: 'host', stale: hostStale, opponentStale: guestStale, winner: 'guest' },
        { role: 'guest', stale: guestStale, opponentStale: hostStale, winner: 'host' }
    ];
    for (const check of checks) {
        const player = room[check.role];
        if (!player || room.status === 'finished') continue;
        if (check.stale && !check.opponentStale) {
            if (!player.disconnectSince) player.disconnectSince = now;
            if (now - player.disconnectSince >= DISCONNECT_GRACE_MS) {
                await finishRoom(room, check.winner, 'disconnect');
                console.log(`[WATCHDOG] Room ${room.code} - ${check.role} failed to reconnect.`);
            }
        } else {
            player.disconnectSince = null;
        }
    }
}

let watchdogBusy = false;
const watchdogInterval = setInterval(async () => {
    if (watchdogBusy) return;
    watchdogBusy = true;
    try {
        const now = Date.now();
        for (const roomCode of Object.keys(rooms)) {
            const room = rooms[roomCode];
            if (room.status === 'finished') {
                if (room.finishedAt && now - room.finishedAt > FINISHED_ROOM_RETENTION_MS) {
                    await removeRoom(roomCode);
                }
                continue;
            }

            if (['waiting', 'setup'].includes(room.status) && room.expiresAt && now >= room.expiresAt) {
                await removeRoom(roomCode);
                continue;
            }

            const bothStale = room.guest
                && now - room.host.lastActive > HEARTBEAT_STALE_MS
                && now - room.guest.lastActive > HEARTBEAT_STALE_MS;
            if (room.status === 'playing' && !bothStale && now - room.turnStartedAt >= TURN_TIMEOUT_MS) {
                const winner = room.currentTurn === 'host' ? 'guest' : 'host';
                await finishRoom(room, winner, 'timeout');
                console.log(`[WATCHDOG] Room ${roomCode} - Turn timed out. Winner: ${winner}.`);
                continue;
            }
            await monitorConnections(room, now);
        }
    } finally {
        watchdogBusy = false;
    }
}, 1000);
watchdogInterval.unref();

const protectedApi = [asyncRoute(requireDataStore), auth.requireUser];

app.get('/api/health', asyncRoute(async (req, res) => {
    await dataStoreReady;
    if (!dataStore || dataStoreError) {
        return res.status(503).json({
            ok: false,
            service: 'homerunbaseball-v12',
            database: { connected: false, error: dataStoreError ? dataStoreError.message : 'DATABASE_URL missing' },
            authConfigured: auth.configured(),
            activeRooms: Object.keys(rooms).length,
            pushConfigured: pushService.configured()
        });
    }
    const database = await dataStore.health();
    return res.json({
        ok: true,
        service: 'homerunbaseball-v12',
        time: Date.now(),
        database,
        authConfigured: auth.configured(),
        activeRooms: Object.keys(rooms).length,
        pushConfigured: pushService.configured()
    });
}));

app.post('/api/me/bootstrap', ...protectedApi, asyncRoute(async (req, res) => {
    const player = await dataStore.ensurePlayer(req.user.id, req.body.name);
    res.json({ player });
}));

app.get('/api/me', ...protectedApi, asyncRoute(async (req, res) => {
    let player = await dataStore.getPlayer(req.user.id);
    if (!player) player = await dataStore.ensurePlayer(req.user.id, '야구유저');
    res.json({ player });
}));

app.patch('/api/me', ...protectedApi, asyncRoute(async (req, res) => {
    const name = safePlayerName(req.body.name, req.user.id);
    const player = await dataStore.updateName(req.user.id, name);
    res.json({ player });
}));

app.delete('/api/me/record', ...protectedApi, asyncRoute(async (req, res) => {
    if (req.body.confirmation !== 'RESET') {
        return res.status(400).json({ error: '전적 초기화 확인 값이 필요합니다.' });
    }
    const player = await dataStore.resetPlayer(req.user.id);
    return res.json({ success: true, player });
}));

app.delete('/api/me', ...protectedApi, asyncRoute(async (req, res) => {
    if (req.body.confirmation !== 'DELETE') {
        return res.status(400).json({ error: '계정 삭제 확인 값이 필요합니다.' });
    }
    await dataStore.deletePlayer(req.user.id);
    await auth.deleteAuthUser(req.user.id);
    return res.json({ success: true });
}));

app.get('/api/rankings', ...protectedApi, asyncRoute(async (req, res) => {
    const rankings = await dataStore.listRankings();
    res.json(rankings.map(player => ({
        name: player.name,
        wins: player.wins,
        losses: player.losses,
        games: player.games,
        rate: player.rate,
        seasonId: player.seasonId,
        seasonName: player.seasonName,
        isMe: player.id === req.user.id
    })));
}));

app.post('/api/push/register', ...protectedApi, asyncRoute(async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (token.length < 20 || token.length > 4096) {
        return res.status(400).json({ error: '올바른 알림 토큰이 필요합니다.' });
    }
    await dataStore.ensurePlayer(req.user.id, req.body.name);
    await dataStore.savePushToken(req.user.id, token, 'android');
    return res.json({ success: true, pushConfigured: pushService.configured() });
}));

app.delete('/api/push/register', ...protectedApi, asyncRoute(async (req, res) => {
    const token = String(req.body.token || '').trim();
    if (token) await dataStore.deletePushToken(token);
    return res.json({ success: true });
}));

app.post('/api/lobby/presence', ...protectedApi, asyncRoute(async (req, res) => {
    await dataStore.ensurePlayer(req.user.id, req.body.name);
    const hasChoice = typeof req.body.acceptingChallenges === 'boolean';
    const presence = await dataStore.touchPresence(
        req.user.id,
        hasChoice ? req.body.acceptingChallenges : undefined
    );
    return res.json({ presence });
}));

app.get('/api/lobby', ...protectedApi, asyncRoute(async (req, res) => {
    await dataStore.ensurePlayer(req.user.id, req.query.name);
    await dataStore.touchPresence(req.user.id);
    return res.json(await dataStore.getLobbyState(req.user.id));
}));

app.post('/api/challenges', ...protectedApi, asyncRoute(async (req, res) => {
    const targetUserId = String(req.body.targetUserId || '');
    const challenger = await dataStore.ensurePlayer(req.user.id, req.body.name);
    const target = await dataStore.getPlayer(targetUserId);
    if (!target) return res.status(404).json({ error: '대전 상대를 찾을 수 없습니다.' });

    const challenge = await dataStore.createChallenge(req.user.id, targetUserId, Date.now() + CHALLENGE_TTL_MS);
    challenge.challenger = challenger;
    challenge.target = target;
    res.json(challenge);
    pushService.sendChallengeReceived(targetUserId, {
        challengeId: challenge.id,
        challengerName: challenger.name
    }).catch(error => console.error('[PUSH] Challenge notification failed:', error.message));
}));

app.post('/api/challenges/:id/respond', ...protectedApi, asyncRoute(async (req, res) => {
    const action = req.body.action;
    if (!['accept', 'decline'].includes(action)) {
        return res.status(400).json({ error: '수락 또는 거절을 선택해 주세요.' });
    }

    const lobby = await dataStore.getLobbyState(req.user.id);
    const pending = lobby.challenge;
    if (!pending || pending.id !== req.params.id || pending.direction !== 'incoming' || pending.status !== 'pending') {
        return res.status(404).json({ error: '처리할 대전 신청을 찾을 수 없습니다.' });
    }
    if (action === 'decline') {
        const challenge = await dataStore.respondToChallenge(req.params.id, req.user.id, action);
        return res.json({ challenge });
    }

    const challengerRoom = await dataStore.findActiveRoom(pending.challengerId);
    const targetRoom = await dataStore.findActiveRoom(pending.targetId);
    if (challengerRoom || targetRoom) {
        await dataStore.cancelChallenge(req.params.id);
        return res.status(409).json({ error: '한쪽 사용자가 이미 다른 대전에 참여 중입니다.' });
    }

    await dataStore.respondToChallenge(req.params.id, req.user.id, action);
    try {
        const [challenger, target] = await Promise.all([
            dataStore.getPlayer(pending.challengerId),
            dataStore.getPlayer(pending.targetId)
        ]);
        if (!challenger || !target) throw new Error('대전 참가자 정보를 찾을 수 없습니다.');
        const roomCode = await generateRoomCode(6);
        const room = createRoomState({
            roomCode,
            hostProfile: challenger,
            guestProfile: target,
            roomTitle: `${challenger.name} vs ${target.name}`,
            visibility: 'private'
        });
        rooms[roomCode] = room;
        await persistRoom(room);
        await dataStore.setChallengeRoom(req.params.id, roomCode);
        pushService.sendChallengeAccepted(challenger.id, {
            challengeId: req.params.id,
            roomCode,
            targetName: target.name
        }).catch(error => console.error('[PUSH] Challenge acceptance notification failed:', error.message));
        return res.json({ room: buildPublicRoomState(room, 'guest'), role: 'guest' });
    } catch (error) {
        await dataStore.cancelChallenge(req.params.id);
        throw error;
    }
}));

app.get('/api/me/active-room', ...protectedApi, asyncRoute(async (req, res) => {
    let room = Object.values(rooms)
        .filter(item => ['waiting', 'setup', 'playing'].includes(item.status))
        .filter(item => !item.expiresAt || item.expiresAt > Date.now())
        .filter(item => item.host.id === req.user.id || (item.guest && item.guest.id === req.user.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!room) room = await dataStore.findActiveRoom(req.user.id);
    if (!room) return res.json({ room: null });

    rooms[room.code] = room;
    const role = room.host.id === req.user.id ? 'host' : 'guest';
    return res.json({ room: buildPublicRoomState(room, role), role });
}));

app.post('/api/create', ...protectedApi, asyncRoute(async (req, res) => {
    const profile = await dataStore.ensurePlayer(req.user.id, req.body.hostName);
    const previous = await dataStore.findActiveRoom(req.user.id);
    if (previous && previous.status === 'playing') {
        return res.status(409).json({ error: '진행 중인 대전을 먼저 종료해 주세요.' });
    }
    if (previous) await removeRoom(previous.code);

    const visibility = req.body.visibility === 'private' ? 'private' : 'public';
    const roomCode = await generateRoomCode(visibility === 'private' ? 6 : 4);
    rooms[roomCode] = createRoomState({
        roomCode,
        hostProfile: profile,
        roomTitle: req.body.roomTitle,
        visibility
    });
    await persistRoom(rooms[roomCode]);
    console.log(`[API] Room created: ${roomCode} by ${profile.name}`);
    res.json(buildPublicRoomState(rooms[roomCode], 'host'));
}));

app.post('/api/join', ...protectedApi, asyncRoute(async (req, res) => {
    const room = await getRoom(req.body.room);
    if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (room.status !== 'waiting') return res.status(400).json({ error: '이미 게임이 진행 중이거나 가득 찬 방입니다.' });
    if (req.user.id === room.host.id) return res.status(400).json({ error: '같은 계정으로 만든 방에는 참가할 수 없습니다.' });

    const profile = await dataStore.ensurePlayer(req.user.id, req.body.guestName);
    const now = Date.now();
    room.guest = {
        id: req.user.id,
        name: profile.name,
        stats: profile,
        status: 'waiting',
        lastActive: now,
        disconnectSince: null
    };
    room.status = 'setup';
    room.expiresAt = now + SETUP_ROOM_TTL_MS;
    touchPlayer(room, 'host', now);
    touchPlayer(room, 'guest', now);
    await persistRoom(room);
    console.log(`[API] Player joined: ${profile.name} entered room ${room.code}`);
    res.json(buildPublicRoomState(room, 'guest'));
    pushService.sendRoomJoined(room.host.id, {
        roomCode: room.code,
        roomTitle: room.roomTitle,
        guestName: profile.name
    }).catch(error => console.error('[PUSH] Room join notification failed:', error.message));
}));

app.post('/api/ready', ...protectedApi, asyncRoute(async (req, res) => {
    const room = await getRoom(req.body.room);
    const role = req.body.role;
    if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (!userOwnsRole(room, role, req.user.id)) return res.status(403).json({ error: '이 플레이어를 조작할 권한이 없습니다.' });
    if (!isValidDigits(req.body.secret)) return res.status(400).json({ error: '서로 다른 숫자 4개를 입력해 주세요.' });

    touchPlayer(room, role);
    room.secrets[role] = normalizeDigits(req.body.secret);
    room[role].status = 'ready';
    if (room.host.status === 'ready' && room.guest && room.guest.status === 'ready') {
        room.status = 'playing';
        room.startedAt = Date.now();
        room.turnStartedAt = room.startedAt;
        room.expiresAt = room.startedAt + ACTIVE_ROOM_TTL_MS;
        console.log(`[API] Room ${room.code} - Match started.`);
    }
    await persistRoom(room);
    res.json(buildPublicRoomState(room, role));
}));

app.post('/api/guess', ...protectedApi, asyncRoute(async (req, res) => {
    const room = await getRoom(req.body.room);
    const role = req.body.role;
    if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (room.status !== 'playing') return res.status(400).json({ error: '진행 중인 게임이 아닙니다.' });
    if (!userOwnsRole(room, role, req.user.id)) return res.status(403).json({ error: '이 플레이어를 조작할 권한이 없습니다.' });
    if (room.currentTurn !== role) return res.status(409).json({ error: '내 공격 차례가 아닙니다.' });
    if (!isValidDigits(req.body.guess)) return res.status(400).json({ error: '서로 다른 숫자 4개를 입력해 주세요.' });

    touchPlayer(room, role);
    const opponentRole = role === 'host' ? 'guest' : 'host';
    const opponentSecret = room.secrets[opponentRole];
    if (!isValidDigits(opponentSecret)) return res.status(400).json({ error: '상대방이 아직 준비되지 않았습니다.' });

    const { strikes, balls } = calculateScore(req.body.guess, opponentSecret);
    room.guesses[role].push({
        guess: normalizeDigits(req.body.guess),
        strikes,
        balls,
        attempt: room.guesses[role].length + 1
    });
    if (strikes === DIGIT_COUNT) {
        await finishRoom(room, role, 'win');
        console.log(`[API] Room ${room.code} - Winner: ${role}`);
    } else {
        room.currentTurn = opponentRole;
        room.turnStartedAt = Date.now();
    }
    await persistRoom(room);
    res.json(buildPublicRoomState(room, role));
}));

app.get('/api/poll', ...protectedApi, asyncRoute(async (req, res) => {
    const room = await getRoom(req.query.room);
    const role = req.query.role;
    if (!room) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (!userOwnsRole(room, role, req.user.id)) return res.status(403).json({ error: '이 플레이어를 확인할 권한이 없습니다.' });
    if (room.status !== 'finished') touchPlayer(room, role);
    if (room.statsPromise) await room.statsPromise;
    res.json(buildPublicRoomState(room, role));
}));

app.post('/api/leave', ...protectedApi, asyncRoute(async (req, res) => {
    const room = await getRoom(req.body.room);
    const role = req.body.role;
    if (!room) return res.json({ success: true });
    if (!userOwnsRole(room, role, req.user.id)) {
        return res.status(403).json({ error: '이 방을 나갈 권한이 없습니다.' });
    }
    if (room.status === 'playing' && room.guest) {
        const winner = role === 'host' ? 'guest' : 'host';
        await finishRoom(room, winner, 'forfeit');
    } else {
        await removeRoom(room.code);
    }
    return res.json({ success: true });
}));

app.get('/api/rooms', ...protectedApi, asyncRoute(async (req, res) => {
    res.json(await dataStore.listWaitingRooms());
}));

app.post('/api/admin/seasons', asyncRoute(requireDataStore), asyncRoute(async (req, res) => {
    const expected = process.env.ADMIN_API_TOKEN || '';
    if (!expected || req.headers['x-admin-token'] !== expected) {
        return res.status(403).json({ error: '관리자 권한이 필요합니다.' });
    }
    const season = await dataStore.startSeason(req.body.name);
    return res.json({ success: true, season });
}));

app.all('/api/ranking', (req, res) => {
    res.status(410).json({ error: 'v6에서는 앱에서 전적을 직접 수정할 수 없습니다.' });
});

app.all('/api/ranking/:id', (req, res) => {
    res.status(410).json({ error: 'v6에서는 개인 전적을 공개 ID로 조회하지 않습니다.' });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((error, req, res, next) => {
    console.error(`[API] ${req.method} ${req.path}:`, error);
    if (res.headersSent) return next(error);
    return res.status(error.status || 500).json({ error: error.message || '서버 오류가 발생했습니다.' });
});

let httpServer = null;
if (require.main === module) {
    httpServer = app.listen(PORT, () => {
        console.log(`Home Run Baseball v12 server is running on port ${PORT}`);
    });
}

module.exports = {
    app,
    httpServer,
    _internals: {
        calculateScore,
        dataStore,
        dataStoreReady,
        finishRoom,
        monitorConnections,
        rooms,
        pushService,
        constants: {
            TURN_TIMEOUT_MS,
            HEARTBEAT_STALE_MS,
            DISCONNECT_GRACE_MS,
            WAITING_ROOM_TTL_MS,
            SETUP_ROOM_TTL_MS,
            CHALLENGE_TTL_MS
        }
    }
};
