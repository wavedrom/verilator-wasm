'use strict';

const fs = require('fs');

const writeFileExtra = (opts) => async (taskName, fname, fbody) => {
  if (opts.verbose) {
    console.log(taskName + ':'); // eslint-disable-line no-console
  }
  await fs.promises.writeFile(fname, fbody);
  if (opts.verbose) {
    console.log(' ', fname, fbody.length); // eslint-disable-line no-console
  }
  return fbody;
};

module.exports = writeFileExtra;
