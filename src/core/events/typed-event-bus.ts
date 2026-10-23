/**
 * @module core/events/typed-event-bus
 *
 * A strongly typed in-process event bus (a thin wrapper over Node's EventEmitter).
 * The event map is supplied by the application (see `src/events.ts`), so this module
 * has no knowledge of WhatsApp or MCP and can be reused by other servers.
 */
import { EventEmitter } from 'node:events';

/**
 * Event bus whose `emit`/`on` are type-checked against `Events`
 * (`{ 'event.name': [arg1, arg2] }`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- matches Node's EventEmitter event-map constraint
export class TypedEventBus<Events extends Record<keyof Events, any[]>> extends EventEmitter<Events> {
    constructor() {
        super();
        // Every open MCP session / SSE stream subscribes; the default limit of 10 is too low.
        this.setMaxListeners(1000);
    }
}
