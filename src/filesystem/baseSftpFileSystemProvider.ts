import * as vscode from 'vscode';
import { SftpClient } from '../sftp/sftpClient';

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

    protected connections: Map<string, T> = new Map();

    constructor(protected readonly syncStatusReporter?: SyncStatusReporter) {}

    protected getClient(uri: vscode.Uri): SftpClient {
        const identifier = uri.authority;
        const conn = this.connections.get(identifier);
        if (!conn) {
            throw vscode.FileSystemError.Unavailable(`Not connected: ${identifier}`);
        }
        return conn.sftpClient;
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

        const client = this.getClient(uri);

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
        const client = this.getClient(uri);

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
        const client = this.getClient(uri);

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
        const client = this.getClient(uri);
        this.syncStatusReporter?.beginSync(uri);

        try {
            await client.writeFile(filePath, Buffer.from(content));
            this._onDidChangeFile.fire([{
                type: vscode.FileChangeType.Changed,
                uri,
            }]);
            this.syncStatusReporter?.completeSync(uri);
        } catch (err: any) {
            this.syncStatusReporter?.failSync(uri);
            throw vscode.FileSystemError.Unavailable(`Failed to write file: ${err.message}`);
        }
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const filePath = this.getFilePath(uri);
        const client = this.getClient(uri);
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
        const oldPath = this.getFilePath(oldUri);
        const newPath = this.getFilePath(newUri);
        const client = this.getClient(oldUri);
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
        const client = this.getClient(uri);
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
        const destinationClient = this.getClient(destination);
        const destinationPath = this.getFilePath(destination);

        try {
            await destinationClient.stat(destinationPath);
            if (!overwrite) {
                throw new Error(`File exists: ${destinationPath}`);
            }
            await destinationClient.delete(destinationPath, { recursive: true });
        } catch (err: any) {
            if (!BaseSftpFileSystemProvider.isRemoteNotFound(err)) {
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
            const destinationClient = this.getClient(destination);
            const destinationPath = this.getFilePath(destination);
            await destinationClient.mkdir(destinationPath);

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
        const destinationClient = this.getClient(destination);
        const destinationPath = this.getFilePath(destination);
        await destinationClient.writeFile(destinationPath, Buffer.from(content));
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
