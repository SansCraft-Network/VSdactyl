import * as vscode from 'vscode';
import * as fs from 'fs';
import { PteroAccount, PterodactylClient } from '../api/pterodactylClient';
import { SftpClient, SftpConnectionInfo } from '../sftp/sftpClient';
import { BaseSftpFileSystemProvider, BaseServerConnection, SyncStatusReporter } from './baseSftpFileSystemProvider';

interface ServerConnection extends BaseServerConnection {
    account: PteroAccount;
    serverIdentifier: string;
    serverName: string;
    sftpHost: string;
    sftpPort: number;
}

export class PterodactylFileSystemProvider extends BaseSftpFileSystemProvider<ServerConnection> {
    constructor(syncStatusReporter?: SyncStatusReporter) {
        super(syncStatusReporter);
    }

    registerConnection(
        serverIdentifier: string,
        account: PteroAccount,
        serverName: string,
        sftpHost: string,
        sftpPort: number
    ): void {
        // Close existing connection if any
        const existing = this.connections.get(serverIdentifier);
        if (existing) {
            existing.sftpClient.disconnect();
        }

        // Read SSH private key: from file or pasted/generated content
        let privateKey: string | undefined;
        let password: string | undefined;

        if (account.sftpAuthMethod === 'ssh-key') {
            if (account.privateKeyPath) {
                try {
                    privateKey = fs.readFileSync(account.privateKeyPath, 'utf-8');
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to read SSH key file: ${err.message}`);
                }
            } else if (account.privateKeyData) {
                privateKey = account.privateKeyData;
            }
        } else {
            password = account.password;
        }

        const connInfo: SftpConnectionInfo = {
            host: sftpHost,
            port: sftpPort,
            username: `${account.username}.${serverIdentifier}`,
            privateKey,
            password,
        };

        this.connections.set(serverIdentifier, {
            identifier: serverIdentifier,
            account,
            serverIdentifier,
            serverName,
            sftpHost,
            sftpPort,
            sftpClient: new SftpClient(connInfo),
        });
    }

    clearCache(): void {
        // No cache with SFTP - direct protocol access
    }

    async disconnectServer(serverIdentifier: string): Promise<void> {
        const conn = this.connections.get(serverIdentifier);
        if (conn) {
            await conn.sftpClient.disconnect();
            this.connections.delete(serverIdentifier);
        }
    }

    async reconnect(serverIdentifier: string): Promise<void> {
        const conn = this.connections.get(serverIdentifier);
        if (!conn) {
            throw new Error(`No active connection found for ${serverIdentifier}`);
        }

        // Disconnect existing
        await conn.sftpClient.disconnect();

        // Re-register (creates new SftpClient)
        this.registerConnection(
            conn.serverIdentifier,
            conn.account,
            conn.serverName,
            conn.sftpHost,
            conn.sftpPort
        );
    }

    async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
        const identifier = uri.authority;
        const conn = this.connections.get(identifier);

        if (conn && conn.account.type === 'pterodactyl') {
            const filePath = this.getFilePath(uri);
            const parts = filePath.split('/');
            const filename = parts.pop() || '';
            const directory = parts.join('/') || '/';

            this.syncStatusReporter?.beginSync(uri);
            try {
                const client = new PterodactylClient(conn.account.panelUrl, conn.account.apiKey || '');
                await client.deleteFiles(conn.serverIdentifier, directory, [filename]);
                this._onDidChangeFile.fire([{
                    type: vscode.FileChangeType.Deleted,
                    uri,
                }]);
                this.syncStatusReporter?.completeSync(uri);
                return;
            } catch (err: any) {
                this.syncStatusReporter?.failSync(uri);
                throw vscode.FileSystemError.Unavailable(`API Delete Failed: ${err.message}`);
            }
        }

        // Fallback to SFTP
        return super.delete(uri, options);
    }

    async createDirectory(uri: vscode.Uri): Promise<void> {
        const identifier = uri.authority;
        const conn = this.connections.get(identifier);

        if (conn && conn.account.type === 'pterodactyl') {
            const filePath = this.getFilePath(uri);
            const parts = filePath.split('/');
            const name = parts.pop() || '';
            const root = parts.join('/') || '/';

            this.syncStatusReporter?.beginSync(uri);
            try {
                const client = new PterodactylClient(conn.account.panelUrl, conn.account.apiKey || '');
                await client.createFolder(conn.serverIdentifier, root, name);
                this._onDidChangeFile.fire([{
                    type: vscode.FileChangeType.Created,
                    uri,
                }]);
                this.syncStatusReporter?.completeSync(uri);
                return;
            } catch (err: any) {
                this.syncStatusReporter?.failSync(uri);
                throw vscode.FileSystemError.Unavailable(`API Create Directory Failed: ${err.message}`);
            }
        }

        return super.createDirectory(uri);
    }

    async rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { overwrite: boolean }): Promise<void> {
        const isSameRemoteConnection = oldUri.scheme === newUri.scheme && oldUri.authority === newUri.authority;
        if (!isSameRemoteConnection) {
            return super.rename(oldUri, newUri, options);
        }

        const identifier = oldUri.authority;
        const conn = this.connections.get(identifier);

        if (conn && conn.account.type === 'pterodactyl') {
            const oldPath = this.getFilePath(oldUri);
            const newPath = this.getFilePath(newUri);
            const from = oldPath.startsWith('/') ? oldPath.substring(1) : oldPath;
            const to = newPath.startsWith('/') ? newPath.substring(1) : newPath;

            this.syncStatusReporter?.beginSync(oldUri);
            this.syncStatusReporter?.beginSync(newUri);

            let session: any;
            let transferManager: any;
            if (this.transferOrchestrator) {
                const path = require('path');
                transferManager = this.transferOrchestrator['sessions'];
                session = transferManager.registerSession({
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
            }

            try {
                if (session && transferManager) {
                    transferManager.updateChildStatus(session.id, session.children[0].id, 'running');
                }

                const client = new PterodactylClient(conn.account.panelUrl, conn.account.apiKey || '');
                await client.renameFile(conn.serverIdentifier, '/', from, to);

                if (session && transferManager) {
                    transferManager.completeChild(session.id, session.children[0].id, true);
                }

                this._onDidChangeFile.fire([
                    { type: vscode.FileChangeType.Deleted, uri: oldUri },
                    { type: vscode.FileChangeType.Created, uri: newUri },
                ]);
                this.syncStatusReporter?.completeSync(oldUri);
                this.syncStatusReporter?.completeSync(newUri);
                return;
            } catch (err: any) {
                if (session && transferManager) {
                    transferManager.completeChild(session.id, session.children[0].id, false, err.message);
                }
                this.syncStatusReporter?.failSync(oldUri);
                this.syncStatusReporter?.failSync(newUri);
                throw vscode.FileSystemError.Unavailable(`API Rename Failed: ${err.message}`);
            }
        }

        return super.rename(oldUri, newUri, options);
    }
}
