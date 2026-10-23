/**
 * @module core/db/database
 *
 * A thin synchronous wrapper over Node's built-in SQLite (`node:sqlite`, no native add-on):
 *  - converts `undefined` → NULL and booleans → 0/1 (node:sqlite rejects both),
 *  - nested transactions via savepoints (`transaction(fn)` can be called inside another),
 *  - WAL journal, foreign keys and `secure_delete` (deleted data is overwritten on disk).
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** node:sqlite rejects undefined and booleans, so map them to NULL and 0/1. */
const toSql = (value: unknown): SQLInputValue =>
    value === undefined ? null : typeof value === 'boolean' ? Number(value) : (value as SQLInputValue);

/** Thin synchronous wrapper over node:sqlite with nested transactions (savepoints). */
export class Database {
    private readonly db: DatabaseSync;
    private depth = 0;

    constructor(file: string) {
        if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
        this.db = new DatabaseSync(file);
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;');
    }

    exec(sql: string) {
        this.db.exec(sql);
    }

    run(sql: string, ...params: unknown[]) {
        return this.db.prepare(sql).run(...params.map(toSql));
    }

    get<T>(sql: string, ...params: unknown[]): T | undefined {
        return this.db.prepare(sql).get(...params.map(toSql)) as T | undefined;
    }

    all<T>(sql: string, ...params: unknown[]): T[] {
        return this.db.prepare(sql).all(...params.map(toSql)) as T[];
    }

    transaction<T>(fn: () => T): T {
        const savepoint = `sp${this.depth}`;
        this.db.exec(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
        this.depth++;
        try {
            const result = fn();
            this.depth--;
            this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
            return result;
        } catch (err) {
            this.depth--;
            this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
            throw err;
        }
    }

    close() {
        this.db.close();
    }
}
