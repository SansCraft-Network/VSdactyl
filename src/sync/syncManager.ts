import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AccountManager } from '../accounts/accountManager';
import { PterodactylClient } from '../api/pterodactylClient';
import { SftpClient } from '../sftp/sftpClient';
import { Logger } from '../utils/logger';
import { ServerTreeItem } from '../views/serverTreeProvider';

export interface SyncConfig {
    accountId: string;
    serverIdentifier: string;
    serverName: string;
    remotePath: string;
    uploadOnSave: boolean;
    ignorePatterns: string[];
}

interface SyncMap {
    localBasePath: string;
    config: SyncConfig;
}

export class SyncManager {
    private static instance: SyncManager;
    private context: vscode.ExtensionContext;
    private syncMaps: Map<string, SyncMap> = new Map();
    private activeConnections: Map<string, SftpClient> = new Map();

    private accountManager: AccountManager;

    private constructor(context: vscode.ExtensionContext, accountManager: AccountManager) {
        this.context = context;
        this.accountManager = accountManager;
        this.initialize();
    }

    public static getInstance(context: vscode.ExtensionContext, accountManager?: AccountManager): SyncManager {
        if (!SyncManager.instance) {
            SyncManager.instance = new SyncManager(context, accountManager!);
        }
        return SyncManager.instance;
    }

    private async initialize() {
        await this.scanForConfigs();

        const watcher = vscode.workspace.createFileSystemWatcher('**/*');
        watcher.onDidChange(uri => this.handleFileEvent(uri, 'change'));
        watcher.onDidCreate(uri => this.handleFileEvent(uri, 'create'));
        watcher.onDidDelete(uri => this.handleFileEvent(uri, 'delete'));

        const configWatcher = vscode.workspace.createFileSystemWatcher('**/.vsdactyl-sync.json');
        configWatcher.onDidChange(() => this.scanForConfigs());
        configWatcher.onDidCreate(() => this.scanForConfigs());
        configWatcher.onDidDelete(() => this.scanForConfigs());
    }

    private async scanForConfigs() {
        this.syncMaps.clear();
        const uris = await vscode.workspace.findFiles('**/.vsdactyl-sync.json', '**/node_modules/**');
        
        for (const uri of uris) {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                const config: SyncConfig = JSON.parse(Buffer.from(content).toString('utf8'));
                const localBasePath = path.dirname(uri.fsPath);
                
                this.syncMaps.set(localBasePath, {
                    localBasePath,
                    config
                });
                Logger.info(`[Auto-Sync] Active mapping loaded: ${localBasePath} -> ${config.serverName}`);
            } catch (e) {
                Logger.error(`[Auto-Sync] Failed to parse config at ${uri.fsPath}`, e);
            }
        }
    }

    public async initSyncConfigCommand(item: ServerTreeItem) {
        if (!item.server || !item.account) {
            vscode.window.showErrorMessage('You must select a server to initialize sync.');
            return;
        }

        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            vscode.window.showErrorMessage('You must have a local workspace folder open to initialize Auto-Sync.');
            return;
        }

        const browseLocal = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Browse...' };
        const localInput = vscode.window.createInputBox();
        localInput.title = `Select local folder to map to ${item.server.name}`;
        localInput.placeholder = 'Type local path or click Browse...';
        localInput.buttons = [browseLocal];

        const localPath = await new Promise<string | undefined>((resolve) => {
            localInput.onDidAccept(() => resolve(localInput.value));
            localInput.onDidTriggerButton(async (btn) => {
                if (btn === browseLocal) {
                    const selectedUris = await vscode.window.showOpenDialog({
                        canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: 'Map Folder'
                    });
                    if (selectedUris && selectedUris.length > 0) localInput.value = selectedUris[0].fsPath;
                }
            });
            localInput.onDidHide(() => resolve(undefined));
            localInput.show();
        });

        if (!localPath) return;
        const selectedUri = vscode.Uri.file(localPath.trim());

        const workspaceFolder = vscode.workspace.getWorkspaceFolder(selectedUri);
        if (!workspaceFolder) {
            vscode.window.showWarningMessage('The selected folder is outside your active VS Code workspace. Auto-Sync cannot detect file changes automatically outside the workspace. Please open it in your workspace first.');
            return;
        }

        const browseRemote = { iconPath: new vscode.ThemeIcon('folder-opened'), tooltip: 'Browse Remote...' };
        const remoteInput = vscode.window.createInputBox();
        remoteInput.title = `Select remote destination path on ${item.server.name}`;
        remoteInput.value = '/';
        remoteInput.placeholder = 'Type remote path or click Browse...';
        remoteInput.buttons = [browseRemote];

        let remotePath = await new Promise<string | undefined>((resolve) => {
            remoteInput.onDidAccept(() => resolve(remoteInput.value));
            remoteInput.onDidTriggerButton(async (btn) => {
                if (btn === browseRemote) {
                    const ptero = new PterodactylClient(item.account!.panelUrl, item.account!.apiKey || '');
                    let currentPath = '/';
                    while (true) {
                        try {
                            const files = await ptero.listFiles(item.server!.identifier, currentPath);
                            const dirs = files.filter(f => f.attributes.is_file === false).map(f => f.attributes.name);
                            
                            const items: vscode.QuickPickItem[] = [];
                            if (currentPath !== '/') items.push({ label: '$(arrow-left) ..', description: 'Go up' });
                            items.push({ label: '$(check) SELECT THIS FOLDER', description: currentPath });
                            
                            dirs.forEach(d => items.push({ label: `$(folder) ${d}` }));

                            const choice = await vscode.window.showQuickPick(items, { title: `Browsing ${currentPath} on ${item.server!.name}` });
                            if (!choice) break;

                            if (choice.label.includes('SELECT THIS FOLDER')) {
                                remoteInput.value = currentPath;
                                break;
                            } else if (choice.label.includes('..')) {
                                const parts = currentPath.split('/').filter(p => p);
                                parts.pop();
                                currentPath = '/' + parts.join('/');
                            } else {
                                const folderName = choice.label.replace('$(folder) ', '');
                                currentPath = currentPath === '/' ? `/${folderName}` : `${currentPath}/${folderName}`;
                            }
                        } catch (e) {
                            vscode.window.showErrorMessage('Failed to list remote directory.');
                            break;
                        }
                    }
                    remoteInput.show();
                }
            });
            remoteInput.onDidHide(() => resolve(undefined));
            remoteInput.show();
        });

        if (remotePath === undefined) return;
        remotePath = remotePath.trim() || '/';

        const configPath = vscode.Uri.joinPath(selectedUri, '.vsdactyl-sync.json');
        
        const config: SyncConfig = {
            accountId: item.account.id,
            serverIdentifier: item.server.identifier,
            serverName: item.server.name,
            remotePath: remotePath,
            uploadOnSave: true,
            ignorePatterns: [".git", "node_modules", ".vsdactyl-sync.json"]
        };

        await vscode.workspace.fs.writeFile(configPath, Buffer.from(JSON.stringify(config, null, 4), 'utf8'));
        const folderName = path.basename(selectedUri.fsPath);
        vscode.window.showInformationMessage(`✅ VSDactyl Auto-Sync initialized! ${folderName} is now mapped to ${item.server.name}.`);
        
        await this.scanForConfigs();
    }

    private getMappingForPath(fsPath: string): SyncMap | undefined {
        let longestMatch: SyncMap | undefined;
        let longestLength = 0;

        for (const [basePath, map] of this.syncMaps.entries()) {
            if (fsPath.startsWith(basePath) && basePath.length > longestLength) {
                longestMatch = map;
                longestLength = basePath.length;
            }
        }
        return longestMatch;
    }

    private isIgnored(fsPath: string, config: SyncConfig): boolean {
        const basename = path.basename(fsPath);
        for (const pattern of config.ignorePatterns) {
            if (basename === pattern || fsPath.includes(pattern)) {
                return true;
            }
        }
        return false;
    }

    private async handleFileEvent(uri: vscode.Uri, type: 'create' | 'change' | 'delete') {
        if (uri.scheme !== 'file') return;

        const map = this.getMappingForPath(uri.fsPath);
        if (!map || !map.config.uploadOnSave) return;
        
        if (this.isIgnored(uri.fsPath, map.config)) return;

        const relativePath = path.relative(map.localBasePath, uri.fsPath).replace(/\\/g, '/');
        const remoteFilePath = path.posix.join(map.config.remotePath, relativePath);

        try {
            const sftp = await this.getSftpConnection(map.config);
            if (!sftp) return;

            if (type === 'delete') {
                Logger.info(`[Auto-Sync] Deleting remote file: ${remoteFilePath}`);
                try {
                    await sftp.delete(remoteFilePath, { recursive: true });
                } catch {
                    // ignore if neither file nor empty dir
                }
                vscode.window.setStatusBarMessage(`🗑️ VSDactyl Synced Delete: ${relativePath}`, 3000);
            } else {
                let isDirectory = false;
                try {
                    const stat = await vscode.workspace.fs.stat(uri);
                    isDirectory = stat.type === vscode.FileType.Directory;
                } catch (e) {
                    // File might have been deleted quickly
                    return;
                }

                if (isDirectory) {
                    await this.ensureRemoteDir(sftp, remoteFilePath);
                    return;
                }

                Logger.info(`[Auto-Sync] Uploading file: ${remoteFilePath}`);
                const parentDir = path.posix.dirname(remoteFilePath);
                await this.ensureRemoteDir(sftp, parentDir);

                const localBuffer = await vscode.workspace.fs.readFile(uri);
                await sftp.writeFile(remoteFilePath, Buffer.from(localBuffer));
                vscode.window.setStatusBarMessage(`✅ VSDactyl Synced: ${relativePath}`, 3000);
            }
        } catch (err: any) {
            Logger.error(`[Auto-Sync] Failed to sync ${relativePath}`, err);
            vscode.window.showErrorMessage(`Auto-Sync Error (${map.config.serverName}): Failed to sync ${relativePath}. ${err.message}`);
        }
    }

    private async ensureRemoteDir(sftp: SftpClient, dirPath: string) {
        if (dirPath === '/' || dirPath === '.' || dirPath === '') return;
        const parts = dirPath.split('/').filter(p => p.length > 0);
        let current = '';
        for (const part of parts) {
            current += '/' + part;
            try {
                await sftp.stat(current);
            } catch {
                try {
                    await sftp.mkdir(current);
                } catch (e) {
                    // Ignore, might have been created
                }
            }
        }
    }

    private async getSftpConnection(config: SyncConfig): Promise<SftpClient | null> {
        const cacheKey = `${config.accountId}_${config.serverIdentifier}`;
        if (this.activeConnections.has(cacheKey)) {
            const client = this.activeConnections.get(cacheKey)!;
            // Best effort check if socket is still active
            if (client['sftp']) return client;
            this.activeConnections.delete(cacheKey);
        }

        const accounts = await this.accountManager.getAccounts();
        const account = accounts.find(a => a.id === config.accountId);
        if (!account || account.type !== 'pterodactyl') {
            Logger.error(`[Auto-Sync] Account not found: ${config.accountId}`);
            return null;
        }

        const ptero = new PterodactylClient(account.panelUrl, account.apiKey || '');
        try {
            const servers = await ptero.listServers();
            const server = servers.find(s => s.identifier === config.serverIdentifier);
            if (!server) {
                Logger.error(`[Auto-Sync] Server not found: ${config.serverIdentifier}`);
                return null;
            }

            const host = server.sftp_details.ip;
            const port = server.sftp_details.port || 2022;
            const username = `${account.username}.${server.identifier}`;
            const password = account.password;

            const sftp = new SftpClient({
                host,
                port,
                username,
                password
            });
            await sftp.connect();

            this.activeConnections.set(cacheKey, sftp);
            return sftp;
        } catch (err) {
            Logger.error(`[Auto-Sync] Failed to connect to server ${config.serverIdentifier}`, err);
            return null;
        }
    }
}
