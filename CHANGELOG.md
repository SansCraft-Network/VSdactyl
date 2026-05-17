# Change Log

All notable changes to the "vsdactyl" extension will be documented in this file.

## [2.1.0-vsdactyl.1] - 2026-05-17

### Brand Identity
- **Official Fork**: VSDactyl is now the official maintained fork of the Pterodactyl extension
- Complete rebranding from SansCraft VSdactyl to VSDactyl across all user-visible surfaces
- Updated all command titles, dialogs, forms, and documentation to use VSDactyl

### 🆕 New Features
- **Sync Status Indicators**: Visual badges (P/S/~/!) showing file sync state
- **Drag & Drop Support**: Move files between local and remote filesystems
- **Explorer Context Menu**: Right-click remote directory to edit connection settings
- **Recursive Copy**: Copy entire folder hierarchies between systems
- **SFTP Persistence**: Standalone SFTP connections restore on VS Code reload
- **Better Reconnection**: Extended support for both panel and standalone accounts

### 🔒 Security
- **Host Key Verification (TOFU)**: Protects against MITM attacks with SHA256 fingerprints
- **Automatic Secret Migration**: Legacy private keys migrated from globalState to VS Code secrets storage
- **Enhanced Logging**: Removed sensitive details (key previews, password hints) from debug output

### 🐛 Bug Fixes
- **Recursive Delete**: Fixed directory deletion with nested files
- **Overwrite-Aware Rename**: Pre-checks target existence, handles conflicts correctly
- **Error Mapping**: Consistent SFTP error translation to VS Code FileSystemError types
- **Timeout Messages**: Fixed to reflect actual 12s timeout value
- **Lifecycle Management**: Proper disposal of SFTP connections and filesystem providers

### ⚙️ Improvements
- Enhanced filesystem contract compliance
- Better error messages and user feedback
- Improved form validation in account setup
- Consistent error handling across operations

## [2.0.2] - 2026-02-16

- **Fix**: Restored the "Generate Key Pair" button in the manual SSH configuration section of the Add/Edit Account form.

## [2.0.1] - 2026-02-16

- **Fix**: Resolved "Unsupported key format" error by switching Ed25519 key generation to OpenSSH format, ensuring full compatibility with SFTP authentication.

## [2.0.0] - 2026-02-16

### Major UI & UX Overhaul
- **New Premium Design**: Completely redesigned the "Add Account" form with a polished theme for a more professional look and better compatibility with VS Code themes.
- **Embedded SSH Auto-Setup**: You can now automatically generate, save, and upload SSH keys directly during account creation. No manual copy-pasting required.
- **Improved Validation**: Added real-time error feedback and better field validation in the setup process.
- **Documentation**: Added a comprehensive [Vietnamese Tutorial](tutorial.html) integrated into the extension.

## [1.6.4] - 2026-02-16

- Added **Auto SSH Key Setup** feature (`VSDactyl: Setup Auto SSH Key`).
- Automatically generates Ed25519 keys and uploads them to the Panel.

## [1.6.3] - 2026-02-16

- Updated repository URL
- Improved extension icon

## [1.6.2] - 2026-02-16

- Fixed npm warnings and deprecated dependencies
- Validated release workflow permissions

## [1.6.1] - 2026-02-16

- Improved release workflow automation
- Updated dependencies
- Use PNG icon for marketplace compatibility

## [1.0.0] - 2026-02-16

- Initial release
- Added multi-account support
- Added SFTP file system provider
- Added server power controls (Start, Stop, Restart, Kill)
- Added integrated server terminal
