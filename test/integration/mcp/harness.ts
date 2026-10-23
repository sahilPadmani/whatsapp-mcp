/**
 * Shared harness for MCP integration tests: a fake WhatsApp gateway, real services and a
 * real MCP client/server pair (in-memory transport), seeded with a few chats.
 */
import { createTestServices, connectClient, callTool, setup } from '../../helpers/env.js';
import { FakeGateway } from '../../helpers/fakes.js';
import { ALICE, BOB, CAROL, GROUP, waMessage } from '../../helpers/fixtures.js';
import type { ServiceDeps } from '../../../src/services/index.js';

export interface HarnessOptions {
    settings?: Partial<ServiceDeps['settings']>;
    toolsets?: string[];
}

export async function createHarness(options: HarnessOptions = {}) {
    const env = setup();
    const gw = new FakeGateway();
    const services = createTestServices(env, gw, options.settings);
    const client = await connectClient(env, services, options.toolsets);

    // Seed data the way WhatsApp would deliver it.
    env.peers.update(ALICE, { name: 'Alice' });
    env.peers.update(BOB, { name: 'Bob Builder' });
    env.peers.update(CAROL, { name: '+91 98111 22233' }); // contact saved under its number
    env.peers.update(GROUP, { name: 'Team' });
    env.ingest.saveMessages(
        [
            waMessage({ chat: ALICE, id: 'A1', text: 'hi, my number is 919876543210', ts: 100 }),
            waMessage({ chat: ALICE, id: 'A2', text: 'you there?', ts: 110 }),
            waMessage({ chat: BOB, id: 'B1', text: 'yo', ts: 120 }),
            waMessage({ chat: CAROL, id: 'C1', text: 'hello', ts: 125 }),
            waMessage({ chat: GROUP, id: 'G1', text: 'meeting at 5', ts: 130, participant: BOB }),
        ],
        true,
    );

    return { ...env, gw, services, client, call: (name: string, args: Record<string, unknown> = {}) => callTool(client, name, args) };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
