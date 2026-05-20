import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PterodactylClient } from '../api/pterodactylClient';
import { SftpClient } from '../sftp/sftpClient';
import { BulkTransferEngine, FileTreeEntry } from './bulkTransferEngine';
import {
    createTransferChild,
    createTransferSession,
    TransferChildOperation,
    TransferDirection,
    TransferMode,
    TransferSession,
    TransferSessionStore,
} from './transferSession';

export interface TransferOrchestrationOptions {
    bulkFileThreshold?: number;
    bulkSizeThresholdMb?: number;
    preferBulk?: boolean;
}

export interface UploadTransferRequest {
    localUris: vscode.Uri[];
    remoteDestinationPath: string;
    sftpClient: SftpClient;
    pteroClient?: PterodactylClient;
    serverIdentifier: string;
    options?: TransferOrchestrationOptions;
}

export interface DownloadTransferRequest {
    remoteSourcePath: string;
    remoteArchiveName: string;
    localDestinationPath: string;
    sftpClient: SftpClient;
    pteroClient?: PterodactylClient;
    serverIdentifier: string;
    options?: TransferOrchestrationOptions;
}

interface PlannedUploadItem {
    uri: vscode.Uri;
    relativePath: string;
    size: number;
}

export class TransferOrchestrator {
    constructor(
        private readonly sessions: TransferSessionStore,
        private readonly bulkEngine: BulkTransferEngine = new BulkTransferEngine(),
    ) {}

    async upload(request: UploadTransferRequest): Promise<TransferSession> {
        const plan = await this.planUpload(request.localUris);
        const mode: TransferMode = plan.useBulk ? 'bulk' : plan.items.length > 1 ? 'multi' : 'single';
        const title = plan.useBulk
            ? `Upload ${plan.items.length} files`
            : plan.items.length === 1
                ? `Upload ${plan.items[0].relativePath}`
                : `Upload ${plan.items.length} files`;

        const session = this.registerSession('upload', request.serverIdentifier, title, mode);
        session.sourcePathHint = request.localUris[0]?.fsPath;
        session.targetPathHint = request.remoteDestinationPath;
        session.retry = async () => {
            await this.upload(request);
        };
        this.sessions.upsertSession(session);
        this.registerPlannedChildren(session, plan.items);

        if (plan.useBulk) {
            const bulkChild = session.children[0];
            try {
                await this.bulkEngine.uploadArchive({
                    session,
                    sftpClient: request.sftpClient,
                    pteroClient: request.pteroClient,
                    remoteDestinationPath: request.remoteDestinationPath,
                    serverIdentifier: request.serverIdentifier,
                    files: plan.items.map(item => ({ uri: item.uri, relativePath: item.relativePath, size: item.size })),
                    commonRoot: plan.commonRoot,
                    onProgress: bytesTransferred => {
                        if (bulkChild) {
                            this.sessions.updateChildProgress(session.id, bulkChild.id, bytesTransferred);
                        }
                    },
                });

                if (bulkChild) {
                    this.sessions.completeChild(session.id, bulkChild.id, true);
                }
            } catch (error: any) {
                if (bulkChild) {
                    this.sessions.completeChild(session.id, bulkChild.id, false, error?.message ?? String(error));
                }
                throw error;
            }
            return session;
        }

        if (plan.items.length === 1) {
            await this.uploadSingleFile(session, plan.items[0], request.remoteDestinationPath, request.sftpClient);
            return session;
        }

        await this.uploadFilesIndividually(session, plan.items, request.remoteDestinationPath, request.sftpClient);
        return session;
    }

    async download(request: DownloadTransferRequest): Promise<TransferSession> {
        const session = this.registerSession('download', request.serverIdentifier, `Download ${request.remoteArchiveName}`, 'bulk');
        session.sourcePathHint = request.remoteSourcePath;
        session.targetPathHint = request.localDestinationPath;
        session.retry = async () => {
            await this.download(request);
        };
        this.sessions.upsertSession(session);
        const child = createTransferChild({
            label: request.remoteArchiveName,
            sourcePath: request.remoteSourcePath,
            targetPath: request.localDestinationPath,
            bytesTotal: 0,
        });
        this.sessions.attachChild(session.id, child);

        try {
            await this.bulkEngine.downloadArchive({
                session,
                sftpClient: request.sftpClient,
                remoteSourcePath: request.remoteSourcePath,
                remoteArchiveName: request.remoteArchiveName,
                localDestinationPath: request.localDestinationPath,
                onProgress: bytesTransferred => this.sessions.updateChildProgress(session.id, child.id, bytesTransferred),
            });
            this.sessions.completeChild(session.id, child.id, true);
        } catch (error: any) {
            this.sessions.completeChild(session.id, child.id, false, error?.message ?? String(error));
            throw error;
        }
        return session;
    }

    private registerSession(type: TransferDirection, serverIdentifier: string, title: string, mode: TransferMode): TransferSession {
        const session = createTransferSession({ type, serverIdentifier, title, mode });
        return this.sessions.registerSession(session);
    }

    private async planUpload(localUris: vscode.Uri[]): Promise<{ items: PlannedUploadItem[]; useBulk: boolean; commonRoot: string }> {
        const items: PlannedUploadItem[] = [];
        const selectedRoots: string[] = [];
        let totalBytes = 0;
        let totalFiles = 0;
        let hasDirectory = false;

        const walkDirectory = async (uri: vscode.Uri, prefix = ''): Promise<void> => {
            const entries = await vscode.workspace.fs.readDirectory(uri);
            for (const [name, type] of entries) {
                const childUri = vscode.Uri.joinPath(uri, name);
                const relativePath = prefix ? path.posix.join(prefix, name) : name;
                if (type === vscode.FileType.Directory) {
                    hasDirectory = true;
                    await walkDirectory(childUri, relativePath);
                    continue;
                }

                const stat = await vscode.workspace.fs.stat(childUri);
                items.push({ uri: childUri, relativePath, size: stat.size });
                totalBytes += stat.size;
                totalFiles++;
            }
        };

        for (const uri of localUris) {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
                hasDirectory = true;
                const folderName = path.basename(uri.fsPath);
                selectedRoots.push(path.dirname(uri.fsPath));
                await walkDirectory(uri, folderName);
                continue;
            }

            items.push({ uri, relativePath: path.basename(uri.fsPath), size: stat.size });
            totalBytes += stat.size;
            totalFiles++;
            selectedRoots.push(path.dirname(uri.fsPath));
        }

        const configuration = vscode.workspace.getConfiguration('vsdactyl.transfers');
        const preferBulk = configuration.get<boolean>('preferBulkTransfers', false);
        const bulkFileThreshold = configuration.get<number>('bulkFileThreshold', 10);
        const bulkSizeThresholdMb = configuration.get<number>('largeTransferThresholdMb', 500);
        const useBulk = preferBulk || hasDirectory || totalFiles > bulkFileThreshold || totalBytes > bulkSizeThresholdMb * 1024 * 1024;

        const commonRoot = selectedRoots.length === 0 ? process.cwd() : this.getCommonAncestor(selectedRoots);

        return { items, useBulk, commonRoot };
    }

    private getCommonAncestor(paths: string[]): string {
        if (paths.length === 0) {
            return process.cwd();
        }

        let common = path.resolve(paths[0]);
        for (const current of paths.slice(1)) {
            common = this.commonPathPair(common, path.resolve(current));
        }

        return common;
    }

    private commonPathPair(first: string, second: string): string {
        const firstParts = first.split(path.sep).filter(Boolean);
        const secondParts = second.split(path.sep).filter(Boolean);
        const shared: string[] = [];

        for (let index = 0; index < Math.min(firstParts.length, secondParts.length); index++) {
            if (firstParts[index] !== secondParts[index]) {
                break;
            }
            shared.push(firstParts[index]);
        }

        if (shared.length === 0) {
            return path.parse(first).root || process.cwd();
        }

        return `${path.parse(first).root}${shared.join(path.sep)}`;
    }

    private registerPlannedChildren(session: TransferSession, items: PlannedUploadItem[]): void {
        for (const item of items) {
            const child = createTransferChild({
                label: item.relativePath,
                sourcePath: item.uri.fsPath,
                targetPath: item.relativePath,
                bytesTotal: item.size,
            });
            this.sessions.attachChild(session.id, child);
        }
    }

    private async uploadSingleFile(session: TransferSession, item: PlannedUploadItem, remoteDestinationPath: string, sftpClient: SftpClient): Promise<void> {
        const child = session.children[0];
        if (!child) {
            throw new Error('Missing child transfer for single-file upload');
        }

        this.sessions.updateChildStatus(session.id, child.id, 'running');
        const remotePath = path.posix.join(remoteDestinationPath || '/', path.basename(item.relativePath));
        const localStream = fs.createReadStream(item.uri.fsPath);
        const remoteStream = await sftpClient.writeFileStream(remotePath);

        try {
            await this.pipeWithProgress(session.id, child, localStream, remoteStream);
            this.sessions.completeChild(session.id, child.id, true);
            session.status = 'completed';
        } catch (error: any) {
            this.sessions.completeChild(session.id, child.id, false, error?.message ?? String(error));
            throw error;
        }
    }

    private async uploadFilesIndividually(session: TransferSession, items: PlannedUploadItem[], remoteDestinationPath: string, sftpClient: SftpClient): Promise<void> {
        session.status = 'transferring';

        for (const item of items) {
            const child = session.children.find(candidate => candidate.sourcePath === item.uri.fsPath);
            if (!child) {
                continue;
            }

            this.sessions.updateChildStatus(session.id, child.id, 'running');
            const remotePath = path.posix.join(remoteDestinationPath || '/', item.relativePath.replace(/\\/g, '/'));
            const localStream = fs.createReadStream(item.uri.fsPath);
            const remoteStream = await sftpClient.writeFileStream(remotePath);

            try {
                await this.pipeWithProgress(session.id, child, localStream, remoteStream);
                this.sessions.completeChild(session.id, child.id, true);
            } catch (error: any) {
                this.sessions.completeChild(session.id, child.id, false, error?.message ?? String(error));
                throw error;
            }
        }

        session.status = 'completed';
    }

    private async pipeWithProgress(sessionId: string, child: TransferChildOperation, readStream: fs.ReadStream, writeStream: NodeJS.WritableStream): Promise<void> {
        let transferred = 0;
        child.cancel = () => {
            readStream.destroy(new Error('Transfer cancelled by user'));
            if ('destroy' in writeStream && typeof writeStream.destroy === 'function') {
                writeStream.destroy(new Error('Transfer cancelled by user'));
            }
        };

        return new Promise<void>((resolve, reject) => {
            readStream.on('data', (chunk: string | Buffer) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                transferred += buffer.length;
                this.sessions.updateChildProgress(sessionId, child.id, transferred);
            });
            readStream.on('error', reject);
            writeStream.on('error', reject);
            writeStream.on('close', () => {
                child.cancel = undefined;
                resolve();
            });
            readStream.pipe(writeStream);
        });
    }
}
