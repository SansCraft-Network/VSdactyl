import * as vscode from 'vscode';
import { PteroAccount, ExportedAccountData } from './types';

const ACCOUNTS_KEY = 'pterodactyl.accounts';
const PRIVATE_KEY_SECRET_PREFIX = 'ptero_privatekey_';
const PANEL_PASSWORD_SECRET_PREFIX = 'ptero_panel_password_';

export class AccountManager {
    private context: vscode.ExtensionContext;
    private _onDidChangeAccounts = new vscode.EventEmitter<void>();
    readonly onDidChangeAccounts = this._onDidChangeAccounts.event;

    constructor(context: vscode.ExtensionContext) {
        this.context = context;
        this.migrateSecrets().catch(err => console.error('Migration error', err));
    }

    private async migrateSecrets(): Promise<void> {
        const accounts = this.context.globalState.get<any[]>(ACCOUNTS_KEY, []);
        let needsUpdate = false;
        
        for (const acc of accounts) {
            let hasGlobalStateSecrets = false;
            
            if (acc.apiKey) {
                await this.context.secrets.store('ptero_apikey_' + acc.id, acc.apiKey);
                delete acc.apiKey;
                hasGlobalStateSecrets = true;
            }
            if (acc.password) {
                await this.context.secrets.store('ptero_password_' + acc.id, acc.password);
                delete acc.password;
                hasGlobalStateSecrets = true;
            }
            if (acc.panelPassword) {
                await this.context.secrets.store(PANEL_PASSWORD_SECRET_PREFIX + acc.id, acc.panelPassword);
                delete acc.panelPassword;
                hasGlobalStateSecrets = true;
            }
            if (acc.privateKeyData) {
                await this.context.secrets.store(PRIVATE_KEY_SECRET_PREFIX + acc.id, acc.privateKeyData);
                acc.privateKeyData = '';
                hasGlobalStateSecrets = true;
            }
            
            if (!acc.type) {
                acc.type = 'pterodactyl';
                needsUpdate = true;
            }
            if (acc.branding !== 'SansCraft Network Corp') {
                acc.branding = 'SansCraft Network Corp';
                needsUpdate = true;
            }

            if (hasGlobalStateSecrets) {
                needsUpdate = true;
            }
        }
        
        if (needsUpdate) {
            await this.context.globalState.update(ACCOUNTS_KEY, accounts);
        }
    }

    async getAccounts(): Promise<PteroAccount[]> {
        const accounts = this.context.globalState.get<any[]>(ACCOUNTS_KEY, []);
        const enrichedAccounts: PteroAccount[] = [];
        
        for (const acc of accounts) {
            const enriched = { ...acc };
            enriched.branding = 'SansCraft Network Corp';
            
            if (enriched.type === 'pterodactyl') {
                const apiKey = await this.context.secrets.get('ptero_apikey_' + acc.id);
                if (apiKey) enriched.apiKey = apiKey;
            }
            const password = await this.context.secrets.get('ptero_password_' + acc.id);
            if (password) enriched.password = password;
            const panelPassword = await this.context.secrets.get(PANEL_PASSWORD_SECRET_PREFIX + acc.id);
            if (panelPassword) enriched.panelPassword = panelPassword;
            const privateKeyData = await this.context.secrets.get(PRIVATE_KEY_SECRET_PREFIX + acc.id);
            if (privateKeyData) enriched.privateKeyData = privateKeyData;
            
            enrichedAccounts.push(enriched as PteroAccount);
        }
        return enrichedAccounts;
    }

    async addAccount(account: PteroAccount): Promise<void> {
        account.type = account.type || 'pterodactyl';
        account.branding = 'SansCraft Network Corp';
        
        if (account.type === 'pterodactyl') {
            if (account.apiKey) {
                await this.context.secrets.store('ptero_apikey_' + account.id, account.apiKey);
            }
            if ((account as any).panelPassword) {
                await this.context.secrets.store(PANEL_PASSWORD_SECRET_PREFIX + account.id, (account as any).panelPassword);
            }
        }
        
        if (account.password) {
            await this.context.secrets.store('ptero_password_' + account.id, account.password);
        }
        if (account.privateKeyData) {
            await this.context.secrets.store(PRIVATE_KEY_SECRET_PREFIX + account.id, account.privateKeyData);
        }
        
        const safeAccount = { ...account } as any;
        delete safeAccount.apiKey;
        delete safeAccount.password;
        delete safeAccount.panelPassword;
        safeAccount.privateKeyData = '';

        const accounts = this.context.globalState.get<any[]>(ACCOUNTS_KEY, []);
        accounts.push(safeAccount);
        await this.context.globalState.update(ACCOUNTS_KEY, accounts);
        this._onDidChangeAccounts.fire();
    }

    async editAccount(id: string, updated: Partial<PteroAccount>): Promise<void> {
        const accounts = this.context.globalState.get<any[]>(ACCOUNTS_KEY, []);
        const index = accounts.findIndex(a => a.id === id);
        if (index === -1) throw new Error('Account not found: ' + id);

        if (!updated.type) {
            updated.type = accounts[index].type || 'pterodactyl';
        }
        
        const merged = { ...accounts[index], ...updated } as any;
        merged.branding = 'SansCraft Network Corp';

        if (merged.apiKey) {
            await this.context.secrets.store('ptero_apikey_' + id, merged.apiKey);
            delete merged.apiKey;
        }
        if (merged.password) {
            await this.context.secrets.store('ptero_password_' + id, merged.password);
            delete merged.password;
        }
        if (merged.panelPassword) {
            await this.context.secrets.store(PANEL_PASSWORD_SECRET_PREFIX + id, merged.panelPassword);
            delete merged.panelPassword;
        } else if (merged.type === 'pterodactyl') {
            await this.context.secrets.delete(PANEL_PASSWORD_SECRET_PREFIX + id);
        }
        if (merged.privateKeyData) {
            await this.context.secrets.store(PRIVATE_KEY_SECRET_PREFIX + id, merged.privateKeyData);
            merged.privateKeyData = '';
        } else {
            await this.context.secrets.delete(PRIVATE_KEY_SECRET_PREFIX + id);
        }

        accounts[index] = merged;
        await this.context.globalState.update(ACCOUNTS_KEY, accounts);
        this._onDidChangeAccounts.fire();
    }

    async removeAccount(id: string): Promise<void> {
        const accounts = this.context.globalState.get<any[]>(ACCOUNTS_KEY, []);
        const newAccounts = accounts.filter(a => a.id !== id);
        await this.context.globalState.update(ACCOUNTS_KEY, newAccounts);
        
        await this.context.secrets.delete('ptero_apikey_' + id);
        await this.context.secrets.delete('ptero_password_' + id);
        await this.context.secrets.delete(PANEL_PASSWORD_SECRET_PREFIX + id);
        await this.context.secrets.delete(PRIVATE_KEY_SECRET_PREFIX + id);
        
        this._onDidChangeAccounts.fire();
    }

    async getAccountById(id: string): Promise<PteroAccount | undefined> {
        const accounts = await this.getAccounts();
        return accounts.find(a => a.id === id);
    }

    async exportAccounts(): Promise<void> {
        const accounts = await this.getAccounts();
        if (accounts.length === 0) {
            vscode.window.showWarningMessage('No accounts to export.');
            return;
        }

        const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file('vsdactyl-accounts.json'),
            filters: { 'JSON Files': ['json'] },
            title: 'Export VSDactyl Accounts',
        });

        if (!uri) {
            return;
        }

        const exportData: ExportedAccountData = {
            version: '2.0.0',
            exportedAt: new Date().toISOString(),
            accounts: accounts
        };

        const content = Buffer.from(JSON.stringify(exportData, null, 2), 'utf-8');
        await vscode.workspace.fs.writeFile(uri, content);
        vscode.window.showInformationMessage(`Exported ${accounts.length} account(s) successfully.`);
    }

    async importAccounts(): Promise<void> {
        const uris = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'JSON Files': ['json'] },
            title: 'Import VSDactyl Accounts',
        });

        if (!uris || uris.length === 0) {
            return;
        }

        try {
            const content = await vscode.workspace.fs.readFile(uris[0]);
            const importData = JSON.parse(Buffer.from(content).toString('utf-8')) as ExportedAccountData;

            if (!importData.accounts || !Array.isArray(importData.accounts)) {
                vscode.window.showErrorMessage('Invalid import file format.');
                return;
            }

            const existingAccounts = await this.getAccounts();
            const existingIds = new Set(existingAccounts.map(a => a.id));

            let imported = 0;
            let skipped = 0;

            for (const account of importData.accounts as any[]) {
                if (!account.type) {
                    if (account.panelUrl) {
                        account.type = 'pterodactyl';
                    } else if (account.host) {
                        account.type = 'sftpOnly';
                    }
                }
                
                if (!account.id || (account.type === 'pterodactyl' && !account.panelUrl)) {
                    skipped++;
                    continue;
                }

                if (existingIds.has(account.id)) {
                    // Ask whether to overwrite
                    const choice = await vscode.window.showQuickPick(
                        ['Overwrite', 'Skip', 'Skip All Duplicates'],
                        { placeHolder: `Account "${account.name}" already exists. What to do?` }
                    );

                    if (choice === 'Skip' || !choice) {
                        skipped++;
                        continue;
                    }
                    if (choice === 'Skip All Duplicates') {
                        skipped += importData.accounts.length - imported - skipped;
                        break;
                    }
                    // Overwrite
                    await this.editAccount(account.id, account);
                    imported++;
                } else {
                    await this.addAccount(account);
                    imported++;
                }
            }

            vscode.window.showInformationMessage(
                `Import complete: ${imported} imported, ${skipped} skipped.`
            );
        } catch (err: any) {
            vscode.window.showErrorMessage(`Failed to import: ${err.message}`);
        }
    }

    generateId(): string {
        return `ptero_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    dispose(): void {
        this._onDidChangeAccounts.dispose();
    }
}
