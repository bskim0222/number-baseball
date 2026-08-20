const fs = require('node:fs');
const path = require('node:path');

function safePlayerName(value) {
    const name = typeof value === 'string' ? value.trim().slice(0, 12) : '';
    return name || '야구유저';
}

function calculateRate(wins, losses) {
    const total = wins + losses;
    return total > 0 ? Number(((wins / total) * 100).toFixed(1)) : 0;
}

function publicPlayer(record) {
    const wins = Number(record.wins) || 0;
    const losses = Number(record.losses) || 0;
    return {
        id: String(record.id || record.player_id),
        name: safePlayerName(record.name || record.nickname),
        wins,
        losses,
        games: wins + losses,
        rate: calculateRate(wins, losses),
        seasonId: Number(record.season_id || record.seasonId || 1),
        seasonName: record.season_name || record.seasonName || '시즌 1'
    };
}

function roomSnapshot(room) {
    if (!room) return null;
    const { statsPromise, ...state } = room;
    return JSON.parse(JSON.stringify(state));
}

function storeError(message, status = 409) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function publicChallenge(challenge, userId) {
    if (!challenge) return null;
    const challengerId = String(challenge.challengerId || challenge.challenger_id);
    const targetId = String(challenge.targetId || challenge.target_id);
    return {
        id: String(challenge.id),
        challengerId,
        targetId,
        direction: challengerId === String(userId) ? 'outgoing' : 'incoming',
        status: challenge.status,
        roomCode: challenge.roomCode || challenge.room_code || null,
        expiresAt: Number(challenge.expiresAt || challenge.expires_at || 0),
        createdAt: Number(challenge.createdAt || challenge.created_at || 0),
        challenger: challenge.challenger || null,
        target: challenge.target || null
    };
}

class MemoryStore {
    constructor() {
        this.players = new Map();
        this.stats = new Map();
        this.matches = new Set();
        this.resets = [];
        this.pushTokens = new Map();
        this.activeRooms = new Map();
        this.presence = new Map();
        this.challenges = new Map();
        this.season = { id: 1, name: '시즌 1' };
    }

    async init() {}

    async health() {
        return { provider: 'memory', connected: true };
    }

    async ensurePlayer(id, name) {
        const current = this.players.get(id) || { id, name: safePlayerName(name), deleted: false };
        current.name = safePlayerName(name || current.name);
        current.deleted = false;
        this.players.set(id, current);
        if (!this.stats.has(id)) this.stats.set(id, { wins: 0, losses: 0 });
        return this.getPlayer(id);
    }

    async getPlayer(id) {
        const player = this.players.get(id);
        if (!player || player.deleted) return null;
        const stats = this.stats.get(id) || { wins: 0, losses: 0 };
        return publicPlayer({ ...player, ...stats, seasonId: this.season.id, seasonName: this.season.name });
    }

    async updateName(id, name) {
        const player = this.players.get(id);
        if (!player || player.deleted) return this.ensurePlayer(id, name);
        player.name = safePlayerName(name);
        return this.getPlayer(id);
    }

    async listRankings() {
        const list = [];
        for (const id of this.players.keys()) {
            const player = await this.getPlayer(id);
            if (player) list.push(player);
        }
        return list.sort((a, b) => b.wins - a.wins || b.rate - a.rate || a.losses - b.losses || a.name.localeCompare(b.name, 'ko'));
    }

    async recordMatch(match) {
        if (this.matches.has(match.matchId)) {
            return { duplicate: true, winner: await this.getPlayer(match.winnerId), loser: await this.getPlayer(match.loserId) };
        }
        this.matches.add(match.matchId);
        await this.ensurePlayer(match.winnerId, match.winnerName);
        await this.ensurePlayer(match.loserId, match.loserName);
        const winnerStats = this.stats.get(match.winnerId);
        const loserStats = this.stats.get(match.loserId);
        winnerStats.wins += 1;
        loserStats.losses += 1;
        return {
            duplicate: false,
            winner: await this.getPlayer(match.winnerId),
            loser: await this.getPlayer(match.loserId)
        };
    }

    async resetPlayer(id) {
        const previous = this.stats.get(id) || { wins: 0, losses: 0 };
        this.resets.push({ id, ...previous, seasonId: this.season.id, createdAt: Date.now() });
        this.stats.set(id, { wins: 0, losses: 0 });
        return this.getPlayer(id);
    }

    async deletePlayer(id) {
        this.players.delete(id);
        this.stats.delete(id);
        this.pushTokens.delete(id);
        this.presence.delete(id);
        for (const [challengeId, challenge] of this.challenges.entries()) {
            if (challenge.challengerId === id || challenge.targetId === id) this.challenges.delete(challengeId);
        }
        for (const [code, room] of this.activeRooms.entries()) {
            if (room.host.id === id || (room.guest && room.guest.id === id)) {
                this.activeRooms.delete(code);
            }
        }
    }

    async savePushToken(userId, token, platform = 'android') {
        const tokens = this.pushTokens.get(userId) || new Map();
        tokens.set(token, { token, platform, updatedAt: Date.now() });
        this.pushTokens.set(userId, tokens);
    }

    async getPushTokens(userId) {
        return [...(this.pushTokens.get(userId) || new Map()).keys()];
    }

    async deletePushToken(token) {
        for (const tokens of this.pushTokens.values()) tokens.delete(token);
    }

    async saveRoom(room) {
        const state = roomSnapshot(room);
        this.activeRooms.set(state.code, state);
        return state;
    }

    async getRoom(code) {
        const state = this.activeRooms.get(String(code));
        if (!state) return null;
        if (state.expiresAt && state.expiresAt <= Date.now()) {
            this.activeRooms.delete(String(code));
            return null;
        }
        return { ...roomSnapshot(state), statsPromise: null };
    }

    async deleteRoom(code) {
        this.activeRooms.delete(String(code));
    }

    async findActiveRoom(userId) {
        const active = [...this.activeRooms.values()]
            .filter(room => room.expiresAt > Date.now())
            .filter(room => ['waiting', 'setup', 'playing'].includes(room.status))
            .filter(room => room.host.id === userId || (room.guest && room.guest.id === userId))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        return active ? { ...roomSnapshot(active), statsPromise: null } : null;
    }

    async listWaitingRooms() {
        return [...this.activeRooms.values()]
            .filter(room => room.status === 'waiting' && room.visibility === 'public' && room.expiresAt > Date.now())
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(room => ({
                code: room.code,
                roomTitle: room.roomTitle,
                hostName: room.host.name,
                expiresAt: room.expiresAt
            }));
    }

    expireChallenges(now = Date.now()) {
        for (const challenge of this.challenges.values()) {
            if (challenge.status === 'pending' && challenge.expiresAt <= now) {
                challenge.status = 'expired';
                challenge.updatedAt = now;
            }
        }
    }

    playerHasActiveRoom(userId, now = Date.now()) {
        return [...this.activeRooms.values()].some(room =>
            room.expiresAt > now
            && ['waiting', 'setup', 'playing'].includes(room.status)
            && (room.host.id === userId || (room.guest && room.guest.id === userId))
        );
    }

    async touchPresence(userId, acceptingChallenges) {
        const now = Date.now();
        const current = this.presence.get(userId) || { userId, availableUntil: 0 };
        current.lastSeen = now;
        if (typeof acceptingChallenges === 'boolean') {
            current.availableUntil = acceptingChallenges ? now + 60 * 60_000 : 0;
        }
        this.presence.set(userId, current);
        return {
            acceptingChallenges: current.availableUntil > now && !this.playerHasActiveRoom(userId, now),
            availableUntil: current.availableUntil
        };
    }

    async getLobbyState(userId) {
        const now = Date.now();
        this.expireChallenges(now);
        const playingIds = new Set();
        for (const room of this.activeRooms.values()) {
            if (room.expiresAt <= now || !['setup', 'playing'].includes(room.status)) continue;
            playingIds.add(room.host.id);
            if (room.guest) playingIds.add(room.guest.id);
        }

        const availablePlayers = [];
        for (const [id, state] of this.presence.entries()) {
            if (id === userId || state.availableUntil <= now || this.playerHasActiveRoom(id, now)) continue;
            const player = await this.getPlayer(id);
            if (player) availablePlayers.push({
                ...player,
                online: now - state.lastSeen <= 45_000,
                availableUntil: state.availableUntil
            });
        }
        availablePlayers.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name, 'ko'));

        const currentChallenge = [...this.challenges.values()]
            .filter(challenge => challenge.challengerId === userId || challenge.targetId === userId)
            .filter(challenge => challenge.status === 'pending'
                || (challenge.status === 'accepted' && now - challenge.updatedAt <= 2 * 60_000)
                || (['declined', 'expired', 'cancelled'].includes(challenge.status) && now - challenge.updatedAt <= 15_000))
            .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
        if (currentChallenge) {
            currentChallenge.challenger = await this.getPlayer(currentChallenge.challengerId);
            currentChallenge.target = await this.getPlayer(currentChallenge.targetId);
        }

        const me = this.presence.get(userId) || { availableUntil: 0 };
        return {
            counts: {
                online: [...this.presence.values()].filter(item => now - item.lastSeen <= 45_000).length,
                available: [...this.presence.entries()].filter(([id, item]) => item.availableUntil > now && !this.playerHasActiveRoom(id, now)).length,
                playing: playingIds.size
            },
            me: { acceptingChallenges: me.availableUntil > now && !this.playerHasActiveRoom(userId, now), availableUntil: me.availableUntil },
            availablePlayers,
            challenge: publicChallenge(currentChallenge, userId)
        };
    }

    async createChallenge(challengerId, targetId, expiresAt) {
        const now = Date.now();
        this.expireChallenges(now);
        if (challengerId === targetId) throw storeError('자기 자신에게는 대전을 신청할 수 없습니다.', 400);
        const targetPresence = this.presence.get(targetId);
        if (!targetPresence || targetPresence.availableUntil <= now || this.playerHasActiveRoom(targetId, now)) {
            throw storeError('상대방이 현재 대전 신청을 받을 수 없습니다.');
        }
        if (this.playerHasActiveRoom(challengerId, now)) throw storeError('진행 중인 대전을 먼저 종료해 주세요.');
        const conflict = [...this.challenges.values()].find(challenge =>
            challenge.status === 'pending'
            && [challenge.challengerId, challenge.targetId].some(id => id === challengerId || id === targetId)
        );
        if (conflict) throw storeError('이미 처리 중인 대전 신청이 있습니다.');
        const recent = [...this.challenges.values()].find(challenge =>
            challenge.updatedAt > now - 10_000
            && challenge.challengerId === challengerId
            && challenge.targetId === targetId
        );
        if (recent) throw storeError('잠시 후 다시 신청해 주세요.', 429);

        const challenge = {
            id: require('node:crypto').randomUUID(),
            challengerId,
            targetId,
            status: 'pending',
            roomCode: null,
            expiresAt,
            createdAt: now,
            updatedAt: now,
            challenger: await this.getPlayer(challengerId),
            target: await this.getPlayer(targetId)
        };
        this.challenges.set(challenge.id, challenge);
        return publicChallenge(challenge, challengerId);
    }

    async respondToChallenge(challengeId, targetId, action) {
        const now = Date.now();
        this.expireChallenges(now);
        const challenge = this.challenges.get(String(challengeId));
        if (!challenge || challenge.targetId !== targetId) throw storeError('대전 신청을 찾을 수 없습니다.', 404);
        if (challenge.status !== 'pending') throw storeError('이미 처리되었거나 만료된 대전 신청입니다.');
        challenge.status = action === 'accept' ? 'accepted' : 'declined';
        challenge.updatedAt = now;
        challenge.challenger = await this.getPlayer(challenge.challengerId);
        challenge.target = await this.getPlayer(challenge.targetId);
        return publicChallenge(challenge, targetId);
    }

    async setChallengeRoom(challengeId, roomCode) {
        const challenge = this.challenges.get(String(challengeId));
        if (!challenge) throw storeError('대전 신청을 찾을 수 없습니다.', 404);
        challenge.roomCode = String(roomCode);
        challenge.updatedAt = Date.now();
    }

    async cancelChallenge(challengeId) {
        const challenge = this.challenges.get(String(challengeId));
        if (challenge && challenge.status !== 'declined') {
            challenge.status = 'cancelled';
            challenge.updatedAt = Date.now();
        }
    }

    async startSeason(name) {
        this.season = { id: this.season.id + 1, name: safePlayerName(name || `시즌 ${this.season.id + 1}`) };
        this.stats = new Map();
        return this.season;
    }
}

function createPostgresPoolOptions(databaseUrl) {
    const connectionUrl = new URL(databaseUrl);
    connectionUrl.searchParams.delete('sslmode');
    connectionUrl.searchParams.delete('uselibpqcompat');
    const isLocal = ['localhost', '127.0.0.1'].includes(connectionUrl.hostname);
    const options = {
        connectionString: connectionUrl.toString(),
        max: 5,
        ssl: false
    };
    if (!isLocal) {
        options.ssl = {
            ca: fs.readFileSync(path.join(__dirname, 'supabase-prod-ca-2021.crt'), 'utf8'),
            rejectUnauthorized: true,
            servername: connectionUrl.hostname
        };
    }
    return options;
}

class PostgresStore {
    constructor(databaseUrl) {
        const { Pool } = require('pg');
        this.pool = new Pool(createPostgresPoolOptions(databaseUrl));
    }

    async init() {
        const schema = fs.readFileSync(path.join(__dirname, 'supabase-schema.sql'), 'utf8');
        await this.pool.query(schema);
    }

    async health() {
        await this.pool.query('select 1');
        return { provider: 'postgres', connected: true };
    }

    async currentSeason(client = this.pool) {
        const result = await client.query('select id, name from hb_seasons where is_active = true order by id desc limit 1');
        if (!result.rows[0]) throw new Error('활성 시즌이 없습니다.');
        return result.rows[0];
    }

    async ensurePlayer(id, name) {
        const nickname = safePlayerName(name);
        await this.pool.query(
            `insert into hb_players (id, nickname) values ($1, $2)
             on conflict (id) do update set
                nickname = case when hb_players.deleted_at is null then excluded.nickname else hb_players.nickname end,
                updated_at = now()`,
            [id, nickname]
        );
        const season = await this.currentSeason();
        await this.pool.query(
            `insert into hb_player_season_stats (player_id, season_id)
             values ($1, $2) on conflict (player_id, season_id) do nothing`,
            [id, season.id]
        );
        return this.getPlayer(id);
    }

    async getPlayer(id) {
        const result = await this.pool.query(
            `select p.id, p.nickname, s.wins, s.losses,
                    season.id as season_id, season.name as season_name
             from hb_players p
             join hb_seasons season on season.is_active = true
             left join hb_player_season_stats s on s.player_id = p.id and s.season_id = season.id
             where p.id = $1 and p.deleted_at is null`,
            [id]
        );
        return result.rows[0] ? publicPlayer({ ...result.rows[0], wins: result.rows[0].wins || 0, losses: result.rows[0].losses || 0 }) : null;
    }

    async updateName(id, name) {
        await this.pool.query(
            'update hb_players set nickname = $2, updated_at = now() where id = $1 and deleted_at is null',
            [id, safePlayerName(name)]
        );
        return this.getPlayer(id);
    }

    async listRankings() {
        const result = await this.pool.query(
            `select p.id, p.nickname, s.wins, s.losses,
                    season.id as season_id, season.name as season_name
             from hb_players p
             join hb_seasons season on season.is_active = true
             join hb_player_season_stats s on s.player_id = p.id and s.season_id = season.id
             where p.deleted_at is null
             order by s.wins desc,
                      case when s.wins + s.losses > 0
                           then s.wins::numeric / (s.wins + s.losses)
                           else 0 end desc,
                      s.losses asc, p.nickname asc`
        );
        return result.rows.map(publicPlayer);
    }

    async recordMatch(match) {
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            const season = await this.currentSeason(client);
            for (const player of [
                { id: match.winnerId, name: match.winnerName },
                { id: match.loserId, name: match.loserName }
            ]) {
                await client.query(
                    `insert into hb_players (id, nickname) values ($1, $2)
                     on conflict (id) do update set nickname = excluded.nickname, updated_at = now()`,
                    [player.id, safePlayerName(player.name)]
                );
                await client.query(
                    `insert into hb_player_season_stats (player_id, season_id)
                     values ($1, $2) on conflict (player_id, season_id) do nothing`,
                    [player.id, season.id]
                );
            }

            const inserted = await client.query(
                `insert into hb_matches (match_id, room_code, season_id, winner_id, loser_id, reason, rating_change)
                 values ($1, $2, $3, $4, $5, $6, 0)
                 on conflict (match_id) do nothing returning match_id`,
                [match.matchId, match.roomCode, season.id, match.winnerId, match.loserId, match.reason]
            );
            if (!inserted.rows[0]) {
                await client.query('rollback');
                return { duplicate: true, winner: await this.getPlayer(match.winnerId), loser: await this.getPlayer(match.loserId) };
            }

            await client.query(
                `update hb_player_season_stats
                 set wins = wins + 1, updated_at = now()
                 where player_id = $1 and season_id = $2`,
                [match.winnerId, season.id]
            );
            await client.query(
                `update hb_player_season_stats
                 set losses = losses + 1, updated_at = now()
                 where player_id = $1 and season_id = $2`,
                [match.loserId, season.id]
            );
            await client.query('commit');
            return {
                duplicate: false,
                winner: await this.getPlayer(match.winnerId),
                loser: await this.getPlayer(match.loserId)
            };
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }

    async resetPlayer(id) {
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            const season = await this.currentSeason(client);
            const current = await client.query(
                `select wins, losses, rating from hb_player_season_stats
                 where player_id = $1 and season_id = $2 for update`,
                [id, season.id]
            );
            const stats = current.rows[0] || { wins: 0, losses: 0, rating: 1000 };
            await client.query(
                `insert into hb_record_resets
                    (player_id, season_id, previous_wins, previous_losses, previous_rating)
                 values ($1, $2, $3, $4, $5)`,
                [id, season.id, stats.wins, stats.losses, stats.rating]
            );
            await client.query(
                `insert into hb_player_season_stats (player_id, season_id, wins, losses, rating)
                 values ($1, $2, 0, 0, 1000)
                 on conflict (player_id, season_id) do update
                 set wins = 0, losses = 0, rating = 1000, updated_at = now()`,
                [id, season.id]
            );
            await client.query('commit');
            return this.getPlayer(id);
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }

    async deletePlayer(id) {
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            await client.query('delete from hb_push_tokens where player_id = $1', [id]);
            await client.query('delete from hb_match_challenges where challenger_id = $1 or target_id = $1', [id]);
            await client.query('delete from hb_player_presence where player_id = $1', [id]);
            await client.query('delete from hb_active_rooms where host_id = $1 or guest_id = $1', [id]);
            await client.query('delete from hb_matches where winner_id = $1 or loser_id = $1', [id]);
            await client.query('delete from hb_record_resets where player_id = $1', [id]);
            await client.query('delete from hb_player_season_stats where player_id = $1', [id]);
            await client.query('delete from hb_players where id = $1', [id]);
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }

    async savePushToken(userId, token, platform = 'android') {
        await this.pool.query(
            `insert into hb_push_tokens (token, player_id, platform)
             values ($1, $2, $3)
             on conflict (token) do update set
                player_id = excluded.player_id,
                platform = excluded.platform,
                updated_at = now()`,
            [token, userId, platform]
        );
    }

    async getPushTokens(userId) {
        const result = await this.pool.query(
            'select token from hb_push_tokens where player_id = $1 order by updated_at desc',
            [userId]
        );
        return result.rows.map(row => row.token);
    }

    async deletePushToken(token) {
        await this.pool.query('delete from hb_push_tokens where token = $1', [token]);
    }

    async saveRoom(room) {
        const state = roomSnapshot(room);
        await this.pool.query(
            `insert into hb_active_rooms
                (code, match_id, status, visibility, host_id, guest_id, state, expires_at, updated_at)
             values ($1, $2, $3, $4, $5, $6, $7::jsonb, to_timestamp($8 / 1000.0), now())
             on conflict (code) do update set
                match_id = excluded.match_id,
                status = excluded.status,
                visibility = excluded.visibility,
                host_id = excluded.host_id,
                guest_id = excluded.guest_id,
                state = excluded.state,
                expires_at = excluded.expires_at,
                updated_at = now()`,
            [
                state.code,
                state.matchId,
                state.status,
                state.visibility,
                state.host.id,
                state.guest ? state.guest.id : null,
                JSON.stringify(state),
                state.expiresAt
            ]
        );
        return state;
    }

    async getRoom(code) {
        const result = await this.pool.query(
            `select state from hb_active_rooms
             where code = $1 and expires_at > now()`,
            [String(code)]
        );
        const state = result.rows[0] && result.rows[0].state;
        return state ? { ...state, statsPromise: null } : null;
    }

    async deleteRoom(code) {
        await this.pool.query('delete from hb_active_rooms where code = $1', [String(code)]);
    }

    async findActiveRoom(userId) {
        const result = await this.pool.query(
            `select state from hb_active_rooms
             where (host_id = $1 or guest_id = $1)
               and status in ('waiting', 'setup', 'playing')
               and expires_at > now()
             order by updated_at desc limit 1`,
            [userId]
        );
        const state = result.rows[0] && result.rows[0].state;
        return state ? { ...state, statsPromise: null } : null;
    }

    async listWaitingRooms() {
        const result = await this.pool.query(
            `select code, state->>'roomTitle' as room_title, state->'host'->>'name' as host_name,
                    extract(epoch from expires_at) * 1000 as expires_at
             from hb_active_rooms
             where status = 'waiting' and visibility = 'public' and expires_at > now()
             order by updated_at desc`
        );
        return result.rows.map(row => ({
            code: row.code,
            roomTitle: row.room_title,
            hostName: row.host_name,
            expiresAt: Number(row.expires_at)
        }));
    }

    async touchPresence(userId, acceptingChallenges) {
        const hasChoice = typeof acceptingChallenges === 'boolean';
        const result = await this.pool.query(
            `insert into hb_player_presence (player_id, last_seen, available_until, updated_at)
             values ($1, now(), case when $2 then now() + interval '1 hour' else null end, now())
             on conflict (player_id) do update set
                last_seen = now(),
                available_until = case
                    when $3 = false then hb_player_presence.available_until
                    when $2 then now() + interval '1 hour'
                    else null
                end,
                updated_at = now()
             returning extract(epoch from available_until) * 1000 as available_until`,
            [userId, acceptingChallenges === true, hasChoice]
        );
        const availableUntil = Number(result.rows[0].available_until) || 0;
        const active = await this.findActiveRoom(userId);
        return { acceptingChallenges: availableUntil > Date.now() && !active, availableUntil };
    }

    async getLobbyState(userId) {
        await this.pool.query(
            `update hb_match_challenges set status = 'expired', updated_at = now()
             where status = 'pending' and expires_at <= now()`
        );
        const [countsResult, availableResult, meResult, challengeResult] = await Promise.all([
            this.pool.query(
                `select
                    (select count(*) from hb_player_presence where last_seen > now() - interval '45 seconds')::int as online,
                    (select count(*) from hb_player_presence p
                     where p.available_until > now() and not exists (
                         select 1 from hb_active_rooms r
                         where (r.host_id = p.player_id or r.guest_id = p.player_id)
                           and r.status in ('waiting', 'setup', 'playing') and r.expires_at > now()
                     ))::int as available,
                    (select count(distinct player_id)::int from (
                         select host_id as player_id from hb_active_rooms where status in ('setup', 'playing') and expires_at > now()
                         union all
                         select guest_id as player_id from hb_active_rooms where guest_id is not null and status in ('setup', 'playing') and expires_at > now()
                    ) active_players)::int as playing`
            ),
            this.pool.query(
                `select p.id, p.nickname, coalesce(s.wins, 0) as wins, coalesce(s.losses, 0) as losses,
                        season.id as season_id, season.name as season_name,
                        presence.last_seen > now() - interval '45 seconds' as online,
                        extract(epoch from presence.available_until) * 1000 as available_until
                 from hb_player_presence presence
                 join hb_players p on p.id = presence.player_id and p.deleted_at is null
                 join hb_seasons season on season.is_active = true
                 left join hb_player_season_stats s on s.player_id = p.id and s.season_id = season.id
                 where presence.available_until > now() and p.id <> $1
                   and not exists (
                       select 1 from hb_active_rooms r
                       where (r.host_id = p.id or r.guest_id = p.id)
                         and r.status in ('waiting', 'setup', 'playing') and r.expires_at > now()
                   )
                 order by online desc, p.nickname asc`,
                [userId]
            ),
            this.pool.query(
                `select extract(epoch from available_until) * 1000 as available_until
                 from hb_player_presence where player_id = $1`,
                [userId]
            ),
            this.pool.query(
                `select c.*,
                        cp.nickname as challenger_name, coalesce(cs.wins, 0) as challenger_wins, coalesce(cs.losses, 0) as challenger_losses,
                        tp.nickname as target_name, coalesce(ts.wins, 0) as target_wins, coalesce(ts.losses, 0) as target_losses,
                        season.id as season_id, season.name as season_name,
                        extract(epoch from c.expires_at) * 1000 as expires_at_ms,
                        extract(epoch from c.created_at) * 1000 as created_at_ms
                 from hb_match_challenges c
                 join hb_players cp on cp.id = c.challenger_id
                 join hb_players tp on tp.id = c.target_id
                 join hb_seasons season on season.is_active = true
                 left join hb_player_season_stats cs on cs.player_id = cp.id and cs.season_id = season.id
                 left join hb_player_season_stats ts on ts.player_id = tp.id and ts.season_id = season.id
                 where (c.challenger_id = $1 or c.target_id = $1)
                   and (c.status = 'pending'
                        or (c.status = 'accepted' and c.updated_at > now() - interval '2 minutes')
                        or (c.status in ('declined', 'expired', 'cancelled') and c.updated_at > now() - interval '15 seconds'))
                 order by c.updated_at desc limit 1`,
                [userId]
            )
        ]);

        const availablePlayers = availableResult.rows.map(row => ({
            ...publicPlayer(row),
            online: Boolean(row.online),
            availableUntil: Number(row.available_until)
        }));
        const row = challengeResult.rows[0];
        let challenge = null;
        if (row) {
            challenge = publicChallenge({
                ...row,
                expires_at: row.expires_at_ms,
                created_at: row.created_at_ms,
                challenger: publicPlayer({ id: row.challenger_id, nickname: row.challenger_name, wins: row.challenger_wins, losses: row.challenger_losses, season_id: row.season_id, season_name: row.season_name }),
                target: publicPlayer({ id: row.target_id, nickname: row.target_name, wins: row.target_wins, losses: row.target_losses, season_id: row.season_id, season_name: row.season_name })
            }, userId);
        }
        const availableUntil = Number(meResult.rows[0] && meResult.rows[0].available_until) || 0;
        const active = await this.findActiveRoom(userId);
        return {
            counts: countsResult.rows[0],
            me: { acceptingChallenges: availableUntil > Date.now() && !active, availableUntil },
            availablePlayers,
            challenge
        };
    }

    async createChallenge(challengerId, targetId, expiresAt) {
        if (challengerId === targetId) throw storeError('자기 자신에게는 대전을 신청할 수 없습니다.', 400);
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            await client.query('select pg_advisory_xact_lock(hashtext($1))', [[challengerId, targetId].sort().join(':')]);
            await client.query("update hb_match_challenges set status = 'expired', updated_at = now() where status = 'pending' and expires_at <= now()");
            const target = await client.query(
                `select 1 from hb_player_presence p where p.player_id = $1 and p.available_until > now()
                 and not exists (select 1 from hb_active_rooms r where (r.host_id = $1 or r.guest_id = $1)
                    and r.status in ('waiting', 'setup', 'playing') and r.expires_at > now())`,
                [targetId]
            );
            if (!target.rows[0]) throw storeError('상대방이 현재 대전 신청을 받을 수 없습니다.');
            const conflict = await client.query(
                `select 1 from hb_match_challenges where status = 'pending'
                 and (challenger_id in ($1, $2) or target_id in ($1, $2)) limit 1`,
                [challengerId, targetId]
            );
            if (conflict.rows[0]) throw storeError('이미 처리 중인 대전 신청이 있습니다.');
            const recent = await client.query(
                `select 1 from hb_match_challenges where challenger_id = $1 and target_id = $2
                 and updated_at > now() - interval '10 seconds' limit 1`,
                [challengerId, targetId]
            );
            if (recent.rows[0]) throw storeError('잠시 후 다시 신청해 주세요.', 429);
            const id = require('node:crypto').randomUUID();
            await client.query(
                `insert into hb_match_challenges (id, challenger_id, target_id, expires_at)
                 values ($1, $2, $3, to_timestamp($4 / 1000.0))`,
                [id, challengerId, targetId, expiresAt]
            );
            await client.query('commit');
            return publicChallenge({ id, challengerId, targetId, status: 'pending', expiresAt, createdAt: Date.now() }, challengerId);
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }

    async respondToChallenge(challengeId, targetId, action) {
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            const result = await client.query('select * from hb_match_challenges where id = $1 for update', [challengeId]);
            const challenge = result.rows[0];
            if (!challenge || String(challenge.target_id) !== String(targetId)) throw storeError('대전 신청을 찾을 수 없습니다.', 404);
            if (challenge.status !== 'pending' || new Date(challenge.expires_at).getTime() <= Date.now()) {
                if (challenge.status === 'pending') await client.query("update hb_match_challenges set status = 'expired', updated_at = now() where id = $1", [challengeId]);
                throw storeError('이미 처리되었거나 만료된 대전 신청입니다.');
            }
            const status = action === 'accept' ? 'accepted' : 'declined';
            await client.query('update hb_match_challenges set status = $2, updated_at = now() where id = $1', [challengeId, status]);
            await client.query('commit');
            return publicChallenge({ ...challenge, status, expires_at: new Date(challenge.expires_at).getTime(), created_at: new Date(challenge.created_at).getTime() }, targetId);
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }

    async setChallengeRoom(challengeId, roomCode) {
        await this.pool.query(
            `update hb_match_challenges set room_code = $2, status = 'accepted', updated_at = now() where id = $1`,
            [challengeId, String(roomCode)]
        );
    }

    async cancelChallenge(challengeId) {
        await this.pool.query(
            `update hb_match_challenges set status = 'cancelled', updated_at = now()
             where id = $1 and status <> 'declined'`,
            [challengeId]
        );
    }

    async startSeason(name) {
        const client = await this.pool.connect();
        try {
            await client.query('begin');
            await client.query('select pg_advisory_xact_lock(482916)');
            await client.query("update hb_seasons set is_active = false, ends_at = now() where is_active = true");
            const result = await client.query(
                'insert into hb_seasons (name, is_active) values ($1, true) returning id, name',
                [String(name || '').trim().slice(0, 40) || `새 시즌 ${new Date().toISOString().slice(0, 10)}`]
            );
            await client.query('commit');
            return { id: Number(result.rows[0].id), name: result.rows[0].name };
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
    }
}

function createDataStore(options = {}) {
    const databaseUrl = options.databaseUrl !== undefined ? options.databaseUrl : process.env.DATABASE_URL;
    const useMemory = options.useMemory !== undefined
        ? options.useMemory
        : process.env.NODE_ENV === 'test' || process.env.ALLOW_EPHEMERAL_STORAGE === 'true';
    if (databaseUrl) return new PostgresStore(databaseUrl);
    if (useMemory) return new MemoryStore();
    throw new Error('DATABASE_URL이 설정되지 않았습니다. v6 서버에는 영구 PostgreSQL 데이터베이스가 필요합니다.');
}

module.exports = {
    MemoryStore,
    PostgresStore,
    createPostgresPoolOptions,
    createDataStore,
    publicPlayer,
    safePlayerName,
    publicChallenge
};
