/**
 * Supabase anonymous authentication for the static WebView app.
 * The publishable key is safe to ship in the client; service-role keys are not.
 */
(function () {
    const STORAGE_KEY = 'homerun_baseball_supabase_session_v1';
    const DEV_USER_KEY = 'homerun_baseball_dev_user_v1';

    function config() {
        return {
            url: String(window.HOMERUN_SUPABASE_URL || '').replace(/\/$/, ''),
            key: String(window.HOMERUN_SUPABASE_PUBLISHABLE_KEY || '')
        };
    }

    function readSession() {
        try {
            return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        } catch (error) {
            return null;
        }
    }

    function writeSession(session) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
        } catch (error) {
            console.warn('Could not persist auth session:', error);
        }
    }

    function clearSession() {
        try {
            localStorage.removeItem(STORAGE_KEY);
        } catch (error) {}
    }

    function normalizeSession(payload) {
        const session = payload && payload.session ? payload.session : payload;
        if (!session || !session.access_token || !session.refresh_token || !session.user || !session.user.id) {
            throw new Error('인증 서버가 올바른 세션을 반환하지 않았습니다.');
        }
        const expiresAt = Number(session.expires_at)
            || Math.floor(Date.now() / 1000) + (Number(session.expires_in) || 3600);
        return {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_at: expiresAt,
            user: {
                id: String(session.user.id),
                is_anonymous: session.user.is_anonymous !== false
            }
        };
    }

    async function supabaseRequest(path, options = {}) {
        const { url, key } = config();
        if (!url || !key) throw new Error('Supabase 인증 설정이 필요합니다.');
        const response = await fetch(`${url}/auth/v1${path}`, {
            ...options,
            headers: {
                apikey: key,
                'Content-Type': 'application/json',
                ...(options.headers || {})
            }
        });
        const text = await response.text();
        let body = {};
        try {
            body = text ? JSON.parse(text) : {};
        } catch (error) {
            body = { message: text };
        }
        if (!response.ok) {
            throw new Error(body.msg || body.message || body.error_description || `인증 오류 (${response.status})`);
        }
        return body;
    }

    async function createAnonymousSession() {
        const payload = await supabaseRequest('/signup', {
            method: 'POST',
            body: JSON.stringify({ data: {} })
        });
        const session = normalizeSession(payload);
        writeSession(session);
        return session;
    }

    async function refreshSession(refreshToken) {
        const payload = await supabaseRequest('/token?grant_type=refresh_token', {
            method: 'POST',
            body: JSON.stringify({ refresh_token: refreshToken })
        });
        const session = normalizeSession(payload);
        writeSession(session);
        return session;
    }

    function developmentSession() {
        let id = '';
        try {
            id = localStorage.getItem(DEV_USER_KEY) || '';
            if (!id) {
                id = typeof crypto !== 'undefined' && crypto.randomUUID
                    ? crypto.randomUUID()
                    : `00000000-0000-4000-8000-${String(Date.now()).slice(-12)}`;
                localStorage.setItem(DEV_USER_KEY, id);
            }
        } catch (error) {
            id = '00000000-0000-4000-8000-000000000001';
        }
        return { access_token: 'development', refresh_token: '', expires_at: 4102444800, user: { id, is_anonymous: true }, development: true };
    }

    async function ensureSession(forceRefresh = false) {
        const { url, key } = config();
        const screenshotMode = new URLSearchParams(window.location.search).has('screenshot');
        if ((!url || !key) && (window.HOMERUN_ALLOW_DEV_AUTH === true || window.isAutomatedTest || screenshotMode)) {
            return developmentSession();
        }
        if (!url || !key) throw new Error('앱 인증 설정이 아직 완료되지 않았습니다.');

        const existing = readSession();
        const now = Math.floor(Date.now() / 1000);
        if (!forceRefresh && existing && existing.access_token && existing.user && existing.expires_at > now + 90) {
            return existing;
        }
        if (existing && existing.refresh_token) {
            try {
                return await refreshSession(existing.refresh_token);
            } catch (error) {
                clearSession();
            }
        }
        return createAnonymousSession();
    }

    async function authorizedFetch(url, options = {}) {
        let session = await ensureSession();
        const send = currentSession => fetch(url, {
            ...options,
            headers: {
                ...(options.headers || {}),
                ...(currentSession.development
                    ? { 'X-Test-User-Id': currentSession.user.id }
                    : { Authorization: `Bearer ${currentSession.access_token}` })
            }
        });

        let response = await send(session);
        if (response.status === 401 && !session.development) {
            session = await ensureSession(true);
            response = await send(session);
        }
        return response;
    }

    window.AuthClient = {
        authorizedFetch,
        clearSession,
        ensureSession,
        isConfigured: () => Boolean(config().url && config().key)
    };
})();
