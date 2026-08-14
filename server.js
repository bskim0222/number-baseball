const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

let rooms = {};
let rankings = {};

const DIGIT_COUNT = 4;
const TURN_TIMEOUT_MS = 60_000;
const HEARTBEAT_STALE_MS = 5_000;
const DISCONNECT_GRACE_MS = 25_000;
const WAITING_ROOM_VISIBLE_MS = 30_000;
const FINISHED_ROOM_RETENTION_MS = 10 * 60_000;
const RANKINGS_FILE = process.env.RANKINGS_FILE || path.join(__dirname, 'rankings.json');

let rankingWriteQueue = Promise.resolve();

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
        if (digit === secretDigits[index]) {
            strikes++;
        } else if (secretDigits.includes(digit)) {
            balls++;
        }
    });

    return { strikes, balls };
}

function safeInteger(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function safePlayerId(value) {
    return typeof value === 'string' ? value.trim().slice(0, 80) : '';
}

function safePlayerName(value) {
    const name = typeof value === 'string' ? value.trim().slice(0, 12) : '';
    return name || '야구유저';
}

function calculateRate(wins, losses) {
    const total = wins + losses;
    return total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;
}

function defaultRating(wins, losses) {
    return Math.max(100, 1000 + ((wins - losses) * 16));
}

function normalizeRanking(record, fallbackId = '') {
    const wins = safeInteger(record && record.wins);
    const losses = safeInteger(record && record.losses);
    const suppliedRating = Number(record && record.rating);

    return {
        id: safePlayerId((record && record.id) || fallbackId),
        name: safePlayerName(record && record.name),
        wins,
        losses,
        rate: calculateRate(wins, losses),
        rating: Number.isFinite(suppliedRating)
            ? Math.max(100, Math.round(suppliedRating))
            : defaultRating(wins, losses),
        updatedAt: Number(record && record.updatedAt) || Date.now()
    };
}

function publicRanking(record) {
    const normalized = normalizeRanking(record);
    return {
        id: normalized.id,
        name: normalized.name,
        wins: normalized.wins,
        losses: normalized.losses,
        games: normalized.wins + normalized.losses,
        rate: normalized.rate,
        rating: normalized.rating
    };
}

function sortRankings(list) {
    return list.sort((a, b) => (
        b.rating - a.rating
        || b.wins - a.wins
        || a.losses - b.losses
        || a.name.localeCompare(b.name, 'ko')
    ));
}

function persistRankings() {
    const snapshot = JSON.stringify(rankings, null, 2);
    rankingWriteQueue = rankingWriteQueue
        .catch(() => {})
        .then(async () => {
            await fs.promises.mkdir(path.dirname(RANKINGS_FILE), { recursive: true });
            await fs.promises.writeFile(RANKINGS_FILE, snapshot, 'utf8');
        })
        .catch(error => {
            console.error('Failed to save rankings:', error);
        });
    return rankingWriteQueue;
}

function ensureRanking(player) {
    if (!player) return null;
    const id = safePlayerId(player.id);
    if (!id) return null;

    if (!rankings[id]) {
        rankings[id] = normalizeRanking({ id, name: player.name });
    } else {
        rankings[id] = normalizeRanking(rankings[id], id);
        rankings[id].name = safePlayerName(player.name || rankings[id].name);
    }
    return rankings[id];
}

function mergePlayerBackup(player) {
    const record = ensureRanking(player);
    if (!record) return null;

    const incomingWins = safeInteger(player.wins);
    const incomingLosses = safeInteger(player.losses);
    const incomingGames = incomingWins + incomingLosses;
    const currentGames = record.wins + record.losses;

    // A device copy can restore a player's record after an ephemeral server restart.
    // Existing server totals are never replaced by an older or equal client copy.
    if (incomingGames > currentGames) {
        record.wins = incomingWins;
        record.losses = incomingLosses;
        const suppliedRating = Number(player.rating);
        record.rating = Number.isFinite(suppliedRating)
            ? Math.max(100, Math.round(suppliedRating))
            : defaultRating(incomingWins, incomingLosses);
    }

    record.name = safePlayerName(player.name || record.name);
    record.rate = calculateRate(record.wins, record.losses);
    record.updatedAt = Date.now();
    return record;
}

function recordRankedMatch(roomState) {
    if (roomState.statsRecorded || !roomState.startedAt || !roomState.guest) return;

    const winnerRole = roomState.winner;
    const loserRole = winnerRole === 'host' ? 'guest' : 'host';
    if (!['host', 'guest'].includes(winnerRole)) return;

    const winner = ensureRanking(roomState[winnerRole]);
    const loser = ensureRanking(roomState[loserRole]);
    if (!winner || !loser) return;

    const winnerExpected = 1 / (1 + Math.pow(10, (loser.rating - winner.rating) / 400));
    const ratingChange = Math.max(8, Math.round(32 * (1 - winnerExpected)));

    winner.wins += 1;
    loser.losses += 1;
    winner.rating += ratingChange;
    loser.rating = Math.max(100, loser.rating - ratingChange);
    winner.rate = calculateRate(winner.wins, winner.losses);
    loser.rate = calculateRate(loser.wins, loser.losses);
    winner.updatedAt = Date.now();
    loser.updatedAt = Date.now();

    roomState.statsRecorded = true;
    roomState.ratingChanges = {
        [winnerRole]: ratingChange,
        [loserRole]: -ratingChange
    };
    persistRankings();
}

function finishRoom(roomState, winner, reason) {
    if (!roomState || roomState.status === 'finished') return;
    roomState.status = 'finished';
    roomState.winner = winner;
    roomState.reason = reason;
    roomState.finishedAt = Date.now();
    recordRankedMatch(roomState);
}

function publicPlayer(player) {
    if (!player) return null;
    return {
        id: player.id,
        name: player.name,
        status: player.status
    };
}

function buildPublicRoomState(roomState, role) {
    const filteredSecrets = {
        host: roomState.status === 'finished' || role === 'host' ? roomState.secrets.host : [],
        guest: roomState.status === 'finished' || role === 'guest' ? roomState.secrets.guest : []
    };
    const player = roomState[role];

    return {
        code: roomState.code,
        status: roomState.status,
        host: publicPlayer(roomState.host),
        guest: publicPlayer(roomState.guest),
        currentTurn: roomState.currentTurn,
        guesses: roomState.guesses,
        winner: roomState.winner,
        reason: roomState.reason,
        turnStartedAt: roomState.turnStartedAt,
        turnDurationMs: TURN_TIMEOUT_MS,
        disconnectGraceMs: HEARTBEAT_STALE_MS + DISCONNECT_GRACE_MS,
        statsRecorded: roomState.statsRecorded,
        ratingChange: roomState.ratingChanges ? roomState.ratingChanges[role] || 0 : 0,
        playerStats: player && rankings[player.id] ? publicRanking(rankings[player.id]) : null,
        secrets: filteredSecrets
    };
}

function touchPlayer(roomState, role, now = Date.now()) {
    if (!roomState || !['host', 'guest'].includes(role) || !roomState[role]) return false;

    if (roomState.guest) {
        const hostWasStale = now - roomState.host.lastActive > HEARTBEAT_STALE_MS;
        const guestWasStale = now - roomState.guest.lastActive > HEARTBEAT_STALE_MS;
        if (hostWasStale && guestWasStale) {
            // Resume fairly after a server sleep or a shared network outage.
            roomState.host.lastActive = now;
            roomState.guest.lastActive = now;
            roomState.host.disconnectSince = null;
            roomState.guest.disconnectSince = null;
            if (roomState.status === 'playing') roomState.turnStartedAt = now;
        }
    }

    roomState[role].lastActive = now;
    roomState[role].disconnectSince = null;
    return true;
}

function monitorConnections(roomState, now) {
    if (!roomState.guest || !['setup', 'playing'].includes(roomState.status)) return;

    const hostStale = now - roomState.host.lastActive > HEARTBEAT_STALE_MS;
    const guestStale = now - roomState.guest.lastActive > HEARTBEAT_STALE_MS;

    if (hostStale && guestStale) {
        roomState.host.disconnectSince = null;
        roomState.guest.disconnectSince = null;
        return;
    }

    const checks = [
        { role: 'host', stale: hostStale, opponentStale: guestStale, winner: 'guest' },
        { role: 'guest', stale: guestStale, opponentStale: hostStale, winner: 'host' }
    ];

    checks.forEach(check => {
        const player = roomState[check.role];
        if (!player || roomState.status === 'finished') return;

        if (check.stale && !check.opponentStale) {
            if (!player.disconnectSince) player.disconnectSince = now;
            if (now - player.disconnectSince >= DISCONNECT_GRACE_MS) {
                finishRoom(roomState, check.winner, 'disconnect');
                console.log(`[WATCHDOG] Room ${roomState.code} - ${check.role} failed to reconnect.`);
            }
        } else {
            player.disconnectSince = null;
        }
    });
}

function loadRankings() {
    if (!fs.existsSync(RANKINGS_FILE)) return;
    try {
        const stored = JSON.parse(fs.readFileSync(RANKINGS_FILE, 'utf8'));
        rankings = Object.fromEntries(
            Object.entries(stored || {})
                .map(([id, record]) => [safePlayerId(id), normalizeRanking(record, id)])
                .filter(([id]) => id)
        );
    } catch (error) {
        console.warn('Failed to load rankings:', error);
    }
}

loadRankings();

const watchdogInterval = setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomCode => {
        const room = rooms[roomCode];

        if (room.status === 'finished') {
            if (room.finishedAt && now - room.finishedAt > FINISHED_ROOM_RETENTION_MS) {
                delete rooms[roomCode];
            }
            return;
        }

        const bothStale = room.guest
            && now - room.host.lastActive > HEARTBEAT_STALE_MS
            && now - room.guest.lastActive > HEARTBEAT_STALE_MS;

        if (room.status === 'playing' && !bothStale && now - room.turnStartedAt >= TURN_TIMEOUT_MS) {
            const winner = room.currentTurn === 'host' ? 'guest' : 'host';
            finishRoom(room, winner, 'timeout');
            console.log(`[WATCHDOG] Room ${roomCode} - Turn timed out. Winner: ${winner}.`);
            return;
        }

        monitorConnections(room, now);
    });
}, 1000);
watchdogInterval.unref();

app.get('/api/health', (req, res) => {
    res.json({
        ok: true,
        service: 'homerunbaseball',
        time: Date.now(),
        activeRooms: Object.keys(rooms).length,
        rankedPlayers: Object.keys(rankings).length
    });
});

app.post('/api/create', (req, res) => {
    const hostId = safePlayerId(req.body.hostId);
    const hostName = safePlayerName(req.body.hostName);
    if (!hostId) return res.status(400).json({ error: '플레이어 정보를 확인해 주세요.' });

    let roomCode;
    do {
        roomCode = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms[roomCode]);

    const now = Date.now();
    rooms[roomCode] = {
        code: roomCode,
        status: 'waiting',
        host: { id: hostId, name: hostName, status: 'waiting', lastActive: now, disconnectSince: null },
        guest: null,
        currentTurn: 'host',
        guesses: { host: [], guest: [] },
        secrets: { host: [], guest: [] },
        winner: '',
        reason: '',
        turnStartedAt: now,
        startedAt: null,
        finishedAt: null,
        statsRecorded: false,
        ratingChanges: null
    };

    ensureRanking(rooms[roomCode].host);
    persistRankings();
    console.log(`[API] Room created: ${roomCode} by ${hostName}`);
    res.json(buildPublicRoomState(rooms[roomCode], 'host'));
});

app.post('/api/join', (req, res) => {
    const roomState = rooms[String(req.body.room || '')];
    if (!roomState) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (roomState.status !== 'waiting') {
        return res.status(400).json({ error: '이미 게임이 진행 중이거나 가득 찬 방입니다.' });
    }

    const guestId = safePlayerId(req.body.guestId);
    const guestName = safePlayerName(req.body.guestName);
    if (!guestId) return res.status(400).json({ error: '플레이어 정보를 확인해 주세요.' });
    if (guestId === roomState.host.id) {
        return res.status(400).json({ error: '같은 계정으로 만든 방에는 참가할 수 없습니다.' });
    }

    const now = Date.now();
    roomState.guest = {
        id: guestId,
        name: guestName,
        status: 'waiting',
        lastActive: now,
        disconnectSince: null
    };
    roomState.status = 'setup';
    touchPlayer(roomState, 'host', now);
    touchPlayer(roomState, 'guest', now);
    ensureRanking(roomState.guest);
    persistRankings();

    console.log(`[API] Player joined: ${guestName} entered room ${roomState.code}`);
    res.json(buildPublicRoomState(roomState, 'guest'));
});

app.post('/api/ready', (req, res) => {
    const roomState = rooms[String(req.body.room || '')];
    const role = req.body.role;
    if (!roomState) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (!['host', 'guest'].includes(role) || !roomState[role]) {
        return res.status(400).json({ error: '플레이어 역할을 확인할 수 없습니다.' });
    }
    if (!isValidDigits(req.body.secret)) {
        return res.status(400).json({ error: '서로 다른 숫자 4개를 입력해 주세요.' });
    }

    touchPlayer(roomState, role);
    roomState.secrets[role] = normalizeDigits(req.body.secret);
    roomState[role].status = 'ready';

    if (roomState.host.status === 'ready' && roomState.guest && roomState.guest.status === 'ready') {
        roomState.status = 'playing';
        roomState.startedAt = Date.now();
        roomState.turnStartedAt = roomState.startedAt;
        console.log(`[API] Room ${roomState.code} - Match started.`);
    }

    res.json(buildPublicRoomState(roomState, role));
});

app.post('/api/guess', (req, res) => {
    const roomState = rooms[String(req.body.room || '')];
    const role = req.body.role;
    if (!roomState) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (roomState.status !== 'playing') return res.status(400).json({ error: '진행 중인 게임이 아닙니다.' });
    if (!['host', 'guest'].includes(role) || !roomState[role]) {
        return res.status(400).json({ error: '플레이어 역할을 확인할 수 없습니다.' });
    }
    if (roomState.currentTurn !== role) return res.status(409).json({ error: '내 공격 차례가 아닙니다.' });
    if (!isValidDigits(req.body.guess)) {
        return res.status(400).json({ error: '서로 다른 숫자 4개를 입력해 주세요.' });
    }

    touchPlayer(roomState, role);
    const opponentRole = role === 'host' ? 'guest' : 'host';
    const opponentSecret = roomState.secrets[opponentRole];
    if (!isValidDigits(opponentSecret)) {
        return res.status(400).json({ error: '상대방이 아직 준비되지 않았습니다.' });
    }

    const { strikes, balls } = calculateScore(req.body.guess, opponentSecret);
    const guessObj = {
        guess: normalizeDigits(req.body.guess),
        strikes,
        balls,
        attempt: roomState.guesses[role].length + 1
    };
    roomState.guesses[role].push(guessObj);

    if (strikes === DIGIT_COUNT) {
        finishRoom(roomState, role, 'win');
        console.log(`[API] Room ${roomState.code} - Winner: ${role}`);
    } else {
        roomState.currentTurn = opponentRole;
        roomState.turnStartedAt = Date.now();
    }

    res.json(buildPublicRoomState(roomState, role));
});

app.get('/api/poll', (req, res) => {
    const roomState = rooms[String(req.query.room || '')];
    const role = req.query.role;
    if (!roomState) return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    if (!['host', 'guest'].includes(role) || !roomState[role]) {
        return res.status(400).json({ error: '플레이어 역할을 확인할 수 없습니다.' });
    }

    if (roomState.status !== 'finished') touchPlayer(roomState, role);
    res.json(buildPublicRoomState(roomState, role));
});

app.get('/api/rooms', (req, res) => {
    const now = Date.now();
    const activeRooms = Object.values(rooms)
        .filter(room => room.status === 'waiting' && now - room.host.lastActive < WAITING_ROOM_VISIBLE_MS)
        .map(room => ({ code: room.code, hostName: room.host.name }));
    res.json(activeRooms);
});

app.get('/api/rankings', (req, res) => {
    const list = sortRankings(Object.values(rankings).map(publicRanking));
    res.json(list);
});

app.get('/api/ranking/:id', (req, res) => {
    const id = safePlayerId(req.params.id);
    const record = rankings[id];
    if (!record) return res.status(404).json({ error: '아직 대전 기록이 없습니다.' });
    res.json(publicRanking(record));
});

app.post('/api/ranking', (req, res) => {
    const player = req.body || {};
    if (!safePlayerId(player.id)) {
        return res.status(400).json({ error: '플레이어 정보를 확인해 주세요.' });
    }

    const record = mergePlayerBackup(player);
    persistRankings();
    res.json({ success: true, player: publicRanking(record) });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

let httpServer = null;
if (require.main === module) {
    httpServer = app.listen(PORT, () => {
        console.log(`Production Game Server is running on port ${PORT}`);
    });
}

module.exports = {
    app,
    httpServer,
    _internals: {
        calculateScore,
        flushRankingWrites: () => rankingWriteQueue,
        monitorConnections,
        normalizeRanking,
        sortRankings,
        constants: {
            TURN_TIMEOUT_MS,
            HEARTBEAT_STALE_MS,
            DISCONNECT_GRACE_MS
        }
    }
};
