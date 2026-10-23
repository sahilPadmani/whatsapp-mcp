import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { ALICE, findIdentifiers, GROUP, PHONES, reactionMessage } from '../../helpers/index.js';
import { createHarness, type Harness } from './harness.js';

describe('toolset: reactions', () => {
    let h: Harness;
    beforeEach(async () => {
        h = await createHarness();
    });

    const findByText = async (chat: string, prefix: string) =>
        (await h.call('get_messages', { chat })).data.messages.find((m: { text: string }) => m.text.startsWith(prefix));

    it('react_to_message sends the emoji for the original message and shows it on the message', async () => {
        const { data } = await h.call('get_messages', { chat: 'Alice' });
        const target = data.messages.at(-1);
        const out = await h.call('react_to_message', { message_id: target.id, emoji: '👍' });
        assert.equal(out.isError, false, out.text);
        assert.equal(out.data.reacted, '👍');
        const sent = h.gw.sent[0].content as { react: { text: string; key: { id: string } } };
        assert.equal(sent.react.text, '👍');
        assert.equal(sent.react.key.id, 'A2');
        assert.equal(h.gw.typing.length, 0, 'no typing indicator for reactions');

        const after = await h.call('get_messages', { chat: 'Alice' });
        assert.deepEqual(after.data.messages.at(-1).reactions, [{ emoji: '👍', from: 'me' }]);

        const removed = await h.call('react_to_message', { message_id: target.id, emoji: '' });
        assert.equal(removed.data.removed, true);
        assert.equal((h.gw.sent[1].content as { react: { text: string } }).react.text, '');
        assert.equal((await h.call('get_messages', { chat: 'Alice' })).data.messages.at(-1).reactions, undefined);
    });

    it('accepts complex single emoji and rejects anything else', async () => {
        const { data } = await h.call('get_messages', { chat: 'Alice' });
        const id = data.messages.at(-1).id;
        for (const ok of ['❤️', '👍🏽', '👨‍👩‍👧', '🇮🇳']) {
            assert.equal((await h.call('react_to_message', { message_id: id, emoji: ok })).isError, false, ok);
        }
        for (const bad of ['ok', '👍👍', 'a👍', '1']) {
            assert.match((await h.call('react_to_message', { message_id: id, emoji: bad })).text, /exactly one emoji/, bad);
        }
        assert.match(
            (await h.call('react_to_message', { message_id: '00000000-0000-4000-8000-000000000000', emoji: '👍' })).text,
            /Unknown message/,
        );
    });

    it('stores incoming reactions, shows who reacted, and announces them', async () => {
        const events: unknown[] = [];
        h.bus.on('reaction.received', (e) => events.push(e));
        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'A1', emoji: '😂' })], true);
        h.ingest.saveMessages([reactionMessage({ chat: GROUP, targetId: 'G1', emoji: '🔥', participant: ALICE })], true);

        const alice = await findByText('Alice', 'hi');
        assert.deepEqual(alice.reactions, [{ emoji: '😂', from: 'Alice', fromId: h.peers.byJid(ALICE)?.uuid }]);
        const team = (await h.call('get_messages', { chat: 'Team' })).data.messages[0];
        assert.equal(team.reactions[0].from, 'Alice');

        assert.equal(events.length, 2);
        assert.deepEqual(findIdentifiers(events, PHONES), []);
        assert.equal((events[0] as { emoji: string }).emoji, '😂');

        // Changing, then removing the reaction
        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'A1', emoji: '❤️' })], true);
        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'A1', emoji: '' })], true);
        assert.equal((await findByText('Alice', 'hi')).reactions, undefined);
        assert.equal((events.at(-1) as { removed: boolean }).removed, true);
    });

    it('ignores reactions to unknown messages, stale reactions, and does not announce own reactions', async () => {
        const events: unknown[] = [];
        h.bus.on('reaction.received', (e) => events.push(e));
        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'NOPE', emoji: '👍' })], true);
        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'A1', emoji: '👍', fromMe: true })], true);
        assert.equal(events.length, 0);

        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'A2', emoji: '🙏', ms: 2_000_000_000_000 })], true);
        h.ingest.saveMessages([reactionMessage({ chat: ALICE, targetId: 'A2', emoji: '😡', ms: 1_000_000_000_000 })], false); // older, from history
        assert.equal((await findByText('Alice', 'you there?')).reactions[0].emoji, '🙏');
    });
});
