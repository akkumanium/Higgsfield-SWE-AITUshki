export const demoSmokeSpec = {
  name: 'demo smoke',
  status: 'ready-for-implementation',
  steps: [
    'open the shared room',
    'verify sync connection transitions to connected',
    'trigger the agent from the canvas',
    'confirm the resulting tool action is planned',
    'confirm the canvas mutation plan is coherent',
  ],
};
