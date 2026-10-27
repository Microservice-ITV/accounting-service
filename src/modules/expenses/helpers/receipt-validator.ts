import { EXPENSE_CONFIG } from '../../../config/expense.config.js';
import { ExpenseApplicationError } from '../errors/expense.error.js';

const allowedMimeTypes = new Set<string>(EXPENSE_CONFIG.receipt.allowedMimeTypes);
const receiptPattern = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/;

export function validateReceiptImage(receiptImage?: string): string | undefined {
  if (receiptImage === undefined || receiptImage === '') {
    return undefined;
  }

  const match = receiptPattern.exec(receiptImage);
  const mimeType = match?.[1];
  const encodedImage = match?.[2];

  if (!mimeType || !encodedImage || !allowedMimeTypes.has(mimeType)) {
    throw new ExpenseApplicationError('Receipt image format is not supported', 400);
  }

  const decodedImage = Buffer.from(encodedImage, 'base64');
  const canonicalBase64 = decodedImage.toString('base64');
  if (canonicalBase64 !== encodedImage) {
    throw new ExpenseApplicationError('Receipt image must contain valid base64 data', 400);
  }

  if (decodedImage.byteLength > EXPENSE_CONFIG.receipt.maxSizeBytes) {
    const maxSizeMegabytes = EXPENSE_CONFIG.receipt.maxSizeBytes / (1024 * 1024);
    throw new ExpenseApplicationError(`Receipt image must be ${maxSizeMegabytes} MB or smaller`, 400);
  }

  return receiptImage;
}
