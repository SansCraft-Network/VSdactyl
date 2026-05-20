import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as tar from 'tar';
import { Writable } from 'stream';
import { installVscodeTestShim } from './testSupport/vscodeShim';

installVscodeTestShim();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TransferOrchestrator } = require('./transferOrchestrator') as typeof import('./transferOrchestrator');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TransferManager } = require('./transferManager') as typeof import('./transferManager');

class FakeSftpClient {
    constructor(private readonly rootDir: string, private readonly mode: 'ok' | 'missing' | 'denied' | 'disconnect' | 'slow' = 'ok') {}

    async writeFileStream(remotePath: string): Promise<NodeJS.WritableStream> {
        if (this.mode === 'disconnect') {
            throw new Error('Connection lost');
        }

        const absolutePath = this.resolve(remotePath);
        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        if (this.mode === 'slow') {
            return new Writable({
                write(_chunk, _encoding, callback) {
                    setTimeout(callback, 25);
                },
                final(callback) {
                    setTimeout(callback, 25);
                },
            });
        }
        return fs.createWriteStream(absolutePath);
    }

    async readFileStream(remotePath: string): Promise<NodeJS.ReadableStream> {
        if (this.mode === 'missing') {
            throw new Error('File not found');
        }

        if (this.mode === 'disconnect') {
            throw new Error('Connection lost');
        }

        return fs.createReadStream(this.resolve(remotePath));
    }

    async exec(command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
        if (this.mode === 'denied') {
            throw new Error('Permission denied');
        }

        if (this.mode === 'disconnect') {
            throw new Error('Connection lost');
        }

        const archiveMatch = command.match(/-czf\s+"([^"]+)"/);
        if (archiveMatch) {
            const archivePath = this.resolve(archiveMatch[1]);
            const sourceMatch = command.match(/-C\s+"([^"]+)"\s+\./);
            if (sourceMatch) {
                await tar.create({ gzip: true, file: archivePath, cwd: this.resolve(sourceMatch[1]) }, ['.']);
                return { stdout: '', stderr: '', exitCode: 0 };
            }
        }

        return { stdout: '', stderr: '', exitCode: 0 };
    }

    async delete(remotePath: string): Promise<void> {
        await fs.promises.rm(this.resolve(remotePath), { force: true });
    }

    private resolve(remotePath: string): string {
        return path.join(this.rootDir, remotePath.replace(/^\//, ''));
    }
}

async function makeTempDir(prefix: string): Promise<string> {
    return await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFile(filePath: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, content);
}

test('multi-file upload creates one session with aggregated progress', async () => {
    const localRoot = await makeTempDir('vsdactyl-local-');
    const remoteRoot = await makeTempDir('vsdactyl-remote-');
    await writeFile(path.join(localRoot, 'alpha.txt'), 'alpha');
    await writeFile(path.join(localRoot, 'beta.txt'), 'beta-beta');

    const manager = TransferManager.getInstance({} as any);
    const orchestrator = new TransferOrchestrator(manager);
    const session = await orchestrator.upload({
        localUris: [
            { fsPath: path.join(localRoot, 'alpha.txt') } as any,
            { fsPath: path.join(localRoot, 'beta.txt') } as any,
        ],
        remoteDestinationPath: '/',
        sftpClient: new FakeSftpClient(remoteRoot) as any,
        serverIdentifier: 'server-a',
    });

    assert.equal(session.mode, 'multi');
    assert.equal(session.fileCountTotal, 2);
    assert.equal(session.fileCountCompleted, 2);
    assert.equal(session.bytesTransferred, session.bytesTotal);
    assert.equal(manager['sessions'].get(session.id)?.status, 'completed');
});

test('folder upload uses bulk mode and completes session', async () => {
    const localRoot = await makeTempDir('vsdactyl-local-');
    const remoteRoot = await makeTempDir('vsdactyl-remote-');
    const folder = path.join(localRoot, 'folder');
    await writeFile(path.join(folder, 'nested', 'gamma.txt'), 'gamma data');

    const manager = TransferManager.getInstance({} as any);
    const orchestrator = new TransferOrchestrator(manager);
    const session = await orchestrator.upload({
        localUris: [{ fsPath: folder } as any],
        remoteDestinationPath: '/',
        sftpClient: new FakeSftpClient(remoteRoot) as any,
        pteroClient: {
            decompressFile: async () => undefined,
            deleteFiles: async () => undefined,
        } as any,
        serverIdentifier: 'server-b',
    });

    assert.equal(session.mode, 'bulk');
    assert.equal(session.status, 'completed');
    assert.equal(session.fileCountCompleted, session.fileCountTotal);
});

test('folder download uses bulk mode and completes session', async () => {
    const localRoot = await makeTempDir('vsdactyl-download-');
    const remoteRoot = await makeTempDir('vsdactyl-remote-');
    const remoteSource = path.join(remoteRoot, 'source');
    await writeFile(path.join(remoteSource, 'content.txt'), 'download me');

    const manager = TransferManager.getInstance({} as any);
    const orchestrator = new TransferOrchestrator(manager);
    const session = await orchestrator.download({
        remoteSourcePath: '/source',
        remoteArchiveName: 'archive.tar.gz',
        localDestinationPath: localRoot,
        sftpClient: new FakeSftpClient(remoteRoot) as any,
        serverIdentifier: 'server-c',
    });

    assert.equal(session.mode, 'bulk');
    assert.equal(session.status, 'completed');
});

test('cancellation marks the child and session as cancelled', async () => {
    const localRoot = await makeTempDir('vsdactyl-cancel-');
    const remoteRoot = await makeTempDir('vsdactyl-remote-');
    await writeFile(path.join(localRoot, 'cancel.txt'), 'cancel me '.repeat(5000));

    const manager = TransferManager.getInstance({} as any);
    const orchestrator = new TransferOrchestrator(manager);
    const uploadPromise = orchestrator.upload({
        localUris: [{ fsPath: path.join(localRoot, 'cancel.txt') } as any],
        remoteDestinationPath: '/',
        sftpClient: new FakeSftpClient(remoteRoot, 'slow') as any,
        serverIdentifier: 'server-d',
    });

    await new Promise(resolve => setTimeout(resolve, 50));
    const session = Array.from((manager as any).sessions.values()).find((item: any) => item.serverIdentifier === 'server-d') as any;
    assert.ok(session);
    manager.cancelSession(session.id);

    await assert.rejects(uploadPromise);

    assert.equal(manager['sessions'].get(session.id)?.status, 'cancelled');
});

test('transfer failures propagate into session failure state', async () => {
    const localRoot = await makeTempDir('vsdactyl-failure-');
    const remoteRoot = await makeTempDir('vsdactyl-remote-');
    await writeFile(path.join(localRoot, 'missing.txt'), 'present');

    const manager = TransferManager.getInstance({} as any);
    const orchestrator = new TransferOrchestrator(manager);
    await assert.rejects(async () => orchestrator.upload({
        localUris: [{ fsPath: path.join(localRoot, 'missing.txt') } as any],
        remoteDestinationPath: '/',
        sftpClient: new FakeSftpClient(remoteRoot, 'disconnect') as any,
        serverIdentifier: 'server-e',
    }));
});
