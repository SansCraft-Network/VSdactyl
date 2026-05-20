import test from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { installVscodeTestShim } from '../transfers/testSupport/vscodeShim';

installVscodeTestShim();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const vscode = require('vscode');

// Mock workspace folders
const tempWorkspaceDir = path.join(__dirname, 'temp_workspace');
if (!fs.existsSync(tempWorkspaceDir)) {
    fs.mkdirSync(tempWorkspaceDir);
}
vscode.workspace.workspaceFolders = [
    {
        uri: vscode.Uri.file(tempWorkspaceDir),
        name: 'temp',
        index: 0
    }
];

// Mock workspace configuration
vscode.workspace.getConfiguration = () => {
    return {
        get: (key: string, defaultValue: any) => {
            if (key === 'agentBridge.enabled') return true;
            if (key === 'agentBridge.port') return 0; // dynamic port
            return defaultValue;
        }
    };
};

import { activateAgentBridge } from './agentBridge';
import { AccountManager } from '../accounts/accountManager';

// Mock context for VS Code extension development
function createMockContext() {
    return {
        subscriptions: [],
        globalState: {
            get: () => [],
            update: async () => {}
        }
    } as any;
}

test('Agent Bridge starts up, writes token, and responds to API requests', async () => {
    const context = createMockContext();
    const accountManager = new AccountManager(context);
    
    // Mock server tree provider
    const serverTreeProvider = {
        findServer: async () => null
    } as any;
    
    activateAgentBridge(context, accountManager, serverTreeProvider);
    
    // Wait for the server to spin up and write the token file
    const tokenPath = path.join(tempWorkspaceDir, '.vsdactyl-token.json');
    let tokenData: any;
    
    for (let i = 0; i < 20; i++) {
        if (fs.existsSync(tokenPath)) {
            try {
                tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
                break;
            } catch (e) {
                // ignore and wait
            }
        }
        await new Promise(r => setTimeout(r, 100));
    }
    
    assert.ok(tokenData, 'Token file should have been written to the workspace');
    assert.ok(tokenData.port > 0, 'Port must be a valid positive integer');
    assert.ok(tokenData.token, 'Token must be present');
    
    // 1. Try request with no Authorization header (401)
    const req1 = await makePostRequest(tokenData.port, '/api/list_servers', {}, null);
    assert.strictEqual(req1.statusCode, 401);
    
    // 2. Try request with invalid Authorization header (401)
    const req2 = await makePostRequest(tokenData.port, '/api/list_servers', {}, 'invalid-token');
    assert.strictEqual(req2.statusCode, 401);
    
    // 3. Try request with valid Authorization header (200)
    const req3 = await makePostRequest(tokenData.port, '/api/list_servers', {}, tokenData.token);
    assert.strictEqual(req3.statusCode, 200);
    const body3 = JSON.parse(req3.body);
    assert.ok(Array.isArray(body3));
    
    // 4. Try 404 route
    const req4 = await makePostRequest(tokenData.port, '/api/non_existent', {}, tokenData.token);
    assert.strictEqual(req4.statusCode, 404);
    
    // Clean up: dispose the context to shut down the server and delete token file
    for (const sub of context.subscriptions) {
        if (typeof sub.dispose === 'function') {
            sub.dispose();
        }
    }
    
    assert.ok(!fs.existsSync(tokenPath), 'Token file should be cleaned up on disposal');

    if (fs.existsSync(tempWorkspaceDir)) {
        fs.rmSync(tempWorkspaceDir, { recursive: true, force: true });
    }
});

// Helper for making HTTP POST requests
function makePostRequest(port: number, path: string, body: any, token: string | null): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const postData = JSON.stringify(body);
        const headers: any = {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        };
        if (token) {
            headers['Authorization'] = `Bearer ${token}`;
        }
        
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            path,
            method: 'POST',
            headers
        }, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
                resolve({ statusCode: res.statusCode || 500, body: resData });
            });
        });
        
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}
