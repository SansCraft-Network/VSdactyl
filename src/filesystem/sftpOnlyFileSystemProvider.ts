import * as vscode from 'vscode';
import * as fs from 'fs';
import { SftpOnlyAccount } from '../accounts/types';
import { SftpClient, SftpConnectionInfo } from '../sftp/sftpClient';
import { BaseSftpFileSystemProvider, BaseServerConnection, SyncStatusReporter } from './baseSftpFileSystemProvider';

import { AccountManager } from '../accounts/accountManager';

export interface SftpOnlyServerConnection extends BaseServerConnection {
    account: SftpOnlyAccount;
}

export class SftpOnlyFileSystemProvider extends BaseSftpFileSystemProvider<SftpOnlyServerConnection> {
    constructor(syncStatusReporter?: SyncStatusReporter) {
        super(syncStatusReporter);
    }

    registerConnection(account: SftpOnlyAccount): void {
        const identifier = account.id;

        // Close existing connection if any
        const existing = this.connections.get(identifier);
        if (existing) {
            existing.sftpClient.disconnect();
        }

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
            host: account.host,
            port: account.port,
            username: account.username,
            privateKey,
            password,
        };

        this.connections.set(identifier, {
            identifier,
            account,
            sftpClient: new SftpClient(connInfo),
        });
    }

    async disconnectServer(identifier: string): Promise<void> {
        const conn = this.connections.get(identifier);
        if (conn) {
            await conn.sftpClient.disconnect();
            this.connections.delete(identifier);
        }
    }

    async reconnect(identifier: string): Promise<void> {
        const conn = this.connections.get(identifier);
        if (conn) {
            await conn.sftpClient.disconnect();

            let privateKey: string | undefined;
            if (conn.account.sftpAuthMethod === 'ssh-key') {
                if (conn.account.privateKeyPath) {
                    try {
                        privateKey = fs.readFileSync(conn.account.privateKeyPath, 'utf8');
                    } catch (err: any) {
                        throw new Error(`Failed to read SSH key file: ${err.message}`);
                    }
                } else {
                    privateKey = conn.account.privateKeyData;
                }
            }

            conn.sftpClient = new SftpClient({
                host: conn.account.host,
                port: conn.account.port,
                username: conn.account.username,
                password: conn.account.password,
                privateKey,
            });
        }
    }

    protected async ensureConnectionRegistered(accountId: string): Promise<void> {
        if (this.connections.has(accountId)) {
            return;
        }

        if (!this.accountManager) {
            return;
        }

        const account = await this.accountManager.getAccountById(accountId);
        if (account && account.type === 'sftpOnly') {
            this.registerConnection(account as SftpOnlyAccount);
        }
    }
}
