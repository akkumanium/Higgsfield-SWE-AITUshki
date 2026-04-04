import { runDemoSmokeSpec } from './demo-smoke.spec.js';
async function main() {
    const report = await runDemoSmokeSpec();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'passed') {
        process.exitCode = 1;
    }
}
void main();
//# sourceMappingURL=run-demo-smoke.js.map