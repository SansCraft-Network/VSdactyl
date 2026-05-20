import * as vscode from 'vscode';
import { SftpClient } from '../sftp/sftpClient';
import { AccountManager } from '../accounts/accountManager';

export interface SyncStatusReporter {
    beginSync(uri: vscode.Uri): void;
    completeSync(uri: vscode.Uri): void;
    failSync(uri: vscode.Uri): void;
}

export interface BaseServerConnection {
    identifier: string;
    sftpClient: SftpClient;
}

export abstract class BaseSftpFileSystemProvider<T extends BaseServerConnection> implements vscode.FileSystemProvider {
    protected _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    readonly onDidChangeFile = this._onDidChangeFile.event;

    protected accountManager?: AccountManager;
    protected connections: Map<string, T> = new Map();
    protected transferOrchestrator?: any;
    protected static hasShownLargeFileWarning = false;

    public setAccountManager(accountManager: AccountManager) {
        this.accountManager = accountManager;
    }

    public setOrchestrator(orchestrator: any) {
        this.transferOrchestrator = orchestrator;
    }

    constructor(protected readonly syncStatusReporter?: SyncStatusReporter) {}

    public getConnection(identifier: string): T | undefined {
        return this.connections.get(identifier);
    }

    protected async getClient(uri: vscode.Uri): Promise<SftpClient> {
        const identifier = uri.authority;
        await this.ensureConnectionRegistered(identifier);
        const conn = this.connections.get(identifier);
        if (!conn) {
            throw vscode.FileSystemError.Unavailable(`Not connected: ${identifier}`);
        }
        return conn.sftpClient;
    }

    protected async ensureConnectionRegistered(_identifier: string): Promise<void> {
        // Overridden by subclasses to dynamically restore connections on demand
    }

    protected getFilePath(uri: vscode.Uri): string {
        let filePath = (uri.path || '/').replace(/\\/g, '/').replace(/\/{2,}/g, '/');
        if (!filePath.startsWith('/')) {
            filePath = `/${filePath}`;
        }
        if (filePath.length > 1 && filePath.endsWith('/')) {
            filePath = filePath.slice(0, -1);
        }
        return filePath || '/';
    }

    private static isRemoteNotFound(err: unknown): boolean {
        const message = String((err as { message?: string })?.message ?? '').toLowerCase();
        return message.includes('no such file') || message.includes('not found');
    }

    private static isFileExists(err: unknown): boolean {
        const message = String((err as { message?: string })?.message ?? '').toLowerCase();
        return message.includes('file exists') || message.includes('already exists') || message.includes('eexist');
    }

    private static isDirectoryNotEmpty(err: unknown): boolean {
        const message = String((err as { message?: string })?.message ?? '').toLowerCase();
        return message.includes('directory not empty') || message.includes('not empty') || message.includes('enotempty');
    }

    private static isFileNotFound(err: unknown): boolean {
        if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
            return true;
        }
        const message = String((err as { message?: string })?.message ?? '').toLowerCase();
        return message.includes('filenotfound') || message.includes('entry not found');
    }

    watch(_uri: vscode.Uri, _options: { recursive: boolean; excludes: string[] }): vscode.Disposable {
        return new vscode.Disposable(() => { });
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const filePath = this.getFilePath(uri);

        if (filePath === '/' || filePath === '') {
            return {
                type: vscode.FileType.Directory,
                ctime: 0,
                mtime: Date.now(),
                size: 0,
            };
        }

        const client = await this.getClient(uri);

        try {
            const entry = await client.stat(filePath);
            return {
                type: entry.isDirectory ? vscode.FileType.Directory :
                    entry.isSymlink ? vscode.FileType.SymbolicLink :
                        vscode.FileType.File,
                ctime: entry.accessTime,
                mtime: entry.modifyTime,
                size: entry.size,
            };
        } catch (err: any) {
            if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            throw vscode.FileSystemError.Unavailable(err.message);
        }
    }

    async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
        const filePath = this.getFilePath(uri);
        const client = await this.getClient(uri);

        try {
            const entries = await client.list(filePath);
            return entries.map(entry => [
                entry.name,
                entry.isDirectory ? vscode.FileType.Directory :
                    entry.isSymlink ? vscode.FileType.SymbolicLink :
                        vscode.FileType.File,
            ]);
        } catch (err: any) {
            throw vscode.FileSystemError.Unavailable(err.message);
        }
    }

    async readFile(uri: vscode.Uri): Promise<Uint8Array> {
        const filePath = this.getFilePath(uri);
        const client = await this.getClient(uri);

        try {
            const buffer = await client.readFile(filePath);
            return new Uint8Array(buffer);
        } catch (err: any) {
            if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            throw vscode.FileSystemError.Unavailable(err.message);
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, _options: { create: boolean; overwrite: boolean }): Promise<void> {
        const filePath = this.getFilePath(uri);
        const client = await this.getClient(uri);
        this.syncStatusReporter?.beginSync(uri);

        const sizeThresholdBytes = 10 * 1024 * 1024; // 10 MB
        if (content.length > sizeThresholdBytes && !BaseSftpFileSystemProvider.hasShownLargeFileWarning) {
            BaseSftpFileSystemProvider.hasShownLargeFileWarning = true;
            vscode.window.showInformationMessage(
                `Uploading large file (${(content.length / (1024 * 1024)).toFixed(1)} MB) via native File Explorer. For faster, compressed uploads and full progress tracking, try dragging files directly into the VSDactyl Server Tree View!`,
                'Got it'
            );
        }

        let session: any;
        let transferManager: any;
        if (this.transferOrchestrator && content.length > 1024 * 1024) { // Only track in TransferManager if > 1MB
            const conn = this.getConnection(uri.authority);
            if (conn) {
                const path = require('path');
                transferManager = this.transferOrchestrator['sessions'];
                session = transferManager.registerSession({
                    id: `write_${Date.now()}`,
                    type: 'upload',
                    serverIdentifier: conn.identifier,
                    title: `Upload ${path.basename(filePath)}`,
                    mode: 'single',
                    fileCountTotal: 1,
                    fileCountCompleted: 0,
                    bytesTotal: content.length,
                    bytesTransferred: 0,
                    status: 'running',
                    children: [{
                        id: `write_child_${Date.now()}`,
                        label: `Upload ${filePath}`,
                        sourcePath: 'VS Code Editor/Explorer',
                        targetPath: filePath,
                        bytesTotal: content.length,
                        bytesTransferred: 0,
                        status: 'running'
                    }],
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                });
            }
        }

        try {
            if (session && transferManager) {
                const sftpClient = await this.getClient(uri);
                const remoteStream = await sftpClient.writeFileStream(filePath);
                const stream = require('stream');
                const bufferStream = new stream.Readable();
                bufferStream.push(content);
                bufferStream.push(null); // End of stream

                let transferred = 0;
                await new Promise<void>((resolve, reject) => {
                    bufferStream.on('data', (chunk: Buffer) => {
                        transferred += chunk.length;
                        transferManager.updateChildProgress(session.id, session.children[0].id, transferred);
                    });
                    bufferStream.on('error', reject);
                    remoteStream.on('error', (err: any) => {
                        reject(err);
                    });
                    remoteStream.on('close', () => {
                        resolve();
                    });
                    bufferStream.pipe(remoteStream);
                });
                transferManager.completeChild(session.id, session.children[0].id, true);
            } else {
                await client.writeFile(filePath, Buffer.from(content));
            }

            this._onDidChangeFile.fire([{
                type: vscode.FileChangeType.Changed,
                uri,
            }]);
            this.syncStatusReporter?.completeSync(uri);
        } catch (err: any) {
            if (session && transferManager) {
                transferManager.completeChild(session.id, session.children[0].id, false, err.message);
            }
            this.syncStatusReporter?.failSync(uri);
            throw vscode.FileSystemError.Unavailable(`Failed to write file: ${err.message}`);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const filePath = this.getFilePath(uri);
        const client = await this.getClient(uri);
        this.syncStatusReporter?.beginSync(uri);

        try {
            await client.delete(filePath, { recursive: options.recursive });
            this._onDidChangeFile.fire([{
                type: vscode.FileChangeType.Deleted,
                uri,
            }]);
            this.syncStatusReporter?.completeSync(uri);
        } catch (err: any) {
            this.syncStatusReporter?.failSync(uri);
            if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
                throw vscode.FileSystemError.FileNotFound(uri);
            }
            if (BaseSftpFileSystemProvider.isDirectoryNotEmpty(err)) {
                throw vscode.FileSystemError.NoPermissions(`Directory is not empty: ${filePath}`);
            }
            throw vscode.FileSystemError.Unavailable(`Failed to delete: ${err.message}`);
        }
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const isSameRemoteConnection = oldUri.scheme === newUri.scheme && oldUri.authority === newUri.authority;
        if (isSameRemoteConnection && this.transferOrchestrator) {
            const conn = this.getConnection(oldUri.authority);
            if (conn) {
                const sftpClient = conn.sftpClient;
                const oldPath = this.getFilePath(oldUri);
                const newPath = this.getFilePath(newUri);
                const path = require('path');

                const transferManager = this.transferOrchestrator['sessions'];
                const session = transferManager.registerSession({
                    id: `move_${Date.now()}`,
                    type: 'upload',
                    serverIdentifier: conn.identifier,
                    title: `Move ${path.basename(oldPath)}`,
                    mode: 'single',
                    fileCountTotal: 1,
                    fileCountCompleted: 0,
                    bytesTotal: 0,
                    bytesTransferred: 0,
                    status: 'running',
                    children: [{
                        id: `move_child_${Date.now()}`,
                        label: `Move ${oldPath} -> ${newPath}`,
                        sourcePath: oldPath,
                        targetPath: newPath,
                        bytesTotal: 0,
                        bytesTransferred: 0,
                        status: 'pending'
                    }],
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                });

                this.syncStatusReporter?.beginSync(oldUri);
                this.syncStatusReporter?.beginSync(newUri);
                try {
                    transferManager.updateChildStatus(session.id, session.children[0].id, 'running');
                    await sftpClient.rename(oldPath, newPath, { overwrite: options.overwrite });
                    transferManager.completeChild(session.id, session.children[0].id, true);

                    this._onDidChangeFile.fire([
                        { type: vscode.FileChangeType.Deleted, uri: oldUri },
                        { type: vscode.FileChangeType.Created, uri: newUri },
                    ]);
                    this.syncStatusReporter?.completeSync(oldUri);
                    this.syncStatusReporter?.completeSync(newUri);
                    return;
                } catch (err: any) {
                    transferManager.completeChild(session.id, session.children[0].id, false, err.message);
                    this.syncStatusReporter?.failSync(oldUri);
                    this.syncStatusReporter?.failSync(newUri);
                    if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
                        throw vscode.FileSystemError.FileNotFound(oldUri);
                    }
                    if (BaseSftpFileSystemProvider.isFileExists(err)) {
                        throw vscode.FileSystemError.FileExists(newUri);
                    }
                    throw vscode.FileSystemError.Unavailable(`Failed to rename: ${err.message}`);
                }
            }
        }

        if (!isSameRemoteConnection) {
            this.syncStatusReporter?.beginSync(oldUri);
            this.syncStatusReporter?.beginSync(newUri);
            try {
                await this.copy(oldUri, newUri, { overwrite: options.overwrite });

                const oldPath = this.getFilePath(oldUri);
                if (oldPath !== '/') {
                    await this.delete(oldUri, { recursive: true });
                }

                this._onDidChangeFile.fire([
                    { type: vscode.FileChangeType.Deleted, uri: oldUri },
                    { type: vscode.FileChangeType.Created, uri: newUri },
                ]);
                this.syncStatusReporter?.completeSync(oldUri);
                this.syncStatusReporter?.completeSync(newUri);
                return;
            } catch (err: any) {
                this.syncStatusReporter?.failSync(oldUri);
                this.syncStatusReporter?.failSync(newUri);
                if (BaseSftpFileSystemProvider.isFileExists(err)) {
                    throw vscode.FileSystemError.FileExists(newUri);
                }
                throw vscode.FileSystemError.Unavailable(`Failed to rename: ${err.message}`);
            }
        }

        const oldPath = this.getFilePath(oldUri);
        const newPath = this.getFilePath(newUri);
        const client = await this.getClient(oldUri);
        this.syncStatusReporter?.beginSync(oldUri);
        this.syncStatusReporter?.beginSync(newUri);

        try {
            await client.rename(oldPath, newPath, { overwrite: options.overwrite });
            this._onDidChangeFile.fire([
                { type: vscode.FileChangeType.Deleted, uri: oldUri },
                { type: vscode.FileChangeType.Created, uri: newUri },
            ]);
            this.syncStatusReporter?.completeSync(oldUri);
            this.syncStatusReporter?.completeSync(newUri);
        } catch (err: any) {
            this.syncStatusReporter?.failSync(oldUri);
            this.syncStatusReporter?.failSync(newUri);
            if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
                throw vscode.FileSystemError.FileNotFound(oldUri);
            }
            if (BaseSftpFileSystemProvider.isFileExists(err)) {
                throw vscode.FileSystemError.FileExists(newUri);
            }
            throw vscode.FileSystemError.Unavailable(`Failed to rename: ${err.message}`);
        }
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const filePath = this.getFilePath(uri);
        const client = await this.getClient(uri);
        this.syncStatusReporter?.beginSync(uri);

        try {
            await client.mkdir(filePath);
            this._onDidChangeFile.fire([{
                type: vscode.FileChangeType.Created,
                uri,
            }]);
            this.syncStatusReporter?.completeSync(uri);
        } catch (err: any) {
            this.syncStatusReporter?.failSync(uri);
            throw vscode.FileSystemError.Unavailable(`Failed to create directory: ${err.message}`);
        }
    }

    async copy(source: vscode.Uri, destination: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const isSourceRemote = source.scheme === 'ptero' || source.scheme === 'sftp';
        const isDestRemote = destination.scheme === 'ptero' || destination.scheme === 'sftp';

        if (this.transferOrchestrator && !isSourceRemote && isDestRemote) {
            const conn = this.getConnection(destination.authority);
            if (conn) {
                const sftpClient = conn.sftpClient;
                const remoteDestinationPath = this.getFilePath(destination);

                const path = require('path');
                const fs = require('fs');
                const os = require('os');
                
                const sourceBase = path.basename(source.fsPath || source.path);
                const destBase = path.basename(remoteDestinationPath);
                
                let localUriToUpload = source;
                let tempDir: string | undefined;
                
                if (sourceBase !== destBase) {
                    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsdactyl_upload_'));
                    const tempFilePath = path.join(tempDir, destBase);
                    
                    const stat = await vscode.workspace.fs.stat(source);
                    if (stat.type === vscode.FileType.Directory) {
                        const copyFolder = async (src: string, dest: string) => {
                            fs.mkdirSync(dest, { recursive: true });
                            const entries = fs.readdirSync(src, { withFileTypes: true });
                            for (const entry of entries) {
                                const s = path.join(src, entry.name);
                                const d = path.join(dest, entry.name);
                                if (entry.isDirectory()) {
                                    await copyFolder(s, d);
                                } else {
                                    fs.copyFileSync(s, d);
                                }
                            }
                        };
                        await copyFolder(source.fsPath, tempFilePath);
                    } else {
                        fs.copyFileSync(source.fsPath, tempFilePath);
                    }
                    localUriToUpload = vscode.Uri.file(tempFilePath);
                }
                
                try {
                    await this.transferOrchestrator.upload({
                        localUris: [localUriToUpload],
                        remoteDestinationPath: path.posix.dirname(remoteDestinationPath),
                        sftpClient,
                        serverIdentifier: conn.identifier,
                        pteroClient: (conn as any).account?.type === 'pterodactyl' ? new (require('../api/pterodactylClient').PterodactylClient)((conn as any).account.panelUrl, (conn as any).account.apiKey || '') : undefined
                    });
                } finally {
                    if (tempDir) {
                        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
                    }
                }
                return;
            }
        }

        if (this.transferOrchestrator && isSourceRemote && isDestRemote) {
            const isSameConnection = source.scheme === destination.scheme && source.authority === destination.authority;
            if (!isSameConnection) {
                const fileSystemProvider = require('../extension').fileSystemProvider;
                const sftpFileSystemProvider = require('../extension').sftpFileSystemProvider;
                
                const sourceConn = source.scheme === 'ptero' ? fileSystemProvider.getConnection(source.authority) : sftpFileSystemProvider.getConnection(source.authority);
                const destConn = destination.scheme === 'ptero' ? fileSystemProvider.getConnection(destination.authority) : sftpFileSystemProvider.getConnection(destination.authority);
                
                if (sourceConn && destConn) {
                    const sourcePath = this.getFilePath(source);
                    const destPath = this.getFilePath(destination);
                    const path = require('path');
                    const fs = require('fs');
                    const os = require('os');
                    
                    const base = path.basename(destPath);
                    const tempFile = path.join(os.tmpdir(), `vsdactyl_transfer_${Date.now()}_${base}`);
                    
                    const transferManager = this.transferOrchestrator['sessions'];
                    const session = transferManager.registerSession({
                        id: `transfer_${Date.now()}`,
                        type: 'upload',
                        serverIdentifier: destConn.identifier,
                        title: `Transfer ${base}`,
                        mode: 'single',
                        fileCountTotal: 1,
                        fileCountCompleted: 0,
                        bytesTotal: 0,
                        bytesTransferred: 0,
                        status: 'running',
                        children: [{
                            id: `transfer_child_${Date.now()}`,
                            label: `${base} (${sourceConn.identifier} -> ${destConn.identifier})`,
                            sourcePath: sourcePath,
                            targetPath: destPath,
                            bytesTotal: 0,
                            bytesTransferred: 0,
                            status: 'pending'
                        }],
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    });
                    
                    try {
                        const child = session.children[0];
                        transferManager.updateChildStatus(session.id, child.id, 'running');
                        
                        const stat = await sourceConn.sftpClient.stat(sourcePath);
                        child.bytesTotal = stat.size;
                        session.bytesTotal = stat.size;
                        transferManager.upsertSession(session);
                        
                        const remoteStream = await sourceConn.sftpClient.readFileStream(sourcePath);
                        const localStream = fs.createWriteStream(tempFile);
                        await new Promise<void>((resolve, reject) => {
                            let bytesDownloaded = 0;
                            remoteStream.on('data', (chunk: any) => {
                                bytesDownloaded += chunk.length;
                                transferManager.updateChildProgress(session.id, child.id, Math.floor(bytesDownloaded / 2));
                            });
                            remoteStream.on('error', reject);
                            localStream.on('error', reject);
                            localStream.on('close', resolve);
                            remoteStream.pipe(localStream);
                        });
                        
                        const localReadStream = fs.createReadStream(tempFile);
                        const remoteWriteStream = await destConn.sftpClient.writeFileStream(destPath);
                        await new Promise<void>((resolve, reject) => {
                            let bytesUploaded = 0;
                            localReadStream.on('data', (chunk: any) => {
                                bytesUploaded += chunk.length;
                                transferManager.updateChildProgress(session.id, child.id, Math.floor(stat.size / 2) + Math.floor(bytesUploaded / 2));
                            });
                            localReadStream.on('error', reject);
                            remoteWriteStream.on('error', reject);
                            remoteWriteStream.on('close', resolve);
                            localReadStream.pipe(remoteWriteStream);
                        });
                        
                        transferManager.completeChild(session.id, child.id, true);
                    } catch (err: any) {
                        transferManager.completeChild(session.id, session.children[0].id, false, err.message || err);
                        throw err;
                    } finally {
                        try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
                    }
                    return;
                }
            }
        }

        this.syncStatusReporter?.beginSync(destination);

        try {
            await this.copyRecursive(source, destination, options.overwrite);
            this.syncStatusReporter?.completeSync(destination);
        } catch (err: any) {
            this.syncStatusReporter?.failSync(destination);

            if (BaseSftpFileSystemProvider.isFileExists(err)) {
                throw vscode.FileSystemError.FileExists(destination);
            }
            if (BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
                throw vscode.FileSystemError.FileNotFound(source);
            }
            throw vscode.FileSystemError.Unavailable(`Failed to copy: ${err.message}`);
        }
    }

    private async ensureDestinationForCopy(destination: vscode.Uri, overwrite: boolean): Promise<void> {
        try {
            await vscode.workspace.fs.stat(destination);
            if (!overwrite) {
                throw new Error(`File exists: ${destination.toString()}`);
            }
            await vscode.workspace.fs.delete(destination, { recursive: true, useTrash: false });
        } catch (err: any) {
            if (!BaseSftpFileSystemProvider.isFileNotFound(err)) {
                if (String(err.message ?? '').toLowerCase().includes('file exists')) {
                    throw err;
                }
                throw err;
            }
        }
    }

    private async copyRecursive(source: vscode.Uri, destination: vscode.Uri, overwrite: boolean): Promise<void> {
        await this.ensureDestinationForCopy(destination, overwrite);

        const sourceStat = await vscode.workspace.fs.stat(source);

        if ((sourceStat.type & vscode.FileType.Directory) !== 0) {
            await vscode.workspace.fs.createDirectory(destination);

            const children = await vscode.workspace.fs.readDirectory(source);
            for (const [name] of children) {
                await this.copyRecursive(
                    vscode.Uri.joinPath(source, name),
                    vscode.Uri.joinPath(destination, name),
                    overwrite
                );
            }
            return;
        }

        const content = await vscode.workspace.fs.readFile(source);
        await vscode.workspace.fs.writeFile(destination, content);
    }

    async disconnectAll(): Promise<void> {
        for (const conn of this.connections.values()) {
            await conn.sftpClient.disconnect();
        }
        this.connections.clear();
    }

    dispose(): void {
        this.disconnectAll();
        this._onDidChangeFile.dispose();
    }
}
