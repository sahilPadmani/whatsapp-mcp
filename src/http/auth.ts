/**
 * @module http/auth
 *
 * Bearer-token authentication for `/mcp` (constant-time comparison, so response timing
 * reveals nothing about the key).
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export const safeEqual = (a: string, b: string) => {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    return ab.length === bb.length && timingSafeEqual(ab, bb);
};

/** MCP endpoint auth: `Authorization: Bearer <API_KEY>`. */
export const bearerAuth = (apiKey: string) => (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token && safeEqual(token, apiKey)) return next();
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: missing or invalid Bearer API key' }, id: null });
};
