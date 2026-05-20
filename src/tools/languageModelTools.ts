import * as vscode from 'vscode';
import { AccountManager } from '../accounts/accountManager';
import { ServerTreeProvider } from '../views/serverTreeProvider';
import { PterodactylClient } from '../api/pterodactylClient';
import { Logger } from '../utils/logger';
import { PterodactylAccount, PteroAccount } from '../accounts/types';

export function registerLanguageModelTools(
    context: vscode.ExtensionContext,
    accountManager: AccountManager,
    serverTreeProvider: ServerTreeProvider
) {
    if (typeof vscode.lm === 'undefined' || typeof vscode.lm.registerTool === 'undefined') {
        Logger.info('Language Model Tools API is not supported in this version of VS Code. Skipping tool registration.');
        return;
    }

    Logger.info('Registering Language Model Tools for agent integration...');

    // Helper to resolve scheme & server info
    async function getFileInfo(serverIdentifier: string) {
        // Try serverTreeProvider cache first
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

        // Fallback: search direct accounts
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

    // 1. List Servers Tool
    context.subscriptions.push(
        vscode.lm.registerTool('vsdactyl_list_servers', {
            async invoke(_options, _token) {
                try {
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
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(JSON.stringify(results, null, 2))
                    ]);
                } catch (err: any) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error listing servers: ${err.message}`)
                    ]);
                }
            }
        })
    );

    // 2. List Files Tool
    context.subscriptions.push(
        vscode.lm.registerTool('vsdactyl_list_files', {
            async invoke(options, _token) {
                const { serverIdentifier, path = '/' } = options.input as { serverIdentifier: string; path?: string };
                try {
                    const info = await getFileInfo(serverIdentifier);
                    if (!info) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Could not find server matching identifier "${serverIdentifier}"`)
                        ]);
                    }
                    const uri = vscode.Uri.parse(`${info.scheme}://${info.authority}${path}`);
                    const entries = await vscode.workspace.fs.readDirectory(uri);
                    const formatted = entries.map(([name, type]) => ({
                        name,
                        type: type === vscode.FileType.Directory ? 'directory' : 'file'
                    }));
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(JSON.stringify(formatted, null, 2))
                    ]);
                } catch (err: any) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error listing files: ${err.message}`)
                    ]);
                }
            }
        })
    );

    // 3. Read File Tool
    context.subscriptions.push(
        vscode.lm.registerTool('vsdactyl_read_file', {
            async invoke(options, _token) {
                const { serverIdentifier, path } = options.input as { serverIdentifier: string; path: string };
                try {
                    const info = await getFileInfo(serverIdentifier);
                    if (!info) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Could not find server matching identifier "${serverIdentifier}"`)
                        ]);
                    }
                    const uri = vscode.Uri.parse(`${info.scheme}://${info.authority}${path}`);
                    const contentBytes = await vscode.workspace.fs.readFile(uri);
                    const content = new TextDecoder('utf-8').decode(contentBytes);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(content)
                    ]);
                } catch (err: any) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error reading file: ${err.message}`)
                    ]);
                }
            }
        })
    );

    // 4. Write File Tool
    context.subscriptions.push(
        vscode.lm.registerTool('vsdactyl_write_file', {
            async invoke(options, _token) {
                const { serverIdentifier, path, content } = options.input as { serverIdentifier: string; path: string; content: string };
                try {
                    const info = await getFileInfo(serverIdentifier);
                    if (!info) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Could not find server matching identifier "${serverIdentifier}"`)
                        ]);
                    }
                    const uri = vscode.Uri.parse(`${info.scheme}://${info.authority}${path}`);
                    const contentBytes = new TextEncoder().encode(content);
                    await vscode.workspace.fs.writeFile(uri, contentBytes);
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Successfully wrote file to ${path}`)
                    ]);
                } catch (err: any) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error writing file: ${err.message}`)
                    ]);
                }
            }
        })
    );

    // 5. Send Command / Action Tool (Pterodactyl Only)
    context.subscriptions.push(
        vscode.lm.registerTool('vsdactyl_send_command', {
            async invoke(options, _token) {
                const { serverIdentifier, command } = options.input as { serverIdentifier: string; command: string };
                try {
                    const info = await getFileInfo(serverIdentifier);
                    if (!info || info.scheme !== 'ptero' || !info.server) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Command execution is only supported on Pterodactyl panel servers. Server "${serverIdentifier}" is not a Pterodactyl server.`)
                        ]);
                    }
                    const account = info.account as PterodactylAccount;
                    const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                    
                    const lowerCmd = command.trim().toLowerCase();
                    if (['start', 'stop', 'restart', 'kill'].includes(lowerCmd)) {
                        await client.sendPowerAction(info.server.uuid, lowerCmd as any);
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Successfully sent power action "${lowerCmd}" to server ${info.server.name}.`)
                        ]);
                    } else {
                        await client.sendCommand(info.server.uuid, command);
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Successfully executed console command "${command}" on server ${info.server.name}.`)
                        ]);
                    }
                } catch (err: any) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error executing command: ${err.message}`)
                    ]);
                }
            }
        })
    );

    // 6. Archive Operation Tool (Pterodactyl Only)
    context.subscriptions.push(
        vscode.lm.registerTool('vsdactyl_archive_operation', {
            async invoke(options, _token) {
                const { serverIdentifier, action, path, files, archiveName } = options.input as {
                    serverIdentifier: string;
                    action: 'compress' | 'decompress';
                    path: string;
                    files?: string[];
                    archiveName?: string;
                };
                try {
                    const info = await getFileInfo(serverIdentifier);
                    if (!info || info.scheme !== 'ptero' || !info.server) {
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Archive operations are only supported on Pterodactyl panel servers. Server "${serverIdentifier}" is not a Pterodactyl server.`)
                        ]);
                    }
                    const account = info.account as PterodactylAccount;
                    const client = new PterodactylClient(account.panelUrl, account.apiKey || '');
                    const root = path.startsWith('/') ? path : `/${path}`;

                    if (action === 'decompress') {
                        if (!files || files.length === 0) {
                            return new vscode.LanguageModelToolResult([
                                new vscode.LanguageModelTextPart(`Decompression requires specifying the target archive file name as the first element of 'files'.`)
                            ]);
                        }
                        await client.decompressFile(info.server.uuid, root, files[0]);
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Successfully decompressed archive "${files[0]}" in "${root}".`)
                        ]);
                    } else {
                        if (!files || files.length === 0) {
                            return new vscode.LanguageModelToolResult([
                                new vscode.LanguageModelTextPart(`Compression requires specifying at least one file or folder name in 'files'.`)
                            ]);
                        }
                        const result = await client.compressFiles(info.server.uuid, root, files);
                        const returnedName = result?.name || archiveName || 'archive.zip';
                        return new vscode.LanguageModelToolResult([
                            new vscode.LanguageModelTextPart(`Successfully compressed files [${files.join(', ')}] into "${returnedName}" in "${root}".`)
                        ]);
                    }
                } catch (err: any) {
                    return new vscode.LanguageModelToolResult([
                        new vscode.LanguageModelTextPart(`Error performing archive operation: ${err.message}`)
                    ]);
                }
            }
        })
    );
}
