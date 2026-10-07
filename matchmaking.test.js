const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryStore } = require('./database');
const { Matchmaking, matchmakingConfig } = require('./matchmaking');
const { createPushService } = require('./push-notifications');

async function fixture(count = 4) {
    const store = new MemoryStore();
    let now = Date.now();
    const matching = new Matchmaking(store, { now: () => now });
    for (let i = 0; i <= count; i++) {
        const id = String(i);
        await store.ensurePlayer(id, `선수${id}`);
        await store.touchPresence(id, true);
        await matching.saveSettings(id, {}, true);
    }
    return { store, matching, advance: ms => { now += ms; } };
}
const makeRoom = async (host, guest) => ({ code: '123456', host, guest, status: 'setup', updatedAt: Date.now(), expiresAt: Date.now() + 120000 });

test('server settings have bounded defaults', () => {
    assert.equal(matchmakingConfig({}).fanout, 3);
    assert.equal(matchmakingConfig({ MATCH_INVITE_FANOUT: '2' }).fanout, 2);
    assert.equal(matchmakingConfig({ MATCH_INVITE_FANOUT: '999' }).fanout, 3);
    assert.equal(matchmakingConfig({ MATCH_INVITE_TTL_SECONDS: 'abc' }).ttlMs, 60000);
});

test('legacy one-hour direct-invite consent is preserved without extending it to random push opt-in', async () => {
    const store = new MemoryStore();
    const matching = new Matchmaking(store);
    await store.ensurePlayer('legacy', '이전버전');
    await store.touchPresence('legacy', true);
    assert.equal((await matching.getSettings('legacy')).inviteNotifications, true);
    await matching.saveSettings('legacy', {}, true);
    assert.equal((await matching.getSettings('legacy')).inviteNotifications, false);
});

test('maximum three recipients, no self invitation; repeated request is idempotent', async () => {
    const { matching } = await fixture();
    const search = await matching.exclusive(() => matching.start('0'));
    assert.equal(Object.keys(search.recipients).length, 3);
    assert.equal(search.recipients['0'], undefined);
    assert.equal((await matching.exclusive(() => matching.start('0'))).id, search.id);
});

test('concurrent accepts produce exactly one room and disclose no room code to other recipients', async () => {
    const { matching, store } = await fixture();
    const search = await matching.exclusive(() => matching.start('0'));
    const ids = Object.keys(search.recipients);
    const results = await Promise.allSettled(ids.map(id => matching.exclusive(() => matching.respond(id, search.id, 'accept', makeRoom))));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(store.activeRooms.size, 1);
    const winner = ids[results.findIndex(result => result.status === 'fulfilled')];
    assert.equal((await matching.current(winner)).roomCode, '123456');
    const loser = ids.find(id => id !== winner);
    assert.equal((await matching.current(loser)).status, 'matched_elsewhere');
    assert.equal((await matching.current(loser)).roomCode, null);
    const retry = await matching.exclusive(() => matching.respond(winner, search.id, 'accept', makeRoom));
    assert.equal(retry.room.code, '123456');
});

test('requester silence invalidates invitations, while heartbeat only refreshes requester', async () => {
    const { matching, advance } = await fixture();
    const search = await matching.start('0');
    const id = Object.keys(search.recipients)[0];
    advance(10000);
    await matching.current(id, true);
    advance(6000);
    assert.equal((await matching.current('0', true)).status, 'cancelled');
    await assert.rejects(() => matching.respond(id, search.id, 'accept', makeRoom), /만료/);
});

test('60 second expiry is not extended by heartbeats', async () => {
    const { matching, advance } = await fixture();
    await matching.start('0');
    for (let i = 0; i < 5; i++) { advance(10000); await matching.current('0', true); }
    advance(10000);
    assert.equal((await matching.current('0', true)).status, 'expired');
});

test('cancel, stranger response and stranger cancellation are checked', async () => {
    const { matching } = await fixture(2);
    const search = await matching.start('0');
    await assert.rejects(() => matching.respond('stranger', search.id, 'accept', makeRoom), /찾을 수/);
    await assert.rejects(() => matching.cancel('1', search.id), /찾을 수/);
    await matching.cancel('0', search.id);
    await assert.rejects(() => matching.respond('1', search.id, 'accept', makeRoom), /만료/);
});

test('disabled recipients, old clients and players in rooms are excluded', async () => {
    const { matching, store } = await fixture(3);
    await matching.saveSettings('1', { acceptChallenges: false });
    matching.settings.delete('2');
    await store.saveRoom(await makeRoom(await store.getPlayer('3'), { id: 'other' }));
    await assert.rejects(() => matching.start('0'), /초대할 수/);
});

test('online players are preferred; offline recipients require opt-in and push token', async () => {
    const { matching, store } = await fixture(2);
    store.presence.get('2').lastSeen -= 60000;
    await matching.saveSettings('2', { inviteNotifications: true });
    await store.savePushToken('2', 'test-token');
    const search = await matching.start('0');
    assert.deepEqual(Object.keys(search.recipients), ['1']);
    await matching.cancel('0', search.id);
    await matching.saveSettings('1', { acceptChallenges: false });
    // Another requester avoids its own short retry throttle.
    await matching.saveSettings('0', { acceptChallenges: false });
    await store.ensurePlayer('other', '다른선수');
    const next = await matching.start('other');
    assert.deepEqual(Object.keys(next.recipients), ['2']);
});

test('recipient cooldown applies across different senders, including declined invitations', async () => {
    const { matching, store } = await fixture(1);
    const search = await matching.start('0');
    await matching.respond('1', search.id, 'decline');
    await store.ensurePlayer('other', '다른선수');
    await matching.saveSettings('0', { acceptChallenges: false });
    await assert.rejects(() => matching.start('other'), /초대할 수/);
});

test('turning off reception closes pending invitations and persists independent notification settings', async () => {
    const { matching } = await fixture(1);
    const search = await matching.start('0');
    await matching.saveSettings('1', { inviteNotifications: true, roomNotifications: false });
    await matching.saveSettings('1', { acceptChallenges: false });
    assert.equal((await matching.current('1')).status, 'declined');
    assert.equal((await matching.getSettings('1')).inviteNotifications, true);
    assert.equal((await matching.getSettings('1')).roomNotifications, false);
    await assert.rejects(() => matching.respond('1', search.id, 'accept', makeRoom), /만료/);
    await assert.rejects(() => matching.saveSettings('1', { supportsRandom: true }), /올바르지/);
    await assert.rejects(() => matching.saveSettings('1', { acceptChallenges: 'true' }), /올바르지/);
});

test('push preferences and expiration suppress delivery; valid invites carry a bounded TTL', async () => {
    const { matching, store } = await fixture(1);
    await store.savePushToken('1', 'test-token');
    const sent = [];
    const push = createPushService({ dataStore: store, getSettings: id => matching.getSettings(id), messaging: {
        async sendEachForMulticast(message) { sent.push(message); return { responses: [{ success: true }], successCount: 1, failureCount: 0 }; }
    } });
    const invite = { challengeId: 'test', challengerName: '선수', expiresAt: Date.now() + 60000, kind: 'random' };
    await push.sendChallengeReceived('1', invite);
    assert.equal(sent.length, 0);
    await matching.saveSettings('1', { inviteNotifications: true, roomNotifications: false });
    await push.sendRoomJoined('1', { guestName: '선수', roomTitle: '방', roomCode: '1234' });
    await push.sendChallengeReceived('1', { ...invite, expiresAt: Date.now() - 1 });
    assert.equal(sent.length, 0);
    await push.sendChallengeReceived('1', invite);
    assert.equal(sent.length, 1);
    assert.ok(sent[0].android.ttl > 0 && sent[0].android.ttl <= 60000);
    assert.equal(sent[0].data.kind, 'random');
});

test('lock is released after failures', async () => {
    const { matching } = await fixture();
    await assert.rejects(() => matching.exclusive(() => { throw new Error('expected'); }), /expected/);
    assert.equal(await matching.exclusive(() => 42), 42);
});

test('practice mode is excluded and moving a requester to background cancels its search', async () => {
    const { matching } = await fixture(2);
    await matching.setActivity('1', 'busy');
    const search = await matching.start('0');
    assert.deepEqual(Object.keys(search.recipients), ['2']);
    await matching.setActivity('0', 'background');
    assert.equal((await matching.current('2')).status, 'cancelled');
});
