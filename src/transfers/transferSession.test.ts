import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateSessionProgress, cloneSession, createTransferChild, createTransferSession } from './transferSession';

test('createTransferSession starts with empty aggregates', () => {
    const session = createTransferSession({
        type: 'upload',
        serverIdentifier: 'server-1',
        title: 'Upload 2 files',
        mode: 'multi',
    });

    assert.equal(session.type, 'upload');
    assert.equal(session.serverIdentifier, 'server-1');
    assert.equal(session.fileCountTotal, 0);
    assert.equal(session.bytesTransferred, 0);
    assert.equal(session.status, 'running');
});

test('calculateSessionProgress uses byte totals when available', () => {
    const session = createTransferSession({
        type: 'download',
        serverIdentifier: 'server-2',
        title: 'Download archive',
        mode: 'bulk',
    });

    session.bytesTotal = 400;
    session.bytesTransferred = 100;

    assert.equal(calculateSessionProgress(session), 25);
});

test('cloneSession preserves structure without sharing nested children', () => {
    const session = createTransferSession({
        type: 'upload',
        serverIdentifier: 'server-3',
        title: 'Upload folder',
        mode: 'bulk',
    });
    const child = createTransferChild({
        label: 'file.txt',
        sourcePath: 'file.txt',
        targetPath: 'file.txt',
        bytesTotal: 12,
    });

    session.children.push(child);
    const cloned = cloneSession(session);

    assert.notEqual(cloned, session);
    assert.notEqual(cloned.children[0], session.children[0]);
    cloned.children[0].bytesTransferred = 8;
    assert.equal(session.children[0].bytesTransferred, 0);
});
