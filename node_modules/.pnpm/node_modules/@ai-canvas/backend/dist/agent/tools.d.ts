import type { ToolCallEnvelope, ToolName } from '../types/contracts.js';
export interface ToolSchema {
    name: ToolName;
    description: string;
    requiredKeys: string[];
}
export declare function isToolEnabled(toolName: ToolName): boolean;
export declare function getToolSchemas(): ToolSchema[];
export declare const TOOL_SCHEMAS: ToolSchema[];
export declare function isKnownToolName(name: string): name is ToolName;
export declare function validateToolArguments(toolName: ToolName, arguments_: Record<string, unknown>): {
    valid: boolean;
    missingKeys: string[];
};
export declare function createToolEnvelope(turnId: string, toolName: ToolName, arguments_: Record<string, unknown>): ToolCallEnvelope;
//# sourceMappingURL=tools.d.ts.map