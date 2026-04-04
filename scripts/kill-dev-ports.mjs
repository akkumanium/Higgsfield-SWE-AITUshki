import { execFileSync } from 'node:child_process';

const ports = [3001, 3002, 5173];

function getListeningPids(port) {
  try {
    const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
    const pids = new Set();

    for (const line of output.split(/\r?\n/)) {
      if (!line.includes(`:${port} `) || !line.includes('LISTENING')) {
        continue;
      }

      const columns = line.trim().split(/\s+/);
      const pid = Number(columns.at(-1));
      if (Number.isInteger(pid) && pid > 0) {
        pids.add(pid);
      }
    }

    return [...pids];
  } catch {
    return [];
  }
}

function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
  } catch {
    // Ignore failures when a process exits between netstat and taskkill.
  }
}

const pidsToKill = new Set();

for (const port of ports) {
  for (const pid of getListeningPids(port)) {
    pidsToKill.add(pid);
  }
}

for (const pid of pidsToKill) {
  killPid(pid);
}