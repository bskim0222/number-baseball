const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Memory Storage for active rooms and rankings
let rooms = {};
let rankings = {};
const RANKINGS_FILE = path.join(__dirname, 'rankings.json');

// Load rankings from file on startup
if (fs.existsSync(RANKINGS_FILE)) {
    try {
        rankings = JSON.parse(fs.readFileSync(RANKINGS_FILE, 'utf8'));
    } catch (e) {
        console.warn("Failed to load rankings.json:", e);
    }
}

// --------------------------------------------------------------------------
// BACKGROUND DISCONNECTION & TIMEOUT WATCHDOG LOOP (Runs every 2 seconds)
// --------------------------------------------------------------------------
setInterval(() => {
    const now = Date.now();
    Object.keys(rooms).forEach(roomCode => {
        const room = rooms[roomCode];
        if (room.status !== 'finished') {
            // Check Host Disconnection (inactive for > 6 seconds)
            if (room.guest && (now - room.host.lastActive) > 6000) {
                room.status = 'finished';
                room.winner = 'guest';
                room.reason = 'disconnect';
                console.log(`[WATCHDOG] Room ${roomCode} - Host disconnected. Forfeit victory to Guest.`);
            }
            // Check Guest Disconnection (only if guest has entered room)
            else if (room.guest && (now - room.guest.lastActive) > 6000) {
                room.status = 'finished';
                room.winner = 'host';
                room.reason = 'disconnect';
                console.log(`[WATCHDOG] Room ${roomCode} - Guest disconnected. Forfeit victory to Host.`);
            }
            // Check Turn Timeout (60 seconds limit)
            else if (room.status === 'playing' && (now - room.turnStartedAt) > 60000) {
                room.status = 'finished';
                room.winner = room.currentTurn === 'host' ? 'guest' : 'host';
                room.reason = 'timeout';
                console.log(`[WATCHDOG] Room ${roomCode} - Turn timed out. Forfeit victory to ${room.winner}.`);
            }
        }
    });
}, 2000);

// --------------------------------------------------------------------------
// REST API ROUTING
// --------------------------------------------------------------------------

// 1. Create Room
app.post('/api/create', (req, res) => {
    const { hostId, hostName } = req.body;
    let roomCode;
    do {
        roomCode = String(Math.floor(1000 + Math.random() * 9000));
    } while (rooms[roomCode]);

    const now = Date.now();
    rooms[roomCode] = {
        code: roomCode,
        status: 'waiting',
        host: { id: hostId, name: hostName, status: 'waiting', lastActive: now },
        guest: null,
        currentTurn: 'host',
        guesses: { host: [], guest: [] },
        secrets: { host: [], guest: [] },
        winner: '',
        turnStartedAt: now,
        reason: ''
    };

    console.log(`[API] Room Created: ${roomCode} by ${hostName}`);
    res.json(rooms[roomCode]);
});

// 2. Join Room
app.post('/api/join', (req, res) => {
    const { room, guestId, guestName } = req.body;
    const roomState = rooms[room];

    if (!roomState) {
        return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    }
    if (roomState.status !== 'waiting') {
        return res.status(400).json({ error: '이미 게임이 진행 중이거나 가득 찬 방입니다.' });
    }

    const now = Date.now();
    roomState.guest = { id: guestId, name: guestName, status: 'waiting', lastActive: now };
    roomState.status = 'setup';

    console.log(`[API] Player Joined: ${guestName} entered room ${room}`);
    res.json(roomState);
});

// 3. Set Ready / Secret submit
app.post('/api/ready', (req, res) => {
    const { room, role, secret } = req.body;
    const roomState = rooms[room];

    if (!roomState) {
        return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    }

    roomState.secrets[role] = secret;
    roomState[role].status = 'ready';

    // If both host and guest submitted secrets, start the match!
    if (roomState.host.status === 'ready' && roomState.guest && roomState.guest.status === 'ready') {
        roomState.status = 'playing';
        roomState.turnStartedAt = Date.now();
        console.log(`[API] Room ${room} - Match started playing!`);
    }

    res.json(roomState);
});

// 4. Submit Turn Guess
app.post('/api/guess', (req, res) => {
    const { room, role, guess, strikes, balls, attempt } = req.body;
    const roomState = rooms[room];

    if (!roomState) {
        return res.status(404).json({ error: '방을 찾을 수 없습니다.' });
    }

    const guessObj = { guess, strikes, balls, attempt };
    roomState.guesses[role].push(guessObj);

    if (strikes === 4) {
        roomState.status = 'finished';
        roomState.winner = role;
        roomState.reason = 'win';
        console.log(`[API] Room ${room} - Winner declared: ${role}`);
    } else {
        roomState.currentTurn = role === 'host' ? 'guest' : 'host';
        roomState.turnStartedAt = Date.now();
    }

    res.json(roomState);
});

// 5. Poll Room State
app.get('/api/poll', (req, res) => {
    const { room, role } = req.query;
    const roomState = rooms[room];

    if (!roomState) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const now = Date.now();
    if (roomState.status !== 'finished') {
        if (role === 'host') {
            roomState.host.lastActive = now;
        } else if (role === 'guest' && roomState.guest) {
            roomState.guest.lastActive = now;
        }
    }

    // Strip real opponent secrets to prevent client-side inspect cheating
    const filteredSecrets = {
        host: (roomState.secrets.host.length > 0 && role === 'guest') ? [9, 9, 9, 9] : roomState.secrets.host,
        guest: (roomState.secrets.guest.length > 0 && role === 'host') ? [9, 9, 9, 9] : roomState.secrets.guest
    };

    res.json({
        code: roomState.code,
        status: roomState.status,
        host: roomState.host,
        guest: roomState.guest,
        currentTurn: roomState.currentTurn,
        guesses: roomState.guesses,
        winner: roomState.winner,
        reason: roomState.reason,
        turnStartedAt: roomState.turnStartedAt,
        secrets: filteredSecrets
    });
});

// 6. Get Public Rooms List
app.get('/api/rooms', (req, res) => {
    const activeRooms = [];
    const now = Date.now();

    Object.keys(rooms).forEach(code => {
        const room = rooms[code];
        if (room.status === 'waiting' && (now - room.host.lastActive) < 8000) {
            activeRooms.push({
                code: room.code,
                hostName: room.host.name
            });
        }
    });

    res.json(activeRooms);
});

// 7. Get Rankings Leaderboard
app.get('/api/rankings', (req, res) => {
    const list = Object.values(rankings);
    res.json(list);
});

// 8. Register/Sync Player Score
app.post('/api/ranking', (req, res) => {
    const p = req.body;
    rankings[p.id] = {
        id: p.id,
        name: p.name,
        wins: p.wins,
        losses: p.losses,
        rate: p.rate
    };

    // Save back to rankings.json asynchronously
    fs.writeFile(RANKINGS_FILE, JSON.stringify(rankings, null, 4), (err) => {
        if (err) console.error("Failed to save rankings.json:", err);
    });

    res.json({ success: true });
});

// Serve main frontend entrypoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Production Game Server is running on port ${PORT}`);
});
