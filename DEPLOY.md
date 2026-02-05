# Production Deployment Guide

This guide walks you through deploying the Employee Handbook Acknowledgement app with the fax-to-store feature.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        GitHub Pages                              │
│                    (Static Frontend)                             │
│              acknowledgement.html, index.html                    │
└─────────────────────┬───────────────────────────────────────────┘
                      │ HTTPS API calls
                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Firebase Cloud Functions                      │
│         sendFax() · sendFaxDirect() · getStores()               │
└─────────────────────┬───────────────────────────────────────────┘
                      │
        ┌─────────────┴─────────────┐
        ▼                           ▼
┌───────────────────┐     ┌─────────────────────┐
│  Firestore        │     │  SMTP → Fax Gateway │
│  stores, fax_log  │     │  Power Automate     │
└───────────────────┘     └─────────────────────┘
```

---

## Prerequisites

1. **Node.js 18+** installed
2. **Firebase CLI** installed globally:
   ```bash
   npm install -g firebase-tools
   ```
3. **Firebase Project** created at [console.firebase.google.com](https://console.firebase.google.com)
4. **SMTP credentials** for your fax gateway email server
5. **Git** configured for GitHub Pages deployment

---

## Step 1: Firebase Project Setup

### 1.1 Login to Firebase
```bash
firebase login
```

### 1.2 Link to Your Firebase Project
Edit `.firebaserc` and replace `YOUR_PROJECT_ID` with your actual Firebase project ID:
```json
{
  "projects": {
    "default": "your-actual-project-id"
  }
}
```

Or run:
```bash
firebase use --add
```
Select your project and give it an alias (e.g., "default").

### 1.3 Enable Required Firebase Services
In the [Firebase Console](https://console.firebase.google.com):
1. Go to **Firestore Database** → Create database (Start in production mode)
2. Go to **Functions** → Get started (requires Blaze plan for external network calls)

> ⚠️ **Important**: Cloud Functions that make external HTTPS calls (like sending email) require the **Blaze (pay-as-you-go) plan**. The free tier won't work for the fax feature.

---

## Step 2: Install Dependencies

```bash
# Install root dependencies
npm install

# Install Cloud Functions dependencies
npm run firebase:functions:install
```

---

## Step 3: Configure SMTP Settings

Set your SMTP credentials using Firebase Functions config:

```bash
firebase functions:config:set \
  smtp.host="your-smtp-server.com" \
  smtp.port="587" \
  smtp.user="your-email@domain.com" \
  smtp.pass="your-password" \
  smtp.from="handbook@yourdomain.com" \
  fax.gateway_email="fax-gateway@yourdomain.com"
```

### Example for common providers:

**Office 365 / Exchange:**
```bash
firebase functions:config:set \
  smtp.host="smtp.office365.com" \
  smtp.port="587" \
  smtp.user="sender@yourcompany.com" \
  smtp.pass="your-password" \
  smtp.from="sender@yourcompany.com" \
  fax.gateway_email="fax-receiver@yourcompany.com"
```

**Gmail (less secure apps must be enabled):**
```bash
firebase functions:config:set \
  smtp.host="smtp.gmail.com" \
  smtp.port="587" \
  smtp.user="your-email@gmail.com" \
  smtp.pass="your-app-password" \
  smtp.from="your-email@gmail.com" \
  fax.gateway_email="fax-receiver@yourcompany.com"
```

### Verify config:
```bash
firebase functions:config:get
```

---

## Step 4: Seed Store Data

Populate Firestore with store data:

```bash
npm run firebase:seed
```

This reads `firebase/stores.json` and batch-writes all 128 stores to Firestore.

> 💡 **Tip**: If you need to update store data, edit `firebase/stores.json` and re-run the seed script. It will overwrite existing documents.

---

## Step 5: Deploy Firebase Backend

### Deploy everything (Functions + Rules):
```bash
npm run firebase:deploy
```

### Or deploy separately:
```bash
# Deploy only Cloud Functions
npm run firebase:deploy:functions

# Deploy only Firestore rules
npm run firebase:deploy:rules
```

### Get your Functions URL:
After deployment, you'll see output like:
```
✔  functions[sendFax(us-central1)]: Successful
✔  functions[sendFaxDirect(us-central1)]: Successful
✔  functions[getStores(us-central1)]: Successful

Function URL (sendFax): https://us-central1-YOUR-PROJECT.cloudfunctions.net/sendFax
```

Copy the base URL: `https://us-central1-YOUR-PROJECT.cloudfunctions.net`

---

## Step 6: Update Frontend Configuration

Edit `acknowledgement.html` and set the `FUNCTIONS_BASE` variable (around line 930):

```javascript
// BEFORE (demo mode):
const FUNCTIONS_BASE = '';

// AFTER (production):
const FUNCTIONS_BASE = 'https://us-central1-YOUR-PROJECT.cloudfunctions.net';
```

---

## Step 7: Deploy Frontend to GitHub Pages

### Option A: Direct push (if GitHub Pages is configured for main branch)
```bash
git add .
git commit -m "Deploy fax feature to production"
git push origin main
```

### Option B: Using gh-pages branch
```bash
# If you use a separate gh-pages branch
git checkout gh-pages
git merge main
git push origin gh-pages
git checkout main
```

### Verify GitHub Pages Settings:
1. Go to your repo → Settings → Pages
2. Ensure Source is set to your deployment branch
3. Your site URL: `https://d6ewasupervisor-netizen.github.io/acknowledge/`

---

## Step 8: Test Production

1. Open your GitHub Pages URL
2. Navigate to the acknowledgement page
3. Click "Print Blank Form at Your Store"
4. Select a store and click "Send Fax"
5. Check your fax gateway email to verify the email was received

---

## Local Development & Testing

### Run emulators (no SMTP needed):
```bash
npm run firebase:emulators
```
This starts local Firestore and Functions emulators at:
- Functions: http://localhost:5001
- Firestore: http://localhost:8080
- Emulator UI: http://localhost:4000

### Run frontend dev server:
```bash
npm run dev
```
Opens at http://localhost:3000

---

## Troubleshooting

### "CORS error" when calling functions
- Ensure CORS is enabled in functions (already configured in `index.js`)
- Check that `FUNCTIONS_BASE` doesn't have a trailing slash

### "Failed to send fax" error
- Verify SMTP config: `firebase functions:config:get`
- Check Firebase Functions logs: `firebase functions:log`
- Ensure Blaze plan is active

### Stores not loading
- Verify seed completed: Check Firestore Console → `stores` collection
- Re-run: `npm run firebase:seed`

### Functions not deploying
- Ensure Node 18 is installed: `node --version`
- Clear and reinstall: `cd firebase/functions && rm -rf node_modules && npm install`

---

## Environment Variables Reference

| Config Key | Description | Example |
|------------|-------------|---------|
| `smtp.host` | SMTP server hostname | `smtp.office365.com` |
| `smtp.port` | SMTP port (usually 587) | `587` |
| `smtp.user` | SMTP username/email | `sender@company.com` |
| `smtp.pass` | SMTP password | `your-password` |
| `smtp.from` | From email address | `handbook@company.com` |
| `fax.gateway_email` | Email monitored by fax server | `fax@company.com` |

---

## Quick Reference Commands

```bash
# Development
npm run dev                      # Start local server
npm run firebase:emulators       # Start Firebase emulators

# Deployment
npm run firebase:deploy          # Deploy functions + rules
npm run firebase:seed            # Populate store data

# Utilities
firebase functions:log           # View function logs
firebase functions:config:get    # View current config
```

---

## Security Notes

1. **Never commit** `.env` files or service account keys
2. The SMTP password is stored securely in Firebase Functions config
3. Firestore rules restrict write access to admin SDK only
4. The fax gateway email is never exposed to the frontend
