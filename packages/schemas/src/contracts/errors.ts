import { z } from 'zod';
import { ErrorCode } from '../constants/error-codes.js';

export const errorCodeSchema = z.enum(ErrorCode);
