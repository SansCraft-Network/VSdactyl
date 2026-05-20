import * as vscode from 'vscode';
import { AccountManager } from './accounts/accountManager';
import { PterodactylClient, PteroAccount, SftpOnlyAccount } from './api/pterodactylClient';
import { ServerTreeProvider, ServerTreeItem, ServerTreeDragAndDropController } from './views/serverTreeProvider';
import { PterodactylFileSystemProvider } from './filesystem/pterodactylFileSystemProvider';
import { SftpOnlyFileSystemProvider } from './filesystem/sftpOnlyFileSystemProvider';
import { RemoteFileDecorationProvider } from './filesystem/remoteFileDecorationProvider';
import { AccountFormPanel } from './views/accountFormPanel';
import { SftpAccountFormPanel } from './views/sftpAccountFormPanel';
import { SftpClient } from './sftp/sftpClient';
import { TerminalManager } from './terminal/terminalManager';
import { TransferManager } from './transfers/transferManager';
import { TransferOrchestrator } from './transfers/transferOrchestrator';
import { BulkTransferEngine } from './transfers/bulkTransferEngine';
import { SyncManager } from './sync/syncManager';
import { registerLanguageModelTools } from './tools/languageModelTools';

let accountManager!: AccountManager;
let serverTreeProvider!: ServerTreeProvider;
let fileSystemProvider!: PterodactylFileSystemProvider;
let sftpFileSystemProvider!: SftpOnlyFileSystemProvider;
let remoteDecorationProvider!: RemoteFileDecorationProvider;
let terminalManager!: TerminalManager;
let transferManager!: TransferManager;
let transferOrchestrator!: TransferOrchestrator;
let syncManager!: SyncManager;
let extensionContext!: vscode.ExtensionContext;

import { Logger } from './utils/logger';
import { PanelProxy } from './utils/panelProxy';
import { SshKeyGenerator } from './utils/sshKeyGenerator';

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize();
    Logger.info('Extension activating...');

    extensionContext = context;

    // Initialize managers
    accountManager = new AccountManager(context);
    serverTreeProvider = new ServerTreeProvider(accountManager);
    remoteDecorationProvider = new RemoteFileDecorationProvider();
    // Initialize core systems
    fileSystemProvider = new PterodactylFileSystemProvider();
    fileSystemProvider.setAccountManager(accountManager);
    sftpFileSystemProvider = new SftpOnlyFileSystemProvider();
    sftpFileSystemProvider.setAccountManager(accountManager);
    serverTreeProvider.setFileSystemProviders(fileSystemProvider, sftpFileSystemProvider);
    terminalManager = new TerminalManager();
    transferManager = TransferManager.getInstance(context);
    transferOrchestrator = new TransferOrchestrator(transferManager, new BulkTransferEngine());
    fileSystemProvider.setOrchestrator(transferOrchestrator);
    sftpFileSystemProvider.setOrchestrator(transferOrchestrator);
    syncManager = SyncManager.getInstance(context, accountManager);

    // Register Language Model Tools for AI Agents / Copilot
    registerLanguageModelTools(context, accountManager, serverTreeProvider);

    // Subscribe to transfer completion events to refresh tree view
    context.subscriptions.push(transferManager.onDidUpdateSession((session) => {
        if (session.status === 'completed' || session.status === 'failed') {
            serverTreeProvider.refreshServer(session.serverIdentifier);
        }
    }));

    // Subscribe to file system changes to refresh tree view
    context.subscriptions.push(fileSystemProvider.onDidChangeFile((events) => {
        for (const event of events) {
            serverTreeProvider.refreshServer(event.uri.authority);
        }
    }));
    context.subscriptions.push(sftpFileSystemProvider.onDidChangeFile((events) => {
        for (const event of events) {
            serverTreeProvider.refreshServer(event.uri.authority);
        }
    }));

    // Register file system providers
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('ptero', fileSystemProvider, { isCaseSensitive: true }));
    context.subscriptions.push(vscode.workspace.registerFileSystemProvider('sftp', sftpFileSystemProvider, { isCaseSensitive: true }));

    // Register tree view with drag & drop support
    const treeView = vscode.window.createTreeView('pterodactylServers', {
        treeDataProvider: serverTreeProvider,
        dragAndDropController: new ServerTreeDragAndDropController(),
        canSelectMany: false,
    });
    context.subscriptions.push(treeView);

    context.subscriptions.push(treeView.onDidExpandElement(e => {
        if (e.element.nodeType === 'server' && e.element.server) {
            serverTreeProvider.setServerExpanded(e.element.server.uuid, true, e.element);
        }
    }));
    context.subscriptions.push(treeView.onDidCollapseElement(e => {
        if (e.element.nodeType === 'server' && e.element.server) {
            serverTreeProvider.setServerExpanded(e.element.server.uuid, false);
        }
    }));

    // Register decoration provider
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(remoteDecorationProvider));

    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.addAccount', () => openAddAccountForm()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.addSftpAccount', () => openAddSftpAccountForm()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.editAccount', (item?: any) => openEditAccountForm(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.removeAccount', (item?: any) => removeAccount(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.refreshServers', () => refreshServers()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.connectServer', (item?: any) => connectToServer(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.disconnectServer', (item?: any) => disconnectServer(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.reconnectServer', (item?: any) => reconnectServer(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.openTerminal', (item?: any) => openTerminal(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.openPanelWebView', (item?: any) => openPanelWebView(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.showTransferManager', () => transferManager.showDashboard()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.exportData', () => accountManager.exportAccounts()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.importData', () => accountManager.importAccounts()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.setupSshKey', () => setupSshKey()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.showSftpLog', () => Logger.show()));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.editConnectionFromExplorer', (item?: any) => openEditAccountForm(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.startServer', (item?: any) => sendPowerSignal(item, 'start')));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.restartServer', (item?: any) => sendPowerSignal(item, 'restart')));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.stopServer', (item?: any) => sendPowerSignal(item, 'stop')));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.killServer', (item?: any) => sendPowerSignal(item, 'kill')));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.initSyncConfig', (item?: any) => syncManager.initSyncConfigCommand(item)));
    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.downloadFromNode', async (target?: any) => {
        await downloadFromNode(target);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.decompressFile', async (target?: ServerTreeItem) => {
        if (!target || !target.account || !target.server || !target.path) {
            vscode.window.showErrorMessage('Invalid target for decompression.');
            return;
        }

        const account = target.account;
        if (account.type !== 'pterodactyl') return;
        const server = target.server;
        const filePath = target.path;

        const path = require('path');
        const directory = path.posix.dirname(filePath);
        const filename = path.posix.basename(filePath);

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Decompressing ${filename} server-side...`,
                cancellable: false
            }, async () => {
                const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                await client.decompressFile(server.uuid, directory, filename);
            });
            vscode.window.showInformationMessage(`Successfully decompressed ${filename}.`);
            serverTreeProvider.refresh();
        } catch (err: any) {
            Logger.error('Decompression failed', err);
            vscode.window.showErrorMessage(`Decompression failed: ${err.message || err}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.compressFile', async (target?: ServerTreeItem) => {
        if (!target || !target.account || !target.server || !target.path) {
            vscode.window.showErrorMessage('Invalid target for compression.');
            return;
        }

        const account = target.account;
        if (account.type !== 'pterodactyl') return;
        const server = target.server;
        const filePath = target.path;

        const path = require('path');
        const directory = path.posix.dirname(filePath);
        const filename = path.posix.basename(filePath);

        const archiveName = await vscode.window.showInputBox({
            prompt: 'Enter the name of the archive to create',
            value: `${filename}.tar.gz`,
            validateInput: (value) => value ? null : 'Archive name is required'
        });

        if (!archiveName) {
            return;
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Compressing to ${archiveName} server-side...`,
                cancellable: false
            }, async () => {
                const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                await client.compressFiles(server.uuid, directory, [filename]);
            });
            vscode.window.showInformationMessage(`Compression started for ${filename}.`);
            serverTreeProvider.refresh();
        } catch (err: any) {
            Logger.error('Compression failed', err);
            vscode.window.showErrorMessage(`Compression failed: ${err.message || err}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.uploadToNode', async (target?: any, uris?: vscode.Uri[]) => {
        if (!target || !target.account || !uris || uris.length === 0) return;
        const isPtero = target.account.type === 'pterodactyl';
        if (isPtero && !target.server) return;
        try {
            Logger.info(`Command: uploadToNode invoked for target account=${target.account?.id || target.account?.name} uris=${uris.map(u=>u.toString()).join(',')}`);
            const transferContext = await getTransferContext(target);
            Logger.debug(`Upload: obtained transfer context for server=${transferContext.serverIdentifier}`);
            const session = await transferOrchestrator.upload({
                localUris: uris,
                remoteDestinationPath: target.path || '/',
                sftpClient: transferContext.sftp,
                pteroClient: transferContext.ptero,
                serverIdentifier: transferContext.serverIdentifier,
            });
            Logger.info(`Upload: started session ${session.id} title="${session.title}" for server=${session.serverIdentifier}`);
        } catch (e: any) {
            Logger.error('Upload to node failed', e);
            vscode.window.showErrorMessage(`Upload failed: ${e.message || e}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.moveOnNode', async (target?: any, uris?: vscode.Uri[]) => {
        if (!target || !target.account || !uris || uris.length === 0) return;
        const isPtero = target.account.type === 'pterodactyl';
        if (isPtero && !target.server) return;
        try {
            Logger.info(`Command: moveOnNode invoked for target account=${target.account?.id || target.account?.name} uris=${uris.map(u=>u.toString()).join(',')}`);
            const transferContext = await getTransferContext(target);
            const sftp = transferContext.sftp;

            // Register a Move session with the TransferManager
            const transferManager = TransferManager.getInstance(extensionContext);
            const session = transferManager.registerSession({
                id: `move_${Date.now()}`,
                type: 'upload',
                serverIdentifier: transferContext.serverIdentifier,
                title: uris.length === 1 ? `Move ${require('path').basename(uris[0].path)}` : `Move ${uris.length} items`,
                mode: uris.length > 1 ? 'multi' : 'single',
                fileCountTotal: uris.length,
                fileCountCompleted: 0,
                bytesTotal: 0,
                bytesTransferred: 0,
                status: 'running',
                children: uris.map((uri, idx) => ({
                    id: `move_child_${Date.now()}_${idx}`,
                    label: `Move ${uri.path}`,
                    sourcePath: uri.path,
                    targetPath: `/${uri.path.split('/').filter(Boolean).pop() || ''}`,
                    bytesTotal: 0,
                    bytesTransferred: 0,
                    status: 'pending'
                })),
                createdAt: Date.now(),
                updatedAt: Date.now()
            });

            for (let i = 0; i < uris.length; i++) {
                const uri = uris[i];
                const child = session.children[i];
                transferManager.updateChildStatus(session.id, child.id, 'running');

                const sourcePath = uri.path || uri.fsPath || '';
                const base = sourcePath.split('/').filter(Boolean).pop() || '';
                const destPath = `/${base}`;
                Logger.debug(`MoveOnNode: renaming ${sourcePath} -> ${destPath} on ${transferContext.serverIdentifier}`);
                try {
                    await sftp.rename(sourcePath, destPath, { overwrite: true });
                    transferManager.completeChild(session.id, child.id, true);
                } catch (err: any) {
                    Logger.error(`MoveOnNode failed for ${sourcePath}`, err);
                    transferManager.completeChild(session.id, child.id, false, err.message || err);
                }
            }
        } catch (e: any) {
            Logger.error('MoveOnNode failed', e);
            vscode.window.showErrorMessage(`Move failed: ${e.message || e}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('pterodactyl.transferBetweenServers', async (target?: any, uris?: vscode.Uri[]) => {
        if (!target || !target.account || !uris || uris.length === 0) return;
        const isPtero = target.account.type === 'pterodactyl';
        if (isPtero && !target.server) return;

        try {
            Logger.info(`Command: transferBetweenServers invoked for target account=${target.account?.id} uris=${uris.map(u=>u.toString()).join(',')}`);
            const destContext = await getTransferContext(target);
            const destSftp = destContext.sftp;

            const transferManager = TransferManager.getInstance(extensionContext);
            const path = require('path');
            const fs = require('fs');
            const os = require('os');

            const session = transferManager.registerSession({
                id: `transfer_${Date.now()}`,
                type: 'upload',
                serverIdentifier: destContext.serverIdentifier,
                title: uris.length === 1 ? `Transfer ${path.basename(uris[0].path)}` : `Transfer ${uris.length} items`,
                mode: uris.length > 1 ? 'multi' : 'single',
                fileCountTotal: uris.length,
                fileCountCompleted: 0,
                bytesTotal: 0,
                bytesTransferred: 0,
                status: 'running',
                children: uris.map((uri, idx) => ({
                    id: `transfer_child_${Date.now()}_${idx}`,
                    label: `${path.basename(uri.path)} (${uri.authority} -> ${destContext.serverIdentifier})`,
                    sourcePath: uri.path,
                    targetPath: `/${path.basename(uri.path)}`,
                    bytesTotal: 0,
                    bytesTransferred: 0,
                    status: 'pending'
                })),
                createdAt: Date.now(),
                updatedAt: Date.now()
            });

            for (let i = 0; i < uris.length; i++) {
                const uri = uris[i];
                const child = session.children[i];
                transferManager.updateChildStatus(session.id, child.id, 'running');

                const sourcePath = uri.path || uri.fsPath || '';
                const base = sourcePath.split('/').filter(Boolean).pop() || '';
                const destPath = `/${base}`;

                const sourceConn = uri.scheme === 'ptero' ? fileSystemProvider.getConnection(uri.authority) : sftpFileSystemProvider.getConnection(uri.authority);
                if (!sourceConn) {
                    transferManager.completeChild(session.id, child.id, false, `Not connected to source server: ${uri.authority}`);
                    continue;
                }

                const tempFile = path.join(os.tmpdir(), `vsdactyl_transfer_${Date.now()}_${base}`);

                try {
                    // Download from source
                    const stat = await sourceConn.sftpClient.stat(sourcePath);
                    child.bytesTotal = stat.size;
                    session.bytesTotal += stat.size;
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

                    // Upload to destination
                    const localReadStream = fs.createReadStream(tempFile);
                    const remoteWriteStream = await destSftp.writeFileStream(destPath);
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
                    Logger.error(`Transfer failed for ${sourcePath}`, err);
                    transferManager.completeChild(session.id, child.id, false, err.message || err);
                } finally {
                    try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
                }
            }
        } catch (e: any) {
            Logger.error('TransferBetweenServers failed', e);
            vscode.window.showErrorMessage(`Transfer failed: ${e.message || e}`);
        }
    }));

    Logger.info('Extension activated.');
}

async function getTransferContext(target: any): Promise<{ sftp: SftpClient; ptero?: PterodactylClient; serverIdentifier: string }> {
    if (!target || !target.account) {
        throw new Error('Target must include account context');
    }

    const account = await accountManager.getAccountById(target.account.id);
    if (!account) {
        throw new Error('Account not found');
    }

    if (account.type === 'pterodactyl') {
        if (!target.server) {
            throw new Error('Target must include server context for panel accounts');
        }
        const ptero = new PterodactylClient(account.panelUrl, account.apiKey || '');
        const host = target.server.sftp_details.ip;
        const port = target.server.sftp_details.port || 2022;
        const username = `${account.username}.${target.server.identifier}`;

        // Try to reuse active connection from fileSystemProvider if registered
        let sftp: SftpClient | undefined;
        const existing = fileSystemProvider.getConnection(target.server.identifier);
        if (existing && existing.sftpClient.isConnected()) {
            sftp = existing.sftpClient;
        } else {
            let privateKey: string | undefined;
            if (account.sftpAuthMethod === 'ssh-key') {
                if (account.privateKeyPath) {
                    privateKey = require('fs').readFileSync(account.privateKeyPath, 'utf-8');
                } else {
                    privateKey = account.privateKeyData;
                }
            }
            const connInfo = {
                host,
                port,
                username,
                privateKey,
                password: account.sftpAuthMethod !== 'ssh-key' ? (account.password || undefined) : undefined,
            };
            sftp = new SftpClient(connInfo);
            await sftp.connect();
        }

        return {
            sftp,
            ptero,
            serverIdentifier: target.server.identifier,
        };
    } else {
        // standalone SFTP account
        let sftp: SftpClient | undefined;
        const existing = sftpFileSystemProvider.getConnection(account.id);
        if (existing && existing.sftpClient.isConnected()) {
            sftp = existing.sftpClient;
        } else {
            let privateKey: string | undefined;
            if (account.sftpAuthMethod === 'ssh-key') {
                if (account.privateKeyPath) {
                    privateKey = require('fs').readFileSync(account.privateKeyPath, 'utf-8');
                } else {
                    privateKey = account.privateKeyData;
                }
            }
            const connInfo = {
                host: account.host,
                port: account.port,
                username: account.username,
                privateKey,
                password: account.password || undefined,
            };
            sftp = new SftpClient(connInfo);
            await sftp.connect();
        }

        return {
            sftp,
            serverIdentifier: account.id,
        };
    }
}

async function downloadFromNode(target?: any): Promise<void> {
    if (!target || !target.account) {
        vscode.window.showWarningMessage('Select a connection node first to download files.');
        return;
    }
    const isPtero = target.account.type === 'pterodactyl';
    if (isPtero && !target.server) {
        vscode.window.showWarningMessage('Select a server node first to download files.');
        return;
    }

    const remoteSourcePath = await vscode.window.showInputBox({
        title: 'Download Folder From Node',
        prompt: 'Enter remote folder path to download as archive',
        value: target.path || '/',
        validateInput: (value) => value.trim().length === 0 ? 'Path is required' : null,
    });
    if (!remoteSourcePath) {
        return;
    }

    const localTarget = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        title: 'Select local destination folder',
        openLabel: 'Download here',
    });
    if (!localTarget || localTarget.length === 0) {
        return;
    }

    try {
        const transferContext = await getTransferContext(target);
        const archiveName = `vsdactyl-download-${Date.now().toString(36)}.tar.gz`;
        await transferOrchestrator.download({
            remoteSourcePath,
            remoteArchiveName: archiveName,
            localDestinationPath: localTarget[0].fsPath,
            sftpClient: transferContext.sftp,
            pteroClient: transferContext.ptero,
            serverIdentifier: transferContext.serverIdentifier,
        });
    } catch (e: any) {
        Logger.error('Download from node failed', e);
        vscode.window.showErrorMessage(`Download failed: ${e.message || e}`);
    }
}

async function openAddSftpAccountForm(): Promise<void> {
    SftpAccountFormPanel.show(extensionContext.extensionUri, async (accountData) => {
        if (!accountData) { return; }
        const account: SftpOnlyAccount = {
            id: accountManager.generateId(),
            ...accountData,
            branding: 'SansCraft Network Corp',
        };
        try {
            await accountManager.addAccount(account);
            vscode.window.showInformationMessage(`SFTP account "${account.name}" added successfully!`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`Failed to add SFTP account: ${e.message || e}`);
        }
    });
}

async function setupSshKey(): Promise<void> {
    const accounts = await accountManager.getAccounts();
    if (accounts.length === 0) {
        vscode.window.showErrorMessage('No accounts found. Please add an account first.');
        return;
    }

    // Select Account
    const picked = await vscode.window.showQuickPick(
        accounts.filter(a => a.type === 'pterodactyl').map(a => ({ label: a.name, description: (a as any).panelUrl, account: a })),
        { placeHolder: 'Select account to upload SSH Key to' }
    );
    if (!picked) return;
    const account = picked.account;

    // Get Key Name
    const keyName = await vscode.window.showInputBox({
        prompt: 'Enter a name for this SSH Key',
        value: 'VSCode Pterodactyl Key',
        validateInput: (value) => value ? null : 'Name is required'
    });
    if (!keyName) return;

    // Optional Passphrase
    const passphrase = await vscode.window.showInputBox({
        prompt: 'Enter a passphrase for the private key (Optional)',
        password: true,
        placeHolder: 'Leave empty for no passphrase'
    });

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Generating and Uploading SSH Key...',
            cancellable: false
        }, async (progress) => {
            progress.report({ message: 'Generating Ed25519 Key Pair...' });

            // 1. Generate Key
            const keyPair = SshKeyGenerator.generateEd25519KeyPair(passphrase); // Passphrase can be undefined/empty string

            progress.report({ message: 'Saving Private Key locally...' });

            // 2. Save Private Key
            const keyPath = await SshKeyGenerator.savePrivateKey(keyName, keyPair.privateKey);

            progress.report({ message: 'Uploading Public Key to Panel...' });

            // 3. Upload Public Key
            if (account.type !== 'pterodactyl') return;
            const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
            await client.createSshKey(keyName, keyPair.publicKey);

            vscode.window.showInformationMessage(`SSH Key "${keyName}" created! Private key saved to: ${keyPath}`);
        });
    } catch (err: any) {
        Logger.error('Failed to setup SSH key', err);
        vscode.window.showErrorMessage(`Failed to setup SSH Key: ${err.message}`);
    }
}

async function collectSftpAccountData(account?: SftpOnlyAccount): Promise<any> {
    return new Promise((resolve) => {
        SftpAccountFormPanel.show(extensionContext.extensionUri, (data: any) => {
            resolve(data);
        }, account);
    });
}


function openAddAccountForm(): void {
    AccountFormPanel.show(
        extensionContext.extensionUri,
        async (data: any) => { // Use any to allow createSshKey extra prop
            // Test connection
            const success = await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'Testing connection...',
                    cancellable: false,
                },
                async () => {
                    const client = new PterodactylClient(data.panelUrl, data.apiKey);
                    return client.testConnection();
                }
            );

            if (!success) {
                const proceed = await vscode.window.showWarningMessage(
                    'Could not connect to the panel. Save account anyway?',
                    'Save', 'Cancel'
                );
                if (proceed !== 'Save') { return; }
            }

            // Handle Auto SSH Key Setup
            if (data.createSshKey && data.sftpAuthMethod === 'ssh-key') {
                try {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: 'Generating and Uploading SSH Key...',
                        cancellable: false
                    }, async (progress) => {
                        // 1. Generate Key
                        const keyName = `VSCode_${data.name.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now().toString().slice(-4)}`;
                        progress.report({ message: 'Generating secure key pair...' });

                        const keyPair = SshKeyGenerator.generateEd25519KeyPair();

                        // 2. Save Locally
                        progress.report({ message: 'Saving private key...' });
                        const keyPath = await SshKeyGenerator.savePrivateKey(keyName, keyPair.privateKey);

                        // 3. Upload to Panel
                        progress.report({ message: 'Uploading to Panel...' });
                        const client = new PterodactylClient(data.panelUrl, data.apiKey);
                        await client.createSshKey(keyName, keyPair.publicKey);

                        // 4. Update Account Data with new key path
                        data.privateKeyPath = keyPath;
                        data.privateKeyData = ''; // Clear data if we are using path

                        vscode.window.showInformationMessage(`SSH Key generated and uploaded: ${keyName}`);
                    });
                } catch (err: any) {
                    vscode.window.showErrorMessage(`Failed to auto-setup SSH key: ${err.message}. Account not saved.`);
                    return;
                }
            }

            // Clean up extra props
            const accountData = { ...data };
            delete accountData.createSshKey;

            const account: PteroAccount = {
                id: accountManager.generateId(),
                ...accountData,
            };

            await accountManager.addAccount(account);
            vscode.window.showInformationMessage(`Account "${data.name}" added successfully!`);
        }
    );
}

async function openEditAccountForm(item?: ServerTreeItem): Promise<void> {
    let account: PteroAccount | undefined;

    if (item?.account) {
        account = item.account;
    } else {
        const accounts = await accountManager.getAccounts();
        if (accounts.length === 0) {
            vscode.window.showInformationMessage('No accounts to edit.');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            accounts.map(a => ({ label: a.name, description: a.type === 'pterodactyl' ? a.panelUrl : a.host, account: a })),
            { placeHolder: 'Select account to edit' }
        );
        if (!picked) { return; }
        account = picked.account;
    }

    if (!account) { return; }

    if (account.type === 'sftpOnly') {
        const updated = await collectSftpAccountData(account);
        if (!updated) { return; }

        await accountManager.editAccount(account.id, updated);
        vscode.window.showInformationMessage(`SFTP account "${updated.name}" updated successfully!`);
        return;
    }

    const editId = account.id;
    AccountFormPanel.show(
        extensionContext.extensionUri,
        async (data) => {
            await accountManager.editAccount(editId, data);
            vscode.window.showInformationMessage(`Account "${data.name}" updated successfully!`);
        },
        account
    );
}

async function removeAccount(item?: ServerTreeItem): Promise<void> {
    let account: PteroAccount | undefined;

    if (item?.account) {
        account = item.account;
    } else {
        const accounts = await accountManager.getAccounts();
        if (accounts.length === 0) {
            vscode.window.showInformationMessage('No accounts to remove.');
            return;
        }
        const picked = await vscode.window.showQuickPick(
            accounts.map(a => ({ label: a.name, description: a.type === 'pterodactyl' ? a.panelUrl : a.host, account: a })),
            { placeHolder: 'Select account to remove' }
        );
        if (!picked) { return; }
        account = picked.account;
    }

    if (!account) { return; }

    const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to remove account "${account.name}"?`,
        { modal: true },
        'Remove'
    );

    if (confirm === 'Remove') {
        await accountManager.removeAccount(account.id);
        vscode.window.showInformationMessage(`Account "${account.name}" removed.`);
    }
}

function refreshServers(): void {
    serverTreeProvider.clearCache();
    fileSystemProvider.clearCache();
    serverTreeProvider.refresh();
    vscode.window.showInformationMessage('Server list refreshed.');
}

async function connectToServer(item?: ServerTreeItem, silent: boolean = false): Promise<void> {
    try {
        if (!item?.account) {
            vscode.window.showErrorMessage('Please select an account or server from the tree to connect.');
            return;
        }

        const account = item.account;

        if (account.type === 'sftpOnly') {
            Logger.info(`SFTP Connect (Standalone): ${account.name} -> ${account.host}:${account.port}`);
            try {
                sftpFileSystemProvider.registerConnection(account);
            } catch (err: any) {
                Logger.error('Failed to register SFTP connection', err);
                vscode.window.showErrorMessage(`Failed to initialize connection: ${err.message}`);
                return;
            }

            const uri = vscode.Uri.parse(`sftp://${account.id}/`);
            const folderName = `🦕 ${account.name}`;

            const existingFolder = vscode.workspace.workspaceFolders?.find(
                f => f.uri.scheme === 'sftp' && f.uri.authority === account.id
            );

            if (existingFolder) {
                vscode.window.showInformationMessage(`Already connected to "${account.name}".`);
                vscode.commands.executeCommand('revealInExplorer', uri);
                return;
            }

            vscode.workspace.updateWorkspaceFolders(
                vscode.workspace.workspaceFolders?.length || 0,
                0,
                { uri, name: folderName }
            );

            if (!silent) {
                vscode.window.showInformationMessage(`Connected to "${account.name}".`);
            }
            return;
        }

        if (!item.server) {
            vscode.window.showErrorMessage('Please select a server from the tree to connect.');
            return;
        }

        const server = item.server;
        Logger.info(`Connecting to server: ${server.name} (${server.identifier})`);

        if (server.is_suspended) {
            vscode.window.showErrorMessage(`Server "${server.name}" is suspended and cannot be accessed.`);
            return;
        }

        if (server.is_installing) {
            vscode.window.showWarningMessage(`Server "${server.name}" is still installing.`);
            return;
        }

        // Get SFTP connection details from server
        const sftpHost = server.sftp_details.ip;
        const sftpPort = server.sftp_details.port || 2022;

        Logger.info(`SFTP Connect: ${server.name} -> ${sftpHost}:${sftpPort}`);

        if (!sftpHost) {
            vscode.window.showErrorMessage(`No SFTP host found for server "${server.name}". Check console for details.`);
            return;
        }

        // Register the SFTP connection
        try {
            fileSystemProvider.registerConnection(
                server.identifier,
                account,
                server.name,
                sftpHost,
                sftpPort
            );
        } catch (err: any) {
            Logger.error('Failed to register SFTP connection', err);
            vscode.window.showErrorMessage(`Failed to initialize connection: ${err.message}`);
            return;
        }

        // Create the ptero:// URI and add as workspace folder
        const uri = vscode.Uri.parse(`ptero://${server.identifier}/`);
        const folderName = `🦕 ${server.name}`;

        // Check if already added
        const existingFolder = vscode.workspace.workspaceFolders?.find(
            f => f.uri.scheme === 'ptero' && f.uri.authority === server.identifier
        );

        if (existingFolder) {
            vscode.window.showInformationMessage(`Already connected to "${server.name}".`);
            vscode.commands.executeCommand('revealInExplorer', uri);
            return;
        }

        const added = vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length || 0,
            0,
            { uri, name: folderName }
        );

        if (added) {
            if (!silent) {
                vscode.window.showInformationMessage(
                    `Connected to "${server.name}" via SFTP (${sftpHost}:${sftpPort})! Browse files in the Explorer.`
                );
            }
        } else {
            Logger.warn(`Failed to add workspace folder for ${server.name}`);
            vscode.window.showErrorMessage(`Failed to connect to "${server.name}".`);
        }
    } catch (err: any) {
        Logger.error('Critical error in connectToServer', err);
        vscode.window.showErrorMessage(`An error occurred while connecting: ${err.message}`);
    }
}

async function disconnectServer(item?: ServerTreeItem): Promise<void> {
    let identifier: string | undefined;
    let serverName: string = '';
    let scheme: string = 'ptero';

    if (item?.account?.type === 'sftpOnly') {
        identifier = item.account.id;
        serverName = item.account.name;
        scheme = 'sftp';
    } else if (item?.server) {
        identifier = item.server.identifier;
        serverName = item.server.name;
    } else {
        // Find active connection from workspace
        const folders = vscode.workspace.workspaceFolders?.filter(f => f.uri.scheme === 'ptero' || f.uri.scheme === 'sftp') || [];
        if (folders.length === 0) {
            vscode.window.showErrorMessage('No server connected.');
            return;
        }

        if (folders.length === 1) {
            identifier = folders[0].uri.authority;
            serverName = folders[0].name.replace('🦕 ', '');
            scheme = folders[0].uri.scheme;
        } else {
            const picked = await vscode.window.showQuickPick(
                folders.map(f => ({ label: f.name, description: f.uri.authority, uri: f.uri })),
                { placeHolder: 'Select server to disconnect' }
            );
            if (!picked) return;
            identifier = picked.description;
            serverName = picked.label.replace('🦕 ', '');
            scheme = picked.uri.scheme;
        }
    }

    if (!identifier) return;

    if (scheme === 'sftp') {
        await sftpFileSystemProvider.disconnectServer(identifier);
    } else {
        await fileSystemProvider.disconnectServer(identifier);
    }

    // Remove from workspace
    const index = vscode.workspace.workspaceFolders?.findIndex(
        f => f.uri.scheme === scheme && f.uri.authority === identifier
    );

    if (index !== undefined && index !== -1) {
        vscode.workspace.updateWorkspaceFolders(index, 1);
        vscode.window.showInformationMessage(`Disconnected from "${serverName}".`);
    } else {
        vscode.window.showWarningMessage(`Server "${serverName}" was not connected in the workspace.`);
    }
}

async function reconnectServer(item?: ServerTreeItem): Promise<void> {
    let identifier: string | undefined;
    let serverName: string = '';
    let scheme: 'ptero' | 'sftp' = 'ptero';

    // If called from tree view
    if (item?.account?.type === 'sftpOnly') {
        identifier = item.account.id;
        serverName = item.account.name;
        scheme = 'sftp';
    } else if (item?.server && item?.account) {
        identifier = item.server.identifier;
        serverName = item.server.name;
    } else {
        // Called from command palette
        const folders = vscode.workspace.workspaceFolders?.filter(
            f => f.uri.scheme === 'ptero' || f.uri.scheme === 'sftp'
        ) || [];
        if (folders.length === 0) {
            vscode.window.showErrorMessage('No server connected to reconnect.');
            return;
        }

        let targetFolder: vscode.WorkspaceFolder;
        if (folders.length === 1) {
            targetFolder = folders[0];
        } else {
            const picked = await vscode.window.showQuickPick(
                folders.map(f => ({ label: f.name, description: f.uri.authority, folder: f })),
                { placeHolder: 'Select server to reconnect' }
            );
            if (!picked) return;
            targetFolder = picked.folder;
        }

        identifier = targetFolder.uri.authority;
        serverName = targetFolder.name.replace('🦕 ', '');
        scheme = targetFolder.uri.scheme === 'sftp' ? 'sftp' : 'ptero';
    }

    if (!identifier) return;

    Logger.info(`Reconnecting to ${serverName} (${identifier})...`);

    try {
        if (scheme === 'sftp') {
            await sftpFileSystemProvider.reconnect(identifier);
        } else {
            await fileSystemProvider.reconnect(identifier);
        }
        vscode.window.showInformationMessage(`Reconnected to "${serverName}" successfully.`);
    } catch (err: any) {
        if (scheme === 'sftp' && err.message.includes('No active connection')) {
            const account = await accountManager.getAccountById(identifier);
            if (account && account.type === 'sftpOnly') {
                sftpFileSystemProvider.registerConnection(account);
                vscode.window.showInformationMessage(`Reconnected to "${serverName}" successfully.`);
                return;
            }
            vscode.window.showErrorMessage(`Could not reconnect: SFTP account not found for "${serverName}".`);
            return;
        }

        // If no active connection found (e.g. after reload), try to find server in tree
        if (err.message.includes('No active connection')) {
            Logger.info(`No active connection state for ${identifier}, attempting to discover from tree...`);

            // Try to find the server
            let treeItem = await serverTreeProvider.findServer(identifier);

            if (!treeItem) {
                // Try refreshing if not found (maybe first load)
                serverTreeProvider.refresh();
                // small delay for refresh? findServer actually triggers fetch if needed for accounts
                // But wait, findServer iterates accounts.
                // let's try finding again just in case async timing
            }

            // findServer implementation already fetches if not in cache! 
            // So if it returns undefined, it's really not found.

            if (treeItem) {
                await connectToServer(treeItem);
                return;
            } else {
                Logger.error(`Could not find server ${identifier} in any configured account.`);
                vscode.window.showErrorMessage(`Could not reconnect: Server not found in your accounts. Please check your configuration.`);
            }
        } else {
            Logger.error('Failed to reconnect', err);
            vscode.window.showErrorMessage(`Failed to reconnect to "${serverName}": ${err.message}`);
        }
    }
}

async function openTerminal(item?: ServerTreeItem): Promise<void> {
    if (!item?.server || !item?.account) {
        vscode.window.showErrorMessage('Please select a server to open terminal.');
        return;
    }

    if (item.account.type !== 'pterodactyl') {
        vscode.window.showErrorMessage('Open Terminal is only available for panel-backed servers.');
        return;
    }

    const server = item.server;
    const client = new PterodactylClient(item.account.panelUrl, item.account.apiKey || '');

    try {
        await terminalManager.openTerminal(
            server.identifier,
            server.name,
            server.uuid,
            client
        );
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to open terminal: ${err.message}`);
    }
}

async function handleOpenPanelFile(filePath: string, fileName: string, item: ServerTreeItem): Promise<void> {
    if (!item.account || item.account.type !== 'pterodactyl') {
        throw new Error('Invalid account type');
    }

    // Create a URI using the ptero scheme so it integrates with our file explorer
    const fileUri = vscode.Uri.parse(`ptero://${item.account.id}/${item.server?.identifier}/file${filePath}`);
    
    try {
        const doc = await vscode.workspace.openTextDocument(fileUri);
        await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err: any) {
        // If direct opening fails, try to use the transfer manager to download the file temporarily
        console.warn('[VSDactyl] Could not open file via ptero scheme, attempting alternative method:', err.message);
        
        // Show an info message
        vscode.window.showInformationMessage(
            `File opening via VS Code explorer requires Auto-Sync setup. Would you like to set up Auto-Sync for ${item.server?.name}?`,
            'Setup Auto-Sync'
        ).then(choice => {
            if (choice === 'Setup Auto-Sync') {
                // Trigger the Auto-Sync setup command
                vscode.commands.executeCommand('vsdactyl.initSync', item);
            }
        });
    }
}

async function openPanelWebView(item?: ServerTreeItem): Promise<void> {
    if (!item?.server || !item?.account) {
        vscode.window.showErrorMessage('Please select a server from the tree to open in Web View.');
        return;
    }

    if (item.account.type !== 'pterodactyl') {
        vscode.window.showErrorMessage('Web View is only available for panel-backed servers.');
        return;
    }

    const serverUrl = await PanelProxy.getProxyUrl(item.account.panelUrl, item.server.identifier);
    
    // Get stored credentials if auto-login is enabled
    let username = item.account.username || '';
    let password = '';
    let shouldAutoLogin = item.account.panelAutoLogin || false;
    
    if (shouldAutoLogin && item.account.panelPassword) {
        password = item.account.panelPassword;
    }

    const panel = vscode.window.createWebviewPanel(
        'pterodactylPanel',
        `Pterodactyl: ${item.server.name}`,
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === 'openPanelFile') {
            console.log('[VSDactyl Debug] Webview requested file open:', message.data);
            const { filePath, fileName } = message.data;
            try {
                await handleOpenPanelFile(filePath, fileName, item);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
            }
        } else if (message.command === 'getProxyHost') {
            try {
                console.log('[VSDactyl Debug] Webview requested proxy host for:', message.url);
                const host = await PanelProxy.getProxyHostFor(message.url);
                console.log('[VSDactyl Debug] Returning proxy host:', host, 'for', message.url);
                panel.webview.postMessage({ command: 'proxyHost', host, forUrl: message.url });
            } catch (e: any) {
                console.error('[VSDactyl Debug] Failed to create proxy host for', message.url, e?.message);
                panel.webview.postMessage({ command: 'proxyHost', error: e.message, forUrl: message.url });
            }
        } else if (message.command === 'openExternal') {
            try {
                const url = message.url;
                if (url) {
                    vscode.env.openExternal(vscode.Uri.parse(url));
                }
            } catch (e: any) {
                console.error('[VSDactyl Debug] Failed to open external URL:', e?.message);
            }
        }
    });

    const credentialsJson = JSON.stringify({ username, password, shouldAutoLogin });

    panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Pterodactyl Panel</title>
            <style>
                body, html {
                    margin: 0;
                    padding: 0;
                    height: 100%;
                    overflow: hidden;
                    background-color: var(--vscode-editor-background);
                }
                iframe {
                    width: 100%;
                    height: 100%;
                    border: none;
                }
                .fallback-notice {
                    position: absolute;
                    top: 10px;
                    left: 50%;
                    transform: translateX(-50%);
                    background: rgba(0,0,0,0.7);
                    color: white;
                    padding: 8px 16px;
                    border-radius: 4px;
                    font-family: var(--vscode-font-family);
                    font-size: 13px;
                    z-index: 10;
                    opacity: 0.8;
                    pointer-events: none;
                    transition: opacity 2s;
                }
            </style>
        </head>
        <body>
            <div class="fallback-notice" id="notice">
                Loading panel...
                <button id="external-auth" style="margin-left:12px; display:none;">Open in external browser</button>
            </div>
            <iframe src="${serverUrl}" id="panel-frame" allow="clipboard-read; clipboard-write;"></iframe>
            <script>
                const vscode = acquireVsCodeApi();
                const notice = document.getElementById('notice');
                const frame = document.getElementById('panel-frame');
                const credentials = ${credentialsJson};
                const panelOrigin = ${JSON.stringify(new URL(item.account.panelUrl).origin)};
                
                let loaded = false;
                let contextMenu = null;
                let navigationMonitor = null;
                let lastRequestedProxyUrl = null;

                function isExternalUrl(targetUrl) {
                    try {
                        return new URL(targetUrl, panelOrigin).origin !== panelOrigin;
                    } catch (e) {
                        console.warn('[VSDactyl Debug] Failed to evaluate URL origin:', targetUrl, e.message);
                        return false;
                    }
                }

                function requestProxyForUrl(targetUrl, reason) {
                    if (!targetUrl) {
                        return;
                    }

                    if (targetUrl === lastRequestedProxyUrl) {
                        return;
                    }

                    lastRequestedProxyUrl = targetUrl;
                    console.log('[VSDactyl Debug] Requesting proxy for', reason, targetUrl);
                    vscode.postMessage({ command: 'getProxyHost', url: targetUrl });
                }

                function startNavigationMonitor() {
                    if (navigationMonitor) {
                        clearInterval(navigationMonitor);
                    }

                    navigationMonitor = setInterval(() => {
                        try {
                            const currentUrl = frame.contentWindow.location.href;
                            if (currentUrl && isExternalUrl(currentUrl)) {
                                console.log('[VSDactyl Debug] External navigation detected via currentUrl:', currentUrl);
                                requestProxyForUrl(currentUrl, 'navigation monitor');
                            }
                        } catch (e) {
                            const src = frame.src;
                            if (src && isExternalUrl(src)) {
                                console.log('[VSDactyl Debug] Cross-origin iframe detected via src:', src);
                                requestProxyForUrl(src, 'cross-origin iframe');
                            }
                        }
                    }, 500);
                }

                function injectNavigationInterceptor() {
                    try {
                        const doc = frame.contentDocument;
                        if (!doc) {
                            console.log('[VSDactyl Debug] Cannot inject interceptor - cross-origin or doc not accessible');
                            return;
                        }

                        // Create a script that will intercept navigation
                        const script = doc.createElement('script');
                        script.textContent = \`
                            (function() {
                                const panelOrigin = ${JSON.stringify(new URL(item.account.panelUrl).origin)};
                                let navigationInProgress = false;

                                function isExternalUrl(url) {
                                    try {
                                        const parsed = new URL(url, window.location.href);
                                        return parsed.origin !== panelOrigin;
                                    } catch (e) {
                                        return false;
                                    }
                                }

                                function handleExternalNavigation(url, source) {
                                    if (navigationInProgress) return;
                                    if (!isExternalUrl(url)) return;

                                    navigationInProgress = true;
                                    console.log('[VSDactyl Interceptor] External navigation detected via ' + source + ':', url);
                                    
                                    // Send message to parent frame to request proxy
                                    window.parent.postMessage({
                                        command: 'requestProxy',
                                        url: url,
                                        source: source
                                    }, '*');

                                    // Prevent the navigation from happening
                                    return false;
                                }

                                // Hook location.href setter
                                const locationDescriptor = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
                                if (locationDescriptor) {
                                    const originalSetter = locationDescriptor.set;
                                    Object.defineProperty(Location.prototype, 'href', {
                                        get: locationDescriptor.get,
                                        set: function(url) {
                                            if (handleExternalNavigation(url, 'location.href')) {
                                                return;
                                            }
                                            return originalSetter.call(this, url);
                                        }
                                    });
                                }

                                // Hook location.assign()
                                const originalAssign = Location.prototype.assign;
                                Location.prototype.assign = function(url) {
                                    if (handleExternalNavigation(url, 'location.assign')) {
                                        return;
                                    }
                                    return originalAssign.call(this, url);
                                };

                                // Hook location.replace()
                                const originalReplace = Location.prototype.replace;
                                Location.prototype.replace = function(url) {
                                    if (handleExternalNavigation(url, 'location.replace')) {
                                        return;
                                    }
                                    return originalReplace.call(this, url);
                                };

                                // Hook window.open()
                                const originalOpen = window.open;
                                window.open = function(url, target, features) {
                                    if (url && handleExternalNavigation(url, 'window.open')) {
                                        return;
                                    }
                                    return originalOpen.apply(window, arguments);
                                };

                                // Intercept clicks on links and buttons
                                document.addEventListener('click', function(e) {
                                    const target = e.target;
                                    
                                    // Check if it's a link
                                    const link = target.closest('a[href]');
                                    if (link && link.href) {
                                        if (isExternalUrl(link.href)) {
                                            console.log('[VSDactyl Interceptor] External link click detected:', link.href);
                                            e.preventDefault();
                                            e.stopPropagation();
                                            handleExternalNavigation(link.href, 'link click');
                                            return false;
                                        }
                                    }

                                    // Check if it's a button with onclick or data handler
                                    const button = target.closest('button');
                                    if (button) {
                                        // Check for onclick attribute
                                        const onclick = button.getAttribute('onclick');
                                        if (onclick && (onclick.includes('location') || onclick.includes('window.open'))) {
                                            console.log('[VSDactyl Interceptor] Button with navigation onclick detected');
                                        }
                                    }
                                }, true);

                                // Hook fetch to detect redirects
                                const originalFetch = window.fetch;
                                window.fetch = function(...args) {
                                    const url = args[0] instanceof Request ? args[0].url : args[0];
                                    if (typeof url === 'string' && isExternalUrl(url)) {
                                        console.log('[VSDactyl Interceptor] Fetch to external URL detected:', url);
                                        window.parent.postMessage({
                                            command: 'requestProxy',
                                            url: url,
                                            source: 'fetch'
                                        }, '*');
                                    }
                                    return originalFetch.apply(window, args);
                                };

                                // Hook XMLHttpRequest
                                const originalXHROpen = XMLHttpRequest.prototype.open;
                                XMLHttpRequest.prototype.open = function(method, url) {
                                    if (typeof url === 'string' && isExternalUrl(url)) {
                                        console.log('[VSDactyl Interceptor] XHR to external URL detected:', url, 'method:', method);
                                        window.parent.postMessage({
                                            command: 'requestProxy',
                                            url: url,
                                            source: 'xhr'
                                        }, '*');
                                    }
                                    return originalXHROpen.apply(this, arguments);
                                };

                                // Monitor for form submissions to external URLs
                                document.addEventListener('submit', function(e) {
                                    const form = e.target;
                                    let action = form.action || window.location.href;
                                    if (isExternalUrl(action)) {
                                        console.log('[VSDactyl Interceptor] Form submission to external URL detected:', action);
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleExternalNavigation(action, 'form submission');
                                        return false;
                                    }
                                }, true);

                                console.log('[VSDactyl Interceptor] Navigation interceptor installed successfully');
                            })();
                        \`;
                        
                        doc.head.appendChild(script);
                        console.log('[VSDactyl Debug] Injected navigation interceptor script');
                    } catch (err) {
                        console.warn('[VSDactyl Debug] Failed to inject navigation interceptor:', err?.message);
                    }
                }


                // Listen for messages from both the iframe and the extension
                window.addEventListener('message', (event) => {
                    const msg = event.data;

                    // Forward iframe requests for proxying to the extension
                    if (msg && msg.command === 'requestProxy' && msg.url) {
                        try {
                            console.log('[VSDactyl Debug] Forwarding proxy request to extension for:', msg.url);
                            requestProxyForUrl(msg.url, 'iframe requestProxy message');
                            notice.innerHTML = '🔗 Requesting proxy for external authentication...';
                            notice.style.background = 'rgba(36, 232, 245, 0.2)';
                        } catch (e) {
                            console.error('[VSDactyl Debug] Failed to forward requestProxy to extension:', e.message);
                        }
                        return;
                    }

                    // Handle responses from the extension containing the proxy host
                    if (msg && msg.command === 'proxyHost' && msg.forUrl) {
                        if (msg.error) {
                            console.error('[VSDactyl Debug] Proxy host error:', msg.error);
                            notice.innerHTML = '<b>Error:</b> Could not proxy external authentication domain.';
                            notice.style.background = 'rgba(255, 71, 87, 0.9)';
                            return;
                        }

                        try {
                            // Use the URL the extension requested proxy for (safe across origins)
                            const target = msg.forUrl || frame.src;
                            const u = new URL(target);
                            const proxied = msg.host + u.pathname + u.search + u.hash;
                            console.log('[VSDactyl Debug] Switching iframe to proxied auth URL:', proxied);
                            lastRequestedProxyUrl = null;
                            frame.src = proxied;
                            notice.innerHTML = '🔗 Proxying external authentication...';
                            notice.style.background = 'rgba(36, 232, 245, 0.2)';
                        } catch (e) {
                            console.error('[VSDactyl Debug] Failed to set proxied URL:', e.message);
                        }
                    }
                });
                
                // Detect common custom authentication flows
                function detectCustomAuthFlow(pageUrl) {
                    try {
                        const url = new URL(pageUrl);
                        const hostname = url.hostname;
                        const pathname = url.pathname.toLowerCase();
                        
                        // Common SSO/OAuth patterns
                        const ssoPatterns = [
                            /oauth|openid|saml|sso|login\.microsoftonline|accounts\.google|auth0|okta|adfs/i,
                            /\/auth\/|\/login\/|\/account\/|\/signin\//i,
                            /code=|id_token=|assertion=|response_type=|redirect_uri=|client_id=/i // OAuth/SAML response codes and OIDC params
                        ];
                        
                        for (const pattern of ssoPatterns) {
                            if (pattern.test(pathname) || pattern.test(url.search)) {
                                return true;
                            }
                        }
                        
                        // Check for external domain redirects (different from panel domain)
                        const panelUrl = '${serverUrl}';
                        const panelDomain = new URL(panelUrl).hostname;
                        if (hostname !== panelDomain && !hostname.includes(panelDomain.split('.').pop())) {
                            console.log('[VSDactyl Debug] External auth domain detected:', hostname);
                            return true;
                        }
                    } catch (e) {
                        console.error('[VSDactyl Debug] Error detecting auth flow:', e.message);
                    }
                    return false;
                }

                // If we can access the iframe DOM (same-origin), observe for password inputs/forms
                function observeFrameForForms() {
                    try {
                        const doc = frame.contentDocument;
                        if (!doc) return;

                        const checkForAuthElements = () => {
                            const pwd = doc.querySelector('input[type=password]');
                            if (pwd) {
                                try {
                                    const form = pwd.closest('form');
                                    const action = form ? (form.action || frame.contentWindow.location.href) : frame.contentWindow.location.href;
                                    if (action && isExternalUrl(action)) {
                                        requestProxyForUrl(action, 'detected password input');
                                    }
                                } catch (e) {
                                    // ignore
                                }
                            }
                        };

                        const mo = new MutationObserver(() => checkForAuthElements());
                        mo.observe(doc, { childList: true, subtree: true, attributes: true });
                        // initial check
                        checkForAuthElements();
                    } catch (e) {
                        // cross-origin or inaccessible
                    }
                }
                
                frame.onload = () => {
                    loaded = true;
                    console.log('[VSDactyl Debug] Iframe loaded successfully.', frame.src);
                    startNavigationMonitor();

                    // Detect custom authentication systems
                    let pageUrl = frame.src;
                    try {
                        // Try to read full location; may throw on cross-origin navigations
                        pageUrl = frame.contentWindow.location.href || frame.src;
                    } catch (e) {
                        // Cross-origin - fallback to frame.src which is safe to read
                        pageUrl = frame.src;
                    }
                    const isCustomAuthFlow = detectCustomAuthFlow(pageUrl);
                    console.log('[VSDactyl Debug] Panel page URL:', pageUrl);
                    console.log('[VSDactyl Debug] Auto-login enabled:', credentials.shouldAutoLogin);
                    console.log('[VSDactyl Debug] Custom auth detected:', isCustomAuthFlow);

                    if (isCustomAuthFlow) {
                        notice.innerHTML = '🔐 Custom authentication detected. Preparing proxy...';
                        notice.style.background = 'rgba(36, 232, 245, 0.2)';
                        notice.style.display = 'block';
                        console.log('[VSDactyl Debug] Custom authentication flow detected at:', pageUrl);

                        // Request the extension to provide a proxy host for this external auth domain
                        try {
                            requestProxyForUrl(pageUrl, 'custom auth detection');
                            // Show fallback external browser button in case proxying fails
                            const externalBtn = document.getElementById('external-auth');
                            if (externalBtn) {
                                externalBtn.style.display = 'inline-block';
                                externalBtn.onclick = () => {
                                    vscode.postMessage({ command: 'openExternal', url: pageUrl });
                                };
                            }
                        } catch (e) {
                            console.error('[VSDactyl Debug] Could not request proxy host:', e.message);
                        }
                    } else if (!credentials.shouldAutoLogin) {
                        notice.innerHTML = '🔐 Manual authentication mode. Please log in, your session will be preserved.';
                        notice.style.background = 'rgba(36, 232, 245, 0.2)';
                        notice.style.display = 'block';
                        console.log('[VSDactyl Debug] Auto-login disabled - manual authentication expected');
                    } else {
                        notice.style.display = 'none';
                    }

                    // Inject navigation interceptor into iframe
                    injectNavigationInterceptor();

                    // Inject right-click handler into iframe
                    setupPanelContextMenu();

                    // Observe frame DOM for forms/password inputs if same-origin
                    observeFrameForForms();

                    // Auto-fill credentials if available and enabled
                    if (credentials.username || credentials.password) {
                        try {
                            console.log('[VSDactyl Debug] Attempting auto-fill login after iframe load');
                            setTimeout(() => autofillLogin(credentials), 500);
                        } catch (e) {
                            console.warn('[VSDactyl Debug] Could not auto-fill login:', e.message);
                        }
                    }
                };

                frame.onerror = (e) => {
                    console.error('[VSDactyl Debug] Iframe error event fired:', e);
                    notice.innerHTML = "<b>Network Error:</b> Failed to reach the panel URL. Check Developer Tools.";
                    notice.style.background = 'rgba(255, 71, 87, 0.9)';
                };

                setTimeout(() => {
                    if (!loaded) {
                        console.warn('[VSDactyl Debug] Iframe took too long to load.');
                        notice.innerHTML = "<b>Timeout:</b> The panel is taking too long to respond.<br>Check VS Code Developer Tools.";
                        console.warn('[VSDactyl Debug] Current iframe src at timeout:', frame.src);
                    }
                }, 5000);

                function setupPanelContextMenu() {
                    try {
                        const doc = frame.contentDocument;
                        if (!doc) return;
                        
                        // Create context menu style
                        const style = doc.createElement('style');
                        style.textContent = \`
                            .vsdactyl-context-menu {
                                position: fixed;
                                background: var(--vscode-menu-background, #252526);
                                border: 1px solid var(--vscode-menu-border, #3e3e42);
                                border-radius: 4px;
                                padding: 4px 0;
                                min-width: 200px;
                                z-index: 10000;
                                box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                                display: none;
                            }
                            .vsdactyl-context-menu.visible {
                                display: block;
                            }
                            .vsdactyl-menu-item {
                                padding: 8px 12px;
                                cursor: pointer;
                                color: var(--vscode-menu-foreground, #cccccc);
                                white-space: nowrap;
                                user-select: none;
                            }
                            .vsdactyl-menu-item:hover {
                                background: var(--vscode-menu-selectionBackground, #094771);
                            }
                            .vsdactyl-menu-icon {
                                margin-right: 8px;
                                display: inline-block;
                                width: 16px;
                                text-align: center;
                            }
                        \`;
                        doc.head.appendChild(style);
                        
                        // Create context menu element
                        contextMenu = doc.createElement('div');
                        contextMenu.className = 'vsdactyl-context-menu';
                        contextMenu.innerHTML = \`
                            <div class="vsdactyl-menu-item" data-action="open-in-vscode">
                                <span class="vsdactyl-menu-icon">📝</span>Open in VS Code
                            </div>
                            <div class="vsdactyl-menu-item" data-action="copy-path">
                                <span class="vsdactyl-menu-icon">📋</span>Copy Path
                            </div>
                        \`;
                        doc.body.appendChild(contextMenu);
                        
                        let selectedFile = null;
                        
                        // Handle right-click on the whole document
                        doc.addEventListener('contextmenu', (e) => {
                            const target = e.target;
                            
                            // Look for file elements - check various Pterodactyl class patterns
                            const fileRow = target.closest('[data-name], .file-entry, .file-row, [role="row"]');
                            const fileName = fileRow?.getAttribute('data-name') || 
                                           fileRow?.innerText?.split('\\n')[0]?.trim() ||
                                           target.textContent?.trim();
                            
                            if (fileRow && fileName && fileName.length > 0) {
                                e.preventDefault();

                                doc.addEventListener('click', (e) => {
                                    try {
                                        const target = e.target;
                                        const anchor = target && target.closest ? target.closest('a[href]') : null;
                                        if (anchor) {
                                            console.log('[VSDactyl Debug] Clicked anchor:', anchor.href);
                                        }
                                    } catch (err) {
                                        console.warn('[VSDactyl Debug] Failed to inspect click target:', err?.message);
                                    }
                                }, true);
                                selectedFile = {
                                    name: fileName,
                                    element: fileRow,
                                    path: extractFilePath(fileRow, fileName)
                                };
                                
                                contextMenu.style.left = e.clientX + 'px';
                                contextMenu.style.top = e.clientY + 'px';
                                contextMenu.classList.add('visible');
                            } else {
                                hideContextMenu();
                            }
                                                        console.log('[VSDactyl Debug] External navigation detected, requesting proxy:', hrefUrl.href);
                        });

                        // Intercept clicks and form submissions to detect external auth navigations
                        doc.addEventListener('click', (e) => {
                                                    console.warn('[VSDactyl Debug] Failed to parse anchor URL:', href, err?.message);
                                const anchor = e.target.closest && e.target.closest('a[href]');
                                if (anchor) {
                                    const href = anchor.href;
                                    if (href) {
                                        console.warn('[VSDactyl Debug] Click interception failed:', err?.message);
                                            const hrefUrl = new URL(href, location.href);
                                            if (hrefUrl.origin !== location.origin) {
                                                // External navigation detected - request proxy from parent
                                                e.preventDefault();
                                                window.parent.postMessage({ command: 'requestProxy', url: hrefUrl.href }, '*');
                                            }
                                        } catch (err) {
                                            // ignore parse errors
                                        }
                                    }
                                }
                                                    console.log('[VSDactyl Debug] External form submission detected, requesting proxy:', actionUrl.href);
                            } catch (err) {
                                // ignore
                            }
                        }, true);
                                                console.warn('[VSDactyl Debug] Failed to parse form action URL:', action, err?.message);
                        doc.addEventListener('submit', (e) => {
                            try {
                                const form = e.target;
                                        console.warn('[VSDactyl Debug] Submit interception failed:', err?.message);
                                if (action) {
                                    try {
                                        const actionUrl = new URL(action, location.href);
                                        if (actionUrl.origin !== location.origin) {
                                            e.preventDefault();
                                            window.parent.postMessage({ command: 'requestProxy', url: actionUrl.href }, '*');
                                        }
                                    } catch (err) {
                                        // ignore
                                    }
                                }
                            } catch (err) {
                                // ignore
                            }
                        }, true);
                        
                        // Handle menu item clicks
                        contextMenu.addEventListener('click', (e) => {
                            const action = e.target.closest('[data-action]')?.getAttribute('data-action');
                            if (action && selectedFile) {
                                if (action === 'open-in-vscode') {
                                    window.parent.postMessage({
                                        command: 'openPanelFile',
                                        data: { filePath: selectedFile.path, fileName: selectedFile.name }
                                    }, '*');
                                } else if (action === 'copy-path') {
                                    navigator.clipboard.writeText(selectedFile.path).catch(err => {
                                        console.warn('[VSDactyl] Could not copy to clipboard:', err);
                                    });
                                }
                                hideContextMenu();
                            }
                        });
                        
                        // Hide menu when clicking elsewhere
                        doc.addEventListener('click', () => hideContextMenu());
                        doc.addEventListener('keydown', (e) => {
                            if (e.key === 'Escape') hideContextMenu();
                        });
                        
                        function hideContextMenu() {
                            contextMenu?.classList.remove('visible');
                            selectedFile = null;
                        }
                        
                        function extractFilePath(element, fileName) {
                            // Try to extract the full path from breadcrumbs or data attributes
                            let path = '';
                            
                            // Check for data-path attribute
                            if (element.getAttribute('data-path')) {
                                path = element.getAttribute('data-path');
                            } else {
                                // Try to find breadcrumb path
                                const breadcrumbs = doc.querySelectorAll('[class*="breadcrumb"] a, [class*="path"] span');
                                if (breadcrumbs.length > 0) {
                                    path = Array.from(breadcrumbs)
                                        .map(b => b.textContent.trim())
                                        .filter(t => t && t !== '/')
                                        .join('/');
                                    path = '/' + path;
                                }
                            }
                            
                            // If no path found, just use filename with root
                            if (!path || path === '/') {
                                path = '/' + fileName;
                            } else if (!path.endsWith(fileName)) {
                                path = path.endsWith('/') ? path + fileName : path + '/' + fileName;
                            }
                            
                            return path;
                        }
                    } catch (e) {
                        console.warn('[VSDactyl Debug] Could not setup context menu:', e.message);
                    }
                }

                function autofillLogin(creds) {
                    try {
                        // Only proceed if auto-login is enabled
                        if (!creds.shouldAutoLogin) {
                            console.log('[VSDactyl Debug] Auto-login disabled - expecting manual authentication');
                            console.log('[VSDactyl Debug] For custom authentication systems (OAuth, SSO, billing), complete login manually');
                            console.log('[VSDactyl Debug] Your session will be automatically preserved via the proxy');
                            return;
                        }

                        const doc = frame.contentDocument;
                        if (!doc) {
                            console.warn('[VSDactyl Debug] Cannot access iframe document (cross-origin).');
                            // Request proxy for the current iframe src so authentication flows can be proxied
                            try {
                                requestProxyForUrl(frame.src || panelOrigin, 'autofill cross-origin');
                                const externalBtn = document.getElementById('external-auth');
                                if (externalBtn) {
                                    externalBtn.style.display = 'inline-block';
                                    externalBtn.onclick = () => {
                                        vscode.postMessage({ command: 'openExternal', url: frame.src || panelOrigin });
                                    };
                                }
                            } catch (e) {
                                console.warn('[VSDactyl Debug] Failed to request proxy from autofill fallback:', e?.message);
                            }
                            return;
                        }

                        const inputs = doc.querySelectorAll('input');
                        if (!inputs || inputs.length === 0) {
                            console.warn('[VSDactyl Debug] No input fields found in iframe - custom auth system detected');
                            console.log('[VSDactyl Debug] This appears to be a custom authentication flow. Please log in manually.');
                            return;
                        }

                        let usernameField = null;
                        let passwordField = null;
                        const csrfTokens = [];

                        // Scan all inputs to find login fields and CSRF tokens
                        for (const input of inputs) {
                            const name = (input.name || '').toLowerCase();
                            const id = (input.id || '').toLowerCase();
                            const type = (input.type || '').toLowerCase();
                            const value = input.value || '';

                            // Check for CSRF token patterns
                            if (
                                type === 'hidden' && (
                                    name.includes('csrf') || 
                                    name.includes('_token') || 
                                    name.includes('authenticity') ||
                                    id.includes('csrf')
                                )
                            ) {
                                csrfTokens.push({ name: input.name, value: value });
                                console.log('[VSDactyl Debug] Found CSRF token:', input.name);
                            }

                            // Find password field
                            if (type === 'password') {
                                passwordField = input;
                            } 
                            // Find username/email field
                            else if (
                                name.includes('email') || name.includes('user') || name.includes('username') ||
                                id.includes('email') || id.includes('user') || id.includes('username') ||
                                type === 'email'
                            ) {
                                usernameField = input;
                            }
                        }

                        if (!usernameField || !passwordField) {
                            console.warn('[VSDactyl Debug] Could not find username or password field');
                            console.log('[VSDactyl Debug] This appears to be a custom authentication system.');
                            console.log('[VSDactyl Debug] Please authenticate manually through the panel.');
                            console.warn('[VSDactyl Debug] Available inputs:', Array.from(inputs).map(i => ({ name: i.name, type: i.type, id: i.id })));
                            // Offer a proxy/external fallback when autofill cannot locate fields
                            try {
                                requestProxyForUrl(frame.src || panelOrigin, 'autofill missing fields');
                                const externalBtn = document.getElementById('external-auth');
                                if (externalBtn) {
                                    externalBtn.style.display = 'inline-block';
                                    externalBtn.onclick = () => {
                                        vscode.postMessage({ command: 'openExternal', url: frame.src || panelOrigin });
                                    };
                                }
                            } catch (e) {
                                // ignore
                            }
                            return;
                        }

                        // Pre-fill username
                        if (creds.username) {
                            usernameField.value = creds.username;
                            usernameField.dispatchEvent(new Event('input', { bubbles: true }));
                            usernameField.dispatchEvent(new Event('change', { bubbles: true }));
                            usernameField.dispatchEvent(new Event('blur', { bubbles: true }));
                            console.log('[VSDactyl Debug] Pre-filled username:', creds.username);
                        }

                        // Pre-fill password
                        if (creds.password) {
                            passwordField.value = creds.password;
                            passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                            passwordField.dispatchEvent(new Event('change', { bubbles: true }));
                            passwordField.dispatchEvent(new Event('blur', { bubbles: true }));
                            console.log('[VSDactyl Debug] Pre-filled password');

                            // Auto-submit if enabled
                            if (creds.shouldAutoLogin) {
                                setTimeout(() => {
                                    try {
                                        const form = passwordField.closest('form');
                                        if (!form) {
                                            console.warn('[VSDactyl Debug] Could not find form element');
                                            return;
                                        }

                                        console.log('[VSDactyl Debug] Submitting login form with', csrfTokens.length, 'CSRF tokens');
                                        
                                        // Use form.submit() which properly includes all form data and respects CSRF tokens
                                        form.submit();
                                        console.log('[VSDactyl Debug] Auto-submitted login form');
                                    } catch (e) {
                                        console.error('[VSDactyl Debug] Error submitting form:', e.message);
                                        
                                        // Fallback: Try clicking submit button for custom workflows
                                        try {
                                            const submitBtn = doc.querySelector('button[type="submit"]') || 
                                                             doc.querySelector('button[name*="submit"]') ||
                                                             doc.querySelector('[type="submit"]');
                                            if (submitBtn) {
                                                submitBtn.click();
                                                console.log('[VSDactyl Debug] Fallback: clicked submit button');
                                            }
                                        } catch (e2) {
                                            console.error('[VSDactyl Debug] Fallback submit also failed:', e2.message);
                                        }
                                    }
                                }, 300);
                            } else {
                                console.log('[VSDactyl Debug] Auto-login disabled, credentials pre-filled for manual submission');
                            }
                        }
                    } catch (e) {
                        console.error('[VSDactyl Debug] Error during auto-fill:', e.message);
                        console.error('[VSDactyl Debug] Stack:', e.stack);
                    }
                }
            </script>
        </body>
        </html>
    `;
}

async function editConnectionFromExplorer(uri?: vscode.Uri): Promise<void> {
    if (!uri || (uri.scheme !== 'ptero' && uri.scheme !== 'sftp')) {
        vscode.window.showErrorMessage('Please right-click a connected remote folder to edit connection details.');
        return;
    }

    if (uri.scheme === 'sftp') {
        const account = await accountManager.getAccountById(uri.authority);
        if (!account || account.type !== 'sftpOnly') {
            vscode.window.showErrorMessage('Could not locate the SFTP account for this folder.');
            return;
        }
        await openEditAccountForm({ account } as ServerTreeItem);
        return;
    }

    const item = await serverTreeProvider.findServer(uri.authority);
    if (!item?.account || item.account.type !== 'pterodactyl') {
        vscode.window.showErrorMessage('Could not locate the panel account for this folder.');
        return;
    }

    await openEditAccountForm({ account: item.account } as ServerTreeItem);
}

async function restoreConnections() {
    const folders = vscode.workspace.workspaceFolders?.filter(
        f => f.uri.scheme === 'ptero' || f.uri.scheme === 'sftp'
    ) || [];
    if (folders.length === 0) return;

    Logger.info(`Found ${folders.length} remote workspace folders to restore.`);

    // Wait briefly for AccountManager to initialize if needed
    // But it's synchronous read.
    // ServerTreeProvider logic handles fetching.

    for (const folder of folders) {
        const identifier = folder.uri.authority;
        Logger.info(`Restoring connection for ${folder.name} (${identifier})...`);
        try {
            if (folder.uri.scheme === 'sftp') {
                const account = await accountManager.getAccountById(identifier);
                if (account && account.type === 'sftpOnly') {
                    await connectToServer({ account } as ServerTreeItem, true);
                } else {
                    Logger.warn(`Could not find SFTP account for ${identifier} to restore.`);
                }
                continue;
            }

            // Finding server might take a moment if it needs to fetch from API
            const item = await serverTreeProvider.findServer(identifier);
            if (item) {
                await connectToServer(item, true); // Silent mode
            } else {
                Logger.warn(`Could not find server info for ${identifier} to restore.`);
            }
        } catch (err) {
            Logger.error(`Failed to restore ${folder.name}`, err);
        }
    }
}

async function sendPowerSignal(item: ServerTreeItem | undefined, signal: 'start' | 'stop' | 'restart' | 'kill'): Promise<void> {
    if (!item || !item.server || !item.account) { return; }

    if (item.account.type !== 'pterodactyl') {
        vscode.window.showErrorMessage('Power actions are only available for panel-backed servers.');
        return;
    }
        const panelOriginJson = JSON.stringify(new URL(item.account.panelUrl).origin);

    const actionName = signal.charAt(0).toUpperCase() + signal.slice(1);

    // Confirm Kill
    if (signal === 'kill') {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to KILL server "${item.server.name}"? This may cause data loss.`,
            'Yes, Kill', 'Cancel'
        );
        if (confirm !== 'Yes, Kill') return;
    }

    try {
        const client = new PterodactylClient(item.account.panelUrl, item.account.apiKey || '');
        await client.sendPowerAction(item.server.uuid, signal);
        vscode.window.showInformationMessage(`Signal "${signal}" sent to "${item.server.name}".`);

        // Refresh status after duplicate delay
        setTimeout(() => {
            // We can't easily refresh just one item, refresh provider
            serverTreeProvider.refresh();
        }, 2000);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to ${signal} server: ${err.message}`);
    }
}

export function deactivate() {
    accountManager?.dispose();
    serverTreeProvider?.dispose();
    fileSystemProvider?.dispose();
    sftpFileSystemProvider?.dispose();
    remoteDecorationProvider?.dispose();
    terminalManager?.dispose();
}
