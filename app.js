/**
 * 홈런 숫자야구 - App-in-Toss & Local Wi-Fi REST API Integration
 */

// Game Constants
const DIGIT_COUNT = 4;
const MAX_ATTEMPTS = 10;
const STORAGE_KEY_BEST = 'number_baseball_best_4digit';

// Resolve Server IP automatically (falls back to local server IP)
const API_BASE = (window.isAutomatedTest) 
                 ? 'http://127.0.0.1:9999-blocked'
                 : ((window.location.origin && window.location.origin.startsWith('http')) 
                    ? window.location.origin 
                    : 'http://192.168.123.108:8000');

// Game State
let gameMode = 'solo'; // 'solo' or 'multi'
let currentScreen = 'screen-lobby';
let secretNumbers = []; // Opponent's secret (the one I need to guess)
let mySecretNumbers = []; // My secret (the one opponent needs to guess, in multi mode)
let currentGuess = [];
let mySecretInput = [];
let attemptsLeft = MAX_ATTEMPTS;
let isMyTurn = true;
let isGameOver = false;

// Player Profile (Toss Bridge)
let myPlayer = { name: "로딩 중...", id: "TOSS-GUEST", avatar: "fa-solid fa-circle-user", wins: 0, losses: 0, rate: 0 };
let opponentPlayer = null;

// Room Info
let currentRoomCode = '';
let opponentName = '상대 대기 중...';
let myRole = ''; // 'host' or 'guest'
let pollInterval = null;
let lobbyInterval = null; // Used to poll waiting room list in lobby
let lastRoomDataJson = ''; // Used to prevent redundant redraws
let lastMyGuessesJson = '';
let lastOppGuessesJson = '';
let lastSpokenMyAttempt = 0;
let gameAudioContext = null;

// Mock Leaderboard for Offline Fallback
const mockRankings = [
    { name: '김토스', wins: 78, losses: 12, rate: 86.6, isMe: false },
    { name: '홈런왕김자바', wins: 65, losses: 15, rate: 81.3, isMe: false },
    { name: '금융천재야구초보', wins: 54, losses: 18, rate: 75.0, isMe: false },
    { name: '도토리수집가', wins: 48, losses: 20, rate: 70.6, isMe: false },
    { name: '삼진아웃클럽', wins: 40, losses: 22, rate: 64.5, isMe: false }
];

// DOM Screen Elements
const screens = {
    lobby: document.getElementById('screen-lobby'),
    leaderboard: document.getElementById('screen-leaderboard'),
    waiting: document.getElementById('screen-waiting'),
    game: document.getElementById('screen-game')
};

// DOM Slots & Display Elements
const slots = Array.from({ length: DIGIT_COUNT }, (_, i) => document.getElementById(`slot-${i}`));
const setupSlots = Array.from({ length: DIGIT_COUNT }, (_, i) => document.getElementById(`setup-${i}`));
const attemptsLeftEl = document.getElementById('attempts-left');
const bestScoreEl = document.getElementById('best-score');
const myHistoryContainer = document.getElementById('my-history-container');
const oppHistoryContainer = document.getElementById('opp-history-container');
const keypadButtons = document.querySelectorAll('.key-btn');

// Opponent Turn simulation panel elements
const turnBulb = document.getElementById('turn-bulb');
const turnText = document.getElementById('turn-text');
const playerMeBox = document.getElementById('player-me-box');
const playerOppBox = document.getElementById('player-opp-box');
const btnSimulateOpp = document.getElementById('btn-simulate-opp');

// Modals
const rulesModal = document.getElementById('rules-modal');
const resultModal = document.getElementById('result-modal');
const joinModal = document.getElementById('join-modal');

// Result Modal Elements
const resultBadge = document.getElementById('result-badge');
const resultTitle = document.getElementById('result-title');
const resultMessage = document.getElementById('result-message');
const resultSecret = document.getElementById('result-secret');
const resultAttempts = document.getElementById('result-attempts');
const btnRestart = document.getElementById('btn-restart');

function hydrateRulesModal() {
    if (!rulesModal) return;

    const title = rulesModal.querySelector('.modal-header h2');
    const body = rulesModal.querySelector('.modal-body');

    if (title) {
        title.innerHTML = '<i class="fa-solid fa-book-open"></i> 게임 방법';
    }

    if (body) {
        body.innerHTML = `
            <p class="modal-desc">상대가 정한 <strong>서로 다른 4자리 숫자</strong>를 먼저 맞히면 승리합니다.</p>
            <div class="rules-box">
                <div class="rule-item">
                    <span class="badge strike">S</span>
                    <div class="rule-text"><strong>스트라이크</strong> 숫자와 자리가 모두 맞을 때 표시됩니다.</div>
                </div>
                <div class="rule-item">
                    <span class="badge ball">B</span>
                    <div class="rule-text"><strong>볼</strong> 숫자는 맞지만 자리가 다를 때 표시됩니다.</div>
                </div>
                <div class="rule-item">
                    <span class="badge out">OUT</span>
                    <div class="rule-text"><strong>아웃</strong> 맞는 숫자가 하나도 없을 때 표시됩니다.</div>
                </div>
            </div>
            <div class="example-box">
                <p class="example-title"><strong>1:1 대전 진행</strong></p>
                <ul>
                    <li>각자 상대가 맞혀야 할 비밀 숫자 4개를 먼저 정합니다.</li>
                    <li>차례가 오면 중복 없는 숫자 4개를 입력하고 확인을 누릅니다.</li>
                    <li>서버가 실제 상대 숫자로 S/B/OUT을 판정합니다.</li>
                    <li>먼저 <strong>4 스트라이크</strong>를 만들면 홈런 승리입니다.</li>
                </ul>
            </div>
            <p class="attempts-info">예: 정답이 1 2 3 4일 때 1 3 8 9를 입력하면 1S 1B입니다.</p>
        `;
    }
}

// Helper for safe event listener registration
function safeAddListener(idOrEl, event, callback) {
    const el = typeof idOrEl === 'string' ? document.getElementById(idOrEl) : idOrEl;
    if (el) {
        el.addEventListener(event, callback);
    } else {
        console.warn(`safeAddListener: Element [${idOrEl}] not found.`);
    }
}

function toSafeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizePlayerStats(player) {
    const wins = Math.max(0, Math.floor(toSafeNumber(player && player.wins)));
    const losses = Math.max(0, Math.floor(toSafeNumber(player && player.losses)));
    const total = wins + losses;
    const calculatedRate = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
    const rate = Number.isFinite(Number(player && player.rate)) ? Number(player.rate) : calculatedRate;

    return {
        ...player,
        wins,
        losses,
        rate: total > 0 ? rate : 0
    };
}

function mergePlayerProfile(profile) {
    myPlayer = normalizePlayerStats({
        ...myPlayer,
        ...profile,
        wins: profile && profile.wins !== undefined ? profile.wins : myPlayer.wins,
        losses: profile && profile.losses !== undefined ? profile.losses : myPlayer.losses,
        rate: profile && profile.rate !== undefined ? profile.rate : myPlayer.rate
    });
}

function updateLobbyProfileName() {
    const nameEl = document.getElementById('lobby-profile-name');
    if (nameEl) {
        nameEl.innerHTML = `${myPlayer.name || '게스트'} <i class="fa-solid fa-pen-to-square edit-icon" style="font-size: 0.8rem; margin-left: 5px; opacity: 0.6;"></i>`;
    }
}

function resetRealtimeRenderCache() {
    lastRoomDataJson = '';
    lastMyGuessesJson = '';
    lastOppGuessesJson = '';
    lastSpokenMyAttempt = 0;
}

function getResultVoiceText(strikes, balls) {
    if (strikes === DIGIT_COUNT) return '홈런!';
    if (strikes === 0 && balls === 0) return '아웃!';

    const countWords = ['', '원', '투', '쓰리', '포'];
    const parts = [];
    if (strikes > 0) parts.push(`${countWords[strikes] || strikes} 스트라이크`);
    if (balls > 0) parts.push(`${countWords[balls] || balls} 볼`);
    return `${parts.join(' ')}!`;
}

function getAudioContext() {
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) return null;
        if (!gameAudioContext) gameAudioContext = new AudioContextClass();
        if (gameAudioContext.state === 'suspended') {
            gameAudioContext.resume().catch(() => {});
        }
        return gameAudioContext;
    } catch (err) {
        return null;
    }
}

function playTone(freq, delay, duration, type = 'sine', volume = 0.08) {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = ctx.currentTime + delay;
    const end = start + duration;

    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end + 0.02);
}

function playResultJingle(strikes, balls) {
    if (strikes === DIGIT_COUNT) {
        playTone(523, 0, 0.08, 'triangle', 0.1);
        playTone(659, 0.09, 0.08, 'triangle', 0.1);
        playTone(784, 0.18, 0.16, 'triangle', 0.11);
    } else if (strikes === 0 && balls === 0) {
        playTone(180, 0, 0.16, 'sawtooth', 0.06);
    } else {
        const total = strikes + balls;
        for (let i = 0; i < total; i++) {
            playTone(strikes > i ? 620 : 420, i * 0.07, 0.05, 'square', 0.045);
        }
    }
}

function speakResult(strikes, balls) {
    const text = getResultVoiceText(strikes, balls);
    playResultJingle(strikes, balls);

    try {
        if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return;
        window.speechSynthesis.cancel();
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = 'ko-KR';
        utterance.rate = 1.08;
        utterance.pitch = strikes === DIGIT_COUNT ? 1.18 : 1.02;
        utterance.volume = 1;
        setTimeout(() => window.speechSynthesis.speak(utterance), 90);
    } catch (err) {
        // Sound feedback is optional; never block gameplay.
    }
}

/* ==========================================================================
   INITIALIZATION (유저 로그인 및 초기 연결)
   ========================================================================== */

function playNoise(delay, duration, volume = 0.04) {
    const ctx = getAudioContext();
    if (!ctx) return;

    const sampleRate = ctx.sampleRate;
    const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(sampleRate * duration)), sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
        data[i] = (Math.random() * 2 - 1) * 0.55;
    }

    const source = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    const start = ctx.currentTime + delay;
    const end = start + duration;

    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(900, start);
    filter.Q.setValueAtTime(0.7, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(volume, start + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    source.buffer = buffer;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    source.start(start);
    source.stop(end + 0.02);
}

function playStartMusic() {
    playNoise(0, 0.45, 0.018);
    playTone(392, 0.02, 0.12, 'triangle', 0.08);
    playTone(523, 0.16, 0.12, 'triangle', 0.08);
    playTone(659, 0.30, 0.16, 'triangle', 0.09);
    playTone(784, 0.48, 0.22, 'triangle', 0.1);
    playTone(1046, 0.50, 0.18, 'sine', 0.035);
}

function playUmpireCue(strikes, balls) {
    if (strikes === DIGIT_COUNT) {
        playTone(330, 0, 0.08, 'square', 0.07);
        playTone(440, 0.10, 0.08, 'square', 0.07);
        playTone(660, 0.20, 0.20, 'triangle', 0.1);
        playNoise(0.05, 0.24, 0.02);
        return;
    }

    if (strikes === 0 && balls === 0) {
        playTone(190, 0, 0.10, 'sawtooth', 0.08);
        playTone(135, 0.12, 0.16, 'sawtooth', 0.07);
        return;
    }

    const total = strikes + balls;
    for (let i = 0; i < total; i++) {
        const isStrikeTone = i < strikes;
        playTone(isStrikeTone ? 360 : 250, i * 0.09, 0.055, 'square', isStrikeTone ? 0.06 : 0.045);
    }
}

function getRefereeVoiceText(strikes, balls) {
    if (strikes === DIGIT_COUNT) return '홈런!';
    if (strikes === 0 && balls === 0) return '아웃!';

    const countWords = ['', '원', '투', '쓰리', '포'];
    const parts = [];
    if (strikes > 0) parts.push(`${countWords[strikes] || strikes} 스트라이크`);
    if (balls > 0) parts.push(`${countWords[balls] || balls} 볼`);
    return `${parts.join(' ')}!`;
}

function getPreferredUmpireVoice() {
    if (!('speechSynthesis' in window) || !window.speechSynthesis.getVoices) return null;
    const voices = window.speechSynthesis.getVoices();
    const koVoices = voices.filter(voice => voice.lang && voice.lang.toLowerCase().startsWith('ko'));
    const maleHints = /(injoon|joon|male|man|남성|남자)/i;
    return koVoices.find(voice => maleHints.test(`${voice.name} ${voice.voiceURI}`))
        || voices.find(voice => maleHints.test(`${voice.name} ${voice.voiceURI}`))
        || koVoices[0]
        || null;
}

function speakReferee(text, delay = 120) {
    try {
        if (!('speechSynthesis' in window) || !window.SpeechSynthesisUtterance) return;
        window.speechSynthesis.cancel();

        const utterance = new SpeechSynthesisUtterance(text);
        const voice = getPreferredUmpireVoice();
        if (voice) utterance.voice = voice;

        utterance.lang = 'ko-KR';
        utterance.rate = text === '플레이볼!' ? 0.9 : 0.96;
        utterance.pitch = 0.42;
        utterance.volume = 1;
        setTimeout(() => window.speechSynthesis.speak(utterance), delay);
    } catch (err) {
        // Sound feedback is optional; never block gameplay.
    }
}

function announcePlayBall() {
    playStartMusic();
    speakReferee('플레이볼!', 360);
}

function getResultVoiceText(strikes, balls) {
    return getRefereeVoiceText(strikes, balls);
}

function playResultJingle(strikes, balls) {
    playUmpireCue(strikes, balls);
}

function speakResult(strikes, balls) {
    playUmpireCue(strikes, balls);
    speakReferee(getRefereeVoiceText(strikes, balls), 120);
}

document.addEventListener('DOMContentLoaded', () => {
    hydrateRulesModal();
    // 0. Animate and remove Splash Screen
    const progress = document.getElementById('splash-progress');
    if (progress) {
        setTimeout(() => { progress.style.width = '100%'; }, 50);
    }
    setTimeout(() => {
        const splash = document.getElementById('splash-screen');
        if (splash) {
            splash.style.opacity = '0';
            splash.style.visibility = 'hidden';
            setTimeout(() => { splash.remove(); }, 400);
        }
    }, 900);

    // 1. Initialize Profile via TossBridge
    TossBridge.getProfile().then(profile => {
        mergePlayerProfile(profile);
        updateLobbyProfileName();
        
        // Load stats from local server or localStorage
        syncPlayerStats();
        
        // Initialize global rankings
        initRankings();

        // 1.1 Check if room query parameter exists for Auto-Join
        const urlParams = new URLSearchParams(window.location.search);
        const urlRoomCode = urlParams.get('room');
        if (urlRoomCode && urlRoomCode.length === 4) {
            autoJoinRoomFromUrl(urlRoomCode);
        }

        // 1.2 Check if screenshot query parameter exists for taking app store screenshots
        const screenshotParam = urlParams.get('screenshot');
        if (screenshotParam) {
            window.isAutomatedTest = true; // bypass confirmation dialogs
            if (screenshotParam === 'lobby') {
                // Populate rankings and profile stats with realistic mock data
                myPlayer.name = "김토스";
                myPlayer.wins = 12;
                myPlayer.losses = 3;
                myPlayer.rate = 80.0;
                updateLobbyStatsUI();
                document.getElementById('lobby-profile-name').innerHTML = `${myPlayer.name} <i class="fa-solid fa-pen-to-square edit-icon" style="font-size: 0.8rem; margin-left: 5px; opacity: 0.6;"></i>`;
                
                const container = document.getElementById('public-rooms-list');
                if (container) {
                    container.innerHTML = `
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(255,255,255,0.05); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem; margin-bottom: 8px;">
                            <div>
                                <span style="font-weight: 600; color: #fff;">홈런왕김자바 님의 방</span>
                                <span style="display: block; font-size: 0.75rem; color: var(--neon-blue); font-family: var(--font-numeric); margin-top: 2px;"># 1234</span>
                            </div>
                            <button style="padding: 6px 12px; background: var(--neon-blue); color: #000; border: none; border-radius: 6px; font-weight: 700; font-size: 0.8rem; cursor: pointer;">입장</button>
                        </div>
                        <div style="display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; background: rgba(255,255,255,0.05); border-radius: 8px; border: 1px solid rgba(255,255,255,0.05); font-size: 0.85rem;">
                            <div>
                                <span style="font-weight: 600; color: #fff;">도토리수집가 님의 방</span>
                                <span style="display: block; font-size: 0.75rem; color: var(--neon-blue); font-family: var(--font-numeric); margin-top: 2px;"># 5678</span>
                            </div>
                            <button style="padding: 6px 12px; background: var(--neon-blue); color: #000; border: none; border-radius: 6px; font-weight: 700; font-size: 0.8rem; cursor: pointer;">입장</button>
                        </div>
                    `;
                }
            } else if (screenshotParam === 'game' || screenshotParam === 'game_horizontal') {
                setTimeout(() => {
                    gameMode = 'solo';
                    startSoloGame();
                    secretNumbers = [1, 2, 3, 4];
                    
                    // Make some guesses to populate UI scoreboard and history logs
                    currentGuess = [1, 5, 3, 7]; // 2S 0B
                    handleSubmitGuess();
                    currentGuess = [8, 9, 0, 2]; // 0S 0B (out)
                    handleSubmitGuess();
                    
                    // Active typing
                    currentGuess = [5, 2, 4, 3];
                    updateSlots();
                }, 1000);
            } else if (screenshotParam === 'result') {
                setTimeout(() => {
                    gameMode = 'solo';
                    startSoloGame();
                    secretNumbers = [1, 2, 3, 4];
                    endGame(true, 5);
                }, 1000);
            }
        }
    });

    // 2. Setup Profile Nickname Modifier
    const profileBar = document.getElementById('lobby-profile-bar');
    if (profileBar) {
        profileBar.addEventListener('click', () => {
            const currentName = myPlayer.name || '';
            const newName = prompt("변경할 닉네임을 입력해 주세요 (2~8글자):", currentName);
            if (newName && newName.trim().length >= 2) {
                TossBridge.updateProfileName(newName).then(updated => {
                    if (updated) {
                        mergePlayerProfile(updated);
                        updateLobbyProfileName();
                        
                        // Sync with local server
                        saveRankingToServer();
                    }
                });
            }
        });
    }
});

/**
 * Automatically joins a multiplayer room from a URL invitation link.
 */
function autoJoinRoomFromUrl(inputCode) {
    const data = {
        room: inputCode,
        guestId: myPlayer.id,
        guestName: myPlayer.name
    };

    fetch(`${API_BASE}/api/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(res => {
        if (!res.ok) {
            return res.json().then(e => { throw new Error(e.error || '접속 실패') });
        }
        return res.json();
    })
    .then(room => {
        gameMode = 'multi';
        myRole = 'guest';
        isGameOver = false;
        currentRoomCode = inputCode;
        document.getElementById('room-code-value').textContent = currentRoomCode;

        // Setup waiting room Guest UI
        document.getElementById('opponent-name').textContent = room.host.name;
        document.getElementById('opponent-avatar').className = 'fa-solid fa-circle-user';
        document.getElementById('opponent-card').className = 'player-card active-player';
        document.getElementById('opponent-status').textContent = '방장 대기';
        document.getElementById('opponent-status').className = 'player-status ready';

        mySecretInput = [];
        updateSetupSlots();

        // Clear query string from browser address bar
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);

        // Start polling room state
        resetRealtimeRenderCache();
        pollInterval = setInterval(pollRoomState, 800);
        showScreen('screen-waiting');
    })
    .catch(err => {
        console.warn("Auto-join failed:", err.message);
        const newUrl = window.location.pathname;
        window.history.replaceState({}, document.title, newUrl);
    });
}

/**
 * Refreshes the list of currently active public waiting rooms.
 */
function refreshPublicRooms() {
    if (window.isAutomatedTest) return; // skip in automated test

    fetch(`${API_BASE}/api/rooms`)
    .then(res => res.json())
    .then(rooms => {
        const container = document.getElementById('public-rooms-list');
        if (!container) return;
        
        if (!rooms || rooms.length === 0) {
            container.innerHTML = `<div style="font-size: 0.85rem; color: rgba(255,255,255,0.4); text-align: center; padding: 15px 0;">대기 중인 방이 없습니다.</div>`;
            return;
        }

        container.innerHTML = '';
        rooms.forEach(room => {
            const item = document.createElement('div');
            item.style.cssText = `
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 12px;
                background: rgba(255,255,255,0.05);
                border-radius: 8px;
                border: 1px solid rgba(255,255,255,0.05);
                font-size: 0.85rem;
            `;
            item.innerHTML = `
                <div>
                    <span style="font-weight: 600; color: #fff;">${room.hostName} 님의 방</span>
                    <span style="display: block; font-size: 0.75rem; color: var(--neon-blue); font-family: var(--font-numeric); margin-top: 2px;"># ${room.code}</span>
                </div>
                <button onclick="joinPublicRoom('${room.code}')" style="
                    padding: 6px 12px;
                    background: var(--neon-blue);
                    color: #000;
                    border: none;
                    border-radius: 6px;
                    font-weight: 700;
                    font-size: 0.8rem;
                    cursor: pointer;
                    box-shadow: 0 0 10px rgba(45,136,255,0.3);
                ">입장</button>
            `;
            container.appendChild(item);
        });
    })
    .catch(err => {
        console.warn("Failed to fetch public rooms:", err);
    });
}

/**
 * Handles joining a public room from the lobby list.
 */
function joinPublicRoom(code) {
    if (window.isAutomatedTest || confirm(`${code}번 방에 입장하시겠습니까?`)) {
        autoJoinRoomFromUrl(code);
    }
}
window.joinPublicRoom = joinPublicRoom;

/**
 * Sync player wins and losses from database or localstorage.
 */
function syncPlayerStats() {
    // Fetch rankings list from server to locate player record
    fetch(`${API_BASE}/api/rankings`)
        .then(res => res.json())
        .then(players => {
            const record = players.find(p => p.id === myPlayer.id);
            if (record) {
                myPlayer.wins = record.wins || 0;
                myPlayer.losses = record.losses || 0;
                myPlayer.rate = record.rate || 0;
            } else {
                saveRankingToServer();
            }
            updateLobbyStatsUI();
        })
        .catch(err => {
            console.warn("REST Server offline, loading localStorage stats.");
            // Offline fallback: localStorage
            try {
                const wins = parseInt(localStorage.getItem('toss_baseball_wins') || '0');
                const losses = parseInt(localStorage.getItem('toss_baseball_losses') || '0');
                myPlayer.wins = wins;
                myPlayer.losses = losses;
                myPlayer.rate = parseFloat(((wins / Math.max(1, wins + losses)) * 100).toFixed(1));
            } catch (e) {}
            updateLobbyStatsUI();
        });
}

function saveRankingToServer() {
    const data = {
        id: myPlayer.id,
        name: myPlayer.name,
        wins: myPlayer.wins || 0,
        losses: myPlayer.losses || 0,
        rate: myPlayer.rate || 0
    };
    fetch(`${API_BASE}/api/ranking`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    }).catch(() => {});
}

function updateLobbyStatsUI() {
    myPlayer = normalizePlayerStats(myPlayer);
    const safeStatsEl = document.getElementById('lobby-profile-stats');
    if (safeStatsEl) {
        safeStatsEl.textContent = `전적: ${myPlayer.wins}승 ${myPlayer.losses}패 (승률 ${myPlayer.rate}%)`;
    }
    return;
    myPlayer = normalizePlayerStats(myPlayer);
    const statsEl = document.getElementById('lobby-profile-stats');
    if (statsEl) {
        statsEl.textContent = `전적: ${myPlayer.wins}승 ${myPlayer.losses}패 (승률 ${myPlayer.rate}%)`;
    }
}

/**
 * Initializes the global rankings / leaderboard.
 */
function initRankings() {
    fetch(`${API_BASE}/api/rankings`)
        .then(res => res.json())
        .then(players => {
            // Sort by win rate, then wins descending
            players.sort((a, b) => b.rate - a.rate || b.wins - a.wins);
            renderLeaderboard(players);
        })
        .catch(err => {
            // Fallback to local mock data
            const localList = [...mockRankings];
            localList.push({
                name: myPlayer.name,
                wins: myPlayer.wins,
                losses: myPlayer.losses,
                rate: myPlayer.rate,
                isMe: true
            });
            localList.sort((a, b) => b.rate - a.rate);
            renderLeaderboard(localList);
        });
}

/* ==========================================================================
   NAVIGATION & UI TRANSITIONS
   ========================================================================== */

function showScreen(screenId) {
    Object.keys(screens).forEach(key => {
        const screen = screens[key];
        if (screen.id === screenId) {
            screen.classList.remove('hidden');
        } else {
            screen.classList.add('hidden');
        }
    });
    currentScreen = screenId;

    // Reset overlays
    closeModal(rulesModal);
    closeModal(resultModal);
    closeModal(joinModal);

    // Manage Public Rooms list polling interval
    if (screenId === 'screen-lobby') {
        refreshPublicRooms();
        if (!lobbyInterval) {
            lobbyInterval = setInterval(refreshPublicRooms, 3000);
        }
    } else {
        if (lobbyInterval) {
            clearInterval(lobbyInterval);
            lobbyInterval = null;
        }
    }
}

// Bind back buttons globally
document.querySelectorAll('.back-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
        const target = btn.getAttribute('data-target');
        // Stop polling and clean room if leaving waiting
        if (currentScreen === 'screen-waiting' && pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
        showScreen(target);
    });
});

/* ==========================================================================
   LOBBY MENUS
   ========================================================================== */

safeAddListener('btn-menu-solo', 'click', () => {
    gameMode = 'solo';
    isMyTurn = true;
    startSoloGame();
});

safeAddListener('btn-menu-create', 'click', () => {
    gameMode = 'multi';
    myRole = 'host';
    isGameOver = false;

    // Setup host UI
    document.getElementById('opponent-name').textContent = '상대 대기 중...';
    document.getElementById('opponent-avatar').className = 'fa-solid fa-circle-question';
    document.getElementById('opponent-card').className = 'player-card waiting-player';
    document.getElementById('opponent-status').textContent = '초대 대기';
    document.getElementById('opponent-status').className = 'player-status';

    // Clear secret selection fields
    mySecretInput = [];
    updateSetupSlots();

    if (window.isAutomatedTest) {
        gameMode = 'multi';
        opponentName = '연습 봇';
        currentRoomCode = 'SAND';
        document.getElementById('room-code-value').textContent = 'SAND';
        setTimeout(() => {
            document.getElementById('opponent-name').textContent = opponentName;
            document.getElementById('opponent-avatar').className = 'fa-solid fa-robot avatar-bot';
            document.getElementById('opponent-card').className = 'player-card active-player';
            document.getElementById('opponent-status').textContent = '입장 완료';
            document.getElementById('opponent-status').className = 'player-status ready';
        }, 1500);
        showScreen('screen-waiting');
        return;
    }

    // Call REST server to generate room
    const data = { hostId: myPlayer.id, hostName: myPlayer.name };
    fetch(`${API_BASE}/api/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(res => res.json())
    .then(room => {
        currentRoomCode = room.code;
        document.getElementById('room-code-value').textContent = currentRoomCode;

        // Start polling room state
        resetRealtimeRenderCache();
        pollInterval = setInterval(pollRoomState, 800);
        showScreen('screen-waiting');
    })
    .catch(err => {
        if (!window.isAutomatedTest) {
            alert("대전 서버 연결 실패! 오프라인 연습 봇 모드를 가동합니다.");
        } else {
            console.warn("REST Server offline during test, fallback to sandbox.");
        }
        gameMode = 'multi';
        opponentName = '연습 봇';
        currentRoomCode = 'SAND';
        document.getElementById('room-code-value').textContent = 'SAND';
        setTimeout(() => {
            document.getElementById('opponent-name').textContent = opponentName;
            document.getElementById('opponent-avatar').className = 'fa-solid fa-robot avatar-bot';
            document.getElementById('opponent-card').className = 'player-card active-player';
            document.getElementById('opponent-status').textContent = '입장 완료';
            document.getElementById('opponent-status').className = 'player-status ready';
        }, 1500);
        showScreen('screen-waiting');
    });
});

safeAddListener('btn-menu-join', 'click', () => {
    document.getElementById('join-room-input').value = '';
    openModal(joinModal);
});

safeAddListener('btn-close-join', 'click', () => closeModal(joinModal));

safeAddListener('btn-submit-join', 'click', () => {
    const inputCode = document.getElementById('join-room-input').value.trim();
    if (inputCode.length !== 4) {
        alert("올바른 4자리 방 번호를 입력해 주세요.");
        return;
    }

    const data = {
        room: inputCode,
        guestId: myPlayer.id,
        guestName: myPlayer.name
    };

    fetch(`${API_BASE}/api/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(res => {
        if (!res.ok) {
            return res.json().then(e => { throw new Error(e.error || '접속 실패') });
        }
        return res.json();
    })
    .then(room => {
        gameMode = 'multi';
        myRole = 'guest';
        isGameOver = false;
        currentRoomCode = inputCode;
        document.getElementById('room-code-value').textContent = currentRoomCode;

        // Setup waiting room Guest UI
        document.getElementById('opponent-name').textContent = room.host.name;
        document.getElementById('opponent-avatar').className = 'fa-solid fa-circle-user';
        document.getElementById('opponent-card').className = 'player-card active-player';
        document.getElementById('opponent-status').textContent = '방장 대기';
        document.getElementById('opponent-status').className = 'player-status ready';

        mySecretInput = [];
        updateSetupSlots();

        closeModal(joinModal);
        
        // Start polling room state
        resetRealtimeRenderCache();
        pollInterval = setInterval(pollRoomState, 800);
        
        showScreen('screen-waiting');
    })
    .catch(err => {
        alert("참가 오류: " + err.message);
    });
});

safeAddListener('btn-menu-rankings', 'click', () => {
    initRankings();
    showScreen('screen-leaderboard');
});

// Copy room code to clipboard
safeAddListener('btn-copy-code', 'click', () => {
    TossBridge.shareRoomCode(currentRoomCode).then(() => {
        TossBridge.vibrate('light');
        alert("방 초대 메시지가 클립보드에 복사되었습니다! 친구에게 공유해 보세요.");
    });
});

/* ==========================================================================
   REST API GAME STATE POLLING LOOP
   ========================================================================== */

function pollRoomState() {
    if (!currentRoomCode || gameMode !== 'multi') return;

    fetch(`${API_BASE}/api/poll?room=${currentRoomCode}&role=${myRole}`)
    .then(res => res.json())
    .then(room => {
        // 1. Live Turn timer update (runs every poll, bypassing redrawing cache)
        const timerContainer = document.getElementById('turn-timer-container');
        if (room.status === 'playing' && currentScreen === 'screen-game') {
            const timerValue = document.getElementById('turn-timer-value');
            if (timerContainer && timerValue && room.turnStartedAt) {
                timerContainer.style.display = 'inline-flex';
                const elapsed = Date.now() - room.turnStartedAt;
                const remaining = Math.max(0, Math.ceil((60000 - elapsed) / 1000));
                timerValue.textContent = remaining;
            }
        } else {
            if (timerContainer) timerContainer.style.display = 'none';
        }

        // 2. Prevent redundant redraws if visible game state is unchanged.
        // Poll updates player lastActive frequently, but that should not redraw attack history.
        const roomJson = JSON.stringify({
            status: room.status,
            currentTurn: room.currentTurn,
            winner: room.winner,
            reason: room.reason,
            host: room.host ? { name: room.host.name, status: room.host.status } : null,
            guest: room.guest ? { name: room.guest.name, status: room.guest.status } : null,
            guesses: room.guesses,
            secrets: room.secrets
        });
        if (roomJson === lastRoomDataJson) return;
        lastRoomDataJson = roomJson;

        // 3. Guest Joins
        if (room.status === 'setup' && myRole === 'host' && room.guest) {
            document.getElementById('opponent-name').textContent = room.guest.name;
            document.getElementById('opponent-avatar').className = 'fa-solid fa-circle-user';
            document.getElementById('opponent-card').className = 'player-card active-player';
            document.getElementById('opponent-status').textContent = '설정 중...';
            document.getElementById('opponent-status').className = 'player-status ready';
        }

        // 4. Setup Status (Show 'Ready' when other submits secret)
        if (room.status === 'setup' || room.status === 'playing') {
            if (myRole === 'host' && room.guest) {
                if (room.guest.status === 'ready') {
                    document.getElementById('opponent-status').textContent = '준비 완료';
                }
            } else if (myRole === 'guest' && room.host) {
                if (room.host.status === 'ready') {
                    document.getElementById('opponent-status').textContent = '준비 완료';
                }
            }
        }

        // 5. Match Starts (Setup secrets done)
        if (room.status === 'playing' && currentScreen !== 'screen-game') {
            startMultiGame(room);
        }

        // 6. Live Gameplay Guesses Update
        if (room.status === 'playing' && currentScreen === 'screen-game') {
            syncRealtimeGuesses(room);
        }

        // 7. Game Over
        if (room.status === 'finished') {
            clearInterval(pollInterval);
            pollInterval = null;
            
            const isWin = room.winner === myRole;
            if (room.secrets) {
                const oppRole = myRole === 'host' ? 'guest' : 'host';
                secretNumbers = room.secrets[oppRole] || secretNumbers;
            }
            const myGuessesList = room.guesses ? (room.guesses[myRole] ? Object.values(room.guesses[myRole]) : []) : [];
            endGame(isWin, myGuessesList.length + 1, room.winner !== myRole, room.reason);
        }
    })
    .catch(err => {
        console.error("Polling error:", err);
    });
}

/* ==========================================================================
   GAME SETUP: SOLO GAME
   ========================================================================== */

function startSoloGame() {
    secretNumbers = generateSecretNumber();
    console.log("Solo Secret:", secretNumbers.join(''));

    currentGuess = [];
    attemptsLeft = MAX_ATTEMPTS;
    isGameOver = false;
    isMyTurn = true;

    // Reset game UIs
    document.getElementById('game-mode-badge').innerHTML = '<i class="fa-solid fa-user"></i> 연습 모드';
    document.getElementById('game-opp-name').textContent = 'AI 수비수';
    document.getElementById('game-opp-sub').textContent = '인공지능';
    btnSimulateOpp.classList.add('hidden'); 

    // Set Bulb Turn
    turnBulb.className = 'turn-bulb active-me';
    turnText.textContent = '내 차례';
    playerMeBox.className = 'battle-player me-turn';
    playerOppBox.className = 'battle-player';

    updateSlots();
    updateScoreboardLeds(null, 0, 0);
    attemptsLeftEl.textContent = attemptsLeft;

    myHistoryContainer.innerHTML = '<div class="empty-placeholder-mini">아직 기록이 없습니다.</div>';
    oppHistoryContainer.innerHTML = '<div class="empty-placeholder-mini">봇은 수비 중입니다.</div>';

    loadBestScore();
    enableKeypad();
    showScreen('screen-game');
    announcePlayBall();
}

function generateSecretNumber() {
    const digits = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const secret = [];
    for (let i = 0; i < DIGIT_COUNT; i++) {
        const rIndex = Math.floor(Math.random() * digits.length);
        secret.push(digits[rIndex]);
        digits.splice(rIndex, 1);
    }
    return secret;
}

/* ==========================================================================
   GAME SETUP: MULTIPLAYER GAME
   ========================================================================== */

function startMultiGame(roomData) {
    isGameOver = false;
    currentGuess = [];
    attemptsLeft = MAX_ATTEMPTS;

    // Resolve opponent info
    const oppData = myRole === 'host' ? roomData.guest : roomData.host;
    opponentName = oppData.name;

    // Setup UIs
    document.getElementById('game-mode-badge').innerHTML = '<i class="fa-solid fa-user-group"></i> 1:1 실시간';
    document.getElementById('game-opp-name').textContent = opponentName;
    document.getElementById('game-opp-sub').textContent = '대결 상대';
    btnSimulateOpp.classList.add('hidden'); 

    updateSlots();
    updateScoreboardLeds(null, 0, 0);
    attemptsLeftEl.textContent = attemptsLeft;

    myHistoryContainer.innerHTML = '<div class="empty-placeholder-mini">아직 기록이 없습니다.</div>';
    oppHistoryContainer.innerHTML = '<div class="empty-placeholder-mini">상대방의 투구를 기다리는 중...</div>';

    // Set Turn
    setTurnState(roomData.currentTurn === myRole);

    // Load opponent secret locally
    if (roomData.secrets) {
        const oppRole = myRole === 'host' ? 'guest' : 'host';
        secretNumbers = roomData.secrets[oppRole] || [];
        console.log("Opponent Secret loaded locally:", secretNumbers.join(''));
    } else {
        secretNumbers = generateSecretNumber();
    }

    enableKeypad();
    showScreen('screen-game');
    announcePlayBall();
}

function setTurnState(isMe) {
    isMyTurn = isMe;
    if (isMe) {
        turnBulb.className = 'turn-bulb active-me';
        turnText.textContent = '내 차례';
        playerMeBox.className = 'battle-player me-turn';
        playerOppBox.className = 'battle-player';
        btnSimulateOpp.classList.add('hidden');
        enableKeypad();
    } else {
        turnBulb.className = 'turn-bulb active-opp';
        turnText.textContent = '상대 차례';
        playerMeBox.className = 'battle-player';
        playerOppBox.className = 'battle-player opp-turn';
        if (currentRoomCode === 'SAND') {
            btnSimulateOpp.classList.remove('hidden');
        } else {
            btnSimulateOpp.classList.add('hidden');
        }
        disableKeypad();
    }
}

/**
 * Synchronize live guesses list from room object.
 */
function syncRealtimeGuesses(room) {
    if (!room.guesses) return;

    const renderHistoryList = (container, guesses, emptyText) => {
        container.innerHTML = '';
        if (guesses.length === 0) {
            container.innerHTML = `<div class="empty-placeholder-mini">${emptyText}</div>`;
            return;
        }

        guesses.forEach(item => {
            appendHistoryItem(container, item.attempt, item.guess, item.strikes, item.balls);
        });
    };

    const cachedMyGuesses = room.guesses[myRole]
        ? Object.values(room.guesses[myRole]).sort((a, b) => a.attempt - b.attempt)
        : [];
    const cachedMyGuessesJson = JSON.stringify(cachedMyGuesses);
    if (cachedMyGuessesJson !== lastMyGuessesJson) {
        lastMyGuessesJson = cachedMyGuessesJson;
        const latestGuessForVoice = cachedMyGuesses[cachedMyGuesses.length - 1];
        if (latestGuessForVoice && latestGuessForVoice.attempt > lastSpokenMyAttempt && currentScreen === 'screen-game') {
            lastSpokenMyAttempt = latestGuessForVoice.attempt;
            speakResult(latestGuessForVoice.strikes, latestGuessForVoice.balls);
        }
        renderHistoryList(myHistoryContainer, cachedMyGuesses, '아직 기록이 없습니다.');
    }

    attemptsLeft = MAX_ATTEMPTS - cachedMyGuesses.length;
    attemptsLeftEl.textContent = attemptsLeft;

    if (cachedMyGuesses.length > 0) {
        const lastGuess = cachedMyGuesses[cachedMyGuesses.length - 1];
        updateScoreboardLeds(lastGuess.guess, lastGuess.strikes, lastGuess.balls);
    } else {
        updateScoreboardLeds(null, 0, 0);
    }

    const cachedOppRole = myRole === 'host' ? 'guest' : 'host';
    const cachedOppGuesses = room.guesses[cachedOppRole]
        ? Object.values(room.guesses[cachedOppRole]).sort((a, b) => a.attempt - b.attempt)
        : [];
    const cachedOppGuessesJson = JSON.stringify(cachedOppGuesses);
    if (cachedOppGuessesJson !== lastOppGuessesJson) {
        lastOppGuessesJson = cachedOppGuessesJson;
        renderHistoryList(oppHistoryContainer, cachedOppGuesses, '상대방의 공격을 기다리는 중...');
    }

    setTurnState(room.currentTurn === myRole);
    return;

    // 1. My Guesses History Render
    const myGuesses = room.guesses[myRole] ? Object.values(room.guesses[myRole]) : [];
    myHistoryContainer.innerHTML = '';
    if (myGuesses.length === 0) {
        myHistoryContainer.innerHTML = '<div class="empty-placeholder-mini">아직 기록이 없습니다.</div>';
    } else {
        myGuesses.sort((a, b) => a.attempt - b.attempt).forEach(item => {
            appendHistoryItem(myHistoryContainer, item.attempt, item.guess, item.strikes, item.balls);
        });
    }

    // Update attempts left
    attemptsLeft = MAX_ATTEMPTS - myGuesses.length;
    attemptsLeftEl.textContent = attemptsLeft;

    // Update LED bulbs with the latest guess result
    if (myGuesses.length > 0) {
        const sortedGuesses = [...myGuesses].sort((a, b) => a.attempt - b.attempt);
        const lastGuess = sortedGuesses[sortedGuesses.length - 1];
        updateScoreboardLeds(lastGuess.guess, lastGuess.strikes, lastGuess.balls);
    } else {
        updateScoreboardLeds(null, 0, 0);
    }

    // 2. Opponent Guesses History Render
    const oppRole = myRole === 'host' ? 'guest' : 'host';
    const oppGuesses = room.guesses[oppRole] ? Object.values(room.guesses[oppRole]) : [];
    oppHistoryContainer.innerHTML = '';
    if (oppGuesses.length === 0) {
        oppHistoryContainer.innerHTML = '<div class="empty-placeholder-mini">상대방의 투구를 기다리는 중...</div>';
    } else {
        oppGuesses.sort((a, b) => a.attempt - b.attempt).forEach(item => {
            appendHistoryItem(oppHistoryContainer, item.attempt, item.guess, item.strikes, item.balls);
        });
    }

    // 3. Set Active Turn bulb
    setTurnState(room.currentTurn === myRole);
}

/* ==========================================================================
   WAITING ROOM: SET DEFENSIVE SECRET
   ========================================================================== */

// Mini keypad in waiting room click handler
document.querySelector('.setup-keypad-grid').addEventListener('click', (e) => {
    const button = e.target.closest('.setup-key');
    if (!button || isGameOver) return;

    const val = button.getAttribute('data-val');

    if (val === 'backspace') {
        if (mySecretInput.length > 0) {
            mySecretInput.pop();
        }
    } else if (button.id === 'btn-ready-start') {
        if (mySecretInput.length === DIGIT_COUNT) {
            submitSecretNumberSetup();
        }
        return;
    } else {
        const num = parseInt(val);
        if (mySecretInput.length < DIGIT_COUNT && !mySecretInput.includes(num)) {
            mySecretInput.push(num);
        }
    }
    updateSetupSlots();
});

function updateSetupSlots() {
    for (let i = 0; i < DIGIT_COUNT; i++) {
        const slot = setupSlots[i];
        if (i < mySecretInput.length) {
            slot.value = mySecretInput[i];
            slot.classList.add('filled');
        } else {
            slot.value = '';
            slot.classList.remove('filled');
        }
        
        if (i === mySecretInput.length) {
            slot.classList.add('active');
        } else {
            slot.classList.remove('active');
        }
    }

    // Toggle Ready Button
    const confirmBtn = document.getElementById('btn-ready-start');
    if (mySecretInput.length === DIGIT_COUNT) {
        confirmBtn.disabled = false;
    } else {
        confirmBtn.disabled = true;
    }
}

function submitSecretNumberSetup() {
    mySecretNumbers = [...mySecretInput];
    document.getElementById('btn-ready-start').disabled = true;

    if (currentRoomCode !== 'SAND') {
        // Send secret to REST API
        const data = {
            room: currentRoomCode,
            role: myRole,
            secret: mySecretNumbers
        };
        fetch(`${API_BASE}/api/ready`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        }).catch(() => {
            alert("준비 설정 송신 실패!");
        });
    } else {
        // Offline Demo fallback
        opponentName = '연습 봇';
        startMultiGame({
            status: 'playing',
            currentTurn: 'host',
            host: { name: myPlayer.name },
            guest: { name: opponentName }
        });
        setTimeout(simulateOfflineBotTurn, 4000);
    }
}

/* ==========================================================================
   GAME CORE INPUTS
   ========================================================================== */

function handleNumberInput(num) {
    if (currentGuess.length < DIGIT_COUNT && !currentGuess.includes(num)) {
        currentGuess.push(num);
        TossBridge.vibrate('light');
        updateSlots();
    }
}

function handleBackspace() {
    if (currentGuess.length > 0) {
        currentGuess.pop();
        TossBridge.vibrate('light');
        updateSlots();
    }
}

function updateSlots() {
    slots.forEach((slot, i) => {
        if (i < currentGuess.length) {
            slot.textContent = currentGuess[i];
            slot.classList.add('filled');
        } else {
            slot.textContent = '';
            slot.classList.remove('filled');
        }

        if (i === currentGuess.length && !isGameOver && isMyTurn) {
            slot.classList.add('active');
        } else {
            slot.classList.remove('active');
        }
    });
}

/**
 * Updates the neon scoreboard LED indicators.
 */
function updateScoreboardLeds(guessArr, strikes, balls) {
    const textVal = document.getElementById('scoreboard-guess-val');
    if (textVal) {
        textVal.textContent = guessArr ? guessArr.join(' ') : '- - - -';
    }

    // Reset all LED lights
    document.querySelectorAll('.led-light').forEach(led => led.classList.remove('active'));

    if (guessArr) {
        // Strike Row (turns yellow)
        for (let i = 0; i < Math.min(strikes, 3); i++) {
            const led = document.getElementById(`led-strike-${i}`);
            if (led) led.classList.add('active');
        }
        // Ball Row (turns green)
        for (let i = 0; i < Math.min(balls, 4); i++) {
            const led = document.getElementById(`led-ball-${i}`);
            if (led) led.classList.add('active');
        }
        // Out Row (turns red if strikes == 0 and balls == 0)
        if (strikes === 0 && balls === 0) {
            const led = document.getElementById('led-out-0');
            if (led) led.classList.add('active');
        }
    }
}

function enableKeypad() {
    keypadButtons.forEach(button => button.disabled = false);
}

function disableKeypad() {
    keypadButtons.forEach(button => button.disabled = true);
}

/* ==========================================================================
   GAMEPLAY SUBMISSION LOGIC
   ========================================================================== */

function handleSubmitGuess() {
    if (currentGuess.length !== DIGIT_COUNT) {
        alert("4자리 숫자를 모두 채워주세요.");
        return;
    }

    TossBridge.vibrate('heavy');

    // Calculate Strikes and Balls
    let strikes = 0;
    let balls = 0;

    const parsedSecret = secretNumbers.map(Number);
    currentGuess.forEach((digit, i) => {
        const guestDigit = Number(digit);
        if (guestDigit === parsedSecret[i]) {
            strikes++;
        } else if (parsedSecret.includes(guestDigit)) {
            balls++;
        }
    });

    const attemptNumber = MAX_ATTEMPTS - attemptsLeft + 1;

    if (gameMode === 'solo') {
        updateScoreboardLeds(currentGuess, strikes, balls);
        attemptsLeft--;
        attemptsLeftEl.textContent = attemptsLeft;
        
        if (attemptNumber === 1) myHistoryContainer.innerHTML = '';
        appendHistoryItem(myHistoryContainer, attemptNumber, currentGuess, strikes, balls);
        speakResult(strikes, balls);

        currentGuess = [];
        updateSlots();

        if (strikes === DIGIT_COUNT) {
            endGame(true, attemptNumber);
        } else if (attemptsLeft === 0) {
            endGame(false, attemptNumber);
        }
    } else {
        if (currentRoomCode !== 'SAND') {
            // Push only the guess to REST API. The server calculates S/B/O from the opponent's real secret.
            const data = {
                room: currentRoomCode,
                role: myRole,
                guess: currentGuess,
                attempt: attemptNumber
            };

            currentGuess = [];
            updateSlots();

            fetch(`${API_BASE}/api/guess`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).then(res => {
                if (!res.ok) throw new Error('guess submit failed');
                return res.json();
            }).then(room => {
                syncRealtimeGuesses(room);
            }).catch(() => {
                alert("투구 데이터 송신 실패!");
            });
        } else {
            // Offline Sandbox Bot Game fallback
            updateScoreboardLeds(currentGuess, strikes, balls);
            attemptsLeft--;
            attemptsLeftEl.textContent = attemptsLeft;

            if (attemptNumber === 1) myHistoryContainer.innerHTML = '';
            appendHistoryItem(myHistoryContainer, attemptNumber, currentGuess, strikes, balls);
            speakResult(strikes, balls);

            currentGuess = [];
            updateSlots();

            if (strikes === DIGIT_COUNT) {
                endGame(true, attemptNumber);
            } else if (attemptsLeft === 0) {
                endGame(false, attemptNumber);
            } else {
                setTurnState(false);
                setTimeout(simulateOfflineBotTurn, 2000);
            }
        }
    }
}

/* ==========================================================================
   OFFLINE MOCK BOT TURN SIMULATOR
   ========================================================================== */

function simulateOfflineBotTurn() {
    if (isGameOver || gameMode !== 'multi') return;
    if (currentRoomCode === 'SAND' && isMyTurn) return;

    const botGuess = generateSecretNumber();
    let strikes = 0;
    let balls = 0;

    botGuess.forEach((digit, i) => {
        if (digit === mySecretNumbers[i]) {
            strikes++;
        } else if (mySecretNumbers.includes(digit)) {
            balls++;
        }
    });

    const oppAttempts = oppHistoryContainer.querySelectorAll('.history-item').length + 1;
    if (oppAttempts === 1) oppHistoryContainer.innerHTML = '';

    appendHistoryItem(oppHistoryContainer, oppAttempts, botGuess, strikes, balls);

    if (strikes === DIGIT_COUNT) {
        endGame(false, oppAttempts, true); // Bot won
    } else {
        setTurnState(true);
    }
}

/* ==========================================================================
   HISTORY LOG RENDERER
   ========================================================================== */

function appendHistoryItem(container, attempt, guessArr, strikes, balls) {
    const item = document.createElement('div');
    item.className = 'history-item';

    const guessStr = guessArr.join(' ');
    let resultBadgesHTML = '';

    if (strikes === DIGIT_COUNT) {
        resultBadgesHTML = `<span class="badge strike">홈런!</span>`;
        item.classList.add('homerun-item');
    } else if (strikes === 0 && balls === 0) {
        resultBadgesHTML = `<span class="badge out">아웃</span>`;
        item.classList.add('out-item');
    } else {
        if (strikes > 0) resultBadgesHTML += `<span class="badge strike">${strikes}S</span>`;
        if (balls > 0) resultBadgesHTML += `<span class="badge ball">${balls}B</span>`;
    }

    item.innerHTML = `
        <span class="history-index">#${attempt}</span>
        <span class="history-guess">${guessStr}</span>
        <div class="history-result">${resultBadgesHTML}</div>
    `;

    container.appendChild(item);
}

/* ==========================================================================
   GAME END ACTIONS & RESULT MODAL
   ========================================================================== */

function endGame(isWin, attemptsUsed, isOpponentWin = false, reason = "win") {
    try {
        isGameOver = true;
        disableKeypad();

        // Hide timer
        const timerContainer = document.getElementById('turn-timer-container');
        if (timerContainer) timerContainer.style.display = 'none';

        resultSecret.textContent = secretNumbers.join(' ');
        resultAttempts.textContent = `${attemptsUsed} / ${MAX_ATTEMPTS}`;

        if (gameMode === 'solo') {
            if (isWin) {
                resultBadge.className = 'result-badge win';
                resultBadge.innerHTML = '<i class="fa-solid fa-trophy"></i>';
                resultTitle.textContent = '🎉 연습 홈런!';
                resultTitle.className = 'result-title win-title';
                resultMessage.textContent = '훌륭합니다! 연습 구장에서 정답 숫자를 맞추셨습니다.';
                updateBestScore(attemptsUsed);
            } else {
                resultBadge.className = 'result-badge lose';
                resultBadge.innerHTML = '<i class="fa-solid fa-circle-xmark"></i>';
                resultTitle.textContent = '⚾ 연습 종료';
                resultTitle.className = 'result-title lose-title';
                resultMessage.textContent = '아쉽게도 기회를 모두 소진했습니다. 실력을 다져 실전으로 가보세요!';
            }
        } else {
            // Multiplayer Game Result
            if (isWin) {
                resultBadge.className = 'result-badge win';
                resultBadge.innerHTML = '<i class="fa-solid fa-crown"></i>';
                resultTitle.className = 'result-title win-title';
                
                if (reason === 'disconnect') {
                    resultTitle.textContent = '🏆 기권 승리!';
                    resultMessage.textContent = `상대방 (${opponentName})의 네트워크 연결이 끊어져 실격승(기권승) 처리되었습니다!`;
                } else if (reason === 'timeout') {
                    resultTitle.textContent = '🏆 시간초과 승리!';
                    resultMessage.textContent = `상대방 (${opponentName})의 공격 제한시간(30초) 초과로 시간초과 승리하였습니다!`;
                } else {
                    resultTitle.textContent = '🏆 대전 승리!';
                    resultMessage.textContent = `상대방 (${opponentName})보다 먼저 숫자를 맞췄습니다! 랭킹 포인트가 상승합니다.`;
                }
                
                // Increment wins
                myPlayer.wins++;
                myPlayer.rate = parseFloat(((myPlayer.wins / Math.max(1, myPlayer.wins + myPlayer.losses)) * 100).toFixed(1));
                saveRankingToServer();
            } else {
                resultBadge.className = 'result-badge lose';
                resultBadge.innerHTML = '<i class="fa-solid fa-skull-crossbones"></i>';
                resultTitle.className = 'result-title lose-title';
                
                if (reason === 'disconnect') {
                    resultTitle.textContent = '💀 기권 패배...';
                    resultMessage.textContent = `내 네트워크 신호가 약해 게임방에서 퇴장 및 기권패 처리되었습니다.`;
                } else if (reason === 'timeout') {
                    resultTitle.textContent = '💀 시간초과 패배...';
                    resultMessage.textContent = `내 공격 제한시간(30초) 내에 숫자를 입력하지 못해 시간초과 패배하였습니다!`;
                } else {
                    resultTitle.textContent = '💀 대전 패배...';
                    resultMessage.textContent = `상대방 (${opponentName})이 내 숫자(${mySecretNumbers.join('')})를 먼저 맞췄습니다!`;
                }
                
                // Increment losses
                myPlayer.losses++;
                myPlayer.rate = parseFloat(((myPlayer.wins / Math.max(1, myPlayer.wins + myPlayer.losses)) * 100).toFixed(1));
                saveRankingToServer();
            }
        }

        setTimeout(() => {
            openModal(resultModal);
        }, 600);
    } catch (err) {
        console.error("endGame error:", err);
    }
}

function openModal(modal) {
    if (modal) {
        modal.classList.remove('hidden');
        modal.setAttribute('aria-hidden', 'false');
    }
}

function closeModal(modal) {
    if (modal) {
        modal.classList.add('hidden');
        modal.setAttribute('aria-hidden', 'true');
    }
}

// Local Storage best score wrappers
function loadBestScore() {
    if (!bestScoreEl) return;
    try {
        const best = localStorage.getItem(STORAGE_KEY_BEST);
        if (best) {
            bestScoreEl.textContent = `${best}회`;
        } else {
            bestScoreEl.textContent = '-';
        }
    } catch (e) {
        console.warn("localStorage is blocked in this environment:", e);
        if (bestScoreEl) bestScoreEl.textContent = '-';
    }
}

function updateBestScore(score) {
    try {
        const best = localStorage.getItem(STORAGE_KEY_BEST);
        if (!best || score < parseInt(best)) {
            localStorage.setItem(STORAGE_KEY_BEST, score);
            loadBestScore();
            return true;
        }
    } catch (e) {
        console.warn("localStorage is blocked in this environment:", e);
    }
    return false;
}

/* ==========================================================================
   LEADERBOARD RENDERER
   ========================================================================== */

function renderLeaderboard(playersList) {
    const tbody = document.getElementById('leaderboard-body');
    if (!tbody) return;
    tbody.innerHTML = '';

    playersList.forEach((player, index) => {
        const tr = document.createElement('tr');
        const rank = index + 1;
        
        let rankBadge = `<span class="rank-num normal">${rank}</span>`;
        if (rank === 1) rankBadge = `<span class="rank-num gold">1</span>`;
        else if (rank === 2) rankBadge = `<span class="rank-num silver">2</span>`;
        else if (rank === 3) rankBadge = `<span class="rank-num bronze">3</span>`;

        tr.innerHTML = `
            <td>${rankBadge}</td>
            <td><span class="rank-name ${player.isMe ? 'me' : ''}">${player.name} ${player.isMe ? '(나)' : ''}</span></td>
            <td><span class="rank-table-stats">${player.wins}승 ${player.losses}패</span></td>
            <td><span class="rank-table-rate ${player.rate >= 75 ? 'high' : ''}">${player.rate}%</span></td>
        `;
        tbody.appendChild(tr);
    });
}

/* ==========================================================================
   EVENT LISTENERS (ONLOAD BINDINGS)
   ========================================================================== */

// 1. Virtual Keypad Click handler inside Game
safeAddListener(document.querySelector('.keypad-grid'), 'click', (e) => {
    const button = e.target.closest('.key-btn');
    if (!button || button.disabled || isGameOver) return;

    const key = button.getAttribute('data-key');

    if (key === 'backspace') {
        handleBackspace();
    } else if (key === 'enter') {
        handleSubmitGuess();
    } else {
        handleNumberInput(parseInt(key));
    }
});

safeAddListener('btn-simulate-opp', 'click', () => {
    if (currentRoomCode !== 'SAND' || isMyTurn || isGameOver) return;
    simulateOfflineBotTurn();
});

// 2. Physical Keyboards (Only active when in game screen and no modal open)
document.addEventListener('keydown', (e) => {
    if (currentScreen !== 'screen-game' || isGameOver) return;
    
    // Check if any overlay is visible
    if (!rulesModal.classList.contains('hidden') || !resultModal.classList.contains('hidden')) {
        if (e.key === 'Escape') {
            closeModal(rulesModal);
        } else if (e.key === 'Enter' && !resultModal.classList.contains('hidden')) {
            closeModal(resultModal);
            showScreen('screen-lobby');
        }
        return;
    }

    if (!isMyTurn) return; // ignore typing when not my turn

    if (e.key >= '0' && e.key <= '9') {
        handleNumberInput(parseInt(e.key));
    } else if (e.key === 'Backspace') {
        handleBackspace();
    } else if (e.key === 'Enter') {
        handleSubmitGuess();
    }
});

// Global onclick trigger directly on HTML button element
window.onRestartClick = function() {
    window.btnRestartClicked = true;
    console.log("onRestartClick triggered!");
    closeModal(resultModal);
    showScreen('screen-lobby');
};

// Info modal toggles
safeAddListener('btn-menu-rules', 'click', () => openModal(rulesModal));
safeAddListener('btn-info', 'click', () => openModal(rulesModal));
safeAddListener('btn-close-rules', 'click', () => closeModal(rulesModal));
window.addEventListener('click', (e) => {
    if (e.target === rulesModal) closeModal(rulesModal);
    if (e.target === joinModal) closeModal(joinModal);
});

// Exit game / Restart game to Lobby
safeAddListener('btn-exit-game', 'click', () => {
    isGameOver = true;
    // Stop polling
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    showScreen('screen-lobby');
});

/* ==========================================================================
   INITIAL RUN
   ========================================================================== */
showScreen('screen-lobby');
