import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

type CookieState = {
    value: string;
    expiresAt?: number;
    path?: string;
    domain?: string;
    secure?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None' | undefined;
};

type ProxyState = {
    port: number;
    cookieJar: Map<string, CookieState>;
};

export class PanelProxy {
    private static proxies: Map<string, ProxyState> = new Map();

    private static debug(message: string, ...details: unknown[]): void {
        console.log(`[VSDactyl Proxy] ${message}`, ...details);
    }

    public static async getProxyUrl(panelUrl: string, serverIdentifier: string): Promise<string> {
        const parsed = new URL(panelUrl);
        const hostKey = parsed.origin;
        
        if (!this.proxies.has(hostKey)) {
            this.proxies.set(hostKey, {
                port: await this.startProxy(hostKey),
                cookieJar: new Map<string, CookieState>(),
            });
        }
        
        const port = this.proxies.get(hostKey)!.port;
        return `http://127.0.0.1:${port}/server/${serverIdentifier}`;
    }

    public static async getProxyHostFor(targetUrl: string): Promise<string> {
        const parsed = new URL(targetUrl);
        const hostKey = parsed.origin;

        if (!this.proxies.has(hostKey)) {
            this.proxies.set(hostKey, {
                port: await this.startProxy(hostKey),
                cookieJar: new Map<string, CookieState>(),
            });
        }

        const port = this.proxies.get(hostKey)!.port;
        return `http://127.0.0.1:${port}`;
    }

    private static async startProxy(targetOrigin: string): Promise<number> {
        return new Promise((resolve) => {
            const targetUrl = new URL(targetOrigin);
            this.debug('Starting proxy for origin', targetOrigin);
            
            const server = http.createServer((req, res) => {
                const proxyState = this.proxies.get(targetOrigin);
                if (!proxyState) {
                    this.debug('Missing proxy state for request', req.method, req.url);
                    res.writeHead(500);
                    res.end('Proxy state missing');
                    return;
                }

                this.debug('Incoming request', req.method, req.url, 'host=', targetUrl.host);

                const options = {
                    hostname: targetUrl.hostname,
                    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                    path: req.url ?? '/',
                    method: req.method,
                    headers: {
                        ...req.headers,
                        host: targetUrl.host,
                        'accept-encoding': 'identity',
                    }
                };

                const cookieHeader = this.buildCookieHeader(proxyState.cookieJar);
                if (cookieHeader) {
                    options.headers.cookie = cookieHeader;
                    this.debug('Attached cookies', cookieHeader);
                }

                if (options.headers.referer) {
                    options.headers.referer = this.rewriteProxyOrigin(options.headers.referer as string, targetOrigin);
                    this.debug('Rewrote referer', options.headers.referer);
                }

                if (options.headers.origin) {
                    options.headers.origin = this.rewriteProxyOrigin(options.headers.origin as string, targetOrigin);
                    this.debug('Rewrote origin', options.headers.origin);
                }
                
                const reqOptions = {
                    ...options,
                    rejectUnauthorized: false
                };

                const proxyReq = (targetUrl.protocol === 'https:' ? https : http).request(reqOptions, (proxyRes) => {
                    const handleResponse = async () => {
                        const headers = { ...proxyRes.headers };

                        this.debug('Received response', proxyRes.statusCode, req.url);

                        delete headers['x-frame-options'];
                        delete headers['content-security-policy'];
                        delete headers['content-security-policy-report-only'];
                        delete headers['content-encoding'];
                        if (proxyRes.headers['content-security-policy'] || proxyRes.headers['x-frame-options']) {
                            this.debug('Stripped blocking headers', {
                                xFrameOptions: proxyRes.headers['x-frame-options'],
                                contentSecurityPolicy: proxyRes.headers['content-security-policy'],
                                contentSecurityPolicyReportOnly: proxyRes.headers['content-security-policy-report-only'],
                            });
                        }

                        const locationHeader = headers.location;
                        const locationValue = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;
                        if (locationValue) {
                            this.debug('Original redirect location', locationValue);
                            let rewrittenLocation = this.rewriteLocationHeader(
                                locationValue,
                                targetOrigin,
                                (server.address() as import('net').AddressInfo).port
                            );
                            if (!rewrittenLocation.startsWith('http://127.0.0.1:')) {
                                const proxied = await this.rewriteRedirectToProxy(rewrittenLocation, targetOrigin);
                                if (proxied) {
                                    rewrittenLocation = proxied;
                                }
                            }
                            headers.location = rewrittenLocation;
                            this.debug('Rewritten redirect location', headers.location);
                        }

                        this.captureCookies(proxyState.cookieJar, headers['set-cookie']);
                        delete headers['set-cookie'];

                        this.debug('Response headers sent to browser', {
                            statusCode: proxyRes.statusCode,
                            location: headers.location,
                            setCookieCount: Array.isArray(proxyRes.headers['set-cookie']) ? proxyRes.headers['set-cookie']?.length : proxyRes.headers['set-cookie'] ? 1 : 0,
                        });

                        const contentType = Array.isArray(proxyRes.headers['content-type'])
                            ? proxyRes.headers['content-type'][0]
                            : proxyRes.headers['content-type'] ?? '';
                        const isHtml = typeof contentType === 'string' && contentType.includes('text/html');

                        if (!isHtml) {
                            res.writeHead(proxyRes.statusCode || 200, headers);
                            proxyRes.pipe(res);
                            return;
                        }

                        const chunks: Buffer[] = [];
                        proxyRes.on('data', (chunk) => {
                            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        });
                        proxyRes.on('end', async () => {
                            const originalBody = Buffer.concat(chunks).toString('utf8');
                            const strippedBody = this.stripCspMetaTags(originalBody);
                            try {
                                const { rewritten, replacements } = await this.rewriteExternalUrlsInHtml(strippedBody, targetOrigin);
                                if (replacements.length > 0) {
                                    this.debug('Rewrote external URLs in HTML', replacements);
                                }

                                if (rewritten !== originalBody) {
                                    delete headers['content-length'];
                                }

                                res.writeHead(proxyRes.statusCode || 200, headers);
                                res.end(rewritten);
                            } catch (err) {
                                this.debug('Failed to rewrite HTML body', (err as Error).message);
                                res.writeHead(proxyRes.statusCode || 200, headers);
                                res.end(strippedBody);
                            }
                        });
                    };

                    void handleResponse();
                });

                proxyReq.on('error', (e) => {
                    this.debug('Proxy request error', req.method, req.url, e.message);
                    res.writeHead(502);
                    res.end('Bad Gateway: ' + e.message);
                });

                req.pipe(proxyReq);
            });

            server.listen(0, '127.0.0.1', () => {
                resolve((server.address() as import('net').AddressInfo).port);
            });
        });
    }

    private static buildCookieHeader(cookieJar: Map<string, CookieState>): string {
        const now = Date.now();
        return Array.from(cookieJar.entries())
            .filter(([, cookie]) => !cookie.expiresAt || cookie.expiresAt > now)
            .map(([, cookie]) => cookie.value)
            .join('; ');
    }

    private static captureCookies(cookieJar: Map<string, CookieState>, setCookieHeader: string[] | string | undefined): void {
        if (!setCookieHeader) {
            return;
        }
        const cookieValues = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        for (const rawCookie of cookieValues) {
            const cookieParts = rawCookie.split(';').map((part) => part.trim());
            const [nameValue, ...attributes] = cookieParts;
            const equalsIndex = nameValue.indexOf('=');

            if (equalsIndex <= 0) {
                continue;
            }

            const name = nameValue.slice(0, equalsIndex).trim();
            const value = nameValue.slice(equalsIndex + 1).trim();
            let expiresAt: number | undefined;
            let shouldDelete = false;
            let path: string | undefined;
            let domain: string | undefined;
            let secure = false;
            let sameSite: CookieState['sameSite'] = undefined;

            for (const attribute of attributes) {
                const [attributeName, ...attributeValueParts] = attribute.split('=');
                const normalizedName = attributeName.trim().toLowerCase();
                const attributeValue = attributeValueParts.join('=').trim();

                if (normalizedName === 'max-age') {
                    const maxAge = Number.parseInt(attributeValue, 10);
                    if (!Number.isNaN(maxAge)) {
                        if (maxAge <= 0) {
                            shouldDelete = true;
                        } else {
                            expiresAt = Date.now() + maxAge * 1000;
                        }
                    }
                }

                if (normalizedName === 'expires') {
                    const expiry = new Date(attributeValue);
                    if (!Number.isNaN(expiry.getTime())) {
                        expiresAt = expiry.getTime();
                        if (expiresAt <= Date.now()) {
                            shouldDelete = true;
                        }
                    }
                }

                if (normalizedName === 'path') {
                    path = attributeValue || '/';
                }

                if (normalizedName === 'domain') {
                    domain = attributeValue || undefined;
                }

                if (normalizedName === 'secure') {
                    secure = true;
                }

                if (normalizedName === 'samesite') {
                    const v = attributeValue.charAt(0).toUpperCase() + attributeValue.slice(1).toLowerCase();
                    if (v === 'Lax' || v === 'Strict' || v === 'None') {
                        sameSite = v as CookieState['sameSite'];
                    }
                }
            }

            if (shouldDelete) {
                this.debug('Deleting expired cookie', name);
                cookieJar.delete(name);
                continue;
            }

            this.debug('Captured cookie', { name, expiresAt, path, domain, secure, sameSite });
            cookieJar.set(name, { value: `${name}=${value}`, expiresAt, path, domain, secure, sameSite });
        }
    }

    private static rewriteProxyOrigin(value: string, targetOrigin: string): string {
        return value.replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/g, targetOrigin);
    }

    private static rewriteLocationHeader(locationHeader: string | string[], targetOrigin: string, port: number): string {
        const location = Array.isArray(locationHeader) ? locationHeader[0] : locationHeader;

        try {
            const absoluteLocation = new URL(location, targetOrigin);
            if (absoluteLocation.origin === targetOrigin) {
                return `http://127.0.0.1:${port}${absoluteLocation.pathname}${absoluteLocation.search}${absoluteLocation.hash}`;
            }
        } catch {
            // Keep the original Location header if it cannot be parsed.
        }

        // If parsing failed or the location points to a different origin, attempt a safe replacement
        try {
            return location.replace(targetOrigin, `http://127.0.0.1:${port}`);
        } catch {
            return location;
        }
    }

    private static async rewriteRedirectToProxy(location: string, targetOrigin: string): Promise<string | null> {
        try {
            const absoluteLocation = new URL(location, targetOrigin);
            if (absoluteLocation.protocol !== 'http:' && absoluteLocation.protocol !== 'https:') {
                return null;
            }

            const proxyHost = await this.getProxyHostFor(absoluteLocation.href);
            this.debug('External redirect proxy allocated', {
                targetOrigin,
                redirectedOrigin: absoluteLocation.origin,
                proxyHost,
            });
            return `${proxyHost}${absoluteLocation.pathname}${absoluteLocation.search}${absoluteLocation.hash}`;
        } catch (e) {
            this.debug('Failed to rewrite external redirect to proxy', location, (e as Error).message);
            return null;
        }
    }

    private static stripCspMetaTags(html: string): string {
        return html
            .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '')
            .replace(/<meta[^>]+http-equiv=["']Content-Security-Policy-Report-Only["'][^>]*>/gi, '');
    }

    private static async rewriteExternalUrlsInHtml(
        html: string,
        targetOrigin: string
    ): Promise<{ rewritten: string; replacements: Array<{ from: string; to: string }> }> {
        const toAbsoluteHttpUrl = (rawUrl: string): string | null => {
            const value = rawUrl.trim();
            if (!value) {
                return null;
            }

            if (value.startsWith('//')) {
                const targetProtocol = new URL(targetOrigin).protocol || 'https:';
                return `${targetProtocol}${value}`;
            }

            if (/^https?:\/\//i.test(value)) {
                return value;
            }

            return null;
        };

        const urlRegex = /https?:\/\/[^\s"'<>]+/g;
        const matches = html.match(urlRegex) ?? [];
        const originMap = new Map<string, string>();

        for (const match of matches) {
            try {
                const url = new URL(match);
                if (url.origin === targetOrigin || url.origin.startsWith('http://127.0.0.1:') || url.origin.startsWith('https://127.0.0.1:')) {
                    continue;
                }
                if (!originMap.has(url.origin)) {
                    const proxyHost = await this.getProxyHostFor(url.href);
                    originMap.set(url.origin, proxyHost);
                }
            } catch {
                // ignore parsing issues
            }
        }

        const replacements: Array<{ from: string; to: string }> = [];
        let rewritten = html.replace(urlRegex, (raw) => {
            try {
                const url = new URL(raw);
                const proxyHost = originMap.get(url.origin);
                if (!proxyHost) {
                    return raw;
                }
                const proxied = `${proxyHost}${url.pathname}${url.search}${url.hash}`;
                if (proxied !== raw) {
                    replacements.push({ from: raw, to: proxied });
                }
                return proxied;
            } catch {
                return raw;
            }
        });

        // Explicitly rewrite anchor href values to keep navigation inside our local proxy.
        // This covers protocol-relative links and edge cases where generic URL replacement misses.
        try {
            const anchorHrefRegex = /(<a\b[^>]*\bhref\s*=\s*)(["'])([^"']+)\2/gi;
            rewritten = rewritten.replace(anchorHrefRegex, (full, prefix, quote, hrefValue) => {
                try {
                    const absoluteRaw = toAbsoluteHttpUrl(hrefValue);
                    if (!absoluteRaw) {
                        return full;
                    }

                    const absolute = new URL(absoluteRaw, targetOrigin);
                    const proxyHost = originMap.get(absolute.origin);
                    if (!proxyHost) {
                        return full;
                    }

                    const proxied = `${proxyHost}${absolute.pathname}${absolute.search}${absolute.hash}`;
                    replacements.push({ from: hrefValue, to: proxied });
                    return `${prefix}${quote}${proxied}${quote}`;
                } catch {
                    return full;
                }
            });
        } catch {
            // ignore
        }

        // Rewrite meta-refresh redirects: <meta http-equiv="refresh" content="0;url=https://...">
        try {
            const metaRefreshRegex = /<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?[^"'>]*url=([^"'>\s]+)["']?[^>]*>/gi;
            rewritten = rewritten.replace(metaRefreshRegex, (match, urlPart) => {
                try {
                    const absolute = new URL(urlPart, targetOrigin);
                    const proxyHost = originMap.get(absolute.origin);
                    if (!proxyHost) return match;
                    const proxied = `${proxyHost}${absolute.pathname}${absolute.search}${absolute.hash}`;
                    replacements.push({ from: urlPart, to: proxied });
                    return match.replace(urlPart, proxied);
                } catch {
                    return match;
                }
            });
        } catch {
            // ignore
        }

        // Rewrite common JS location assignments and replaces
        try {
            const jsLocationRegex = /(window\.(?:top\.)?location(?:\.href|\.pathname)?\s*=\s*|location\.href\s*=\s*|location\.replace\()(["'])(https?:\/\/[^"'\)\s]+)\2/gi;
            rewritten = rewritten.replace(jsLocationRegex, (full, prefix, quote, urlPart) => {
                try {
                    const absolute = new URL(urlPart, targetOrigin);
                    const proxyHost = originMap.get(absolute.origin);
                    if (!proxyHost) return full;
                    const proxied = `${proxyHost}${absolute.pathname}${absolute.search}${absolute.hash}`;
                    replacements.push({ from: urlPart, to: proxied });
                    return `${prefix}${quote}${proxied}${quote}`;
                } catch {
                    return full;
                }
            });
        } catch {
            // ignore
        }

        // Plain assignment: location = 'https://...'
        try {
            const plainAssignRegex = /(window\.)?location\s*=\s*(["'])(https?:\/\/[^"']+)\2/gi;
            rewritten = rewritten.replace(plainAssignRegex, (full, winPrefix, quote, urlPart) => {
                try {
                    const absolute = new URL(urlPart, targetOrigin);
                    const proxyHost = originMap.get(absolute.origin);
                    if (!proxyHost) return full;
                    const proxied = `${proxyHost}${absolute.pathname}${absolute.search}${absolute.hash}`;
                    replacements.push({ from: urlPart, to: proxied });
                    const prefix = winPrefix ? winPrefix + 'location = ' : 'location = ';
                    return `${prefix}${quote}${proxied}${quote}`;
                } catch {
                    return full;
                }
            });
        } catch {
            // ignore
        }

        // window.open(url, target) — rewrite when url is absolute
        try {
            const windowOpenRegex = /window\.open\(\s*(["'])(https?:\/\/[^"']+)\1(\s*,\s*(["'][^"']*["']))?/gi;
            rewritten = rewritten.replace(windowOpenRegex, (full, quote, urlPart, rest) => {
                try {
                    const absolute = new URL(urlPart, targetOrigin);
                    const proxyHost = originMap.get(absolute.origin);
                    if (!proxyHost) return full;
                    const proxied = `${proxyHost}${absolute.pathname}${absolute.search}${absolute.hash}`;
                    replacements.push({ from: urlPart, to: proxied });
                    return `window.open(${quote}${proxied}${quote}${rest || ''}`;
                } catch {
                    return full;
                }
            });
        } catch {
            // ignore
        }

        // document.location.assign / window.location.assign
        try {
            const docAssignRegex = /(document\.location\.assign\(|window\.location\.assign\()(["'])(https?:\/\/[^"'\)\s]+)\2/gi;
            rewritten = rewritten.replace(docAssignRegex, (full, prefix, quote, urlPart) => {
                try {
                    const absolute = new URL(urlPart, targetOrigin);
                    const proxyHost = originMap.get(absolute.origin);
                    if (!proxyHost) return full;
                    const proxied = `${proxyHost}${absolute.pathname}${absolute.search}${absolute.hash}`;
                    replacements.push({ from: urlPart, to: proxied });
                    return `${prefix}${quote}${proxied}${quote}`;
                } catch {
                    return full;
                }
            });
        } catch {
            // ignore
        }

        return { rewritten, replacements };
    }
}
