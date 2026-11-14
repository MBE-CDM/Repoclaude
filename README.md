# TestHub — connecteurs d'environnement et exécution technique

Implémentation de la section **2.10** : environnements cibles, exécution UI/API sur l'URL de l'application, connecteurs de bases de données, contrôles SQL, préparation et nettoyage des données, scripts et batchs, orchestration, sécurité et traçabilité.

```
server/   API Fastify + moteur d'exécution (TypeScript, Node 22)
web/      Interface React (Vite) servie par le serveur une fois construite
agent/    Agent d'exécution autonome (agent.mjs, sans dépendance) à installer sur les serveurs cibles
scripts/  it-up.sh : bases et serveur SSH Docker pour les tests d'intégration
```

## Démarrage

```bash
npm install
npm run build                 # construit le front (web/dist) et vérifie les types du serveur
TESTHUB_MASTER_KEY=$(openssl rand -hex 32) npm start
```

Au premier démarrage, un jeton administrateur est affiché et enregistré dans `server/data/admin.token`. On peut aussi l'imposer avec `TESTHUB_ADMIN_TOKEN`. Ouvrez `http://localhost:8080`.

En développement : `npm run dev:server`, puis `npm run dev:web` (Vite sur le port 5173, qui redirige `/api` vers le port 8080).

| Variable | Rôle |
|---|---|
| `TESTHUB_MASTER_KEY` | Clé AES-256 (64 caractères hexadécimaux, ou phrase de passe). Si elle est absente, une clé est générée dans `data/master.key` (mode 0600). |
| `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_MOUNT` | Si elles sont définies, les secrets sont écrits dans HashiCorp Vault (KV v2) au lieu d'être chiffrés localement. |
| `TESTHUB_PROD_POLICY` | `dual-approval` (par défaut) ou `forbid`. |
| `TESTHUB_DATA_DIR`, `TESTHUB_PORT`, `TESTHUB_HOST` | Stockage (SQLite et preuves), port, interface d'écoute. |
| `TESTHUB_HEADLESS=false` | Navigateur visible par défaut pour les étapes UI. |

## Ce que couvre l'implémentation

### Environnements cibles
- Chaque environnement (DEV, INT, RECETTE, PREPROD, PROD) déclare : les URL front et API, le chemin de health-check, des variables, les comptes de test par profil, les bases, les serveurs SSH, les agents, les ordonnanceurs, les partages de fichiers et les colonnes sensibles.
- Les secrets (mots de passe, clés SSH, jetons) sont scellés en AES-256-GCM ou dans Vault avant d'être stockés. L'API ne les renvoie jamais : elle affiche `{ "set": true }` à la place.
- Le bouton « Tester les connexions » vérifie la connexion TCP (ping), le health-check HTTP, le login (par API ou par UI avec Playwright), chaque base, chaque serveur SSH, les agents et les ordonnanceurs.
- Les cas désignent les ressources par leur **nom logique** (`database: "principale"`, `server: "batch01"`, `profile: "admin"`). Une campagne ou un lancement peut imposer un autre environnement sans modifier les cas.

### Exécution sur l'URL de l'application
- **Étape `ui`** : actions Playwright (`goto`, `login`, `click`, `fill`, `select`, `expectText`, `expectUrl`, `extract`, `screenshot`, etc.), en mode headless ou visible.
- **Preuves capturées automatiquement** : captures d'écran (dont une capture à l'échec), vidéo `.webm`, trace Playwright, trafic réseau HAR et logs console.
- **Enregistreur** : ouvre un navigateur sur l'URL front et capture les clics, saisies et sélections, puis les convertit en cas de test. Les mots de passe sont remplacés par `{{motDePasse}}`.
- **Étape `api`** : REST, GraphQL ou SOAP. Assertions sur le code HTTP, JSONPath (y compris sur le XML d'une réponse SOAP), le temps de réponse, les en-têtes et le corps. Les valeurs peuvent être extraites vers des variables.

### Connecteurs bases de données
- PostgreSQL, Oracle (mode thin, sans Instant Client), SQL Server, MySQL/MariaDB, SQLite et MongoDB. DB2 passe par le module natif `ibm_db`, qui est optionnel.
- Paramètres de connexion : hôte, port, base, schéma, utilisateur, mot de passe chiffré, SSL et **tunnel SSH**.
- **Lecture seule par défaut.** Le garde SQL analyse chaque instruction, après avoir neutralisé les commentaires et les littéraux. Il bloque :
  - toute écriture sur une connexion en lecture seule ;
  - `DROP`, `TRUNCATE`, `DELETE` ou `UPDATE` sans `WHERE`, `ALTER … DROP`, `GRANT`, le SQL dynamique et les blocs procéduraux à risque, sauf double autorisation (`allowDestructive` sur la connexion **et** sur l'étape ou la requête).

  En plus du garde, PostgreSQL et MariaDB ouvrent la session elle-même en lecture seule.
- **Éditeur SQL intégré** : coloration selon le dialecte, autocomplétion des tables et colonnes, explorateur de schéma, analyse en direct (lecture, écriture, destructif) et exécution avec Ctrl+Entrée.

### Contrôles SQL (étape `sql`)
- Requête paramétrée : `SELECT statut FROM commande WHERE id = {{commande.id}}`. Chaque `{{var}}` devient un **paramètre lié**, jamais du texte concaténé.
- Assertions : valeur attendue, nombre de lignes, existence ou absence, comparaison avec un résultat de référence, plage de valeurs, regex.
- `mode: snapshot`, puis `mode: diff` : comparaison avant/après par clé, sur les lignes ajoutées, supprimées, modifiées et les colonnes modifiées.
- `mode: integrity` : clés étrangères orphelines, doublons, champs obligatoires, cohérence entre tables, requête personnalisée.
- Le résultat de chaque requête est joint comme preuve, avec les données sensibles masquées.

### Préparation et nettoyage des données
- `setup` et `teardown` SQL au niveau du cas et de la campagne. Toutes les instructions sont contrôlées **avant** l'exécution de la première.
- `transactional: ["principale"]` : toutes les écritures du cas sur cette base sont annulées en fin de cas.
- Points de restauration : `mode: savepoint` et `mode: rollbackTo`.

### Scripts et batchs
- **Étape `script`** : Shell, PowerShell ou Python sur un serveur distant (SSH) ou via l'agent. Le SQL multi-instructions et les procédures stockées passent par l'étape `sql` en `mode: procedure`.
- **Étape `batch`** : commande SSH ou agent, Jenkins, GitLab CI, Airflow, Control-M (Automation API). Elle attend la fin, vérifie le code retour et le timeout, contrôle les fichiers produits, puis enchaîne des vérifications (`then`, par exemple un contrôle SQL de l'effet du batch).
- Suivi : statut, code retour, durée, stdout et stderr diffusés **en temps réel** (SSE) dans l'interface, timeout configurable.
- **Fichiers** (étape `file` ou `files` d'un batch) : CSV, XML, JSON et positionnel, lus sur SFTP, sur un partage monté ou via l'agent. Contrôles disponibles : présence, format, nombre de lignes et d'enregistrements, contenu, JSONPath, comparaison avec un fichier de référence.

### Orchestration
- Un cas enchaîne librement des étapes UI, API, SQL, Batch, Fichier et Script.
- Les variables passent d'une étape à l'autre avec `extract`. Par exemple, l'ID créé dans l'UI est réutilisé dans la requête SQL suivante.
- Jeux de données : avec un tableau, le cas est rejoué pour chaque ligne.
- Campagnes planifiées (cron, fuseau horaire) et déclenchement CI/CD par webhook :
  ```bash
  curl -X POST -H "X-TestHub-Token: <jeton>" "https://testhub/api/hooks/campaigns/<id>?wait=true"
  ```
  La réponse contient `result`.

### Sécurité et traçabilité
- Le journal d'audit enregistre chaque requête SQL, script, batch, appel API, test de connexion et modification de configuration : qui, quand, sur quel environnement, quoi et avec quel résultat. Les entrées bloquées y figurent aussi.
- **Production** : selon la politique, l'exécution y est interdite, ou soumise à double validation (deux valideurs distincts du demandeur, validation à usage unique). La règle s'applique aussi à l'éditeur SQL.
- Masquage automatique dans les logs, preuves, HAR, rapports et audit : secrets de l'environnement, en-têtes d'authentification, paires `password=`/`token=`, cartes bancaires (contrôle de Luhn), IBAN et colonnes déclarées sensibles.
- Rôles : `admin`, `tester`, `approver`, `viewer`. L'authentification se fait par jeton Bearer.

## Agent d'exécution

À installer sur un serveur sans SSH, ou sous Windows :

```bash
AGENT_TOKEN=<secret> AGENT_PORT=8765 AGENT_FILE_ROOTS=/data/exports node agent/agent.mjs
# HTTPS : AGENT_TLS_CERT=cert.pem AGENT_TLS_KEY=key.pem
```

Déclarez-le ensuite dans l'environnement (`agents: [{ name, url, token }]`).

## Exemple de cas orchestré

```json
{
  "name": "Commande de bout en bout",
  "dataset": { "produit": "Clavier" },
  "transactional": ["principale"],
  "steps": [
    { "type": "ui", "actions": [
      { "action": "login", "profile": "vendeur" },
      { "action": "fill", "selector": "[data-testid=produit]", "value": "{{produit}}" },
      { "action": "click", "selector": "button:has-text('Créer')" },
      { "action": "extract", "var": "commandeId", "selector": "#cmd-id" } ] },
    { "type": "sql", "database": "principale", "query": "SELECT statut FROM commande WHERE id = {{commandeId}}",
      "assertions": [{ "type": "value", "column": "statut", "value": "CREEE" }] },
    { "type": "batch", "launcher": { "kind": "ssh", "server": "batch01", "command": "/opt/batch/export.sh {{commandeId}}" },
      "files": [{ "source": { "share": "exports", "path": "export_{{commandeId}}.csv" }, "format": "csv",
                  "assertions": [{ "type": "recordCount", "value": 1 }] }],
      "then": [{ "type": "sql", "database": "principale", "query": "SELECT COUNT(*) AS n FROM commande WHERE id = {{commandeId}} AND statut = 'EXPORTEE'",
                 "assertions": [{ "type": "value", "column": "n", "value": 1 }] }] }
  ]
}
```

## Tests

```bash
npm test                                        # tests unitaires et de bout en bout (application cible, agent, Chromium)
./scripts/it-up.sh && TESTHUB_IT=1 npm test     # + PostgreSQL, MariaDB, SQL Server, Oracle, MongoDB et SSH réels
```

## Limites connues
- **DB2** : le connecteur est écrit mais n'a pas été validé. Il faut le module natif `ibm_db`, qui télécharge le clidriver IBM à l'installation. Si ce téléchargement est bloqué, installez le clidriver puis lancez `npm rebuild ibm_db`.
- **MySQL** : seul MariaDB a été testé réellement. MySQL utilise le même pilote (`mysql2`).
- **Ordonnanceurs** : Jenkins, GitLab, Airflow et Control-M sont appelés via leurs API publiques documentées, mais n'ont pas été testés sur de vraies instances.
- **Enregistreur** : le navigateur s'ouvre sur la machine qui héberge TestHub. Il faut donc un affichage, ou le mode headless pour les tests automatisés.
- **SQL Server** : une lecture faite depuis une autre connexion pendant un cas en rollback transactionnel attend les verrous. Le délai est réglable avec `options.lockTimeoutMs`, 30 s par défaut.
