import { z } from 'zod';

export type ExpenseAuthContext = {
	userId: string;
	role?: string;
	activeShopId?: string | null;
	authorizedShopIds?: Iterable<string>;
	shops?: Array<{ shop_id?: string | null; role?: { code?: string | null; name?: string | null } | null }>;
};

export type CreateExpenseInput = {
	scope?: 'SHOP' | 'PLATFORM';
	amount: number;
	expenseDate?: Date | string;
	expenseAccountCode?: string;
	fundingAccountCode?: string;
	eventId?: string;
	expenseCategoryId?: string;
	category?: string;
	description?: string;
	receiptImage?: string;
	shopId?: string | null;
};

export type ExpenseCategoryInput = {
	code: string;
	name: string;
	description?: string | null;
	status?: string;
};

const expenseBaseSchema = z.object({
	scope: z.enum(['SHOP', 'PLATFORM']).default('SHOP'),
	shopId: z.string().trim().min(1).nullable().optional(),
	amount: z.coerce.number().finite().positive(),
	expenseDate: z.string().trim().min(1).optional(),
	expenseAccountCode: z.string().trim().min(1).optional(),
	fundingAccountCode: z.string().trim().min(1).optional(),
	eventId: z.string().trim().min(1).optional(),
	expenseCategoryId: z.string().trim().min(1).optional(),
	category: z.string().trim().min(1).optional(),
	description: z.string().trim().min(1).optional(),
	receiptImage: z.string().optional(),
});

export const expenseSchema = expenseBaseSchema.superRefine((input, context) => {
	if (input.scope === 'SHOP' && !input.shopId) {
		context.addIssue({ code: z.ZodIssueCode.custom, path: ['shopId'], message: 'Shop is required for a shop expense' });
	}
	if (input.scope === 'PLATFORM' && input.shopId) {
		context.addIssue({ code: z.ZodIssueCode.custom, path: ['shopId'], message: 'Platform expenses cannot specify a shop' });
	}
});

export const expenseCategorySchema = z.object({
	code: z.string().trim().min(1),
	name: z.string().trim().min(1),
	description: z.string().trim().nullable().optional(),
	status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const returnedExpenseSchema = expenseBaseSchema.pick({
	amount: true,
	expenseDate: true,
	expenseCategoryId: true,
	description: true,
	receiptImage: true,
});
