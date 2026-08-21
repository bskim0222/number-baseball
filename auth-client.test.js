const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function storage(initial = {}) {
    const values = new Map(Object.entries(initial));
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key)
    };
}

function loadBrowserScript(fileName, overrides = {}) {
    const window = {
        HOMERUN_SUPABASE_URL: 'https://auth.example.test',
        HOMERUN_SUPABASE_PUBLISHABLE_KEY: 'publishable-test-key',
        HOMERUN_ALLOW_DEV_AUTH: false,
        location: { search: '' },
        setTimeout,
        clearTimeout,
        ...overrides.window
    };
    const context = {
        window,
        localStorage: overrides.localStorage || storage(),
        fetch: overrides.fetch || (() => { throw new Error('unexpected fetch'); }),
        URLSearchParams,
        crypto,
        console,
        setTimeout,
        clearTimeout
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, fileName), 'utf8'), context, { filename: fileName });
    return context;
}

test('authentication retries once and stops instead of waiting forever', async () => {
    let fetchCount = 0;
    const context = loadBrowserScript('auth-client.js', {
        fetch: () => {
            fetchCount += 1;
            return new Promise(() => {});
        },
        window: {
            setTimeout: callback => {
                queueMicrotask(callback);
                return 1;
            },
            clearTimeout: () => {}
        }
    });

    await assert.rejects(
        context.window.AuthClient.ensureSession(),
        /응답 시간이 초과/
    );
    assert.equal(fetchCount, 2);
});

test('a valid saved session restores without a network request', async () => {
    const savedSession = {
        access_token: 'saved-access-token',
        refresh_token: 'saved-refresh-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'saved-user', is_anonymous: true }
    };
    const context = loadBrowserScript('auth-client.js', {
        localStorage: storage({
            homerun_baseball_supabase_session_v1: JSON.stringify(savedSession)
        })
    });

    const restored = await context.window.AuthClient.ensureSession();
    assert.equal(restored.user.id, 'saved-user');
});

test('cached nickname is available before authentication completes', () => {
    const context = loadBrowserScript('game-bridge.js', {
        localStorage: storage({
            homerun_baseball_user_profile: JSON.stringify({ id: 'player-1', name: '홈런왕' })
        }),
        window: { AuthClient: { ensureSession: () => new Promise(() => {}) } }
    });

    assert.equal(context.window.GameBridge.getCachedProfile().name, '홈런왕');
});
