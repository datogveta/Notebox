const admin = require('firebase-admin');
const serviceAccount = require('./firebase_service_account_notebox.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

async function main() {
  console.log("--- Auth Users ---");
  const listUsersResult = await admin.auth().listUsers(10);
  listUsersResult.users.forEach((userRecord) => {
    console.log(`UID: ${userRecord.uid} => Email: ${userRecord.email}, Name: ${userRecord.displayName || 'None'}`);
  });
}

main().catch(console.error);
