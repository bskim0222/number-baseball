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
        rating: Math.max(100, Number(record.rating) || 1000),
        seasonId: Number(record.season_id || record.seasonId || 1),
        seasonName: record.season_name || record.seasonName || '시즌 1'
    };
}

function calculateRatingChange(winnerRating, loserRating) {
    const winnerExpected = 1 / (1 + Math.pow(10, (loserRating - winnerRating) / 400));
    return Math.max(8, Math.round(32 * (1 - winnerExpected)));
}

class MemoryStore {
    constructor() {
        this.players = new Map();
        this.stats = new Map();
        this.matches = new Set();
        this.resets = [];
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
        if (!this.stats.has(id)) this.stats.set(id, { wins: 0, losses: 0, rating: 1000 });
        return this.getPlayer(id);
    }

    async getPlayer(id) {
        const player = this.players.get(id);
        if (!player || player.deleted) return null;
        const stats = this.stats.get(id) || { wins: 0, losses: 0, rating: 1000 };
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
        return list.sort((a, b) => b.rating - a.rating || b.wins - a.wins || a.losses - b.losses || a.name.localeCompare(b.name, 'ko'));
    }

    async recordMatch(match) {
        if (this.matches.has(match.matchId)) {
            return { duplicate: true, winner: await this.getPlayer(match.winnerId), loser: await this.getPlayer(match.loserId), ratingChange: 0 };
        }
        this.matches.add(match.matchId);
        await this.ensurePlayer(match.winnerId, match.winnerName);
        await this.ensurePlayer(match.loserId, match.loserName);
        const winnerStats = this.stats.get(match.winnerId);
        const loserStats = this.stats.get(match.loserId);
        const ratingChange = calculateRatingChange(winnerStats.rating, loserStats.rating);
        winnerStats.wins += 1;
        winnerStats.rating += ratingChange;
        loserStats.losses += 1;
        loserStats.rating = Math.max(100, loserStats.rating - ratingChange);
        return {
            duplicate: false,
            winner: await this.getPlayer(match.winnerId),
            loser: await this.getPlayer(match.loserId),
            ratingChange
        };
    }

    async resetPlayer(id) {
        const previous = this.stats.get(id) || { wins: 0, losses: 0, rating: 1000 };
        this.resets.push({ id, ...previous, seasonId: this.season.id, createdAt: Date.now() });
        this.stats.set(id, { wins: 0, losses: 0, rating: 1000 });
        return this.getPlayer(id);
    }

    async deletePlayer(id) {
        const player = this.players.get(id);
        if (player) {
            player.name = '탈퇴한 사용자';
            player.deleted = true;
        }
        this.stats.delete(id);
    }

    async startSeason(name) {
        this.season = { id: this.season.id + 1, name: safePlayerName(name || `시즌 ${this.season.id + 1}`) };
        this.stats = new Map();
        return this.season;
    }
}

class PostgresStore {
    constructor(databaseUrl) {
        const { Pool } = require('pg');
        this.pool = new Pool({
            connectionString: databaseUrl,
            max: 5,
            ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false }
        });
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
            `select p.id, p.nickname, s.wins, s.losses, s.rating,
                    season.id as season_id, season.name as season_name
             from hb_players p
             join hb_seasons season on season.is_active = true
             left join hb_player_season_stats s on s.player_id = p.id and s.season_id = season.id
             where p.id = $1 and p.deleted_at is null`,
            [id]
        );
        return result.rows[0] ? publicPlayer({ ...result.rows[0], wins: result.rows[0].wins || 0, losses: result.rows[0].losses || 0, rating: result.rows[0].rating || 1000 }) : null;
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
            `select p.id, p.nickname, s.wins, s.losses, s.rating,
                    season.id as season_id, season.name as season_name
             from hb_players p
             join hb_seasons season on season.is_active = true
             join hb_player_season_stats s on s.player_id = p.id and s.season_id = season.id
             where p.deleted_at is null
             order by s.rating desc, s.wins desc, s.losses asc, p.nickname asc`
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
                return { duplicate: true, winner: await this.getPlayer(match.winnerId), loser: await this.getPlayer(match.loserId), ratingChange: 0 };
            }

            const ids = [match.winnerId, match.loserId].sort();
            const locked = await client.query(
                `select player_id, wins, losses, rating from hb_player_season_stats
                 where season_id = $1 and player_id = any($2::uuid[])
                 order by player_id for update`,
                [season.id, ids]
            );
            const byId = Object.fromEntries(locked.rows.map(row => [row.player_id, row]));
            const winner = byId[match.winnerId];
            const loser = byId[match.loserId];
            const ratingChange = calculateRatingChange(Number(winner.rating), Number(loser.rating));

            await client.query(
                `update hb_player_season_stats
                 set wins = wins + 1, rating = rating + $3, updated_at = now()
                 where player_id = $1 and season_id = $2`,
                [match.winnerId, season.id, ratingChange]
            );
            await client.query(
                `update hb_player_season_stats
                 set losses = losses + 1, rating = greatest(100, rating - $3), updated_at = now()
                 where player_id = $1 and season_id = $2`,
                [match.loserId, season.id, ratingChange]
            );
            await client.query('update hb_matches set rating_change = $2 where match_id = $1', [match.matchId, ratingChange]);
            await client.query('commit');
            return {
                duplicate: false,
                winner: await this.getPlayer(match.winnerId),
                loser: await this.getPlayer(match.loserId),
                ratingChange
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
            await client.query(
                `update hb_players set nickname = '탈퇴한 사용자', deleted_at = now(), updated_at = now()
                 where id = $1`,
                [id]
            );
            await client.query('delete from hb_player_season_stats where player_id = $1', [id]);
            await client.query('commit');
        } catch (error) {
            await client.query('rollback');
            throw error;
        } finally {
            client.release();
        }
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
    calculateRatingChange,
    createDataStore,
    publicPlayer,
    safePlayerName
};
