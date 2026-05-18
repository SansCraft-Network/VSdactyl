## [2.2.13-vsdactyl] - 2026-05-18
### ?? Custom Authentication System Support
- **Manual Authentication Flow**: Users can now disable auto-login to authenticate through custom systems (OAuth, SSO, billing, etc.)
- **Smart Auth Detection**: Extension automatically detects common SSO/OAuth patterns and shows appropriate guidance
- **Session Preservation**: Once authenticated through any custom system, the session is preserved via the proxy for all future connections
- **Graceful Degradation**: If auto-login fails, the extension prompts manual authentication instead of errors
### ? Features
- **Custom Auth Detection**: Identifies OAuth, SAML, SSO, and external domain redirects automatically
- **Enhanced Panel Guidance**: Clear on-screen messages guide users through different authentication scenarios
- **Better Error Messages**: Detailed console logging helps troubleshoot authentication issues
- **Flexible Authentication**: Works with any Pterodactyl panel variant, regardless of custom login system
### ?? Implementation Details
- Detects custom auth flows using pattern matching on URL paths and OAuth/SAML response codes
- Shows informative notices when manual authentication is detected
- Auto-login gracefully skips if form structure doesn't match standard Pterodactyl login
- All authentication attempts logged with \[VSDactyl Debug]\ prefix for troubleshooting## [2.2.12-vsdactyl] - 2026-05-18
### ?? Bug Fixes
- **CSRF Token Mismatch**: Fixed auto-login CSRF token validation errors by properly detecting and including CSRF tokens in form submissions
- **Enhanced Form Detection**: Improved detection of username/password fields to handle various Pterodactyl panel implementations and custom workflows
- **Better Error Handling**: Added comprehensive debug logging and fallback mechanisms for custom panel login workflows
### ? Features
- **Smart CSRF Token Detection**: Automatically detects common CSRF token patterns (csrf, _token, authenticity) and includes them in form submissions
- **Custom Workflow Support**: Added fallback button-click method for Pterodactyl panels with non-standard form implementations
- **Improved Debugging**: Enhanced console logging to help diagnose login issues with detailed form introspection data# Change Log

All notable changes to the "vsdactyl" extension will be documented in this file.

## [2.2.11-vsdactyl] - 2026-05-18

### ✨ Features
- **Right-Click Context Menu in Panel**: Right-click on files in the Pterodactyl panel webview to quickly open them in VS Code
- **Quick File Actions**: Choose "Open in VS Code" to edit remote files or "Copy Path" to get the full file path
- **Smart Path Detection**: Automatically detects file paths from breadcrumbs and panel metadata for accurate file handling

## [2.2.10-vsdactyl] - 2026-05-18

### ✨ Features
- **Panel Auto-Login**: You can now enable automatic credential pre-filling and submission when opening the Pterodactyl panel. When adding or editing a panel account, toggle "Panel Auto-Login" and enter your panel password to enable this feature.
- **Secure Credential Storage**: Panel passwords are stored securely using VS Code's Secrets API, never exposed in globalState or logs.
- **Automatic Form Detection**: The webview automatically detects common login form patterns (username/email and password fields) and intelligently pre-fills them with your saved credentials.
- **Optional Auto-Submit**: When enabled, the login form is automatically submitted after credentials are filled, providing seamless single-click panel access.

## [2.2.9-vsdactyl] - 2026-05-18

### 🐛 Bug Fixes
- **Panel Proxy Session Handling**: The local panel proxy now preserves login sessions across redirects and forwards panel auth cookies so embedded web views can load more Pterodactyl panels successfully.
- **Embedded Panel Routing**: The proxy now rewrites redirect locations back through the local loopback endpoint while stripping `X-Frame-Options` and `Content-Security-Policy` headers.

## [2.2.8-vsdactyl] - 2026-05-18

### ✨ Improvements
- **Global Transfer Interception**: The Transfer Manager dashboard now intercepts all background single-file operations (like Auto-Sync saves and regular code edits) and displays them natively in the UI with a live progress bar.
- **Cancel Button Integration**: Embedded native `Cancel` buttons directly into the Transfer Manager UI, allowing you to instantly terminate active Node.js byte streams mid-transfer without having to abruptly disconnect from the server.

## [2.2.6-vsdactyl] - 2026-05-18

### ✨ Improvements
- **Advanced Directory Browsing**: The Auto-Sync setup flow now uses hybrid input boxes for both the local and remote path selection. You can either type the exact path manually, or click the **Browse** folder icon to interactively navigate your local disk or securely browse the live remote server's file tree via the Pterodactyl API.
- **Manual Bandwidth Limits**: The Transfer Manager dashboard now features dedicated number inputs next to the bandwidth sliders, allowing you to explicitly type out custom exact speed limits (overriding the 50MB/s visual slider max) down to the byte.

## [2.2.4-vsdactyl] - 2026-05-18

### ✨ Improvements
- **Interactive Auto-Sync Targeting**: The Auto-Sync initializer now interactively prompts you to specify a remote target directory (like `/plugins`) instead of silently defaulting to the server root `/`.
- **Enhanced Documentation**: Expanded the in-editor Auto-Sync documentation to include common pitfalls and explicitly outline the difference between Live-Editing (Virtual Workspace) and one-way Compilation Deployment (Auto-Sync).

## [2.2.3-vsdactyl] - 2026-05-18

### ✨ Improvements
- **Nested Auto-Sync Picker**: Replaced the restrictive `Workspace Folder` root picker with a robust `Open Dialog` picker, allowing users to map deeply nested subdirectories directly to Auto-Sync instead of being forced to map the entire workspace root.
- **Documentation CDNs**: Migrated all public tutorial HTML documentation links to use `staticdelivr.com` instead of raw `jsdelivr` endpoints.

## [2.2.2-vsdactyl] - 2026-05-18

### ⚡ Performance
- **Transfer Speed Unlock**: Disabled the verbose low-level `ssh2` packet debug hook that was blocking the Node.js event loop with thousands of VS Code Output Channel writes per second during bulk transfers. File uploads and downloads will now saturate your network bandwidth.

## [2.2.1-vsdactyl] - 2026-05-18

### 🚀 Major Features
- **Auto-Sync Deployment Engine**: You can now map any local workspace folder to a remote Pterodactyl node! By generating a `.vsdactyl-sync.json` file, VSDactyl will monitor your local folder via the native `FileSystemWatcher` and instantly tunnel all saves, deletes, and file creations to the remote production daemon in real-time.

### 🐛 Bug Fixes
- **Transfer Manager UI**: Fixed a missing state hook that prevented the real-time upload progress dashboard from rendering correctly.
- **Web View Debugger**: Injected cross-origin security debugging into the Web View panel loader to diagnose `X-Frame-Options` drops.

## [2.2.0-vsdactyl] - 2026-05-17

### 🚀 Major Features
- **Archive-Assisted Bulk Transfers**: Automatically intercepts massive folder drops, compresses them locally (via stream or 7-Zip), and extracts them server-side using the Pterodactyl API.
- **Advanced Transfer Manager**: A new glassmorphic dashboard to monitor bulk transfer progress and throttle speeds.
- **Embedded Web View**: Load your server's Pterodactyl panel directly within a VS Code tab.
- **Hardware Telemetry**: View real-time CPU, RAM, and Disk metrics directly in the Server Tree View.
- **API Deletions**: Directory deletions now use the Pterodactyl API instead of slow recursive SFTP commands.

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
- **Documentation**: Added a comprehensive [Vietnamese Tutorial](https://cdn.staticdelivr.com/gh/SansCraft-Network/VSdactyl/main/tutorial.vi.html) integrated into the extension.

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


