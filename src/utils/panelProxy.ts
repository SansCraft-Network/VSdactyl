import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

type CookieState = {
    value: string;
    expiresAt?: number;
};

type ProxyState = {
    port: number;
    cookieJar: Map<string, CookieState>;
};

export class PanelProxy {
    private static proxies: Map<string, ProxyState> = new Map();

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
            
            const server = http.createServer((req, res) => {
                const proxyState = this.proxies.get(targetOrigin);
                if (!proxyState) {
                    res.writeHead(500);
                    res.end('Proxy state missing');
                    return;
                }

                const options = {
                    hostname: targetUrl.hostname,
                    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
                    path: req.url ?? '/',
                    method: req.method,
                    headers: { ...req.headers, host: targetUrl.host }
                };

                const cookieHeader = this.buildCookieHeader(proxyState.cookieJar);
                if (cookieHeader) {
                    options.headers.cookie = cookieHeader;
                }

                if (options.headers.referer) {
                    options.headers.referer = this.rewriteProxyOrigin(options.headers.referer as string, targetOrigin);
                }

                if (options.headers.origin) {
                    options.headers.origin = this.rewriteProxyOrigin(options.headers.origin as string, targetOrigin);
                }
                
                const reqOptions = {
                    ...options,
                    rejectUnauthorized: false
                };

                const proxyReq = (targetUrl.protocol === 'https:' ? https : http).request(reqOptions, (proxyRes) => {
                    const headers = { ...proxyRes.headers };
                    
                    delete headers['x-frame-options'];
                    delete headers['content-security-policy'];
                    delete headers['content-security-policy-report-only'];

                    if (headers.location) {
                        headers.location = this.rewriteLocationHeader(
                            headers.location,
                            targetOrigin,
                            (server.address() as import('net').AddressInfo).port
                        );
                    }

                    this.captureCookies(proxyState.cookieJar, headers['set-cookie']);
                    delete headers['set-cookie'];

                    res.writeHead(proxyRes.statusCode || 200, headers);
                    proxyRes.pipe(res);
                });

                proxyReq.on('error', (e) => {
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
            }

            if (shouldDelete) {
                cookieJar.delete(name);
                continue;
            }

            cookieJar.set(name, { value: `${name}=${value}`, expiresAt });
        }
    }

    private static rewriteProxyOrigin(value: string, targetOrigin: string): string {
        return value.replace(/http:\/\/127\.0\.0\.1:\d+/g, targetOrigin);
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

        return location.replace(targetOrigin, `http://127.0.0.1:${port}`);
    }
}
