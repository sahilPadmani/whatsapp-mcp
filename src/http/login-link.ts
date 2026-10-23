/**
 * @module http/login-link
 *
 * The one-time login link (`/login/<token>`). See {@link LoginLink}.
 */
import { randomBytes } from 'node:crypto';
import { safeEqual } from './auth.js';

/**
 * One-time login link (`/login/<token>`) that shows the WhatsApp QR. The token
 * is random and unrelated to API_KEY, so the key never appears in a URL. It is
 * issued when WhatsApp needs a QR and revoked as soon as login succeeds.
 */
export class LoginLink {
    private token: string | null = null;

    constructor(
        private readonly publicUrl: string,
        private readonly onIssue: (url: string) => void,
    ) {}

    get active() {
        return this.token !== null;
    }

    issue(): string {
        this.token = randomBytes(24).toString('base64url');
        const url = `${this.publicUrl}/login/${this.token}`;
        this.onIssue(url);
        return url;
    }

    isValid(token: string): boolean {
        return this.token !== null && safeEqual(token, this.token);
    }

    revoke() {
        this.token = null;
    }
}
