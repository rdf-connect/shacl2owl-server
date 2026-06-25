/**
 * Entry point: load config, read the baked-in N3 rules once, start the server,
 * and shut down cleanly on SIGINT/SIGTERM.
 */
import {loadConfig} from './config.js';
import {buildServer} from './server.js';
import {$INLINE_FILE} from "@ajuvercr/ts-transformer-inline-file";

/**
 * The N3 rule set, inlined at build time by ts-transformer-inline-file.
 */
const RULES_N3: string = $INLINE_FILE('./properties-mapping.n3');

const config = loadConfig();

const app = await buildServer(RULES_N3, config);

try {
   await app.listen({host: config.host, port: config.port});
} catch (err) {
   app.log.error(err);
   process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
   process.on(signal, () => {
      app
         .close()
         .then(() => process.exit(0))
         .catch(() => process.exit(1));
   });
}
