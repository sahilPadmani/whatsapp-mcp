/**
 * @module index
 *
 * Process entrypoint (`npm start`): make sure secrets exist, load config, start the app,
 * and shut down cleanly on Ctrl+C / SIGTERM. All wiring lives in `app.ts`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp, DB_FILE } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { ensureSecrets } from './core/crypto/keys.js';

async function main() {
    // First run: generate API_KEY / ENCRYPTION_KEY into .env (refuses a new key if encrypted data exists).
    const dbExists = existsSync(path.resolve(process.env.DATA_DIR ?? './data', DB_FILE));
    const generated = ensureSecrets(path.resolve('.env'), process.env, dbExists);
    if (generated.length) console.warn(`\n  Generated ${generated.join(' and ')} in .env. Back up ENCRYPTION_KEY!\n`);

    const config = loadConfig(process.env);
    const app = createApp({ config });
    const { url } = await app.start();
    console.log(`\n  MCP: ${url}/mcp  (Authorization: Bearer <API_KEY from .env>)\n`);

    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await app.stop();
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
    console.error(err instanceof ConfigError ? `\n${err.message}\n` : err);
    process.exit(1);
});
