import { openDatabase } from './db.js';
import { createApp } from './app.js';

const dataDir = process.env.DATA_DIR || new URL('../data', import.meta.url).pathname;
const db = openDatabase(process.env.DB_PATH || `${dataDir}/title.db`);
const app = createApp({ db, uploadDir: `${dataDir}/uploads` });

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`MS Title Co running at http://localhost:${port}`));
