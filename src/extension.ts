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
import { SyncManager } from './sync/syncManager';

let accountManager: AccountManager;
let serverTreeProvider: ServerTreeProvider;
let fileSystemProvider: PterodactylFileSystemProvider;
let sftpFileSystemProvider: SftpOnlyFileSystemProvider;
let remoteDecorationProvider: RemoteFileDecorationProvider;
let terminalManager: TerminalManager;
let extensionContext: vscode.ExtensionContext;

import { Logger } from './utils/logger';
import { PanelProxy } from './utils/panelProxy';

export function activate(context: vscode.ExtensionContext) {
    Logger.initialize();
    Logger.info('Extension activating...');

    extensionContext = context;

    // Initialize managers
    accountManager = new AccountManager(context);
    serverTreeProvider = new ServerTreeProvider(accountManager);
    remoteDecorationProvider = new RemoteFileDecorationProvider();
    fileSystemProvider = new PterodactylFileSystemProvider(remoteDecorationProvider);
    sftpFileSystemProvider = new SftpOnlyFileSystemProvider(remoteDecorationProvider);
    terminalManager = new TerminalManager();

    // Initialize background singletons
    TransferManager.getInstance(context);
    SyncManager.getInstance(context, accountManager);

    // Register FileSystemProvider for ptero:// scheme
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('ptero', fileSystemProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        })
    );

    // Register FileSystemProvider for sftp:// scheme
    context.subscriptions.push(
        vscode.workspace.registerFileSystemProvider('sftp', sftpFileSystemProvider, {
            isCaseSensitive: true,
            isReadonly: false,
        })
    );

    context.subscriptions.push(
        vscode.window.registerFileDecorationProvider(remoteDecorationProvider)
    );

    // Register TreeView
    const treeView = vscode.window.createTreeView('pterodactylServers', {
        treeDataProvider: serverTreeProvider,
        showCollapseAll: true,
        dragAndDropController: new ServerTreeDragAndDropController(),
    });
    context.subscriptions.push(treeView);


    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('pterodactyl.addAccount', () => openAddAccountForm()),
        vscode.commands.registerCommand('pterodactyl.initSyncConfig', (item?: ServerTreeItem) => {
            if (item) SyncManager.getInstance(context).initSyncConfigCommand(item);
        }),
        vscode.commands.registerCommand('pterodactyl.addSftpAccount', () => openAddSftpAccountForm()),
        vscode.commands.registerCommand('pterodactyl.editAccount', (item?: ServerTreeItem) => openEditAccountForm(item)),
        vscode.commands.registerCommand('pterodactyl.removeAccount', (item?: ServerTreeItem) => removeAccount(item)),
        vscode.commands.registerCommand('pterodactyl.refreshServers', () => refreshServers()),
        vscode.commands.registerCommand('pterodactyl.connectServer', (item?: ServerTreeItem) => connectToServer(item)),
        vscode.commands.registerCommand('pterodactyl.disconnectServer', (item?: ServerTreeItem) => disconnectServer(item)),
        vscode.commands.registerCommand('pterodactyl.reconnectServer', (item?: ServerTreeItem) => reconnectServer(item)),
        vscode.commands.registerCommand('pterodactyl.exportData', () => accountManager.exportAccounts()),
        vscode.commands.registerCommand('pterodactyl.importData', () => accountManager.importAccounts()),
        vscode.commands.registerCommand('pterodactyl.showSftpLog', () => SftpClient.showDebugLog()),
        vscode.commands.registerCommand('pterodactyl.setupSshKey', () => setupSshKey()),
        vscode.commands.registerCommand('pterodactyl.uploadToNode', async (item: ServerTreeItem, uris: vscode.Uri[]) => {
            const conn = fileSystemProvider.getConnection(item.server!.identifier);
            if (!conn) {
                vscode.window.showErrorMessage('You must connect to the server first before dropping files.');
                return;
            }
            if (item.account?.type !== 'pterodactyl') {
                return; // Type guard to ensure we have panelUrl and apiKey
            }
            const pteroClient = new PterodactylClient(item.account.panelUrl, item.account.apiKey || '');
            const transferManager = TransferManager.getInstance(context);
            await transferManager.initiateArchiveAssistedUpload(
                uris,
                '/', // Upload to root directory by default for TreeView drops
                conn.sftpClient,
                pteroClient,
                item.server!.identifier
            );
        }),
        vscode.commands.registerCommand('pterodactyl.showTransferManager', () => TransferManager.getInstance(context).showDashboard()),
        vscode.commands.registerCommand('pterodactyl.openTerminal', (item?: ServerTreeItem) => openTerminal(item)),
        vscode.commands.registerCommand('pterodactyl.openPanelWebView', (item?: ServerTreeItem) => openPanelWebView(item)),
        vscode.commands.registerCommand('pterodactyl.editConnectionFromExplorer', (uri?: vscode.Uri) => editConnectionFromExplorer(uri)),

        // Power Actions
        vscode.commands.registerCommand('pterodactyl.startServer', (item?: ServerTreeItem) => sendPowerSignal(item, 'start')),
        vscode.commands.registerCommand('pterodactyl.restartServer', (item?: ServerTreeItem) => sendPowerSignal(item, 'restart')),
        vscode.commands.registerCommand('pterodactyl.stopServer', (item?: ServerTreeItem) => sendPowerSignal(item, 'stop')),
        vscode.commands.registerCommand('pterodactyl.killServer', (item?: ServerTreeItem) => sendPowerSignal(item, 'kill')),
    );

    // Auto-restore connections
    restoreConnections();

    Logger.info('VSDactyl extension activated');
}

// ... existing functions ...

import { SshKeyGenerator } from './utils/sshKeyGenerator';

async function collectSftpAccountData(existingAccount?: SftpOnlyAccount): Promise<Omit<SftpOnlyAccount, 'id'> | undefined> {
    const name = await vscode.window.showInputBox({
        prompt: 'Enter a display name for this SFTP connection',
        value: existingAccount?.name || '',
        validateInput: (value) => value.trim() ? null : 'Name is required',
    });
    if (!name) { return undefined; }

    const host = await vscode.window.showInputBox({
        prompt: 'Enter the SFTP host',
        value: existingAccount?.host || '',
        placeHolder: 'sftp.example.com',
        validateInput: (value) => value.trim() ? null : 'Host is required',
    });
    if (!host) { return undefined; }

    const portInput = await vscode.window.showInputBox({
        prompt: 'Enter the SFTP port',
        value: String(existingAccount?.port || 22),
        placeHolder: '22',
        validateInput: (value) => {
            const port = Number.parseInt(value, 10);
            return Number.isInteger(port) && port > 0 && port <= 65535 ? null : 'Enter a valid port between 1 and 65535';
        },
    });
    if (!portInput) { return undefined; }

    const username = await vscode.window.showInputBox({
        prompt: 'Enter the SFTP username',
        value: existingAccount?.username || '',
        placeHolder: 'ubuntu',
        validateInput: (value) => value.trim() ? null : 'Username is required',
    });
    if (!username) { return undefined; }

    const authChoice = await vscode.window.showQuickPick(
        [
            { label: 'SSH Key', description: 'Authenticate with a private key file', value: 'ssh-key' as const },
            { label: 'Password', description: 'Authenticate with a password', value: 'password' as const },
        ],
        {
            placeHolder: 'Select the SFTP authentication method',
            ignoreFocusOut: true,
            canPickMany: false,
        }
    );
    if (!authChoice) { return undefined; }

    let privateKeyPath = existingAccount?.privateKeyPath || '';
    let privateKeyData = existingAccount?.privateKeyData || '';
    let password = existingAccount?.password || '';

    if (authChoice.value === 'ssh-key') {
        const keyPath = await vscode.window.showInputBox({
            prompt: existingAccount ? 'SSH private key path (leave blank to keep current key)' : 'SSH private key path',
            value: existingAccount?.privateKeyPath || '',
            placeHolder: 'C:\\Users\\you\\.ssh\\id_ed25519',
            validateInput: (value) => {
                if (value.trim()) { return null; }
                return (existingAccount?.privateKeyPath || existingAccount?.privateKeyData) ? null : 'SSH private key path is required';
            },
        });
        if (keyPath === undefined) { return undefined; }

        if (keyPath.trim()) {
            privateKeyPath = keyPath.trim();
            privateKeyData = '';
        } else if (!existingAccount?.privateKeyPath && !existingAccount?.privateKeyData) {
            return undefined;
        }

        password = '';
    } else {
        const passwordInput = await vscode.window.showInputBox({
            prompt: existingAccount ? 'SFTP password (leave blank to keep current password)' : 'Enter the SFTP password',
            password: true,
            placeHolder: existingAccount?.password ? 'Leave blank to keep current password' : 'SFTP password',
            validateInput: (value) => {
                if (value.length > 0) { return null; }
                return existingAccount?.password ? null : 'Password is required';
            },
        });
        if (passwordInput === undefined) { return undefined; }

        if (passwordInput.length > 0) {
            password = passwordInput;
        } else if (!existingAccount?.password) {
            return undefined;
        }

        privateKeyPath = '';
        privateKeyData = '';
    }

    return {
        name,
        type: 'sftpOnly',
        branding: 'SansCraft Network Corp',
        username,
        host,
        port: Number.parseInt(portInput, 10),
        sftpAuthMethod: authChoice.value,
        privateKeyPath,
        privateKeyData,
        password: password || undefined,
    };
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
            const { filePath, fileName } = message.data;
            try {
                await handleOpenPanelFile(filePath, fileName, item);
            } catch (err: any) {
                vscode.window.showErrorMessage(`Failed to open file: ${err.message}`);
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
            </div>
            <iframe src="${serverUrl}" id="panel-frame" allow="clipboard-read; clipboard-write;"></iframe>
            <script>
                const notice = document.getElementById('notice');
                const frame = document.getElementById('panel-frame');
                const credentials = ${credentialsJson};
                
                let loaded = false;
                let contextMenu = null;
                
                frame.onload = () => {
                    loaded = true;
                    console.log('[VSDactyl Debug] Iframe loaded successfully.');
                    notice.style.display = 'none';
                    
                    // Inject right-click handler into iframe
                    setupPanelContextMenu();
                    
                    // Auto-fill credentials if available
                    if (credentials.username || credentials.password) {
                        try {
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
                        });
                        
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
                        const inputs = frame.contentDocument?.querySelectorAll('input');
                        if (!inputs || inputs.length === 0) {
                            console.warn('[VSDactyl Debug] No input fields found in iframe');
                            return;
                        }

                        let usernameField = null;
                        let passwordField = null;

                        // Common patterns for login forms
                        for (const input of inputs) {
                            const name = (input.name || '').toLowerCase();
                            const id = (input.id || '').toLowerCase();
                            const type = (input.type || '').toLowerCase();

                            if (type === 'password') {
                                passwordField = input;
                            } else if (
                                name.includes('email') || name.includes('user') || 
                                id.includes('email') || id.includes('user') ||
                                type === 'email'
                            ) {
                                usernameField = input;
                            }
                        }

                        if (usernameField && creds.username) {
                            usernameField.value = creds.username;
                            usernameField.dispatchEvent(new Event('input', { bubbles: true }));
                            usernameField.dispatchEvent(new Event('change', { bubbles: true }));
                            console.log('[VSDactyl Debug] Pre-filled username');
                        }

                        if (passwordField && creds.password) {
                            passwordField.value = creds.password;
                            passwordField.dispatchEvent(new Event('input', { bubbles: true }));
                            passwordField.dispatchEvent(new Event('change', { bubbles: true }));
                            console.log('[VSDactyl Debug] Pre-filled password');

                            // Auto-submit if enabled
                            if (creds.shouldAutoLogin) {
                                const form = passwordField.closest('form');
                                if (form) {
                                    setTimeout(() => {
                                        form.submit();
                                        console.log('[VSDactyl Debug] Auto-submitted login form');
                                    }, 200);
                                } else {
                                    // Try to find a submit button
                                    const submitBtn = frame.contentDocument?.querySelector('button[type="submit"]');
                                    if (submitBtn) {
                                        setTimeout(() => {
                                            submitBtn.click();
                                            console.log('[VSDactyl Debug] Clicked submit button');
                                        }, 200);
                                    }
                                }
                            }
                        }
                    } catch (e) {
                        console.warn('[VSDactyl Debug] Error during auto-fill:', e.message);
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
