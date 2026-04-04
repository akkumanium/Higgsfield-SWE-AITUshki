interface SmokeStepResult {
    name: string;
    passed: boolean;
    details?: string;
}
export interface DemoSmokeReport {
    name: string;
    status: 'passed' | 'failed';
    startedAt: string;
    finishedAt: string;
    steps: SmokeStepResult[];
}
export declare function runDemoSmokeSpec(): Promise<DemoSmokeReport>;
export declare const demoSmokeSpec: {
    name: string;
    run: typeof runDemoSmokeSpec;
};
export {};
//# sourceMappingURL=demo-smoke.spec.d.ts.map