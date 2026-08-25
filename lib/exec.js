'use strict';

const childProcess = require('child_process');

// Spawn without a shell, so '-DDEFENV_SYSTEMC=""' survives verbatim: the macro
// has to expand to a string literal, and a shell would eat the inner quotes.
const exec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  const child = childProcess.spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env || process.env,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  });

  let stdout = '';
  let stderr = '';
  if (opts.capture) {
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
  }

  child.on('error', reject);
  child.on('close', code => {
    if (code === 0 || opts.allowFailure) {
      resolve({code, stdout, stderr});
    } else {
      const err = new Error(cmd + ' ' + args.join(' ') + ' exited ' + code);
      err.code = code;
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    }
  });
});

const execCapture = async (cmd, args, opts = {}) =>
  (await exec(cmd, args, {...opts, capture: true})).stdout.trim();

module.exports = {exec, execCapture};
