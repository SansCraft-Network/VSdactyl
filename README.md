# VSDactyl for VS Code

VSDactyl, SansCraft Network's official fork of the original Pterodactyl extension from MinhMCPC, is a VS Code extension for connecting to Pterodactyl panels and standalone SFTP servers. It keeps the familiar panel and SFTP workflows, while adding maintained fixes and improvements for anyone to use directly from VS Code.


## What It Does

- Connect to Pterodactyl panel servers and standalone SFTP endpoints.
- Browse, edit, create, rename, and delete remote files from the VS Code Explorer.
- Open a live terminal to send commands to a server console.
- Start, stop, restart, or kill panel-backed servers from the tree view.
- Store account secrets securely through VS Code secret storage.
- Import and export account data for backup or migration.

## Install

### From source
1. Clone this repository.
2. Run `npm install` in the extension folder.
3. Press `F5` in VS Code to launch the extension host.

### From a packaged build
1. Install the `.vsix` package in VS Code.
2. Open the VSDactyl view in the Activity Bar.

## Quick Start

### Panel account
1. Open the VSDactyl view in the Activity Bar.
2. Click **Add Account**.
3. Enter your panel URL, API key, username, and SFTP details.
4. Select SSH key or password authentication.
5. After saving, expand the account to see your servers.

### Standalone SFTP account
1. Open the VSDactyl view in the Activity Bar.
2. Click **Add SFTP Account**.
3. Enter the host, port, username, and authentication method.
4. Save the account and connect when you are ready.

### Remote files
1. Right-click a server and choose **Connect**.
2. The server mounts as a workspace folder.
3. Edit files normally and save to sync back to the remote host.

### Terminal and power controls
1. Right-click a panel-backed server.
2. Choose **Open Terminal** to access the console.
3. Use the power actions to control the server state.

## SSH Key Setup

The extension can generate an Ed25519 key pair and upload the public key to the panel for you.

1. Open the Command Palette with `Ctrl+Shift+P`.
2. Run **VSDactyl: Setup Auto SSH Key**.
3. Select a panel account.
4. Choose a key name and optional passphrase.
5. The private key is saved locally and the public key is uploaded to the panel.

## Commands

The command IDs stay compatible with the original extension surface, but the user-facing titles are VSDactyl-branded.

- `pterodactyl.addAccount` - Add a panel account.
- `pterodactyl.addSftpAccount` - Add a standalone SFTP account.
- `pterodactyl.editAccount` - Edit the selected account.
- `pterodactyl.removeAccount` - Remove the selected account.
- `pterodactyl.refreshServers` - Refresh the server list.
- `pterodactyl.connectServer` - Connect to a server.
- `pterodactyl.disconnectServer` - Disconnect from a server.
- `pterodactyl.reconnectServer` - Reconnect a server.
- `pterodactyl.openTerminal` - Open the server terminal.
- `pterodactyl.exportData` - Export account data.
- `pterodactyl.importData` - Import account data.
- `pterodactyl.setupSshKey` - Generate and upload an SSH key.
- `pterodactyl.showSftpLog` - Show SFTP debug output.

## Requirements

- A Pterodactyl panel URL and client API key for panel-backed accounts.
- Or a standalone SFTP host, port, username, and authentication method.

## Security Notes

- API keys and passwords are stored in VS Code secret storage when possible.
- SSH private keys can be selected from disk or pasted into the account form.
- The extension uses `ptero://` for panel-backed mounts and `sftp://` for standalone SFTP mounts.

## Troubleshooting

- If file operations are slow, check the network connection and server load.
- If connection attempts fail, confirm the host, port, username, and authentication method.
- Make sure SFTP is enabled on the target server and accessible from your network.
- Standalone SFTP entries do not support panel-specific actions like power controls or terminal access.

## Tutorials & Guides

Full walkthroughs are available in multiple languages:
- [English Guide (tutorial.en.html)](tutorial.en.html)
- [German Guide / Deutsche Anleitung (tutorial.de.html)](tutorial.de.html)
- [French Guide / Guide en français (tutorial.fr.html)](tutorial.fr.html)
- [Spanish Guide / Guía en español (tutorial.es.html)](tutorial.es.html)
- [Vietnamese Guide / Hướng dẫn tiếng Việt (tutorial.html)](tutorial.html)

## Project Notes

This fork is public and intended for community use. It keeps the original protocol and command identifiers for compatibility while evolving the branding, documentation, and implementation around them.
