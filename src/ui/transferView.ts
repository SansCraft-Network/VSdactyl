import { calculateSessionProgress, TransferSession } from '../transfers/transferSession';

export interface TransferViewSession {
    id: string;
    type: 'upload' | 'download';
    serverIdentifier: string;
    title: string;
    mode: 'single' | 'multi' | 'bulk';
    fileCountTotal: number;
    fileCountCompleted: number;
    bytesTotal: number;
    bytesTransferred: number;
    status: string;
    error?: string;
    speedBps?: number;
    etaSec?: number | null;
    canRetry?: boolean;
    canOpenSource?: boolean;
    canOpenTarget?: boolean;
    sourcePathHint?: string;
    targetPathHint?: string;
    createdAt: number;
    updatedAt: number;
    notificationShown?: boolean;
    children: Array<{
        id: string;
        label: string;
        sourcePath?: string;
        targetPath?: string;
        bytesTotal: number;
        bytesTransferred: number;
        status: string;
        error?: string;
        canCancel?: boolean;
    }>;
}

function formatBytes(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        return '0 B';
    }

    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = value;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }

    return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeText(value: string): string {
    return value.replace(/[&<>"]/g, character => {
        switch (character) {
            case '&': return '&amp;';
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '"': return '&quot;';
            default: return character;
        }
    });
}

function getBadgeClass(status: string): string {
    if (status === 'completed') return 'success';
    if (status === 'failed') return 'failed';
    if (status === 'cancelled') return 'muted';
    if (status === 'compressing' || status === 'extracting') return 'accent';
    return 'active';
}

export function renderTransferDashboard(
    sessions: TransferViewSession[],
    options: { uploadLimitBps: number; downloadLimitBps: number; soundEnabled: boolean },
): string {
    const initialSessions = JSON.stringify(sessions).replace(/</g, '\\u003c');

    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Transfer Manager</title>
    <style>
        :root {
            color-scheme: dark;
            --bg: linear-gradient(180deg, rgba(10, 16, 28, 0.96), rgba(12, 17, 26, 0.98));
            --panel: rgba(255,255,255,0.05);
            --panel-border: rgba(255,255,255,0.10);
            --text: var(--vscode-editor-foreground);
            --muted: rgba(255,255,255,0.62);
            --accent: #67b7ff;
            --success: #57d38c;
            --warning: #f1c15b;
            --danger: #ff6b6b;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 24px;
            font-family: var(--vscode-font-family), system-ui, sans-serif;
            color: var(--text);
            background: var(--bg);
        }
        .shell { max-width: 1180px; margin: 0 auto; }
        .hero { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 18px; }
        h1 { margin: 0; font-size: 28px; font-weight: 700; }
        .subtitle { color: var(--muted); margin-top: 6px; }
        .controls, .session-card, .empty-state {
            background: var(--panel);
            border: 1px solid var(--panel-border);
            border-radius: 16px;
            backdrop-filter: blur(12px);
            box-shadow: 0 16px 40px rgba(0, 0, 0, 0.24);
        }
        .controls { padding: 14px 16px; display: flex; flex-wrap: wrap; gap: 18px; margin-bottom: 18px; }
        .control { min-width: 220px; }
        .control label { display: block; font-size: 11px; letter-spacing: 0.08em; color: var(--muted); text-transform: uppercase; margin-bottom: 8px; }
        .control input { width: 100%; }
        .toolbar { display: flex; gap: 8px; flex-wrap: wrap; }
        .action {
            appearance: none; border: 0; border-radius: 10px; padding: 8px 12px; cursor: pointer;
            font-weight: 600; color: white; transition: transform 0.15s ease, opacity 0.15s ease;
        }
        .action:hover { transform: translateY(-1px); }
        .action.secondary { background: rgba(255,255,255,0.12); color: var(--text); }
        .action.danger { background: var(--danger); }
        .session-list { display: grid; gap: 14px; }
        .session-card { padding: 16px; animation: fadeIn 0.2s ease; }
        .session-header { display: flex; justify-content: space-between; gap: 12px; align-items: start; }
        .session-title { font-size: 18px; font-weight: 700; }
        .session-subtitle { margin-top: 4px; color: var(--muted); font-size: 12px; }
        .session-badge, .child-status {
            padding: 5px 10px; border-radius: 999px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
        }
        .session-progress, .child-progress { height: 8px; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: hidden; }
        .session-progress { margin: 14px 0; }
        .session-progress span, .child-progress span { display: block; height: 100%; background: linear-gradient(90deg, var(--accent), #9d7dff); border-radius: inherit; }
        .session-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 12px; }
        .session-stats div { padding: 10px 12px; border-radius: 12px; background: rgba(255,255,255,0.04); }
        .session-stats span { display: block; font-size: 11px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
        .session-stats strong { font-size: 13px; }
        .session-error { margin-bottom: 12px; color: #ffd0d0; }
        .session-details summary { cursor: pointer; color: var(--muted); }
        .children-list { display: grid; gap: 10px; margin-top: 12px; }
        .child-row { padding: 12px; border-radius: 12px; background: rgba(255,255,255,0.04); }
        .child-header { display: flex; justify-content: space-between; gap: 8px; align-items: center; }
        .child-title { font-weight: 600; }
        .child-meta, .child-footer { color: var(--muted); font-size: 12px; }
        .child-meta { margin: 4px 0 8px; word-break: break-all; }
        .child-progress { margin-bottom: 8px; }
        .child-footer { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
        .child-error { color: #ffd0d0; }
        .child-empty { color: var(--muted); }
        .empty-state { padding: 40px; text-align: center; color: var(--muted); }
        .session-actions { margin-top: 12px; }
        .success { background: color-mix(in srgb, var(--success) 24%, transparent); color: var(--success); }
        .failed { background: color-mix(in srgb, var(--danger) 24%, transparent); color: var(--danger); }
        .muted { background: rgba(255,255,255,0.10); color: var(--muted); }
        .accent { background: color-mix(in srgb, var(--warning) 24%, transparent); color: var(--warning); }
        .active { background: color-mix(in srgb, var(--accent) 24%, transparent); color: var(--accent); }
        .session-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
        .session-meta { display: flex; gap: 14px; flex-wrap: wrap; color: var(--muted); font-size: 12px; margin-top: 8px; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        @media (max-width: 900px) {
            .session-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .hero { align-items: start; flex-direction: column; }
        }
    </style>
</head>
<body>
    <div class="shell">
        <div class="hero">
            <div>
                <h1>Transfer Manager</h1>
                <div class="subtitle">Aggregated sessions for single-file, multi-file, and bulk transfers.</div>
            </div>
            <div class="toolbar">
                <button class="action secondary" id="refresh-btn">Refresh</button>
            </div>
        </div>

        <section class="controls">
            <div class="control">
                <label>Upload limit (MB/s)</label>
                <input id="upload-limit" type="range" min="0" max="100" value="${Math.round(options.uploadLimitBps / 1024 / 1024)}">
            </div>
            <div class="control">
                <label>Download limit (MB/s)</label>
                <input id="download-limit" type="range" min="0" max="100" value="${Math.round(options.downloadLimitBps / 1024 / 1024)}">
            </div>
            <div class="control">
                <label>Notifications</label>
                <div style="padding:8px 0;color:var(--muted);">Sound ${options.soundEnabled ? 'enabled' : 'disabled'}</div>
            </div>
        </section>

        <section id="session-list" class="session-list"></section>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        const state = {
            sessions: ${initialSessions},
            soundEnabled: ${JSON.stringify(options.soundEnabled)},
        };

        function escapeHtml(value) {
            return String(value).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch] || ch));
        }

        function bytes(value) {
            if (!Number.isFinite(value) || value <= 0) return '0 B';
            const units = ['B','KB','MB','GB','TB'];
            let size = value;
            let unitIndex = 0;
            while (size >= 1024 && unitIndex < units.length - 1) { size /= 1024; unitIndex++; }
            return size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1) + ' ' + units[unitIndex];
        }

        function progress(session) {
            if (session.bytesTotal > 0) return Math.min((session.bytesTransferred / session.bytesTotal) * 100, 100);
            return session.fileCountTotal > 0 ? (session.fileCountCompleted / session.fileCountTotal) * 100 : 0;
        }

        function formatSpeed(value) {
            if (!Number.isFinite(value) || value <= 0) return '0 B/s';
            return bytes(value) + '/s';
        }

        function formatEta(seconds) {
            if (!Number.isFinite(seconds) || seconds === null || seconds < 0) return 'ETA unavailable';
            const total = Math.max(0, Math.ceil(seconds));
            const hours = Math.floor(total / 3600);
            const minutes = Math.floor((total % 3600) / 60);
            const secs = total % 60;
            if (hours > 0) return hours + 'h ' + minutes + 'm';
            if (minutes > 0) return minutes + 'm ' + secs + 's';
            return secs + 's';
        }

        function render() {
            const list = document.getElementById('session-list');
            if (!state.sessions || state.sessions.length === 0) {
                list.innerHTML = '<div class="empty-state">No transfer sessions yet.</div>';
                return;
            }

            list.innerHTML = state.sessions.map(session => {
                const percent = progress(session);
                const badgeClass = session.status === 'completed' ? 'success' : session.status === 'failed' ? 'failed' : session.status === 'cancelled' ? 'muted' : (session.status === 'compressing' || session.status === 'extracting' ? 'accent' : 'active');
                const children = (session.children || []).map(child => {
                    const childProgress = child.bytesTotal > 0 ? Math.min((child.bytesTransferred / child.bytesTotal) * 100, 100) : 0;
                    let childHtml = '';
                    childHtml += '<div class="child-row">';
                    childHtml += '<div class="child-header">';
                    childHtml += '<div class="child-title">' + escapeHtml(child.label) + '</div>';
                    childHtml += '<div class="child-status ' + badgeClass + '">' + escapeHtml(child.status) + '</div>';
                    childHtml += '</div>';
                    childHtml += '<div class="child-meta">' + escapeHtml(child.sourcePath || '');
                    if (child.targetPath) {
                        childHtml += ' → ' + escapeHtml(child.targetPath);
                    }
                    childHtml += '</div>';
                    childHtml += '<div class="child-progress"><span style="width:' + childProgress + '%"></span></div>';
                    childHtml += '<div class="child-footer">';
                    childHtml += '<span>' + bytes(child.bytesTransferred) + ' / ' + bytes(child.bytesTotal) + '</span>';
                    if (child.error) {
                        childHtml += '<span class="child-error">' + escapeHtml(child.error) + '</span>';
                    }
                    childHtml += '</div>';
                    if (child.canCancel && session.status === 'running') {
                        childHtml += '<button class="action secondary" data-cancel-child="' + escapeHtml(child.id) + '">Cancel file</button>';
                    }
                    childHtml += '</div>';
                    return childHtml;
                }).join('');

                let sessionHtml = '';
                sessionHtml += '<article class="session-card" data-session-id="' + escapeHtml(session.id) + '">';
                sessionHtml += '<header class="session-header">';
                sessionHtml += '<div>';
                sessionHtml += '<div class="session-title">' + escapeHtml(session.title) + '</div>';
                sessionHtml += '<div class="session-subtitle">' + escapeHtml(session.type) + ' · ' + escapeHtml(session.serverIdentifier) + ' · ' + escapeHtml(session.mode) + '</div>';
                sessionHtml += '</div>';
                sessionHtml += '<div class="session-badge ' + badgeClass + '">' + escapeHtml(session.status) + '</div>';
                sessionHtml += '</header>';
                sessionHtml += '<div class="session-progress"><span style="width:' + percent + '%"></span></div>';
                sessionHtml += '<div class="session-stats">';
                sessionHtml += '<div><span>Files</span><strong>' + session.fileCountCompleted + ' / ' + session.fileCountTotal + '</strong></div>';
                sessionHtml += '<div><span>Bytes</span><strong>' + bytes(session.bytesTransferred) + ' / ' + bytes(session.bytesTotal) + '</strong></div>';
                sessionHtml += '<div><span>Progress</span><strong>' + percent.toFixed(1) + '%</strong></div>';
                sessionHtml += '<div><span>Speed</span><strong>' + formatSpeed(session.speedBps || 0) + '</strong></div>';
                sessionHtml += '</div>';
                sessionHtml += '<div class="session-meta">';
                sessionHtml += '<span>Updated ' + new Date(session.updatedAt).toLocaleTimeString() + '</span>';
                sessionHtml += '<span>' + formatEta(session.etaSec) + '</span>';
                sessionHtml += '</div>';
                if (session.error) {
                    sessionHtml += '<div class="session-error">' + escapeHtml(session.error) + '</div>';
                }
                sessionHtml += '<div class="session-actions">';
                if (session.canRetry && (session.status === 'failed' || session.status === 'cancelled')) {
                    sessionHtml += '<button class="action secondary" data-retry-session="' + escapeHtml(session.id) + '">Retry</button>';
                }
                if (session.canOpenSource) {
                    sessionHtml += '<button class="action secondary" data-open-source="' + escapeHtml(session.id) + '">Open source</button>';
                }
                if (session.canOpenTarget) {
                    sessionHtml += '<button class="action secondary" data-open-target="' + escapeHtml(session.id) + '">Open target</button>';
                }
                sessionHtml += '</div>';
                sessionHtml += '<details class="session-details">';
                sessionHtml += '<summary>Show file details</summary>';
                sessionHtml += '<div class="children-list">' + (children || '<div class="child-row child-empty">No per-file detail available.</div>') + '</div>';
                sessionHtml += '</details>';
                if (session.status === 'running') {
                    sessionHtml += '<div class="session-actions"><button class="action danger" data-cancel-session="' + escapeHtml(session.id) + '">Cancel session</button></div>';
                }
                sessionHtml += '</article>';
                return sessionHtml;
            }).join('');
        }

        function playSound(kind) {
            if (!state.soundEnabled) return;
            try {
                const AudioContextClass = window.AudioContext || window.webkitAudioContext;
                if (!AudioContextClass) return;
                const context = new AudioContextClass();
                const oscillator = context.createOscillator();
                const gain = context.createGain();
                oscillator.connect(gain);
                gain.connect(context.destination);
                const now = context.currentTime;
                oscillator.type = kind === 'failed' ? 'sawtooth' : 'sine';
                oscillator.frequency.setValueAtTime(kind === 'failed' ? 620 : 880, now);
                gain.gain.setValueAtTime(0.18, now);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'failed' ? 0.28 : 0.18));
                oscillator.start(now);
                oscillator.stop(now + (kind === 'failed' ? 0.3 : 0.2));
            } catch {
                // Ignore audio failures in restricted environments.
            }
        }

        document.getElementById('refresh-btn').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
        document.getElementById('upload-limit').addEventListener('input', event => vscode.postMessage({ type: 'updateLimit', direction: 'upload', value: Number(event.target.value) }));
        document.getElementById('download-limit').addEventListener('input', event => vscode.postMessage({ type: 'updateLimit', direction: 'download', value: Number(event.target.value) }));

        document.addEventListener('click', event => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const sessionId = target.getAttribute('data-cancel-session');
            if (sessionId) vscode.postMessage({ type: 'cancelSession', id: sessionId });
            const childId = target.getAttribute('data-cancel-child');
            if (childId) vscode.postMessage({ type: 'cancelChild', id: childId });
            const retryId = target.getAttribute('data-retry-session');
            if (retryId) vscode.postMessage({ type: 'retrySession', id: retryId });
            const openSourceId = target.getAttribute('data-open-source');
            if (openSourceId) vscode.postMessage({ type: 'openSource', id: openSourceId });
            const openTargetId = target.getAttribute('data-open-target');
            if (openTargetId) vscode.postMessage({ type: 'openTarget', id: openTargetId });
        });

        window.addEventListener('message', event => {
            const message = event.data;
            if (message.type === 'updateSessions') {
                state.sessions = message.data || [];
                state.soundEnabled = Boolean(message.soundEnabled);
                render();
            }
            if (message.type === 'playSound') {
                playSound(message.kind || 'completed');
            }
        });

        render();
    </script>
</body>
</html>`;
}
