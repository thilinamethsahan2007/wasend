# 🤖 WaSender - WhatsApp Personal Bot

A powerful WhatsApp automation bot with AI-powered message summaries, scheduled messaging, birthday reminders, and more!

## ✨ Features

- 📱 **WhatsApp Web Integration** - Connect your WhatsApp account
- 🤖 **AI Message Summaries** - Get AI-generated summaries of unread messages using Google Gemini
- ⏰ **Message Scheduler** - Schedule messages with media support
- 📇 **VCF Import** - Import recipients from contact files
- 🎂 **Birthday Reminders** - Auto-send birthday wishes
- 💬 **Quick Replies** - Reply to messages directly from the dashboard
- ✍️ **Typing Indicator** - Show typing status to contacts
- 👁️ **Auto-View Status** - Automatically view WhatsApp statuses
- 🎨 **Modern Glassmorphism UI** - Beautiful dark theme with glass effects

## 🚀 Quick Start (Local Development)

### Prerequisites

- Node.js 18+ installed
- WhatsApp account

### Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd WaSender
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

4. **Open your browser:**
   - Go to http://localhost:3000
   - Scan the QR code with your WhatsApp

## 🌐 Deploy to Cloud (24/7 Hosting)

See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions on deploying to:
- Railway (Recommended)
- Render
- Heroku
- DigitalOcean
- Docker + VPS

## 📁 Project Structure

```
WaSender/
├── src/
│   └── server.js          # Main server file
├── public/
│   ├── index.html         # Frontend UI
│   └── uploads/           # Media file storage
├── data/
│   ├── auth_info_baileys/ # WhatsApp session data
│   ├── contacts.json      # Saved contacts
│   ├── schedule.json      # Scheduled messages
│   └── birthdays.json     # Birthday list
├── Dockerfile             # Docker configuration
├── docker-compose.yml     # Docker Compose setup
└── package.json           # Dependencies
```

## 🛠️ Configuration

### Port Configuration

Default port is `3000`. To change:

```bash
PORT=8080 npm start
```

### Environment Variables

Create a `.env` file (optional):

```env
PORT=3000
NODE_ENV=production
```

## 📝 Usage

### 1. Message Summaries

- Click "Refresh Summaries" to get AI summaries of unread messages
- Summaries are generated using Google Gemini AI
- Reply directly from the summary panel

### 2. Schedule Messages

- Enter recipients (comma-separated or line-by-line)
- Upload media file (optional)
- Enter your message
- Set date/time
- Click "Schedule Message"

### 3. Birthday Management

- Add birthdays with name, phone, date
- Bot will automatically send personalized birthday wishes
- Messages are AI-generated based on relationship and gender

### 4. VCF Import

- Upload a VCF file when scheduling messages
- Bot will extract phone numbers automatically
- Only WhatsApp-verified numbers are added

## 🎨 Features in Detail

### AI-Powered Summaries
- Summarizes chat messages intelligently
- Detects chat type (personal/group)
- First-person perspective for personal chats
- Includes sender names in summaries
- Handles Singlish and multilingual messages

### Message Scheduling
- Schedule text messages
- Schedule media (images, videos, documents)
- Add captions to media
- Bulk messaging with VCF import
- Queue management

### Auto-View Status
- Toggle to automatically view contacts' statuses
- Helps with status monitoring
- Privacy-friendly

## 🔧 Technical Stack

- **Backend:** Node.js, Express
- **WhatsApp:** Baileys (WhatsApp Web API)
- **AI:** Google Gemini API
- **Frontend:** Vanilla JavaScript, Socket.IO
- **Storage:** JSON files
- **Media Processing:** Multer

## 🐳 Docker Deployment

### Build and Run

```bash
# Build image
docker build -t wasender .

# Run container
docker run -p 3000:3000 -v ./data:/app/data wasender
```

### Using Docker Compose

```bash
docker-compose up -d
```

## 🔒 Security Notes

- WhatsApp session data is stored locally in `data/auth_info_baileys/`
- Never commit the `data/` directory
- All sensitive files are in `.gitignore`
- Use environment variables for sensitive config

## 🐛 Troubleshooting

### QR Code Not Showing
- Ensure port 3000 is not blocked
- Check if WhatsApp Web is accessible
- Clear browser cache

### Bot Disconnects
- Ensure persistent storage is configured (for cloud deployments)
- Check WhatsApp hasn't logged you out
- Verify session files exist in `data/`

### Messages Not Sending
- Verify WhatsApp connection status
- Check recipient phone numbers are valid
- Ensure media files are accessible

## 📄 License

MIT License - feel free to use and modify!

## 🤝 Contributing

Contributions are welcome! Feel free to:
- Report bugs
- Suggest features
- Submit pull requests

## 📞 Support

For issues and questions, please open a GitHub issue.

---

Made with ❤️ for WhatsApp automation