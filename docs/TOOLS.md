# Tool reference

All ids are UUIDs created by this server. Phone numbers and WhatsApp IDs never appear in results. Tools are grouped into **toolsets**, which you can enable with `TOOLSETS=...`.

| Toolset     | Tools                                              |
| ----------- | -------------------------------------------------- |
| `status`    | `whatsapp_status`                                  |
| `chats`     | `list_chats`, `search_contacts`                    |
| `messages`  | `get_messages`, `get_new_messages`, `mark_as_read` |
| `sending`   | `send_message`, `reply_to_message`                 |
| `media`     | `get_media`, `send_media`                          |
| `reactions` | `react_to_message`                                 |

**Chat arguments:**

- read tools take a chat **UUID** or an **exact name**;
- send tools also accept a **phone number with country code** (write-only);
- raw WhatsApp IDs are always rejected.

**Errors** come back as tool errors with a readable message. Examples: `No contact or chat matches "Zed"`, `Sending too fast; wait 2s`, or the login hint when WhatsApp isn't connected.

---

## whatsapp_status

No arguments.

```json
{
    "connected": true,
    "state": "open",
    "me": { "name": "Me", "id": "8d41b6e2-…" },
    "stored": { "chats": 323, "contacts": 929, "messages": 1898 },
    "latestCursor": 2410,
    "newChatsStartedToday": 0
}
```

`me.id` is your own "Message yourself" chat, which is useful for safe testing.

## list_chats

`limit` (1–100, default 20) · `query` (name filter) · `unread_only`

```json
[
    {
        "id": "0b7f3c2e-…",
        "name": "Alice",
        "isGroup": false,
        "unread": 2,
        "lastMessageAt": "2026-10-23T08:22:47.000Z",
        "lastMessage": "see you at 5"
    }
]
```

## search_contacts

`query` (part of a name; numbers are rejected) · `limit` (default 10)

```json
[{ "id": "0b7f3c2e-…", "name": "Alice", "isGroup": false }]
```

## get_messages

`chat` · `limit` (default 20) · `before_ts` (page back: pass the oldest returned `ts`)

```json
{
    "chat": { "id": "0b7f3c2e-…", "name": "Alice" },
    "messages": [
        {
            "id": "6e3d9a47-…",
            "ts": 1792743767,
            "time": "…",
            "from": "Alice",
            "fromId": "0b7f3c2e-…",
            "fromMe": false,
            "type": "text",
            "text": "are you coming?",
            "replyTo": "…",
            "reactions": [{ "emoji": "👍", "from": "me" }]
        },
        {
            "id": "…",
            "from": "me",
            "fromMe": true,
            "type": "image",
            "text": "[image] look",
            "media": { "kind": "image", "mimeType": "image/jpeg", "fileName": null, "size": 48211, "seconds": null, "caption": "look" }
        }
    ]
}
```

## get_new_messages

`cursor` (from the previous call) · `wait_seconds` (0–50; long-poll) · `limit` (default 50)

- **Without `cursor`:** returns the current unread messages.
- **With `cursor`:** returns messages that arrived after it.

Each message includes its `chat`. **Always keep `next_cursor` for the next call.**

```json
{ "messages": [{ "id": "…", "chat": { "id": "…", "name": "Alice" }, "from": "Alice", "text": "ping", … }], "next_cursor": 2411 }
```

Notes you type into your own chat count as incoming, so you can use that chat to give the agent instructions.

## mark_as_read

`chat` → `{ "chat": { "id", "name" }, "marked": 2 }` (sends blue ticks)

## send_message

`to` (UUID / exact name / `+<country><number>`) · `text` · `reply_to` (message id in the same chat, which quotes it)

```json
{ "sent": true, "messageId": "…", "chat": { "id": "…", "name": "Unknown contact" }, "newChat": true, "time": "…" }
```

- **Typing indicator:** "typing…" shows first, for a time proportional to the length of the text.
- **Rate limits:** `SEND_MIN_INTERVAL_MS` and `SEND_MAX_PER_HOUR`.
- **New chats:** a first message to someone new is marked `newChat: true` and counts toward `NEW_CHAT_MAX_PER_DAY`, as well as WhatsApp's own new-contact quota.
- **Unknown numbers:** if the number has no WhatsApp account, the tool returns `This phone number is not on WhatsApp.`

## reply_to_message

`message_id` · `text` → same result as `send_message`, with `replyTo`. Sends a quoted reply in the chat the original message came from.

## get_media

`message_id` (a message with a `media` field). The result has two parts:

1. A JSON summary: `{ messageId, media }`.
2. The file:
    - **image or sticker** → image content (multimodal agents can see it);
    - **voice note or audio** → audio content;
    - **anything else** → an embedded resource `whatsapp://media/<id>` with the file's bytes.

Downloads are cached encrypted. Files larger than `MEDIA_MAX_BYTES` are refused.

## send_media

`to` · exactly one of `data_base64` / `file_path` (inside `MEDIA_SEND_DIR`) · `mime_type` (guessed from `file_name` if omitted) · `file_name` · `caption` · `voice_note` · `reply_to`

How the file is shown in WhatsApp:

- **JPEG, PNG, WebP** → photo
- **MP4, 3GP** → video
- **`audio/*`** → audio, or a voice note with `voice_note: true` (send OGG/Opus)
- **anything else** → document

Result: the `send_message` result plus `media: { kind, mimeType, size, fileName }`.

## react_to_message

`message_id` · `emoji`: exactly one emoji (skin tones, flags and combined emoji like 👨‍👩‍👧 count as one), or `""` to remove your reaction.

```json
{ "messageId": "…", "chat": { "id": "…", "name": "Alice" }, "reacted": "❤️" }
```

---

## Resource and prompt

- **Resource `whatsapp://inbox`:** returns `{ latestCursor, unreadChats: [{ id, name, unread }] }`. Subscribe to it to get `notifications/resources/updated` for every new message.
- **Notifications:** a `notifications/message` with logger `whatsapp.inbox` and `event`:
    - `message.received`: `messageId`, `chatId`, `chatName`, `senderName`, `preview`, `cursor`, …
    - `reaction.received`: `messageId`, `reactorName`, `emoji`, `removed`.
- **Prompt `handle_new_messages`:** guides an agent through fetching new messages, reading context, replying and marking them read.
