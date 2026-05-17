import * as vscode from 'vscode';

type SyncState = 'syncing' | 'error';

export class RemoteFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private readonly states = new Map<string, SyncState>();

    constructor() {
        // Listen to configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('vsdactyl.pterodactylIcon') || e.affectsConfiguration('vsdactyl.sftpIcon')) {
                // Fire change event for all open folders to refresh decorations
                const folders = vscode.workspace.workspaceFolders || [];
                const uris: vscode.Uri[] = [];
                for (const folder of folders) {
                    if (folder.uri.scheme === 'ptero' || folder.uri.scheme === 'sftp') {
                        uris.push(folder.uri);
                    }
                }
                if (uris.length > 0) {
                    this._onDidChangeFileDecorations.fire(uris);
                }
            }
        });
    }

    provideFileDecoration(uri: vscode.Uri): vscode.ProviderResult<vscode.FileDecoration> {
        if (uri.scheme !== 'ptero' && uri.scheme !== 'sftp') {
            return;
        }

        const key = uri.toString();
        const state = this.states.get(key);

        if (state === 'syncing') {
            return {
                badge: '~',
                tooltip: 'Syncing remote changes',
                color: new vscode.ThemeColor('charts.yellow'),
            };
        }

        if (state === 'error') {
            return {
                badge: '!',
                tooltip: 'Last sync operation failed',
                color: new vscode.ThemeColor('errorForeground'),
            };
        }

        const isPtero = uri.scheme === 'ptero';
        const config = vscode.workspace.getConfiguration('vsdactyl');
        const badge = isPtero ? 
            (config.get<string>('pterodactylIcon.badge') || 'P') : 
            (config.get<string>('sftpIcon.badge') || 'S');
        const colorKey = isPtero ?
            config.get<string>('pterodactylIcon.color') || 'descriptionForeground' :
            config.get<string>('sftpIcon.color') || 'descriptionForeground';

        return {
            badge: badge || (isPtero ? 'P' : 'S'),
            tooltip: isPtero ? 'Remote panel filesystem' : 'Remote SFTP filesystem',
            color: colorKey ? new vscode.ThemeColor(colorKey) : new vscode.ThemeColor('descriptionForeground'),
        };
    }

    beginSync(uri: vscode.Uri): void {
        this.states.set(uri.toString(), 'syncing');
        this._onDidChangeFileDecorations.fire(uri);
    }

    completeSync(uri: vscode.Uri): void {
        this.states.delete(uri.toString());
        this._onDidChangeFileDecorations.fire(uri);
    }

    failSync(uri: vscode.Uri): void {
        this.states.set(uri.toString(), 'error');
        this._onDidChangeFileDecorations.fire(uri);

        setTimeout(() => {
            if (this.states.get(uri.toString()) === 'error') {
                this.states.delete(uri.toString());
                this._onDidChangeFileDecorations.fire(uri);
            }
        }, 5000);
    }

    dispose(): void {
        this.states.clear();
        this._onDidChangeFileDecorations.dispose();
    }
}
