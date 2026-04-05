import type { AgentTurnRequest, AgentTurnResponse } from './types/contracts.js';
export declare function isAgentTurnRequest(value: unknown): value is AgentTurnRequest;
export declare function handleAgentTurn(request: AgentTurnRequest): Promise<AgentTurnResponse>;
export declare const backendPort: number;
export declare function createBackendHealth(): {
    status: "ok";
    backendPort: number;
};
interface StartBackendServerOptions {
    port?: number;
}
export declare function startBackendServer(options?: StartBackendServerOptions): Promise<{
    port: number;
    close(): Promise<void>;
}>;
export declare function runBackendServerCli(): Promise<void>;
export {};
//# sourceMappingURL=server.d.ts.map