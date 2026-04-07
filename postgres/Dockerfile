# =============================================================================
# Custom PostgreSQL image for ECS deployment.
# Bakes init-databases.sql into the image so it runs on first startup via
# the postgres entrypoint's /docker-entrypoint-initdb.d/ mechanism.
#
# Build context must be the project root so COPY can reach init-databases.sql:
#   docker build -f postgres/Dockerfile -t postgres-demo .
# =============================================================================

FROM postgres:16-alpine

COPY init-databases.sql /docker-entrypoint-initdb.d/01-init-databases.sql

EXPOSE 5432
