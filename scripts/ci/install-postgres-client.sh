#!/usr/bin/env bash
# Install the PostgreSQL CLIENT whose major matches the embedded server the database lane drives.
#
# WHY THIS EXISTS. Two controls in the frozen ABC-27 real-Postgres suite
# (src/test/abc27RecipientSnapshot.realpg.test.ts) drive a REAL `psql` against the embedded
# PostgreSQL that `embedded-postgres` bundles, and refuse a client of another major outright: the
# runbook's `\gset` capture is evidence only when the client is the server's own major. GitHub's
# ubuntu-latest image ships PostgreSQL 16's psql, so the lane failed closed there until a matching
# client is installed and named to the suite through `ABC27_PSQL`. This script is that install.
#
# scripts/ci/workflow-contract.mjs pins its shape: the major below, the path it produces and the
# `ABC27_PSQL` the workflow hands the suite must all agree with package.json's `embedded-postgres`
# major, or the contract — run by two required checks — turns red. Edit them together.
#
# FAIL CLOSED. Every step can abort, the signing key is accepted only on its full fingerprint, and
# the last step re-reads the installed client's own `--version` rather than trusting apt: a
# wrong-major client is refused HERE, with a message, not minutes later inside a test.
set -euo pipefail

PG_MAJOR=18
PSQL=/usr/lib/postgresql/18/bin/psql
PGDG_KEY_URL=https://www.postgresql.org/media/keys/ACCC4CF8.asc
# "PostgreSQL Debian Repository" (key id ACCC4CF8). The downloaded key is trusted only when its
# full fingerprint is exactly this one.
PGDG_KEY_FINGERPRINT=B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8
PGDG_KEYRING=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
PGDG_LIST=/etc/apt/sources.list.d/pgdg-ci.list

die() { echo "install-postgres-client: $*" >&2; exit 1; }

# Root inside a container (the local verification), an unprivileged runner user with passwordless
# sudo on GitHub-hosted runners.
if [ "$(id -u)" = "0" ]; then SUDO=""; else SUDO="sudo"; fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl --fail --silent --show-error --location --retry 3 --retry-delay 2 \
  --output "$tmp/pgdg-download.asc" "$PGDG_KEY_URL"
# THE DOWNLOAD IS NEVER INSTALLED AS-IS. It is imported into a throwaway keyring and ONLY the key
# with the pinned fingerprint is exported back out; a bundle that carries the right key first and
# another key after it can therefore neither pass the check below nor reach apt. The exported
# keyring is then re-read and must hold exactly one public key, with exactly that fingerprint.
export GNUPGHOME="$tmp/gnupg"
mkdir -m 0700 "$GNUPGHOME"
gpg --batch --quiet --import "$tmp/pgdg-download.asc"
gpg --batch --quiet --armor --export "$PGDG_KEY_FINGERPRINT" > "$tmp/pgdg.asc"
key_summary="$(gpg --batch --quiet --show-keys --with-colons --with-fingerprint "$tmp/pgdg.asc" \
  | awk -F: '$1 == "pub" { n++ } $1 == "fpr" && !f { f = $10 } END { print n ":" f }')"
[ "$key_summary" = "1:${PGDG_KEY_FINGERPRINT}" ] || die "the exported PGDG keyring is '${key_summary}', expected exactly one key with fingerprint ${PGDG_KEY_FINGERPRINT}"

$SUDO install -d -m 0755 "$(dirname "$PGDG_KEYRING")"
$SUDO install -m 0644 "$tmp/pgdg.asc" "$PGDG_KEYRING"
. /etc/os-release
[ -n "${VERSION_CODENAME:-}" ] || die "cannot read the distribution codename from /etc/os-release"
echo "deb [signed-by=$PGDG_KEYRING] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
  | $SUDO tee "$PGDG_LIST" > /dev/null

# Refresh ONLY the PGDG source. The runner image's other sources are irrelevant here, and one of
# them being unreachable must not fail this install.
$SUDO apt-get update \
  -o Dir::Etc::sourcelist="$PGDG_LIST" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 \
  -o Acquire::Retries=3
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "postgresql-client-${PG_MAJOR}"

[ -x "$PSQL" ] || die "$PSQL is not executable after installing postgresql-client-${PG_MAJOR}"
version="$("$PSQL" --version)"
case "$version" in
  *"(PostgreSQL) ${PG_MAJOR}."*) ;;
  *) die "$PSQL reports '$version', not PostgreSQL ${PG_MAJOR}.x" ;;
esac
echo "install-postgres-client: $PSQL -> $version"
