const { randomUUID, randomInt } = require('node:crypto');

const DEFAULT_SETTINGS = Object.freeze({ acceptChallenges: true, inviteNotifications: false, roomNotifications: true });
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
function configuredNumber(env, key, fallback, min, max) {
    const value = Number(env[key]);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function matchmakingConfig(env = process.env) {
    return {
        fanout: configuredNumber(env, 'MATCH_INVITE_FANOUT', 3, 1, 10),
        ttlMs: configuredNumber(env, 'MATCH_INVITE_TTL_SECONDS', 60, 15, 180) * 1000,
        cooldownMs: configuredNumber(env, 'MATCH_INVITE_COOLDOWN_SECONDS', 300, 60, 3600) * 1000,
        recentMs: configuredNumber(env, 'MATCH_RECENT_DAYS', 7, 1, 30) * 86400000,
        heartbeatMs: 15000,
        requestCooldownMs: 10000
    };
}

// This lock is shared by random matching, direct challenges, room entry and preferences.
// A database advisory lock also serializes these mutations across server instances.
class Matchmaking {
    constructor(store, options = {}) {
        this.store = store;
        this.config = options.config || matchmakingConfig();
        this.now = options.now || Date.now;
        this.settings = new Map();
        this.searches = new Map();
        this.tail = Promise.resolve();
    }

    async exclusive(action) {
        const previous = this.tail;
        let release;
        this.tail = new Promise(resolve => { release = resolve; });
        await previous;
        let client;
        try {
            if (this.store.pool) {
                client = await this.store.pool.connect();
                await client.query('begin');
                await client.query('select pg_advisory_xact_lock(482917)');
            }
            return await action();
        } finally {
            try {
                if (client) {
                    try { await client.query('rollback'); }
                    finally { client.release(); }
                }
            } finally { release(); }
        }
    }

    async getSettings(id) {
        if (!this.store.pool) {
            const saved = this.settings.get(id);
            return saved ? { ...DEFAULT_SETTINGS, ...saved } : {
                ...DEFAULT_SETTINGS, inviteNotifications: (this.store.presence.get(id)?.availableUntil || 0) > this.now()
            };
        }
        const result = await this.store.pool.query(`select
            (select settings from hb_match_settings where player_id = $1) as settings,
            (select available_until > now() from hb_player_presence where player_id = $1) as legacy_waiting`, [id]);
        const row = result.rows[0];
        return row?.settings ? { ...DEFAULT_SETTINGS, ...row.settings }
            : { ...DEFAULT_SETTINGS, inviteNotifications: Boolean(row?.legacy_waiting) };
    }

    async saveSettings(id, patch, register = false) {
        const keys = Object.keys(DEFAULT_SETTINGS);
        if (!patch || Array.isArray(patch) || typeof patch !== 'object'
            || Object.entries(patch).some(([key, value]) => !keys.includes(key) || typeof value !== 'boolean')) {
            throw fail('설정 값이 올바르지 않습니다.', 400);
        }
        const settings = { ...await this.getSettings(id), ...patch };
        if (register && !settings.supportsRandom) {
            // The old one-hour waiting opt-in must not silently become a seven-day push opt-in.
            settings.supportsRandom = true;
            settings.inviteNotifications = false;
        }
        if (this.store.pool) {
            await this.store.pool.query(`insert into hb_match_settings (player_id, settings) values ($1, $2::jsonb)
                on conflict (player_id) do update set settings = excluded.settings`, [id, JSON.stringify(settings)]);
        } else this.settings.set(id, settings);
        if (!settings.acceptChallenges) {
            const all = await this.listSearches();
            for (const search of all) {
                if (search.status === 'pending' && search.recipients[id] === 'pending') {
                    search.recipients[id] = 'declined';
                    if (!Object.values(search.recipients).includes('pending')) search.status = 'declined';
                    await this.saveSearch(search);
                }
            }
            const lobby = await this.store.getLobbyState(id);
            if (lobby.challenge?.direction === 'incoming' && lobby.challenge.status === 'pending') {
                await this.store.cancelChallenge(lobby.challenge.id);
            }
        }
        return settings;
    }

    async setActivity(id, activity) {
        if (!['lobby', 'busy', 'background'].includes(activity)) throw fail('접속 상태가 올바르지 않습니다.', 400);
        if (this.store.pool) {
            await this.store.pool.query(`update hb_match_settings
                set settings = jsonb_set(settings, '{activity}', to_jsonb($2::text)) where player_id = $1`, [id, activity]);
        } else if (this.settings.has(id)) {
            this.settings.set(id, { ...this.settings.get(id), activity });
        }
        if (activity !== 'lobby') {
            for (const search of await this.listSearches()) {
                if (search.challengerId === id && search.status === 'pending') {
                    search.status = 'cancelled';
                    await this.saveSearch(search);
                }
            }
        }
    }

    async listSearches() {
        if (!this.store.pool) return [...this.searches.values()].map(value => structuredClone(value));
        const result = await this.store.pool.query(`select state from hb_random_searches
            where status = 'pending' or updated_at > now() - interval '1 hour' order by updated_at desc`);
        return result.rows.map(row => row.state);
    }

    async saveSearch(search, client = this.store.pool) {
        search.updatedAt = this.now();
        if (!client) { this.searches.set(search.id, structuredClone(search)); return; }
        await client.query(`insert into hb_random_searches (id, challenger_id, status, state, updated_at)
            values ($1, $2, $3, $4::jsonb, now()) on conflict (id) do update
            set status = excluded.status, state = excluded.state, updated_at = now()`,
        [search.id, search.challengerId, search.status, JSON.stringify(search)]);
    }

    async prune() {
        const now = this.now();
        const searches = await this.listSearches();
        for (const search of searches) {
            if (search.status !== 'pending') continue;
            if (search.expiresAt <= now || search.heartbeatAt + this.config.heartbeatMs <= now) {
                search.status = search.expiresAt <= now ? 'expired' : 'cancelled';
                await this.saveSearch(search);
            }
        }
        if (this.store.pool) {
            await this.store.pool.query("delete from hb_random_searches where status <> 'pending' and updated_at < now() - interval '1 hour'");
        } else {
            for (const [id, search] of this.searches) {
                if (search.status !== 'pending' && search.updatedAt < now - 3600000) this.searches.delete(id);
            }
        }
        return searches;
    }

    async assertAvailable(id) {
        if (await this.store.findActiveRoom(id)) throw fail('진행 중인 대전을 먼저 종료해 주세요.');
        const lobby = await this.store.getLobbyState(id);
        if (lobby.challenge?.status === 'pending') throw fail('이미 처리 중인 대전 신청이 있습니다.');
        await this.assertNotSearching(id);
    }

    async assertNotSearching(id) {
        const searches = await this.prune();
        if (searches.some(search => search.status === 'pending'
            && (search.challengerId === id || search.recipients[id] === 'pending'))) {
            throw fail('랜덤 대전 신청을 먼저 수락·거절하거나 취소해 주세요.');
        }
    }

    async canReceive(id, online) {
        const settings = await this.getSettings(id);
        return settings.acceptChallenges && (online || settings.inviteNotifications);
    }

    async filterLobbyPlayers(players) {
        let preferences = this.settings;
        if (this.store.pool && players.length) {
            const result = await this.store.pool.query('select player_id, settings from hb_match_settings where player_id = any($1::uuid[])', [players.map(p => p.id)]);
            preferences = new Map(result.rows.map(row => [row.player_id, row.settings]));
        }
        const pending = (await this.listSearches()).filter(search => search.status === 'pending');
        return players.filter(player => {
            const saved = preferences.get(player.id);
            const settings = saved ? { ...DEFAULT_SETTINGS, ...saved }
                : { ...DEFAULT_SETTINGS, inviteNotifications: player.availableUntil > this.now() };
            if (player.online && settings.activity === 'busy') return false;
            const online = player.online && settings.activity !== 'background';
            return settings.acceptChallenges && (online || settings.inviteNotifications)
                && !pending.some(search => search.challengerId === player.id || search.recipients[player.id] === 'pending');
        });
    }

    async presence() {
        if (!this.store.pool) return [...this.store.presence.entries()].map(([id, p]) => ({ id, lastSeen: p.lastSeen }));
        const result = await this.store.pool.query(`select p.player_id as id, extract(epoch from p.last_seen) * 1000 as "lastSeen"
            from hb_player_presence p join hb_players u on u.id = p.player_id and u.deleted_at is null
            where p.last_seen > now() - ($1 * interval '1 millisecond')`, [this.config.recentMs]);
        return result.rows.map(row => ({ id: row.id, lastSeen: Number(row.lastSeen) }));
    }

    async candidates() {
        if (!this.store.pool) {
            return (await this.presence()).filter(person => !this.store.playerHasActiveRoom(person.id)
                && ![...this.store.challenges.values()].some(c => c.status === 'pending' && c.expiresAt > this.now()
                    && [c.challengerId, c.targetId].includes(person.id)))
                .map(person => ({ ...person, settings: { ...DEFAULT_SETTINGS, ...this.settings.get(person.id) },
                    hasToken: Boolean(this.store.pushTokens.get(person.id)?.size) }));
        }
        const result = await this.store.pool.query(`select p.player_id as id,
            extract(epoch from p.last_seen) * 1000 as "lastSeen", s.settings,
            exists (select 1 from hb_push_tokens t where t.player_id = p.player_id) as "hasToken"
            from hb_player_presence p join hb_match_settings s on s.player_id = p.player_id
            join hb_players u on u.id = p.player_id and u.deleted_at is null
            where p.last_seen > now() - ($1 * interval '1 millisecond')
            and not exists (select 1 from hb_active_rooms r where (r.host_id = p.player_id or r.guest_id = p.player_id)
                and r.status in ('waiting', 'setup', 'playing') and r.expires_at > now())
            and not exists (select 1 from hb_match_challenges c where (c.challenger_id = p.player_id or c.target_id = p.player_id)
                and c.status = 'pending' and c.expires_at > now())`, [this.config.recentMs]);
        return result.rows.map(row => ({ ...row, lastSeen: Number(row.lastSeen), settings: { ...DEFAULT_SETTINGS, ...row.settings } }));
    }

    async start(id) {
        const now = this.now();
        const previous = await this.prune();
        const same = previous.find(search => search.challengerId === id && search.status === 'pending');
        if (same) return same;
        await this.assertAvailable(id);
        if (previous.some(search => search.challengerId === id && search.createdAt > now - this.config.requestCooldownMs)) {
            throw fail('잠시 후 다시 찾아 주세요.', 429);
        }
        const candidates = [];
        for (const person of await this.candidates()) {
            if (person.id === id || now - person.lastSeen > this.config.recentMs) continue;
            const settings = person.settings;
            const recentlySeen = now - person.lastSeen <= 45000;
            if (recentlySeen && settings.activity === 'busy') continue;
            const online = recentlySeen && settings.activity !== 'background';
            if (!settings.supportsRandom || !settings.acceptChallenges || (!online && !settings.inviteNotifications)) continue;
            if (!online && !person.hasToken) continue;
            if (previous.some(search => search.recipients[person.id] && search.createdAt > now - this.config.cooldownMs)) continue;
            if (previous.some(search => search.status === 'pending'
                && (search.challengerId === person.id || search.recipients[person.id] === 'pending'))) continue;
            candidates.push({ ...person, online });
        }
        const online = candidates.filter(person => person.online);
        const pool = online.length ? online : candidates;
        for (let i = pool.length - 1; i > 0; i--) {
            const j = randomInt(i + 1);
            [pool[i], pool[j]] = [pool[j], pool[i]];
        }
        if (!pool.length) throw fail('지금 초대할 수 있는 상대가 없습니다. 잠시 후 다시 찾아 주세요.', 404);
        const search = {
            id: randomUUID(), challengerId: id, status: 'pending',
            recipients: Object.fromEntries(pool.slice(0, this.config.fanout).map(person => [person.id, 'pending'])),
            createdAt: now, expiresAt: now + this.config.ttlMs, heartbeatAt: now, updatedAt: now,
            roomCode: null, acceptedBy: null
        };
        await this.saveSearch(search);
        return search;
    }

    async current(id, heartbeat = false) {
        const searches = await this.prune();
        const search = searches.filter(item => item.challengerId === id || item.recipients[id])
            .filter(item => item.status === 'pending' || item.updatedAt > this.now() - 120000)
            .sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt - a.createdAt)[0];
        if (!search) return null;
        if (heartbeat && search.challengerId === id && search.status === 'pending') {
            search.heartbeatAt = this.now();
            await this.saveSearch(search);
        }
        return this.publicSearch(search, id);
    }

    async publicSearch(search, id) {
        const outgoing = search.challengerId === id;
        let status = search.status;
        if (!outgoing && status === 'pending' && search.recipients[id] !== 'pending') status = 'declined';
        if (!outgoing && status === 'accepted' && search.acceptedBy !== id) status = 'matched_elsewhere';
        return {
            id: search.id, kind: 'random', direction: outgoing ? 'outgoing' : 'incoming', status,
            expiresAt: search.expiresAt, invitedCount: Object.keys(search.recipients).length,
            roomCode: status === 'accepted' ? search.roomCode : null,
            challenger: await this.store.getPlayer(search.challengerId)
        };
    }

    async cancel(id, searchId) {
        const search = (await this.prune()).find(item => item.id === searchId && item.challengerId === id);
        if (!search) throw fail('대전 신청을 찾을 수 없습니다.', 404);
        if (search.status === 'pending') { search.status = 'cancelled'; await this.saveSearch(search); }
        return this.publicSearch(search, id);
    }

    async respond(id, searchId, action, makeRoom) {
        if (!['accept', 'decline'].includes(action)) throw fail('수락 또는 거절을 선택해 주세요.', 400);
        const search = (await this.prune()).find(item => item.id === searchId && item.recipients[id]);
        if (!search) throw fail('대전 신청을 찾을 수 없습니다.', 404);
        if (search.status === 'accepted' && search.acceptedBy === id) {
            const room = await this.store.getRoom(search.roomCode);
            if (!room || room.status === 'finished') throw fail('이미 종료된 대전입니다.');
            return { room, role: 'guest' };
        }
        if (search.status === 'accepted') throw fail('다른 상대와 매칭되었어요.');
        if (search.status !== 'pending' || search.recipients[id] !== 'pending') throw fail('이미 종료되었거나 만료된 초대입니다.');
        if (action === 'decline') {
            search.recipients[id] = 'declined';
            if (!Object.values(search.recipients).includes('pending')) search.status = 'declined';
            await this.saveSearch(search);
            return { challenge: await this.publicSearch(search, id) };
        }
        if (!(await this.getSettings(id)).acceptChallenges) throw fail('대전 신청 받기가 꺼져 있습니다.');
        if (await this.store.findActiveRoom(id) || await this.store.findActiveRoom(search.challengerId)) {
            throw fail('이미 다른 대전에 참여 중입니다.');
        }
        const challenger = await this.store.getPlayer(search.challengerId);
        const target = await this.store.getPlayer(id);
        if (!challenger || !target) throw fail('대전 참가자를 찾을 수 없습니다.', 404);
        const room = await makeRoom(challenger, target);
        search.status = 'accepted'; search.acceptedBy = id; search.roomCode = room.code;
        if (this.store.pool) {
            const client = await this.store.pool.connect();
            try {
                await client.query('begin');
                const transactionalStore = Object.create(this.store);
                transactionalStore.pool = client;
                await transactionalStore.saveRoom(room);
                await this.saveSearch(search, client);
                await client.query('commit');
            } catch (error) { await client.query('rollback'); throw error; }
            finally { client.release(); }
        } else {
            await this.store.saveRoom(room);
            await this.saveSearch(search);
        }
        return { room, role: 'guest' };
    }

    async deletePlayer(id) {
        if (this.store.pool) {
            await this.store.pool.query("delete from hb_random_searches where challenger_id = $1 or state->'recipients' ? $2", [id, id]);
        } else {
            this.settings.delete(id);
            for (const [key, search] of this.searches) {
                if (search.challengerId === id || search.recipients[id]) this.searches.delete(key);
            }
        }
    }
}

module.exports = { Matchmaking, DEFAULT_SETTINGS, matchmakingConfig };
