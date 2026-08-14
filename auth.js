const AUTH_CACHE_MS = 2 * 60_000;

function createAuth(options = {}) {
    const supabaseUrl = String(options.supabaseUrl || process.env.SUPABASE_URL || '').replace(/\/$/, '');
    const publishableKey = options.publishableKey
        || process.env.SUPABASE_PUBLISHABLE_KEY
        || process.env.SUPABASE_ANON_KEY
        || '';
    const serviceRoleKey = options.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    const allowTestAuth = options.allowTestAuth !== undefined
        ? options.allowTestAuth
        : process.env.NODE_ENV === 'test';
    const tokenCache = new Map();

    function configured() {
        return Boolean(supabaseUrl && publishableKey);
    }

    async function verifyToken(token) {
        const cached = tokenCache.get(token);
        if (cached && cached.expiresAt > Date.now()) return cached.user;

        if (!configured()) {
            const error = new Error('인증 서버가 아직 설정되지 않았습니다.');
            error.status = 503;
            throw error;
        }

        const response = await fetch(`${supabaseUrl}/auth/v1/user`, {
            headers: {
                apikey: publishableKey,
                Authorization: `Bearer ${token}`
            }
        });
        if (!response.ok) {
            const error = new Error('로그인 정보를 확인할 수 없습니다.');
            error.status = 401;
            throw error;
        }

        const user = await response.json();
        if (!user || !user.id) {
            const error = new Error('사용자 정보가 올바르지 않습니다.');
            error.status = 401;
            throw error;
        }

        tokenCache.set(token, {
            user: { id: String(user.id), isAnonymous: Boolean(user.is_anonymous) },
            expiresAt: Date.now() + AUTH_CACHE_MS
        });
        return tokenCache.get(token).user;
    }

    async function requireUser(req, res, next) {
        try {
            if (allowTestAuth && req.headers['x-test-user-id']) {
                req.user = { id: String(req.headers['x-test-user-id']), isAnonymous: true };
                return next();
            }

            const header = String(req.headers.authorization || '');
            const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
            if (!token) return res.status(401).json({ error: '로그인이 필요합니다.' });

            req.user = await verifyToken(token);
            return next();
        } catch (error) {
            return res.status(error.status || 401).json({ error: error.message || '로그인에 실패했습니다.' });
        }
    }

    async function deleteAuthUser(userId) {
        if (!supabaseUrl || !serviceRoleKey) {
            const error = new Error('계정 삭제용 서버 키가 설정되지 않았습니다.');
            error.status = 503;
            throw error;
        }

        const response = await fetch(`${supabaseUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
            method: 'DELETE',
            headers: {
                apikey: serviceRoleKey,
                Authorization: `Bearer ${serviceRoleKey}`
            }
        });
        if (!response.ok) {
            const body = await response.text();
            const error = new Error(`인증 계정 삭제 실패 (${response.status}): ${body.slice(0, 120)}`);
            error.status = 502;
            throw error;
        }
    }

    return { configured, deleteAuthUser, requireUser, verifyToken };
}

module.exports = { createAuth };

