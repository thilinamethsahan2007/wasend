
import { proto } from '@whiskeysockets/baileys';
import { getSheet } from './googleSheet.js';

// Helper to convert Buffer to Base64 string
const bufferToBase64 = (buffer) => buffer.toString('base64');
// Helper to convert Base64 string back to Buffer
const base64ToBuffer = (base64) => Buffer.from(base64, 'base64');

// Custom replacer/reviver for JSON serialization to handle Buffers
const  BufferJSON = {
  replacer: (key, value) => {
    if (value?.type === 'Buffer' && Array.isArray(value.data)) {
      return {
        type: 'Buffer',
        data: bufferToBase64(Buffer.from(value.data)),
      };
    }
    return value;
  },
  reviver: (key, value) => {
    if (value?.type === 'Buffer' && typeof value.data === 'string') {
      return base64ToBuffer(value.data);
    }
    return value;
  },
};

export const useGoogleSheetAuthState = async () => {
  const sheet = await getSheet('Auth');
  let creds = {
    noiseKey: null,
    signedIdentityKey: null,
    signedPreKey: null,
    registrationId: null,
    advSecretKey: null,
    nextPreKeyId: null,
    firstUnuploadedPreKeyId: null,
    accountSyncCounter: null,
    accountSettings: null,
    appStateVersions: {},
    processedHistoryMessages: [],
    pairingCode: null
  };
  const keys = {};

  const readData = async () => {
    const rows = await sheet.getRows();
    for (const row of rows) {
      const key = row.get('key');
      const value = row.get('value');
      if (key === 'creds') {
        creds = JSON.parse(value, BufferJSON.reviver);
      } else {
        keys[key] = JSON.parse(value, BufferJSON.reviver);
      }
    }
  };

  const writeData = async () => {
    const rows = await sheet.getRows();
    const rowMap = new Map(rows.map(row => [row.get('key'), row]));

    const credsStr = JSON.stringify(creds, BufferJSON.replacer);
    if (rowMap.has('creds')) {
      const row = rowMap.get('creds');
      row.set('value', credsStr);
      await row.save();
    } else {
      await sheet.addRow({ key: 'creds', value: credsStr });
    }

    for (const key in keys) {
      const valueStr = JSON.stringify(keys[key], BufferJSON.replacer);
      if (rowMap.has(key)) {
        const row = rowMap.get(key);
        row.set('value', valueStr);
        await row.save();
      } else {
        await sheet.addRow({ key, value: valueStr });
      }
    }
  };

  await readData();

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const data = {};
          for (const id of ids) {
            const key = `${type}-${id}`;
            if (keys[key]) {
              data[id] = keys[key];
            }
          }
          return Promise.resolve(data);
        },
        set: (data) => {
          for (const type in data) {
            for (const id in data[type]) {
              const key = `${type}-${id}`;
              keys[key] = data[type][id];
            }
          }
          return writeData();
        },
      },
    },
    saveCreds: writeData,
  };
};
