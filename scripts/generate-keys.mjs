import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

console.log('=== PRIVATE KEY ===');
console.log(privateKey);
console.log('=== PUBLIC KEY ===');
console.log(publicKey);

// Write to .env format (escape newlines)
const envPrivate = privateKey.replace(/\n/g, '\\n');
const envPublic = publicKey.replace(/\n/g, '\\n');

console.log('\n=== FOR .env FILE ===');
console.log(`JWT_PRIVATE_KEY="${envPrivate}"`);
console.log(`JWT_PUBLIC_KEY="${envPublic}"`);

// Also write raw files for easier debugging
fs.mkdirSync('keys', { recursive: true });
fs.writeFileSync('keys/private.pem', privateKey);
fs.writeFileSync('keys/public.pem', publicKey);
console.log('\nKeys also written to keys/private.pem and keys/public.pem');
