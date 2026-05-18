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
}
