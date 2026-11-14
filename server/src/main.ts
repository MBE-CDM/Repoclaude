import { buildApp } from './app.js';

const { app, cfg, generatedToken } = await buildApp({ logger: true });
await app.listen({ port: cfg.port, host: cfg.host });
if (generatedToken) {
  console.log(`\n  Jeton administrateur initial (aussi enregistré dans ${cfg.dataDir}/admin.token) :\n  ${generatedToken}\n`);
}
console.log(`TestHub démarré sur http://${cfg.host}:${cfg.port} (politique production : ${cfg.prodPolicy})`);
