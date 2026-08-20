/**
 * 홈런 숫자야구 - Realtime REST API Integration
 */

// Game Constants
const DIGIT_COUNT = 4;
const MAX_ATTEMPTS = 10;
const STORAGE_KEY_BEST = 'number_baseball_best_4digit';
const STORAGE_KEY_STATS = 'homerun_baseball_stats_v2';
const STORAGE_KEY_ACTIVE_ROOM = 'homerun_baseball_active_room_v1';
const TURN_TIMEOUT_MS = 60_000;
const TIMER_WARNING_SECONDS = 20;

// Resolve Server URL. Published apps need a public HTTPS backend for 1:1 mode.
const CONFIGURED_API_BASE = (window.HOMERUN_API_BASE || '').replace(/\/$/, '');
const IS_LOCAL_HTTP = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(window.location.origin || '');
const API_BASE = (window.isAutomatedTest)
                 ? 'http://127.0.0.1:9999-blocked'
                 : (IS_LOCAL_HTTP
                    ? window.location.origin
                    : (CONFIGURED_API_BASE
                    || ((window.location.origin && window.location.origin.startsWith('http'))
                        ? window.location.origin
                        : 'http://192.168.123.108:8000')));

function apiFetch(route, options = {}) {
    const url = /^https?:\/\//i.test(route) ? route : `${API_BASE}${route}`;
    return window.AuthClient.authorizedFetch(url, options);
}

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

// Player Profile
let myPlayer = { name: "로딩 중...", id: "LOCAL-GUEST", avatar: "fa-solid fa-circle-user", wins: 0, losses: 0, rate: 0 };
let opponentPlayer = null;

// Room Info
let currentRoomCode = '';
let currentRoomTitle = '';
let currentRoomVisibility = 'public';
let selectedRoomVisibility = 'public';
let opponentName = '상대 대기 중...';
let myRole = ''; // 'host' or 'guest'
let pollInterval = null;
let lobbyInterval = null; // Used to poll waiting room list in lobby
let lastRoomDataJson = ''; // Used to prevent redundant redraws
let lastMyGuessesJson = '';
let lastOppGuessesJson = '';
let lastSpokenMyAttempt = 0;
let gameAudioContext = null;
let activeSpeechUtterance = null;
let lastNotifiedGuestId = '';
let pollInFlight = false;
let pollFailureCount = 0;
let networkWarningActive = false;
let lastWarnedTurnStartedAt = 0;
let locallyRecordedRoomCode = '';
let messageDialogResolver = null;
let lobbyRefreshInFlight = false;
let currentLobbyChallenge = null;
let challengeCountdownInterval = null;
let lastResolvedChallengeId = '';
let lastAcceptedChallengeRoomCode = '';

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
const createRoomModal = document.getElementById('create-room-modal');
const joinModal = document.getElementById('join-modal');
const createRoomTitleInput = document.getElementById('create-room-title');
const roomVisibilityHelp = document.getElementById('room-visibility-help');
const accountModal = document.getElementById('account-modal');
const accountNicknameInput = document.getElementById('account-nickname-input');
const accountRecordValue = document.getElementById('account-record-value');
const accountIdValue = document.getElementById('account-id-value');
const messageModal = document.getElementById('message-modal');
const messageModalTitle = document.getElementById('message-modal-title');
const messageModalText = document.getElementById('message-modal-text');
const messageModalIcon = document.getElementById('message-modal-icon');
const messageModalCancel = document.getElementById('message-modal-cancel');
const messageModalConfirm = document.getElementById('message-modal-confirm');
const challengeModal = document.getElementById('challenge-modal');
const matchWaitingCheckbox = document.getElementById('match-waiting-checkbox');
const availablePlayerList = document.getElementById('available-player-list');
const outgoingChallengeStatus = document.getElementById('outgoing-challenge-status');

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

async function readApiResponse(response) {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(body.error || '서버 요청을 처리하지 못했습니다.');
        error.status = response.status;
        throw error;
    }
    return body;
}

function showToast(message, type = 'info', duration = 3200) {
    const stack = document.getElementById('app-toast-stack');
    if (!stack || !message) return;

    const iconByType = {
        success: 'fa-circle-check',
        warning: 'fa-triangle-exclamation',
        error: 'fa-circle-exclamation',
        info: 'fa-circle-info'
    };
    const toast = document.createElement('div');
    toast.className = `app-toast ${type}`;
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.innerHTML = `
        <i class="fa-solid ${iconByType[type] || iconByType.info}" aria-hidden="true"></i>
        <span></span>
    `;
    toast.querySelector('span').textContent = message;
    stack.appendChild(toast);

    window.setTimeout(() => {
        toast.classList.add('leaving');
        window.setTimeout(() => toast.remove(), 220);
    }, duration);
}

function closeMessageDialog(confirmed) {
    if (messageModal) {
        messageModal.classList.add('hidden');
        messageModal.setAttribute('aria-hidden', 'true');
    }
    if (messageDialogResolver) {
        const resolve = messageDialogResolver;
        messageDialogResolver = null;
        resolve(Boolean(confirmed));
    }
}

function showConfirmDialog({ title, message, confirmText = '확인', icon = 'fa-circle-question' }) {
    if (window.isAutomatedTest) return Promise.resolve(true);
    if (!messageModal) return Promise.resolve(window.confirm(message));

    if (messageDialogResolver) closeMessageDialog(false);
    messageModalTitle.textContent = title;
    messageModalText.textContent = message;
    messageModalConfirm.textContent = confirmText;
    messageModalIcon.className = `fa-solid ${icon}`;
    messageModal.classList.remove('hidden');
    messageModal.setAttribute('aria-hidden', 'false');

    return new Promise(resolve => {
        messageDialogResolver = resolve;
    });
}

safeAddListener(messageModalCancel, 'click', () => closeMessageDialog(false));
safeAddListener(messageModalConfirm, 'click', () => closeMessageDialog(true));
safeAddListener(messageModal, 'click', event => {
    if (event.target === messageModal) closeMessageDialog(false);
});

function toSafeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function normalizePlayerStats(player) {
    const wins = Math.max(0, Math.floor(toSafeNumber(player && player.wins)));
    const losses = Math.max(0, Math.floor(toSafeNumber(player && player.losses)));
    const total = wins + losses;
    const calculatedRate = total > 0 ? parseFloat(((wins / total) * 100).toFixed(1)) : 0;
    return {
        ...player,
        wins,
        losses,
        games: total,
        rate: calculatedRate
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

function loadLocalStatsBackup() {
    try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY_STATS) || 'null');
        if (!stored || stored.id !== myPlayer.id) return null;
        return normalizePlayerStats(stored);
    } catch (error) {
        return null;
    }
}

function persistLocalStats() {
    try {
        const stats = normalizePlayerStats(myPlayer);
        localStorage.setItem(STORAGE_KEY_STATS, JSON.stringify({
            id: stats.id,
            name: stats.name,
            wins: stats.wins,
            losses: stats.losses,
            rate: stats.rate,
            updatedAt: Date.now()
        }));
    } catch (error) {
        console.warn('Could not save local stats backup:', error);
    }
}

function updateLobbyProfileName() {
    const nameEl = document.getElementById('lobby-profile-name');
    if (nameEl) {
        nameEl.innerHTML = `${myPlayer.name || '게스트'} <i class="fa-solid fa-pen-to-square edit-icon" style="font-size: 0.8rem; margin-left: 5px; opacity: 0.6;"></i>`;
    }
}

function updateMyNameDisplays() {
    const displayName = myPlayer.name || '게스트';
    const waitingNameEl = document.getElementById('waiting-my-name');
    const gameNameEl = document.getElementById('game-my-name');

    if (waitingNameEl) {
        waitingNameEl.textContent = displayName;
    }
    if (gameNameEl) {
        gameNameEl.textContent = `나 (${displayName})`;
    }
}

function resetRealtimeRenderCache() {
    lastRoomDataJson = '';
    lastMyGuessesJson = '';
    lastOppGuessesJson = '';
    lastSpokenMyAttempt = 0;
    lastNotifiedGuestId = '';
    pollFailureCount = 0;
    networkWarningActive = false;
    lastWarnedTurnStartedAt = 0;
    pollInFlight = false;
    locallyRecordedRoomCode = '';
}

function rememberActiveRoom(room, role) {
    if (!room || !room.code || !role) return;
    try {
        localStorage.setItem(STORAGE_KEY_ACTIVE_ROOM, JSON.stringify({
            code: String(room.code),
            role,
            roomTitle: room.roomTitle || '',
            visibility: room.visibility || 'public',
            savedAt: Date.now()
        }));
    } catch (error) {
        console.warn('Could not save active room:', error);
    }
}

function clearActiveRoom() {
    try {
        localStorage.removeItem(STORAGE_KEY_ACTIVE_ROOM);
    } catch (error) {}
}

function updateWaitingRoomMeta(room) {
    currentRoomTitle = room.roomTitle || `${room.host && room.host.name ? room.host.name : '대전'}님의 방`;
    currentRoomVisibility = room.visibility === 'private' ? 'private' : 'public';

    const title = document.getElementById('waiting-room-title');
    const badge = document.getElementById('room-visibility-badge');
    if (title) title.textContent = currentRoomTitle;
    if (badge) {
        badge.textContent = currentRoomVisibility === 'private' ? '비공개방' : '공개방';
        badge.classList.toggle('private', currentRoomVisibility === 'private');
        badge.classList.toggle('public', currentRoomVisibility !== 'private');
    }
}

function registerPushToken(token) {
    const normalized = String(token || '').trim();
    if (!normalized) return Promise.resolve(false);
    return apiFetch('/api/push/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: normalized, name: myPlayer.name })
    })
        .then(readApiResponse)
        .then(() => true)
        .catch(error => {
            console.warn('Push token registration failed:', error);
            return false;
        });
}

window.onNativePushToken = token => registerPushToken(token);
window.onNativeRoomInvite = () => restoreActiveRoom(true);
window.onNativeChallengeInvite = () => {
    showScreen('screen-lobby');
    refreshLobbyNetwork();
};

function requestRoomNotificationPermission() {
    if (GameBridge && typeof GameBridge.enableRoomNotifications === 'function') {
        GameBridge.enableRoomNotifications()
            .then(token => registerPushToken(token))
            .catch(error => console.warn('Native room notifications unavailable:', error));
    }
    try {
        if ('Notification' in window && Notification.permission === 'default') {
            Notification.requestPermission().catch(() => {});
        }
    } catch (err) {
        // Browser notifications are optional.
    }
}

const START_AUDIO_FILE = 'assets/audio/playball.mp3';
let startAudioCache = null;

function preloadStartAudio() {
    if (startAudioCache) return;
    startAudioCache = new Audio(START_AUDIO_FILE);
    startAudioCache.preload = 'auto';
    startAudioCache.volume = 1;
}

function warmUpSpeechSynthesis() {
    preloadStartAudio();
}

function playStartAudio() {
    try {
        preloadStartAudio();
        const audio = startAudioCache.cloneNode(true);
        audio.volume = 1;
        const playPromise = audio.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(err => console.warn('Start audio blocked or missing:', err));
        }
    } catch (err) {
        console.warn('Start audio failed:', err);
    }
}

function speakReferee() {
    // Disabled: no generated voice or judgment voice.
}

function announcePlayBall() {
    playStartAudio();
}

function speakResult() {
    // Disabled: judgment sound removed by request.
}

function notifyGuestJoined(guest) {
    const guestName = (guest && guest.name) ? guest.name : '상대방';
    GameBridge.vibrate('heavy');
    showToast(`${guestName}님이 대전방에 입장했습니다.`, 'success', 4200);

    try {
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('상대방 입장', {
                body: `${guestName}님이 방에 들어왔습니다.`
            });
        }
    } catch (err) {
        // Browser notifications are optional.
    }
}

document.addEventListener('DOMContentLoaded', () => {
    hydrateRulesModal();
    preloadStartAudio();
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

        // 1. Initialize Profile
    GameBridge.getProfile().then(profile => {
        mergePlayerProfile(profile);
        const localStats = loadLocalStatsBackup();
        if (localStats && localStats.games > myPlayer.games) {
            mergePlayerProfile(localStats);
        }
        updateLobbyProfileName();
        updateMyNameDisplays();
        updateLobbyStatsUI();
        
        // 1.1 Check if room query parameter exists for Auto-Join
        const urlParams = new URLSearchParams(window.location.search);
        const urlRoomCode = urlParams.get('room');
        const screenshotParam = urlParams.get('screenshot');

        // Restore the authoritative record first, then recover an active room.
        syncPlayerStats().then(() => {
            initRankings();
            if (!urlRoomCode && !screenshotParam) restoreActiveRoom(false);
        });

        if (urlRoomCode && [4, 6].includes(urlRoomCode.length)) {
            autoJoinRoomFromUrl(urlRoomCode);
        }

        // 1.2 Check if screenshot query parameter exists for taking app store screenshots
        if (screenshotParam) {
            window.isAutomatedTest = true; // bypass confirmation dialogs
            if (screenshotParam === 'lobby') {
                // Populate rankings and profile stats with realistic mock data
                myPlayer.name = "알쏭달쏭";
                myPlayer.wins = 12;
                myPlayer.losses = 3;
                myPlayer.rate = 80.0;
                updateLobbyStatsUI();
                document.getElementById('lobby-profile-name').innerHTML = `${myPlayer.name} <i class="fa-solid fa-pen-to-square edit-icon" style="font-size: 0.8rem; margin-left: 5px; opacity: 0.6;"></i>`;
                renderLobbyNetwork({
                    counts: { online: 8, available: 3, playing: 4 },
                    me: { acceptingChallenges: true, availableUntil: Date.now() + 60 * 60_000 },
                    challenge: null,
                    availablePlayers: [
                        { id: 'preview-1', name: '홈런왕', wins: 9, losses: 4, rate: 69.2, online: true },
                        { id: 'preview-2', name: '숫자마스터', wins: 5, losses: 2, rate: 71.4, online: false }
                    ]
                });
                
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
            } else if (screenshotParam === 'challenge') {
                renderLobbyNetwork({
                    counts: { online: 7, available: 2, playing: 4 },
                    me: { acceptingChallenges: true, availableUntil: Date.now() + 60 * 60_000 },
                    availablePlayers: [],
                    challenge: {
                        id: 'preview-challenge',
                        direction: 'incoming',
                        status: 'pending',
                        expiresAt: Date.now() + 30_000,
                        challenger: { name: '홈런왕', wins: 9, losses: 4, rate: 69.2 }
                    }
                });
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
            } else if (screenshotParam === 'timer_warning') {
                setTimeout(() => {
                    gameMode = 'multi';
                    myRole = 'host';
                    currentRoomCode = 'SAND';
                    startMultiGame({
                        status: 'playing',
                        currentTurn: 'host',
                        host: { name: myPlayer.name },
                        guest: { name: '대전 상대' },
                        secrets: { host: [], guest: [] }
                    });
                    const timerContainer = document.getElementById('turn-timer-container');
                    const timerValue = document.getElementById('turn-timer-value');
                    if (timerContainer && timerValue) {
                        timerValue.textContent = TIMER_WARNING_SECONDS;
                        timerContainer.style.display = 'inline-flex';
                        timerContainer.classList.add('timer-warning');
                    }
                }, 1000);
            }
        }
    }).catch(error => {
        mergePlayerProfile({ name: '게스트', id: 'AUTH-PENDING' });
        updateLobbyProfileName();
        updateMyNameDisplays();
        updateLobbyStatsUI();
        showToast(`1:1 인증 준비가 필요합니다: ${error.message}`, 'warning', 6000);
    });

    // 2. Setup Profile Nickname Modifier
    const profileBar = document.getElementById('lobby-profile-bar');
    if (profileBar) {
        profileBar.addEventListener('click', () => {
            if (accountNicknameInput) accountNicknameInput.value = myPlayer.name || '';
            if (accountIdValue) accountIdValue.textContent = myPlayer.id || '확인할 수 없음';
            if (accountRecordValue) {
                accountRecordValue.textContent = `${myPlayer.wins}승 ${myPlayer.losses}패 · 승률 ${myPlayer.rate}%`;
            }
            openModal(accountModal);
        });
    }
});

/**
 * Automatically joins a multiplayer room from a URL invitation link.
 */
function autoJoinRoomFromUrl(inputCode) {
    const data = {
        room: inputCode,
        guestName: myPlayer.name
    };

    apiFetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(readApiResponse)
    .then(room => {
        gameMode = 'multi';
        myRole = 'guest';
        isGameOver = false;
        currentRoomCode = inputCode;
        document.getElementById('room-code-value').textContent = currentRoomCode;
        updateWaitingRoomMeta(room);
        rememberActiveRoom(room, myRole);

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
        showToast(`${room.host.name}님의 대전방에 입장했습니다.`, 'success');
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

    apiFetch('/api/rooms')
    .then(readApiResponse)
    .then(rooms => {
        const container = document.getElementById('public-rooms-list');
        if (!container) return;
        
        if (!rooms || rooms.length === 0) {
            container.innerHTML = `<div style="font-size: 0.85rem; color: rgba(255,255,255,0.4); text-align: center; padding: 15px 0;">대기 중인 방이 없습니다.</div>`;
            return;
        }

        container.innerHTML = '';
        rooms.forEach(room => {
            const escapedTitle = escapeHtml(room.roomTitle || `${room.hostName}님의 방`);
            const escapedCode = escapeHtml(room.code);
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
                    <span style="font-weight: 600; color: #fff;">${escapedTitle}</span>
                    <span style="display: block; font-size: 0.75rem; color: var(--neon-blue); font-family: var(--font-numeric); margin-top: 2px;"># ${escapedCode}</span>
                </div>
                <button type="button" style="
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
            item.querySelector('button').addEventListener('click', () => joinPublicRoom(room.code));
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
    showConfirmDialog({
        title: '대전방 참가',
        message: `${code}번 방에 입장하시겠습니까?`,
        confirmText: '입장하기',
        icon: 'fa-arrow-right-to-bracket'
    }).then(confirmed => {
        if (confirmed) autoJoinRoomFromUrl(code);
    });
}

function playerRecordText(player) {
    const wins = Number(player && player.wins) || 0;
    const losses = Number(player && player.losses) || 0;
    const rate = Number(player && player.rate) || 0;
    return `${wins}승 ${losses}패 · 승률 ${rate}%`;
}

function renderAvailablePlayers(players, hasPendingChallenge) {
    if (!availablePlayerList) return;
    if (!players || players.length === 0) {
        availablePlayerList.innerHTML = '<div class="match-list-empty">대전 대기 중인 사용자가 없습니다.</div>';
        return;
    }

    availablePlayerList.innerHTML = '';
    players.forEach(player => {
        const row = document.createElement('div');
        row.className = 'available-player-row';
        row.innerHTML = `
            <i class="fa-solid fa-circle-user available-player-avatar"></i>
            <div class="available-player-copy">
                <strong>${escapeHtml(player.name)}</strong>
                <span>${escapeHtml(playerRecordText(player))} · <span class="player-online-state">${player.online ? '접속 중' : '알림 대기'}</span></span>
            </div>
            <button type="button" class="challenge-player-btn" ${hasPendingChallenge ? 'disabled' : ''}>신청</button>
        `;
        row.querySelector('button').addEventListener('click', () => sendDirectChallenge(player.id, player.name));
        availablePlayerList.appendChild(row);
    });
}

function updateChallengeCountdown(challenge) {
    if (challengeCountdownInterval) clearInterval(challengeCountdownInterval);
    const update = () => {
        const secondsEl = document.getElementById('challenge-expiry-seconds');
        const seconds = Math.max(0, Math.ceil((Number(challenge.expiresAt) - Date.now()) / 1000));
        if (secondsEl) secondsEl.textContent = seconds;
        if (seconds <= 0) {
            clearInterval(challengeCountdownInterval);
            challengeCountdownInterval = null;
            closeModal(challengeModal);
            refreshLobbyNetwork();
        }
    };
    update();
    challengeCountdownInterval = setInterval(update, 250);
}

function showIncomingChallenge(challenge) {
    if (!challengeModal || !challenge || challenge.status !== 'pending') return;
    const opponent = challenge.challenger || {};
    const name = document.getElementById('challenge-opponent-name');
    const record = document.getElementById('challenge-opponent-record');
    if (name) name.textContent = `${opponent.name || '상대방'}님의 신청`;
    if (record) record.textContent = playerRecordText(opponent);
    openModal(challengeModal);
    updateChallengeCountdown(challenge);
    GameBridge.vibrate('heavy');
}

function handleLobbyChallenge(challenge) {
    currentLobbyChallenge = challenge || null;
    const isPending = Boolean(challenge && challenge.status === 'pending');
    if (outgoingChallengeStatus) {
        const outgoing = isPending && challenge.direction === 'outgoing';
        outgoingChallengeStatus.classList.toggle('hidden', !outgoing);
        if (outgoing) {
            const targetName = challenge.target && challenge.target.name ? challenge.target.name : '상대방';
            const seconds = Math.max(0, Math.ceil((Number(challenge.expiresAt) - Date.now()) / 1000));
            outgoingChallengeStatus.innerHTML = `<i class="fa-regular fa-clock"></i> ${escapeHtml(targetName)}님의 응답을 기다리는 중 · ${seconds}초`;
        }
    }

    if (isPending && challenge.direction === 'incoming') {
        showIncomingChallenge(challenge);
        return;
    }
    if (challengeCountdownInterval) {
        clearInterval(challengeCountdownInterval);
        challengeCountdownInterval = null;
    }
    closeModal(challengeModal);

    if (challenge && challenge.status === 'accepted' && challenge.roomCode) {
        if (lastAcceptedChallengeRoomCode !== challenge.roomCode) {
            lastAcceptedChallengeRoomCode = challenge.roomCode;
            restoreActiveRoom(true);
        }
        return;
    }

    if (challenge && challenge.direction === 'outgoing'
        && ['declined', 'expired', 'cancelled'].includes(challenge.status)
        && lastResolvedChallengeId !== `${challenge.id}:${challenge.status}`) {
        lastResolvedChallengeId = `${challenge.id}:${challenge.status}`;
        const messages = {
            declined: '상대방이 대전 신청을 거절했습니다.',
            expired: '대전 신청 응답 시간이 지났습니다.',
            cancelled: '상대방이 다른 대전에 참여해 신청이 취소되었습니다.'
        };
        showToast(messages[challenge.status], 'info', 4200);
    }
}

function renderLobbyNetwork(data) {
    const counts = data.counts || {};
    const onlineEl = document.getElementById('presence-online');
    const availableEl = document.getElementById('presence-available');
    const playingEl = document.getElementById('presence-playing');
    if (onlineEl) onlineEl.textContent = Number(counts.online) || 0;
    if (availableEl) availableEl.textContent = Number(counts.available) || 0;
    if (playingEl) playingEl.textContent = Number(counts.playing) || 0;

    const accepting = Boolean(data.me && data.me.acceptingChallenges);
    if (matchWaitingCheckbox) matchWaitingCheckbox.checked = accepting;
    const waitingStatus = document.getElementById('match-waiting-status');
    if (waitingStatus) {
        waitingStatus.textContent = accepting
            ? '최대 1시간 동안 대전 신청과 알림을 받습니다.'
            : '대전 대기를 켜면 신청을 받을 수 있습니다.';
    }
    handleLobbyChallenge(data.challenge);
    renderAvailablePlayers(data.availablePlayers, Boolean(data.challenge && data.challenge.status === 'pending'));
}

function refreshLobbyNetwork() {
    if (window.isAutomatedTest || lobbyRefreshInFlight || currentScreen !== 'screen-lobby') return Promise.resolve();
    lobbyRefreshInFlight = true;
    return apiFetch(`/api/lobby?name=${encodeURIComponent(myPlayer.name || '')}`)
        .then(readApiResponse)
        .then(renderLobbyNetwork)
        .catch(error => console.warn('Lobby presence refresh failed:', error.message))
        .finally(() => { lobbyRefreshInFlight = false; });
}

function sendDirectChallenge(targetUserId, targetName) {
    if (currentLobbyChallenge && currentLobbyChallenge.status === 'pending') return;
    apiFetch('/api/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetUserId, name: myPlayer.name })
    })
        .then(readApiResponse)
        .then(challenge => {
            currentLobbyChallenge = challenge;
            showToast(`${targetName}님에게 대전을 신청했습니다.`, 'success');
            refreshLobbyNetwork();
        })
        .catch(error => showToast(error.message, 'warning', 4200));
}

function respondToDirectChallenge(action) {
    const challenge = currentLobbyChallenge;
    if (!challenge || challenge.direction !== 'incoming' || challenge.status !== 'pending') return;
    const acceptButton = document.getElementById('btn-accept-challenge');
    const declineButton = document.getElementById('btn-decline-challenge');
    if (acceptButton) acceptButton.disabled = true;
    if (declineButton) declineButton.disabled = true;

    apiFetch(`/api/challenges/${encodeURIComponent(challenge.id)}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
    })
        .then(readApiResponse)
        .then(result => {
            closeModal(challengeModal);
            if (action === 'accept' && result.room) {
                applyRestoredRoom(result.room, result.role || 'guest');
                showToast('대전 신청을 수락했습니다.', 'success');
            } else {
                currentLobbyChallenge = null;
                showToast('대전 신청을 거절했습니다.', 'info');
                refreshLobbyNetwork();
            }
        })
        .catch(error => {
            showToast(error.message, 'warning', 4200);
            refreshLobbyNetwork();
        })
        .finally(() => {
            if (acceptButton) acceptButton.disabled = false;
            if (declineButton) declineButton.disabled = false;
        });
}

safeAddListener(matchWaitingCheckbox, 'change', () => {
    const acceptingChallenges = Boolean(matchWaitingCheckbox.checked);
    matchWaitingCheckbox.disabled = true;
    if (acceptingChallenges) requestRoomNotificationPermission();
    apiFetch('/api/lobby/presence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptingChallenges, name: myPlayer.name })
    })
        .then(readApiResponse)
        .then(() => {
            showToast(acceptingChallenges ? '1시간 동안 대전 대기를 시작합니다.' : '대전 대기를 종료했습니다.', 'success');
            refreshLobbyNetwork();
        })
        .catch(error => {
            matchWaitingCheckbox.checked = !acceptingChallenges;
            showToast(error.message, 'warning');
        })
        .finally(() => { matchWaitingCheckbox.disabled = false; });
});
safeAddListener('btn-accept-challenge', 'click', () => respondToDirectChallenge('accept'));
safeAddListener('btn-decline-challenge', 'click', () => respondToDirectChallenge('decline'));

function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    })[character]);
}

function applyRestoredRoom(room, role) {
    gameMode = 'multi';
    myRole = role;
    isGameOver = false;
    currentRoomCode = room.code;
    document.getElementById('room-code-value').textContent = currentRoomCode;
    updateWaitingRoomMeta(room);
    rememberActiveRoom(room, role);
    updateMyNameDisplays();

    const opponent = role === 'host' ? room.guest : room.host;
    const opponentNameEl = document.getElementById('opponent-name');
    const opponentAvatarEl = document.getElementById('opponent-avatar');
    const opponentCardEl = document.getElementById('opponent-card');
    const opponentStatusEl = document.getElementById('opponent-status');

    if (opponent) {
        opponentNameEl.textContent = opponent.name;
        opponentAvatarEl.className = 'fa-solid fa-circle-user';
        opponentCardEl.className = 'player-card active-player';
        opponentStatusEl.textContent = opponent.status === 'ready' ? '준비 완료' : '설정 중...';
        opponentStatusEl.className = 'player-status ready';
    } else {
        opponentNameEl.textContent = '상대 대기 중...';
        opponentAvatarEl.className = 'fa-solid fa-circle-question';
        opponentCardEl.className = 'player-card waiting-player';
        opponentStatusEl.textContent = '초대 대기';
        opponentStatusEl.className = 'player-status';
    }

    mySecretInput = room.secrets && Array.isArray(room.secrets[role])
        ? room.secrets[role].slice(0, DIGIT_COUNT)
        : [];
    updateSetupSlots();
    resetRealtimeRenderCache();
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(pollRoomState, 800);

    if (room.status === 'playing') startMultiGame(room);
    else showScreen('screen-waiting');
}

function restoreActiveRoom(fromNotification) {
    if (window.isAutomatedTest || gameMode === 'solo' && currentScreen === 'screen-game') {
        return Promise.resolve(false);
    }
    return apiFetch('/api/me/active-room')
        .then(readApiResponse)
        .then(response => {
            if (!response.room) {
                clearActiveRoom();
                return false;
            }
            applyRestoredRoom(response.room, response.role);
            if (response.role === 'host') requestRoomNotificationPermission();
            showToast(
                fromNotification && response.room.guest
                    ? `${response.room.guest.name}님이 입장한 방으로 돌아왔습니다.`
                    : '진행 중인 대전방으로 돌아왔습니다.',
                'success',
                3600
            );
            return true;
        })
        .catch(error => {
            console.warn('Active room restore failed:', error);
            return false;
        });
}
window.joinPublicRoom = joinPublicRoom;

/**
 * Sync the local backup with the server and use the newest complete record.
 */
function syncPlayerStats() {
    return apiFetch('/api/me/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: myPlayer.name
        })
    })
        .then(readApiResponse)
        .then(response => {
            if (response.player) mergePlayerProfile(response.player);
            persistLocalStats();
            updateLobbyStatsUI();
            return myPlayer;
        })
        .catch(error => {
            console.warn('Stats server unavailable; using device backup.', error);
            updateLobbyStatsUI();
            return myPlayer;
        });
}

function saveRankingToServer() {
    const data = { name: myPlayer.name };
    persistLocalStats();
    return apiFetch('/api/me', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
        .then(readApiResponse)
        .then(response => {
            if (response.player) mergePlayerProfile(response.player);
            persistLocalStats();
            updateLobbyStatsUI();
            return myPlayer;
        })
        .catch(() => myPlayer);
}

function updateLobbyStatsUI() {
    myPlayer = normalizePlayerStats(myPlayer);
    const safeStatsEl = document.getElementById('lobby-profile-stats');
    if (safeStatsEl) {
        safeStatsEl.textContent = `전적: ${myPlayer.wins}승 ${myPlayer.losses}패 (승률 ${myPlayer.rate}%)`;
    }
}

function updateMyRankSummary(players) {
    const rankValue = document.getElementById('my-rank-position');
    const rankDetail = document.getElementById('my-rank-detail');
    if (!rankValue || !rankDetail) return;

    const rankedPlayers = players.filter(player => player.games > 0);
    const myIndex = rankedPlayers.findIndex(player => player.isMe);
    if (myIndex < 0) {
        rankValue.textContent = '기록 없음';
        rankDetail.textContent = '첫 1:1 대전 후 순위가 집계됩니다.';
        return;
    }

    const rank = myIndex + 1;
    const percentile = Math.max(1, Math.ceil((rank / rankedPlayers.length) * 100));
    const record = rankedPlayers[myIndex];
    rankValue.textContent = `${rank}위`;
    rankDetail.textContent = `상위 ${percentile}% · ${record.wins}승 ${record.losses}패 · 승률 ${record.rate}%`;
}

/**
 * Initializes the global rankings / leaderboard.
 */
function initRankings() {
    return apiFetch('/api/rankings')
        .then(readApiResponse)
        .then(players => {
            const normalizedPlayers = players.map(player => ({
                ...normalizePlayerStats(player),
                isMe: Boolean(player.isMe)
            }));
            normalizedPlayers.sort((a, b) => (
                b.wins - a.wins
                || b.rate - a.rate
                || a.losses - b.losses
            ));

            const serverMe = normalizedPlayers.find(player => player.isMe);
            if (serverMe) {
                mergePlayerProfile(serverMe);
                persistLocalStats();
                updateLobbyStatsUI();
            }

            updateMyRankSummary(normalizedPlayers);
            renderLeaderboard(normalizedPlayers.filter(player => player.games > 0));
            return normalizedPlayers;
        })
        .catch(error => {
            console.warn('Leaderboard server unavailable:', error);
            const localPlayer = { ...normalizePlayerStats(myPlayer), isMe: true };
            updateMyRankSummary([]);
            renderLeaderboard(localPlayer.games > 0 ? [localPlayer] : []);
            const detail = document.getElementById('my-rank-detail');
            if (detail) detail.textContent = '서버 연결 후 순위를 확인할 수 있습니다.';
            showToast('랭킹 서버 연결이 잠시 불안정합니다.', 'warning');
            return [];
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
    closeModal(createRoomModal);
    closeModal(joinModal);
    closeModal(challengeModal);
    if (messageModal && !messageModal.classList.contains('hidden')) {
        closeMessageDialog(false);
    }

    // Manage Public Rooms list polling interval
    if (screenId === 'screen-lobby') {
        refreshPublicRooms();
        refreshLobbyNetwork();
        if (!lobbyInterval) {
            lobbyInterval = setInterval(() => {
                refreshPublicRooms();
                refreshLobbyNetwork();
            }, 3000);
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
            if (currentRoomCode && currentRoomCode !== 'SAND') {
                apiFetch('/api/leave', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ room: currentRoomCode, role: myRole })
                }).catch(() => {});
            }
            clearActiveRoom();
            currentRoomCode = '';
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

function setRoomVisibility(visibility) {
    selectedRoomVisibility = visibility === 'private' ? 'private' : 'public';
    document.querySelectorAll('.visibility-option').forEach(button => {
        button.classList.toggle('active', button.dataset.visibility === selectedRoomVisibility);
    });
    if (roomVisibilityHelp) {
        roomVisibilityHelp.textContent = selectedRoomVisibility === 'private'
            ? '공개방 목록에는 나타나지 않습니다. 생성 후 6자리 초대 코드를 공유하세요.'
            : '공개방 목록에 표시되어 누구나 참가할 수 있습니다.';
    }
}

safeAddListener('btn-menu-create', 'click', () => {
    setRoomVisibility('public');
    if (createRoomTitleInput) createRoomTitleInput.value = '';
    openModal(createRoomModal);
    if (createRoomTitleInput) window.setTimeout(() => createRoomTitleInput.focus(), 120);
});

safeAddListener('btn-room-public', 'click', () => setRoomVisibility('public'));
safeAddListener('btn-room-private', 'click', () => setRoomVisibility('private'));
safeAddListener('btn-close-create', 'click', () => closeModal(createRoomModal));

safeAddListener('btn-submit-create', 'click', () => {
    gameMode = 'multi';
    myRole = 'host';
    isGameOver = false;
    requestRoomNotificationPermission();
    updateMyNameDisplays();
    closeModal(createRoomModal);

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
    const data = {
        hostName: myPlayer.name,
        roomTitle: createRoomTitleInput ? createRoomTitleInput.value.trim() : '',
        visibility: selectedRoomVisibility
    };
    apiFetch('/api/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(readApiResponse)
    .then(room => {
        currentRoomCode = room.code;
        document.getElementById('room-code-value').textContent = currentRoomCode;
        updateWaitingRoomMeta(room);
        rememberActiveRoom(room, myRole);

        // Start polling room state
        resetRealtimeRenderCache();
        pollInterval = setInterval(pollRoomState, 800);
        showScreen('screen-waiting');
        showToast(`대전방 ${room.code}번을 만들었습니다.`, 'success');
    })
    .catch(err => {
        if (!window.isAutomatedTest) {
            gameMode = 'solo';
            showScreen('screen-lobby');
            showToast('대전 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'error', 4500);
            return;
        }
        console.warn("REST Server offline during test, fallback to sandbox.");
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

safeAddListener('btn-close-account', 'click', () => closeModal(accountModal));

safeAddListener('btn-copy-account-id', 'click', () => {
    const accountId = String(myPlayer.id || '');
    if (!accountId || accountId === 'LOCAL-GUEST' || accountId === 'AUTH-PENDING') {
        showToast('계정 식별번호를 아직 불러오지 못했습니다.', 'warning');
        return;
    }
    const copyPromise = navigator.clipboard && navigator.clipboard.writeText
        ? navigator.clipboard.writeText(accountId)
        : Promise.reject(new Error('clipboard unavailable'));
    copyPromise.catch(() => {
        const field = document.createElement('textarea');
        field.value = accountId;
        document.body.appendChild(field);
        field.select();
        document.execCommand('copy');
        field.remove();
    }).then(() => showToast('계정 식별번호를 복사했습니다.', 'success'));
});

safeAddListener('btn-save-account-name', 'click', () => {
    const nextName = accountNicknameInput ? accountNicknameInput.value.trim() : '';
    if (nextName.length < 2) {
        showToast('닉네임은 2글자 이상 입력해 주세요.', 'warning');
        return;
    }
    GameBridge.updateProfileName(nextName).then(updated => {
        if (!updated) throw new Error('닉네임을 저장하지 못했습니다.');
        mergePlayerProfile(updated);
        return saveRankingToServer();
    }).then(() => {
        updateLobbyProfileName();
        updateMyNameDisplays();
        closeModal(accountModal);
        showToast('닉네임을 변경했습니다.', 'success');
    }).catch(error => showToast(error.message, 'error'));
});

safeAddListener('btn-reset-record', 'click', () => {
    showConfirmDialog({
        title: '현재 시즌 전적 초기화',
        message: '현재 시즌의 승패 기록을 0승 0패로 초기화합니다.',
        confirmText: '초기화',
        icon: 'fa-rotate-left'
    }).then(confirmed => {
        if (!confirmed) return null;
        return apiFetch('/api/me/record', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'RESET' })
        }).then(readApiResponse);
    }).then(response => {
        if (!response || !response.player) return;
        mergePlayerProfile(response.player);
        persistLocalStats();
        updateLobbyStatsUI();
        if (accountRecordValue) accountRecordValue.textContent = '0승 0패 · 승률 0%';
        showToast('현재 시즌 전적을 초기화했습니다.', 'success');
    }).catch(error => showToast(error.message, 'error'));
});

safeAddListener('btn-delete-account', 'click', () => {
    showConfirmDialog({
        title: '계정과 기록 삭제',
        message: '익명 계정, 닉네임, 모든 시즌 전적과 경기 연결 기록을 삭제합니다. 이 작업은 되돌릴 수 없습니다.',
        confirmText: '완전 삭제',
        icon: 'fa-user-xmark'
    }).then(confirmed => {
        if (!confirmed) return null;
        return apiFetch('/api/me', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation: 'DELETE' })
        }).then(readApiResponse);
    }).then(response => {
        if (!response || !response.success) return;
        window.AuthClient.clearSession();
        localStorage.removeItem(STORAGE_KEY_STATS);
        localStorage.removeItem('homerun_baseball_user_profile');
        window.location.reload();
    }).catch(error => showToast(error.message, 'error'));
});

safeAddListener('btn-submit-join', 'click', () => {
    const inputCode = document.getElementById('join-room-input').value.trim();
    if (!/^\d{4}(\d{2})?$/.test(inputCode)) {
        showToast('4자리 공개방 번호 또는 6자리 초대 코드를 입력해 주세요.', 'warning');
        return;
    }

    const data = {
        room: inputCode,
        guestName: myPlayer.name
    };

    apiFetch('/api/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
    })
    .then(readApiResponse)
    .then(room => {
        gameMode = 'multi';
        myRole = 'guest';
        isGameOver = false;
        currentRoomCode = inputCode;
        document.getElementById('room-code-value').textContent = currentRoomCode;
        updateWaitingRoomMeta(room);
        rememberActiveRoom(room, myRole);

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
        showToast(`${room.host.name}님의 대전방에 입장했습니다.`, 'success');
    })
    .catch(err => {
        showToast(`방 참가 실패: ${err.message}`, 'error', 4500);
    });
});

safeAddListener('btn-menu-rankings', 'click', () => {
    initRankings();
    showScreen('screen-leaderboard');
});

// Copy room code to clipboard
safeAddListener('btn-copy-code', 'click', () => {
    GameBridge.shareRoomCode(currentRoomCode, currentRoomTitle, currentRoomVisibility).then(() => {
        GameBridge.vibrate('light');
        showToast('초대 메시지를 공유했습니다.', 'success');
    });
});

/* ==========================================================================
   REST API GAME STATE POLLING LOOP
   ========================================================================== */

function updateTurnTimer(room) {
    const timerContainer = document.getElementById('turn-timer-container');
    const timerValue = document.getElementById('turn-timer-value');
    if (!timerContainer || !timerValue) return;

    if (room.status !== 'playing' || currentScreen !== 'screen-game' || !room.turnStartedAt) {
        timerContainer.style.display = 'none';
        timerContainer.classList.remove('timer-warning');
        return;
    }

    const duration = Number(room.turnDurationMs) || TURN_TIMEOUT_MS;
    const elapsed = Date.now() - Number(room.turnStartedAt);
    const remaining = Math.max(0, Math.ceil((duration - elapsed) / 1000));
    const shouldWarn = room.currentTurn === myRole && remaining <= TIMER_WARNING_SECONDS;

    timerContainer.style.display = 'inline-flex';
    timerValue.textContent = remaining;
    timerContainer.classList.toggle('timer-warning', shouldWarn);

    if (shouldWarn && lastWarnedTurnStartedAt !== room.turnStartedAt) {
        lastWarnedTurnStartedAt = room.turnStartedAt;
        GameBridge.vibrate('heavy');
        showToast('내 공격 시간이 20초 남았습니다.', 'warning', 3500);
    }
}

function markPollRecovered() {
    if (networkWarningActive) {
        showToast('대전 서버에 다시 연결되었습니다.', 'success');
    }
    pollFailureCount = 0;
    networkWarningActive = false;
}

function markPollFailed(error) {
    pollFailureCount += 1;
    console.error('Polling error:', error);

    if (pollFailureCount >= 3 && !networkWarningActive) {
        networkWarningActive = true;
        showToast('연결이 불안정합니다. 재접속을 시도하고 있습니다.', 'warning', 5000);
    }
}

async function pollRoomState() {
    if (!currentRoomCode || gameMode !== 'multi' || pollInFlight || isGameOver) return;
    pollInFlight = true;

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const requestTimeout = window.setTimeout(() => {
        if (controller) controller.abort();
    }, 6000);

    try {
        const response = await apiFetch(
            `/api/poll?room=${encodeURIComponent(currentRoomCode)}&role=${encodeURIComponent(myRole)}`,
            controller ? { signal: controller.signal } : undefined
        );
        const room = await readApiResponse(response);
        markPollRecovered();
        updateTurnTimer(room);

        const roomJson = JSON.stringify({
            status: room.status,
            currentTurn: room.currentTurn,
            winner: room.winner,
            reason: room.reason,
            host: room.host ? { name: room.host.name, status: room.host.status } : null,
            guest: room.guest ? { name: room.guest.name, status: room.guest.status } : null,
            guesses: room.guesses,
            secrets: room.secrets,
            playerStats: room.playerStats
        });
        if (roomJson === lastRoomDataJson) return;
        lastRoomDataJson = roomJson;

        if (room.status === 'setup' && myRole === 'host' && room.guest) {
            const guestKey = room.guest.id || room.guest.name || 'guest';
            if (guestKey !== lastNotifiedGuestId) {
                lastNotifiedGuestId = guestKey;
                notifyGuestJoined(room.guest);
            }
            document.getElementById('opponent-name').textContent = room.guest.name;
            document.getElementById('opponent-avatar').className = 'fa-solid fa-circle-user';
            document.getElementById('opponent-card').className = 'player-card active-player';
            document.getElementById('opponent-status').textContent = '설정 중...';
            document.getElementById('opponent-status').className = 'player-status ready';
        }

        if (room.status === 'setup' || room.status === 'playing') {
            if (myRole === 'host' && room.guest && room.guest.status === 'ready') {
                document.getElementById('opponent-status').textContent = '준비 완료';
            } else if (myRole === 'guest' && room.host && room.host.status === 'ready') {
                document.getElementById('opponent-status').textContent = '준비 완료';
            }
        }

        if (room.status === 'playing' && currentScreen !== 'screen-game') {
            startMultiGame(room);
        }

        if (room.status === 'playing' && currentScreen === 'screen-game') {
            syncRealtimeGuesses(room);
        }

        if (room.status === 'finished') {
            clearInterval(pollInterval);
            pollInterval = null;
            clearActiveRoom();
            const isWin = room.winner === myRole;
            if (room.secrets) {
                const oppRole = myRole === 'host' ? 'guest' : 'host';
                secretNumbers = room.secrets[oppRole] || secretNumbers;
            }
            const myGuessesList = room.guesses && room.guesses[myRole]
                ? Object.values(room.guesses[myRole])
                : [];
            endGame(
                isWin,
                myGuessesList.length,
                room.winner !== myRole,
                room.reason,
                room.playerStats
            );
        }
    } catch (error) {
        markPollFailed(error);
        if (error.status === 404 && pollFailureCount >= 3) {
            clearInterval(pollInterval);
            pollInterval = null;
            isGameOver = true;
            clearActiveRoom();
            showScreen('screen-lobby');
            showToast('대전방 연결이 종료되었습니다. 새 방에서 다시 시작해 주세요.', 'error', 5000);
        }
    } finally {
        window.clearTimeout(requestTimeout);
        pollInFlight = false;
    }
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
    updateMyNameDisplays();
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

    updateMyNameDisplays();
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
        apiFetch('/api/ready', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        })
            .then(readApiResponse)
            .then(room => {
                showToast('수비 숫자 설정을 완료했습니다.', 'success');
                if (room.status === 'playing' && currentScreen !== 'screen-game') {
                    startMultiGame(room);
                }
            })
            .catch(error => {
                document.getElementById('btn-ready-start').disabled = false;
                showToast(`준비 설정 실패: ${error.message}`, 'error', 4500);
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
        GameBridge.vibrate('light');
        updateSlots();
    }
}

function handleBackspace() {
    if (currentGuess.length > 0) {
        currentGuess.pop();
        GameBridge.vibrate('light');
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
        showToast('서로 다른 숫자 4개를 모두 입력해 주세요.', 'warning');
        return;
    }

    GameBridge.vibrate('heavy');

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
            const submittedGuess = [...currentGuess];
            const data = {
                room: currentRoomCode,
                role: myRole,
                guess: submittedGuess,
                attempt: attemptNumber
            };

            currentGuess = [];
            updateSlots();

            apiFetch('/api/guess', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            }).then(readApiResponse).then(room => {
                syncRealtimeGuesses(room);
            }).catch(error => {
                currentGuess = submittedGuess;
                updateSlots();
                showToast(`공격 전송 실패: ${error.message}`, 'error', 4500);
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

function applyCompletedMatchStats(isWin, serverStats) {
    if (gameMode !== 'multi' || currentRoomCode === 'SAND') return;

    if (serverStats) {
        mergePlayerProfile(serverStats);
        persistLocalStats();
        updateLobbyStatsUI();
        return;
    }

    // v6 never accepts wins or losses from the device. Re-fetch the server record.
    if (locallyRecordedRoomCode === currentRoomCode) return;
    locallyRecordedRoomCode = currentRoomCode;
    syncPlayerStats();
}

function notifyNativeAdAfterNormalResult(reason) {
    if (reason !== 'win') return;
    if (!window.AndroidAds || typeof window.AndroidAds.onNormalGameCompleted !== 'function') return;

    window.setTimeout(() => {
        try {
            window.AndroidAds.onNormalGameCompleted(reason);
        } catch (err) {
            console.warn('Android ad bridge unavailable:', err);
        }
    }, 1800);
}

function endGame(isWin, attemptsUsed, isOpponentWin = false, reason = "win", serverStats = null) {
    try {
        isGameOver = true;
        disableKeypad();

        // Hide timer
        const timerContainer = document.getElementById('turn-timer-container');
        if (timerContainer) timerContainer.style.display = 'none';

        resultSecret.textContent = secretNumbers.length ? secretNumbers.join(' ') : '-';
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
                    resultMessage.textContent = `상대방 (${opponentName})의 공격 제한시간(60초) 초과로 승리했습니다.`;
                } else {
                    resultTitle.textContent = '🏆 대전 승리!';
                    resultMessage.textContent = `상대방 (${opponentName})보다 먼저 숫자를 맞췄습니다!`;
                }
            } else {
                resultBadge.className = 'result-badge lose';
                resultBadge.innerHTML = '<i class="fa-solid fa-skull-crossbones"></i>';
                resultTitle.className = 'result-title lose-title';
                
                if (reason === 'disconnect') {
                    resultTitle.textContent = '💀 기권 패배...';
                    resultMessage.textContent = `내 네트워크 신호가 약해 게임방에서 퇴장 및 기권패 처리되었습니다.`;
                } else if (reason === 'timeout') {
                    resultTitle.textContent = '💀 시간초과 패배...';
                    resultMessage.textContent = '내 공격 제한시간(60초) 안에 숫자를 입력하지 못해 패배했습니다.';
                } else {
                    resultTitle.textContent = '💀 대전 패배...';
                    resultMessage.textContent = `상대방 (${opponentName})이 내 숫자(${mySecretNumbers.join('')})를 먼저 맞췄습니다!`;
                }
            }

            applyCompletedMatchStats(isWin, serverStats);
        }

        setTimeout(() => {
            openModal(resultModal);
            notifyNativeAdAfterNormalResult(reason);
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

    if (!playersList.length) {
        const emptyRow = document.createElement('tr');
        emptyRow.className = 'ranking-empty-row';
        emptyRow.innerHTML = '<td colspan="4">아직 집계된 1:1 대전 기록이 없습니다.</td>';
        tbody.appendChild(emptyRow);
        return;
    }

    playersList.forEach((player, index) => {
        const tr = document.createElement('tr');
        const rank = index + 1;
        
        let rankBadge = `<span class="rank-num normal">${rank}</span>`;
        if (rank === 1) rankBadge = `<span class="rank-num gold">1</span>`;
        else if (rank === 2) rankBadge = `<span class="rank-num silver">2</span>`;
        else if (rank === 3) rankBadge = `<span class="rank-num bronze">3</span>`;

        tr.innerHTML = `
            <td>${rankBadge}</td>
            <td><span class="rank-name ${player.isMe ? 'me' : ''}"></span></td>
            <td><span class="rank-table-stats">${player.wins}승 ${player.losses}패</span></td>
            <td><span class="rank-table-rate ${player.rate >= 75 ? 'high' : ''}">${player.rate}%</span></td>
        `;
        tr.querySelector('.rank-name').textContent = `${player.name}${player.isMe ? ' (나)' : ''}`;
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
    syncPlayerStats();
};

// Info modal toggles
safeAddListener('btn-menu-rules', 'click', () => openModal(rulesModal));
safeAddListener('btn-info', 'click', () => openModal(rulesModal));
safeAddListener('btn-close-rules', 'click', () => closeModal(rulesModal));
window.addEventListener('click', (e) => {
    if (e.target === rulesModal) closeModal(rulesModal);
    if (e.target === createRoomModal) closeModal(createRoomModal);
    if (e.target === joinModal) closeModal(joinModal);
    if (e.target === accountModal) closeModal(accountModal);
});

// Exit game / Restart game to Lobby
safeAddListener('btn-exit-game', 'click', () => {
    isGameOver = true;
    if (gameMode === 'multi' && currentRoomCode && currentRoomCode !== 'SAND') {
        apiFetch('/api/leave', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ room: currentRoomCode, role: myRole })
        }).catch(() => {});
    }
    clearActiveRoom();
    // Stop polling
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    showScreen('screen-lobby');
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gameMode === 'multi' && !isGameOver) {
        pollRoomState();
    }
});

/* ==========================================================================
   INITIAL RUN
   ========================================================================== */
showScreen('screen-lobby');
