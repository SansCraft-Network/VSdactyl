import test from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeTestShim } from '../transfers/testSupport/vscodeShim';

installVscodeTestShim();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

import { AccountManager } from './accountManager';
import { PteroAccount, SftpOnlyAccount } from './types';

// Mock context for VS Code extension development
function createMockContext() {
    const globalStateStore = new Map<string, any>();
    const secretsStore = new Map<string, string>();
    
    return {
        globalState: {
            get: (key: string, defaultValue?: any) => {
                return globalStateStore.has(key) ? globalStateStore.get(key) : defaultValue;
            },
            update: async (key: string, value: any) => {
                globalStateStore.set(key, value);
            }
        },
        secrets: {
            get: async (key: string) => secretsStore.get(key),
            store: async (key: string, value: string) => {
                secretsStore.set(key, value);
            },
            delete: async (key: string) => {
                secretsStore.delete(key);
            }
        },
        subscriptions: []
    } as any;
}

test('AccountManager preserves type on add and edit', async () => {
    const context = createMockContext();
    const manager = new AccountManager(context);

    // 1. Add SFTP account and check its type is preserved
    const sftpAccount: SftpOnlyAccount = {
        id: 'sftp_123',
        name: 'My SFTP',
        type: 'sftpOnly',
        username: 'sftpuser',
        host: 'sftp.example.com',
        port: 22,
        sftpAuthMethod: 'password',
        privateKeyPath: '',
        privateKeyData: '',
        password: 'securepassword',
    };

    await manager.addAccount(sftpAccount);

    let accounts = await manager.getAccounts();
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].type, 'sftpOnly');
    assert.strictEqual(accounts[0].name, 'My SFTP');

    // 2. Edit the SFTP account without passing a type property, check type is preserved
    await manager.editAccount('sftp_123', {
        name: 'Updated My SFTP',
    });

    accounts = await manager.getAccounts();
    assert.strictEqual(accounts.length, 1);
    assert.strictEqual(accounts[0].type, 'sftpOnly');
    assert.strictEqual(accounts[0].name, 'Updated My SFTP');

    // 3. Add Pterodactyl account and check it defaults to pterodactyl if type is missing
    const pteroAccount: any = {
        id: 'ptero_456',
        name: 'My Panel',
        username: 'ptero-user',
        panelUrl: 'https://panel.example.com',
        authMethod: 'api-key',
        apiKey: 'my-api-key',
        sftpAuthMethod: 'password',
        privateKeyPath: '',
        privateKeyData: '',
    };

    await manager.addAccount(pteroAccount);

    accounts = await manager.getAccounts();
    assert.strictEqual(accounts.length, 2);
    
    const pteroResult = accounts.find(a => a.id === 'ptero_456');
    assert.ok(pteroResult);
    assert.strictEqual(pteroResult.type, 'pterodactyl');

    // 4. Edit Pterodactyl account without passing type
    await manager.editAccount('ptero_456', {
        name: 'Updated My Panel',
    });
    
    accounts = await manager.getAccounts();
    const updatedPteroResult = accounts.find(a => a.id === 'ptero_456');
    assert.ok(updatedPteroResult);
    assert.strictEqual(updatedPteroResult.type, 'pterodactyl');
    assert.strictEqual(updatedPteroResult.name, 'Updated My Panel');
});

test('AccountManager imports SFTP accounts correctly and infers type', async () => {
    const context = createMockContext();
    const manager = new AccountManager(context);

    // Mock VS Code file system write / read (import/export)
    // and mock showOpenDialog to return our imported file
    const importData = {
        version: '2.0.0',
        exportedAt: new Date().toISOString(),
        accounts: [
            {
                id: 'import_sftp',
                name: 'Imported SFTP',
                host: 'import.sftp.com',
                port: 2222,
                username: 'importuser',
                sftpAuthMethod: 'password',
                privateKeyPath: '',
                privateKeyData: '',
            },
            {
                id: 'import_ptero',
                name: 'Imported Ptero',
                panelUrl: 'https://import.ptero.com',
                username: 'importptero',
                sftpAuthMethod: 'password',
                privateKeyPath: '',
                privateKeyData: '',
            }
        ]
    };

    const originalShowOpenDialog = vscode.window.showOpenDialog;
    vscode.window.showOpenDialog = async () => [vscode.Uri.file('dummy.json')];

    const originalWriteFile = vscode.workspace.fs.writeFile;
    const originalReadFile = vscode.workspace.fs.readFile;

    vscode.workspace.fs.readFile = async () => {
        return Buffer.from(JSON.stringify(importData));
    };

    try {
        await manager.importAccounts();
        
        const accounts = await manager.getAccounts();
        assert.strictEqual(accounts.length, 2);
        
        const sftpAcc = accounts.find(a => a.id === 'import_sftp');
        assert.ok(sftpAcc);
        assert.strictEqual(sftpAcc.type, 'sftpOnly');
        
        const pteroAcc = accounts.find(a => a.id === 'import_ptero');
        assert.ok(pteroAcc);
        assert.strictEqual(pteroAcc.type, 'pterodactyl');
    } finally {
        vscode.window.showOpenDialog = originalShowOpenDialog;
        vscode.workspace.fs.writeFile = originalWriteFile;
        vscode.workspace.fs.readFile = originalReadFile;
    }
});

test('AccountManager migrateSecrets corrects existing incorrectly-typed accounts', async () => {
    const context = createMockContext();
    
    // Seed globalState with accounts that need migration
    const legacySftpAcc = {
        id: 'legacy_sftp',
        name: 'Legacy SFTP',
        host: 'legacy.sftp.com',
        port: 22,
        username: 'legacyuser',
    };
    
    const incorrectSftpAcc = {
        id: 'incorrect_sftp',
        name: 'Incorrect SFTP',
        type: 'pterodactyl', // incorrect type, has host but no panelUrl, should be migrated to sftpOnly
        host: 'incorrect.sftp.com',
        port: 22,
        username: 'incorrectuser',
    };
    
    const normalPteroAcc = {
        id: 'normal_ptero',
        name: 'Normal Ptero',
        panelUrl: 'https://normal.ptero.com',
    };
    
    await context.globalState.update('pterodactyl.accounts', [
        legacySftpAcc,
        incorrectSftpAcc,
        normalPteroAcc
    ]);
    
    // Instantiating the manager runs migrateSecrets()
    const manager = new AccountManager(context);
    
    // Give it a moment to run migrateSecrets (which is async and called in constructor)
    await new Promise(r => setTimeout(r, 50));
    
    const accounts = await manager.getAccounts();
    assert.strictEqual(accounts.length, 3);
    
    const migratedLegacySftp = accounts.find(a => a.id === 'legacy_sftp');
    assert.ok(migratedLegacySftp);
    assert.strictEqual(migratedLegacySftp.type, 'sftpOnly');
    
    const migratedIncorrectSftp = accounts.find(a => a.id === 'incorrect_sftp');
    assert.ok(migratedIncorrectSftp);
    assert.strictEqual(migratedIncorrectSftp.type, 'sftpOnly');
    
    const migratedNormalPtero = accounts.find(a => a.id === 'normal_ptero');
    assert.ok(migratedNormalPtero);
    assert.strictEqual(migratedNormalPtero.type, 'pterodactyl');
});
