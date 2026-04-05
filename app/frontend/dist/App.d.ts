export declare const defaultRoomId = "demo-room";
export declare const defaultSessionId = "demo-session";
export interface AppOptions {
    roomId?: string;
    sessionId?: string;
    displayName?: string;
    syncUrl?: string;
    backendUrl?: string;
}
export interface MountedApp {
    root: HTMLElement;
    dispose: () => void;
}
export declare function App(root: HTMLElement, options?: AppOptions): MountedApp;
//# sourceMappingURL=App.d.ts.map