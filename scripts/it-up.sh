#!/usr/bin/env bash
# Démarre les bases et le serveur SSH utilisés par les tests d'intégration (TESTHUB_IT=1 npm test).
set -euo pipefail
docker rm -f th-pg th-maria th-mssql th-ora th-mongo th-ssh >/dev/null 2>&1 || true
docker run -d --name th-pg -e POSTGRES_PASSWORD=Pg_pass1 -p 15432:5432 postgres:16-alpine
docker run -d --name th-maria -e MARIADB_ROOT_PASSWORD=Maria_pass1 -e MARIADB_DATABASE=boutique -p 13306:3306 mariadb:11
docker run -d --name th-mssql -e ACCEPT_EULA=Y -e MSSQL_SA_PASSWORD='Mssql_pass1!' -p 11433:1433 mcr.microsoft.com/mssql/server:2022-latest
docker run -d --name th-ora -e ORACLE_PASSWORD=Ora_pass1 -e APP_USER=boutique -e APP_USER_PASSWORD=Ora_pass1 -p 11521:1521 gvenzl/oracle-free:23-slim
docker run -d --name th-mongo -p 37017:27017 mongo:7 --replSet rs0 --bind_ip_all
docker run -d --name th-ssh -e USER_NAME=batch -e USER_PASSWORD=Ssh_pass1 -e PASSWORD_ACCESS=true -p 12222:2222 linuxserver/openssh-server:latest
echo "Initialisation du replica set MongoDB (transactions)…"
for i in $(seq 1 30); do docker exec th-mongo mongosh --quiet --eval 'try { rs.initiate({_id:"rs0",members:[{_id:0,host:"127.0.0.1:27017"}]}).ok } catch (e) { e.codeName }' && break || sleep 2; done
echo "Activation du transfert de port SSH (tunnels)…"
for i in $(seq 1 30); do docker exec th-ssh test -f /config/sshd/sshd_config && break || sleep 2; done
docker exec th-ssh sh -c "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /config/sshd/sshd_config /etc/ssh/sshd_config" && docker restart th-ssh
echo "Conteneurs démarrés. Oracle peut mettre 1 à 2 minutes à être prêt (les tests attendent)."
