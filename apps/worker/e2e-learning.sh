#!/usr/bin/env bash
# Runner do E2E determinístico do aprendizado contínuo (e2e-learning.ts).
#
# Sobe um Postgres 16 DESCARTÁVEL (mesma major da produção — docker/docker-compose.yml),
# aplica as migrations, roda o script determinístico (LLM stubado) e derruba tudo. Sem
# credencial real, sem rede: só o SQL real contra um banco real.
#
# Dois modos (auto-detectados):
#   • docker  — se o daemon estiver acessível: sobe `postgres:16-alpine` num container efêmero.
#   • local   — senão: initdb + pg_ctl num cluster temporário no diretório de scratch.
#
# Uso: cd apps/worker && ./e2e-learning.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKER_DIR="$REPO_ROOT/apps/worker"
DB_NAME="learning_e2e"
DB_USER="postgres"
DB_PASS="postgres"
PGPORT="${PGPORT:-5544}"

cleanup() { :; }
trap 'cleanup' EXIT

start_docker() {
  echo "▶ modo docker — subindo postgres:16-alpine efêmero na porta $PGPORT"
  docker rm -f trafego-learning-e2e >/dev/null 2>&1 || true
  docker run -d --name trafego-learning-e2e \
    -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASS" -e POSTGRES_DB="$DB_NAME" \
    -p "$PGPORT:5432" postgres:16-alpine >/dev/null
  cleanup() { docker rm -f trafego-learning-e2e >/dev/null 2>&1 || true; }
  for _ in $(seq 1 30); do
    if docker exec trafego-learning-e2e pg_isready -U "$DB_USER" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "postgres (docker) não subiu a tempo" >&2; exit 1
}

start_local() {
  echo "▶ modo local — initdb + pg_ctl (daemon docker indisponível)"
  # vars de nível de script (NÃO `local`): o trap de cleanup as lê depois que a função retorna.
  PGBIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1)"
  if [ -z "$PGBIN" ]; then echo "sem binários de postgres e sem docker — não dá p/ rodar o E2E" >&2; exit 1; fi
  # initdb/postgres não rodam como root → executa como o usuário `postgres` do sistema.
  local runas=""
  if [ "$(id -u)" = "0" ]; then runas="postgres"; fi
  PGBASE="$(mktemp -d)"
  PGDATA="$PGBASE/pgdata"; PGSOCK="$PGBASE/sock"
  mkdir -p "$PGDATA" "$PGSOCK"
  if [ -n "$runas" ]; then chown -R "$runas" "$PGBASE"; fi
  PGRUN="bash -c"
  [ -n "$runas" ] && PGRUN="runuser -u $runas -- bash -c"
  $PGRUN "'$PGBIN/initdb' -D '$PGDATA' -U '$DB_USER' --auth=trust >/dev/null"
  $PGRUN "'$PGBIN/pg_ctl' -D '$PGDATA' -o '-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1' -w start >/dev/null"
  cleanup() {
    ${PGRUN:-bash -c} "'$PGBIN/pg_ctl' -D '$PGDATA' -m immediate stop >/dev/null 2>&1" || true
    rm -rf "$PGBASE" 2>/dev/null || true
  }
  $PGRUN "'$PGBIN/createdb' -h 127.0.0.1 -p $PGPORT -U '$DB_USER' '$DB_NAME'"
}

# docker só quando o daemon responde E a imagem já está local (o pull pode estar bloqueado
# pelo proxy do ambiente). Senão, cluster local com os binários do postgres.
if [ "${E2E_PG_MODE:-auto}" = "local" ]; then
  start_local
elif [ "${E2E_PG_MODE:-auto}" = "docker" ]; then
  start_docker
elif docker ps >/dev/null 2>&1 && docker image inspect postgres:16-alpine >/dev/null 2>&1; then
  start_docker
else
  start_local
fi

export DATABASE_URL="postgres://$DB_USER:$DB_PASS@127.0.0.1:$PGPORT/$DB_NAME"
echo "▶ migrando ($DATABASE_URL)"
( cd "$REPO_ROOT/packages/db" && npx tsx src/migrate.ts )

echo "▶ rodando o E2E determinístico do aprendizado"
( cd "$WORKER_DIR" && npx tsx e2e-learning.ts )
