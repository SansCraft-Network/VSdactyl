import Module from 'module';
import * as fs from 'fs';
import * as path from 'path';

type Disposable = { dispose(): void };

function createDisposable(): Disposable {
    return { dispose() { /* no-op */ } };
}

export function installVscodeTestShim(): void {
    const moduleAny = Module as unknown as { _load: (request: string, parent: NodeModule | null, isMain: boolean) => unknown };
    const originalLoad = moduleAny._load;

    const vscodeStub = {
        Uri: {
            file: (filePath: string) => ({
                scheme: 'file',
                fsPath: filePath,
                path: filePath.replace(/\\/g, '/'),
                toString: () => `file://${filePath.replace(/\\/g, '/')}`,
            }),
            joinPath: (base: any, ...segments: string[]) => {
                const joined = [base.fsPath ?? base.path ?? '', ...segments].join('/');
                return {
                    ...base,
                    fsPath: joined,
                    path: joined.replace(/\\/g, '/'),
                    toString: () => `file://${joined.replace(/\\/g, '/')}`,
                };
            },
            parse: (value: string) => {
                try {
                    const url = new URL(value);
                    return {
                        scheme: url.protocol.replace(':', ''),
                        authority: url.hostname || url.host,
                        path: url.pathname,
                        fsPath: url.protocol === 'file:' ? (url.pathname.startsWith('/') && process.platform === 'win32' ? url.pathname.slice(1) : url.pathname) : value,
                        toString: () => value,
                    };
                } catch {
                    return {
                        scheme: value.split(':')[0],
                        authority: '',
                        fsPath: value.replace(/^file:\/\//, ''),
                        path: value.replace(/^file:\/\//, ''),
                        toString: () => value,
                    };
                }
            },
        },
        workspace: {
            fs: {
                stat: async (uri: { fsPath: string }) => {
                    const stats = await fs.promises.stat(uri.fsPath);
                    return {
                        type: stats.isDirectory() ? 2 : stats.isSymbolicLink() ? 64 : 1,
                        size: stats.size,
                        ctime: stats.birthtimeMs,
                        mtime: stats.mtimeMs,
                    };
                },
                readDirectory: async (uri: { fsPath: string }) => {
                    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
                    return entries.map(entry => [entry.name, entry.isDirectory() ? 2 : entry.isSymbolicLink() ? 64 : 1] as [string, number]);
                },
                readFile: async (uri: { fsPath: string }) => new Uint8Array(await fs.promises.readFile(uri.fsPath)),
                writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
                    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
                    await fs.promises.writeFile(uri.fsPath, Buffer.from(content));
                },
                createDirectory: async (uri: { fsPath: string }) => {
                    await fs.promises.mkdir(uri.fsPath, { recursive: true });
                },
                delete: async (uri: { fsPath: string }) => {
                    await fs.promises.rm(uri.fsPath, { recursive: true, force: true });
                },
            },
            getConfiguration: () => ({ get: (_key: string, defaultValue: unknown) => defaultValue }),
            createFileSystemWatcher: () => createDisposable(),
        },
        window: {
            showInformationMessage: async () => undefined,
            showWarningMessage: async () => undefined,
            showErrorMessage: async () => undefined,
            showOpenDialog: async () => [],
            showInputBox: async () => undefined,
            createWebviewPanel: () => ({
                webview: { html: '', postMessage: async () => true, onDidReceiveMessage: () => createDisposable() },
                onDidDispose: () => createDisposable(),
                reveal: () => undefined,
            }),
            createOutputChannel: () => ({
                appendLine: (_s: string) => undefined,
                show: (_preserve?: boolean) => undefined,
                dispose: () => undefined,
            }),
            createTreeView: () => ({ dispose: () => undefined }),
        },
        commands: { executeCommand: async () => undefined },
        env: { openExternal: async () => undefined },
        ProgressLocation: { Notification: 1 },
        ViewColumn: { One: 1 },
        TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
        ThemeIcon: class ThemeIcon { constructor(public readonly id: string, public readonly color?: any) {} },
        ThemeColor: class ThemeColor { constructor(public readonly id: string) {} },
        TreeItem: class TreeItem {
            label: string;
            collapsibleState: number;
            contextValue?: string;
            iconPath: any;
            command?: any;
            description?: string;
            tooltip?: string;
            constructor(label: string, collapsibleState: number) {
                this.label = label;
                this.collapsibleState = collapsibleState;
            }
        },
        DataTransferItem: class DataTransferItem {
            constructor(private readonly value: string) {}
            async asString() { return this.value; }
            asFile() {
                try {
                    if (this.value && this.value.includes('://')) {
                        const url = new URL(this.value);
                        return {
                            name: path.basename(this.value),
                            uri: {
                                scheme: url.protocol.replace(':', ''),
                                authority: url.hostname || url.host,
                                path: url.pathname,
                                fsPath: url.protocol === 'file:' ? (url.pathname.startsWith('/') && process.platform === 'win32' ? url.pathname.slice(1) : url.pathname) : this.value,
                                toString: () => this.value,
                            }
                        };
                    }
                } catch {
                    // Ignore
                }
                return undefined;
            }
        },
        FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
        FileSystemError: {
            Unavailable: (message: string) => new Error(message),
            FileNotFound: (_uri: any) => new Error('File not found'),
            NoPermissions: (message: string) => new Error(message),
            FileExists: (_uri: any) => new Error('File exists'),
        },
        EventEmitter: class EventEmitter<T> {
            event = () => createDisposable();
            fire(_value: T) { return undefined; }
            dispose() { return undefined; }
        },
        Disposable: { from: (..._values: Disposable[]) => createDisposable() },
    };

    moduleAny._load = function patchedLoad(request: string, parent: NodeModule | null, isMain: boolean) {
        if (request === 'vscode') {
            return vscodeStub;
        }

        return originalLoad.apply(this, arguments as unknown as [string, NodeModule | null, boolean]);
    };
}
