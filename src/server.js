import 'dotenv/config';
import express from "express";
import session from "express-session";
import bcrypt from "bcryptjs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import { Server as SocketIOServer } from "socket.io";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import mime from "mime-types";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { default as vcardParser } from "vcard-parser";
import pino from "pino";
import PinoPretty from "pino-pretty";
import axios from "axios";

// Configure dayjs with timezone support
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Colombo"); // Sri Lanka timezone (UTC+5:30)
import { GoogleGenAI } from "@google/genai";
import { getSheet } from './googleSheet.js';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, downloadMediaMessage } from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logger = pino(PinoPretty({ translateTime: "SYS:standard", colorize: true }));

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: "*" } });

// Password configuration (change this!)
const APP_PASSWORD = process.env.APP_PASSWORD || "admin123"; // Change this password!
const PASSWORD_HASH = bcrypt.hashSync(APP_PASSWORD, 10);
const SESSION_SECRET = process.env.SESSION_SECRET || "wasender-session-secret-2024"; // Fixed secret for development

// Session configuration
app.use(session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	cookie: {
		secure: false, // Disable secure cookies for Railway compatibility
		httpOnly: true,
		maxAge: 24 * 60 * 60 * 1000, // 24 hours
		sameSite: 'lax' // Add sameSite for better compatibility
	}
}));

// Authentication middleware
function requireAuth(req, res, next) {
	logger.info("Auth check", { 
		path: req.path,
		sessionId: req.sessionID,
		authenticated: req.session?.authenticated,
		hasSession: !!req.session,
		sessionData: req.session
	});
	
	if (req.session && req.session.authenticated) {
		logger.info("Authentication successful", { path: req.path, sessionId: req.sessionID });
		return next();
	}
	
	logger.warn("Authentication failed", { 
		path: req.path, 
		sessionId: req.sessionID,
		authenticated: req.session?.authenticated,
		hasSession: !!req.session
	});
	
	// If it's an API request, return JSON error
	if (req.path.startsWith('/api/')) {
		return res.status(401).json({ error: 'Unauthorized' });
	}
	// Otherwise redirect to login
	res.redirect('/login.html');
}

const DATA_DIR = path.join(__dirname, "..", "data");
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const UPLOADS_DIR = path.join(PUBLIC_DIR, "uploads");

for (const d of [DATA_DIR, PUBLIC_DIR, UPLOADS_DIR]) {
	if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}



const statusCacheFile = path.join(DATA_DIR, "status-cache.json");

// Dual Gemini API Keys with failover system
const GEMINI_API_KEYS = [
	process.env.GEMINI_API_KEY_1 || "AIzaSyBIF9IaWHoGrvCWj6Ho7dswGCFG086Iaps",
	process.env.GEMINI_API_KEY_2 || "AIzaSyDentNxzy1eBwSNzLoJyNcGfm0gB-xxCSw"
];

// Key status tracking
const keyStatus = {
	0: { lastError: null, errorCount: 0, isBlocked: false },
	1: { lastError: null, errorCount: 0, isBlocked: false }
};

let currentKeyIndex = 0;
let genAI = null;

// Initialize Gemini AI with first key
function initializeGemini() {
	const currentKey = GEMINI_API_KEYS[currentKeyIndex];
	genAI = new GoogleGenAI({
		apiKey: currentKey,
		httpOptions: { apiVersion: "v1alpha" }
	});
	logger.info(`Initialized Gemini AI with key index ${currentKeyIndex}`);
}

// Switch to next available API key
function switchToNextKey() {
	const originalIndex = currentKeyIndex;
	
	// Try next key
	currentKeyIndex = (currentKeyIndex + 1) % GEMINI_API_KEYS.length;
	
	// If we've tried all keys, reset and wait
	if (currentKeyIndex === originalIndex) {
		logger.warn("All Gemini API keys have been exhausted, waiting before retry");
		return false;
	}
	
	// Check if this key is blocked (quota exceeded within 24 hours)
	const keyInfo = keyStatus[currentKeyIndex];
	if (keyInfo.isBlocked && keyInfo.lastError) {
		const hoursSinceError = (Date.now() - keyInfo.lastError) / (1000 * 60 * 60);
		if (hoursSinceError < 24) {
			logger.warn(`Key ${currentKeyIndex} is still blocked (${Math.round(24 - hoursSinceError)}h remaining)`);
			// Try next key recursively
			return switchToNextKey();
		} else {
			// Reset key status after 24 hours
			keyInfo.isBlocked = false;
			keyInfo.errorCount = 0;
			keyInfo.lastError = null;
			logger.info(`Key ${currentKeyIndex} unblocked after 24 hours`);
		}
	}
	
	// Initialize with new key
	initializeGemini();
	logger.info(`Switched to Gemini API key index ${currentKeyIndex}`);
	return true;
}

// Handle API errors and switch keys if needed
function handleGeminiError(error) {
	const keyInfo = keyStatus[currentKeyIndex];
	keyInfo.errorCount++;
	keyInfo.lastError = Date.now();
	
	const errorMessage = error.message?.toLowerCase() || '';
	
	// Check for quota exceeded errors
	if (errorMessage.includes('quota') || errorMessage.includes('limit') || 
		errorMessage.includes('exceeded') || errorMessage.includes('billing')) {
		
		keyInfo.isBlocked = true;
		logger.error(`Gemini API key ${currentKeyIndex} quota exceeded, blocking for 24 hours`);
		
		// Switch to next key
		const switched = switchToNextKey();
		if (!switched) {
			logger.error("No available Gemini API keys, all are blocked");
			return false;
		}
	} else {
		// For other errors, try switching after 3 consecutive errors
		if (keyInfo.errorCount >= 3) {
			logger.warn(`Gemini API key ${currentKeyIndex} failed ${keyInfo.errorCount} times, switching`);
			const switched = switchToNextKey();
			if (!switched) {
				logger.error("No available Gemini API keys");
				return false;
			}
		}
	}
	
	return true;
}

// Initialize with first key
initializeGemini();

async function readJson(file, fallback) {
	try {
		const raw = await fsp.readFile(file, "utf-8");
		return JSON.parse(raw);
	} catch (e) {
		return fallback;
	}
}

async function writeJson(file, data) {
	await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

async function ensureDefaults() {
	const statuses = await readJson(statusCacheFile, []);
	await writeJson(statusCacheFile, statuses);
}

await ensureDefaults();

// Multer storage for media uploads
const storage = multer.diskStorage({
	destination: function (req, file, cb) {
		cb(null, UPLOADS_DIR);
	},
	filename: function (req, file, cb) {
		const ext = mime.extension(file.mimetype) || "bin";
		cb(null, `${Date.now()}-${nanoid(6)}.${ext}`);
	}
});
const upload = multer({ storage });

// Body parsers (must be after session)
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// Public routes (no authentication required for login page)
app.get('/login.html', (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
});

// Root route - serve main page (protected)
app.get('/', (req, res) => {
	res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Apply authentication to main page and static files
app.use((req, res, next) => {
	// Allow login.html and auth API
	if (req.path === '/login.html' || req.path.startsWith('/api/auth/')) {
		return next();
	}
	// Require auth for everything else
	requireAuth(req, res, next);
});

// Serve static files (now protected by middleware above)
app.use(express.static(PUBLIC_DIR));

let sock = null;
let connectionStatus = { connected: false, lastDisconnect: null, qr: null, device: "Personal Bot" };
let sendingInProgress = false;
let autoViewStatus = process.env.AUTO_VIEW_STATUS !== "false"; // default true, runtime toggle
let freezeLastSeen = true; // freeze presence (last seen) after viewing statuses until next status
let lastSeenUpdatedAt = null; // ISO timestamp of last time we nudged presence
let isConnecting = false;
let startTime = Date.now(); // Track bot start time for uptime calculation

async function startBaileys(clearAuth = false) {
	if (clearAuth) {
		// Clear auth folder to force new session
		try {
			await fsp.rm(path.join(DATA_DIR, "auth"), { recursive: true, force: true });
		} catch (e) {
			logger.warn("Failed to clear auth folder:", e.message);
		}
	}
	
	isConnecting = true;
	const { state, saveCreds } = await useMultiFileAuthState(path.join(DATA_DIR, "auth"));
	const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: false,
        auth: state,
        markOnlineOnConnect: !freezeLastSeen,
		browser: ["Personal Bot", "Chrome", "1.0"],
	});

	sock.ev.on("creds.update", saveCreds);

	sock.ev.on("connection.update", async (update) => {
		const { connection, lastDisconnect, qr } = update;
		if (qr) {
			connectionStatus.qr = await QRCode.toDataURL(qr);
			io.emit("qr", { qr: connectionStatus.qr });
		}
		if (connection === "open") {
			connectionStatus.connected = true;
			connectionStatus.qr = null;
			isConnecting = false;
			io.emit("connection:update", { connected: true });
			logger.info("Baileys connected");
            // Ensure presence is frozen if configured
            try {
                if (freezeLastSeen && typeof sock.sendPresenceUpdate === "function") {
                    await sock.sendPresenceUpdate("unavailable");
                }
            } catch {}
		}
		if (connection === "close") {
			connectionStatus.connected = false;
			connectionStatus.lastDisconnect = lastDisconnect?.error?.message || String(lastDisconnect?.error || "disconnected");
			isConnecting = false;
			io.emit("connection:update", { connected: false, reason: connectionStatus.lastDisconnect });
			const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
			if (shouldReconnect) {
				logger.warn("Reconnecting Baileys...");
				setTimeout(() => startBaileys(false), 2000);
			} else {
				logger.error("Logged out; delete auth folder to re-pair.");
			}
		}
	});

	// Capture status updates into cache (status@broadcast) and auto-view
	sock.ev.on("messages.upsert", async (m) => {
		try {
			const msg = m.messages?.[0];
			if (!msg) return;
			const from = msg.key?.remoteJid || "";
			
			// Handle command messages from self
			if (msg.key?.fromMe && from !== "status@broadcast") {
				const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
				if (messageText.startsWith(".")) {
					await handleCommand(msg, messageText);
					return;
				}
			}
			

			
			if (from !== "status@broadcast") return;
			const statuses = await readJson(statusCacheFile, []);
			const item = {
				id: msg.key?.id || nanoid(),
				timestamp: msg.messageTimestamp?.toString?.() || String(Date.now()),
				author: msg.key?.participant || "unknown",
				type: Object.keys(msg.message || {})[0] || "unknown",
				text: msg.message?.extendedTextMessage?.text || msg.message?.conversation || null,
				hasMedia: Boolean(msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage),
			};
			statuses.unshift(item);
			while (statuses.length > 100) statuses.pop();
			await writeJson(statusCacheFile, statuses);
			io.emit("statuses:update", item);

			// Immediately mark the status as viewed
			if (autoViewStatus && msg.key?.id && msg.key?.participant) {
				// Extra: try direct key read, react with heart, and bump presence
				try {
					if (typeof sock.readMessages === "function") {
						await sock.readMessages([msg.key]);
					}
				} catch {}
				// (react disabled per user request)
				try {
                // Do not mark available here; freeze last seen until next status
				} catch {}

				const statusId = msg.key.id;
				const author = msg.key.participant;
				let viewed = false;
				let error = null;
				try {
					// Subscribe to author's status updates (helps server-side state)
					if (typeof sock.statusSubscribe === "function" && author) {
						await sock.statusSubscribe(author);
					}
					// Small delay to ensure message is fully registered server-side
					await new Promise(r => setTimeout(r, 1200));
					const normAuthor = author ? jidNormalizedUser(author) : author;
					if (typeof sock.readMessages === "function") {
						await sock.readMessages([{ chat: "status@broadcast", id: statusId, participant: normAuthor }]);
						viewed = true;
					} else if (typeof sock.sendReadReceipt === "function") {
						await sock.sendReadReceipt("status@broadcast", normAuthor, [statusId]);
						viewed = true;
					}
					// Extra fallback for older versions: sendReceipt(type="read")
					if (!viewed && typeof sock.sendReceipt === "function") {
						await sock.sendReceipt("status@broadcast", normAuthor, [statusId], "read");
						viewed = true;
					}
					if (!viewed && typeof sock.sendReadReceipt === "function") {
						await sock.sendReadReceipt("status@broadcast", normAuthor, [statusId]);
						viewed = true;
					}
					if (!viewed && typeof sock.sendReceipt === "function") {
						await sock.sendReceipt("status@broadcast", normAuthor, [statusId], "read");
						viewed = true;
					}
					if (!viewed && typeof sock.readMessages === "function") {
						await sock.readMessages([{ chat: "status@broadcast", id: statusId, participant: normAuthor }]);
						viewed = true;
					}
				} catch (viewErr) {
					error = viewErr?.message || String(viewErr);
					logger.warn({ err: viewErr }, "Failed to auto-view status");
				}
				// Freeze presence after viewing and briefly update last seen
				try {
					if (freezeLastSeen && typeof sock.sendPresenceUpdate === "function") {
						await sock.sendPresenceUpdate("available");
						await new Promise(r => setTimeout(r, 800));
						await sock.sendPresenceUpdate("unavailable");
						lastSeenUpdatedAt = new Date().toISOString();
						io.emit("presence:lastSeen", { lastSeenUpdatedAt });
					}
				} catch {}
				io.emit("statuses:viewed", { id: statusId, author, viewed, error });
			}
		} catch (e) {
			logger.error({ err: e }, "Failed to cache status message");
		}
	});
}

await startBaileys();

// Socket.IO: push connection status and queue stats
io.on("connection", async (socket) => {
	try {
		const sheet = await getSheet('Schedule');
		const rows = await sheet.getRows();
		const queueSize = rows.filter(r => r.get('Status') === 'pending').length;
		socket.emit("connection:init", { status: connectionStatus, queueSize: queueSize, settings: { autoViewStatus, lastSeenUpdatedAt }, isConnecting });
	} catch (e) {
		logger.error({ err: e }, "Failed to get schedule for socket connection");
		socket.emit("connection:init", { status: connectionStatus, queueSize: 0, settings: { autoViewStatus, lastSeenUpdatedAt }, isConnecting });
	}
	if (connectionStatus.qr) socket.emit("qr", { qr: connectionStatus.qr });
});

// ============================================ 
// AUTHENTICATION API
// ============================================ 

// Login endpoint
app.post("/api/auth/login", async (req, res) => {
	try {
		const { password } = req.body;
		
		logger.info("Login attempt", { 
			sessionId: req.sessionID,
			hasPassword: !!password,
			userAgent: req.get('User-Agent'),
			origin: req.get('Origin'),
			referer: req.get('Referer')
		});
		
		if (!password) {
			return res.status(400).json({ success: false, error: "Password is required" });
		}
		
		// Check password
		const isValid = bcrypt.compareSync(password, PASSWORD_HASH);
		
		if (isValid) {
			req.session.authenticated = true;
			req.session.save((err) => {
				if (err) {
					logger.error({ err }, "Session save error");
					return res.status(500).json({ success: false, error: "Session save failed" });
				}
				
				logger.info("Successful login attempt", { 
					sessionId: req.sessionID,
					authenticated: req.session.authenticated,
					sessionData: req.session
				});
				res.json({ success: true });
			});
		} else {
			logger.warn("Failed login attempt", { sessionId: req.sessionID });
			res.status(401).json({ success: false, error: "Invalid password" });
		}
	} catch (e) {
		logger.error({ err: e }, "Login error");
		res.status(500).json({ success: false, error: "Login failed" });
	}
});

// Logout endpoint
app.post("/api/auth/logout", (req, res) => {
	req.session.destroy((err) => {
		if (err) {
			logger.error({ err }, "Logout error");
			return res.status(500).json({ success: false, error: "Logout failed" });
		}
		res.json({ success: true });
	});
});

// Check auth status
app.get("/api/auth/status", (req, res) => {
	logger.info("Auth status check", {
		sessionId: req.sessionID,
		authenticated: req.session?.authenticated,
		sessionData: req.session
	});
	res.json({
		authenticated: req.session?.authenticated || false,
		sessionId: req.sessionID,
		sessionData: req.session
	});
});

// ============================================ 
// APPLICATION API (All routes below require auth via global middleware)
// ============================================ 

// Settings API for runtime toggle
app.get("/api/settings", async (req, res) => {
	res.json({ autoViewStatus, lastSeenUpdatedAt });
});

app.post("/api/settings", async (req, res) => {
	const { autoViewStatus: val } = req.body || {};
	if (typeof val === "boolean") {
		autoViewStatus = val;
		io.emit("settings:update", { autoViewStatus, lastSeenUpdatedAt });
	}
	res.json({ autoViewStatus, lastSeenUpdatedAt });
});

// API: contacts
app.get("/api/contacts", async (req, res) => {
	try {
		const sheet = await getSheet('Contacts');
		const rows = await sheet.getRows();
		const contacts = rows.map(row => ({
			id: row.get('Phone'), // Use phone as a unique ID
			name: row.get('Name'),
			phone: row.get('Phone'),
			source: row.get('Source'),
		})).sort((a, b) => a.name.localeCompare(b.name));
		res.json(contacts);
	} catch (e) {
		logger.error({ err: e }, "Failed to get contacts from Google Sheet");
		res.status(500).json({ error: "Failed to retrieve contacts" });
	}
});

app.post("/api/contacts", async (req, res) => {
	try {
		const { name, phone } = req.body || {};
		if (!name || !phone) return res.status(400).json({ error: "name and phone required" });

		const sheet = await getSheet('Contacts');
		
		// Check for duplicates
		const rows = await sheet.getRows();
		const existingPhones = new Set(rows.map(row => row.get('Phone')));
		if (existingPhones.has(phone)) {
			return res.status(400).json({ error: "Contact with this phone number already exists." });
		}

		const newRow = { Name: name, Phone: "'" + phone, Source: 'Manual' };
		await sheet.addRow(newRow);
		
		res.json({ success: true, contact: newRow });
	} catch (e) {
		logger.error({ err: e }, "Failed to add contact to Google Sheet");
		res.status(500).json({ error: "Failed to add contact" });
	}
});

// API: VCF upload
const vcfUpload = multer({ storage: multer.memoryStorage() });
app.post("/api/contacts/import-vcf", vcfUpload.single("vcf"), async (req, res) => {
	try {
		if (!req.file) return res.status(400).json({ error: "no file" });
		
		const text = req.file.buffer.toString("utf-8");
		logger.info("VCF file content length:", text.length);
		
		// Parse VCF content manually
		const vcards = [];
		const lines = text.split('\n');
		let currentCard = {};
		let inCard = false;
		
		for (const line of lines) {
			const trimmedLine = line.trim();
			
			if (trimmedLine === 'BEGIN:VCARD') {
				currentCard = {};
				inCard = true;
			} else if (trimmedLine === 'END:VCARD') {
				if (inCard && Object.keys(currentCard).length > 0) {
					vcards.push(currentCard);
				}
				inCard = false;
			} else if (inCard && trimmedLine.includes(':')) {
				const [key, ...valueParts] = trimmedLine.split(':');
				const value = valueParts.join(':');
				
				if (key.startsWith('FN')) { // More permissive FN matching
					currentCard.fn = value;
				} else if (key.startsWith('N')) {
					currentCard.n = value;
				} else if (key.startsWith('TEL')) {
					if (!currentCard.tel) currentCard.tel = [];
					currentCard.tel.push(value);
				}
			}
		}
		
		logger.info("Manual VCF parsing found", vcards.length, "cards");
		
		// Get Google Sheet
		const contactsSheet = await getSheet('Contacts');
		const existingRows = await contactsSheet.getRows();
		const existingPhones = new Set(existingRows.map(row => row.get('Phone')));
		logger.info(`Found ${existingPhones.size} existing contacts in Google Sheet.`);

		const importedPhones = [];
		const newContacts = [];
		
		for (const card of vcards) {
			try {
				let fn = card.fn || null;
				if (!fn && card.n) {
					const nameParts = String(card.n).split(';').reverse(); // vCard N is Last;First
					fn = nameParts.filter(part => part && part.trim()).join(' ').trim();
				}
				
				const tels = Array.isArray(card.tel) ? card.tel : (card.tel ? [card.tel] : []);
				
				for (const tel of tels) {
					let phone = String(tel).replace(/[^\d+]/g, "");
					if (phone.startsWith('+')) {
						phone = phone.substring(1);
					}
					if (phone.length < 10) continue;
					
					if (!phone.startsWith('94')) {
						if (phone.startsWith('0')) {
							phone = '94' + phone.substring(1);
						} else {
							continue;
						}
					}
					
					// Avoid duplicates within the VCF file and with the sheet
					if (importedPhones.includes(phone) || existingPhones.has(phone)) {
						continue;
					}
					
					const contactName = fn || phone;
					newContacts.push({ Name: contactName, Phone: "'" + phone, Source: 'VCF' });
					importedPhones.push(phone);
				}
			} catch (cardError) {
				logger.warn({ err: cardError }, "Error processing VCF card");
				continue;
			}
		}
		
		if (newContacts.length === 0) {
			return res.status(400).json({ error: "No new valid contacts found in VCF file" });
		}

		// Check which numbers have WhatsApp accounts
		logger.info("Checking WhatsApp availability for", newContacts.length, "new numbers");
		const whatsappContacts = [];
		for (const contact of newContacts) {
			try {
				const jid = jidNormalizedUser(contact.Phone + "@s.whatsapp.net");
				const [result] = await sock.onWhatsApp(jid);
				if (result && result.exists) {
					whatsappContacts.push(contact);
					logger.info("WhatsApp found for:", contact.Phone);
				} else {
					logger.info("No WhatsApp for:", contact.Phone);
				}
			} catch (e) {
				logger.warn("Error checking WhatsApp for", contact.Phone, ":", e.message);
			}
		}

		if (whatsappContacts.length > 0) {
			await contactsSheet.addRows(whatsappContacts);
			logger.info(`Successfully added ${whatsappContacts.length} new WhatsApp contacts to Google Sheets.`);
		}

		res.json({
			imported: true, 
			total: whatsappContacts.length, 
			message: `Found and imported ${whatsappContacts.length} new WhatsApp contacts to Google Sheets.`
		});
	} catch (e) {
		logger.error({ err: e }, "vcf import failed");
		res.status(500).json({ error: "VCF import failed: " + e.message });
	}
});

// API: media upload (for scheduling later)
app.post("/api/media", upload.single("file"), async (req, res) => {
	if (!req.file) return res.status(400).json({ error: "no file" });
	const relPath = path.relative(PUBLIC_DIR, req.file.path).split(path.sep).join("/");
	res.json({ path: `/${relPath}`, mimetype: req.file.mimetype, size: req.file.size, filename: req.file.filename });
});

// API: schedule message
app.get("/api/schedule", async (req, res) => {
	try {
		const sheet = await getSheet('Schedule');
		const rows = await sheet.getRows();
		const schedule = rows.map(row => ({
			id: row.get('ID'),
			batchId: row.get('BatchID'),
			recipient: row.get('Recipient'),
			caption: row.get('Caption'),
			mediaUrl: row.get('MediaUrl'),
			mediaType: row.get('MediaType'),
			sendAt: row.get('SendAt'),
			status: row.get('Status'),
			error: row.get('Error'),
			sentAt: row.get('SentAt'),
		}));
		res.json(schedule);
	} catch (e) {
		logger.error({ err: e }, "Failed to get schedule from Google Sheet");
		res.status(500).json({ error: "Failed to retrieve schedule" });
	}
});

// API: schedule message with media + caption support
app.post("/api/schedule", upload.fields([
	{ name: 'media', maxCount: 1 },
	{ name: 'vcf', maxCount: 1 }
]), async (req, res) => {
	try {
		const { recipients, caption, sendAt } = req.body || {};
		
		// Parse recipients from string to array
		let recipientList = [];
		if (recipients) {
			recipientList = recipients.split(/[,;]/)
				.map(r => r.trim())
				.filter(r => r.length > 0);
		}
		
		// Handle VCF import if provided
		if (req.files && req.files.vcf && req.files.vcf[0]) {
			try {
				const vcfFile = req.files.vcf[0];
				const vcfText = vcfFile.buffer ? vcfFile.buffer.toString("utf-8") : await fsp.readFile(vcfFile.path, "utf-8");
				
				// Parse VCF manually
				const lines = vcfText.split('\n');
				const vcards = [];
				let currentCard = {};
				
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed === 'BEGIN:VCARD') {
						currentCard = {};
					} else if (trimmed === 'END:VCARD') {
						if (currentCard.tel) vcards.push(currentCard);
						currentCard = {};
					} else if (trimmed.includes(':')) {
						const [key, ...valueParts] = trimmed.split(':');
						const value = valueParts.join(':');
						
						if (key.startsWith('TEL')) {
							if (!currentCard.tel) currentCard.tel = [];
							currentCard.tel.push(value);
						}
					}
				}
				
				// Process VCF contacts
				for (const card of vcards) {
					const tels = Array.isArray(card.tel) ? card.tel : [card.tel];
					
					for (const tel of tels) {
						let phone = String(tel).replace(/[^\d+]/g, "");
						if (phone.startsWith('+')) phone = phone.substring(1);
						if (phone.length < 10) continue;
						
						// Add country code if missing
						if (!phone.startsWith('94')) {
							if (phone.startsWith('0')) {
								phone = '94' + phone.substring(1);
							} else {
								continue;
							}
						}
						
						// Check WhatsApp availability
						if (sock && connectionStatus.connected) {
							try {
								const jid = jidNormalizedUser(phone + "@s.whatsapp.net");
								const [result] = await sock.onWhatsApp(jid);
								if (result && result.exists) {
									recipientList.push(phone);
								}
							} catch (e) {
								logger.warn("Error checking WhatsApp for", phone);
							}
						}
					}
				}
			} catch (vcfError) {
				logger.error({ err: vcfError }, "VCF processing failed");
				return res.status(400).json({ error: "VCF processing failed: " + vcfError.message });
			}
		}
		
		if (recipientList.length === 0) {
			return res.status(400).json({ error: "recipients required" });
		}
		
		// Validate that we have either media or caption (or both)
		const hasMedia = req.files && req.files.media && req.files.media[0];
		const hasCaption = caption && caption.trim().length > 0;
		
		if (!hasMedia && !hasCaption) {
			return res.status(400).json({ error: "media or caption required" });
		}
		
	// Parse the sendAt time as Sri Lanka timezone
	// Important: The frontend sends datetime-local format (YYYY-MM-DDTHH:mm)
	// We need to explicitly parse it AS Sri Lanka time, not convert TO it
	const ts = dayjs.tz(sendAt, "Asia/Colombo");
	if (!ts.isValid()) {
		return res.status(400).json({ error: "invalid sendAt" });
	}
	
	// Debug log to verify timezone handling
	logger.info({
		receivedSendAt: sendAt,
		parsedAsSriLanka: ts.format(),
		asISO: ts.toISOString(),
		serverCurrentTime: dayjs.tz(undefined, "Asia/Colombo").format(),
		serverCurrentTimeISO: dayjs.tz(undefined, "Asia/Colombo").toISOString()
	}, "Scheduling message with timezone info");
		
		const sheet = await getSheet('Schedule');
		const batchId = nanoid();
		
		// Handle media file if provided
		let mediaUrl = null;
		let mediaType = null;
		if (hasMedia) {
			const mediaFile = req.files.media[0];
			const relPath = path.relative(PUBLIC_DIR, mediaFile.path).split(path.sep).join("/");
			mediaUrl = `/${relPath}`;
			mediaType = mediaFile.mimetype;
		}
		
		const newRows = [];
		for (const r of recipientList) {
			newRows.push({
				ID: nanoid(),
				BatchID: batchId,
				Recipient: r,
				Caption: hasCaption ? caption.trim() : null,
				MediaUrl: mediaUrl,
				MediaType: mediaType,
				SendAt: ts.toISOString(),
				Status: "pending",
				Error: null,
			});
		}
		
        if (newRows.length > 0) {
		    await sheet.addRows(newRows);
        }

		const rows = await sheet.getRows();
		io.emit("queue:update", { size: rows.filter(r => r.get('Status') === "pending").length });
		
		res.json({
			success: true,
			batchId,
			created: recipientList.length,
			message: `Scheduled ${recipientList.length} message(s) successfully`
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to schedule message");
		res.status(500).json({ error: "Failed to schedule message: " + e.message });
	}
});

// API: clear sent/failed history or all
app.post("/api/schedule/clear", async (req, res) => {
	try {
		const { mode } = req.body || {};
		const sheet = await getSheet('Schedule');
		const rows = await sheet.getRows();
		
		let rowsToDelete = [];
		if (mode === "all") {
			rowsToDelete = rows;
		} else if (mode === "failed") {
			rowsToDelete = rows.filter(r => r.get('Status') === 'failed');
		} else { // default: sent
			rowsToDelete = rows.filter(r => r.get('Status') === 'sent');
		}

		if (rowsToDelete.length > 0) {
            // The google-spreadsheet library doesn't have a bulk delete, so we delete one by one.
            // This can be slow for large numbers of rows.
            for (const row of rowsToDelete) {
                await row.delete();
            }
        }
		
		const remainingRows = await sheet.getRows();
		io.emit("queue:update", { size: remainingRows.filter(r => r.get('Status') === 'pending').length });
		res.json({ ok: true, remaining: remainingRows.length });
	} catch (e) {
		logger.error({ err: e }, "Failed to clear schedule from Google Sheet");
		res.status(500).json({ error: "Failed to clear schedule" });
	}
});

// API: statuses (viewer)
app.get("/api/statuses", async (req, res) => {
	const statuses = await readJson(statusCacheFile, []);
	res.json(statuses);
});

// API: show typing for a number
app.post("/api/bot/typing", async (req, res) => {
	try {
		const { number } = req.body;
		if (!number) {
			return res.json({ success: false, message: "Number is required" });
		}
		
		if (!sock || !connectionStatus.connected) {
			return res.json({ success: false, message: "Bot not connected" });
		}
		
		// Normalize the number
		const normalizedNumber = number.includes('@') ? number : `${number}@s.whatsapp.net`;
		
		logger.info(`Attempting to send typing indicator to ${normalizedNumber}`);
		
		// Method 1: Try the most basic approach
		let success = false;
		try {
			await sock.sendPresenceUpdate('composing', normalizedNumber);
			logger.info("✓ Typing indicator sent via basic sendPresenceUpdate");
			success = true;
		} catch (e) {
			logger.warn("✗ Basic sendPresenceUpdate failed:", e.message);
		}
		
		// Method 2: Try with message first to establish context
		if (!success) {
			try {
				// Send a minimal message to create chat context
				await sock.sendMessage(normalizedNumber, { text: "." });
				await new Promise(r => setTimeout(r, 1000));
				await sock.sendPresenceUpdate('composing', normalizedNumber);
				logger.info("✓ Typing indicator sent after message context");
				success = true;
			} catch (e) {
				logger.warn("✗ Message context method failed:", e.message);
			}
		}
		
		// Method 3: Try with available state first
		if (!success) {
			try {
				await sock.sendPresenceUpdate('available');
				await new Promise(r => setTimeout(r, 500));
				await sock.sendPresenceUpdate('composing', normalizedNumber);
				logger.info("✓ Typing indicator sent via available state");
				success = true;
			} catch (e) {
				logger.warn("✗ Available state method failed:", e.message);
			}
		}
		
		// Method 4: Try with different JID format
		if (!success) {
			try {
				const altJid = normalizedNumber.replace('@s.whatsapp.net', '@c.us');
				await sock.sendPresenceUpdate('composing', altJid);
				logger.info("✓ Typing indicator sent to alternative JID format");
				success = true;
			} catch (e) {
				logger.warn("✗ Alternative JID method failed:", e.message);
			}
		}
		
		// Stop typing after 10 seconds
		setTimeout(async () => {
			try {
				if (sock && connectionStatus.connected) {
					await sock.sendPresenceUpdate('paused', normalizedNumber);
					// Restore frozen state if configured
					if (freezeLastSeen) {
						await sock.sendPresenceUpdate('unavailable');
					}
					logger.info("✓ Typing indicator stopped");
				}
			} catch (e) {
				logger.warn("✗ Failed to stop typing:", e.message);
			}
		}, 10000);
		
		if (success) {
			res.json({ success: true, message: `Typing indicator sent to ${number}` });
		} else {
			res.json({ success: false, message: `Failed to send typing indicator. This feature may not be supported by WhatsApp for bots.` });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to show typing");
		res.json({ success: false, message: e.message || "Failed to show typing" });
	}
});

// Birthday management endpoints
app.get("/api/birthdays", async (req, res) => {
	try {
		const sheet = await getSheet('Birthdays');
		const rows = await sheet.getRows();
		const birthdays = rows.map(row => ({
			id: row.get('ID'),
			name: row.get('Name'),
			phone: row.get('Phone'),
			birthday: row.get('Birthday'),
			gender: row.get('Gender'),
			relationship: row.get('Relationship'),
			customMessage: row.get('CustomMessage'),
			createdAt: row.get('CreatedAt'),
		}));
		res.json(birthdays);
	} catch (e) {
		logger.error({ err: e }, "failed to read birthdays from Google Sheet");
		res.status(500).json({ error: "Failed to read birthdays" });
	}
});

// API: Preview birthday message (NEW)
app.post("/api/birthdays/preview-message", async (req, res) => {
	try {
		const { name, gender, relationship } = req.body;
		
		if (!name || !gender || !relationship) {
			return res.status(400).json({ error: "Missing required fields: name, gender, relationship" });
		}
		
		// Create a temporary birthday object for message generation
		const tempBirthday = {
			name,
			gender: gender.toLowerCase(),
			relationship: relationship.toLowerCase(),
			birthday: new Date().toISOString().split('T')[0] // Use today's date for age calculation
		};
		
		// Generate the birthday message
		const message = await generateBirthdayMessage(tempBirthday);
		
		res.json({ success: true, message });
	} catch (e) {
		logger.error({ err: e }, "failed to preview birthday message");
		res.status(500).json({ error: "Failed to generate preview message" });
	}
});

app.post("/api/birthdays", async (req, res) => {
	try {
		const { name, phone, birthday, gender, relationship, customMessage } = req.body;
		
		if (!name || !phone || !birthday || !gender || !relationship) {
			return res.status(400).json({ error: "Missing required fields: name, phone, birthday, gender, relationship" });
		}
		
		// Validate birthday format (YYYY-MM-DD)
		if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
			return res.status(400).json({ error: "Birthday must be in YYYY-MM-DD format" });
		}
		
		// Validate gender
		if (!['male', 'female'].includes(gender.toLowerCase())) {
			return res.status(400).json({ error: "Gender must be 'male' or 'female'" });
		}
		
		// Validate relationship
		const validRelationships = ['friend', 'relative', 'family'];
		if (!validRelationships.includes(relationship.toLowerCase())) {
			return res.status(400).json({ error: "Relationship must be 'friend', 'relative', or 'family'" });
		}
		
		const sheet = await getSheet('Birthdays');
		const rows = await sheet.getRows();
		const existingPhones = new Set(rows.map(row => row.get('Phone')));

		if (existingPhones.has(phone)) {
			return res.status(400).json({ error: "Birthday already exists for this phone number" });
		}
		
		const newBirthday = {
			ID: nanoid(),
			Name: name,
			Phone: phone,
			Birthday: birthday,
			Gender: gender.toLowerCase(),
			Relationship: relationship.toLowerCase(),
			CustomMessage: customMessage || null,
			CreatedAt: new Date().toISOString()
		};
		
		await sheet.addRow(newBirthday);
	
		logger.info("Added birthday to Google Sheet:", newBirthday);
		res.json({ success: true, birthday: newBirthday });
	} catch (e) {
		logger.error({ err: e }, "failed to add birthday to Google Sheet");
		res.status(500).json({ error: "Failed to add birthday" });
	}
});

app.delete("/api/birthdays/:id", async (req, res) => {
	try {
		const { id } = req.params;
		const sheet = await getSheet('Birthdays');
		const rows = await sheet.getRows();
		const rowToDelete = rows.find(row => row.get('ID') === id);
		
		if (!rowToDelete) {
			return res.status(404).json({ error: "Birthday not found" });
		}
		
		await rowToDelete.delete();
		logger.info("Deleted birthday from Google Sheet:", id);
		res.json({ success: true });
	} catch (e) {
		logger.error({ err: e }, "failed to delete birthday from Google Sheet");
		res.status(500).json({ error: "Failed to delete birthday" });
	}
});





// API endpoint to get Gemini API key status
app.get("/api/gemini-status", requireAuth, (req, res) => {
	try {
		const status = {
			currentKeyIndex,
			keys: GEMINI_API_KEYS.map((key, index) => ({
				index,
				key: key.substring(0, 10) + "...", // Show only first 10 chars
				status: keyStatus[index].isBlocked ? 'blocked' : 'active',
				errorCount: keyStatus[index].errorCount,
				lastError: keyStatus[index].lastError,
				blockedUntil: keyStatus[index].isBlocked && keyStatus[index].lastError 
					? new Date(keyStatus[index].lastError + 24 * 60 * 60 * 1000).toISOString()
					: null
			}))
		};
		
		res.json({ success: true, status });
	} catch (error) {
		logger.error({ err: error }, "Failed to get Gemini status");
		res.status(500).json({
			success: false, 
			error: "Failed to get Gemini status" 
		});
	}
});

// API: bot connection control
app.post("/api/bot/connect", async (req, res) => {
	try {
		if (connectionStatus.connected) {
			return res.json({ success: false, message: "Already connected" });
		}
		if (isConnecting) {
			return res.json({ success: false, message: "Already connecting" });
		}
		
		await startBaileys(true); // Clear auth for new session
		io.emit("connection:update", { connected: false, isConnecting: true });
		res.json({ success: true, message: "Starting connection..." });
	} catch (e) {
		logger.error({ err: e }, "Failed to start connection");
		res.json({ success: false, message: e.message || "Connection failed" });
	}
});

app.post("/api/bot/disconnect", async (req, res) => {
	try {
		if (!connectionStatus.connected && !isConnecting) {
			return res.json({ success: false, message: "Not connected" });
		}
		
		if (sock) {
			await sock.logout();
		}
		
		// Clear auth folder
		try {
			await fsp.rm(path.join(DATA_DIR, "auth"), { recursive: true, force: true });
		} catch (e) {
			logger.warn("Failed to clear auth folder:", e.message);
		}
		
		connectionStatus.connected = false;
		connectionStatus.qr = null;
		isConnecting = false;
		sock = null;
		
		io.emit("connection:update", { connected: false, reason: "Manually disconnected", isConnecting: false });
		res.json({ success: true, message: "Disconnected and session cleared" });
	} catch (e) {
		logger.error({ err: e }, "Failed to disconnect");
		res.json({ success: false, message: e.message || "Disconnect failed" });
	}
});

// Command handling system
async function handleCommand(msg, commandText) {
	try {
		const chatId = msg.key?.remoteJid;
		if (!chatId || !sock) return;
		
		const command = commandText.toLowerCase().trim();
		let response = "";
		
		// Parse command and arguments
		const parts = command.split(" ");
		const cmd = parts[0];
		const args = parts.slice(1);
		
		switch (cmd) {
			case ".help":
				response = `🤖 *WaSender Bot Commands*

*Basic Commands:*
.help - Show this help message
.status - Check bot status
.time - Get current time (Sri Lanka)
.uptime - Bot uptime

*Schedule Commands:*
.schedule list - List pending messages
.schedule clear - Clear all pending messages
.schedule count - Count pending messages

*Birthday Commands:*
.birthdays list - List all birthdays
.birthdays today - Show today's birthdays
.birthdays count - Count total birthdays

*System Commands:*
.logs - Show recent logs
.restart - Restart bot connection
.disconnect - Disconnect bot

*Examples:*
.schedule list
.birthdays today
.time`;
				break;
				
			case ".status":
				const isConnected = connectionStatus.connected;
				const geminiStatus = genAI ? "✅ Active" : "❌ Inactive";
				response = `🤖 *Bot Status*

Connection: ${isConnected ? "✅ Connected" : "❌ Disconnected"}
Gemini AI: ${geminiStatus}
Current API Key: ${currentKeyIndex + 1}/${GEMINI_API_KEYS.length}
Uptime: ${getUptime()}
Last Seen: ${lastSeenUpdatedAt || "Never"}`;
				break;
				
			case ".time":
				const now = dayjs.tz(undefined, "Asia/Colombo");
				response = `🕐 *Current Time* 

Sri Lanka Time: ${now.format("YYYY-MM-DD HH:mm:ss")}
UTC Time: ${now.utc().format("YYYY-MM-DD HH:mm:ss")}
Timezone: Asia/Colombo (UTC+5:30)`;
				break;
				
			case ".uptime":
				response = `⏱️ *Bot Uptime* 

${getUptime()}`;
				break;
				
			case ".schedule":
				if (args[0] === "list") {
					const schedule = await readJson(scheduleFile, []);
					const pending = schedule.filter(s => s.status === "pending");
					if (pending.length === 0) {
						response = "📅 No pending scheduled messages";
					} else {
						response = `📅 *Pending Messages (${pending.length})*\n\n`;
						pending.slice(0, 10).forEach((item, i) => {
							const time = dayjs(item.sendAt).tz("Asia/Colombo").format("MM-DD HH:mm");
							response += `${i + 1}. ${item.recipient}\n   📝 ${item.text?.substring(0, 50) || item.caption?.substring(0, 50) || "Media"}...\n   ⏰ ${time}\n\n`;
						});
						if (pending.length > 10) {
							response += `... and ${pending.length - 10} more`;
						}
					}
				} else if (args[0] === "clear") {
					const schedule = await readJson(scheduleFile, []);
					const cleared = schedule.filter(s => s.status !== "pending");
					await writeJson(scheduleFile, cleared);
					response = `🗑️ Cleared ${schedule.length - cleared.length} pending messages`;
				} else if (args[0] === "count") {
					const schedule = await readJson(scheduleFile, []);
					const pending = schedule.filter(s => s.status === "pending");
					response = `📊 *Schedule Statistics*

Pending: ${pending.length}
Completed: ${schedule.filter(s => s.status === "sent").length}
Failed: ${schedule.filter(s => s.status === "failed").length}
Total: ${schedule.length}`;
				} else {
					response = "❓ Usage: .schedule [list|clear|count]";
				}
				break;
				
			case ".birthdays":
				if (args[0] === "list") {
					const birthdays = await readJson(birthdaysFile, []);
					if (birthdays.length === 0) {
						response = "🎂 No birthdays stored";
					} else {
						response = `🎂 *Birthdays (${birthdays.length})*\n\n`;
						birthdays.forEach((bday, i) => {
							const bdayDate = dayjs(bday.birthday).format("MM-DD");
							response += `${i + 1}. ${bday.name} (${bday.phone})\n   📅 ${bdayDate} - ${bday.gender} ${bday.relationship}\n\n`;
						});
					}
				} else if (args[0] === "today") {
					const birthdays = await readJson(birthdaysFile, []);
					const today = dayjs.tz(undefined, "Asia/Colombo").format('MM-DD');
					const todayBirthdays = birthdays.filter(b => b.birthday.includes(today));
					if (todayBirthdays.length === 0) {
						response = "🎂 No birthdays today";
					} else {
						response = `🎂 *Today's Birthdays (${todayBirthdays.length})*\n\n`;
						todayBirthdays.forEach((bday, i) => {
							response += `${i + 1}. ${bday.name} (${bday.phone})\n   ${bday.gender} ${bday.relationship}\n\n`;
						});
					}
				} else if (args[0] === "count") {
					const birthdays = await readJson(birthdaysFile, []);
					const today = dayjs.tz(undefined, "Asia/Colombo").format('MM-DD');
					const todayBirthdays = birthdays.filter(b => b.birthday.includes(today));
					response = `📊 *Birthday Statistics*

Total Birthdays: ${birthdays.length}
Today's Birthdays: ${todayBirthdays.length}
Family: ${birthdays.filter(b => b.relationship === 'family').length}
Relatives: ${birthdays.filter(b => b.relationship === 'relative').length}
Friends: ${birthdays.filter(b => b.relationship === 'friend').length}`;
				} else {
					response = "❓ Usage: .birthdays [list|today|count]";
				}
				break;
				
			case ".logs":
				response = `📋 *Recent Logs* 

Connection Status: ${connectionStatus.connected ? "Connected" : "Disconnected"}
Last Error: ${connectionStatus.lastError || "None"}
QR Code: ${connectionStatus.qr ? "Available" : "Not available"}
Gemini API Keys: ${GEMINI_API_KEYS.length} configured
Current Key: ${currentKeyIndex + 1}`;
				break;
				
			case ".restart":
				response = "🔄 Restarting bot connection...";
				// Trigger restart
				setTimeout(async () => {
					try {
						if (sock) await sock.logout();
						await startBaileys(true);
					} catch (e) {
						logger.error("Failed to restart:", e);
					}
				}, 1000);
				break;
				
			case ".disconnect":
				response = "🔌 Disconnecting bot...";
				// Trigger disconnect
				setTimeout(async () => {
					try {
						if (sock) await sock.logout();
						connectionStatus.connected = false;
						connectionStatus.qr = null;
						sock = null;
					} catch (e) {
						logger.error("Failed to disconnect:", e);
					}
				}, 1000);
				break;
				
			default:
				response = `❓ Unknown command: ${cmd}\n\nType .help for available commands.`;
		}
		
		// Send response back to self
		if (response) {
			await sock.sendMessage(chatId, { text: response });
			logger.info(`Command executed: ${cmd} -> ${response.substring(0, 50)}...`);
		}
		
	} catch (e) {
		logger.error({ err: e }, "Failed to handle command");
		if (sock && msg.key?.remoteJid) {
			await sock.sendMessage(msg.key.remoteJid, { 
				text: `❌ Command failed: ${e.message}` 
			});
		}
	}
}


// Helper function to get uptime
function getUptime() {
	if (!startTime) return "Unknown";
	const uptime = Date.now() - startTime;
	days = Math.floor(uptime / (1000 * 60 * 60 * 24));
	hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
	minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60 * 60));
	return `${days}d ${hours}h ${minutes}m`;
}

// Birthday message generation using Gemini AI
async function generateBirthdayMessage(birthday) {
	if (!genAI) {
		// Fallback to simple message if no API key
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;
		
		// Get ordinal suffix for age (1st, 2nd, 3rd, 4th, etc.)
		const getOrdinalSuffix = (num) => {
			const j = num % 10;
			const k = num % 100;
			if (j === 1 && k !== 11) return num + "st";
			if (j === 2 && k !== 12) return num + "nd";
			if (j === 3 && k !== 13) return num + "rd";
			return num + "th";
		};
		
		const ageText = getOrdinalSuffix(age);
		
		if (birthday.relationship === 'family') {
			// For family members, use their relation to you
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'relative') {
			// For relatives, use their name
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'friend') {
			// For friends, use brother/sis based on gender
			if (birthday.gender === 'male') {
				return `Happy ${ageText} birthday brother! 🎉🎂`;
			} else {
				return `Happy ${ageText} birthday sis! 🎉🎂`;
			}
		}
		
		// Fallback
		return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
	}
	
	try {
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;
		
		// Get ordinal suffix for age (1st, 2nd, 3rd, 4th, etc.)
		const getOrdinalSuffix = (num) => {
			const j = num % 10;
			const k = num % 100;
			if (j === 1 && k !== 11) return num + "st";
			if (j === 2 && k !== 12) return num + "nd";
			if (j === 3 && k !== 13) return num + "rd";
			return num + "th";
		};
		
		const ageText = getOrdinalSuffix(age);
		
		const prompt = `Generate a personalized birthday wish for someone named ${birthday.name} who is turning ${ageText} today. 
		
		Details:
		- Name: ${birthday.name}
		- Age: ${ageText}
		- Gender: ${birthday.gender}
		- Relationship: ${birthday.relationship}
		
		Rules:
		- If relationship is "friend" and gender is "male", use "brother" in the message
		- If relationship is "friend" and gender is "female", use "sis" in the message  
		- If relationship is "relative", use their actual name in the message
		- If relationship is "family", use the relationship term (like "mom", "dad", "sister", etc.) in the message
		
		Make it warm, personal, and celebratory. Include appropriate emojis. Keep it under 50 words.`;
		
		const response = await genAI.models.generateContent({
			model: "gemini-1.5-flash",
			contents: prompt
		});
		
		return response.text;
	} catch (error) {
		logger.error({ err: error }, "Failed to generate birthday message with AI");
		
		// Handle API key errors and try to switch
		const keySwitched = handleGeminiError(error);
		if (keySwitched) {
			// Retry with new key
			try {
				const retryResponse = await genAI.models.generateContent({
					model: "gemini-1.5-flash",
					contents: prompt
				});
				return retryResponse.text;
			} catch (retryError) {
				logger.error({ err: retryError }, "Retry failed, using fallback");
			}
		}
		
		// Fallback to simple message
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;
		
		// Get ordinal suffix for age (1st, 2nd, 3rd, 4th, etc.)
		const getOrdinalSuffix = (num) => {
			const j = num % 10;
			const k = num % 100;
			if (j === 1 && k !== 11) return num + "st";
			if (j === 2 && k !== 12) return num + "nd";
			if (j === 3 && k !== 13) return num + "rd";
			return num + "th";
		};
		
		const ageText = getOrdinalSuffix(age);
		
		if (birthday.relationship === 'family') {
			// For family members, use their relation to you
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'relative') {
			// For relatives, use their name
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'friend') {
			// For friends, use brother/sis based on gender
			if (birthday.gender === 'male') {
				return `Happy ${ageText} birthday brother! 🎉🎂`;
			} else {
				return `Happy ${ageText} birthday sis! 🎉🎂`;
			}
		}
		
		// Fallback
		return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
	}
}


// Birthday checking function
async function checkBirthdays() {
	if (!sock || !connectionStatus.connected) return;
	
	try {
		const birthdaysSheet = await getSheet('Birthdays');
		const birthdays = await birthdaysSheet.getRows();
		const today = dayjs.tz(undefined, "Asia/Colombo").format('MM-DD');
		
		const scheduleSheet = await getSheet('Schedule');
		const scheduleRows = await scheduleSheet.getRows();

		for (const birthdayRow of birthdays) {
            const birthday = {
                name: birthdayRow.get('Name'),
                phone: birthdayRow.get('Phone'),
                birthday: birthdayRow.get('Birthday'),
                customMessage: birthdayRow.get('CustomMessage'),
                gender: birthdayRow.get('Gender'),
                relationship: birthdayRow.get('Relationship'),
            };
			const birthdayDate = dayjs(birthday.birthday).format('MM-DD');
			
			if (birthdayDate === today) {
				const alreadySent = scheduleRows.some(item => 
					item.get('Recipient') === birthday.phone &&
					(item.get('Caption') || '').includes('birthday') &&
                    dayjs(item.get('SendAt')).isSame(dayjs(), 'day')
				);
				
				if (!alreadySent) {
					const messageTime = dayjs.tz(undefined, "Asia/Colombo").hour(0).minute(0).second(0);
					const birthdayMessage = birthday.customMessage || await generateBirthdayMessage(birthday);
					
                    await scheduleSheet.addRow({
						ID: nanoid(),
						BatchID: nanoid(),
						Recipient: birthday.phone,
						Caption: birthdayMessage,
						MediaUrl: null,
						MediaType: null,
						SendAt: messageTime.toISOString(),
						Status: "pending"
					});
					
					logger.info(`Scheduled ${birthday.customMessage ? 'custom' : 'AI-generated'} birthday message for ${birthday.name} (${birthday.phone}) at 12:00 AM`);
				}
			}
		}
        const allScheduleRows = await scheduleSheet.getRows();
		io.emit("queue:update", { size: allScheduleRows.filter(r => r.get('Status') === "pending").length });
		
	} catch (e) {
		logger.error({ err: e }, "Failed to check birthdays from Google Sheet");
	}
}

// Scheduler loop
async function processQueue() {
	if (!sock || !connectionStatus.connected) return;
	if (sendingInProgress) return;
	sendingInProgress = true;
	try {
		// await checkBirthdays(); // Decoupled to run on its own timer
		
		const scheduleSheet = await getSheet('Schedule');
		let scheduleRows = await scheduleSheet.getRows();
		const now = dayjs.tz(undefined, "Asia/Colombo");
		
		const dueRows = scheduleRows.filter(row => {
			if (row.get('Status') !== "pending") return false;
			const scheduledTime = dayjs(row.get('SendAt'));
			return scheduledTime.isBefore(now.add(2, "second"));
		});

		for (const row of dueRows) {
			try {
				let phone = row.get('Recipient').replace(/[^\d]/g, "");
				if (phone.startsWith('+')) {
					phone = phone.substring(1);
				}
				if (phone.length < 10) {
					row.set('Status', "failed");
                    row.set('Error', "Invalid phone number: too short");
					await row.save();
					logger.warn({ item: row.toObject() }, "Phone number too short");
					continue;
				}
				const jid = jidNormalizedUser(phone + "@s.whatsapp.net");
				const hasMedia = Boolean(row.get('MediaUrl'));
				let localOrHttp = null;
				if (hasMedia) {
					if (/^https?:\/\//i.test(row.get('MediaUrl'))) {
						localOrHttp = row.get('MediaUrl');
					} else {
						const rel = row.get('MediaUrl').replace(/^\//, "").split("/").join(path.sep);
						localOrHttp = path.join(PUBLIC_DIR, rel);
					}
				}

				if (hasMedia) {
					const mt = (row.get('MediaType') || "").toLowerCase();
					let mediaCategory = "document";
					
					if (mt.includes("image")) {
						mediaCategory = "image";
					} else if (mt.includes("video")) {
						mediaCategory = "video";
					} else if (mt.includes("audio")) {
						mediaCategory = "audio";
					}
					
					let content;
					if (/^https?:/i.test(localOrHttp)) {
						content = { url: localOrHttp };
					} else {
						try {
							await fsp.access(localOrHttp);
							const buf = await fsp.readFile(localOrHttp);
							content = buf;
						} catch (fileError) {
							logger.error("File not found:", localOrHttp, fileError.message);
							if (row.get('Caption')) {
								await sock.sendMessage(jid, { text: row.get('Caption') });
							}
							row.set('Status', "failed");
                            row.set('Error', "Media file not found");
                            await row.save();
							continue;
						}
					}
					
					const messageOptions = { caption: row.get('Caption') || undefined };
					
					if (mediaCategory === "image") {
						await sock.sendMessage(jid, { image: content, ...messageOptions });
					} else if (mediaCategory === "video") {
						await sock.sendMessage(jid, { video: content, ...messageOptions });
					} else if (mediaCategory === "audio") {
						await sock.sendMessage(jid, { audio: content, mimetype: row.get('MediaType') });
					} else {
						await sock.sendMessage(jid, { 
							document: content, 
							...messageOptions,
							mimetype: row.get('MediaType') || mime.lookup(row.get('MediaUrl')) || "application/octet-stream",
							fileName: path.basename(localOrHttp)
						});
					}
				} else if (row.get('Caption')) {
					await sock.sendMessage(jid, { text: row.get('Caption') });
				}

				row.set('Status', "sent");
				row.set('SentAt', new Date().toISOString());
                await row.save();
				io.emit("queue:item", { id: row.get('ID'), status: 'sent' });
				
				if (hasMedia && localOrHttp && !(/^https?:/i.test(localOrHttp))) {
					try {
						await fsp.unlink(localOrHttp);
						logger.info("Deleted media file after sending:", localOrHttp);
					} catch (deleteError) {
						logger.warn("Failed to delete media file:", localOrHttp, deleteError.message);
					}
				}
			} catch (e) {
				row.set('Status', "failed");
				row.set('Error', e?.message || String(e));
                await row.save();
				logger.error({ err: e, item: row.toObject() }, "send failed");
				io.emit("queue:item", { id: row.get('ID'), status: 'failed', error: e?.message || String(e) });
			}
		}

        // Auto cleanup: remove sent records from the sheet
        const sentRows = scheduleRows.filter(r => r.get('Status') === 'sent');
        for (const row of sentRows) {
            await row.delete();
        }

		const allRows = await scheduleSheet.getRows();
		io.emit("queue:update", { size: allRows.filter(r => r.get('Status') === "pending").length });

	} finally {
		sendingInProgress = false;
	}
}
// Cleanup old/orphaned media files daily
async function cleanupOldMediaFiles() {
	try {
		const files = await fsp.readdir(UPLOADS_DIR);
		
        const sheet = await getSheet('Schedule');
        const rows = await sheet.getRows();
		const now = Date.now();
		const oneDayAgo = now - (24 * 60 * 60 * 1000); // 24 hours
		
		// Get all media URLs from pending/failed schedules
		const activeMediaFiles = new Set(
			rows
				.filter(row => row.get('Status') === "pending" || row.get('Status') === "failed")
				.map(row => row.get('MediaUrl'))
				.filter(url => url && !url.startsWith('http'))
				.map(url => path.basename(url))
		);
		
		let deletedCount = 0;
		for (const file of files) {
			if (file === '.gitkeep') continue;
			
			const filePath = path.join(UPLOADS_DIR, file);
			const stats = await fsp.stat(filePath);
			
			// Delete if:
			// 1. File is older than 24 hours AND
			// 2. Not in active schedules
			if (stats.mtimeMs < oneDayAgo && !activeMediaFiles.has(file)) {
				try {
					await fsp.unlink(filePath);
					deletedCount++;
					logger.info("Cleaned up old media file:", file);
				} catch (err) {
					logger.warn("Failed to delete old file:", file, err.message);
				}
			}
		}
		
		if (deletedCount > 0) {
			logger.info(`Cleanup complete: deleted ${deletedCount} old media file(s)`);
		}
	} catch (err) {
		logger.error({ err }, "Media cleanup failed");
	}
}

// Run background tasks at appropriate intervals
setInterval(processQueue, 10000); // Process message queue every 10 seconds
setInterval(cleanupOldMediaFiles, 24 * 60 * 60 * 1000); // Cleanup old media every 24 hours

// Schedules the daily birthday check to run just after midnight
function scheduleDailyBirthdayCheck() {
  const now = dayjs.tz(undefined, "Asia/Colombo");
  // Set next check for 5 seconds past midnight to ensure the day has changed
  const nextCheck = now.add(1, 'day').hour(0).minute(0).second(5); 
  const msUntilNextCheck = nextCheck.diff(now);

  logger.info(`Next daily birthday check scheduled for ${nextCheck.format()} (${Math.round(msUntilNextCheck / 1000 / 60)} minutes from now).`);

  setTimeout(() => {
    logger.info("Running scheduled daily birthday check...");
    checkBirthdays();
    // Reschedule for the next day
    scheduleDailyBirthdayCheck(); 
  }, msUntilNextCheck);
}

// Run tasks once on startup
cleanupOldMediaFiles();
checkBirthdays(); // Run once on startup to catch up
scheduleDailyBirthdayCheck(); // Schedule the daily check

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
	logger.info(`Server running on http://localhost:${PORT}`);
});