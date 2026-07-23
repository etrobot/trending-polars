import { spawn } from 'node:child_process';

const processes = [
  spawn('tsx', ['watch', 'server/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn('vite', [], { stdio: 'inherit', env: process.env }),
];

let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of processes) child.kill('SIGTERM');
  process.exit(code);
};

for (const child of processes) {
  child.on('exit', (code, signal) => {
    if (!shuttingDown && (code ?? 0) !== 0 && signal !== 'SIGTERM') shutdown(code ?? 1);
  });
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
