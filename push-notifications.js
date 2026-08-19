function readServiceAccount() {
    const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim();
    if (!raw) return null;

    try {
        const decoded = raw.startsWith('{')
            ? raw
            : Buffer.from(raw, 'base64').toString('utf8');
        const account = JSON.parse(decoded);
        if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, '\n');
        return account;
    } catch (error) {
        console.error('[PUSH] FIREBASE_SERVICE_ACCOUNT_JSON is invalid:', error.message);
        return null;
    }
}

function createPushService(options = {}) {
    const dataStore = options.dataStore;
    let messaging = options.messaging || null;
    let configured = Boolean(messaging);

    if (!messaging && process.env.NODE_ENV !== 'test') {
        const serviceAccount = readServiceAccount();
        if (serviceAccount) {
            try {
                const admin = require('firebase-admin');
                const app = admin.apps.length
                    ? admin.app()
                    : admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
                messaging = app.messaging();
                configured = true;
            } catch (error) {
                console.error('[PUSH] Firebase Admin initialization failed:', error.message);
            }
        }
    }

    async function sendRoomJoined(userId, room) {
        if (!configured || !messaging || !dataStore) return { sent: 0, skipped: true };

        const tokens = await dataStore.getPushTokens(userId);
        if (!tokens.length) return { sent: 0, skipped: true };

        const response = await messaging.sendEachForMulticast({
            tokens,
            notification: {
                title: '상대방이 입장했습니다',
                body: `${room.guestName}님이 ${room.roomTitle}에 입장했습니다.`
            },
            data: {
                type: 'room_joined',
                roomCode: String(room.roomCode),
                role: 'host'
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'match_alerts',
                    sound: 'default',
                    tag: `room-${room.roomCode}`
                }
            }
        });

        const invalidTokens = [];
        response.responses.forEach((result, index) => {
            const code = result.error && result.error.code;
            if (code === 'messaging/registration-token-not-registered'
                || code === 'messaging/invalid-registration-token') {
                invalidTokens.push(tokens[index]);
            }
        });
        await Promise.all(invalidTokens.map(token => dataStore.deletePushToken(token)));
        return { sent: response.successCount, failed: response.failureCount };
    }

    return {
        configured: () => configured,
        sendRoomJoined
    };
}

module.exports = { createPushService, readServiceAccount };
