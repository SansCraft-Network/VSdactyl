import test from 'node:test';
import assert from 'node:assert/strict';
import { installVscodeTestShim } from '../transfers/testSupport/vscodeShim';

installVscodeTestShim();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ServerTreeDragAndDropController } = require('./serverTreeProvider') as typeof import('./serverTreeProvider');

test('handleDrop routes file:// URIs to uploadToNode, ptero:// URIs on same server to moveOnNode, and different server URIs to transferBetweenServers', async () => {
    const controller = new ServerTreeDragAndDropController();

    const called: string[] = [];
    // stub executeCommand
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const vscode = require('vscode');
    const originalExec = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (cmd: string, ...args: any[]) => {
        called.push(cmd);
        return Promise.resolve(true);
    };

    const fakeTarget = { label: 'server', server: { identifier: 'srv123' }, account: { type: 'pterodactyl' } };

    // file:// URIs
    const fileList = 'file:///C:/tmp/a.txt\r\nfile:///C:/tmp/b.txt';
    const filesItem = { asString: async () => fileList };
    const dataTransfer = { get: (k: string) => k === 'text/uri-list' ? filesItem : undefined };

    await controller.handleDrop(fakeTarget as any, dataTransfer as any);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(called.includes('pterodactyl.uploadToNode'));

    // reset
    called.length = 0;

    // ptero:// URIs on same server
    const remoteList = 'ptero://srv123/var/log/foo.log';
    const remoteItem = { asString: async () => remoteList };
    const dataTransfer2 = { get: (k: string) => k === 'text/uri-list' ? remoteItem : undefined };

    await controller.handleDrop(fakeTarget as any, dataTransfer2 as any);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(called.includes('pterodactyl.moveOnNode'));

    // reset
    called.length = 0;

    // ptero:// URIs on different server
    const diffRemoteList = 'ptero://srv456/var/log/bar.log';
    const diffRemoteItem = { asString: async () => diffRemoteList };
    const dataTransfer3 = { get: (k: string) => k === 'text/uri-list' ? diffRemoteItem : undefined };

    await controller.handleDrop(fakeTarget as any, dataTransfer3 as any);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(called.includes('pterodactyl.transferBetweenServers'));

    // reset
    called.length = 0;

    // OS Files drop (external drag and drop)
    const mockFileItem = {
        asFile: () => ({
            name: 'a.txt',
            uri: vscode.Uri.file('C:/tmp/a.txt')
        }),
        asString: async () => ''
    };
    const dataTransfer4 = {
        get: (k: string) => undefined,
        [Symbol.iterator]: function* () {
            yield ['Files', mockFileItem];
        }
    };

    await controller.handleDrop(fakeTarget as any, dataTransfer4 as any);
    await new Promise(r => setTimeout(r, 10));
    assert.ok(called.includes('pterodactyl.uploadToNode'));

    // restore
    vscode.commands.executeCommand = originalExec;
});

test('handleDrop filters out root server/account drops to prevent accidental full-server syncs/renames', async () => {
    const controller = new ServerTreeDragAndDropController();

    const called: string[] = [];
    const vscode = require('vscode');
    const originalExec = vscode.commands.executeCommand;
    vscode.commands.executeCommand = (cmd: string, ...args: any[]) => {
        called.push(cmd);
        return Promise.resolve(true);
    };

    const fakeTarget = { label: 'server', server: { identifier: 'srv123' }, account: { type: 'pterodactyl' } };

    // ptero:// URIs on same server but with root path '/' (e.g. dragging the whole server)
    const remoteList = 'ptero://srv123/\r\nptero://srv456/';
    const remoteItem = { asString: async () => remoteList };
    const dataTransfer = { get: (k: string) => k === 'text/uri-list' ? remoteItem : undefined };

    await controller.handleDrop(fakeTarget as any, dataTransfer as any);
    await new Promise(r => setTimeout(r, 10));
    // Should NOT trigger moveOnNode or transferBetweenServers
    assert.strictEqual(called.length, 0);

    // restore
    vscode.commands.executeCommand = originalExec;
});

