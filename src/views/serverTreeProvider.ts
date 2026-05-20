import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import { PterodactylClient, PterodactylAccount, PteroAccount, PteroServer } from '../api/pterodactylClient';
import { SftpOnlyAccount } from '../accounts/types';
import { Logger } from '../utils/logger';

export type TreeNodeType = 'account' | 'server' | 'serverInfo' | 'systemInfo' | 'folder' | 'file' | 'loading' | 'error' | 'empty';

export class ServerTreeItem extends vscode.TreeItem {
    private _path?: string;

    public get path(): string | undefined {
        return this._path;
    }

    public set path(value: string | undefined) {
        this._path = value;
        this.setupAppearance();
    }

    constructor(
        public readonly label: string,
        public readonly nodeType: TreeNodeType,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly account?: PteroAccount,
        public readonly server?: PteroServer,
    ) {
        super(label, collapsibleState);
        this.contextValue = nodeType;
        this.setupAppearance();
    }

    private setupAppearance(): void {
        switch (this.nodeType) {
            case 'account':
                this.iconPath = new vscode.ThemeIcon('account');
                if (this.account?.type === 'pterodactyl') {
                    this.contextValue = 'account';
                    this.description = this.account.panelUrl.replace(/https?:\/\//, '');
                    this.tooltip = `Account: ${this.account.name}\nPanel: ${this.account.panelUrl}\nUser: ${this.account.username}\nAuth: ${this.account.authMethod}`;
                } else {
                    this.contextValue = 'account-sftp';
                    this.description = `${this.account?.host || ''}:${this.account?.port || ''}`;
                    this.tooltip = `Account: ${this.account?.name}\nHost: ${this.account?.host}\nPort: ${this.account?.port}\nUser: ${this.account?.username}\nAuth: ${this.account?.sftpAuthMethod}`;
                    this.command = {
                        command: 'pterodactyl.connectServer',
                        title: 'Connect to Server',
                        arguments: [this],
                    };
                }
                break;

            case 'server':
                // Set context value to enable specific commands (server-running, server-offline, etc.)
                // server.status can be: null, installing, suspended, restoring, transfer, running, offline, starting, stopping
                const status = this.server?.status || 'offline'; // Default to offline if null
                this.contextValue = `server-${status}`;

                // Extract Java/Image version
                let imageTag = 'Unknown';
                if (this.server?.docker_image) {
                    // Regex to find version number in tag
                    // Matches: :java_17, :17-jdk, :java-17, :jdk-17, :17
                    const match = this.server.docker_image.match(/:.*?(\d+)/);
                    if (match) {
                        imageTag = match[1];
                    } else {
                        // Fallback to full tag if no number found
                        const parts = this.server.docker_image.split(':');
                        if (parts.length > 1) imageTag = parts[1];
                    }
                }

                if (this.server?.is_suspended) {
                    this.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('errorForeground'));
                    this.description = '⛔ Suspended';
                } else if (this.server?.is_installing) {
                    this.iconPath = new vscode.ThemeIcon('loading~spin');
                    this.description = '⏳ Installing';
                } else {
                    // Status icon
                    if (status === 'running') {
                        this.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.green'));
                    } else if (status === 'starting') {
                        this.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.yellow'));
                    } else if (status === 'stopping') {
                        this.iconPath = new vscode.ThemeIcon('debug-stop', new vscode.ThemeColor('charts.red'));
                    } else {
                        // Offline or other
                        this.iconPath = new vscode.ThemeIcon('stop-circle', new vscode.ThemeColor('debugIcon.stopForeground'));
                    }

                    // Description: Node | Status | Java
                    const parts = [];
                    if (status && status !== 'running') parts.push(status.toUpperCase());
                    if (imageTag !== 'Unknown') parts.push(`Java ${imageTag}`);
                    this.description = parts.join(' | ');
                }
                this.tooltip = this.buildServerTooltip();
                // Omit automatic click command for server nodes since they are now expandable folders containing files.
                // Right-click context actions will still let users manually connect/mount.
                break;

            case 'systemInfo':
                this.iconPath = new vscode.ThemeIcon('dashboard');
                this.contextValue = 'systemInfo';
                break;

            case 'folder':
                this.iconPath = vscode.ThemeIcon.Folder;
                this.contextValue = this.account?.type === 'pterodactyl' ? 'folder-ptero' : 'folder-sftp';
                break;

            case 'file':
                this.iconPath = vscode.ThemeIcon.File;
                this.contextValue = this.account?.type === 'pterodactyl' ? 'file-ptero' : 'file-sftp';
                if (this.account && this.path) {
                    const scheme = this.account.type === 'pterodactyl' ? 'ptero' : 'sftp';
                    const authority = this.account.type === 'pterodactyl' ? this.server?.identifier : this.account.id;
                    if (authority) {
                        this.command = {
                            command: 'vscode.open',
                            title: 'Open File',
                            arguments: [vscode.Uri.parse(`${scheme}://${authority}${this.path}`)],
                        };
                    }
                }
                break;

            case 'serverInfo':
                // Info items are non-interactive detail lines
                break;

            case 'loading':
                this.iconPath = new vscode.ThemeIcon('loading~spin');
                break;

            case 'error':
                this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
                break;

            case 'empty':
                this.iconPath = new vscode.ThemeIcon('info');
                break;
        }
    }

    private buildServerTooltip(): vscode.MarkdownString {
        if (!this.server) { return new vscode.MarkdownString(''); }
        const s = this.server;
        const md = new vscode.MarkdownString();
        md.supportHtml = true;

        md.appendMarkdown(`### 🖥️ ${s.name}\n`);
        md.appendMarkdown(`**ID**: \`${s.identifier}\` | **Node**: ${s.node}\n\n`);

        if (s.usage) {
            const statusIcon = s.status === 'running' ? '🟢' : (s.status === 'offline' ? '🔴' : '🟡');
            md.appendMarkdown(`${statusIcon} **${s.status?.toUpperCase()}**`);
            md.appendMarkdown(` | ⏱️ **Uptime**: ${this.formatUptime(s.usage.uptime)}\n\n`);

            md.appendMarkdown(`| Resource | Usage | Limit |\n`);
            md.appendMarkdown(`| :--- | :--- | :--- |\n`);
            md.appendMarkdown(`| **CPU** | ${s.usage.cpu_absolute.toFixed(1)}% | ${formatLimitCPU(s.limits.cpu)} |\n`);
            md.appendMarkdown(`| **RAM** | ${formatBytes(s.usage.memory_bytes)} | ${formatLimitMB(s.limits.memory)} |\n`);
            md.appendMarkdown(`| **Disk** | ${formatBytes(s.usage.disk_bytes)} | ${formatLimitMB(s.limits.disk)} |\n\n`);
        } else {
            if (s.allocation.ip) {
                md.appendMarkdown(`**IP**: \`${s.allocation.ip}:${s.allocation.port}\`\n`);
            }
            md.appendMarkdown(`**Limits**:\n`);
            md.appendMarkdown(`- CPU: ${formatLimitCPU(s.limits.cpu)}\n`);
            md.appendMarkdown(`- RAM: ${formatLimitMB(s.limits.memory)}\n`);
            md.appendMarkdown(`- Disk: ${formatLimitMB(s.limits.disk)}\n\n`);
        }

        if (s.sftp_details.ip) {
            md.appendMarkdown(`**SFTP**: \`${s.sftp_details.ip}:${s.sftp_details.port}\`\n`);
        }
        if (s.description) {
            md.appendMarkdown(`\n_${s.description}_`);
        }
        return md;
    }

    private formatUptime(ms: number): string {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const hours = Math.floor(minutes / 60);
        const days = Math.floor(hours / 24);
        if (days > 0) return `${days}d ${hours % 24}h`;
        if (hours > 0) return `${hours}h ${minutes % 60}m`;
        return `${minutes}m ${seconds % 60}s`;
    }
}

function createInfoItem(icon: string, label: string, detail: string, color?: vscode.ThemeColor): ServerTreeItem {
    const item = new ServerTreeItem(label, 'serverInfo', vscode.TreeItemCollapsibleState.None);
    item.iconPath = color ? new vscode.ThemeIcon(icon, color) : new vscode.ThemeIcon(icon);
    item.description = detail;
    return item;
}

function formatMB(mb: number): string {
    if (mb >= 1024) {
        return `${(mb / 1024).toFixed(1)} GB`;
    }
    return `${mb} MB`;
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024 * 1024) {
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    if (bytes >= 1024 * 1024) {
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / 1024).toFixed(1)} KB`;
}

function formatLimitMB(mb: number): string {
    if (mb === 0) return 'Unlimited';
    return formatMB(mb);
}

function formatLimitCPU(cpu: number): string {
    if (cpu === 0) return 'Unlimited';
    return `${cpu}%`;
}

export class ServerTreeDragAndDropController implements vscode.TreeDragAndDropController<ServerTreeItem> {
    readonly dragMimeTypes = ['text/uri-list'];
    readonly dropMimeTypes = ['text/uri-list'];

    async handleDrag(source: readonly ServerTreeItem[], dataTransfer: vscode.DataTransfer): Promise<void> {
        const uris: vscode.Uri[] = [];

        for (const item of source) {
            if (item.nodeType === 'server' && item.server) {
                uris.push(vscode.Uri.parse(`ptero://${item.server.identifier}/`));
                continue;
            }

            if (item.nodeType === 'account' && item.account?.type === 'sftpOnly') {
                uris.push(vscode.Uri.parse(`sftp://${item.account.id}/`));
                continue;
            }

            if ((item.nodeType === 'folder' || item.nodeType === 'file') && item.account && item.path) {
                const scheme = item.account.type === 'pterodactyl' ? 'ptero' : 'sftp';
                const authority = item.account.type === 'pterodactyl' ? item.server?.identifier : item.account.id;
                if (authority) {
                    uris.push(vscode.Uri.parse(`${scheme}://${authority}${item.path}`));
                }
            }
        }

        if (uris.length === 0) {
            return;
        }

        const uriListPayload = uris.map((uri) => uri.toString()).join('\r\n');
        dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriListPayload));
    }

    async handleDrop(target: ServerTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
        if (!target || !target.account) {
            return;
        }

        const isTargetPtero = target.account.type === 'pterodactyl';
        const targetServerId = isTargetPtero ? target.server?.identifier : target.account.id;
        if (!targetServerId) {
            return;
        }

        const rawUris: string[] = [];

        // 1. Try to extract from text/uri-list
        const filesItem = dataTransfer.get('text/uri-list');
        if (filesItem) {
            const uriList = await filesItem.asString();
            rawUris.push(...uriList.split('\r\n').map(s => s.trim()).filter(Boolean));
        }

        // 2. Try to extract from iterator (for OS drag and drop)
        if (typeof (dataTransfer as any)[Symbol.iterator] === 'function') {
            for (const [mimeType, item] of dataTransfer) {
                const file = item.asFile();
                if (file && file.uri) {
                    rawUris.push(file.uri.toString());
                }
            }
        }

        if (rawUris.length === 0) {
            return;
        }

        const fileUris: vscode.Uri[] = [];
        const remoteSameUris: vscode.Uri[] = [];
        const remoteDiffUris: vscode.Uri[] = [];

        for (const rawUri of rawUris) {
            try {
                const uri = vscode.Uri.parse(rawUri);
                if (uri.scheme === 'file') {
                    fileUris.push(uri);
                } else if (uri.scheme === 'ptero' || uri.scheme === 'sftp') {
                    if (uri.path === '/' || uri.path === '') {
                        continue;
                    }
                    if (uri.authority === targetServerId) {
                        remoteSameUris.push(uri);
                    } else {
                        remoteDiffUris.push(uri);
                    }
                }
            } catch (e) {
                // ignore
            }
        }

        if (fileUris.length > 0) {
            vscode.commands.executeCommand('pterodactyl.uploadToNode', target, fileUris);
        }
        if (remoteSameUris.length > 0) {
            vscode.commands.executeCommand('pterodactyl.moveOnNode', target, remoteSameUris);
        }
        if (remoteDiffUris.length > 0) {
            vscode.commands.executeCommand('pterodactyl.transferBetweenServers', target, remoteDiffUris);
        }
    }
}

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private serverCache: Map<string, PteroServer[]> = new Map();
    private cacheTimestamps: Map<string, number> = new Map();
    private expandedServers: Map<string, { element: ServerTreeItem, timer?: NodeJS.Timeout }> = new Map();
    private loadingAccounts: Set<string> = new Set();
    private errorAccounts: Map<string, string> = new Map();

    private fileSystemProvider?: any;
    private sftpFileSystemProvider?: any;

    public setFileSystemProviders(fileSystemProvider: any, sftpFileSystemProvider: any): void {
        this.fileSystemProvider = fileSystemProvider;
        this.sftpFileSystemProvider = sftpFileSystemProvider;
    }

    constructor(private accountManager: AccountManager) {
        accountManager.onDidChangeAccounts(() => {
            this.serverCache.clear();
            this.refresh();
        });
    }

    refresh(element?: ServerTreeItem): void {
        this._onDidChangeTreeData.fire(element);
    }

    public refreshServer(serverIdentifierOrUuid: string): void {
        let entry = this.expandedServers.get(serverIdentifierOrUuid);
        if (!entry) {
            for (const [_, e] of this.expandedServers.entries()) {
                if (e.element.server?.identifier === serverIdentifierOrUuid || 
                    e.element.server?.uuid === serverIdentifierOrUuid || 
                    e.element.account?.id === serverIdentifierOrUuid) {
                    entry = e;
                    break;
                }
            }
        }
        if (entry) {
            this._onDidChangeTreeData.fire(entry.element);
        } else {
            this._onDidChangeTreeData.fire(undefined);
        }
    }

    getTreeItem(element: ServerTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ServerTreeItem): Promise<ServerTreeItem[]> {
        if (!element) {
            // Root level: show accounts
            const accounts = await this.accountManager.getAccounts();
            if (accounts.length === 0) {
                return [
                    new ServerTreeItem(
                        'No accounts configured. Click + to add one.',
                        'empty',
                        vscode.TreeItemCollapsibleState.None
                    ),
                ];
            }
            return accounts.map(
                account => new ServerTreeItem(
                    account.name,
                    'account',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    account
                )
            );
        }

        if (element.nodeType === 'account' && element.account) {
            if (element.account.type === 'pterodactyl') {
                return this.fetchServers(element.account);
            }

            return [
                new ServerTreeItem('Standalone SFTP connection', 'empty', vscode.TreeItemCollapsibleState.None),
            ];
        }

        // Server children: show System Information node and root files/directories
        if (element.nodeType === 'server' && element.server && element.account) {
            const items: ServerTreeItem[] = [];
            items.push(
                new ServerTreeItem('System Information', 'systemInfo', vscode.TreeItemCollapsibleState.Collapsed, element.account, element.server)
            );
            try {
                const files = await this.fetchFiles(element.account, element.server, '/');
                items.push(...files);
            } catch (e: any) {
                Logger.error(`Failed to fetch root files for server ${element.server.identifier}`, e);
                items.push(new ServerTreeItem(`Error loading files: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None));
            }
            return items;
        }

        // System Info children: show live usage details
        if (element.nodeType === 'systemInfo' && element.server) {
            return this.getServerInfoItems(element.server);
        }

        // Folder children: show subfolders and files
        if (element.nodeType === 'folder' && element.account && element.path) {
            return this.fetchFiles(element.account, element.server, element.path);
        }

        return [];
    }

    private async fetchFiles(account: PteroAccount, server: PteroServer | undefined, path: string): Promise<ServerTreeItem[]> {
        if (account.type === 'pterodactyl') {
            if (!server) return [];
            try {
                const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                const files = await client.listFiles(server.uuid, path);
                if (files.length === 0) {
                    return [new ServerTreeItem('Empty folder', 'empty', vscode.TreeItemCollapsibleState.None)];
                }
                // Sort: folders first, then files alphabetically
                files.sort((a, b) => {
                    if (a.is_file !== b.is_file) {
                        return a.is_file ? 1 : -1;
                    }
                    return a.name.localeCompare(b.name);
                });
                return files.map(file => {
                    const itemPath = `${path === '/' ? '' : path}/${file.name}`;
                    const nodeType = file.is_file ? 'file' : 'folder';
                    const collapsibleState = file.is_file ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed;
                    const item = new ServerTreeItem(file.name, nodeType, collapsibleState, account, server);
                    item.path = itemPath;
                    return item;
                });
            } catch (e: any) {
                Logger.error(`Failed to list files for ${path} on server ${server.identifier}`, e);
                return [new ServerTreeItem(`Error: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None)];
            }
        } else {
            // Standalone SFTP connection
            if (this.sftpFileSystemProvider) {
                let conn = this.sftpFileSystemProvider.getConnection(account.id);
                if (!conn) {
                    try {
                        this.sftpFileSystemProvider.registerConnection(account as SftpOnlyAccount);
                        conn = this.sftpFileSystemProvider.getConnection(account.id);
                    } catch (e: any) {
                        Logger.error(`Failed to register connection for SFTP account ${account.name}`, e);
                        return [new ServerTreeItem(`Connection error: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None)];
                    }
                }
                if (conn) {
                    try {
                        if (!conn.sftpClient.isConnected()) {
                            await conn.sftpClient.connect();
                        }
                        const entries = await conn.sftpClient.list(path);
                        if (entries.length === 0) {
                            return [new ServerTreeItem('Empty folder', 'empty', vscode.TreeItemCollapsibleState.None)];
                        }
                        // Sort: folders first, then files
                        entries.sort((a: any, b: any) => {
                            if (a.isDirectory !== b.isDirectory) {
                                return a.isDirectory ? -1 : 1;
                            }
                            return a.name.localeCompare(b.name);
                        });
                        return entries.map((entry: any) => {
                            const itemPath = `${path === '/' ? '' : path}/${entry.name}`;
                            const nodeType = entry.isDirectory ? 'folder' : 'file';
                            const collapsibleState = entry.isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None;
                            const item = new ServerTreeItem(entry.name, nodeType, collapsibleState, account);
                            item.path = itemPath;
                            return item;
                        });
                    } catch (e: any) {
                        Logger.error(`Failed to list SFTP files for ${path}`, e);
                        return [new ServerTreeItem(`Error: ${e.message}`, 'error', vscode.TreeItemCollapsibleState.None)];
                    }
                }
            }
            return [new ServerTreeItem('No connection active', 'error', vscode.TreeItemCollapsibleState.None)];
        }
    }

    private getServerInfoItems(server: PteroServer): ServerTreeItem[] {
        const items: ServerTreeItem[] = [];

        // IP & Port
        if (server.allocation.ip) {
            items.push(createInfoItem('globe', 'Address', `${server.allocation.ip}:${server.allocation.port}`));
        }

        // Resources (Limits / Usage)
        if (server.usage) {
            const cpuUsage = server.usage.cpu_absolute;
            const cpuLimit = server.limits.cpu;
            const cpuWarning = cpuLimit > 0 && cpuUsage > (cpuLimit * 0.9);
            items.push(createInfoItem('dashboard', 'CPU', `${cpuUsage.toFixed(1)}% / ${formatLimitCPU(cpuLimit)}`, cpuWarning ? new vscode.ThemeColor('errorForeground') : undefined));

            const ramUsage = server.usage.memory_bytes;
            const ramLimit = server.limits.memory * 1024 * 1024;
            const ramWarning = ramLimit > 0 && ramUsage > (ramLimit * 0.9);
            items.push(createInfoItem('pulse', 'RAM', `${formatBytes(ramUsage)} / ${formatLimitMB(server.limits.memory)}`, ramWarning ? new vscode.ThemeColor('errorForeground') : undefined));

            const diskUsage = server.usage.disk_bytes;
            const diskLimit = server.limits.disk * 1024 * 1024;
            const diskWarning = diskLimit > 0 && diskUsage > (diskLimit * 0.9);
            items.push(createInfoItem('database', 'Disk', `${formatBytes(diskUsage)} / ${formatLimitMB(server.limits.disk)}`, diskWarning ? new vscode.ThemeColor('errorForeground') : undefined));
        } else {
            // Static Limits
            items.push(createInfoItem('dashboard', 'CPU', formatLimitCPU(server.limits.cpu)));
            items.push(createInfoItem('pulse', 'RAM', formatLimitMB(server.limits.memory)));
            items.push(createInfoItem('database', 'Disk', formatLimitMB(server.limits.disk)));
        }

        // SFTP info
        if (server.sftp_details.ip) {
            items.push(createInfoItem('remote', 'SFTP', `${server.sftp_details.ip}:${server.sftp_details.port}`));
        }

        // Node
        if (server.node) {
            items.push(createInfoItem('server', 'Node', server.node));
        }

        return items;
    }

    private async fetchServers(account: PterodactylAccount): Promise<ServerTreeItem[]> {
        const now = Date.now();
        const cached = this.serverCache.get(account.id);
        const lastFetch = this.cacheTimestamps.get(account.id) || 0;

        if (cached && (now - lastFetch) < 10000) { // 10s TTL
            if (cached.length === 0) {
                return [new ServerTreeItem('No servers found', 'empty', vscode.TreeItemCollapsibleState.None)];
            }
            return cached.map(
                server => new ServerTreeItem(
                    server.name,
                    'server',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    account,
                    server
                )
            );
        }

        try {
            this.loadingAccounts.add(account.id);
            const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
            const servers = await client.listServers();

            // Fetch live status for servers that don't have a special status
            // (e.g. installing/suspended have status set, others have null)
            await Promise.all(servers.map(async (server) => {
                if (!server.is_suspended && !server.is_installing) {
                    try {
                        const resources = await client.getServerResources(server.uuid);
                        server.status = resources.current_state;
                        // Store usage stats
                        server.usage = {
                            memory_bytes: resources.resources.memory_bytes,
                            cpu_absolute: resources.resources.cpu_absolute,
                            disk_bytes: resources.resources.disk_bytes,
                            network_rx_bytes: resources.resources.network_rx_bytes,
                            network_tx_bytes: resources.resources.network_tx_bytes,
                            uptime: resources.resources.uptime || 0
                        };
                    } catch (e) {
                        // usage undefined
                    }
                }
            }));

            this.serverCache.set(account.id, servers);
            this.cacheTimestamps.set(account.id, now);
            this.loadingAccounts.delete(account.id);
            this.errorAccounts.delete(account.id);

            if (servers.length === 0) {
                return [new ServerTreeItem('No servers found', 'empty', vscode.TreeItemCollapsibleState.None)];
            }

            return servers.map(
                server => new ServerTreeItem(
                    server.name,
                    'server',
                    vscode.TreeItemCollapsibleState.Collapsed,
                    account,
                    server
                )
            );
        } catch (err: any) {
            this.loadingAccounts.delete(account.id);
            this.errorAccounts.set(account.id, err.message);
            return [
                new ServerTreeItem(
                    `Error: ${err.message}`,
                    'error',
                    vscode.TreeItemCollapsibleState.None
                ),
            ];
        }
    }

    clearCache(): void {
        this.serverCache.clear();
        this.errorAccounts.clear();
    }

    async findServer(identifier: string): Promise<ServerTreeItem | undefined> {
        const accounts = await this.accountManager.getAccounts();
        const accountById = new Map(accounts.map(account => [account.id, account]));

        // Helper to search in cache
        const searchCache = () => {
            for (const [accountId, servers] of this.serverCache.entries()) {
                const server = servers.find(s => s.identifier === identifier);
                if (server) {
                    const account = accountById.get(accountId);
                    if (account && account.type === 'pterodactyl') {
                        return new ServerTreeItem(server.name, 'server', vscode.TreeItemCollapsibleState.Collapsed, account, server);
                    }
                }
            }
            return undefined;
        };

        // Check cache first
        let found = searchCache();
        if (found) return found;

        // If not found, fetch all accounts (re-populate cache)
        for (const account of accounts) {
            if (account.type !== 'pterodactyl') {
                continue;
            }
            try {
                // parallelize? maybe sequentially to stop early
                await this.fetchServers(account);
                found = searchCache();
                if (found) return found;
            } catch (e) {
                // ignore error, allow searching other accounts
            }
        }

        return undefined;
    }

    public setServerExpanded(serverUuid: string, expanded: boolean, element?: ServerTreeItem): void {
        if (expanded && element) {
            this.expandedServers.set(serverUuid, { element });
            this.startRefreshTimer(serverUuid);
        } else {
            const entry = this.expandedServers.get(serverUuid);
            if (entry?.timer) {
                clearTimeout(entry.timer);
            }
            this.expandedServers.delete(serverUuid);
        }
    }

    private startRefreshTimer(serverUuid: string): void {
        const entry = this.expandedServers.get(serverUuid);
        if (!entry) return;

        entry.timer = setTimeout(async () => {
            await this.refreshServerStats(serverUuid);
            this.startRefreshTimer(serverUuid);
        }, 20000); // 20s background polling
    }

    private async refreshServerStats(serverUuid: string): Promise<void> {
        const entry = this.expandedServers.get(serverUuid);
        if (!entry || !entry.element.server || !entry.element.account) return;

        const server = entry.element.server;
        const account = entry.element.account;
        if (account.type !== 'pterodactyl') return;

        try {
            const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
            const resources = await client.getServerResources(server.uuid);
            server.status = resources.current_state;
            server.usage = {
                memory_bytes: resources.resources.memory_bytes,
                cpu_absolute: resources.resources.cpu_absolute,
                disk_bytes: resources.resources.disk_bytes,
                network_rx_bytes: resources.resources.network_rx_bytes,
                network_tx_bytes: resources.resources.network_tx_bytes,
                uptime: resources.resources.uptime || 0
            };
            this._onDidChangeTreeData.fire(entry.element);
        } catch (e) {
            // silent fail
        }
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const [_, entry] of this.expandedServers.entries()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.expandedServers.clear();
    }
}
