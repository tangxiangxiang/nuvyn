# Deployment

The maintained deployment documentation is organized under [`docs/deployment/`](docs/deployment/overview.md):

- [Deployment overview](docs/deployment/overview.md)
- [Docker](docs/deployment/docker.md)
- [Runtime configuration](docs/deployment/configuration.md)
- [Security](docs/deployment/security.md)
- [Backup and restore](docs/deployment/backup-and-restore.md)

For the default Docker deployment:

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:3000/api/health
```

Nuvyn provides single-owner authentication but does not terminate TLS. Review
the security and backup guides before exposing it beyond the local machine.
