/**
 * Advanced Notebox Sovereign Telegram Bot Backend
 * 
 * Includes:
 *   1. Interactive Note Session State Machine (Start -> Attach files -> Finish).
 *   2. Google Speech-to-Text (STT) OGG_OPUS Voice Note Transcription.
 *   3. Graceful fallback for untranscribed audio (HTML5 audio player links).
 *   4. Multi-media and document attachments grid synced instantly to Firestore.
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const admin = require('firebase-admin');
const axios = require('axios');
const speech = require('@google-cloud/speech');

// Helper: Escape HTML characters for secure Telegram HTML parsing
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Initialize Firebase Admin SDK
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });
}

const db = admin.firestore();
const bucket = admin.storage().bucket();

// Initialize Google Cloud Speech Client
let speechClient = null;
try {
  speechClient = new speech.SpeechClient({
    keyFilename: process.env.GOOGLE_APPLICATION_CREDENTIALS
  });
  console.log("Google Cloud Speech-to-Text Client initialized successfully.");
} catch (e) {
  console.warn("WARNING: Google Cloud Speech Client failed to initialize. Voice notes will still be saved as audio file attachments.", e.message);
}

// Initialize Telegram Bot
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("CRITICAL ERROR: TELEGRAM_BOT_TOKEN environment variable is missing.");
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
console.log("Notebox Interactive Bot Backend has started successfully...");

// Memory Cache for Active Drafting Sessions
// activeSessions[chatId] = { noteId, uid, title, content, attachmentsCount, timestamp }
const activeSessions = new Map();

// Session Timeout Checker (Clear sessions older than 2 hours)
setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of activeSessions.entries()) {
    if (now - session.timestamp > 2 * 60 * 60 * 1000) {
      activeSessions.delete(chatId);
      bot.sendMessage(chatId, "⚠️ <b>Session Timeout:</b> Your active draft note session has expired. You can start a new note anytime by sending a text or voice message.", { parse_mode: 'HTML' });
    }
  }
}, 15 * 60 * 1000);

// Handle /start commands (Account Linking)
bot.onText(/\/start (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const firebaseUid = match[1].trim();
  
  try {
    const userRecord = await admin.auth().getUser(firebaseUid);
    await db.collection('telegram_users').doc(String(chatId)).set({
      uid: firebaseUid,
      username: msg.chat.username || "",
      firstName: msg.chat.first_name || "",
      connectedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    
    bot.sendMessage(chatId, `🎉 <b>Welcome to Notebox, ${escapeHTML(userRecord.displayName || 'User')}!</b>\n\nYour accounts are paired! 🤖\n\n<b>How to use Notebox:</b>\n1. Send a voice message or type a text message to create a new draft note.\n2. Forward photos, videos, or documents to attach them to that draft in real-time.\n3. Click <b>Finish Note</b> when done!`, { parse_mode: 'HTML' });
  } catch (error) {
    console.error("Activation Error:", error);
    bot.sendMessage(chatId, "❌ Setup failed. We couldn't verify your Notebox account. Please try again from the website dashboard.");
  }
});

bot.onText(/\/start$/, (msg) => {
  bot.sendMessage(msg.chat.id, "👋 Hello! Please log in to your Notebox Dashboard and click the 'Launch Telegram Bot' button to pair your account.");
});

// Callback Query Handler for Inline Buttons (Finish / Delete)
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;
  
  if (data.startsWith('finish_')) {
    const noteId = data.replace('finish_', '');
    
    try {
      // Finalize the note status in Firestore
      await db.collection('notes').doc(noteId).update({
        status: 'published',
        finalizedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      activeSessions.delete(chatId);
      bot.editMessageText("🎉 <b>Note Finalized and Synced!</b>\nYour notes are locked and safely stored in your cloud drive.", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error("Failed to finalize note:", e);
      bot.sendMessage(chatId, "⚠️ Failed to finalize note. It remains saved as a draft.");
    }
  } 
  
  else if (data.startsWith('delete_')) {
    const noteId = data.replace('delete_', '');
    
    try {
      // Remove from Firestore
      await db.collection('notes').doc(noteId).delete();
      activeSessions.delete(chatId);
      
      bot.editMessageText("🗑️ <b>Draft Note Deleted.</b>", {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'HTML'
      });
    } catch (e) {
      console.error("Failed to delete draft:", e);
      bot.sendMessage(chatId, "⚠️ Failed to delete note. You can remove it manually from the website dashboard.");
    }
  }
  
  bot.answerCallbackQuery(query.id);
});

// General Message Listener: Voice, Audio, Media, Text
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  
  // Skip command messages
  if (msg.text && msg.text.startsWith('/')) return;
  
  try {
    // 1. Check account connection
    const userDoc = await db.collection('telegram_users').doc(String(chatId)).get();
    if (!userDoc.exists) {
      bot.sendMessage(chatId, "🔒 <b>Account Pairing Required.</b>\nPlease link your Telegram account to Notebox first by logging into your web dashboard.", { parse_mode: 'HTML' });
      return;
    }
    
    const { uid } = userDoc.data();
    const hasSession = activeSessions.has(chatId);
    
    // CASE 1: USER IS CREATING A NEW DRAFT NOTE
    if (!hasSession) {
      bot.sendChatAction(chatId, msg.voice ? 'record_audio' : 'typing');
      
      let title = "Telegram Note";
      let content = "";
      let fileUrl = "";
      let thumbnailUrl = "";
      let isVoice = false;
      const timestamp = Date.now();
      
      // Handle initial Voice Message
      if (msg.voice) {
        isVoice = true;
        title = "Voice Note";
        
        // Download the raw file
        const fileInfo = await bot.getFile(msg.voice.file_id);
        const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
        const fileResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
        const fileBuffer = Buffer.from(fileResponse.data);
        
        // Transcribe voice note
        let transcription = null;
        if (speechClient) {
          transcription = await transcribeVoiceBuffer(fileBuffer);
        }
        
        // Upload voice note `.ogg` file to Firebase Storage
        const uploadInfo = await uploadBufferToStorage(fileBuffer, uid, `voice_${timestamp}.ogg`, 'audio/ogg');
        fileUrl = uploadInfo.publicUrl;
        
        if (transcription) {
          content = transcription;
          title = `Voice: ${transcription.substring(0, 30)}${transcription.length > 30 ? '...' : ''}`;
        } else {
          content = "🎤 (Voice Note Audio - Transcribe unavailable)";
        }
      }
      // Handle initial Text message
      else if (msg.text) {
        content = msg.text.trim();
        const lines = content.split('\n');
        title = lines[0].substring(0, 40) + (lines[0].length > 40 ? '...' : '');
      }
      // Handle initial image or file (automatic note creation)
      else if (msg.photo || msg.document) {
        content = msg.caption || "File forwarding note";
        title = msg.photo ? "Image Note" : "Document Note";
      } else {
        bot.sendMessage(chatId, "ℹ️ Please start your note by sending a voice message or typing a text note.");
        return;
      }
      
      // Write draft note to Firestore
      const noteRef = await db.collection('notes').add({
        uid: uid,
        title: title,
        content: content,
        fileUrl: fileUrl,
        thumbnailUrl: thumbnailUrl,
        attachments: [],
        status: 'draft',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'telegram',
        isVoice: isVoice
      });
      
      // Set Active Session state
      activeSessions.set(chatId, {
        noteId: noteRef.id,
        uid: uid,
        title: title,
        content: content,
        attachmentsCount: 0,
        timestamp: Date.now()
      });
      
      // If user sent a photo/document as their first message, automatically process it as an attachment
      if (msg.photo || msg.document) {
        await processAttachment(msg, chatId);
      } else {
        // Send Interactive Keyboard
        sendInteractiveSessionMessage(chatId, noteRef.id, title, content, isVoice);
      }
    } 
    
    // CASE 2: USER HAS AN ACTIVE DRAFT SESSION
    else {
      const session = activeSessions.get(chatId);
      session.timestamp = Date.now(); // update active timer
      
      // User sent text -> append as new line
      if (msg.text) {
        bot.sendChatAction(chatId, 'typing');
        const appendText = msg.text.trim();
        const newContent = `${session.content}\n\n📝 ${appendText}`;
        
        await db.collection('notes').doc(session.noteId).update({
          content: newContent
        });
        
        session.content = newContent;
        
        bot.sendMessage(chatId, `✍️ <b>Text appended to active note!</b>\n\n<i>Updated draft content:</i>\n"${escapeHTML(newContent)}"`, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Finish Note', callback_data: `finish_${session.noteId}` },
                { text: '🗑️ Delete Draft', callback_data: `delete_${session.noteId}` }
              ]
            ]
          }
        });
      }
      // User sent photo / file -> attach!
      else if (msg.photo || msg.document || msg.video || msg.voice) {
        await processAttachment(msg, chatId);
      }
    }
  } catch (error) {
    console.error("Failed to process message:", error);
    bot.sendMessage(chatId, "⚠️ Failed to record your note content. Please try again.");
  }
});

// Helper: Process and Upload Attachments
async function processAttachment(msg, chatId) {
  const session = activeSessions.get(chatId);
  bot.sendChatAction(chatId, 'upload_document');
  
  let fileId = "";
  let originalName = "";
  let fileType = "document";
  const timestamp = Date.now();
  
  if (msg.photo) {
    const photo = msg.photo[msg.photo.length - 1];
    fileId = photo.file_id;
    originalName = `photo_${timestamp}.jpg`;
    fileType = "image";
  } else if (msg.document) {
    fileId = msg.document.file_id;
    originalName = msg.document.file_name || `file_${timestamp}`;
    fileType = "document";
  } else if (msg.video) {
    fileId = msg.video.file_id;
    originalName = `video_${timestamp}.mp4`;
    fileType = "video";
  } else if (msg.voice) {
    fileId = msg.voice.file_id;
    originalName = `voice_attachment_${timestamp}.ogg`;
    fileType = "voice";
  }
  
  const fileInfo = await bot.getFile(fileId);
  const downloadUrl = `https://api.telegram.org/file/bot${token}/${fileInfo.file_path}`;
  const response = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
  const buffer = Buffer.from(response.data);
  
  const uploadInfo = await uploadBufferToStorage(buffer, session.uid, `${timestamp}_${originalName}`, response.headers['content-type'] || 'application/octet-stream');
  
  const attachment = {
    name: originalName,
    fileUrl: uploadInfo.publicUrl,
    type: fileType,
    uploadedAt: Date.now()
  };
  
  // Update Firestore note attachments array
  const noteRef = db.collection('notes').doc(session.noteId);
  await noteRef.update({
    attachments: admin.firestore.FieldValue.arrayUnion(attachment)
  });
  
  session.attachmentsCount += 1;
  
  bot.sendMessage(chatId, `📎 <b>Attachment Added!</b> (${session.attachmentsCount} total)\n<i>${escapeHTML(originalName)}</i>\n\nYou can keep sending files/photos to attach them, or finalize the note.`, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Finish Note', callback_data: `finish_${session.noteId}` },
          { text: '🗑️ Delete Draft', callback_data: `delete_${session.noteId}` }
        ]
      ]
    }
  });
}

// Helper: Transcribe voice OGG buffer
async function transcribeVoiceBuffer(buffer) {
  try {
    const audio = { content: buffer.toString('base64') };
    const config = {
      encoding: 'OGG_OPUS',
      sampleRateHertz: 48000,
      languageCode: 'en-US',
      alternativeLanguageCodes: ['ka-GE', 'ru-RU'] // English, Georgian, Russian fallbacks
    };
    
    const [response] = await speechClient.recognize({ audio, config });
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');
    return transcription.trim() || null;
  } catch (err) {
    console.error("Speech to Text API failed:", err.message);
    return null;
  }
}

// Helper: Upload file buffer to Firebase Storage
async function uploadBufferToStorage(buffer, uid, fileName, contentType) {
  const filePath = `notes/${uid}/${fileName}`;
  const file = bucket.file(filePath);
  
  await file.save(buffer, {
    metadata: {
      contentType: contentType,
      metadata: { uploadedBy: 'telegram-bot-v2' }
    },
    public: true
  });
  
  return {
    publicUrl: `https://storage.googleapis.com/${bucket.name}/${filePath}`,
    storagePath: filePath
  };
}

// Helper: Send Interactive Keyboard message
function sendInteractiveSessionMessage(chatId, noteId, title, content, isVoice) {
  let text = "";
  if (isVoice) {
    text = `🎙️ <b>Voice Note Draft Registered!</b>\n\n<b>Transcription:</b>\n"${escapeHTML(content)}"\n\n📎 Forward <b>photos, videos, or documents</b> to attach them to this note, or use the menu below to finalize.`;
  } else {
    text = `📝 <b>Draft Note Registered!</b>\n\n<b>Content:</b>\n"${escapeHTML(content)}"\n\n📎 Forward <b>photos, videos, or documents</b> to attach them to this note, or use the menu below to finalize.`;
  }
  
  bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✅ Finish Note', callback_data: `finish_${noteId}` },
          { text: '🗑️ Delete Draft', callback_data: `delete_${noteId}` }
        ]
      ]
    }
  });
}
