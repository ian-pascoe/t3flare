// Types of relay.js for apps/environment/test/opencodeKeyPlugin.test.ts (the plugin itself is plain JavaScript).
export declare const RELAY: string;
export declare const ENDPOINT_PROVIDER: string;
export declare const ENDPOINT_ID: RegExp;
export declare const HANDLE: RegExp;
export declare const PACKAGE_PATHS: Readonly<Record<string, string>>;
export declare const PLACEHOLDER: string;
export declare const HOLDER_CMDLINE: string;
export declare const relayProviders: (config: unknown) => ReadonlyArray<{ readonly providerID: string; readonly endpoint: string }>;
export declare const atRelay: (url: string, endpoint: string) => boolean;
export declare const putHandle: (headers: Headers, url: string, endpoint: string, handle: string) => boolean;
export declare const handleFrom: (cmdline: string, environ: string, exec: string | undefined) => string;
