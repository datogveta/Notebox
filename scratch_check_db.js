const admin = require('firebase-admin');
const serviceAccount = require('./firebase_service_account_notebox.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function main() {
  console.log("--- Telegram Users ---");
  const usersSnapshot = await db.collection('telegram_users').get();
  if (usersSnapshot.empty) {
    console.log("No registered telegram users found.");
  } else {
    usersSnapshot.forEach(doc => {
      console.log(`Chat ID: ${doc.id} =>`, doc.data());
    });
  }

  console.log("\n--- Last 5 Notes ---");
  const notesSnapshot = await db.collection('notes').orderBy('createdAt', 'desc').limit(5).get();
  if (notesSnapshot.empty) {
    console.log("No notes found.");
  } else {
    notesSnapshot.forEach(doc => {
      const data = doc.data();
      console.log(`Note ID: ${doc.id} =>`, {
        uid: data.uid,
        title: data.title,
        status: data.status,
        source: data.source,
        createdAt: data.createdAt ? data.createdAt.toDate() : null
      });
    });
  }
}

main().catch(console.error);
