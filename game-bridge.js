/**
 * Game WebView Bridge
 * Provides local profile, haptic, and share helpers for web/app builds.
 */

(function () {
    const STORAGE_KEY_USER = 'homerun_baseball_user_profile';

    const GameBridge = {
        isNative: false,

        getProfile: function () {
            return window.AuthClient.ensureSession().then(session => new Promise((resolve) => {
                let cachedUser = null;
                try {
                    cachedUser = localStorage.getItem(STORAGE_KEY_USER);
                } catch (e) {
                    console.warn("Storage access restricted:", e);
                }

                if (cachedUser) {
                    const profile = JSON.parse(cachedUser);
                    profile.id = session.user.id;
                    try {
                        localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(profile));
                    } catch (e) {}
                    resolve(profile);
                    return;
                }

                const nickname = ('야구유저' + Math.floor(1000 + Math.random() * 9000)).substring(0, 8);

                const userObj = {
                    name: nickname,
                    id: session.user.id,
                    avatar: 'fa-solid fa-circle-user'
                };

                try {
                    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(userObj));
                } catch (e) {
                    console.warn("Could not cache user profile:", e);
                }

                resolve(userObj);
            }));
        },

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

        vibrate: function (style = 'light') {
            if (navigator.vibrate) {
                if (style === 'heavy') navigator.vibrate([100]);
                else navigator.vibrate([30]);
            }
        },

        shareRoomCode: function (roomCode) {
            const shareUrl = `${window.location.origin}${window.location.pathname}?room=${roomCode}`;
            const message = `[홈런 숫자야구] 대전 방이 열렸습니다!\n방 코드: ${roomCode}\n같이 치러 가기: ${shareUrl}`;

            return new Promise((resolve) => {
                navigator.clipboard.writeText(message).then(() => {
                    resolve(true);
                }).catch(() => {
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

    window.GameBridge = GameBridge;
})();
