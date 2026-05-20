import * as vscode from 'vscode';
import { Logger } from '../utils/logger';
import { renderTransferDashboard, TransferViewSession } from '../ui/transferView';
import {
    cloneSession,
    TransferChildOperation,
    TransferChildStatus,
    TransferSession,
    TransferSessionStore,
} from './transferSession';

export class TransferManager implements TransferSessionStore {
    private static instance: TransferManager;

    private readonly sessions = new Map<string, TransferSession>();
    private readonly childToSession = new Map<string, string>();
    private webviewPanel: vscode.WebviewPanel | null = null;

    private uploadLimitBps = 0;
    private downloadLimitBps = 0;
    private soundEnabled = true;

    private constructor(private readonly context: vscode.ExtensionContext) {}

    public static getInstance(context: vscode.ExtensionContext): TransferManager {
        if (!TransferManager.instance) {
            TransferManager.instance = new TransferManager(context);
        }

        return TransferManager.instance;
    }

    public registerSession(session: TransferSession): TransferSession {
        const next = cloneSession(session);
        next.updatedAt = Date.now();
        this.sessions.set(next.id, next);
        Logger.info(`TransferManager: registered session ${next.id} (${next.title}) for server ${next.serverIdentifier}`);
        this.broadcastSessions();
        return next;
    }

    public upsertSession(session: TransferSession): TransferSession {
        session.updatedAt = Date.now();
        this.sessions.set(session.id, session);
        this.broadcastSessions();
        return session;
    }

    public attachChild(sessionId: string, child: TransferChildOperation): void {
        const session = this.requireSession(sessionId);
        session.children.push(child);
        session.fileCountTotal = session.children.length;
        session.bytesTotal = session.children.reduce((total, current) => total + current.bytesTotal, 0);
        session.updatedAt = Date.now();
        this.childToSession.set(child.id, sessionId);
        Logger.debug(`TransferManager: attached child ${child.id} to session ${sessionId} (${child.label})`);
        this.broadcastSessions();
    }

    public updateChildProgress(sessionId: string, childId: string, bytesTransferred: number): void {
        const session = this.requireSession(sessionId);
        const child = this.requireChild(session, childId);
        child.status = 'running';
        child.bytesTransferred = Math.max(0, bytesTransferred);
        session.bytesTransferred = session.children.reduce((total, current) => total + Math.min(current.bytesTransferred, current.bytesTotal || current.bytesTransferred), 0);
        session.updatedAt = Date.now();
        Logger.debug(`TransferManager: progress session=${sessionId} child=${childId} bytes=${child.bytesTransferred}/${child.bytesTotal}`);
        this.broadcastSessions();
    }

    public updateChildStatus(sessionId: string, childId: string, status: TransferChildStatus, error?: string): void {
        const session = this.requireSession(sessionId);
        const child = this.requireChild(session, childId);
        child.status = status;
        child.error = error;
        session.updatedAt = Date.now();
        this.broadcastSessions();
    }

    public completeChild(sessionId: string, childId: string, success = true, error?: string): void {
        const session = this.requireSession(sessionId);
        const child = this.requireChild(session, childId);
        child.status = success ? 'completed' : 'failed';
        child.error = error;
        child.bytesTransferred = child.bytesTotal;
        session.fileCountCompleted = session.children.filter(item => item.status === 'completed').length;
        session.bytesTransferred = session.children.reduce((total, current) => total + current.bytesTransferred, 0);
        session.updatedAt = Date.now();

        Logger.info(`TransferManager: child ${childId} completed on session ${sessionId} success=${success}` + (error ? ` error=${error}` : ''));

        if (!success) {
            if (session.status !== 'cancelled') {
                session.status = 'failed';
            }
            session.error = error;
            this.playNotificationSound(session);
        } else if (session.fileCountCompleted >= session.fileCountTotal && session.fileCountTotal > 0) {
            session.status = 'completed';
            session.error = undefined;
            this.playNotificationSound(session);
        }

        this.broadcastSessions();
    }

    public cancelSession(sessionId: string, reason?: string): void {
        const session = this.requireSession(sessionId);
        session.status = 'cancelled';
        session.error = reason ?? 'Cancelled by user';
        session.cancel?.();
        for (const child of session.children) {
            child.status = 'cancelled';
            child.cancel?.();
        }
        session.updatedAt = Date.now();
        Logger.info(`TransferManager: session ${sessionId} cancelled: ${session.error}`);
        this.playNotificationSound(session);
        this.broadcastSessions();
    }

    public cancelChild(sessionId: string, childId: string, reason?: string): void {
        const session = this.requireSession(sessionId);
        const child = this.requireChild(session, childId);
        child.status = 'cancelled';
        child.error = reason ?? 'Cancelled by user';
        child.cancel?.();
        session.updatedAt = Date.now();
        this.broadcastSessions();
    }

    public async showDashboard(): Promise<void> {
        if (this.webviewPanel) {
            this.webviewPanel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.webviewPanel = vscode.window.createWebviewPanel(
            'vsdactylTransferManager',
            'VSDactyl: Transfer Manager',
            vscode.ViewColumn.One,
            { enableScripts: true, retainContextWhenHidden: true },
        );

        this.webviewPanel.onDidDispose(() => {
            this.webviewPanel = null;
        });

        this.webviewPanel.webview.onDidReceiveMessage(message => {
            if (message.type === 'updateLimit') {
                const value = Math.max(0, Number(message.value) || 0) * 1024 * 1024;
                if (message.direction === 'upload') {
                    this.uploadLimitBps = value;
                } else if (message.direction === 'download') {
                    this.downloadLimitBps = value;
                }

                this.broadcastSessions();
                return;
            }

            if (message.type === 'cancelSession') {
                this.cancelSession(String(message.id));
                return;
            }

            if (message.type === 'cancelChild') {
                const childId = String(message.id);
                const sessionId = this.childToSession.get(childId);
                if (sessionId) {
                    this.cancelChild(sessionId, childId);
                }
                return;
            }

            if (message.type === 'refresh') {
                this.broadcastSessions();
                return;
            }

            if (message.type === 'retrySession') {
                void this.retrySession(String(message.id));
                return;
            }

            if (message.type === 'openSource') {
                void this.openSessionPath(String(message.id), 'source');
                return;
            }

            if (message.type === 'openTarget') {
                void this.openSessionPath(String(message.id), 'target');
            }
        });

        this.updateDashboardUI();
        this.broadcastSessions();
    }

    private playNotificationSound(session: TransferSession): void {
        if (!this.soundEnabled || session.notificationShown) {
            return;
        }

        session.notificationShown = true;

        if (this.webviewPanel) {
            this.webviewPanel.webview.postMessage({
                type: 'playSound',
                kind: session.status === 'failed' ? 'failed' : 'completed',
            });
        }

        if (session.status === 'completed') {
            void vscode.window.showInformationMessage(`Transfer completed: ${session.title}`);
        } else if (session.status === 'failed') {
            void vscode.window.showErrorMessage(`Transfer failed: ${session.error ?? session.title}`);
        }
    }

    private broadcastSessions(): void {
        if (!this.webviewPanel) {
            return;
        }

        const sessions = Array.from(this.sessions.values()).map(session => this.toViewSession(session));
        this.webviewPanel.webview.postMessage({
            type: 'updateSessions',
            data: sessions,
            soundEnabled: this.soundEnabled,
            uploadLimitBps: this.uploadLimitBps,
            downloadLimitBps: this.downloadLimitBps,
        });
    }

    private updateDashboardUI(): void {
        if (!this.webviewPanel) {
            return;
        }

        this.webviewPanel.webview.html = renderTransferDashboard(
            Array.from(this.sessions.values()).map(session => this.toViewSession(session)),
            {
                uploadLimitBps: this.uploadLimitBps,
                downloadLimitBps: this.downloadLimitBps,
                soundEnabled: this.soundEnabled,
            },
        );
    }

    private toViewSession(session: TransferSession): TransferViewSession {
        const elapsedSeconds = Math.max((Date.now() - session.createdAt) / 1000, 1);
        const speedBps = session.bytesTransferred > 0 ? session.bytesTransferred / elapsedSeconds : 0;
        const remainingBytes = Math.max(0, session.bytesTotal - session.bytesTransferred);
        const etaSec = speedBps > 0 ? Math.ceil(remainingBytes / speedBps) : null;

        return {
            id: session.id,
            type: session.type,
            serverIdentifier: session.serverIdentifier,
            title: session.title,
            mode: session.mode,
            fileCountTotal: session.fileCountTotal,
            fileCountCompleted: session.fileCountCompleted,
            bytesTotal: session.bytesTotal,
            bytesTransferred: session.bytesTransferred,
            status: session.status,
            error: session.error,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
            notificationShown: session.notificationShown,
            speedBps,
            etaSec,
            canRetry: !!session.retry,
            canOpenSource: !!session.sourcePathHint,
            canOpenTarget: !!session.targetPathHint,
            sourcePathHint: session.sourcePathHint,
            targetPathHint: session.targetPathHint,
            children: session.children.map(child => ({
                id: child.id,
                label: child.label,
                sourcePath: child.sourcePath,
                targetPath: child.targetPath,
                bytesTotal: child.bytesTotal,
                bytesTransferred: child.bytesTransferred,
                status: child.status,
                error: child.error,
                canCancel: true,
            })),
        };
    }

    private async retrySession(sessionId: string): Promise<void> {
        const session = this.requireSession(sessionId);
        if (!session.retry) {
            return;
        }

        await session.retry();
    }

    private async openSessionPath(sessionId: string, which: 'source' | 'target'): Promise<void> {
        const session = this.requireSession(sessionId);
        const pathHint = which === 'source' ? session.sourcePathHint : session.targetPathHint;
        if (!pathHint) {
            return;
        }

        await vscode.env.openExternal(vscode.Uri.file(pathHint));
    }

    private requireSession(sessionId: string): TransferSession {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session ${sessionId} not found`);
        }

        return session;
    }

    private requireChild(session: TransferSession, childId: string): TransferChildOperation {
        const child = session.children.find(candidate => candidate.id === childId);
        if (!child) {
            throw new Error(`Child transfer ${childId} not found in session ${session.id}`);
        }

        return child;
    }
}

