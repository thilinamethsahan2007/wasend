import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { getSheet, ensureSheetsExist } from '../googleSheet.js';

// Mock the GoogleSpreadsheet and JWT classes
jest.mock('google-spreadsheet');
jest.mock('google-auth-library');

describe('googleSheet', () => {
  const mockDoc = {
    useServiceAccountAuth: jest.fn(),
    loadInfo: jest.fn(),
    addSheet: jest.fn(),
    sheetsByTitle: {},
  };

  beforeAll(() => {
    GoogleSpreadsheet.mockImplementation(() => mockDoc);
    JWT.mockImplementation(() => ({
      // Mock JWT constructor if needed
    }));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDoc.sheetsByTitle = {}; // Reset sheets for each test
  });

  it('should return an existing sheet', async () => {
    const mockSheet = { title: 'TestSheet' };
    mockDoc.sheetsByTitle['TestSheet'] = mockSheet;

    const sheet = await getSheet('TestSheet');

    expect(GoogleSpreadsheet).toHaveBeenCalledTimes(1);
    expect(mockDoc.useServiceAccountAuth).toHaveBeenCalledTimes(1);
    expect(mockDoc.loadInfo).toHaveBeenCalledTimes(1);
    expect(sheet).toBe(mockSheet);
  });

  it('should create a new sheet if it does not exist', async () => {
    const mockNewSheet = { title: 'NewSheet' };
    mockDoc.addSheet.mockResolvedValue(mockNewSheet);

    const sheet = await getSheet('NewSheet');

    expect(GoogleSpreadsheet).toHaveBeenCalledTimes(1);
    expect(mockDoc.useServiceAccountAuth).toHaveBeenCalledTimes(1);
    expect(mockDoc.loadInfo).toHaveBeenCalledTimes(1);
    expect(mockDoc.addSheet).toHaveBeenCalledWith({ title: 'NewSheet' });
    expect(sheet).toBe(mockNewSheet);
  });

  it('should ensure all required sheets exist', async () => {
    const mockSheet1 = { title: 'Sheet1' };
    const mockSheet2 = { title: 'Sheet2' };
    mockDoc.sheetsByTitle['Sheet1'] = mockSheet1;
    mockDoc.addSheet.mockResolvedValue(mockSheet2);

    await ensureSheetsExist(['Sheet1', 'Sheet2', 'Sheet3']);

    expect(mockDoc.addSheet).toHaveBeenCalledTimes(2); // Sheet2 and Sheet3 should be added
    expect(mockDoc.addSheet).toHaveBeenCalledWith({ title: 'Sheet2' });
    expect(mockDoc.addSheet).toHaveBeenCalledWith({ title: 'Sheet3' });
  });
});