import * as vscode from 'vscode';
import * as http from 'http';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { AccountManager } from '../accounts/accountManager';
import { ServerTreeProvider } from '../views/serverTreeProvider';
import { PterodactylClient } from '../api/pterodactylClient';
import { Logger } from '../utils/logger';
import { PterodactylAccount } from '../accounts/types';

export function activateAgentBridge(
    context: vscode.ExtensionContext,
    accountManager: AccountManager,
    serverTreeProvider: ServerTreeProvider
): void {
    const config = vscode.workspace.getConfiguration('vsdactyl');
    const enabled = config.get<boolean>('agentBridge.enabled', true);
    if (!enabled) {
        Logger.info('Agent Bridge is disabled in settings. Skipping activation.');
        return;
    }

    const configuredPort = config.get<number>('agentBridge.port', 0);
    const token = crypto.randomBytes(32).toString('hex');
    let server: http.Server | undefined;
    let tokenFilePath: string | undefined;

    // Helper to parse JSON request body
    function parseJsonBody(req: http.IncomingMessage): Promise<any> {
        return new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => {
                data += chunk;
            });
            req.on('end', () => {
                try {
                    resolve(data ? JSON.parse(data) : {});
                } catch (err) {
                    reject(err);
                }
            });
            req.on('error', err => reject(err));
        });
    }

    // Helper to resolve server info
    async function getFileInfo(serverIdentifier: string) {
        const item = await serverTreeProvider.findServer(serverIdentifier);
        if (item?.account) {
            const scheme = item.account.type === 'pterodactyl' ? 'ptero' : 'sftp';
            const authority = item.account.type === 'pterodactyl' ? item.server?.identifier : item.account.id;
            return {
                scheme,
                authority,
                account: item.account,
                server: item.server
            };
        }

        const account = await accountManager.getAccountById(serverIdentifier);
        if (account && account.type === 'sftpOnly') {
            return {
                scheme: 'sftp',
                authority: account.id,
                account,
                server: undefined
            };
        }
        return null;
    }

    // Response helper
    function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
    }

    server = http.createServer(async (req, res) => {
        // Enforce loopback-only connections
        const remoteAddress = req.socket.remoteAddress;
        if (remoteAddress !== '127.0.0.1' && remoteAddress !== '::1' && remoteAddress !== '::ffff:127.0.0.1') {
            res.writeHead(403);
            res.end('Forbidden: Agent Bridge only permits loopback connections.');
            return;
        }

        // Validate authorization token
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${token}`) {
            sendJson(res, 401, { error: 'Unauthorized: Invalid or missing token.' });
            return;
        }

        const url = req.url || '';
        if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'Method Not Allowed. Use POST.' });
            return;
        }

        try {
            const body = await parseJsonBody(req);

            if (url === '/api/list_servers') {
                const accounts = await accountManager.getAccounts();
                const results: any[] = [];
                for (const account of accounts) {
                    if (account.type === 'sftpOnly') {
                        results.push({
                            type: 'sftpOnly',
                            accountId: account.id,
                            name: account.name,
                            host: account.host,
                            port: account.port,
                            username: account.username
                        });
                    } else {
                        const pteroAcc = account as PterodactylAccount;
                        const client = new PterodactylClient(pteroAcc.panelUrl, pteroAcc.apiKey || '');
                        const servers = await client.listServers();
                        for (const server of servers) {
                            results.push({
                                type: 'pterodactyl',
                                accountId: pteroAcc.id,
                                panelUrl: pteroAcc.panelUrl,
                                serverName: server.name,
                                serverIdentifier: server.identifier,
                                serverUuid: server.uuid,
                                host: server.sftp_details.ip,
                                port: server.sftp_details.port
                            });
                        }
                    }
                }
                sendJson(res, 200, results);
                return;
            }

            if (url === '/api/list_files') {
                const { serverIdentifier, path = '/' } = body;
                if (!serverIdentifier) {
                    sendJson(res, 400, { error: 'Missing parameter: serverIdentifier' });
                    return;
                }
                const info = await getFileInfo(serverIdentifier);
                if (!info) {
                    sendJson(res, 404, { error: `Could not find server matching "${serverIdentifier}"` });
                    return;
                }
                const uri = vscode.Uri.parse(`${info.scheme}://${info.authority}${path}`);
                const entries = await vscode.workspace.fs.readDirectory(uri);
                const formatted = entries.map(([name, type]) => ({
                    name,
                    type: type === vscode.FileType.Directory ? 'directory' : 'file'
                }));
                sendJson(res, 200, formatted);
                return;
            }

            if (url === '/api/read_file') {
                const { serverIdentifier, path } = body;
                if (!serverIdentifier || !path) {
                    sendJson(res, 400, { error: 'Missing parameters: serverIdentifier, path' });
                    return;
                }
                const info = await getFileInfo(serverIdentifier);
                if (!info) {
                    sendJson(res, 404, { error: `Could not find server matching "${serverIdentifier}"` });
                    return;
                }
                const uri = vscode.Uri.parse(`${info.scheme}://${info.authority}${path}`);
                const contentBytes = await vscode.workspace.fs.readFile(uri);
                const content = Buffer.from(contentBytes).toString('utf-8');
                sendJson(res, 200, { content });
                return;
            }

            if (url === '/api/write_file') {
                const { serverIdentifier, path, content } = body;
                if (!serverIdentifier || !path || content === undefined) {
                    sendJson(res, 400, { error: 'Missing parameters: serverIdentifier, path, content' });
                    return;
                }
                const info = await getFileInfo(serverIdentifier);
                if (!info) {
                    sendJson(res, 404, { error: `Could not find server matching "${serverIdentifier}"` });
                    return;
                }
                const uri = vscode.Uri.parse(`${info.scheme}://${info.authority}${path}`);
                const contentBytes = Buffer.from(content, 'utf-8');
                await vscode.workspace.fs.writeFile(uri, contentBytes);
                sendJson(res, 200, { message: `Successfully wrote file to ${path}` });
                return;
            }

            if (url === '/api/send_command') {
                const { serverIdentifier, command } = body;
                if (!serverIdentifier || !command) {
                    sendJson(res, 400, { error: 'Missing parameters: serverIdentifier, command' });
                    return;
                }
                const info = await getFileInfo(serverIdentifier);
                if (!info || info.scheme !== 'ptero' || !info.server) {
                    sendJson(res, 400, { error: `Command execution is only supported on Pterodactyl servers. "${serverIdentifier}" is not a Pterodactyl server.` });
                    return;
                }
                const account = info.account as PterodactylAccount;
                const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                const lowerCmd = command.trim().toLowerCase();

                if (['start', 'stop', 'restart', 'kill'].includes(lowerCmd)) {
                    await client.sendPowerAction(info.server.uuid, lowerCmd as any);
                    sendJson(res, 200, { message: `Successfully sent power action "${lowerCmd}" to server ${info.server.name}.` });
                } else {
                    await client.sendCommand(info.server.uuid, command);
                    sendJson(res, 200, { message: `Successfully executed console command "${command}" on server ${info.server.name}.` });
                }
                return;
            }

            if (url === '/api/archive_operation') {
                const { serverIdentifier, action, path: archivePath, files, archiveName } = body;
                if (!serverIdentifier || !action || !archivePath) {
                    sendJson(res, 400, { error: 'Missing parameters: serverIdentifier, action, path' });
                    return;
                }
                const info = await getFileInfo(serverIdentifier);
                if (!info || info.scheme !== 'ptero' || !info.server) {
                    sendJson(res, 400, { error: `Archive operations are only supported on Pterodactyl servers. "${serverIdentifier}" is not a Pterodactyl server.` });
                    return;
                }
                const account = info.account as PterodactylAccount;
                const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                const root = archivePath.startsWith('/') ? archivePath : `/${archivePath}`;

                if (action === 'decompress') {
                    if (!files || files.length === 0) {
                        sendJson(res, 400, { error: `Decompression requires specifying the target archive file name in 'files'.` });
                        return;
                    }
                    await client.decompressFile(info.server.uuid, root, files[0]);
                    sendJson(res, 200, { message: `Successfully decompressed archive "${files[0]}" in "${root}".` });
                } else {
                    if (!files || files.length === 0) {
                        sendJson(res, 400, { error: `Compression requires specifying files or folders in 'files'.` });
                        return;
                    }
                    const result = await client.compressFiles(info.server.uuid, root, files);
                    const returnedName = result?.name || archiveName || 'archive.zip';
                    sendJson(res, 200, { message: `Successfully compressed files [${files.join(', ')}] into "${returnedName}" in "${root}".` });
                }
                return;
            }

            sendJson(res, 404, { error: 'Not Found' });
        } catch (err: any) {
            sendJson(res, 500, { error: err.message || 'Internal Server Error' });
        }
    });

    server.listen(configuredPort, '127.0.0.1', () => {
        const address = server?.address();
        if (address && typeof address === 'object') {
            const port = address.port;
            Logger.info(`Agent Bridge HTTP server listening on 127.0.0.1:${port}`);

            // Write token file to workspace
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const workspacePath = workspaceFolders[0].uri.fsPath;
                tokenFilePath = path.join(workspacePath, '.vsdactyl-token.json');
                const tokenData = { port, token };

                try {
                    fs.writeFileSync(tokenFilePath, JSON.stringify(tokenData, null, 2), { mode: 0o600 });
                    Logger.info(`Successfully wrote Agent Bridge token to ${tokenFilePath}`);
                } catch (err: any) {
                    Logger.error(`Failed to write Agent Bridge token to workspace: ${err.message}`);
                }
            }
        }
    });

    context.subscriptions.push({
        dispose: () => {
            if (server) {
                server.close();
                Logger.info('Closed Agent Bridge HTTP server.');
            }
            if (tokenFilePath && fs.existsSync(tokenFilePath)) {
                try {
                    fs.unlinkSync(tokenFilePath);
                    Logger.info(`Cleaned up Agent Bridge token at ${tokenFilePath}`);
                } catch (err: any) {
                    Logger.error(`Failed to delete Agent Bridge token: ${err.message}`);
                }
            }
        }
    });
}
