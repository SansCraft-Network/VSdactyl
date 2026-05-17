import * as vscode from 'vscode';

type SyncState = 'syncing' | 'error';

export class RemoteFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[]>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    private readonly states = new Map<string, SyncState>();

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

        return {
            badge: uri.scheme === 'ptero' ? 'P' : 'S',
            tooltip: uri.scheme === 'ptero' ? 'Remote panel filesystem' : 'Remote SFTP filesystem',
            color: new vscode.ThemeColor('descriptionForeground'),
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
