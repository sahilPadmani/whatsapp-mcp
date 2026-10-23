/**
 * @module store/auth-state
 *
 * Persists the WhatsApp login (account credentials + Signal session keys) encrypted in
 * SQLite, so the server stays logged in across restarts until you log out. Anyone with a
 * plaintext copy of this data could take over the account, which is why Baileys' default
 * JSON-files store is not used.
 */
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from 'baileys';
import type { Cipher } from '../core/crypto/cipher.js';
import type { Database } from '../core/db/database.js';

const aad = (key: string) => `auth_kv.value:${key}`;

/**
 * Baileys auth state (account credentials + Signal session keys) stored
 * encrypted in SQLite instead of plaintext JSON files. Modelled on Baileys'
 * useMultiFileAuthState. The session survives restarts until `clear()` (logout).
 */
export class EncryptedAuthStore {
    constructor(
        private readonly db: Database,
        private readonly cipher: Cipher,
    ) {}

    private read<T>(key: string): T | null {
        const row = this.db.get<{ value_enc: string }>('SELECT value_enc FROM auth_kv WHERE key = ?', key);
        return row ? this.cipher.decryptJson<T>(row.value_enc, aad(key), BufferJSON.reviver) : null;
    }

    private write(key: string, value: unknown) {
        this.db.run(
            'INSERT INTO auth_kv (key, value_enc) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value_enc = excluded.value_enc',
            key,
            this.cipher.encryptJson(value, aad(key), BufferJSON.replacer),
        );
    }

    private remove(key: string) {
        this.db.run('DELETE FROM auth_kv WHERE key = ?', key);
    }

    hasSession(): boolean {
        return Boolean(this.db.get("SELECT 1 FROM auth_kv WHERE key = 'creds'"));
    }

    load(): { state: AuthenticationState; saveCreds: () => void } {
        const creds = this.read<AuthenticationCreds>('creds') ?? initAuthCreds();
        return {
            state: {
                creds,
                keys: {
                    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
                        const data: { [id: string]: SignalDataTypeMap[T] } = {};
                        for (const id of ids) {
                            let value = this.read<SignalDataTypeMap[T]>(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value as never) as unknown as SignalDataTypeMap[T];
                            }
                            if (value) data[id] = value;
                        }
                        return data;
                    },
                    set: async (data) => {
                        this.db.transaction(() => {
                            for (const category in data) {
                                const entries = data[category as keyof SignalDataTypeMap] ?? {};
                                for (const id in entries) {
                                    const value = entries[id];
                                    const key = `${category}-${id}`;
                                    if (value) this.write(key, value);
                                    else this.remove(key);
                                }
                            }
                        });
                    },
                },
            },
            saveCreds: () => this.write('creds', creds),
        };
    }

    clear() {
        this.db.exec('DELETE FROM auth_kv;');
    }
}
