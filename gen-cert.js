/**
 * Generate a self-signed X.509 certificate + private key for local HTTPS.
 * cert.pem must be a real certificate (-----BEGIN CERTIFICATE-----), not a raw public key,
 * or Node will fail with ERR_OSSL_PEM_NO_START_LINE / setCert errors.
 *
 * Usage: node gen-cert.js [commonName]
 * Example: node gen-cert.js 10.6.12.132
 */
const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

async function main() {
  const cn = process.argv[2] || process.env.SSL_COMMON_NAME || '10.6.12.132';
  const outDir = __dirname;

  const attrs = [{ name: 'commonName', value: cn }];
  const notBefore = new Date();
  const notAfter = new Date(notBefore);
  notAfter.setFullYear(notAfter.getFullYear() + 1);

  const pems = await selfsigned.generate(attrs, {
    keySize: 2048,
    notBeforeDate: notBefore,
    notAfterDate: notAfter,
    algorithm: 'sha256',
  });

  const keyPath = path.join(outDir, 'key.pem');
  const certPath = path.join(outDir, 'cert.pem');

  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);

  console.log('✅ Wrote X.509 self-signed cert for CN=%s', cn);
  console.log('   ', keyPath);
  console.log('   ', certPath);
  console.log('Copy these files to your production app folder (e.g. C:\\inetpub\\Dynamic Dashboard) and restart.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
