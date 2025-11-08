import 'dotenv/config';
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import mime from "mime-types";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { nanoid } from "nanoid";
import QRCode from "qrcode";
import { GoogleGenAI } from "@google/genai";
import makeWASocket, { fetchLatestBaileysVersion, DisconnectReason, jidNormalizedUser, useMultiFileAuthState } from "@whiskeysockets/baileys";

import logger from './logger.js';
import { getSheet } from './googleSheet.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Colombo");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const UPLOADS_DIR = path.join(PUBLIC_DIR, 'uploads');
const statusCacheFile = path.join(DATA_DIR, "status-cache.json");

let sock = null;
let connectionStatus = { connected: false, lastDisconnect: null, qr: null, device: "Personal Bot" };
let sendingInProgress = false;
let autoViewStatus = process.env.AUTO_VIEW_STATUS !== "false";
let autoReactStatus = process.env.AUTO_REACT_STATUS === "true";
let reactionEmoji = process.env.REACTION_EMOJI || "❤️,💕,😍,👍";
let freezeLastSeen = true;
let lastSeenUpdatedAt = null;
let isConnecting = false;
let startTime = Date.now();

let genAI = null;

export function updateSettings(newSettings) {
    if (typeof newSettings.autoViewStatus !== 'undefined') {
        autoViewStatus = newSettings.autoViewStatus;
    }
    if (typeof newSettings.autoReactStatus !== 'undefined') {
        autoReactStatus = newSettings.autoReactStatus;
    }
    if (typeof newSettings.reactionEmoji !== 'undefined') {
        reactionEmoji = newSettings.reactionEmoji;
    }
    logger.info('Bot settings updated:', { autoViewStatus, autoReactStatus, reactionEmoji });
}

function initializeGemini() {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		if (genAI) { // only log once
			logger.warn("No Gemini API key found in .env file, disabling AI features.");
			genAI = null;
		}
		return;
	}
	genAI = new GoogleGenAI(apiKey);
	logger.info(`Initialized Gemini AI.`);
}

function handleGeminiError(error) {
	logger.error({ err: error }, "An error occurred with the Gemini AI API.");
}

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

export async function startBaileys(io, clearAuth = false) {
	const authDir = path.join(DATA_DIR, "auth");
	if (clearAuth) {
		try {
			await fsp.rm(authDir, { recursive: true, force: true });
		} catch (e) {
			logger.warn("Failed to clear auth folder:", e.message);
		}
	}
	
	isConnecting = true;
	const { state, saveCreds } = await useMultiFileAuthState(authDir);
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
				setTimeout(() => startBaileys(io, false), 2000);
			} else {
				logger.error("Logged out; delete auth folder to re-pair.");
			}
		}
	});

	sock.ev.on("messages.upsert", async (m) => {
		try {
			const msg = m.messages?.[0];
			if (!msg) return;
			const from = msg.key?.remoteJid || "";

			if (msg.key?.fromMe && from !== "status@broadcast") {
				const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
				if (messageText.startsWith(".")) {
					await handleCommand(msg, messageText);
					return;
				}
			}

			// Generate and emit smart replies
			if (!msg.key?.fromMe && (msg.message?.conversation || msg.message?.extendedTextMessage?.text)) {
				const messageText = msg.message?.conversation || msg.message?.extendedTextMessage?.text;
				const suggestions = await generateReplySuggestions(messageText);
				io.emit("ai:reply-suggestions", { suggestions });
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

			if (autoViewStatus && msg.key?.id && msg.key?.participant) {
				try {
					if (typeof sock.readMessages === "function") {
						await sock.readMessages([msg.key]);
					}
				} catch {}
				try {
				} catch {}

				const statusId = msg.key.id;
				const author = msg.key.participant;
				let viewed = false;
				let error = null;
				try {
					if (typeof sock.statusSubscribe === "function" && author) {
						await sock.statusSubscribe(author);
					}
					await new Promise(r => setTimeout(r, 1200));
					const normAuthor = author ? jidNormalizedUser(author) : author;
					if (typeof sock.readMessages === "function") {
						await sock.readMessages([{ chat: "status@broadcast", id: statusId, participant: normAuthor }]);
						viewed = true;
					} else if (typeof sock.sendReadReceipt === "function") {
						await sock.sendReadReceipt("status@broadcast", normAuthor, [statusId]);
						viewed = true;
					}
					if (!viewed && typeof sock.sendReceipt === "function") {
						await sock.sendReceipt("status@broadcast", normAuthor, [statusId], "read");
						viewed = true;
					}
						if (viewed && autoReactStatus && reactionEmoji) {
							try {
								let selectedEmoji = reactionEmoji;
								if (reactionEmoji.includes(',')) {
									const emojis = reactionEmoji.split(',').map(e => e.trim()).filter(e => e);
									if (emojis.length > 0) {
										selectedEmoji = emojis[Math.floor(Math.random() * emojis.length)];
									}
								}

								await sock.sendMessage(jidNormalizedUser(author), {
									react: {
										text: selectedEmoji,
										key: msg.key
									}
								});
								logger.info(`Reacted with ${selectedEmoji} to status from ${author}`);
							} catch (reactErr) {
								logger.warn({ err: reactErr }, "Failed to react to status");
							}
						}
				} catch (viewErr) {
					error = viewErr?.message || String(viewErr);
					logger.warn({ err: viewErr }, "Failed to auto-view status");
				}
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

async function generateReplySuggestions(message) {
	if (!genAI) return [];
	try {
		const model = genAI.getGenerativeModel({ model: "gemini-pro"});
		const prompt = `Generate 2-3 short, context-aware reply suggestions for the following message:\n\n"${message}"\n\nSuggestions should be enclosed in double quotes and separated by a newline.`;
		const result = await model.generateContent(prompt);
		const response = await result.response;
		const text = response.text();
		const suggestions = text.match(/"(.*?)"/g).map(s => s.replace(/"/g, ''));
		return suggestions;
	} catch (error) {
		logger.error({ err: error }, "Failed to generate reply suggestions with AI");
		handleGeminiError(error);
		return [];
	}
}

async function handleCommand(msg, commandText) {
	try {
		const chatId = msg.key?.remoteJid;
		if (!chatId || !sock) return;
		
		const command = commandText.toLowerCase().trim();
		let response = "";
		
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
QR Code: ${connectionStatus.qr ? "Available" : "Not available"}`;
				break;
				
			case ".restart":
				response = "🔄 Restarting bot connection...";
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

async function generateBirthdayMessage(birthday) {
	if (!genAI) {
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;
		
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
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'relative') {
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'friend') {
			if (birthday.gender === 'male') {
				return `Happy ${ageText} birthday brother! 🎉🎂`;
			} else {
				return `Happy ${ageText} birthday sis! 🎉🎂`;
			}
		}
		
		return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
	}
	
	try {
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;
		
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
		
		const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash"});
		const result = await model.generateContent(prompt);
		const response = await result.response;
		return response.text();

	} catch (error) {
		logger.error({ err: error }, "Failed to generate birthday message with AI");
		handleGeminiError(error);
		// Fallback to non-AI message
		const today = dayjs();
		const birthYear = dayjs(birthday.birthday).year();
		const age = today.year() - birthYear;
		
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
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'relative') {
			return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
		} else if (birthday.relationship === 'friend') {
			if (birthday.gender === 'male') {
				return `Happy ${ageText} birthday brother! 🎉🎂`;
			} else {
				return `Happy ${ageText} birthday sis! 🎉🎂`;
			}
		}
		
		return `Happy ${ageText} birthday ${birthday.name}! 🎉🎂`;
	}
}

async function checkBirthdays(io) {
	if (!sock || !connectionStatus.connected) return;
	
	try {
		const birthdaysSheet = await getSheet('Birthdays');
		const birthdays = await birthdaysSheet.getRows();
		const tomorrow = dayjs.tz(undefined, "Asia/Colombo").add(1, 'day').format('MM-DD');
		
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
			
			if (birthdayDate === tomorrow) {
				const alreadySent = scheduleRows.some(item => 
					item.get('Recipient') === birthday.phone &&
					(item.get('Caption') || '').includes('birthday') &&
                    dayjs(item.get('SendAt')).isSame(dayjs().add(1, 'day'), 'day')
				);
				
				if (!alreadySent) {
					const messageTime = dayjs.tz(undefined, "Asia/Colombo").add(1, 'day').hour(0).minute(0).second(0);
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
					
					logger.info(`Scheduled ${birthday.customMessage ? 'custom' : 'AI-generated'} birthday message for ${birthday.name} (${birthday.phone}) for tomorrow at 12:00 AM`);
				}
			}
		}
        const allScheduleRows = await scheduleSheet.getRows();
		io.emit("queue:update", { size: allScheduleRows.filter(r => r.get('Status') === "pending").length });
		
	} catch (e) {
		logger.error({ err: e }, "Failed to check birthdays from Google Sheet");
	}
}

async function processQueue(io) {
	if (!sock || !connectionStatus.connected) return;
	if (sendingInProgress) return;
	sendingInProgress = true;
	try {
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
async function cleanupOldMediaFiles() {
	try {
		const files = await fsp.readdir(UPLOADS_DIR);
		
        const sheet = await getSheet('Schedule');
        const rows = await sheet.getRows();
		const now = Date.now();
		const oneDayAgo = now - (24 * 60 * 60 * 1000);
		
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

function scheduleDailyBirthdayCheck(io) {
  const now = dayjs.tz(undefined, "Asia/Colombo");
  let nextCheck = now.hour(23).minute(55).second(0);

  if (now.isAfter(nextCheck)) {
    nextCheck = nextCheck.add(1, 'day');
  }

  const msUntilNextCheck = nextCheck.diff(now);

  logger.info(`Next daily birthday check scheduled for ${nextCheck.format()} (${Math.round(msUntilNextCheck / 1000 / 60)} minutes from now).`);

  setTimeout(() => {
    logger.info("Running scheduled daily birthday check...");
    checkBirthdays(io); 
    scheduleDailyBirthdayCheck(io); 
  }, msUntilNextCheck);
}

export function initBaileys(io) {
    initializeGemini();
    startBaileys(io);
    setInterval(() => processQueue(io), 10000);
    setInterval(cleanupOldMediaFiles, 24 * 60 * 60 * 1000);
    cleanupOldMediaFiles();
    checkBirthdays(io);
    scheduleDailyBirthdayCheck(io);
}

export function getSocket() {
    return sock;
}

export function getConnectionStatus() {
    return connectionStatus;
}

export function isConnectingStatus() {
    return isConnecting;
}

export function getUptime() {
	if (!startTime) return "Unknown";
	const uptime = Date.now() - startTime;
	const days = Math.floor(uptime / (1000 * 60 * 60 * 24));
	const hours = Math.floor((uptime % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
	const minutes = Math.floor((uptime % (1000 * 60 * 60)) / (1000 * 60));
	return `${days}d ${hours}h ${minutes}m`;
}
