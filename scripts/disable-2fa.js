// Escape hatch: turns two-factor off from the machine running the app, for
// when the authenticator phone is lost or replaced.
//
//   npm run disable-2fa
//
// This requires access to the Mac itself, so it is a safety net rather than a
// way past the login. Everyone signs in with the password alone afterwards.

const auth = require('../auth');

if (!auth.isEnabled()) {
  console.log('\n  Two-factor is already off. Nothing to do.\n');
  process.exit(0);
}

auth.disable();
console.log('\n  Two-factor turned off.');
console.log('  Everyone now signs in with the password alone.');
console.log('  Set it up again from the Security tab whenever you are ready.\n');
