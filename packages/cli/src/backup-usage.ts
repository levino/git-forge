export const BACKUP_USAGE = `usage: git forge backup keygen <file>
       git forge backup list --from <location> --key <file>
       git forge backup restore --from <location> --key <file> [--snapshot <key>] <owner>/<name> <dir>
       git forge backup check --from <location>
       git forge backup copy --from <location> --to <location>

<location> is a directory or s3://<bucket>[/<prefix>] (S3_ENDPOINT, S3_REGION,
AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE=true).

keygen writes a new recovery key (private X25519 JWK) to <file> and prints the
public key for BACKUP_RECOVERY_KEY. Keep the private key offline.
restore rebuilds a bare repository with its LFS objects in <dir> (clone it
with git clone <dir>) and writes the issue/pull request export, if any, to
<dir>/git-forge-data.json. check and copy need no key.`
