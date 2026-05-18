import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import { PterodactylClient, PterodactylAccount, PteroAccount, PteroServer } from '../api/pterodactylClient';

export type TreeNodeType = 'account' | 'server' | 'serverInfo' | 'loading' | 'error' | 'empty';

export class ServerTreeItem extends vscode.TreeItem {
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
                this.command = {
                    command: 'pterodactyl.connectServer',
                    title: 'Connect to Server',
                    arguments: [this],
                };
                break;

            case 'serverInfo':
                // Info items are non-interactive detail lines
                break;

            case 'loading':
                this.iconPath = new vscode.ThemeIcon('loading~spin');
                break;

                this.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
                break;

            case 'serverInfo':
                // Handled in creation
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
            }
        }

        if (uris.length === 0) {
            return;
        }

        const uriListPayload = uris.map((uri) => uri.toString()).join('\r\n');
        dataTransfer.set('text/uri-list', new vscode.DataTransferItem(uriListPayload));
    }

    async handleDrop(_target: ServerTreeItem | undefined, _dataTransfer: vscode.DataTransfer): Promise<void> {
        // No-op: this controller is only used as a drag source into Explorer.
    }
}

export class ServerTreeProvider implements vscode.TreeDataProvider<ServerTreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<ServerTreeItem | undefined | null>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private serverCache: Map<string, PteroServer[]> = new Map();
    private loadingAccounts: Set<string> = new Set();
    private errorAccounts: Map<string, string> = new Map();

    constructor(private accountManager: AccountManager) {
        accountManager.onDidChangeAccounts(() => {
            this.serverCache.clear();
            this.refresh();
        });
    }

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined);
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

        // Server children: show info details
        if (element.nodeType === 'server' && element.server) {
            return this.getServerInfoItems(element.server);
        }

        return [];
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
        // Check cache first
        if (this.serverCache.has(account.id)) {
            const servers = this.serverCache.get(account.id)!;
            if (servers.length === 0) {
                return [new ServerTreeItem('No servers found', 'empty', vscode.TreeItemCollapsibleState.None)];
            }
            return servers.map(
                server => new ServerTreeItem(
                    server.name,
                    'server',
                    vscode.TreeItemCollapsibleState.Collapsed, // Collapsed to show info children
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

    dispose(): void {
        this._onDidChangeTreeData.dispose();
    }
}
