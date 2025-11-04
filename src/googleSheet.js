import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';

// Environment variables
const { 
  GOOGLE_SHEET_ID,
  GOOGLE_SERVICE_ACCOUNT_EMAIL,
  GOOGLE_PRIVATE_KEY
} = process.env;

// Authenticate with Google
const serviceAccountAuth = new JWT({
  email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), // Ensure newlines are correctly formatted
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  gaxiosOptions: {
    timeout: 120000, // 120 seconds
  },
});

// Initialize the Google Spreadsheet document
const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);

/**
 * Loads the spreadsheet document.
 * This function must be called before any other sheet operations.
 */
async function loadDocument() {
  await doc.loadInfo();
}

/**
 * Gets a worksheet by its title.
 * @param {string} title The title of the worksheet.
 * @returns {Promise<GoogleSpreadsheetWorksheet>} The worksheet object.
 */
async function getSheet(title) {
  if (!doc.sheetsByTitle[title]) {
    await loadDocument();
  }
  return doc.sheetsByTitle[title];
}

/**
 * Ensures that the required sheets exist in the document.
 * Creates them with headers if they don't.
 */
async function ensureSheetsExist() {
  await loadDocument();
  const requiredSheets = {
    'Contacts': ['Name', 'Phone', 'Source'],
    'Birthdays': ['ID', 'Name', 'Phone', 'Birthday', 'Gender', 'Relationship', 'CustomMessage', 'CreatedAt'],
    'Schedule': ['ID', 'BatchID', 'Recipient', 'Caption', 'MediaUrl', 'MediaType', 'SendAt', 'Status', 'Error', 'SentAt'],
  };

  for (const title in requiredSheets) {
    if (!doc.sheetsByTitle[title]) {
      console.log(`Creating sheet: ${title}`);
      const newSheet = await doc.addSheet({ title });
      await newSheet.setHeaderRow(requiredSheets[title]);
    }
  }
}

// Load the document and ensure sheets exist on startup
(async () => {
  try {
    if(GOOGLE_SHEET_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_PRIVATE_KEY) {
      await ensureSheetsExist();
      console.log('Successfully connected to Google Sheets and verified sheets.');
    } else {
      console.log('Google Sheets environment variables not set. Skipping connection.');
    }
  } catch (error) {
    console.error('Failed to connect to Google Sheets:', error);
  }
})();

export { doc, getSheet };
