import * as vscode from 'vscode';
import { SftpOnlyAccount } from '../accounts/types';
import { Logger } from '../utils/logger';

export class SftpAccountFormPanel {
    private static currentPanel: SftpAccountFormPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];

    private constructor(
        panel: vscode.WebviewPanel,
        private readonly extensionUri: vscode.Uri,
        private readonly onSubmit: (account: Omit<SftpOnlyAccount, 'id'>) => void,
        editAccount?: Omit<SftpOnlyAccount, 'id'>,
    ) {
        this.panel = panel;
        this.panel.webview.html = this.getHtml(editAccount);

        this.panel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'submit':
                    this.onSubmit(message.data);
                    this.panel.dispose();
                    break;
                case 'cancel':
                    this.panel.dispose();
                    break;
                case 'browseKey':
                    const uris = await vscode.window.showOpenDialog({
                        canSelectMany: false,
                        openLabel: 'Select SSH Private Key',
                        title: 'Select SSH Private Key File',
                        filters: { 'All Files': ['*'] },
                    });
                    if (uris && uris.length > 0) {
                        this.panel.webview.postMessage({ command: 'setKeyPath', path: uris[0].fsPath });
                    }
                    break;
            }
        }, null, this.disposables);

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    }

    static show(extensionUri: vscode.Uri, onSubmit: (account: Omit<SftpOnlyAccount, 'id'>) => void, editAccount?: Omit<SftpOnlyAccount, 'id'>) {
        if (SftpAccountFormPanel.currentPanel) {
            SftpAccountFormPanel.currentPanel.panel.reveal();
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'sftpAccountForm',
            editAccount ? `Edit: ${editAccount.name}` : 'Add SFTP Account',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true }
        );

        SftpAccountFormPanel.currentPanel = new SftpAccountFormPanel(panel, extensionUri, onSubmit, editAccount);
    }

    private getHtml(editAccount?: Omit<SftpOnlyAccount, 'id'>): string {
        const name = editAccount?.name || '';
        const host = editAccount?.host || '';
        const port = editAccount?.port?.toString() || '22';
        const username = editAccount?.username || '';
        const sftpAuthMethod = editAccount?.sftpAuthMethod || 'ssh-key';
        const privateKeyPath = editAccount?.privateKeyPath || '';
        const privateKeyData = editAccount?.privateKeyData || '';
        const logoUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'logo.svg'));

        return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>SFTP Account</title>
        <style>body{font-family:system-ui,Segoe UI,Helvetica,Arial;margin:18px;color:#eaeaea;background:#07111c}label{display:block;margin-top:12px;font-size:13px}input,textarea,select{width:100%;padding:8px;margin-top:6px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:#091826;color:#fff}button{margin-top:14px;padding:8px 12px;border-radius:6px} .row{display:flex;gap:8px} .col{flex:1}</style>
        </head><body>
        <h2><img src="${logoUri}" style="width:34px;vertical-align:middle;margin-right:8px"/> ${editAccount ? 'Edit SFTP Account' : 'Add SFTP Account'}</h2>
        <label>Display Name</label><input id="name" value="${this.escapeHtml(name)}" />
        <label>Host</label><input id="host" value="${this.escapeHtml(host)}" placeholder="sftp.example.com" />
        <div class="row"><div class="col"><label>Port</label><input id="port" value="${this.escapeHtml(port)}" /></div><div class="col"><label>Username</label><input id="username" value="${this.escapeHtml(username)}" /></div></div>
        <label>Auth Method</label>
        <select id="authMethod">
            <option value="ssh-key" ${sftpAuthMethod === 'ssh-key' ? 'selected' : ''}>SSH Key</option>
            <option value="password" ${sftpAuthMethod === 'password' ? 'selected' : ''}>Password</option>
        </select>

        <div id="sshSection">
            <label>Private Key Path</label>
            <div style="display:flex;gap:8px"><input id="privateKeyPath" value="${this.escapeHtml(privateKeyPath)}" /><button onclick="browseKey()" type="button">Browse</button></div>
            <label style="margin-top:8px">Or Paste Private Key</label>
            <textarea id="privateKeyData" style="min-height:90px">${this.escapeHtml(privateKeyData)}</textarea>
        </div>

        <div id="passwordSection" style="display:none">
            <label>Password</label>
            <input id="password" type="password" />
        </div>

        <div style="display:flex;justify-content:flex-end;gap:8px"><button onclick="cancel()">Cancel</button><button onclick="submit()">${editAccount ? 'Save' : 'Add'}</button></div>

        <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('authMethod').addEventListener('change', (e)=>{
            const v = e.target.value;
            document.getElementById('sshSection').style.display = v==='ssh-key' ? 'block' : 'none';
            document.getElementById('passwordSection').style.display = v==='password' ? 'block' : 'none';
        });
        function browseKey(){ vscode.postMessage({command:'browseKey'}); }
        window.addEventListener('message', e=>{ if(e.data.command==='setKeyPath'){ document.getElementById('privateKeyPath').value = e.data.path; } });
        function submit(){
            const name = document.getElementById('name').value.trim();
            const host = document.getElementById('host').value.trim();
            const port = parseInt(document.getElementById('port').value||'22',10);
            const username = document.getElementById('username').value.trim();
            const auth = document.getElementById('authMethod').value;
            const privateKeyPath = document.getElementById('privateKeyPath').value.trim();
            const privateKeyData = document.getElementById('privateKeyData').value.trim();
            const password = document.getElementById('password').value;
            if(!name||!host||!username){ alert('Name, host and username are required'); return; }
            vscode.postMessage({ command:'submit', data:{ name, host, port, username, sftpAuthMethod: auth, privateKeyPath: privateKeyPath, privateKeyData: privateKeyData, password: password } });
        }
        function cancel(){ vscode.postMessage({command:'cancel'}); }
        </script>
        </body></html>`;
    }

    private escapeHtml(text: string): string {
        return String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    private dispose(): void {
        SftpAccountFormPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const d = this.disposables.pop();
            d?.dispose();
        }
    }
}
