import { z } from 'zod';
import { FactCategory } from '../constants/fact-extraction.js';

export const factValueShape = {
  category: z.enum(FactCategory),
  value: z
    .string()
    .min(1, 'Enter the fact.')
    .max(1000, 'Keep the fact to 1,000 characters or fewer.'),
  qualifier: z.string().min(1).max(1000).nullable(),
  dateValue: z
    .string()
    .regex(/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/, 'Enter a date as YYYY, YYYY-MM, or YYYY-MM-DD.')
    .nullable(),
  datePrecision: z.enum(['year', 'month', 'day']).nullable(),
  dateMeaning: z.string().min(1).max(200).nullable(),
  treatmentStatus: z.enum(['recommended', 'performed', 'unspecified']).nullable(),
  findingStatus: z.enum(['suspected', 'confirmed', 'unspecified']).nullable(),
  negated: z.boolean(),
};

export type FactValues = z.infer<z.ZodObject<typeof factValueShape>>;

export function validateFactValues(fact: FactValues, context: z.RefinementCtx) {
  const dateFields = [fact.dateValue, fact.datePrecision, fact.dateMeaning];
  let validDate = dateFields.every((value) => value === null);
  if (
    fact.category === FactCategory.Date &&
    fact.dateValue &&
    fact.datePrecision &&
    fact.dateMeaning
  ) {
    const widths = { year: 4, month: 7, day: 10 };
    const padded = `${fact.dateValue}-01-01`.slice(0, 10);
    const parsed = new Date(`${padded}T00:00:00Z`);
    validDate =
      fact.dateValue.length === widths[fact.datePrecision] &&
      !fact.dateValue.startsWith('0000') &&
      !Number.isNaN(parsed.valueOf()) &&
      parsed.toISOString().slice(0, 10) === padded;
  } else if (fact.category === FactCategory.Date) {
    validDate = false;
  }

  if (!validDate) {
    context.addIssue({
      code: 'custom',
      path: ['dateValue'],
      message: 'Enter a valid date and meaning that match the selected precision.',
    });
  }

  if ((fact.category === FactCategory.Treatment) !== (fact.treatmentStatus !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['treatmentStatus'],
      message: 'Treatment status must match the selected category.',
    });
  }

  if ((fact.category === FactCategory.Finding) !== (fact.findingStatus !== null)) {
    context.addIssue({
      code: 'custom',
      path: ['findingStatus'],
      message: 'Finding status must match the selected category.',
    });
  }
}

export const factValuesSchema = z.strictObject(factValueShape).superRefine(validateFactValues);
