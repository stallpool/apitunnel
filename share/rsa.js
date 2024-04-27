const i_crypto = require('node:crypto');

function _randomPassphrase(n) {
   const p = Buffer.alloc(n);
   i_crypto.randomFillSync(p);
   return p;
}

function rsaKeyGen(passphrase) {
   if (!passphrase) passphrase = _randomPassphrase(16);
   const {
      publicKey,
      privateKey,
   } = i_crypto.generateKeyPairSync('rsa', {
      modulusLength: 4096,
      publicKeyEncoding: {
         type: 'spki',
         format: 'pem',
      },
      privateKeyEncoding: {
         type: 'pkcs8',
         format: 'pem',
         cipher: 'aes-256-cbc',
         passphrase,
      },
   });
   return { pu: publicKey, pr: privateKey, k: passphrase };
}

function rsaPrEncode(key, buf) {
   return i_crypto.privateEncrypt(key, buf);
}

function rsaPuDecode(key, buf) {
   return i_crypto.publicDecrypt(key, buf);
}

/*
const {pr, k, pu} = rsaKeyGen();
const testbuf = rsaPrEncode({ key: pr, passphrase: k }, Buffer.from('hello world'));
const outbuf = rsaPuDecode(pu, testbuf);
console.log(testbuf.toString('base64'), outbuf.toString());
*/

module.exports = {
   rsaKeyGen,
   rsaPrEncode,
   rsaPuDecode,
};
