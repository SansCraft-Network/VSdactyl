export type AccountType = 'pterodactyl' | 'sftpOnly';

export interface BaseAccount {
    id: string;
    name: string;
    type: AccountType;
    branding?: 'SansCraft Network Corp';
    username: string;
    sftpAuthMethod: 'password' | 'ssh-key'; // SFTP authentication method
    privateKeyPath: string; // Path to SSH private key file
    privateKeyData: string; // Pasted/generated SSH private key content
    publicKeyData?: string; // Generated SSH public key content (optional, added for reference)
}

export interface PterodactylAccount extends BaseAccount {
    type: 'pterodactyl';
    panelUrl: string;
    authMethod: 'api-key' | 'cookie';
    apiKey?: string; // Not saved in globalState directly anymore, fetched from secrets
    password?: string; // Panel login password (for SFTP password auth / cookie), from secrets
    panelPassword?: string; // Dedicated panel login password, from secrets
    panelAutoLogin?: boolean; // Whether to auto-fill and auto-login on panel webview
}

export interface SftpOnlyAccount extends BaseAccount {
    type: 'sftpOnly';
    host: string;
    port: number;
    password?: string; // Fetched from secrets
}

export type PteroAccount = PterodactylAccount | SftpOnlyAccount;

export interface ExportedAccountData {
    version: string;
    exportedAt: string;
    accounts: (PteroAccount & { apiKey?: string; password?: string })[];
}
