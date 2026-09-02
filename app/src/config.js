const os = require('node:os');
const path = require('node:path');

const dataDir = process.env.AKM_DATA_DIR
  ? path.resolve(process.env.AKM_DATA_DIR)
  : path.join(os.homedir(), '.ai-key-manager');

const port = Number(process.env.AKM_PORT || 37700);

module.exports = { dataDir, port };
