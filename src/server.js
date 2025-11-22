import 'dotenv/config';
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import fsp from "fs/promises";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { nanoid } from "nanoid";

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.tz.setDefault("Asia/Colombo");

import logger from './services/logger.js';
import { getSheet } from './services/googleSheet.js';
import { initBaileys, getSocket, getConnectionStatus, isConnectingStatus, getUptime, startBaileys, updateSettings } from './services/baileys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || "admin123";

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		const dir = path.join(__dirname, "..", "public", "uploads");
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		cb(null, dir);
	},
	filename: (req, file, cb) => {
		const ext = path.extname(file.originalname) || ".tmp";
		cb(null, `${Date.now()}-${nanoid()}${ext}`);
	}
});
const upload = multer({ storage });

// Middleware to check password
const checkPassword = (req, res, next) => {
	const password = req.headers['x-app-password'] || req.body.password;
	if (password !== APP_PASSWORD) {
		return res.status(401).json({ error: "Unauthorized" });
	}
	next();
};

// API routes
app.get("/api/status", (req, res) => {
	res.json({
		status: getConnectionStatus(),
		isConnecting: isConnectingStatus(),
		uptime: getUptime()
	});
});

app.post("/api/bot/connect", (req, res) => {
	startBaileys(io, true);
	res.json({ success: true, message: "Connecting..." });
});

app.post("/api/bot/disconnect", async (req, res) => {
	const sock = getSocket();
	if (sock) {
		await sock.logout();
	}
	res.json({ success: true, message: "Disconnected" });
});

app.get("/api/settings", (req, res) => {
	res.json({
		autoViewStatus: process.env.AUTO_VIEW_STATUS !== "false",
		autoReactStatus: process.env.AUTO_REACT_STATUS === "true",
		reactionEmoji: process.env.REACTION_EMOJI || "❤️,💕,😍,👍",
		lastSeenUpdatedAt: getUptime() 
	});
});

app.post("/api/settings", (req, res) => {
	const { autoViewStatus, autoReactStatus, reactionEmoji } = req.body;
	
	if (typeof autoViewStatus !== 'undefined') {
		process.env.AUTO_VIEW_STATUS = String(autoViewStatus);
	}
	if (typeof autoReactStatus !== 'undefined') {
		process.env.AUTO_REACT_STATUS = String(autoReactStatus);
	}
	if (typeof reactionEmoji !== 'undefined') {
		process.env.REACTION_EMOJI = reactionEmoji;
	}

	const newSettings = {
		autoViewStatus: process.env.AUTO_VIEW_STATUS !== "false",
		autoReactStatus: process.env.AUTO_REACT_STATUS === "true",
		reactionEmoji: process.env.REACTION_EMOJI
	};

	updateSettings(newSettings);
	io.emit("settings:update", newSettings);
	
	res.json({ success: true, message: "Settings updated" });
});

app.post("/api/schedule", upload.single("media"), async (req, res) => {
	try {
		const { recipients, caption, sendAt } = req.body;
		if (!recipients) {
			return res.status(400).json({ error: "Recipients are required" });
		}
		
		const recipientList = recipients.split(",").map(r => r.trim()).filter(r => r);
		if (recipientList.length === 0) {
			return res.status(400).json({ error: "Invalid recipients list" });
		}
		
		const sheet = await getSheet('Schedule');
		const batchId = nanoid();
		const sendAtDate = sendAt ? dayjs(sendAt).toISOString() : dayjs().add(2, 'second').toISOString();
		
		const newRows = recipientList.map(recipient => ({
			ID: nanoid(),
			BatchID: batchId,
			Recipient: recipient,
			Caption: caption || null,
			MediaUrl: req.file ? `/uploads/${req.file.filename}` : null,
			MediaType: req.file ? req.file.mimetype : null,
			SendAt: sendAtDate,
			Status: "pending"
		}));

        if (newRows.length > 0) {
		    await sheet.addRows(newRows);
        }

		io.emit("queue:scheduled", newRows);
		
		res.json({
			success: true,
			batchId,
			created: recipientList.length,
			message: `Scheduled ${recipientList.length} message(s) successfully`
		});
	} catch (e) {
		logger.error({ err: e }, "Failed to schedule message");
		res.status(500).json({ error: "Failed to schedule message" });
	}
});

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

app.post("/api/schedule/clear", async (req, res) => {
	try {
		const sheet = await getSheet('Schedule');
		const rows = await sheet.getRows();
		const toDelete = rows.filter(r => r.get('Status') === 'sent' || r.get('Status') === 'failed');
		for (let i = toDelete.length - 1; i >= 0; i--) {
			await toDelete[i].delete();
		}
		res.json({ success: true, message: `Cleared ${toDelete.length} finished jobs.` });
	} catch (e) {
		logger.error({ err: e }, "Failed to clear schedule");
		res.status(500).json({ error: "Failed to clear schedule" });
	}
});

app.get("/api/contacts", async (req, res) => {
	try {
		const sheet = await getSheet('Contacts');
		const rows = await sheet.getRows();
		const contacts = rows.map(row => ({
			id: row.get('ID'),
			name: row.get('Name'),
			phone: row.get('Phone'),
		}));
		res.json(contacts);
	} catch (e) {
		logger.error({ err: e }, "Failed to get contacts from Google Sheet");
		res.status(500).json({ error: "Failed to retrieve contacts" });
	}
});

app.post("/api/contacts/import-vcf", upload.single("vcf"), async (req, res) => {
	if (!req.file) {
		return res.status(400).json({ error: "VCF file is required." });
	}
	try {
		const vcfData = await fsp.readFile(req.file.path, "utf-8");
		const lines = vcfData.split(/\r\n|\r|\n/);
		
		const contacts = [];
		let currentContact = {};
		
		for (const line of lines) {
			if (line.startsWith("BEGIN:VCARD")) {
				currentContact = {};
			} else if (line.startsWith("END:VCARD")) {
				if (currentContact.name && currentContact.phone) {
					contacts.push(currentContact);
				}
			} else if (line.startsWith("FN:")) {
				currentContact.name = line.substring(3).trim();
			} else if (line.startsWith("TEL;")) {
				currentContact.phone = line.split(":").pop().replace(/[^\d+]/g, "").trim();
			}
		}
		
		if (contacts.length > 0) {
			const sheet = await getSheet('Contacts');
			const rows = await sheet.getRows();
			const existingPhones = new Set(rows.map(row => row.get('Phone')));
			
			const newContacts = contacts.filter(c => !existingPhones.has(c.phone));
			
			if (newContacts.length > 0) {
				const newRows = newContacts.map(c => ({
					ID: nanoid(),
					Name: c.name,
					Phone: c.phone,
					CreatedAt: new Date().toISOString()
				}));
				await sheet.addRows(newRows);
				res.json({ success: true, message: `Imported ${newRows.length} new contacts.` });
			} else {
				res.json({ success: true, message: "No new contacts to import." });
			}
		} else {
			res.status(400).json({ error: "No contacts found in VCF file." });
		}
	} catch (e) {
		logger.error({ err: e }, "Failed to import VCF");
		res.status(500).json({ error: "Failed to process VCF file." });
	} finally {
		await fsp.unlink(req.file.path);
	}
});

app.get("/api/contacts/export-csv", async (req, res) => {
    try {
        const sheet = await getSheet('Contacts');
        const rows = await sheet.getRows();
        if (rows.length === 0) {
            return res.status(404).send("No contacts to export.");
        }
        
        const headers = rows[0].sheet.headerValues;
        const csvRows = [headers.join(',')];

        for (const row of rows) {
            const values = headers.map(header => {
                const value = row.get(header) || '';
                // Escape commas and quotes
                const escaped = value.replace(/"/g, '""');
                if (escaped.includes(',')) {
                    return `"${escaped}"`;
                }
                return escaped;
            });
            csvRows.push(values.join(','));
        }

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="contacts.csv"');
        res.status(200).end(csvRows.join('\n'));

    } catch (e) {
        logger.error({ err: e }, "Failed to export contacts to CSV");
        res.status(500).send("Failed to export contacts.");
    }
});

app.get("/api/birthdays", async (req, res) => {
	try {
		const sheet = await getSheet('Birthdays');
		const rows = await sheet.getRows();
		const birthdays = rows.map(row => ({
			id: row.get('ID'),
			name: row.get('Name'),
			phone: row.get('Phone'),
			birthday: row.get('Birthday'),
		}));
		res.json(birthdays);
	} catch (e) {
		logger.error({ err: e }, "Failed to get birthdays from Google Sheet");
		res.status(500).json({ error: "Failed to retrieve birthdays" });
	}
});

app.post("/api/birthdays", async (req, res) => {
	try {
		const { name, phone, birthday, gender, relationship, customMessage } = req.body;
		
		if (!name || !phone || !birthday || !gender || !relationship) {
			return res.status(400).json({ error: "Missing required fields: name, phone, birthday, gender, relationship" });
		}
		
		if (!/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
			return res.status(400).json({ error: "Birthday must be in YYYY-MM-DD format" });
		}
		
		if (!['male', 'female'].includes(gender.toLowerCase())) {
			return res.status(400).json({ error: "Gender must be 'male' or 'female'" });
		}
		
		const validRelationships = ['friend', 'family', 'relative', 'other'];
		if (!validRelationships.includes(relationship.toLowerCase())) {
			return res.status(400).json({ error: "Invalid relationship" });
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
        const rowToDelete = rows.find(r => r.get('ID') === id);
        if (rowToDelete) {
            await rowToDelete.delete();
            res.json({ success: true, message: "Birthday deleted" });
        } else {
            res.status(404).json({ error: "Birthday not found" });
        }
    } catch (e) {
        logger.error({ err: e }, "Failed to delete birthday");
        res.status(500).json({ error: "Failed to delete birthday" });
    }
});

app.post("/api/birthdays/preview-message", async (req, res) => {
    try {
        const { name, gender, relationship } = req.body;
        if (!name || !gender || !relationship) {
            return res.status(400).json({ error: "Name, gender, and relationship are required." });
        }
        // This is a placeholder for a function that would call the AI
        // In a real scenario, you would import and call generateBirthdayMessage from baileys.js
        const message = `Happy birthday, ${name}! Wishing you all the best.`;
        res.json({ success: true, message });
    } catch (e) {
        logger.error({ err: e }, "Failed to preview birthday message");
        res.status(500).json({ error: "Failed to generate preview" });
    }
});

app.get("/api/finance/analysis", async (req, res) => {
    try {
        const sheet = await getSheet('Finances');
        const rows = await sheet.getRows();
        const now = dayjs.tz(undefined, "Asia/Colombo");
        const startOfMonth = now.startOf('month');

        let totalIncome = 0;
        let totalExpenses = 0;
        const categoryTotals = {};

        for (const row of rows) {
            const rowDate = dayjs(row.get('Date'));
            if (rowDate.isAfter(startOfMonth)) {
                const type = row.get('Type');
                const amount = parseFloat(row.get('Amount'));
                const category = row.get('Category') || 'Uncategorized';

                if (!isNaN(amount)) {
                    if (type === 'Income') {
                        totalIncome += amount;
                    } else if (type === 'Expense') {
                        totalExpenses += amount;
                        categoryTotals[category] = (categoryTotals[category] || 0) + amount;
                    }
                }
            }
        }

        const categoryBreakdown = Object.entries(categoryTotals)
            .map(([name, total]) => ({ name, total }))
            .sort((a, b) => b.total - a.total);

        res.json({
            totalIncome: totalIncome.toFixed(2),
            totalExpenses: totalExpenses.toFixed(2),
            netBalance: (totalIncome - totalExpenses).toFixed(2),
            categoryBreakdown,
            month: now.format("MMMM YYYY"),
        });

    } catch (e) {
        logger.error({ err: e }, "Failed to generate finance analysis");
        res.status(500).json({ error: "Failed to generate finance analysis" });
    }
});


// Socket.IO connection
io.on("connection", (socket) => {
	logger.info("New client connected:", socket.id);
	
	socket.emit("connection:init", {
		status: getConnectionStatus(),
		isConnecting: isConnectingStatus(),
		queueSize: 0 // Placeholder
	});

	socket.on("disconnect", () => {
		logger.info("Client disconnected:", socket.id);
	});
});

// Initialize Baileys
initBaileys(io);

server.listen(PORT, () => {
	logger.info(`Server running on http://localhost:${PORT}`);
});