# Receiving messages

There are three ways to learn about new messages. Use whichever fits; they all work at the same time.

| Mechanism               | Best for                        | How                                                                    |
| ----------------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `get_new_messages` tool | any MCP client                  | Cursor-based polling, with optional long-polling (`wait_seconds` ≤ 50) |
| MCP notifications       | agents that keep a session open | Pushed over the session's SSE stream                                   |
| Webhook                 | your own services               | Signed HTTP POST, retried until delivered                              |

**What counts as incoming:**

- messages from other people;
- notes you type into your **own** "Message yourself" chat on your phone, so that chat works as a command channel to the agent.

Messages the server sent itself never count, so an agent can't loop on its own replies. History synced at login doesn't trigger anything.

## 1. `get_new_messages` (cursor)

```
first call:   get_new_messages()                        → current unread + next_cursor
then:         get_new_messages(cursor, wait_seconds=50) → returns as soon as a message arrives (or [] after 50 s)
always:       keep the returned next_cursor
```

The cursor is global and increases with every stored message. Keeping it between calls means nothing is missed or repeated, even across reconnects.

## 2. MCP notifications

Every MCP session receives a `notifications/message` with `logger: "whatsapp.inbox"`:

```json
{
    "event": "message.received",
    "messageId": "…",
    "chatId": "…",
    "chatName": "Alice",
    "senderId": "…",
    "senderName": "Alice",
    "isGroup": false,
    "time": "…",
    "cursor": 2411,
    "preview": "are you coming?"
}
```

```json
{
    "event": "reaction.received",
    "messageId": "…",
    "chatId": "…",
    "chatName": "Alice",
    "reactorId": "…",
    "reactorName": "Alice",
    "emoji": "❤️",
    "removed": false,
    "time": "…"
}
```

Sessions subscribed to the `whatsapp://inbox` resource also receive `notifications/resources/updated` for each new message. Whether an agent acts on notifications depends on the client; `get_new_messages` always works.

## 3. Webhook

Set `WEBHOOK_URL` and `WEBHOOK_SECRET` (at least 16 characters) in `.env`.

```
POST <WEBHOOK_URL>
Content-Type: application/json
X-Webhook-Id: <event uuid, the same on every retry>
X-Webhook-Timestamp: <unix seconds>
X-Webhook-Signature: sha256=<hex HMAC-SHA256(WEBHOOK_SECRET, "<timestamp>.<raw body>")>

{"id":"…","type":"message.received","createdAt":"…","data":{"seq":2411,"messageId":"…","chatId":"…","chatName":"Alice",
 "isGroup":false,"senderId":"…","senderName":"Alice","type":"text","text":"are you coming?","ts":1792743767,
 "time":"…","replyToMessageId":null}}
```

`type` is `message.received` or `reaction.received`. The payload contains UUIDs and names, **never phone numbers**. To reply, call MCP tools with `messageId` or `chatId`.

**Delivery:**

- Any 2xx response counts as delivered.
- Otherwise the event is retried with exponential backoff (5 s, 10 s, 20 s, … up to 15 min) until `WEBHOOK_MAX_ATTEMPTS`.
- Events wait in an encrypted outbox, so a server restart loses nothing.

**Verifying the signature (Node.js):**

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(req, rawBody, secret) {
    const ts = req.headers['x-webhook-timestamp'];
    if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject replays older than 5 min
    const expected = `sha256=${createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex')}`;
    const given = String(req.headers['x-webhook-signature'] ?? '');
    return given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
```

Use `X-Webhook-Id` to ignore duplicates: delivery is at-least-once.
