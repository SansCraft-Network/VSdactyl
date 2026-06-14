import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Client, SFTPWrapper, ConnectConfig } from 'ssh2';
import { Logger } from '../utils/logger';

// helper to map local log calls to Logger
function log(message: string): void {
    Logger.debug(`[SFTP] ${message}`);
}

export interface SftpConnectionInfo {
    host: string;
    port: number;
    username: string; // format: <panelUsername>.<serverIdentifier>
    privateKey?: string; // PEM-format private key
    password?: string; // fallback if no key
    knownHostsPath?: string;
}

export interface SftpFileEntry {
    name: string;
    size: number;
    isDirectory: boolean;
    isFile: boolean;
    isSymlink: boolean;
    modifyTime: number;
    accessTime: number;
    mode: number;
}

function isENOENTMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('no such file') || normalized.includes('not found');
}

function isAlreadyExistsMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('already exists') || normalized.includes('file exists') || normalized.includes('eexist');
}

function isNotEmptyMessage(message: string): boolean {
    const normalized = message.toLowerCase();
    return normalized.includes('directory not empty') || normalized.includes('not empty') || normalized.includes('enotempty');
}

export class SftpClient {
    private client: Client | null = null;
    private sftp: SFTPWrapper | null = null;
    private connected = false;
    private connectionInfo: SftpConnectionInfo;

    // Connection mutex: prevents multiple simultaneous connect() calls
    private connectingPromise: Promise<void> | null = null;
    private keepAliveTimer: NodeJS.Timeout | null = null;

    private clearKeepAlive() {
        if (this.keepAliveTimer) {
            clearInterval(this.keepAliveTimer);
            this.keepAliveTimer = null;
        }
    }

    // Track consecutive failures to prevent infinite retry loops
    private consecutiveFailures = 0;
    private static readonly MAX_RETRIES = 1; // Reduced from 3 to 1 to fail fast and let user retry manually

    private getKnownHostsPath(): string {
        if (this.connectionInfo.knownHostsPath) {
            return this.connectionInfo.knownHostsPath;
        }
        return path.join(os.homedir(), '.sanscraft-vsdactyl-known-hosts.json');
    }

    private getKnownHostKey(): string {
        return `${this.connectionInfo.host}:${this.connectionInfo.port}`;
    }

    private readKnownHosts(): Record<string, string> {
        const knownHostsPath = this.getKnownHostsPath();
        try {
            if (!fs.existsSync(knownHostsPath)) {
                return {};
            }
            const raw = fs.readFileSync(knownHostsPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                return parsed as Record<string, string>;
            }
        } catch (err: any) {
            log(`  ⚠️ Failed to read known hosts file: ${err.message}`);
        }
        return {};
    }

    private writeKnownHosts(entries: Record<string, string>): void {
        const knownHostsPath = this.getKnownHostsPath();
        try {
            const dir = path.dirname(knownHostsPath);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(knownHostsPath, JSON.stringify(entries, null, 2), { encoding: 'utf-8' });
        } catch (err: any) {
            log(`  ⚠️ Failed to persist known host fingerprint: ${err.message}`);
        }
    }

    private getFingerprint(hostKey: Buffer): string {
        const digest = crypto.createHash('sha256').update(hostKey).digest('base64');
        return `sha256:${digest}`;
    }

    private verifyAndStoreHostKey(hostKey: Buffer): boolean {
        const fingerprint = this.getFingerprint(hostKey);
        const knownHosts = this.readKnownHosts();
        const hostKeyId = this.getKnownHostKey();
        const existing = knownHosts[hostKeyId];

        if (!existing) {
            knownHosts[hostKeyId] = fingerprint;
            this.writeKnownHosts(knownHosts);
            log(`  ✅ Learned new host fingerprint for ${hostKeyId}`);
            return true;
        }

        if (existing === fingerprint) {
            return true;
        }

        log(`  ❌ Host key mismatch for ${hostKeyId}`);
        log(`  ⚠️ Stored: ${existing}`);
        log(`  ⚠️ Current: ${fingerprint}`);
        return false;
    }

    constructor(info: SftpConnectionInfo) {
        this.connectionInfo = info;
    }

    async connect(): Promise<void> {
        // If already connected, skip
        if (this.connected && this.sftp) {
            return;
        }

        // If another connect() is in progress, wait for it instead of starting a new one
        if (this.connectingPromise) {
            log(`  ⏳ Connection already in progress, waiting...`);
            return this.connectingPromise;
        }

        // Check retry limit
        if (this.consecutiveFailures >= SftpClient.MAX_RETRIES) {
            const msg = `Too many connection failures (${this.consecutiveFailures}). Use "VSDactyl: Connect to Server" to retry.`;
            log(`  🛑 ${msg}`);
            throw new Error(msg);
        }

        // Set the mutex promise
        this.connectingPromise = this.doConnect();

        try {
            await this.connectingPromise;
        } finally {
            this.connectingPromise = null;
        }
    }

    private doConnect(): Promise<void> {
        const { host, port, username } = this.connectionInfo;
        log(`🔌 Connecting to ${host}:${port} as ${username}...`);

        return new Promise<void>((resolve, reject) => {
            // Clean up any existing client
            if (this.client) {
                try { this.client.end(); } catch { /* ignore */ }
                this.client = null;
                this.sftp = null;
            }

            this.client = new Client();

            const config: ConnectConfig = {
                host,
                port,
                username,
                readyTimeout: 10000, // Reduced from 15000
                hostVerifier: (hostKey: Buffer) => this.verifyAndStoreHostKey(hostKey),
                keepaliveInterval: 10000,
                keepaliveCountMax: 3,
                algorithms: {
                    kex: [
                        'curve25519-sha256',
                        'curve25519-sha256@libssh.org',
                        'ecdh-sha2-nistp256',
                        'ecdh-sha2-nistp384',
                        'ecdh-sha2-nistp521',
                        'diffie-hellman-group14-sha256',
                    ],
                    cipher: [
                        'aes128-ctr',
                        'aes192-ctr',
                        'aes256-ctr',
                        'aes128-gcm@openssh.com',
                        'aes256-gcm@openssh.com',
                    ],
                    serverHostKey: [
                        'ssh-rsa',
                        'rsa-sha2-256',
                        'rsa-sha2-512',
                        'ecdsa-sha2-nistp256',
                        'ssh-ed25519',
                    ],
                    hmac: [
                        'hmac-sha2-256',
                        'hmac-sha2-512',
                        'hmac-sha1',
                    ],
                },
            };

            // Auth method
            if (this.connectionInfo.privateKey) {
                log(`  🔑 Auth: SSH private key`);
                config.privateKey = this.connectionInfo.privateKey;
            } else if (this.connectionInfo.password) {
                log(`  🔑 Auth: Password`);
                config.password = this.connectionInfo.password;
            } else {
                const msg = 'No authentication method configured (no key and no password)';
                log(`  ❌ ${msg}`);
                this.consecutiveFailures++;
                reject(new Error(msg));
                return;
            }

            let settled = false;

            const timeout = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    const msg = `Connection timed out after 12s to ${host}:${port}`;
                    log(`  ❌ TIMEOUT: ${msg}`);
                    log(`  💡 Check: (1) SFTP host/port correct? (2) Firewall blocking? (3) Server running?`);
                    this.consecutiveFailures++;
                    try { this.client?.end(); } catch { /* ignore */ }
                    reject(new Error(msg));
                }
            }, 12000); // reduced timeout safety buffer

            this.client.on('banner', (msg: string) => {
                log(`  📢 Server banner: ${msg.trim()}`);
            });

            this.client.on('greeting', (msg: string) => {
                log(`  👋 Server greeting: ${msg.trim()}`);
            });

            this.client.on('ready', () => {
                log(`  ✅ SSH handshake complete, requesting SFTP subsystem...`);
                this.client!.sftp((err, sftp) => {
                    if (settled) { return; }
                    clearTimeout(timeout);

                    if (err) {
                        settled = true;
                        log(`  ❌ SFTP subsystem failed: ${err.message}`);
                        log(`  💡 The SSH connection worked, but SFTP subsystem is unavailable`);
                        log(`  💡 Check: Is SFTP enabled on the server?`);
                        this.consecutiveFailures++;
                        reject(new Error(`SFTP session failed: ${err.message}`));
                        return;
                    }
                    settled = true;
                    this.sftp = sftp;
                    this.connected = true;
                    this.consecutiveFailures = 0; // reset on success

                    this.clearKeepAlive();
                    this.keepAliveTimer = setInterval(() => {
                        if (this.sftp) {
                            this.sftp.realpath('.', () => { /* silent keep-alive ping */ });
                        }
                    }, 45000);

                    log(`  ✅ SFTP session established successfully`);
                    resolve();
                });
            });

            this.client.on('error', (err: any) => {
                clearTimeout(timeout);
                this.clearKeepAlive();
                const errCode = err.level || err.code || 'UNKNOWN';
                const errMsg = err.message || String(err);

                if (!settled) {
                    settled = true;
                    log(`  ❌ SSH ERROR [${errCode}]: ${errMsg}`);

                    // Provide specific help based on error type
                    if (errMsg.includes('ENOTFOUND') || errMsg.includes('getaddrinfo')) {
                        log(`  💡 DNS lookup failed - hostname "${host}" cannot be resolved`);
                        log(`  💡 Check: Is the SFTP host correct in server settings?`);
                    } else if (errMsg.includes('ECONNREFUSED')) {
                        log(`  💡 Connection refused - nothing listening on ${host}:${port}`);
                        log(`  💡 Check: Is the SFTP port correct? Is the server running?`);
                    } else if (errMsg.includes('ETIMEDOUT')) {
                        log(`  💡 Connection timed out - host is unreachable or firewalled`);
                        log(`  💡 Check: Firewall settings, network connectivity`);
                    } else if (errMsg.includes('All configured authentication methods failed')) {
                        log(`  💡 Authentication failed with all methods`);
                        if (this.connectionInfo.privateKey) {
                            log(`  💡 Check: Is the SSH public key added to the panel? (Account → SSH Keys)`);
                            log(`  💡 Check: Does the private key match the public key on the panel?`);
                            log(`  💡 Check: Is the username correct? Should be: ${username}`);
                        } else {
                            log(`  💡 Check: Is the password correct?`);
                        }
                    } else if (errMsg.includes('Handshake failed')) {
                        log(`  💡 SSH handshake failed - incompatible SSH versions or algorithms?`);
                    }

                    this.consecutiveFailures++;
                    this.connected = false;
                    this.sftp = null;
                    reject(new Error(`SSH connection error [${errCode}]: ${errMsg}`));
                } else {
                    log(`  ⚠️ SSH error (post-connect) [${errCode}]: ${errMsg}`);
                    this.connected = false;
                    this.sftp = null;
                }
            });

            this.client.on('end', () => {
                log(`  ⚠️ SSH connection ended by server (${host}:${port})`);
                this.clearKeepAlive();
                this.connected = false;
                this.sftp = null;
            });

            this.client.on('close', () => {
                log(`  ⚠️ SSH connection closed for ${host}:${port}`);
                this.clearKeepAlive();
                this.connected = false;
                this.sftp = null;
            });

            this.client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, prompts, finish) => {
                log(`  🔐 Keyboard-interactive auth requested (${prompts.length} prompts)`);
                if (this.connectionInfo.password) {
                    log(`  🔐 Responding with password...`);
                    finish([this.connectionInfo.password]);
                } else {
                    log(`  ⚠️ No password configured for keyboard-interactive`);
                    finish([]);
                }
            });

            log(`  🚀 Initiating SSH connection...`);
            try {
                this.client.connect(config);
            } catch (err: any) {
                clearTimeout(timeout);
                if (!settled) {
                    settled = true;
                    log(`  ❌ Failed to initiate connection: ${err.message}`);
                    this.consecutiveFailures++;
                    reject(new Error(`Failed to start SSH client: ${err.message}`));
                }
            }
        });
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            const { host, port } = this.connectionInfo;
            log(`Disconnecting from ${host}:${port}`);
            this.clearKeepAlive();
            try { this.client.end(); } catch { /* ignore */ }
            this.client = null;
            this.sftp = null;
            this.connected = false;
            this.consecutiveFailures = 0; // Reset on manual disconnect
        }
    }

    /** Reset failure counter so reconnect can be attempted again */
    resetRetries(): void {
        this.consecutiveFailures = 0;
    }

    private async ensureConnected(): Promise<SFTPWrapper> {
        if (!this.connected || !this.sftp) {
            log(`Auto-reconnecting...`);
            await this.connect();
        }
        if (!this.sftp) {
            throw new Error('SFTP session not available after connect');
        }
        return this.sftp;
    }

    private static normalizeRemotePath(remotePath: string): string {
        let normalized = (remotePath || '/').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        if (!normalized.startsWith('/')) {
            normalized = `/${normalized}`;
        }
        if (normalized.length > 1 && normalized.endsWith('/')) {
            normalized = normalized.slice(0, -1);
        }
        return normalized || '/';
    }

    async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        if (!this.client) {
            throw new Error('SSH client is not connected');
        }

        return new Promise((resolve, reject) => {
            this.client!.exec(command, (err, stream) => {
                if (err) {
                    reject(new Error(`Failed to execute remote command: ${err.message}`));
                    return;
                }

                let stdout = '';
                let stderr = '';

                stream.on('data', (chunk: string | Buffer) => {
                    stdout += chunk.toString();
                });
                stream.stderr.on('data', (chunk: string | Buffer) => {
                    stderr += chunk.toString();
                });
                stream.on('close', (code: number | null) => {
                    resolve({ stdout, stderr, exitCode: code ?? 0 });
                });
                stream.on('error', (streamError: Error) => {
                    reject(new Error(`Remote command stream failed: ${streamError.message}`));
                });
            });
        });
    }

    private async pathKind(remotePath: string): Promise<'dir' | 'file' | 'missing'> {
        const sftp = await this.ensureConnected();
        return new Promise((resolve, reject) => {
            sftp.lstat(remotePath, (err, attrs) => {
                if (err) {
                    if (isENOENTMessage(err.message ?? '')) {
                        resolve('missing');
                        return;
                    }
                    reject(err);
                    return;
                }

                const mode = attrs.mode ?? 0;
                const isDir = (mode & 0o40000) !== 0;
                resolve(isDir ? 'dir' : 'file');
            });
        });
    }

    private async unlinkFile(remotePath: string): Promise<void> {
        const sftp = await this.ensureConnected();
        return new Promise((resolve, reject) => {
            sftp.unlink(remotePath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    private async removeDir(remotePath: string): Promise<void> {
        const sftp = await this.ensureConnected();
        return new Promise((resolve, reject) => {
            sftp.rmdir(remotePath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    private async renameRaw(oldPath: string, newPath: string): Promise<void> {
        const sftp = await this.ensureConnected();
        return new Promise((resolve, reject) => {
            sftp.rename(oldPath, newPath, (err) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            });
        });
    }

    async list(directory: string): Promise<SftpFileEntry[]> {
        const sftp = await this.ensureConnected();
        log(`LIST ${directory}`);
        return new Promise((resolve, reject) => {
            sftp.readdir(directory, (err, list) => {
                if (err) {
                    // Suppress log for common errors or lower level
                    if (isENOENTMessage(err.message ?? '') || (err as any).code === 'ENOENT') {
                        log(`  ℹ️ LIST ${directory}: no such file`);
                    } else {
                        log(`  ❌ LIST failed: ${err.message}`);
                    }
                    reject(new Error(`Failed to list ${directory}: ${err.message}`));
                    return;
                }
                const entries = list
                    .filter(item => item.filename !== '.' && item.filename !== '..')
                    .map(item => ({
                        name: item.filename,
                        size: item.attrs.size,
                        isDirectory: (item.attrs.mode! & 0o40000) !== 0,
                        isFile: (item.attrs.mode! & 0o100000) !== 0,
                        isSymlink: (item.attrs.mode! & 0o120000) === 0o120000,
                        modifyTime: item.attrs.mtime * 1000,
                        accessTime: item.attrs.atime * 1000,
                        mode: item.attrs.mode!,
                    }));
                log(`  ✅ ${entries.length} entries`);
                resolve(entries);
            });
        });
    }

    async stat(filePath: string): Promise<SftpFileEntry> {
        const sftp = await this.ensureConnected();
        return new Promise((resolve, reject) => {
            sftp.stat(filePath, (err, stats) => {
                if (err) {
                    if (isENOENTMessage(err.message ?? '') || (err as any).code === 'ENOENT') {
                        log(`  ℹ️ STAT ${filePath}: no such file`);
                    } else {
                        log(`  ❌ STAT ${filePath}: ${err.message}`);
                    }
                    reject(new Error(`Failed to stat ${filePath}: ${err.message}`));
                    return;
                }
                const name = filePath.split(/[/\\]/).pop() || '';
                resolve({
                    name,
                    size: stats.size,
                    isDirectory: (stats.mode! & 0o40000) !== 0,
                    isFile: (stats.mode! & 0o100000) !== 0,
                    isSymlink: (stats.mode! & 0o120000) === 0o120000,
                    modifyTime: stats.mtime * 1000,
                    accessTime: stats.atime * 1000,
                    mode: stats.mode!,
                });
            });
        });
    }

    async readFileStream(filePath: string): Promise<import('stream').Readable> {
        const sftp = await this.ensureConnected();
        return sftp.createReadStream(filePath);
    }

    async writeFileStream(filePath: string): Promise<import('stream').Writable> {
        const sftp = await this.ensureConnected();
        return sftp.createWriteStream(filePath);
    }

    async readFile(filePath: string): Promise<Buffer> {
        const stream = await this.readFileStream(filePath);
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: string | Buffer) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            stream.on('error', (err: Error) => reject(new Error(`Failed to read ${filePath}: ${err.message}`)));
            stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
    }

    async getWriteStream(filePath: string): Promise<import('stream').Writable> {
        return this.writeFileStream(filePath);
    }

    async writeFile(filePath: string, data: Buffer): Promise<void> {
        const stream = await this.writeFileStream(filePath);
        return new Promise((resolve, reject) => {
            let completed = false;
            const done = (err?: Error) => {
                if (completed) return;
                completed = true;
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            };
            stream.on('error', (err: Error) => done(new Error(`Failed to write ${filePath}: ${err.message}`)));
            stream.on('finish', () => done());
            stream.on('close', () => done());
            stream.end(data);
        });
    }

    async mkdir(dirPath: string): Promise<void> {
        const normalizedPath = SftpClient.normalizeRemotePath(dirPath);
        if (normalizedPath === '/' || normalizedPath === '') {
            return;
        }

        const kind = await this.pathKind(normalizedPath);
        if (kind === 'dir') {
            return;
        }
        if (kind === 'file') {
            throw new Error(`Cannot create directory: path exists and is not a directory: ${normalizedPath}`);
        }

        const parent = path.posix.dirname(normalizedPath);
        if (parent !== '/' && parent.length > 0) {
            await this.mkdir(parent);
        }

        const sftp = await this.ensureConnected();
        log(`MKDIR ${normalizedPath}`);
        return new Promise((resolve, reject) => {
            sftp.mkdir(normalizedPath, (err) => {
                if (err) {
                    if (isAlreadyExistsMessage(err.message ?? '')) {
                        log(`  ℹ️ MKDIR exists: ${normalizedPath}`);
                        resolve();
                        return;
                    }
                    log(`  ❌ MKDIR failed: ${err.message}`);
                    reject(new Error(`Failed to create directory ${normalizedPath}: ${err.message}`));
                    return;
                }
                log(`  ✅ Created`);
                resolve();
            });
        });
    }

    private async deleteRecursive(targetPath: string): Promise<void> {
        const entries = await this.list(targetPath);
        for (const entry of entries) {
            const childPath = path.posix.join(targetPath, entry.name);
            if (entry.isDirectory) {
                await this.deleteRecursive(childPath);
            } else {
                await this.unlinkFile(childPath);
            }
        }
        await this.removeDir(targetPath);
    }

    async delete(filePath: string, options?: { recursive?: boolean }): Promise<void> {
        const normalizedPath = SftpClient.normalizeRemotePath(filePath);
        const recursive = options?.recursive ?? false;
        log(`DELETE ${normalizedPath} (recursive=${recursive})`);

        const kind = await this.pathKind(normalizedPath);
        if (kind === 'missing') {
            throw new Error(`No such file: ${normalizedPath}`);
        }

        try {
            if (kind === 'file') {
                await this.unlinkFile(normalizedPath);
                log(`  ✅ Deleted (file)`);
                return;
            }

            if (!recursive) {
                await this.removeDir(normalizedPath);
                log(`  ✅ Deleted (dir)`);
                return;
            }

            await this.deleteRecursive(normalizedPath);
            log(`  ✅ Deleted (dir recursive)`);
        } catch (err: any) {
            if (isNotEmptyMessage(err.message ?? '')) {
                throw new Error(`Directory not empty: ${normalizedPath}`);
            }
            throw new Error(`Failed to delete ${normalizedPath}: ${err.message}`);
        }
    }

    async rename(oldPath: string, newPath: string, options?: { overwrite?: boolean }): Promise<void> {
        const sourcePath = SftpClient.normalizeRemotePath(oldPath);
        const targetPath = SftpClient.normalizeRemotePath(newPath);
        const overwrite = options?.overwrite ?? false;

        log(`RENAME ${sourcePath} → ${targetPath} (overwrite=${overwrite})`);

        const sourceKind = await this.pathKind(sourcePath);
        if (sourceKind === 'missing') {
            throw new Error(`No such file: ${sourcePath}`);
        }

        const targetKind = await this.pathKind(targetPath);
        if (targetKind !== 'missing' && !overwrite) {
            throw new Error(`File exists: ${targetPath}`);
        }

        if (targetKind !== 'missing' && overwrite) {
            await this.delete(targetPath, { recursive: true });
        }

        try {
            await this.renameRaw(sourcePath, targetPath);
            log(`  ✅ Renamed`);
        } catch (err: any) {
            throw new Error(`Failed to rename ${sourcePath} to ${targetPath}: ${err.message}`);
        }
    }

    async chmod(filePath: string, mode: number): Promise<void> {
        const sftp = await this.ensureConnected();
        return new Promise((resolve, reject) => {
            sftp.chmod(filePath, mode, (err) => {
                if (err) {
                    reject(new Error(`Failed to chmod ${filePath}: ${err.message}`));
                    return;
                }
                resolve();
            });
        });
    }

    isConnected(): boolean {
        return this.connected;
    }

    /** Show the debug output channel to the user */
    static showDebugLog(): void {
        Logger.show();
    }
}
