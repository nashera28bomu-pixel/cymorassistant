import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import mongoose from 'mongoose';
import { Contact, Conversation, Message, Request, WhatsAppSession, AiUsage, AuditLog, CATEGORIES } from '../models/index.js';
import { requireAdmin, verifyCredentials, issueSession, clearSession } from '../middleware/auth.js';
import { getSettings, updateSetting, automationActive } from '../services/settings.js';
import { listRequests, updateRequest } from '../requests/request-service.js';
import { setTakeover } from '../assistant/conversation-engine.js';
import { deleteContactData } from '../services/contacts.js';
import { qrToDataUrl, QR_TTL_MS } from '../whatsapp/qr-manager.js';
import { databaseStatus } from '../database/connect.js';
import { normalizePhone } from '../utils/phone.js';
import { audit } from '../utils/audit.js';

const isId = (id) => mongoose.isValidObjectId(id);
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---- Settings validation: whitelist what the dashboard may change; secrets are never settings.
const settingsPatchSchema = z
  .object({
    assistantEnabled: z.boolean(),
    ownerPhone: z.string().max(20),
    footer: z.string().min(3).max(80),
    personalityNotes: z.string().max(1500),
    ai: z.object({ model: z.string().max(80), temperature: z.number().min(0).max(1.5), timeoutMs: z.number().int().min(3000).max(60000), maxRetries: z.number().int().min(0).max(4), historyMessages: z.number().int().min(4).max(40) }).partial(),
    notifications: z.object({ enabled: z.boolean(), newInquiry: z.boolean(), urgent: z.boolean(), kuccps: z.boolean(), unansweredQuestion: z.boolean(), dailySummary: z.boolean(), dailySummaryHour: z.number().int().min(0).max(23) }).partial(),
    automation: z.object({ groupsEnabled: z.boolean(), autoTakeoverOnOwnerReply: z.boolean(), takeoverInactivityMinutes: z.number().int().min(0).max(10080), maxMediaBytes: z.number().int().min(0).max(25_000_000), retentionDays: z.number().int().min(0).max(3650) }).partial(),
    ownerProfile: z.object({ name: z.string().min(1).max(100), position: z.string().max(150), professions: z.array(z.string().max(80)).max(10), company: z.string().max(100), primaryChannel: z.string().max(50), country: z.string().max(60), currency: z.string().max(10) }).partial(),
    company: z.object({ description: z.string().max(2000) }).partial(),
    services: z.array(z.object({ id: z.string().max(50), title: z.string().max(100), items: z.array(z.string().max(150)).max(40) })).max(20),
    faqs: z.array(z.object({ q: z.string().max(300), a: z.string().max(1200) })).max(60),
    policies: z.object({ communication: z.array(z.string().max(400)).max(20), consultationInfo: z.string().max(1500), officialLinks: z.array(z.string().max(300)).max(20), workingHours: z.string().max(300) }).partial(),
  })
  .partial()
  .strict();

export function createApiRouter({ config }) {
  const router = express.Router();
  const admin = requireAdmin(config);

  const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many login attempts. Try again later.' } });

  // ---------------------------------------------------------------- public
  router.get('/health', (req, res) => res.json({ status: 'ok' })); // deliberately minimal

  router.post('/auth/login', loginLimiter, wrap(async (req, res) => {
    const body = z.object({ username: z.string().max(100), password: z.string().max(200) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid request' });
    const ok = await verifyCredentials(config, body.data.username, body.data.password);
    if (!ok) {
      await audit('dashboard', 'login_failed');
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    const csrf = issueSession(config, res);
    await audit('dashboard', 'login');
    res.json({ ok: true, csrf, username: config.DASHBOARD_USERNAME });
  }));

  // ---------------------------------------------------------- authenticated
  router.use(admin);

  router.post('/auth/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => res.json({ username: config.DASHBOARD_USERNAME, csrf: req.admin.csrf }));

  router.get('/overview', wrap(async (req, res) => {
    const settings = await getSettings();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const sess = await WhatsAppSession.findOne({ sessionId: config.SESSION_ID }).lean();
    const usage = await AiUsage.findOne({ day: new Date().toISOString().slice(0, 10) }).lean();
    const heartbeatAge = sess?.workerHeartbeatAt ? Date.now() - new Date(sess.workerHeartbeatAt).getTime() : null;
    const [contacts, active, pending, kuccps, web, software, today] = await Promise.all([
      Contact.countDocuments({ status: { $ne: 'deleted' } }),
      Conversation.countDocuments({ lastMessageAt: { $gte: new Date(Date.now() - 24 * 3600_000) }, state: { $ne: 'CONVERSATION_ENDED' } }),
      Request.countDocuments({ status: 'pending' }),
      Request.countDocuments({ category: 'kuccps' }),
      Request.countDocuments({ category: 'web_development' }),
      Request.countDocuments({ category: 'software_development' }),
      Message.countDocuments({ timestamp: { $gte: startOfDay } }),
    ]);
    res.json({
      whatsapp: { state: sess?.connectionState || 'disconnected', me: sess?.me || null, lastConnectedAt: sess?.lastConnectedAt || null },
      assistant: { enabled: settings.assistantEnabled, active: automationActive(settings), pausedUntil: settings.pausedUntil },
      gemini: { configured: Boolean(config.GEMINI_API_KEY), model: settings.ai.model || config.GEMINI_MODEL, requestsToday: usage?.requests || 0, failuresToday: usage?.failures || 0, lastError: usage?.lastError || null },
      mongodb: { status: databaseStatus() },
      heroku: { web: 'running', dyno: process.env.DYNO || 'local', worker: heartbeatAge === null ? 'unknown' : heartbeatAge < 60_000 ? 'running' : 'not responding', workerHeartbeatAgeSec: heartbeatAge === null ? null : Math.round(heartbeatAge / 1000) },
      counts: { contacts, activeConversations: active, pendingRequests: pending, kuccpsInquiries: kuccps, webInquiries: web, softwareInquiries: software, messagesToday: today },
    });
  }));

  // ---------------------------------------------------- WhatsApp connection
  router.get('/whatsapp/status', wrap(async (req, res) => {
    const s = await WhatsAppSession.findOne({ sessionId: config.SESSION_ID }).lean();
    let qr = null;
    let qrExpiresInSec = null;
    if (s?.qr && s.qrUpdatedAt) {
      const age = Date.now() - new Date(s.qrUpdatedAt).getTime();
      if (age < QR_TTL_MS) {
        qr = await qrToDataUrl(s.qr);
        qrExpiresInSec = Math.max(0, Math.round((QR_TTL_MS - age) / 1000));
      }
    }
    const hb = s?.workerHeartbeatAt ? Date.now() - new Date(s.workerHeartbeatAt).getTime() : null;
    res.set('Cache-Control', 'no-store');
    res.json({
      state: s?.connectionState || 'disconnected',
      qr, // PNG data URL, only ever served to an authenticated admin
      qrExpiresInSec,
      me: s?.me ? { id: s.me.id, name: s.me.name } : null,
      lastConnectedAt: s?.lastConnectedAt || null,
      lastDisconnectReason: s?.lastDisconnectReason || '',
      reconnectAttempts: s?.reconnectAttempts || 0,
      workerOnline: hb !== null && hb < 60_000,
    });
  }));

  router.post('/whatsapp/action', wrap(async (req, res) => {
    const body = z.object({ action: z.enum(['disconnect', 'logout', 'reconnect']) }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid action' });
    await WhatsAppSession.updateOne({ sessionId: config.SESSION_ID }, { $set: { requestedAction: body.data.action } }, { upsert: true });
    await audit('dashboard', `whatsapp_${body.data.action}`);
    res.json({ ok: true, message: 'Request sent to the worker. This may take a few seconds.' });
  }));

  // ---------------------------------------------------------- conversations
  router.get('/conversations', wrap(async (req, res) => {
    const q = {};
    if (req.query.status === 'takeover') q.humanTakeover = true;
    const convs = await Conversation.find(q).sort({ lastMessageAt: -1 }).limit(200).populate('contact').lean();
    const search = String(req.query.search || '').toLowerCase();
    const rows = convs
      .filter((c) => !search || `${c.contact?.displayName} ${c.contact?.phone} ${c.lastMessagePreview}`.toLowerCase().includes(search))
      .map((c) => ({
        id: c._id,
        name: c.contact?.displayName || '',
        phone: c.contact?.phone || '',
        lastMessage: c.lastMessagePreview,
        lastInteractionAt: c.lastMessageAt,
        state: c.state,
        category: c.category,
        automationEnabled: c.automationEnabled,
        humanTakeover: c.humanTakeover,
        hasOpenRequest: Boolean(c.openRequest),
      }));
    res.json({ conversations: rows });
  }));

  router.get('/conversations/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const conv = await Conversation.findById(req.params.id).populate('contact').lean();
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const messages = await Message.find({ conversation: conv._id }).sort({ timestamp: 1 }).limit(500).lean();
    const requests = await Request.find({ conversation: conv._id }).sort({ createdAt: -1 }).lean();
    res.json({
      conversation: { id: conv._id, name: conv.contact?.displayName || '', phone: conv.contact?.phone || '', state: conv.state, category: conv.category, automationEnabled: conv.automationEnabled, humanTakeover: conv.humanTakeover, collected: conv.collected, summary: conv.summary },
      messages: messages.map((m) => ({ id: m._id, sender: m.sender, text: m.text, type: m.type, automated: m.automated, timestamp: m.timestamp })),
      requests,
    });
  }));

  router.post('/conversations/:id/takeover', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const body = z.object({ on: z.boolean() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid request' });
    const conv = await Conversation.findById(req.params.id).lean();
    if (!conv) return res.status(404).json({ error: 'Not found' });
    await setTakeover(conv.jid, body.data.on);
    await audit('dashboard', body.data.on ? 'takeover' : 'release', conv.jid.split('@')[0]);
    res.json({ ok: true });
  }));

  router.post('/conversations/:id/automation', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const body = z.object({ enabled: z.boolean() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid request' });
    await Conversation.updateOne({ _id: req.params.id }, { $set: { automationEnabled: body.data.enabled } });
    await audit('dashboard', 'contact_automation', String(body.data.enabled));
    res.json({ ok: true });
  }));

  router.delete('/conversations/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const conv = await Conversation.findById(req.params.id).lean();
    if (!conv) return res.status(404).json({ error: 'Not found' });
    const result = await deleteContactData(conv.jid);
    await audit('dashboard', 'delete_contact_data', conv.jid.split('@')[0]);
    res.json({ ok: true, deleted: result });
  }));

  // --------------------------------------------------------------- requests
  router.get('/requests', wrap(async (req, res) => {
    const q = z.object({ status: z.enum(['pending', 'reviewed', 'completed']).optional(), category: z.enum(CATEGORIES).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), search: z.string().max(100).optional() }).safeParse(req.query);
    if (!q.success) return res.status(400).json({ error: 'Invalid filter' });
    res.json({ requests: await listRequests(q.data) });
  }));

  router.patch('/requests/:id', wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad id' });
    const body = z.object({ status: z.enum(['pending', 'reviewed', 'completed']).optional(), ownerNotes: z.string().max(2000).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional() }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'Invalid request' });
    const updated = await updateRequest(req.params.id, body.data);
    if (!updated) return res.status(404).json({ error: 'Not found' });
    await audit('dashboard', 'request_update', `${req.params.id} ${body.data.status || ''}`);
    res.json({ request: updated });
  }));

  // --------------------------------------------------------------- settings
  router.get('/settings', wrap(async (req, res) => {
    const s = await getSettings({ fresh: true });
    res.json({
      settings: s,
      secrets: { geminiApiKey: config.GEMINI_API_KEY ? 'configured (hidden)' : 'NOT SET', mongodb: 'configured (hidden)', encryptionKey: 'configured (hidden)' },
      envDefaults: { model: config.GEMINI_MODEL, timezone: config.TIMEZONE },
    });
  }));

  router.put('/settings', wrap(async (req, res) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid settings', details: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) });
    const patch = parsed.data;
    if (patch.ownerPhone !== undefined) patch.ownerPhone = normalizePhone(patch.ownerPhone);
    for (const [k, v] of Object.entries(patch)) {
      const current = (await getSettings({ fresh: true }))[k];
      await updateSetting(k, current && typeof current === 'object' && !Array.isArray(current) ? { ...current, ...v } : v);
    }
    await audit('dashboard', 'settings_update', Object.keys(patch).join(','));
    res.json({ ok: true, settings: await getSettings({ fresh: true }) });
  }));

  // -------------------------------------------------------------- analytics
  router.get('/analytics', wrap(async (req, res) => {
    const days = 14;
    const since = new Date(Date.now() - days * 86400_000);
    since.setHours(0, 0, 0, 0);
    const [perDay, byCategory, replies, topQuestions, usage] = await Promise.all([
      Message.aggregate([{ $match: { timestamp: { $gte: since }, sender: 'contact' } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, messages: { $sum: 1 }, chats: { $addToSet: '$conversation' } } }, { $project: { messages: 1, conversations: { $size: '$chats' } } }, { $sort: { _id: 1 } }]),
      Request.aggregate([{ $group: { _id: '$category', count: { $sum: 1 } } }, { $sort: { count: -1 } }]),
      Message.aggregate([{ $match: { timestamp: { $gte: since }, sender: 'assistant' } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }]),
      Message.aggregate([{ $match: { sender: 'contact', type: 'text', timestamp: { $gte: since }, text: /\?\s*$/ } }, { $group: { _id: { $toLower: { $trim: { input: '$text' } } }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 8 }]),
      AiUsage.find({ day: { $gte: since.toISOString().slice(0, 10) } }).sort({ day: 1 }).lean(),
    ]);
    const pending = await Request.countDocuments({ status: 'pending' });
    res.json({
      conversationsOverTime: perDay.map((d) => ({ day: d._id, messages: d.messages, conversations: d.conversations })),
      inquiriesByCategory: byCategory.map((c) => ({ category: c._id, count: c.count })),
      responseVolume: replies.map((r) => ({ day: r._id, count: r.count })),
      commonQuestions: topQuestions.map((q) => ({ question: String(q._id).slice(0, 140), count: q.count })),
      aiUsage: usage.map((u) => ({ day: u.day, requests: u.requests, failures: u.failures, promptTokens: u.promptTokens, outputTokens: u.outputTokens })),
      pendingRequests: pending,
    });
  }));

  router.get('/audit', wrap(async (req, res) => {
    res.json({ entries: await AuditLog.find({}).sort({ at: -1 }).limit(100).lean() });
  }));

  return router;
}
