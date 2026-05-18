import * as vscode from 'vscode';
import * as tar from 'tar';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as util from 'util';
import { PterodactylClient } from '../api/pterodactylClient';

const exec = util.promisify(cp.exec);
import { SftpClient } from '../sftp/sftpClient';
import { Logger } from '../utils/logger';

export interface ActiveTransfer {
    id: string;
    type: 'upload' | 'download';
    serverIdentifier: string;
    totalFiles: number;
    filesCompleted: number;
    totalBytes: number;
    bytesCompleted: number;
    startTime: number;
    status: 'compressing' | 'transferring' | 'extracting' | 'completed' | 'failed';
    error?: string;
}

export class TransferManager {
    private static instance: TransferManager;
    private activeTransfers: Map<string, ActiveTransfer> = new Map();
    private webviewPanel: vscode.WebviewPanel | null = null;
    
    // Throttling constraints (Bytes per second)
    private uploadLimitBps: number = 0; // 0 = unlimited
    private downloadLimitBps: number = 0;

    private constructor(private context: vscode.ExtensionContext) {}

    public static getInstance(context: vscode.ExtensionContext): TransferManager {
        if (!TransferManager.instance) {
            TransferManager.instance = new TransferManager(context);
        }
        return TransferManager.instance;
    }

    public async showDashboard() {
        if (this.webviewPanel) {
            this.webviewPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.webviewPanel = vscode.window.createWebviewPanel(
            'vsdactylTransferManager',
            'VSDactyl: Transfer Manager',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = null;
        });

        this.updateDashboardUI();
        this.broadcastTransfers();
    }

    private broadcastTransfers() {
        if (this.webviewPanel) {
            this.webviewPanel.webview.postMessage({
                type: 'updateTransfers',
                data: Array.from(this.activeTransfers.values())
            });
        }
    }

    private updateDashboardUI() {
        if (!this.webviewPanel) return;

        this.webviewPanel.webview.html = `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Transfer Manager</title>
                <style>
                    :root {
                        --ptero-primary: hsl(212, 100%, 50%);
                        --ptero-primary-hover: hsl(212, 100%, 60%);
                        --ptero-bg: var(--vscode-editor-background);
                        --ptero-card-bg: rgba(255, 255, 255, 0.05);
                        --ptero-card-border: rgba(255, 255, 255, 0.1);
                        --ptero-text: var(--vscode-editor-foreground);
                        --ptero-success: hsl(142, 70%, 45%);
                        --ptero-warning: hsl(40, 90%, 50%);
                        --ptero-danger: hsl(350, 70%, 50%);
                    }
                    
                    body {
                        font-family: var(--vscode-font-family), -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                        padding: 40px;
                        margin: 0;
                        background: var(--ptero-bg);
                        color: var(--ptero-text);
                    }

                    .dashboard-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 30px;
                        padding-bottom: 15px;
                        border-bottom: 1px solid var(--ptero-card-border);
                    }

                    .dashboard-title {
                        font-size: 24px;
                        font-weight: 600;
                        margin: 0;
                        background: linear-gradient(90deg, var(--ptero-primary), #a270ff);
                        -webkit-background-clip: text;
                        -webkit-text-fill-color: transparent;
                    }

                    .controls-section {
                        display: flex;
                        gap: 20px;
                        background: var(--ptero-card-bg);
                        padding: 15px 20px;
                        border-radius: 12px;
                        border: 1px solid var(--ptero-card-border);
                        backdrop-filter: blur(10px);
                        margin-bottom: 30px;
                    }

                    .control-group {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                    }

                    .control-group label {
                        font-size: 12px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        opacity: 0.7;
                    }

                    .range-slider {
                        width: 200px;
                        accent-color: var(--ptero-primary);
                    }

                    .transfers-container {
                        display: grid;
                        gap: 20px;
                        grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
                    }

                    .transfer-card {
                        background: var(--ptero-card-bg);
                        border: 1px solid var(--ptero-card-border);
                        border-radius: 12px;
                        padding: 20px;
                        transition: transform 0.2s, box-shadow 0.2s;
                        backdrop-filter: blur(10px);
                    }

                    .transfer-card:hover {
                        transform: translateY(-2px);
                        box-shadow: 0 8px 24px rgba(0,0,0,0.2);
                        border-color: var(--ptero-primary);
                    }

                    .transfer-header {
                        display: flex;
                        justify-content: space-between;
                        align-items: center;
                        margin-bottom: 15px;
                    }

                    .transfer-title {
                        font-size: 16px;
                        font-weight: 500;
                    }

                    .badge {
                        padding: 4px 10px;
                        border-radius: 20px;
                        font-size: 12px;
                        font-weight: 600;
                        text-transform: uppercase;
                    }

                    .badge.upload { background: rgba(33, 150, 243, 0.2); color: #64b5f6; }
                    .badge.download { background: rgba(156, 39, 176, 0.2); color: #ba68c8; }
                    
                    .progress-container {
                        width: 100%;
                        height: 8px;
                        background: rgba(255,255,255,0.1);
                        border-radius: 4px;
                        overflow: hidden;
                        margin: 15px 0;
                    }

                    .progress-bar {
                        height: 100%;
                        background: linear-gradient(90deg, var(--ptero-primary), #a270ff);
                        width: 45%; /* Example width */
                        transition: width 0.3s ease;
                    }

                    .stats-grid {
                        display: grid;
                        grid-template-columns: 1fr 1fr;
                        gap: 10px;
                        font-size: 13px;
                        opacity: 0.8;
                    }

                    .stats-item {
                        display: flex;
                        justify-content: space-between;
                    }

                    .empty-state {
                        text-align: center;
                        padding: 60px 20px;
                        opacity: 0.5;
                        font-size: 16px;
                    }
                </style>
            </head>
            <body>
                <div class="dashboard-header">
                    <h1 class="dashboard-title">VSDactyl Transfer Manager</h1>
                </div>

                <div class="controls-section">
                    <div class="control-group">
                        <label>Upload Limit (MB/s): <span id="ul-val">Unlimited</span></label>
                        <input type="range" class="range-slider" min="0" max="50" value="0" id="ul-slider">
                    </div>
                    <div class="control-group">
                        <label>Download Limit (MB/s): <span id="dl-val">Unlimited</span></label>
                        <input type="range" class="range-slider" min="0" max="50" value="0" id="dl-slider">
                    </div>
                </div>

                <div class="transfers-container" id="transfers-list">
                    <!-- Skeleton Empty State -->
                    <div class="transfer-card">
                        <div class="transfer-header">
                            <span class="transfer-title">Waiting for operations...</span>
                        </div>
                        <div class="empty-state">
                            No active bulk transfers
                        </div>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    
                    document.getElementById('ul-slider').addEventListener('input', (e) => {
                        const val = e.target.value;
                        document.getElementById('ul-val').textContent = val == 0 ? 'Unlimited' : val;
                        vscode.postMessage({ type: 'updateLimit', direction: 'upload', value: val });
                    });

                    document.getElementById('dl-slider').addEventListener('input', (e) => {
                        const val = e.target.value;
                        document.getElementById('dl-val').textContent = val == 0 ? 'Unlimited' : val;
                        vscode.postMessage({ type: 'updateLimit', direction: 'download', value: val });
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        if (message.type === 'updateTransfers') {
                            const list = document.getElementById('transfers-list');
                            const transfers = message.data;
                            if (transfers.length === 0) {
                                list.innerHTML = '<div class="transfer-card"><div class="transfer-header"><span class="transfer-title">Waiting for operations...</span></div><div class="empty-state">No active bulk transfers</div></div>';
                                return;
                            }
                            
                            let html = '';
                            for (const t of transfers) {
                                const progress = t.totalBytes > 0 ? Math.min((t.bytesCompleted / t.totalBytes) * 100, 100) : 0;
                                const mbTotal = (t.totalBytes / 1024 / 1024).toFixed(2);
                                const mbDone = (t.bytesCompleted / 1024 / 1024).toFixed(2);
                                const elapsedSec = (Date.now() - t.startTime) / 1000;
                                const speed = t.bytesCompleted > 0 && elapsedSec > 0 ? (t.bytesCompleted / elapsedSec / 1024 / 1024).toFixed(2) : '0.00';
                                
                                let statusColor = 'var(--ptero-primary)';
                                if (t.status === 'completed') statusColor = 'var(--ptero-success)';
                                if (t.status === 'failed') statusColor = 'var(--ptero-danger)';
                                if (t.status === 'compressing' || t.status === 'extracting') statusColor = 'var(--ptero-warning)';

                                html += '<div class="transfer-card" style="border-left: 4px solid ' + statusColor + '"><div class="transfer-header"><span class="transfer-title">' + (t.type === 'upload' ? '📤' : '📥') + ' Transfer: ' + t.serverIdentifier + '</span><span class="badge ' + t.type + '" style="background:' + statusColor + '22; color:' + statusColor + '">' + t.status.toUpperCase() + '</span></div><div class="progress-container"><div class="progress-bar" style="width: ' + progress + '%; background: ' + statusColor + '"></div></div><div class="stats-grid"><div class="stats-item"><span>Progress</span><span>' + mbDone + ' / ' + mbTotal + ' MB (' + progress.toFixed(1) + '%)</span></div><div class="stats-item"><span>Speed</span><span>' + speed + ' MB/s</span></div></div></div>';
                            }
                            list.innerHTML = html;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    public async initiateArchiveAssistedUpload(
        localUris: vscode.Uri[], 
        remoteDestinationPath: string, 
        sftpClient: SftpClient,
        pteroClient: PterodactylClient,
        serverIdentifier: string
    ) {
        this.showDashboard();
        
        let totalBytes = 0;
        let totalFiles = 0;
        const allFiles: string[] = [];

        // 1. Calculate Size
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Calculating transfer size...',
            cancellable: false
        }, async () => {
            for (const uri of localUris) {
                const stat = await vscode.workspace.fs.stat(uri);
                if (stat.type === vscode.FileType.Directory) {
                    const gather = async (dirUri: vscode.Uri) => {
                        const entries = await vscode.workspace.fs.readDirectory(dirUri);
                        for (const [name, type] of entries) {
                            const childUri = vscode.Uri.joinPath(dirUri, name);
                            if (type === vscode.FileType.Directory) {
                                await gather(childUri);
                            } else {
                                const childStat = await vscode.workspace.fs.stat(childUri);
                                totalBytes += childStat.size;
                                totalFiles++;
                                allFiles.push(childUri.fsPath);
                            }
                        }
                    };
                    await gather(uri);
                } else {
                    totalBytes += stat.size;
                    totalFiles++;
                    allFiles.push(uri.fsPath);
                }
            }
        });

        const configThresholdMb = vscode.workspace.getConfiguration('vsdactyl.transfers').get<number>('largeTransferThresholdMb', 500);
        const largeThreshold = configThresholdMb * 1024 * 1024;
        let use7Zip = false;

        if (totalBytes > largeThreshold) {
            const has7Zip = await this.check7ZipInstalled();
            if (has7Zip) {
                const choice = await vscode.window.showInformationMessage(
                    `This transfer is quite large (${(totalBytes / 1024 / 1024).toFixed(2)} MB). 7-Zip is installed on your system. Would you like to use 7-Zip for faster local compression (requires temporary disk space), or stream it directly?`,
                    { modal: true },
                    'Use 7-Zip (Faster CPU)', 'Stream (No Temp Files)'
                );
                if (choice === 'Use 7-Zip (Faster CPU)') {
                    use7Zip = true;
                }
            }
        }

        if (use7Zip) {
            await this.uploadVia7Zip(allFiles, localUris, remoteDestinationPath, sftpClient, pteroClient, serverIdentifier, totalBytes, totalFiles);
        } else {
            await this.uploadViaStream(allFiles, localUris, remoteDestinationPath, sftpClient, pteroClient, serverIdentifier, totalBytes, totalFiles);
        }
    }

    private async check7ZipInstalled(): Promise<boolean> {
        try {
            await exec('7z --help');
            return true;
        } catch {
            try {
                await exec('7za --help');
                return true;
            } catch {
                return false;
            }
        }
    }

    private async uploadVia7Zip(files: string[], roots: vscode.Uri[], remoteDest: string, sftp: SftpClient, ptero: PterodactylClient, serverId: string, totalBytes: number, totalFiles: number) {
        const transferId = Math.random().toString(36).substring(2, 9);
        const active: ActiveTransfer = {
            id: transferId, type: 'upload', serverIdentifier: serverId,
            totalFiles, filesCompleted: 0, totalBytes, bytesCompleted: 0,
            startTime: Date.now(), status: 'compressing'
        };
        this.activeTransfers.set(transferId, active);
        this.broadcastTransfers();

        const os = require('os');
        const tempTarball = path.join(os.tmpdir(), `vsdactyl_7z_${transferId}.tar.gz`);
        const tempTar = path.join(os.tmpdir(), `vsdactyl_7z_${transferId}.tar`);
        const remoteTarball = path.posix.join(remoteDest, `vsdactyl_7z_${transferId}.tar.gz`);
        
        try {
            const firstRoot = path.dirname(roots[0].fsPath);
            const rootsStr = roots.map(r => `"${path.relative(firstRoot, r.fsPath)}"`).join(' ');
            
            let bin = '7z';
            try { await exec('7z --help'); } catch { bin = '7za'; }

            await exec(`${bin} a -ttar "${tempTar}" ${rootsStr}`, { cwd: firstRoot });
            await exec(`${bin} a -tgzip "${tempTarball}" "${tempTar}"`);
            
            try { fs.unlinkSync(tempTar); } catch {}

            const stat = fs.statSync(tempTarball);
            active.totalBytes = stat.size;
            active.status = 'transferring';
            active.startTime = Date.now();
            this.broadcastTransfers();

            const readStream = fs.createReadStream(tempTarball);
            const writeStream = await sftp.getWriteStream(remoteTarball);

            readStream.on('data', (chunk) => {
                active.bytesCompleted += chunk.length;
                this.broadcastTransfers();
            });

            readStream.pipe(writeStream);

            await new Promise((resolve, reject) => {
                writeStream.on('close', resolve);
                writeStream.on('error', reject);
                readStream.on('error', reject);
            });

            try { fs.unlinkSync(tempTarball); } catch {}

            active.status = 'extracting';
            this.broadcastTransfers();

            await ptero.decompressFile(serverId, remoteDest, path.basename(remoteTarball));
            await ptero.deleteFiles(serverId, remoteDest, [path.basename(remoteTarball)]);

            active.status = 'completed';
            this.broadcastTransfers();
            vscode.window.showInformationMessage(`7-Zip Bulk Transfer complete!`);
        } catch (err: any) {
            active.status = 'failed';
            active.error = err.message;
            this.broadcastTransfers();
            vscode.window.showErrorMessage(`7-Zip transfer failed: ${err.message}`);
            Logger.error('7-Zip transfer failed', err);
        }
    }

    private async uploadViaStream(files: string[], roots: vscode.Uri[], remoteDest: string, sftp: SftpClient, ptero: PterodactylClient, serverId: string, totalBytes: number, totalFiles: number) {
        const transferId = Math.random().toString(36).substring(2, 9);
        const remoteTarball = path.posix.join(remoteDest, `vsdactyl_stream_${transferId}.tar.gz`);
        
        const active: ActiveTransfer = {
            id: transferId, type: 'upload', serverIdentifier: serverId,
            totalFiles, filesCompleted: 0, totalBytes, bytesCompleted: 0,
            startTime: Date.now(), status: 'transferring'
        };
        this.activeTransfers.set(transferId, active);
        this.broadcastTransfers();

        try {
            const firstRoot = path.dirname(roots[0].fsPath);
            const relativeFiles = files.map(f => path.relative(firstRoot, f));

            const writeStream = await sftp.getWriteStream(remoteTarball);
            const tarStream = tar.c({
                gzip: true,
                cwd: firstRoot,
            }, relativeFiles);

            tarStream.on('data', (chunk) => {
                active.bytesCompleted += chunk.length;
                this.broadcastTransfers();
            });

            tarStream.pipe(writeStream);

            await new Promise((resolve, reject) => {
                writeStream.on('close', resolve);
                writeStream.on('error', reject);
                tarStream.on('error', reject);
            });

            active.status = 'extracting';
            this.broadcastTransfers();

            await ptero.decompressFile(serverId, remoteDest, path.basename(remoteTarball));
            await ptero.deleteFiles(serverId, remoteDest, [path.basename(remoteTarball)]);

            active.status = 'completed';
            this.broadcastTransfers();
            vscode.window.showInformationMessage(`Archive-Assisted Bulk Transfer complete!`);
        } catch (err: any) {
            active.status = 'failed';
            active.error = err.message;
            this.broadcastTransfers();
            vscode.window.showErrorMessage(`Streaming transfer failed: ${err.message}`);
            Logger.error('Streaming transfer failed', err);
        }
    }
}
