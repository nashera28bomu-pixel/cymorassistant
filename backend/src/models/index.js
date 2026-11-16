import mongoose from 'mongoose';

const { Schema } = mongoose;

export const CONVERSATION_STATES = [
  'NEW_CONTACT',
  'GREETING_SENT',
  'WAITING_FOR_WELLBEING_RESPONSE',
  'ASKING_FOR_REQUEST',
  'COLLECTING_REQUEST',
  'REQUEST_CAPTURED',
  'OFFERING_COMPANIONSHIP',
  'CONVERSATION_ACTIVE',
  'CONVERSATION_ENDED',
  'HUMAN_TAKEOVER',
  'AUTOMATION_PAUSED',
];

export const CATEGORIES = [
  'web_development',
  'software_development',
  'kuccps',
  'academic_guidance',
  'technical_support',
  'business_inquiry',
  'partnership',
  'personal',
  'general_conversation',
  'other',
];

// ---------------------------------------------------------------- Contacts
const contactSchema = new Schema(
  {
    jid: { type: String, required: true, unique: true },
    phone: { type: String, default: '', index: true },
    displayName: { type: String, default: '' },
    firstInteractionAt: { type: Date, default: Date.now },
    lastInteractionAt: { type: Date, default: Date.now, index: true },
    preferences: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: ['active', 'blocked', 'deleted'], default: 'active' },
  },
  { timestamps: true },
);

// ----------------------------------------------------------- Conversations
const conversationSchema = new Schema(
  {
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    jid: { type: String, required: true, unique: true },
    state: { type: String, enum: CONVERSATION_STATES, default: 'NEW_CONTACT' },
    // State to restore when takeover/pause is released.
    stateBeforeOverride: { type: String, enum: [...CONVERSATION_STATES, null], default: null },
    category: { type: String, enum: CATEGORIES, default: 'general_conversation' },
    automationEnabled: { type: Boolean, default: true },
    humanTakeover: { type: Boolean, default: false },
    takeoverAt: { type: Date, default: null },
    lastOwnerMessageAt: { type: Date, default: null },
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: '' },
    summary: { type: String, default: '' },
    summarizedUpTo: { type: Date, default: null },
    collected: { type: Schema.Types.Mixed, default: {} },
    openRequest: { type: Schema.Types.ObjectId, ref: 'Request', default: null },
    consecutiveBotReplies: { type: Number, default: 0 },
    aiFailureNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

// ---------------------------------------------------------------- Messages
const messageSchema = new Schema(
  {
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    jid: { type: String, required: true },
    waMessageId: { type: String, default: null },
    sender: { type: String, enum: ['contact', 'assistant', 'owner'], required: true },
    type: { type: String, default: 'text' },
    text: { type: String, default: '' },
    automated: { type: Boolean, default: false },
    timestamp: { type: Date, default: Date.now },
    deliveryStatus: { type: String, default: '' },
  },
  { timestamps: true },
);
messageSchema.index({ conversation: 1, timestamp: 1 });
// Duplicate prevention: one stored copy per WhatsApp message ID per chat.
messageSchema.index({ jid: 1, waMessageId: 1 }, { unique: true, partialFilterExpression: { waMessageId: { $type: 'string' } } });

// ---------------------------------------------------------------- Requests
const requestSchema = new Schema(
  {
    contact: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    conversation: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    jid: { type: String, required: true },
    phone: { type: String, default: '' },
    contactName: { type: String, default: '' },
    category: { type: String, enum: CATEGORIES, default: 'other' },
    description: { type: String, required: true },
    collected: { type: Schema.Types.Mixed, default: {} },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    status: { type: String, enum: ['pending', 'reviewed', 'completed'], default: 'pending' },
    ownerNotes: { type: String, default: '' },
    notifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
requestSchema.index({ status: 1, createdAt: -1 });
requestSchema.index({ category: 1 });

// ---------------------------------------------------------------- Settings
const settingSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    value: { type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

// ------------------------------------------------------- WhatsApp sessions
// One document per credential/key. `data` is AES-256-GCM encrypted JSON.
const waAuthSchema = new Schema(
  {
    sessionId: { type: String, required: true },
    type: { type: String, required: true }, // 'creds' | pre-key | session | ...
    keyId: { type: String, required: true },
    data: { type: String, required: true },
  },
  { timestamps: true },
);
waAuthSchema.index({ sessionId: 1, type: 1, keyId: 1 }, { unique: true });

const waSessionMetaSchema = new Schema(
  {
    sessionId: { type: String, required: true, unique: true },
    connectionState: { type: String, default: 'disconnected' },
    qr: { type: String, default: null }, // short-lived, only for the admin pairing page
    qrUpdatedAt: { type: Date, default: null },
    me: { type: Schema.Types.Mixed, default: null },
    ownerLid: { type: String, default: '' },
    lastConnectedAt: { type: Date, default: null },
    lastDisconnectReason: { type: String, default: '' },
    reconnectAttempts: { type: Number, default: 0 },
    workerHeartbeatAt: { type: Date, default: null },
    requestedAction: { type: String, enum: ['none', 'disconnect', 'logout', 'reconnect'], default: 'none' },
  },
  { timestamps: true },
);

// Encrypted backup snapshots of credentials (recovery strategy).
const waBackupSchema = new Schema({
  sessionId: { type: String, required: true, index: true },
  data: { type: String, required: true }, // encrypted creds JSON
  createdAt: { type: Date, default: Date.now },
});

// Single-owner lease so two workers never run the same session.
const lockSchema = new Schema({
  name: { type: String, required: true, unique: true },
  holder: { type: String, required: true },
  expiresAt: { type: Date, required: true },
});

const auditSchema = new Schema(
  {
    actor: { type: String, required: true },
    action: { type: String, required: true },
    detail: { type: String, default: '' },
    at: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

const aiUsageSchema = new Schema(
  {
    day: { type: String, required: true, unique: true }, // YYYY-MM-DD
    requests: { type: Number, default: 0 },
    failures: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    lastError: { type: Schema.Types.Mixed, default: null },
  },
  { versionKey: false },
);

const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

export const Contact = model('Contact', contactSchema);
export const Conversation = model('Conversation', conversationSchema);
export const Message = model('Message', messageSchema);
export const Request = model('Request', requestSchema);
export const Setting = model('Setting', settingSchema);
export const WhatsAppAuth = model('WhatsAppAuth', waAuthSchema);
export const WhatsAppSession = model('WhatsAppSession', waSessionMetaSchema);
export const WhatsAppBackup = model('WhatsAppBackup', waBackupSchema);
export const WorkerLock = model('WorkerLock', lockSchema);
export const AuditLog = model('AuditLog', auditSchema);
export const AiUsage = model('AiUsage', aiUsageSchema);
