# Notebox — Sync Telegram Notes to the Cloud

Notebox is a lightweight, premium serverless solution designed to sync notes, media, and documents from a Telegram Bot directly to a cloud database (Firestore) and mirror them to Google Drive or Microsoft OneDrive.

This repository contains:
1. **Frontend Dashboard (`index.html`):** An institutional-grade, responsive glassmorphic dashboard featuring Email/Password, Google, and **Microsoft Entra ID (Azure AD) SSO** authentication.
2. **Telegram Bot Backend (`bot.js`):** A production-grade Node.js Telegram Bot that links user chats to Firebase UIDs via deep links and handles message/media storage pipelines.

---

## Technical Architecture

```
[ Telegram App ] ──(Sends Note/File)──> [ Telegram Bot (bot.js) ]
                                                   │
                                            (Writes Data)
                                                   ▼
[ Notebox Web App ] <──(Real-time Sync)── [ Firebase Firestore ]
```

---

## 🛠️ Step-by-Step Local Setup

### 1. Firebase Project Provisioning
1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Add Project**.
2. Enable the following services:
   * **Authentication:** Enable **Email/Password**, **Google**, and **Microsoft** (OAuth) sign-in providers.
   * **Cloud Firestore:** Initialize a database in **Production Mode** and select a suitable location.
   * **Cloud Storage:** Provision a storage bucket to store photos and forwarded documents.
3. Under **Project Settings**, generate a new **Web App** and copy the `firebaseConfig` credentials.
4. Open [index.html](file:///c:/Users/David%20Gvetadze/Desktop/Trado_Agent_Workspace/notebox/index.html) and replace the placeholder `firebaseConfig` object (line 467) with your actual credentials:
   ```javascript
   const firebaseConfig = {
     apiKey: "YOUR_API_KEY",
     authDomain: "YOUR_AUTH_DOMAIN",
     projectId: "YOUR_PROJECT_ID",
     storageBucket: "YOUR_STORAGE_BUCKET",
     messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
     appId: "YOUR_APP_ID"
   };
   ```

### 2. Firestore Security Rules
Deploy the following security rules in the Firestore Database console to restrict read/write access to the owner:
```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /notes/{noteId} {
      allow read, write: if request.auth != null && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null && request.auth.uid == request.resource.data.uid;
    }
    match /telegram_users/{chatId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

### 3. Telegram Bot Creation
1. Message `@BotFather` on Telegram.
2. Send the `/newbot` command and follow the instructions to get your **Telegram Bot Token**.
3. Enable inline/deep-linking so users can pair accounts:
   * Send `/setjoingroups` to disable group invites (recommended for individual note synchronization).

### 4. Bot Environment Configuration
1. Generate a Firebase Service Account key in the Firebase Console under **Project Settings > Service Accounts**. Click **Generate New Private Key** and save the JSON file as `firebase-service-account.json` in your backend directory.
2. Set the environment variables on your server or create a `.env` file in the root directory:
   ```env
   TELEGRAM_BOT_TOKEN="your_telegram_bot_token"
   FIREBASE_STORAGE_BUCKET="your-project-id.appspot.com"
   GOOGLE_APPLICATION_CREDENTIALS="absolute/path/to/firebase-service-account.json"
   ```
3. Install the node packages:
   ```bash
   npm install node-telegram-bot-api firebase-admin dotenv axios
   ```
4. Run the Telegram Bot client:
   ```bash
   node bot.js
   ```

---

## 🚀 Azure Marketplace SaaS Offer Publishing Checklist

To fulfill your **ISV Success & Marketplace Rewards** milestone, follow these instructions to publish Notebox as a **List-Only (Free Trial / SaaS)** offer.

### Step 1: Set Up Microsoft Partner Center Account
1. Enroll in the [Microsoft AI Cloud Partner Program](https://partner.microsoft.com/).
2. Navigate to **Partner Center Account Settings > Identifiers** and complete business verification.

### Step 2: Register Microsoft Entra ID Application (For SSO)
Since Notebox supports Microsoft SSO (configured in [index.html](file:///c:/Users/David%20Gvetadze/Desktop/Trado_Agent_Workspace/notebox/index.html)), register the app in your Azure Portal:
1. Go to **Azure Portal > Entra ID > App Registrations** and click **New Registration**.
2. Set redirect URIs to point to your live Notebox application hosting URL (e.g. `https://your-app-domain.web.app/__/auth/handler` for Firebase Auth).
3. Under **Authentication**, check **ID Tokens** (used for OpenID Connect SSO authentication).
4. Copy the Application (client) ID and Directory (tenant) ID and configure them inside the Firebase Authentication Console under the **Microsoft** Provider.

### Step 3: Create Commercial Marketplace Offer
1. In the Microsoft Partner Center dashboard, click **Commercial Marketplace > Overview** and select **New Offer > Software as a Service (SaaS)**.
2. Set your **Offer ID** (e.g., `notebox-cloud-notes`) and **Offer Alias** (e.g., `Notebox`).

### Step 4: Configure Offer Details
1. **Customer Lead Management:** Connect your CRM or select **No Lead Management** (you will receive notifications via email).
2. **Properties:** Categorize your app (e.g., `Productivity`, `Collaboration Tools`).
3. **Offer Listing:** Provide standard marketing assets:
   * **Name & Description:** Highlight the Telegram-to-Google Drive functionality.
   * **Search Keywords:** `Telegram bot`, `Google Drive Sync`, `Notes forwarding`.
   * **Support Link:** A URL where customers can file bugs.
   * **Privacy Policy:** Link to a privacy statement hosted on your site.
   * **Logos & Screenshots:** Upload your app branding and screenshots of the modernized dashboard.

### Step 5: Define Publishing Option (SaaS Plans)
For the **List-Only / Trial** approach, configure the plan type as **Free Trial** or **Contact Me**:
1. Provide your landing page URL (the live domain where your modernized `index.html` is hosted).
2. Click **Save Draft** and proceed to review.

### Step 6: Review & Publish
1. Click the **Review and Publish** button.
2. Microsoft commercial certification takes **2–5 business days**. Once approved, your application goes live on the Azure Marketplace directory!

---

## 🔒 Security Best Practices
* **Zero Client Secrets:** The client-side `index.html` is designed to be securely exposed. All authentication is verified dynamically via Firebase Authentication rules.
* **Serverless Backend:** Ensure the server running `bot.js` does not expose any public ports. All events are received via secure outbound polling requests to the Telegram API.
