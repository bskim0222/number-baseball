/**
 * Toss App WebView Bridge Mock SDK (toss-bridge.js)
 * Mimics native App-in-Toss platform functionalities.
 */

(function () {
    const STORAGE_KEY_USER = 'toss_ baseball_user_profile';

    // Check if running inside actual Toss App
    const isTossApp = /Toss|toss/i.test(navigator.userAgent) || 
                      (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.toss);

    const TossBridge = {
        isNative: isTossApp,

        /**
         * Resolves the current user's profile (name, unique ID, avatar).
         * Inside Toss app, it requests native profile.
         * Locally, it loads from localStorage or prompts for nickname.
         */
        getProfile: function () {
            return new Promise((resolve) => {
                if (isTossApp) {
                    // Call actual native bridge (standard App-in-Toss mock call)
                    if (window.TossAppBridge && typeof window.TossAppBridge.getUserInfo === 'function') {
                        window.TossAppBridge.getUserInfo((info) => {
                            resolve({
                                name: info.name || '무명토스',
                                id: info.id || 'TOSS-NATIVE-USER',
                                avatar: 'fa-solid fa-circle-user'
                            });
                        });
                        return;
                    }
                }

                // Local Fallback: Load from localStorage
                let cachedUser = null;
                try {
                    cachedUser = localStorage.getItem(STORAGE_KEY_USER);
                } catch (e) {
                    console.warn("Storage access restricted:", e);
                }

                if (cachedUser) {
                    resolve(JSON.parse(cachedUser));
                    return;
                }

                // If no user profile exists, prompt for username (skip if in test environment)
                let nickname = null;
                const isTestFile = window.location.href.includes('test.html');
                if (!isTestFile) {
                    try {
                        nickname = prompt("토스 앱 연동용 닉네임을 입력해 주세요 (2~8글자):");
                    } catch (e) {
                        console.warn("Prompt blocked in headless mode:", e);
                    }
                }
                if (!nickname || nickname.trim().length < 2) {
                    nickname = '토스유저' + Math.floor(1000 + Math.random() * 9000);
                }
                nickname = nickname.trim().substring(0, 8);

                const userObj = {
                    name: nickname,
                    id: 'TOSS-' + Math.floor(100000 + Math.random() * 900000),
                    avatar: 'fa-solid fa-circle-user'
                };

                try {
                    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(userObj));
                } catch (e) {
                    console.warn("Could not cache user profile:", e);
                }

                resolve(userObj);
            });
        },

        /**
         * Updates the cached user name.
         */
        updateProfileName: function (newName) {
            return new Promise((resolve) => {
                const nameStr = (newName || '').trim().substring(0, 8);
                if (nameStr.length < 2) return resolve(false);

                this.getProfile().then(profile => {
                    profile.name = nameStr;
                    try {
                        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(profile));
                    } catch (e) {}
                    resolve(profile);
                });
            });
        },

        /**
         * Simulates Native Haptic Vibration.
         */
        vibrate: function (style = 'light') {
            if (isTossApp && window.TossAppBridge && typeof window.TossAppBridge.vibrate === 'function') {
                window.TossAppBridge.vibrate(style);
                return;
            }
            // Fallback to HTML5 Vibrate API
            if (navigator.vibrate) {
                if (style === 'heavy') navigator.vibrate([100]);
                else navigator.vibrate([30]);
            }
        },

        /**
         * Simulates room sharing via Toss message or link copying.
         */
        shareRoomCode: function (roomCode) {
            const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
            const message = `[⚾ 토스 홈런야구] 대전 방이 열렸습니다!\n방 코드: ${roomCode}\n같이 치러 가기: ${shareUrl}`;

            if (isTossApp && window.TossAppBridge && typeof window.TossAppBridge.share === 'function') {
                window.TossAppBridge.share({
                    message: message,
                    url: shareUrl
                });
                return Promise.resolve(true);
            }

            // Fallback: Copy to clipboard
            return new Promise((resolve) => {
                navigator.clipboard.writeText(message).then(() => {
                    resolve(true);
                }).catch(() => {
                    // Fallback input copy
                    const tempInput = document.createElement('textarea');
                    tempInput.value = message;
                    document.body.appendChild(tempInput);
                    tempInput.select();
                    document.execCommand('copy');
                    document.body.removeChild(tempInput);
                    resolve(true);
                });
            });
        }
    };

    // Export to global namespace
    window.TossBridge = TossBridge;
})();
