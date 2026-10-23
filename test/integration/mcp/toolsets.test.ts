import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConfigError } from '../../../src/core/errors.js';
import { resolveToolsets, TOOLSETS } from '../../../src/mcp/toolsets/index.js';
import { createHarness } from './harness.js';

const ALL_TOOLS = [
    'get_media',
    'get_messages',
    'get_new_messages',
    'list_chats',
    'mark_as_read',
    'react_to_message',
    'reply_to_message',
    'search_contacts',
    'send_media',
    'send_message',
    'whatsapp_status',
];

describe('MCP server surface', () => {
    it('exposes all tools, the prompt and the inbox resource by default', async () => {
        const h = await createHarness();
        assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name).sort(), ALL_TOOLS);
        assert.deepEqual(
            (await h.client.listPrompts()).prompts.map((p) => p.name),
            ['handle_new_messages'],
        );
        assert.deepEqual(
            (await h.client.listResources()).resources.map((r) => r.uri),
            ['whatsapp://inbox'],
        );
    });

    it('TOOLSETS limits which tools are exposed', async () => {
        const h = await createHarness({ toolsets: ['chats', 'messages'] });
        assert.deepEqual((await h.client.listTools()).tools.map((t) => t.name).sort(), [
            'get_messages',
            'get_new_messages',
            'list_chats',
            'mark_as_read',
            'search_contacts',
        ]);
    });

    it('rejects unknown toolset names and lists the valid ones', () => {
        assert.throws(
            () => resolveToolsets(['chats', 'nope']),
            (err: Error) => err instanceof ConfigError && /nope/.test(err.message),
        );
        assert.equal(resolveToolsets(['all']).length, TOOLSETS.length);
        assert.equal(resolveToolsets([]).length, TOOLSETS.length);
    });

    it('every toolset has a unique name and a description', () => {
        const names = TOOLSETS.map((t) => t.name);
        assert.equal(new Set(names).size, names.length);
        for (const t of TOOLSETS) assert.ok(t.description.length > 10, t.name);
    });
});
