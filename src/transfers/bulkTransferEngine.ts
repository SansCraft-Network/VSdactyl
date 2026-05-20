import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as tar from 'tar';
import { PterodactylClient } from '../api/pterodactylClient';
import { SftpClient } from '../sftp/sftpClient';
import { TransferSession } from './transferSession';

export interface FileTreeEntry {
    uri: vscode.Uri;
    relativePath: string;
    size: number;
}

export interface BulkUploadContext {
    session: TransferSession;
    sftpClient: SftpClient;
    pteroClient?: PterodactylClient;
    remoteDestinationPath: string;
    serverIdentifier: string;
    files: FileTreeEntry[];
    commonRoot: string;
    onProgress?: (bytesTransferred: number) => void;
}

export interface BulkDownloadContext {
    session: TransferSession;
    sftpClient: SftpClient;
    remoteSourcePath: string;
    remoteArchiveName: string;
    localDestinationPath: string;
    onProgress?: (bytesTransferred: number) => void;
}

function makeTempPath(sessionId: string, suffix: string): string {
    return path.join(os.tmpdir(), `vsdactyl_${sessionId}${suffix}`);
}

function sanitizeArchiveName(name: string): string {
    return name.replace(/[^a-zA-Z0-9._-]+/g, '_');
}

export class BulkTransferEngine {
    async uploadArchive(context: BulkUploadContext): Promise<void> {
        const { session, sftpClient, pteroClient, remoteDestinationPath, serverIdentifier, files, commonRoot } = context;
        const tempTar = makeTempPath(session.id, '.tar');
        const tempArchive = makeTempPath(session.id, '.tar.gz');
        const archiveName = sanitizeArchiveName(`${session.title || 'transfer'}-${session.id}.tar.gz`);
        const remoteArchivePath = path.posix.join(remoteDestinationPath || '/', archiveName);

        session.status = 'compressing';
        session.updatedAt = Date.now();

        try {
            await tar.create({ gzip: false, cwd: commonRoot, file: tempTar }, files.map(item => item.relativePath));
            await tar.create({ gzip: true, file: tempArchive }, [tempTar]);

            try { fs.unlinkSync(tempTar); } catch { /* ignore */ }

            session.status = 'transferring';
            session.updatedAt = Date.now();
            await this.streamLocalFileToRemote(tempArchive, remoteArchivePath, sftpClient, context.onProgress);

            session.status = 'extracting';
            session.updatedAt = Date.now();

            if (pteroClient) {
                await pteroClient.decompressFile(serverIdentifier, remoteDestinationPath, path.basename(remoteArchivePath));
                await pteroClient.deleteFiles(serverIdentifier, remoteDestinationPath, [path.basename(remoteArchivePath)]);
            } else {
                await sftpClient.exec(`tar -xzf ${this.quote(remoteArchivePath)} -C ${this.quote(remoteDestinationPath || '/')}`);
                await sftpClient.delete(remoteArchivePath);
            }

            session.status = 'completed';
            session.fileCountCompleted = session.fileCountTotal;
            session.bytesTransferred = session.bytesTotal;
            session.updatedAt = Date.now();
        } catch (error) {
            this.failSession(session, error);
            throw error;
        } finally {
            try { fs.unlinkSync(tempArchive); } catch { /* ignore */ }
            try { fs.unlinkSync(tempTar); } catch { /* ignore */ }
        }
    }

    async downloadArchive(context: BulkDownloadContext): Promise<void> {
        const { session, sftpClient, remoteSourcePath, remoteArchiveName, localDestinationPath } = context;
        const tempArchive = makeTempPath(session.id, '.tar.gz');
        const tempExtract = makeTempPath(session.id, '.extract');

        session.status = 'transferring';
        session.updatedAt = Date.now();

        try {
            const remoteArchivePath = path.posix.join(remoteSourcePath, remoteArchiveName);
            await sftpClient.exec(`tar -czf ${this.quote(remoteArchivePath)} -C ${this.quote(remoteSourcePath)} .`);
            await this.streamRemoteFileToLocal(remoteArchivePath, tempArchive, sftpClient, context.onProgress);

            session.status = 'extracting';
            session.updatedAt = Date.now();

            await fs.promises.mkdir(tempExtract, { recursive: true });
            await tar.extract({ cwd: tempExtract, file: tempArchive });
            await this.copyDirectory(tempExtract, localDestinationPath);

            session.status = 'completed';
            session.fileCountCompleted = session.fileCountTotal;
            session.bytesTransferred = session.bytesTotal;
            session.updatedAt = Date.now();
        } catch (error) {
            this.failSession(session, error);
            throw error;
        } finally {
            try { fs.unlinkSync(tempArchive); } catch { /* ignore */ }
            try { fs.rmSync(tempExtract, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    }

    async gatherDirectoryEntries(rootUri: vscode.Uri, rootRelative = ''): Promise<FileTreeEntry[]> {
        const entries: FileTreeEntry[] = [];
        const stat = await vscode.workspace.fs.stat(rootUri);

        if (stat.type !== vscode.FileType.Directory) {
            entries.push({ uri: rootUri, relativePath: rootRelative || path.basename(rootUri.fsPath), size: stat.size });
            return entries;
        }

        const walk = async (directoryUri: vscode.Uri, relativePrefix: string): Promise<void> => {
            const children = await vscode.workspace.fs.readDirectory(directoryUri);
            for (const [name, type] of children) {
                const childUri = vscode.Uri.joinPath(directoryUri, name);
                const childRelativePath = relativePrefix ? path.posix.join(relativePrefix, name) : name;
                if (type === vscode.FileType.Directory) {
                    await walk(childUri, childRelativePath);
                    continue;
                }

                const childStat = await vscode.workspace.fs.stat(childUri);
                entries.push({ uri: childUri, relativePath: childRelativePath, size: childStat.size });
            }
        };

        await walk(rootUri, rootRelative);
        return entries;
    }

    async calculatePlan(uris: vscode.Uri[]): Promise<{ entries: FileTreeEntry[]; commonRoot: string; archiveName: string }> {
        const entries: FileTreeEntry[] = [];
        const roots = new Set<string>();

        for (const uri of uris) {
            const stat = await vscode.workspace.fs.stat(uri);
            if (stat.type === vscode.FileType.Directory) {
                const directoryEntries = await this.gatherDirectoryEntries(uri);
                entries.push(...directoryEntries);
                roots.add(path.dirname(uri.fsPath));
                continue;
            }

            entries.push({ uri, relativePath: path.basename(uri.fsPath), size: stat.size });
            roots.add(path.dirname(uri.fsPath));
        }

        return {
            entries,
            commonRoot: this.getCommonAncestor(Array.from(roots)),
            archiveName: sanitizeArchiveName(`vsdactyl-${Date.now().toString(36)}.tar.gz`),
        };
    }

    private async streamLocalFileToRemote(localFile: string, remoteFile: string, sftpClient: SftpClient, onProgress?: (bytesTransferred: number) => void): Promise<void> {
        const localStream = fs.createReadStream(localFile);
        const remoteStream = await sftpClient.writeFileStream(remoteFile);
        let bytesTransferred = 0;

        return new Promise<void>((resolve, reject) => {
            localStream.on('data', (chunk: string | Buffer) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytesTransferred += buffer.length;
                onProgress?.(bytesTransferred);
            });
            localStream.on('error', reject);
            remoteStream.on('error', reject);
            remoteStream.on('close', resolve);
            localStream.pipe(remoteStream);
        });
    }

    private async streamRemoteFileToLocal(remoteFile: string, localFile: string, sftpClient: SftpClient, onProgress?: (bytesTransferred: number) => void): Promise<void> {
        const remoteStream = await sftpClient.readFileStream(remoteFile);
        const localStream = fs.createWriteStream(localFile);
        let bytesTransferred = 0;

        return new Promise<void>((resolve, reject) => {
            remoteStream.on('data', (chunk: string | Buffer) => {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                bytesTransferred += buffer.length;
                onProgress?.(bytesTransferred);
            });
            remoteStream.on('error', reject);
            localStream.on('error', reject);
            localStream.on('close', resolve);
            remoteStream.pipe(localStream);
        });
    }

    private async copyDirectory(source: string, destination: string): Promise<void> {
        await fs.promises.mkdir(destination, { recursive: true });
        const entries = await fs.promises.readdir(source, { withFileTypes: true });

        for (const entry of entries) {
            const sourcePath = path.join(source, entry.name);
            const destinationPath = path.join(destination, entry.name);
            if (entry.isDirectory()) {
                await this.copyDirectory(sourcePath, destinationPath);
                continue;
            }

            await fs.promises.copyFile(sourcePath, destinationPath);
        }
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

    private quote(value: string): string {
        return `"${value.replace(/"/g, '\\"')}"`;
    }

    private failSession(session: TransferSession, error: unknown): void {
        if (session.status !== 'cancelled') {
            session.status = 'failed';
        }
        session.error = error instanceof Error ? error.message : String(error);
        session.updatedAt = Date.now();
    }
}
