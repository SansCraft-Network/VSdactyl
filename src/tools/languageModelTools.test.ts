import test from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeTestShim } from '../transfers/testSupport/vscodeShim';

installVscodeTestShim();

test('languageModelTools registers tools when vscode.lm is supported', () => {
    const vscode = require('vscode');
    const registeredTools = new Map<string, any>();
    
    vscode.lm = {
        registerTool: (name: string, impl: any) => {
            registeredTools.set(name, impl);
            return { dispose() {} };
        }
    };
    
    // Stub class implementations
    const mockContext = {
        subscriptions: []
    } as any;
    
    const mockAccountManager = {} as any;
    const mockServerTreeProvider = {} as any;
    
    const { registerLanguageModelTools } = require('./languageModelTools');
    registerLanguageModelTools(mockContext, mockAccountManager, mockServerTreeProvider);
    
    assert.ok(registeredTools.has('vsdactyl_list_servers'));
    assert.ok(registeredTools.has('vsdactyl_list_files'));
    assert.ok(registeredTools.has('vsdactyl_read_file'));
    assert.ok(registeredTools.has('vsdactyl_write_file'));
    assert.ok(registeredTools.has('vsdactyl_send_command'));
    assert.ok(registeredTools.has('vsdactyl_archive_operation'));
    
    // Clean up
    delete vscode.lm;
});
