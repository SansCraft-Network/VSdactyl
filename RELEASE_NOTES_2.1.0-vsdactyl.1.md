# VSDactyl 2.1.0-vsdactyl.1 Release Notes

## 🎉 Welcome to VSDactyl!

This is the first release of **VSDactyl**, SansCraft Network's official fork of the Pterodactyl VS Code extension. This release brings comprehensive quality-of-life improvements, enhanced security, and new user-facing features.

## 🆕 What's New

### Brand Identity
- **Official Fork**: VSDactyl is now the official maintained fork of the Pterodactyl extension, with improved stability, security, and features
- **Clear Branding**: All user-facing surfaces now display "VSDactyl" with attribution to SansCraft Network
- **Repository**: [github.com/SansCraft-Network/VSdactyl](https://github.com/SansCraft-Network/VSdactyl)

### ✨ New Features

#### Sync Status Indicators
- Visual badges on remote files/folders showing their sync state
- Status types: **P** (Panel), **S** (SFTP), **~** (syncing), **!** (error)
- Auto-expiring error indicators to reduce clutter
- Helps you see at a glance which files are currently syncing

#### Enhanced File Management
- **Drag & Drop Support**: Move files and folders between local and remote filesystems
- **Recursive Copy**: Copy entire folder hierarchies between systems
- **Explorer Context Menu**: Right-click on remote directory to edit connection settings
- **Overwrite-Aware Operations**: Rename and delete operations now handle conflicts intelligently

#### Connection Management
- **Standalone SFTP Persistence**: Standalone SFTP connections now restore automatically on VS Code reload
- **Better Reconnection**: Extended reconnect flow to support both Pterodactyl panel and standalone SFTP accounts
- **Improved Lifecycle**: Proper cleanup and disposal of filesystem providers

### 🔒 Security Improvements

#### Host Key Verification (Trust On First Use)
- **TOFU Implementation**: Verifies server identity on first connection, protects against MITM attacks
- **SHA256 Fingerprints**: Persisted to `~/.sanscraft-vsdactyl-known-hosts.json`
- **Graceful Handling**: Supports reconnection with host verification checks

#### Secrets Storage
- **Automatic Migration**: Legacy private key data migrated from VS Code globalState to secrets storage
- **Enhanced Protection**: API keys, passwords, and private keys now stored securely
- **Transparent Migration**: Existing accounts automatically upgraded on first load

### 🐛 Bug Fixes & Improvements

#### Filesystem Contract Compliance
- **Recursive Delete**: Properly deletes nested directories and files
- **Overwrite Handling**: Delete operations now correctly handle existing files
- **Error Mapping**: Consistent translation of SFTP errors to VS Code FileSystemError types

#### Stability
- **Timeout Consistency**: Fixed timeout message to reflect actual 12s value
- **Error Logging**: Removed sensitive details from debug logs (no key previews or password hints)
- **Resource Cleanup**: Proper disposal of SFTP connections on extension deactivation

#### User Experience
- **Clear Error Messages**: More informative connection failure messages
- **Improved Forms**: Better validation and error feedback in account setup
- **Consistent Naming**: All dialogs and messages use VSDactyl branding

## 📋 Migration Guide

### For Existing Users
- ✅ **Automatic**: All settings and accounts migrate automatically
- ✅ **No Manual Action Required**: Your connections will continue working
- ✅ **Host Keys**: First connection will establish trust (one-time verification)
- ✅ **Secrets**: Private keys automatically secured in VS Code secrets storage

### Known Compatibility
- **VS Code**: 1.80.0 or later
- **Node.js**: 20 (for development)
- **Platforms**: Windows, macOS, Linux

## 🔄 Changes from Original Repository

This fork maintains compatibility with the original Pterodactyl extension while adding:
- Enhanced security (TOFU host key verification, proper secret storage)
- Better filesystem operations (recursive delete, overwrite-aware rename)
- Improved lifecycle management (SFTP restore, proper cleanup)
- New UX features (sync status badges, drag/drop, context menus)
- Fixed bugs in file operations and error handling
- Professional rebranding and documentation

## 🆘 Known Issues

- Known-hosts file path uses `.sanscraft-vsdactyl-known-hosts.json` for backward compatibility
- Vietnamese tutorial included; additional language tutorials welcome via contributions

## 🙏 Acknowledgments

- **MinhMCPC**: Original Pterodactyl extension creator
- **SansCraft Network**: Maintaining and enhancing the fork
- **Contributors**: Community feedback and testing

## 📞 Support

- **GitHub Issues**: [Report bugs or request features](https://github.com/SansCraft-Network/VSdactyl/issues)
- **Discussions**: [Join community discussions](https://github.com/SansCraft-Network/VSdactyl/discussions)

## 📦 Installation

### From Marketplace
1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X / Cmd+Shift+X)
3. Search for "VSDactyl"
4. Click Install

### From Source
```bash
git clone https://github.com/SansCraft-Network/VSdactyl
cd VSdactyl
npm install
npm run compile
# Press F5 to debug
```

---

**VSDactyl 2.1.0-vsdactyl.1** is a stable pre-release. We welcome feedback and contributions!
