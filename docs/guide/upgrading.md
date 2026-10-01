# Upgrading

Upgrading Pithagoras is pulling a newer version and starting it. When the new version changes the database, it checks and backs it up first. While that runs, it shows a page instead of the portal.

## What happens on the first start

The database records its schema version. A new version that needs a newer schema does this before the portal opens:

1. **Checks the database** with SQLite's `quick_check`, which reads every page. On a large database this can take a few minutes.
2. **Backs it up** with SQLite's online backup, to `backups/` in the data folder (`/data/backups` in the image). The file is named after the schema version it came from, for example `portal-v0-20261001-142914.db`. The two newest backups are kept and older ones are removed.
3. **Upgrades it** in one transaction. Either every change is made or none is, so a failure leaves the database as it was, at its old version.

Meanwhile the portal's address shows an **Upgrading** page that reloads itself, and API calls answer `503` with a message saying so. The portal opens on its own when the upgrade is done.

A new install has nothing to upgrade. A database already at the current version starts straight away, with no check and no backup.

## When it cannot upgrade

If the database is damaged, or there is no room for the backup, nothing is changed. The portal stays up showing the page with the reason, and the log says the same. It doesn't exit, which in Docker would only restart it into the same failure.

### No room for the backup

The backup needs about the size of `portal.db` plus its `-wal` file, with some margin. Free that much space on the volume holding the data folder and restart.

If you can't, and you accept upgrading without a backup, start once with:

```sh
PORTAL_UPGRADE_BACKUP=skip
```

### A damaged database

SQLite can recover everything still readable into a new file. With the Compose deployment, the data volume is `pithagoras_portal-data` unless yours is named otherwise:

```sh
docker compose stop portal

# Recover what can be read into a new file
docker run --rm -v pithagoras_portal-data:/data alpine sh -c \
  "apk add -q sqlite && sqlite3 /data/portal.db .recover | sqlite3 /data/portal-recovered.db"

# Keep the damaged file, put the recovered one in its place
docker run --rm -v pithagoras_portal-data:/data alpine sh -c \
  "cd /data && mv portal.db portal-damaged.db && rm -f portal.db-wal portal.db-shm && mv portal-recovered.db portal.db"

docker compose start portal
```

The portal checks the recovered database before upgrading it. Rows on damaged pages can't be recovered, which usually means part of the event history of some conversations. Once you're happy with the result, delete `portal-damaged.db`.

## Going back

To return to the version you had:

1. Stop the portal.
2. Put the backup back as `portal.db`, and remove `portal.db-wal` and `portal.db-shm` beside it.
3. Start the previous version.

An older version starts on a newer database too, because upgrades only add tables and columns. Restoring the backup is the way to be sure nothing differs.
