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
        const logoUri = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'icon.png'));

        return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><title>SFTP Account</title>
        <style>
        :root{--sc-bg:#081622;--sc-panel:#0f2638;--sc-input:#0b1d2c;--sc-border:rgba(10,58,102,.45);--sc-primary:#0a3a66;--sc-primary-hover:#073b61;--sc-text:#f4f1e6;--sc-muted:rgba(244,241,230,.72);--sc-cyan:#24e8f5}
        *{box-sizing:border-box}
        body{font-family:'Inter','Segoe UI',system-ui,sans-serif;margin:0;padding:36px 20px;color:var(--sc-text);background:radial-gradient(circle at top left,rgba(36,232,245,.14),transparent 32%),radial-gradient(circle at bottom right,rgba(10,58,102,.34),transparent 44%),linear-gradient(180deg,#07111c 0%,var(--sc-bg) 100%);min-height:100vh}
        .container{max-width:640px;margin:0 auto;background:linear-gradient(180deg,rgba(15,38,56,.96),rgba(8,22,34,.98));padding:28px;border:1px solid var(--sc-border);border-radius:16px;box-shadow:0 20px 50px rgba(0,0,0,.35)}
        h2{display:flex;align-items:center;gap:12px;margin:0 0 18px 0;font-size:24px;font-weight:800;border-bottom:2px solid var(--sc-border);padding-bottom:12px}
        .brand-mark{width:42px;height:42px;border-radius:10px;padding:6px;background:rgba(255,255,255,.04);box-shadow:0 0 0 1px rgba(255,255,255,.06) inset}
        label{display:block;margin-top:12px;margin-bottom:6px;font-size:12px;font-weight:700;letter-spacing:.45px;text-transform:uppercase;color:var(--sc-muted)}
        input,textarea,select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--sc-border);background:var(--sc-input);color:#fff;outline:none;transition:all .2s}
        input:focus,textarea:focus,select:focus{border-color:var(--sc-primary);box-shadow:0 0 0 2px rgba(36,232,245,.22)}
        textarea{min-height:96px;font-family:'JetBrains Mono','Courier New',monospace}
        button{margin-top:14px;padding:9px 14px;border-radius:8px;border:1px solid var(--sc-border);cursor:pointer}
        .primary{background:var(--sc-primary);color:#fff;box-shadow:0 8px 18px rgba(10,58,102,.34)}
        .primary:hover{background:var(--sc-primary-hover)}
        .secondary{background:transparent;color:var(--sc-text)}
        .secondary:hover{background:rgba(255,255,255,.05)}
        .row{display:flex;gap:10px}.col{flex:1}
        .actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;padding-top:14px;border-top:1px solid var(--sc-border)}
        </style>
        </head><body><div class="container">
        <h2><img class="brand-mark" src="${logoUri}" alt="VSDactyl"/> ${editAccount ? 'Edit SFTP Account' : 'Add SFTP Account'}</h2>
        <label>Display Name</label><input id="name" value="${this.escapeHtml(name)}" />
        <label>Host</label><input id="host" value="${this.escapeHtml(host)}" placeholder="sftp.example.com" />
        <div class="row"><div class="col"><label>Port</label><input id="port" value="${this.escapeHtml(port)}" /></div><div class="col"><label>Username</label><input id="username" value="${this.escapeHtml(username)}" /></div></div>
        <label>Auth Method</label>
        <select id="authMethod">
            <option value="ssh-key" ${sftpAuthMethod === 'ssh-key' ? 'selected' : ''}>SSH Key</option>
            <option value="password" ${sftpAuthMethod === 'password' ? 'selected' : ''}>Password</option>
        </select>

        <div id="sshSection" style="display:${sftpAuthMethod === 'ssh-key' ? 'block' : 'none'}">
            <label>Private Key Path</label>
            <div style="display:flex;gap:8px"><input id="privateKeyPath" value="${this.escapeHtml(privateKeyPath)}" /><button onclick="browseKey()" type="button">Browse</button></div>
            <label style="margin-top:8px">Or Paste Private Key</label>
            <textarea id="privateKeyData" style="min-height:90px">${this.escapeHtml(privateKeyData)}</textarea>
        </div>

        <div id="passwordSection" style="display:${sftpAuthMethod === 'password' ? 'block' : 'none'}">
            <label>Password</label>
            <input id="password" type="password" />
        </div>

        <div class="actions"><button class="secondary" onclick="cancel()">Cancel</button><button class="primary" onclick="submit()">${editAccount ? 'Save' : 'Add'}</button></div>

        </div>

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
