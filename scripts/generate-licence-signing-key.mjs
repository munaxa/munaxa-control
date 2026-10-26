#!/usr/bin/env node
// Generates a licence-signing key pair (ECDSA P-256, for ES256).
//
//   pnpm keys:generate --out deploy/secrets/licence_signing_private_key.pem --kid licence-2026-11
//
// The private key is written to --out with mode 0600 and is never printed. The public key and its
// kid are printed: that is what installations and the product repositories are given.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
};
const out = arg('out');
const kid = arg('kid');
if (!out || !kid) {
  console.error('usage: generate-licence-signing-key --out <private key file> --kid <key id>');
  process.exit(1);
}
if (existsSync(out)) {
  console.error(
    `${out} exists. Refusing to overwrite a signing key; rotate with a new file and kid.`,
  );
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
  mode: 0o600,
  flag: 'wx',
});
console.log(
  JSON.stringify(
    { kid, algorithm: 'ES256', publicKey: publicKey.export({ type: 'spki', format: 'pem' }) },
    null,
    2,
  ),
);
console.error(
  `private key written to ${out} (0600). Set LICENCE_SIGNING_PRIVATE_KEY_FILE and LICENCE_SIGNING_KID=${kid}.`,
);
