#!/usr/bin/env node
/**
 * Seed script for Firestore stores collection
 * 
 * Reads stores.json and batch-writes all documents to Firestore.
 * 
 * Prerequisites:
 *   1. Set GOOGLE_APPLICATION_CREDENTIALS environment variable to your service account key path
 *   2. Or run: firebase login && firebase use <your-project-id>
 * 
 * Usage:
 *   node seed-stores.js
 * 
 * The script uses the Admin SDK which bypasses Firestore security rules.
 */

const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// Initialize Firebase Admin
// Uses GOOGLE_APPLICATION_CREDENTIALS env var or Application Default Credentials
admin.initializeApp({
  projectId: 'the-dump-bin'
});

const db = admin.firestore();

async function seedStores() {
  console.log('🚀 Starting store seed process...\n');

  // Read stores.json
  const storesPath = path.join(__dirname, 'stores.json');
  
  if (!fs.existsSync(storesPath)) {
    console.error('❌ Error: stores.json not found at', storesPath);
    process.exit(1);
  }

  const storesData = JSON.parse(fs.readFileSync(storesPath, 'utf8'));
  console.log(`📦 Loaded ${storesData.length} stores from stores.json\n`);

  // Firestore batch writes are limited to 500 operations
  const batchSize = 500;
  let totalWritten = 0;

  for (let i = 0; i < storesData.length; i += batchSize) {
    const batch = db.batch();
    const chunk = storesData.slice(i, i + batchSize);

    for (const store of chunk) {
      // Use storeNumber as document ID (e.g., "#023")
      const docRef = db.collection('stores').doc(store.storeNumber);
      batch.set(docRef, {
        storeNumber: store.storeNumber,
        location: store.location,
        faxNumber: store.faxNumber
      });
    }

    try {
      await batch.commit();
      totalWritten += chunk.length;
      console.log(`✅ Batch ${Math.floor(i / batchSize) + 1}: Wrote ${chunk.length} stores (${totalWritten}/${storesData.length})`);
    } catch (error) {
      console.error(`❌ Error writing batch ${Math.floor(i / batchSize) + 1}:`, error.message);
      process.exit(1);
    }
  }

  console.log(`\n🎉 Successfully seeded ${totalWritten} stores to Firestore!`);
  console.log('\n📋 Sample documents:');
  
  // Show a few sample documents
  const samples = storesData.slice(0, 3);
  samples.forEach(store => {
    console.log(`   ${store.storeNumber} - ${store.location} (${store.faxNumber})`);
  });

  console.log('\n✨ Done! You can verify in the Firebase Console.');
  process.exit(0);
}

// Run the seed function
seedStores().catch(error => {
  console.error('❌ Seed failed:', error);
  process.exit(1);
});
