export type TransferDirection = 'upload' | 'download';

export type TransferMode = 'single' | 'multi' | 'bulk';

export type TransferStatus = 'running' | 'compressing' | 'transferring' | 'extracting' | 'completed' | 'cancelled' | 'failed';

export type TransferChildStatus = 'pending' | 'running' | 'completed' | 'cancelled' | 'failed';

export interface TransferChildOperation {
    id: string;
    label: string;
    sourcePath?: string;
    targetPath?: string;
    bytesTotal: number;
    bytesTransferred: number;
    status: TransferChildStatus;
    error?: string;
    cancel?: () => void;
}

export interface TransferSession {
    id: string;
    type: TransferDirection;
    serverIdentifier: string;
    title: string;
    mode: TransferMode;
    fileCountTotal: number;
    fileCountCompleted: number;
    bytesTotal: number;
    bytesTransferred: number;
    status: TransferStatus;
    children: TransferChildOperation[];
    createdAt: number;
    updatedAt: number;
    error?: string;
    cancel?: () => void;
    retry?: () => Promise<void>;
    sourcePathHint?: string;
    targetPathHint?: string;
    notificationShown?: boolean;
}

export interface TransferSessionStore {
    registerSession(session: TransferSession): TransferSession;
    upsertSession(session: TransferSession): TransferSession;
    attachChild(sessionId: string, child: TransferChildOperation): void;
    updateChildProgress(sessionId: string, childId: string, bytesTransferred: number): void;
    updateChildStatus(sessionId: string, childId: string, status: TransferChildStatus, error?: string): void;
    completeChild(sessionId: string, childId: string, success?: boolean, error?: string): void;
    cancelSession(sessionId: string, reason?: string): void;
    cancelChild(sessionId: string, childId: string, reason?: string): void;
}

export interface CreateTransferSessionInput {
    type: TransferDirection;
    serverIdentifier: string;
    title: string;
    mode?: TransferMode;
}

export interface CreateTransferChildInput {
    label: string;
    sourcePath?: string;
    targetPath?: string;
    bytesTotal: number;
}

function createId(prefix: string): string {
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function createTransferSession(input: CreateTransferSessionInput): TransferSession {
    const now = Date.now();
    return {
        id: createId('transfer'),
        type: input.type,
        serverIdentifier: input.serverIdentifier,
        title: input.title,
        mode: input.mode ?? 'single',
        fileCountTotal: 0,
        fileCountCompleted: 0,
        bytesTotal: 0,
        bytesTransferred: 0,
        status: 'running',
        children: [],
        createdAt: now,
        updatedAt: now,
    };
}

export function createTransferChild(input: CreateTransferChildInput): TransferChildOperation {
    return {
        id: createId('child'),
        label: input.label,
        sourcePath: input.sourcePath,
        targetPath: input.targetPath,
        bytesTotal: Math.max(0, input.bytesTotal),
        bytesTransferred: 0,
        status: 'pending',
    };
}

export function calculateSessionProgress(session: TransferSession): number {
    if (session.bytesTotal > 0) {
        return Math.min((session.bytesTransferred / session.bytesTotal) * 100, 100);
    }

    return session.fileCountTotal > 0 ? Math.min((session.fileCountCompleted / session.fileCountTotal) * 100, 100) : 0;
}

export function cloneSession(session: TransferSession): TransferSession {
    return {
        ...session,
        children: session.children.map(child => ({ ...child })),
    };
}
